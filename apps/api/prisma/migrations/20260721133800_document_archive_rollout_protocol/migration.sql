-- Archive vérifiée V2 — protocole de rolling deploy et matérialisation des preuves legacy.
--
-- Phase 1 (expand) : le binaire N-1 conserve INSERT/UPDATE sur l'outbox, mais les nouveaux
-- triggers de scope B2C/B2B s'appliquent déjà. Le binaire N utilise les capacités V2.
-- Phase 2 (activate, après readiness + mono-réplique) : toute preuve produite pendant la fenêtre
-- est matérialisée/revérifiée, puis les droits directs et les capacités V1 sont retirés dans la
-- même transaction que l'activation monotone. Un rollback N-1 devient ensuite interdit.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE TABLE public.document_archive_protocol_state (
  id SMALLINT PRIMARY KEY,
  "activeVersion" SMALLINT NOT NULL,
  "activatedAt" TIMESTAMPTZ,
  "activatedByReleaseSha" CHAR(40),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "document_archive_protocol_singleton" CHECK (id = 1),
  CONSTRAINT "document_archive_protocol_version" CHECK ("activeVersion" IN (1, 2)),
  CONSTRAINT "document_archive_protocol_activation_shape" CHECK (
    ("activeVersion" = 1 AND "activatedAt" IS NULL AND "activatedByReleaseSha" IS NULL)
    OR (
      "activeVersion" = 2
      AND "activatedAt" IS NOT NULL
      AND "activatedByReleaseSha" ~ '^[0-9a-f]{40}$'
    )
  )
);

INSERT INTO public.document_archive_protocol_state (id, "activeVersion") VALUES (1, 1);

CREATE FUNCTION public.enforce_document_archive_protocol_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document archive protocol state is append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'document_archive_protocol_monotone';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."activeVersion" < OLD."activeVersion"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."activeVersion" = 2 AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'document archive protocol cannot be downgraded or rewritten'
      USING ERRCODE = '23514', CONSTRAINT = 'document_archive_protocol_monotone';
  END IF;
  IF OLD."activeVersion" = 1
     AND NEW."activeVersion" = 1
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'document archive protocol V1 cannot be mutated before activation'
      USING ERRCODE = '23514', CONSTRAINT = 'document_archive_protocol_monotone';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_document_archive_protocol_monotonicity() FROM PUBLIC;

CREATE TRIGGER document_archive_protocol_monotonicity
BEFORE UPDATE OR DELETE ON public.document_archive_protocol_state
FOR EACH ROW
EXECUTE FUNCTION public.enforce_document_archive_protocol_monotonicity();

-- Le singleton est lisible par les fonctions runtime, mais son activation est une capacité de
-- déploiement DIRECT_URL exclusivement. Les projets Supabase peuvent hériter de privilèges de
-- table via leurs default privileges : on retire donc explicitement toute mutation Data API.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.document_archive_protocol_state FROM PUBLIC;
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER '
        'ON TABLE public.document_archive_protocol_state FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

-- Un manifeste ne constitue pas une preuve du profil interne d'un PDF. Ce verdict relie donc
-- l'artefact annoncé à l'attestation issue de la lecture de SES octets, puis relie, pour une
-- facture professionnelle, le SHA du XML embarqué au SHA du fichier XML séparé. Les factures
-- legacy sans audience figée restent volontairement non prouvables.
CREATE FUNCTION public.document_archive_job_pdf_attestation_v2_is_valid(
  expected_company_id TEXT,
  expected_piece_id TEXT,
  expected_reason TEXT,
  proof JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF NOT coalesce(public.document_archive_integrity_proof_for_reason_v2_is_valid(
    expected_company_id, expected_piece_id, expected_reason, proof
  ), false) THEN
    RETURN FALSE;
  END IF;

  -- Les devis signés n'embarquent pas de XML et conservent leur preuve PDF simple existante.
  IF expected_reason = 'quote-signed' THEN
    RETURN TRUE;
  END IF;

  IF expected_reason = 'invoice-issued-pdf-only-b2c' THEN
    RETURN EXISTS (
      SELECT 1
        FROM jsonb_array_elements(proof->'artifacts') AS pdf_item(artifact)
        JOIN public.documents AS document
          ON document.id = pdf_item.artifact->>'documentId'
         AND document."companyId" = expected_company_id
         AND document.kind = 'invoice_pdf'::public."StoredDocumentKind"
         AND document.origin = 'generated'::public."StoredDocumentOrigin"
         AND document.status = 'active'::public."StoredDocumentStatus"
         AND document."linkedEntityType" = 'invoice'::public."StoredDocumentLinkedEntityType"
         AND document."linkedEntityId" = expected_piece_id
         AND document."mimeType" = 'application/pdf'
         AND btrim(document.sha256::text) = pdf_item.artifact->>'sha256'
        JOIN public.document_versions AS version
          ON version.id = pdf_item.artifact->>'versionId'
         AND version."documentId" = document.id
         AND version.version = 1
         AND version.reason = expected_reason
         AND btrim(version.sha256::text) = btrim(document.sha256::text)
         AND version."storageKey" = document."storageKey"
         AND version."mimeType" = document."mimeType"
         AND version."byteSize" = document."byteSize"
        JOIN public.document_invoice_pdf_attestations AS attestation
          ON attestation."companyId" = expected_company_id
         AND attestation."documentId" = document.id
         AND attestation."versionId" = version.id
         AND btrim(attestation."documentSha256"::text) = btrim(document.sha256::text)
         AND attestation.profile = 'plain_pdf'
         AND attestation."embeddedXmlSha256" IS NULL
         AND attestation."detectorVersion" = 1
        JOIN public.invoices AS invoice
          ON invoice.id = expected_piece_id
         AND invoice."companyId" = expected_company_id
         AND invoice.number IS NOT NULL
         AND invoice."issuedAt" IS NOT NULL
         AND invoice.status <> 'draft'::public."InvoiceStatus"
         AND invoice."archiveAudienceAtIssuance" = 'consumer'
       WHERE pdf_item.artifact->>'kind' = 'invoice_pdf'
         AND pdf_item.artifact->>'contentProfile' = 'plain_pdf'
    );
  END IF;

  IF expected_reason = 'invoice-issued' THEN
    RETURN EXISTS (
      SELECT 1
        FROM jsonb_array_elements(proof->'artifacts') AS pdf_item(artifact)
        CROSS JOIN jsonb_array_elements(proof->'artifacts') AS xml_item(artifact)
        JOIN public.documents AS pdf_document
          ON pdf_document.id = pdf_item.artifact->>'documentId'
         AND pdf_document."companyId" = expected_company_id
         AND pdf_document.kind = 'invoice_pdf'::public."StoredDocumentKind"
         AND pdf_document.origin = 'generated'::public."StoredDocumentOrigin"
         AND pdf_document.status = 'active'::public."StoredDocumentStatus"
         AND pdf_document."linkedEntityType" = 'invoice'::public."StoredDocumentLinkedEntityType"
         AND pdf_document."linkedEntityId" = expected_piece_id
         AND pdf_document."mimeType" = 'application/pdf'
         AND btrim(pdf_document.sha256::text) = pdf_item.artifact->>'sha256'
        JOIN public.document_versions AS pdf_version
          ON pdf_version.id = pdf_item.artifact->>'versionId'
         AND pdf_version."documentId" = pdf_document.id
         AND pdf_version.version = 1
         AND pdf_version.reason = expected_reason
         AND btrim(pdf_version.sha256::text) = btrim(pdf_document.sha256::text)
         AND pdf_version."storageKey" = pdf_document."storageKey"
         AND pdf_version."mimeType" = pdf_document."mimeType"
         AND pdf_version."byteSize" = pdf_document."byteSize"
        JOIN public.document_invoice_pdf_attestations AS attestation
          ON attestation."companyId" = expected_company_id
         AND attestation."documentId" = pdf_document.id
         AND attestation."versionId" = pdf_version.id
         AND btrim(attestation."documentSha256"::text) = btrim(pdf_document.sha256::text)
         AND attestation.profile = 'facturx_pdfa3'
         AND btrim(attestation."embeddedXmlSha256"::text) = xml_item.artifact->>'sha256'
         AND attestation."detectorVersion" = 1
        JOIN public.documents AS xml_document
          ON xml_document.id = xml_item.artifact->>'documentId'
         AND xml_document."companyId" = expected_company_id
         AND xml_document.kind = 'facturx_xml'::public."StoredDocumentKind"
         AND xml_document.origin = 'generated'::public."StoredDocumentOrigin"
         AND xml_document.status = 'active'::public."StoredDocumentStatus"
         AND xml_document."linkedEntityType" = 'invoice'::public."StoredDocumentLinkedEntityType"
         AND xml_document."linkedEntityId" = expected_piece_id
         AND xml_document."mimeType" = 'application/xml'
         AND btrim(xml_document.sha256::text) = xml_item.artifact->>'sha256'
        JOIN public.document_versions AS xml_version
          ON xml_version.id = xml_item.artifact->>'versionId'
         AND xml_version."documentId" = xml_document.id
         AND xml_version.version = 1
         AND xml_version.reason = expected_reason
         AND btrim(xml_version.sha256::text) = btrim(xml_document.sha256::text)
         AND xml_version."storageKey" = xml_document."storageKey"
         AND xml_version."mimeType" = xml_document."mimeType"
         AND xml_version."byteSize" = xml_document."byteSize"
        JOIN public.invoices AS invoice
          ON invoice.id = expected_piece_id
         AND invoice."companyId" = expected_company_id
         AND invoice.number IS NOT NULL
         AND invoice."issuedAt" IS NOT NULL
         AND invoice.status <> 'draft'::public."InvoiceStatus"
         AND invoice."archiveAudienceAtIssuance" = 'professional'
       WHERE pdf_item.artifact->>'kind' = 'invoice_pdf'
         AND pdf_item.artifact->>'contentProfile' = 'facturx_pdfa3'
         AND xml_item.artifact->>'kind' = 'facturx_xml'
         AND xml_item.artifact->>'contentProfile' = 'facturx_xml'
    );
  END IF;

  RETURN FALSE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.document_archive_job_pdf_attestation_v2_is_valid(
  TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;

-- La policy RLS doit éviter le cycle documents -> document_versions -> documents. Ce helper
-- étroit lit avec row_security=off mais ne rend qu'un booléen, après avoir vérifié AVANT toute
-- lecture que le tenant GUC correspond au tenant demandé. Il reste privé au rôle runtime.
CREATE FUNCTION public.generated_invoice_pdf_attestation_visible_v2(
  expected_company_id TEXT,
  expected_document_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '')
       IS DISTINCT FROM expected_company_id THEN
    RETURN FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.document_archive_protocol_state AS protocol
     WHERE protocol.id = 1
       AND protocol."activeVersion" = 2
  ) THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.documents AS document
     WHERE document.id = expected_document_id
       AND document."companyId" = expected_company_id
       AND document.origin = 'generated'::public."StoredDocumentOrigin"
       AND document.kind = 'invoice_pdf'::public."StoredDocumentKind"
       AND public.generated_legal_archive_representation_v2_is_valid(document.id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.generated_invoice_pdf_attestation_visible_v2(TEXT, TEXT)
  FROM PUBLIC;

-- Capacité distincte réservée au scanner de cutover. Contrairement à la capacité runtime
-- permanente, elle verrouille le singleton et refuse toute écriture dès que l'activation V2 a
-- commencé. L'ordre de lock est protocole -> documents, identique au script d'activation.
CREATE FUNCTION public.attest_historical_generated_invoice_pdf_v1(
  input_company_id TEXT,
  input_document_id TEXT,
  input_version_id TEXT,
  input_document_sha256 TEXT,
  input_profile TEXT,
  input_embedded_xml_sha256 TEXT,
  input_detector_version SMALLINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  protocol_version SMALLINT;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '')
       IS DISTINCT FROM input_company_id THEN
    RETURN FALSE;
  END IF;

  SELECT protocol."activeVersion"
    INTO protocol_version
    FROM public.document_archive_protocol_state AS protocol
   WHERE protocol.id = 1
   FOR SHARE;
  IF NOT FOUND OR protocol_version <> 1 THEN
    RETURN FALSE;
  END IF;

  RETURN public.attest_generated_invoice_pdf_v1(
    input_company_id,
    input_document_id,
    input_version_id,
    input_document_sha256,
    input_profile,
    input_embedded_xml_sha256,
    input_detector_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attest_historical_generated_invoice_pdf_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, SMALLINT
) FROM PUBLIC;

-- Remplace l'enveloppe créée en 1337 : le job est verrouillé avant le contrôle, afin qu'un writer
-- N-1 ne puisse pas changer son scope entre la vérification de l'attestation et complete_v1.
CREATE OR REPLACE FUNCTION public.document_archive_job_complete_v2(
  input_id TEXT,
  input_company_id TEXT,
  input_lease_token TEXT,
  input_proof JSONB,
  expected_proof_sha256 TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  job_piece_id TEXT;
  job_reason TEXT;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '')
       IS DISTINCT FROM input_company_id
     OR btrim(coalesce(input_lease_token, '')) = '' THEN
    RETURN FALSE;
  END IF;

  SELECT job."invoiceId", job.reason
    INTO job_piece_id, job_reason
    FROM public.document_archive_jobs AS job
   WHERE job.id = input_id
     AND job."companyId" = input_company_id
     AND job."leaseToken" = input_lease_token
     AND job.status IN (
       'pending'::public."DocumentArchiveJobStatus",
       'failed'::public."DocumentArchiveJobStatus"
     )
     AND job."integrityProof" IS NULL
     AND job."nextAttemptAt" > statement_timestamp()
   FOR UPDATE;
  IF NOT FOUND
     OR NOT coalesce(public.document_archive_job_scope_v2_is_valid(
       input_company_id, job_piece_id, job_reason
     ), false)
     OR NOT coalesce(public.document_archive_job_pdf_attestation_v2_is_valid(
       input_company_id, job_piece_id, job_reason, input_proof
     ), false) THEN
    RETURN FALSE;
  END IF;

  RETURN public.document_archive_job_complete_v1(
    input_id,
    input_company_id,
    input_lease_token,
    input_proof,
    expected_proof_sha256
  );
END;
$$;

REVOKE ALL ON FUNCTION public.document_archive_job_complete_v2(
  TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC;

-- Matérialise les preuves produites avant la capacité complete_v1/v2 (ou par N-1 pendant la
-- fenêtre expand). Aucune donnée n'est inventée : chaque tuple JSON doit correspondre exactement
-- à l'original et à sa version immuables. La moindre divergence annule toute l'activation.
CREATE FUNCTION public.document_archive_backfill_proved_artifacts_v1()
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  job RECORD;
  expected_link_type TEXT;
  matched_artifacts INTEGER;
  materialized_artifacts INTEGER;
  inserted_rows INTEGER;
  inserted_total BIGINT := 0;
BEGIN
  FOR job IN
    SELECT archive_job.*
      FROM public.document_archive_jobs AS archive_job
     WHERE archive_job."integrityProof" IS NOT NULL
     ORDER BY archive_job."companyId", archive_job.id
     FOR UPDATE
  LOOP
    IF job.status <> 'done'::public."DocumentArchiveJobStatus"
       OR job."completedAt" IS NULL
       OR job."integrityProofSha256" IS NULL
       OR NOT coalesce(public.document_archive_integrity_proof_for_reason_v2_is_valid(
         job."companyId", job."invoiceId", job.reason, job."integrityProof"
       ), false)
       OR public.document_archive_integrity_proof_v1_sha256(job."integrityProof")
            IS DISTINCT FROM job."integrityProofSha256"
       OR NOT coalesce(public.document_archive_job_scope_v2_is_valid(
         job."companyId", job."invoiceId", job.reason
       ), false)
       OR NOT coalesce(public.document_archive_job_pdf_attestation_v2_is_valid(
         job."companyId", job."invoiceId", job.reason, job."integrityProof"
       ), false) THEN
      RAISE EXCEPTION 'document archive proof cannot be materialized for job %', job.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'document_archive_proof_materialization_valid';
    END IF;

    expected_link_type := CASE
      WHEN job.reason = 'quote-signed' THEN 'quote'
      ELSE 'invoice'
    END;

    SELECT count(*)::integer
      INTO matched_artifacts
      FROM jsonb_array_elements(job."integrityProof"->'artifacts') AS item(artifact)
      JOIN public.documents AS document
        ON document.id = item.artifact->>'documentId'
       AND document."companyId" = job."companyId"
       AND document.kind::text = item.artifact->>'kind'
       AND document.origin = 'generated'::public."StoredDocumentOrigin"
       AND document.status = 'active'::public."StoredDocumentStatus"
       AND document."linkedEntityType"::text = expected_link_type
       AND document."linkedEntityId" = job."invoiceId"
       AND document."storageKey" = item.artifact->>'storageKey'
       AND document."mimeType" = item.artifact->>'mimeType'
       AND document."byteSize" = (item.artifact->>'byteSize')::integer
       AND btrim(document.sha256::text) = item.artifact->>'sha256'
      JOIN public.document_versions AS version
        ON version.id = item.artifact->>'versionId'
       AND version."documentId" = document.id
       AND version.version = (item.artifact->>'version')::integer
       AND version."storageKey" = document."storageKey"
       AND version."mimeType" = document."mimeType"
       AND version."byteSize" = document."byteSize"
       AND btrim(version.sha256::text) = btrim(document.sha256::text)
       AND version.reason = job.reason;

    IF matched_artifacts <> jsonb_array_length(job."integrityProof"->'artifacts') THEN
      RAISE EXCEPTION 'document archive proof references unverified artifacts for job %', job.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'document_archive_proof_materialization_valid';
    END IF;

    INSERT INTO public.document_archive_job_artifacts (
      "jobId", "companyId", kind, "contentProfile", "documentId", "versionId", "versionNumber",
      "storageKey", "mimeType", "byteSize", sha256, "createdAt"
    )
    SELECT job.id,
           job."companyId",
           item.artifact->>'kind',
           item.artifact->>'contentProfile',
           item.artifact->>'documentId',
           item.artifact->>'versionId',
           (item.artifact->>'version')::integer,
           item.artifact->>'storageKey',
           item.artifact->>'mimeType',
           (item.artifact->>'byteSize')::integer,
           item.artifact->>'sha256',
           statement_timestamp()
      FROM jsonb_array_elements(job."integrityProof"->'artifacts') AS item(artifact)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    inserted_total := inserted_total + inserted_rows;

    SELECT count(*)::integer
      INTO materialized_artifacts
      FROM public.document_archive_job_artifacts AS artifact
     WHERE artifact."jobId" = job.id
       AND artifact."companyId" = job."companyId";

    IF materialized_artifacts <> jsonb_array_length(job."integrityProof"->'artifacts')
       OR EXISTS (
         SELECT 1
           FROM public.document_archive_job_artifacts AS artifact
          WHERE artifact."jobId" = job.id
            AND artifact."companyId" = job."companyId"
            AND NOT EXISTS (
              SELECT 1
                FROM jsonb_array_elements(job."integrityProof"->'artifacts') AS item(proof_artifact)
               WHERE item.proof_artifact->>'kind' = artifact.kind
                 AND item.proof_artifact->>'contentProfile' = artifact."contentProfile"
                 AND item.proof_artifact->>'documentId' = artifact."documentId"
                 AND item.proof_artifact->>'versionId' = artifact."versionId"
                 AND (item.proof_artifact->>'version')::integer = artifact."versionNumber"
                 AND item.proof_artifact->>'storageKey' = artifact."storageKey"
                 AND item.proof_artifact->>'mimeType' = artifact."mimeType"
                 AND (item.proof_artifact->>'byteSize')::integer = artifact."byteSize"
                 AND item.proof_artifact->>'sha256' = btrim(artifact.sha256::text)
            )
       ) THEN
      RAISE EXCEPTION 'document archive artifact projection conflicts for job %', job.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'document_archive_proof_materialization_valid';
    END IF;
  END LOOP;

  RETURN inserted_total;
END;
$$;

REVOKE ALL ON FUNCTION public.document_archive_backfill_proved_artifacts_v1() FROM PUBLIC;

-- Supabase peut appliquer des default privileges explicites aux rôles Data API lors de chaque
-- CREATE FUNCTION. La révocation vit dans LA MÊME transaction que les créations : aucune fenêtre
-- inter-migration ne peut exposer le backfill global SECURITY DEFINER via /rpc.
DO $$
DECLARE
  protected_names CONSTANT TEXT[] := ARRAY[
    'enforce_document_archive_protocol_monotonicity',
    'document_archive_job_pdf_attestation_v2_is_valid',
    'generated_invoice_pdf_attestation_visible_v2',
    'attest_historical_generated_invoice_pdf_v1',
    'document_archive_job_complete_v2',
    'document_archive_backfill_proved_artifacts_v1'
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
    RAISE EXCEPTION 'archive rollout RPC inventory drift';
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
