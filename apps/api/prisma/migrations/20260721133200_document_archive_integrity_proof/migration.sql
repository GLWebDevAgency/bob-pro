-- Archives probantes v2 — un statut `done` applicatif n'est plus une preuve : le worker doit
-- relire chaque octet, vérifier MIME/taille/SHA-256, puis persister un manifeste versionné.
-- EXPAND compatible N-1 : pendant le rolling deploy, un ancien worker peut encore écrire
-- `done` sans preuve ; le nouveau reader le compte incomplet et le réclame pour vérification.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- Cette migration remet les anciennes terminaisons en attente. Les verrous sont volontairement
-- pris AVANT cette remise en attente : ils drainent les émissions/claims N-1, installent le
-- snapshot d'audience avant de rouvrir les writers, et empêchent qu'un job se glisse entre les
-- migrations 1332 et 1338. Les I/O objet déjà parties sont neutralisées par le fence `documents`.
LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_archive_jobs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.documents IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_versions IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "document_archive_jobs"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "integrityProof" JSONB,
  ADD COLUMN "integrityProofSha256" CHAR(64),
  ADD COLUMN "completedAt" TIMESTAMPTZ(6);

-- Le scope d'archive est un fait de la pièce, jamais une relecture future de la fiche client.
-- Les factures déjà émises restent NULL (inconnu) jusqu'à un backfill AUDITÉ ; toute émission qui
-- reprend après le COMMIT de 1332 reçoit en revanche son snapshot, y compris depuis N-1.
ALTER TABLE public.invoices
  ADD COLUMN "archiveAudienceAtIssuance" TEXT;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_archive_audience_at_issuance_valid
    CHECK (
      "archiveAudienceAtIssuance" IS NULL
      OR "archiveAudienceAtIssuance" IN ('consumer', 'professional')
    ),
  ADD CONSTRAINT invoices_archive_audience_requires_issue
    CHECK (
      "archiveAudienceAtIssuance" IS NULL
      OR (
        number IS NOT NULL
        AND "issuedAt" IS NOT NULL
        AND status <> 'draft'::public."InvoiceStatus"
      )
    );

CREATE FUNCTION public.capture_invoice_archive_audience_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  customer_type public."CustomerType";
  expected_audience TEXT;
  old_was_issued BOOLEAN := FALSE;
  new_is_issued BOOLEAN :=
    NEW.number IS NOT NULL
    AND NEW."issuedAt" IS NOT NULL
    AND NEW.status <> 'draft'::public."InvoiceStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_was_issued :=
      OLD.number IS NOT NULL
      AND OLD."issuedAt" IS NOT NULL
      AND OLD.status <> 'draft'::public."InvoiceStatus";

    IF OLD."archiveAudienceAtIssuance" IS NOT NULL
       AND NEW."archiveAudienceAtIssuance" IS DISTINCT FROM OLD."archiveAudienceAtIssuance" THEN
      RAISE EXCEPTION 'invoice archive audience is immutable after issuance'
        USING ERRCODE = '23514',
              CONSTRAINT = 'invoices_archive_audience_immutable';
    END IF;

    -- Une pièce legacy déjà émise sans preuve reste explicitement inconnue. Un save applicatif
    -- ultérieur ne doit jamais transformer la fiche client courante en prétendue vérité passée.
    IF old_was_issued AND OLD."archiveAudienceAtIssuance" IS NULL THEN
      IF NEW."archiveAudienceAtIssuance" IS NOT NULL THEN
        RAISE EXCEPTION 'legacy invoice archive audience requires an audited backfill'
          USING ERRCODE = '23514',
                CONSTRAINT = 'invoices_archive_audience_legacy_unknown';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF NOT new_is_issued THEN
    IF NEW."archiveAudienceAtIssuance" IS NOT NULL THEN
      RAISE EXCEPTION 'draft invoice cannot declare an archive audience'
        USING ERRCODE = '23514',
              CONSTRAINT = 'invoices_archive_audience_requires_issue';
    END IF;
    RETURN NEW;
  END IF;

  SELECT customer.type
    INTO customer_type
    FROM public.customers AS customer
   WHERE customer.id = NEW."customerId"
     AND customer."companyId" = NEW."companyId"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice archive audience customer is missing or cross-tenant'
      USING ERRCODE = '23503',
            CONSTRAINT = 'invoices_archive_audience_customer_tenant';
  END IF;

  expected_audience := CASE
    WHEN customer_type = 'b2c'::public."CustomerType" THEN 'consumer'
    ELSE 'professional'
  END;
  IF NEW."archiveAudienceAtIssuance" IS NULL THEN
    NEW."archiveAudienceAtIssuance" := expected_audience;
  ELSIF NEW."archiveAudienceAtIssuance" IS DISTINCT FROM expected_audience THEN
    RAISE EXCEPTION 'invoice archive audience does not match its customer at issuance'
      USING ERRCODE = '23514',
            CONSTRAINT = 'invoices_archive_audience_customer_match';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_invoice_archive_audience_v1() FROM PUBLIC;

CREATE TRIGGER invoices_capture_archive_audience
BEFORE INSERT OR UPDATE OF
  "companyId", "customerId", status, number, "issuedAt", "archiveAudienceAtIssuance"
ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.capture_invoice_archive_audience_v1();

-- Le snapshot et la fiche ne doivent jamais diverger après une pièce légale. Installer cette
-- barrière dans le même COMMIT que la capture ferme la fenêtre 1332→1337, y compris pour N-1.
CREATE FUNCTION public.guard_customer_type_after_legal_piece_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF NEW.type IS NOT DISTINCT FROM OLD.type THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.quotes AS quote
     WHERE quote."companyId" = OLD."companyId"
       AND quote."customerId" = OLD.id
       AND quote."signedAt" IS NOT NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.invoices AS invoice
     WHERE invoice."companyId" = OLD."companyId"
       AND invoice."customerId" = OLD.id
       AND invoice.number IS NOT NULL
       AND invoice."issuedAt" IS NOT NULL
       AND invoice.status <> 'draft'::public."InvoiceStatus"
  ) THEN
    RAISE EXCEPTION
      'customer type is immutable after a signed quote or an issued invoice'
      USING ERRCODE = '23514',
            CONSTRAINT = 'customers_type_legal_piece_immutable';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_customer_type_after_legal_piece_v1() FROM PUBLIC;

CREATE TRIGGER customers_type_legal_piece_immutable
BEFORE UPDATE OF type ON public.customers
FOR EACH ROW
EXECUTE FUNCTION public.guard_customer_type_after_legal_piece_v1();

CREATE UNIQUE INDEX "document_archive_jobs_leaseToken_key"
  ON "document_archive_jobs"("leaseToken");

CREATE INDEX "document_archive_jobs_due_claim_idx"
  ON "document_archive_jobs"("companyId", "nextAttemptAt", "createdAt")
  WHERE status IN ('pending', 'failed') OR (status = 'done' AND "integrityProof" IS NULL);

-- Source unique, fail-closed, de la phase de cutover. La table de protocole n'existe qu'en 1338 :
-- son absence signifie donc V1/PAUSE, jamais « actif par défaut ». L'accès dynamique maintient
-- l'ordre expand/contract sans dépendance SQL vers une relation encore absente.
CREATE FUNCTION public.document_archive_protocol_v2_is_active()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  active BOOLEAN := FALSE;
BEGIN
  IF to_regclass('public.document_archive_protocol_state') IS NULL THEN
    RETURN FALSE;
  END IF;
  EXECUTE
    'SELECT "activeVersion" = 2 FROM public.document_archive_protocol_state WHERE id = 1'
    INTO active;
  RETURN coalesce(active, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.document_archive_protocol_v2_is_active() FROM PUBLIC;

-- Spool durable du rolling deploy. Tout ordre sans preuve est daté hors horizon JavaScript et
-- ne peut donc être ni listé ni claimé par N-1 ou N. Une tentative de terminer un ancien lease
-- pendant V1 est refusée : sa sortie réglementaire ne peut pas franchir le cutover à moitié.
CREATE FUNCTION public.spool_document_archive_job_during_v2_cutover()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF public.document_archive_protocol_v2_is_active() THEN
    RETURN NEW;
  END IF;

  IF NEW."integrityProof" IS NOT NULL THEN
    RAISE EXCEPTION 'document archive completion is paused during V2 cutover'
      USING ERRCODE = '55000',
            CONSTRAINT = 'document_archive_jobs_cutover_spool_v2';
  END IF;

  NEW."nextAttemptAt" := TIMESTAMP '9999-12-31 23:59:59.999';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.spool_document_archive_job_during_v2_cutover() FROM PUBLIC;

CREATE TRIGGER document_archive_jobs_cutover_spool_v2
BEFORE INSERT OR UPDATE ON public.document_archive_jobs
FOR EACH ROW
EXECUTE FUNCTION public.spool_document_archive_job_during_v2_cutover();

-- Un worker déjà claimé peut être hors transaction pendant son upload. Tant que V2 n'est pas
-- activé, aucune matérialisation SQL d'un original légal généré n'est donc admise. Les imports
-- utilisateur (`origin = uploaded`) et les autres documents du coffre restent disponibles.
CREATE FUNCTION public.guard_generated_legal_archive_cutover_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF NEW.origin = 'generated'::public."StoredDocumentOrigin"
     AND NEW.kind IN (
       'invoice_pdf'::public."StoredDocumentKind",
       'facturx_xml'::public."StoredDocumentKind",
       'signed_quote'::public."StoredDocumentKind"
     )
     AND NOT public.document_archive_protocol_v2_is_active() THEN
    RAISE EXCEPTION 'generated legal archives are paused during V2 cutover'
      USING ERRCODE = '55000',
            CONSTRAINT = 'documents_generated_legal_archive_cutover_v2';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_generated_legal_archive_cutover_v2() FROM PUBLIC;

CREATE TRIGGER documents_generated_legal_archive_cutover_v2
BEFORE INSERT OR UPDATE OF origin, kind ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.guard_generated_legal_archive_cutover_v2();

-- Ne jamais fabriquer une preuve depuis les seules lignes SQL : elles ne prouvent pas les octets
-- du stockage objet. Les anciennes terminaisons sont remises en vérification automatique ; le
-- marqueur interdit au nouveau worker de régénérer une archive historique absente.
UPDATE "document_archive_jobs"
   SET status = 'failed'::"DocumentArchiveJobStatus",
       -- Le trigger de spool impose également ce sentinel. L'expliciter ici rend la migration
       -- auditable et empêche une future modification du trigger de réouvrir ce trou.
       "nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999',
       "leaseToken" = NULL,
       "lastError" = left(
         '[archive-integrity-proof-required] Ancienne terminaison non attestée. '
         || coalesce("lastError", ''),
         2000
       ),
       "updatedAt" = statement_timestamp()
 WHERE status = 'done';

-- Validation profonde sans extension : chaque clé du manifeste est authentifiée par le digest
-- applicatif, et la base refuse les formes ambiguës (extras, doublons, mauvais MIME/type/hash).
CREATE FUNCTION document_archive_integrity_proof_v1_is_valid(
  expected_company_id TEXT,
  expected_piece_id TEXT,
  expected_reason TEXT,
  proof JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  artifact JSONB;
  artifact_kind TEXT;
  artifact_document_id TEXT;
  artifact_version_id TEXT;
  artifact_storage_key TEXT;
  artifact_mime_type TEXT;
  proof_key_count INTEGER;
  artifact_key_count INTEGER;
  invoice_pdf_count INTEGER := 0;
  facturx_xml_count INTEGER := 0;
  signed_quote_count INTEGER := 0;
  seen_document_ids TEXT[] := ARRAY[]::TEXT[];
  seen_version_ids TEXT[] := ARRAY[]::TEXT[];
  seen_storage_keys TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF jsonb_typeof(proof) <> 'object' THEN RETURN FALSE; END IF;
  SELECT count(*) INTO proof_key_count FROM jsonb_object_keys(proof);
  IF proof_key_count <> 6
     OR proof->>'version' <> '1'
     OR proof->>'algorithm' <> 'sha256'
     OR proof->>'companyId' <> expected_company_id
     OR proof->>'pieceId' <> expected_piece_id
     OR proof->>'reason' <> expected_reason
     OR jsonb_typeof(proof->'artifacts') <> 'array'
     OR jsonb_array_length(proof->'artifacts') < 1 THEN
    RETURN FALSE;
  END IF;

  FOR artifact IN SELECT value FROM jsonb_array_elements(proof->'artifacts') LOOP
    IF jsonb_typeof(artifact) <> 'object' THEN RETURN FALSE; END IF;
    SELECT count(*) INTO artifact_key_count FROM jsonb_object_keys(artifact);
    IF artifact_key_count <> 9
       OR NOT artifact ?& ARRAY[
         'kind', 'documentId', 'versionId', 'version',
         'storageKey', 'mimeType', 'byteSize', 'sha256', 'contentProfile'
       ]
       OR artifact->>'version' <> '1'
       OR jsonb_typeof(artifact->'byteSize') <> 'number'
       OR (artifact->>'byteSize')::numeric <> trunc((artifact->>'byteSize')::numeric)
       OR (artifact->>'byteSize')::numeric < 1
       OR (artifact->>'byteSize')::numeric > 9007199254740991
       OR coalesce(artifact->>'sha256', '') !~ '^[0-9a-f]{64}$' THEN
      RETURN FALSE;
    END IF;

    artifact_kind := artifact->>'kind';
    artifact_document_id := artifact->>'documentId';
    artifact_version_id := artifact->>'versionId';
    artifact_storage_key := artifact->>'storageKey';
    artifact_mime_type := artifact->>'mimeType';
    IF btrim(coalesce(artifact_document_id, '')) = ''
       OR btrim(coalesce(artifact_version_id, '')) = ''
       OR btrim(coalesce(artifact_storage_key, '')) = ''
       OR artifact_storage_key NOT LIKE
         'companies/' || expected_company_id || '/documents/' || artifact_document_id || '/%'
       OR artifact_storage_key LIKE '%..%'
       OR artifact_storage_key LIKE '%//%'
       OR artifact_document_id = ANY(seen_document_ids)
       OR artifact_version_id = ANY(seen_version_ids)
       OR artifact_storage_key = ANY(seen_storage_keys) THEN
      RETURN FALSE;
    END IF;

    IF artifact_kind = 'invoice_pdf'
       AND artifact_mime_type = 'application/pdf'
       AND artifact->>'contentProfile' = 'facturx_pdfa3' THEN
      invoice_pdf_count := invoice_pdf_count + 1;
    ELSIF artifact_kind = 'facturx_xml'
       AND artifact_mime_type = 'application/xml'
       AND artifact->>'contentProfile' = 'facturx_xml' THEN
      facturx_xml_count := facturx_xml_count + 1;
    ELSIF artifact_kind = 'signed_quote'
       AND artifact_mime_type = 'application/pdf'
       AND artifact->>'contentProfile' = 'plain_pdf' THEN
      signed_quote_count := signed_quote_count + 1;
    ELSE
      RETURN FALSE;
    END IF;

    seen_document_ids := array_append(seen_document_ids, artifact_document_id);
    seen_version_ids := array_append(seen_version_ids, artifact_version_id);
    seen_storage_keys := array_append(seen_storage_keys, artifact_storage_key);
  END LOOP;

  RETURN CASE expected_reason
    WHEN 'invoice-issued' THEN
      jsonb_array_length(proof->'artifacts') = 2
      AND invoice_pdf_count = 1 AND facturx_xml_count = 1 AND signed_quote_count = 0
    WHEN 'quote-signed' THEN
      jsonb_array_length(proof->'artifacts') = 1
      AND signed_quote_count = 1 AND invoice_pdf_count = 0 AND facturx_xml_count = 0
    ELSE FALSE
  END;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

-- SECURITY INVOKER ne transforme pas ce validateur en RPC public. Il est appelé par le CHECK
-- relationnel et reçoit une preuve complète ; l'exposer via PostgREST ouvrirait inutilement une
-- surface coûteuse avant même la migration de clôture Data API.
REVOKE ALL ON FUNCTION document_archive_integrity_proof_v1_is_valid(
  TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;

ALTER TABLE "document_archive_jobs"
  ADD CONSTRAINT "document_archive_jobs_reason_valid"
  CHECK (reason IN ('invoice-issued', 'quote-signed')),
  ADD CONSTRAINT "document_archive_jobs_integrity_digest_shape"
  CHECK (
    "integrityProofSha256" IS NULL
    OR "integrityProofSha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "document_archive_jobs_integrity_proof_shape"
  CHECK (
    "integrityProof" IS NULL
    OR coalesce(document_archive_integrity_proof_v1_is_valid(
      "companyId", "invoiceId", reason, "integrityProof"
    ), false)
  ),
  -- Une preuve n'est jamais partielle. `done` sans preuve reste provisoirement accepté pour N-1,
  -- mais le nouveau repository le compte incomplet et le reprend.
  ADD CONSTRAINT "document_archive_jobs_completion_proof_atomic"
  CHECK (
    ("integrityProof" IS NULL AND "integrityProofSha256" IS NULL AND "completedAt" IS NULL)
    OR (
      status = 'done'
      AND "leaseToken" IS NULL
      AND "integrityProof" IS NOT NULL
      AND "integrityProofSha256" IS NOT NULL
      AND "completedAt" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "document_archive_jobs_lease_shape"
  CHECK (
    "leaseToken" IS NULL
    OR (
      status IN ('pending', 'failed')
      AND "integrityProof" IS NULL
      AND "completedAt" IS NULL
    )
  );

-- Une terminaison PROUVÉE est append-only. Une terminaison legacy sans preuve reste réparable
-- pendant la fenêtre expand/contract.
CREATE FUNCTION guard_document_archive_job_proof_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'done' AND OLD."integrityProof" IS NOT NULL THEN
    RAISE EXCEPTION 'proved document archive jobs are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'document_archive_jobs_proof_immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION guard_document_archive_job_proof_v1() FROM PUBLIC;

CREATE TRIGGER document_archive_jobs_proof_immutable
BEFORE UPDATE ON "document_archive_jobs"
FOR EACH ROW
EXECUTE FUNCTION guard_document_archive_job_proof_v1();

-- Défense inter-migrations : les default privileges Supabase peuvent accorder EXECUTE directement
-- aux rôles Data API lors du CREATE. Les révoquer avant ce COMMIT évite toute fenêtre RPC.
DO $$
DECLARE
  protected_names CONSTANT TEXT[] := ARRAY[
    'capture_invoice_archive_audience_v1',
    'guard_customer_type_after_legal_piece_v1',
    'document_archive_protocol_v2_is_active',
    'spool_document_archive_job_during_v2_cutover',
    'guard_generated_legal_archive_cutover_v2',
    'document_archive_integrity_proof_v1_is_valid',
    'guard_document_archive_job_proof_v1'
  ]::TEXT[];
  protected_function RECORD;
  exposed_role TEXT;
BEGIN
  IF (
    SELECT count(*)
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.prokind = 'f'
       AND procedure.proname = ANY(protected_names)
  ) <> cardinality(protected_names) THEN
    RAISE EXCEPTION 'archive integrity RPC inventory drift';
  END IF;
  FOR protected_function IN
    SELECT namespace.nspname,
           procedure.proname,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.prokind = 'f'
       AND procedure.proname = ANY(protected_names)
  LOOP
    FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
      IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I',
          protected_function.nspname,
          protected_function.proname,
          protected_function.identity_arguments,
          exposed_role
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
