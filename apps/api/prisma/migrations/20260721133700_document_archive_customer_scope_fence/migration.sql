-- Clôture archive v4 — le motif d'archivage d'une facture est une conséquence du snapshot
-- d'audience capturé à l'émission, jamais une relecture future ni une préférence du worker :
--   B2C       -> PDF original uniquement (pas de faux Flux 2) ;
--   B2B / B2G -> PDF + XML Factur-X.
--
-- Le contrôle strict est activé en deux phases par la migration suivante : pendant l'expand,
-- N-1 conserve son format historique ; N utilise déjà les capacités V2 exactes. Après readiness,
-- l'activation réconcilie les seuls ordres non prouvés et ferme définitivement les anciens droits.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- Aucun writer ne doit pouvoir émettre une pièce ou modifier son client entre l'audit des lignes
-- existantes et l'installation des triggers.
LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_archive_jobs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_archive_job_artifacts IN SHARE ROW EXCLUSIVE MODE;

-- Une archive déjà PROUVÉE constitue une preuve de périmètre. Un ancien job non prouvé ne suffit
-- jamais : sa facture garde NULL et l'activation demandera une revue, plutôt que de transformer le
-- type client courant en prétendue vérité historique. Le trigger a été installé dès 1332 pour
-- fermer la course inter-migrations ; il est suspendu sous les verrous de CETTE transaction pour
-- ce seul backfill prouvé, puis immédiatement réarmé (un échec rollback aussi sa suspension).
ALTER TABLE public.invoices DISABLE TRIGGER invoices_capture_archive_audience;

UPDATE public.invoices AS invoice
   SET "archiveAudienceAtIssuance" = CASE
     WHEN job.reason = 'invoice-issued-pdf-only-b2c' THEN 'consumer'
     ELSE 'professional'
   END
  FROM public.document_archive_jobs AS job
 WHERE job."invoiceId" = invoice.id
   AND job."companyId" = invoice."companyId"
   AND job.reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c')
   AND job.status = 'done'::public."DocumentArchiveJobStatus"
   AND job."integrityProof" IS NOT NULL
   AND job."integrityProofSha256" IS NOT NULL
   AND job."completedAt" IS NOT NULL
   AND invoice.number IS NOT NULL
   AND invoice."issuedAt" IS NOT NULL
   AND invoice.status <> 'draft'::public."InvoiceStatus";

ALTER TABLE public.invoices ENABLE TRIGGER invoices_capture_archive_audience;

-- Fence de fenêtre mixed-version : N-1 générait systématiquement un XML pour toute facture. Même
-- avant l'activation V2, la base refuse donc qu'un worker historique matérialise un faux Flux 2
-- pour un consommateur (ou pour une facture legacy dont l'audience n'est pas prouvée).
CREATE FUNCTION public.guard_generated_invoice_facturx_scope_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  invoice_audience TEXT;
BEGIN
  IF NEW.kind <> 'facturx_xml'::public."StoredDocumentKind"
     OR NEW.origin <> 'generated'::public."StoredDocumentOrigin" THEN
    RETURN NEW;
  END IF;

  IF NEW."linkedEntityType" IS DISTINCT FROM 'invoice'::public."StoredDocumentLinkedEntityType"
     OR btrim(coalesce(NEW."linkedEntityId", '')) = '' THEN
    RAISE EXCEPTION 'generated Factur-X XML must be linked to an issued invoice'
      USING ERRCODE = '23514',
            CONSTRAINT = 'documents_generated_invoice_facturx_scope_valid';
  END IF;

  SELECT invoice."archiveAudienceAtIssuance"
    INTO invoice_audience
    FROM public.invoices AS invoice
   WHERE invoice.id = NEW."linkedEntityId"
     AND invoice."companyId" = NEW."companyId";
  IF NOT FOUND OR invoice_audience IS DISTINCT FROM 'professional' THEN
    RAISE EXCEPTION
      'generated Factur-X XML requires a professional audience frozen at invoice issuance'
      USING ERRCODE = '23514',
            CONSTRAINT = 'documents_generated_invoice_facturx_scope_valid';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_generated_invoice_facturx_scope_v1() FROM PUBLIC;

CREATE TRIGGER documents_generated_invoice_facturx_scope_valid
BEFORE INSERT OR UPDATE OF
  "companyId", kind, origin, "linkedEntityType", "linkedEntityId"
ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.guard_generated_invoice_facturx_scope_v1();

-- Attestation byte-derived : un libellé de job ou un MIME ne prouve pas qu'un PDF B2C ne contient
-- pas `factur-x.xml`. Seul le worker qui vient de parser les octets peut appeler cette capacité ;
-- le tuple est ensuite immuable et lié par FK au SHA de la version originale.
CREATE TABLE public.document_invoice_pdf_attestations (
  "companyId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "documentSha256" CHAR(64) NOT NULL,
  profile TEXT NOT NULL,
  "embeddedXmlSha256" CHAR(64),
  "detectorVersion" SMALLINT NOT NULL,
  "attestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "document_invoice_pdf_attestations_pkey"
    PRIMARY KEY ("documentId", "versionId"),
  CONSTRAINT "document_invoice_pdf_attestations_document_company_fkey"
    FOREIGN KEY ("companyId", "documentId")
    REFERENCES public.documents("companyId", id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "document_invoice_pdf_attestations_version_document_fkey"
    FOREIGN KEY ("documentId", "versionId")
    REFERENCES public.document_versions("documentId", id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "document_invoice_pdf_attestations_sha_valid"
    CHECK ("documentSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "document_invoice_pdf_attestations_detector_valid"
    CHECK ("detectorVersion" = 1),
  CONSTRAINT "document_invoice_pdf_attestations_profile_valid"
    CHECK (
      (profile = 'plain_pdf' AND "embeddedXmlSha256" IS NULL)
      OR (
        profile = 'facturx_pdfa3'
        AND "embeddedXmlSha256" ~ '^[0-9a-f]{64}$'
      )
    )
);

CREATE INDEX document_invoice_pdf_attestations_company_document_idx
  ON public.document_invoice_pdf_attestations("companyId", "documentId");

-- Attestation byte-derived immuable et privée. Sans ce deny immédiat, les default privileges
-- Supabase peuvent autoriser une fausse INSERT via la Data API avant l'application de rls.sql.
ALTER TABLE public.document_invoice_pdf_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_invoice_pdf_attestations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.document_invoice_pdf_attestations FROM PUBLIC;
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.document_invoice_pdf_attestations FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.guard_document_invoice_pdf_attestation_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'invoice PDF attestations are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'document_invoice_pdf_attestations_immutable';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_document_invoice_pdf_attestation_immutable_v1() FROM PUBLIC;

CREATE TRIGGER document_invoice_pdf_attestations_immutable
BEFORE UPDATE OR DELETE ON public.document_invoice_pdf_attestations
FOR EACH ROW
EXECUTE FUNCTION public.guard_document_invoice_pdf_attestation_immutable_v1();

CREATE FUNCTION public.attest_generated_invoice_pdf_v1(
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
  issuance_audience TEXT;
  actual_sha256 TEXT;
  changed_rows INTEGER;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '')
       IS DISTINCT FROM input_company_id
     OR input_detector_version <> 1
     OR input_document_sha256 !~ '^[0-9a-f]{64}$'
     OR input_profile NOT IN ('plain_pdf', 'facturx_pdfa3') THEN
    RAISE EXCEPTION 'invoice PDF attestation identity rejected'
      USING ERRCODE = '42501';
  END IF;

  SELECT invoice."archiveAudienceAtIssuance", btrim(document.sha256::text)
    INTO issuance_audience, actual_sha256
    FROM public.documents AS document
    JOIN public.document_versions AS version
      ON version.id = input_version_id
     AND version."documentId" = document.id
     AND version.version = 1
     AND btrim(version.sha256::text) = btrim(document.sha256::text)
     AND version."storageKey" = document."storageKey"
     AND version."mimeType" = document."mimeType"
     AND version."byteSize" = document."byteSize"
    JOIN public.invoices AS invoice
      ON invoice.id = document."linkedEntityId"
     AND invoice."companyId" = document."companyId"
   WHERE document.id = input_document_id
     AND document."companyId" = input_company_id
     AND document.kind = 'invoice_pdf'::public."StoredDocumentKind"
     AND document.origin = 'generated'::public."StoredDocumentOrigin"
     AND document.status = 'active'::public."StoredDocumentStatus"
     AND document."linkedEntityType" = 'invoice'::public."StoredDocumentLinkedEntityType"
     AND document."mimeType" = 'application/pdf'
   FOR SHARE OF document, version, invoice;
  IF NOT FOUND
     OR actual_sha256 IS DISTINCT FROM input_document_sha256
     OR issuance_audience IS NULL
     OR (
       issuance_audience = 'consumer'
       AND (
         input_profile <> 'plain_pdf'
         OR input_embedded_xml_sha256 IS NOT NULL
       )
     )
     OR (
       issuance_audience = 'professional'
       AND (
         input_profile <> 'facturx_pdfa3'
         OR input_embedded_xml_sha256 IS NULL
         OR input_embedded_xml_sha256 !~ '^[0-9a-f]{64}$'
       )
     ) THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.document_invoice_pdf_attestations (
    "companyId", "documentId", "versionId", "documentSha256", profile,
    "embeddedXmlSha256", "detectorVersion", "attestedAt"
  ) VALUES (
    input_company_id, input_document_id, input_version_id, input_document_sha256, input_profile,
    input_embedded_xml_sha256, input_detector_version, statement_timestamp()
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows = 1 THEN RETURN TRUE; END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.document_invoice_pdf_attestations AS attestation
     WHERE attestation."companyId" = input_company_id
       AND attestation."documentId" = input_document_id
       AND attestation."versionId" = input_version_id
       AND btrim(attestation."documentSha256"::text) = input_document_sha256
       AND attestation.profile = input_profile
       AND attestation."embeddedXmlSha256" IS NOT DISTINCT FROM input_embedded_xml_sha256
       AND attestation."detectorVersion" = input_detector_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attest_generated_invoice_pdf_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, SMALLINT
) FROM PUBLIC;

-- Attestation durable de la représentation produite. Le SHA prouve les octets ; le reason de la
-- version initiale prouve le chemin de génération qui leur est associé. En V2, un ancien writer
-- ne peut donc pas faire passer son PDF/A-3 B2C (`invoice-issued`) pour un PDF simple
-- (`invoice-issued-pdf-only-b2c`), même s'il reprend après les verrous du cutover.
CREATE FUNCTION public.generated_legal_archive_representation_v2_is_valid(
  expected_document_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT coalesce((
    SELECT CASE
      WHEN document.origin <> 'generated'::public."StoredDocumentOrigin"
        OR document.kind NOT IN (
          'invoice_pdf'::public."StoredDocumentKind",
          'facturx_xml'::public."StoredDocumentKind",
          'signed_quote'::public."StoredDocumentKind"
        ) THEN TRUE
      WHEN document.kind = 'invoice_pdf'::public."StoredDocumentKind" THEN
        document.status = 'active'::public."StoredDocumentStatus"
        AND document."mimeType" = 'application/pdf'
        AND document."linkedEntityType" = 'invoice'::public."StoredDocumentLinkedEntityType"
        AND invoice.id IS NOT NULL
        AND invoice.number IS NOT NULL
        AND invoice."issuedAt" IS NOT NULL
        AND invoice.status <> 'draft'::public."InvoiceStatus"
        AND version.version = 1
        AND attestation."documentId" = document.id
        AND attestation."versionId" = version.id
        AND btrim(attestation."documentSha256"::text) = btrim(document.sha256::text)
        AND attestation."detectorVersion" = 1
        AND (
          (
            invoice."archiveAudienceAtIssuance" = 'consumer'
            AND version.reason = 'invoice-issued-pdf-only-b2c'
            AND attestation.profile = 'plain_pdf'
            AND attestation."embeddedXmlSha256" IS NULL
          )
          OR (
            invoice."archiveAudienceAtIssuance" = 'professional'
            AND version.reason = 'invoice-issued'
            AND attestation.profile = 'facturx_pdfa3'
            AND attestation."embeddedXmlSha256" ~ '^[0-9a-f]{64}$'
          )
        )
        AND (
          SELECT count(*) = 1
            FROM public.document_versions AS all_versions
           WHERE all_versions."documentId" = document.id
        )
      WHEN document.kind = 'facturx_xml'::public."StoredDocumentKind" THEN
        document.status = 'active'::public."StoredDocumentStatus"
        AND document."mimeType" = 'application/xml'
        AND document."linkedEntityType" = 'invoice'::public."StoredDocumentLinkedEntityType"
        AND invoice.id IS NOT NULL
        AND invoice."archiveAudienceAtIssuance" = 'professional'
        AND invoice.number IS NOT NULL
        AND invoice."issuedAt" IS NOT NULL
        AND invoice.status <> 'draft'::public."InvoiceStatus"
        AND version.version = 1
        AND version.reason = 'invoice-issued'
        AND (
          SELECT count(*) = 1
            FROM public.document_versions AS all_versions
           WHERE all_versions."documentId" = document.id
        )
      ELSE
        document.status = 'active'::public."StoredDocumentStatus"
        AND document."mimeType" = 'application/pdf'
        AND document."linkedEntityType" = 'quote'::public."StoredDocumentLinkedEntityType"
        AND quote.id IS NOT NULL
        AND quote.status = 'signed'::public."QuoteStatus"
        AND quote."signedAt" IS NOT NULL
        AND version.version = 1
        AND version.reason = 'quote-signed'
        AND (
          SELECT count(*) = 1
            FROM public.document_versions AS all_versions
           WHERE all_versions."documentId" = document.id
        )
      END
      FROM public.documents AS document
      LEFT JOIN public.document_versions AS version
        ON version."documentId" = document.id
       AND version.version = 1
      LEFT JOIN public.document_invoice_pdf_attestations AS attestation
        ON attestation."companyId" = document."companyId"
       AND attestation."documentId" = document.id
       AND attestation."versionId" = version.id
      LEFT JOIN public.invoices AS invoice
        ON invoice.id = document."linkedEntityId"
       AND invoice."companyId" = document."companyId"
      LEFT JOIN public.quotes AS quote
        ON quote.id = document."linkedEntityId"
       AND quote."companyId" = document."companyId"
     WHERE document.id = expected_document_id
  ), FALSE);
$$;

REVOKE ALL ON FUNCTION public.generated_legal_archive_representation_v2_is_valid(TEXT)
  FROM PUBLIC;

CREATE FUNCTION public.guard_generated_legal_archive_representation_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  document_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    document_id := coalesce(NEW.id, OLD.id);
  ELSE
    document_id := CASE
      WHEN TG_OP = 'DELETE' THEN OLD."documentId"
      ELSE NEW."documentId"
    END;
  END IF;
  IF NOT public.document_archive_protocol_v2_is_active() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NOT coalesce(
    public.generated_legal_archive_representation_v2_is_valid(document_id),
    FALSE
  ) THEN
    RAISE EXCEPTION 'generated legal archive representation is invalid for V2'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_legal_archive_representation_v2_valid';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_generated_legal_archive_representation_v2() FROM PUBLIC;

-- Déféré à la fin de transaction : l'adapter insère d'abord `documents`, puis sa version 1.
CREATE CONSTRAINT TRIGGER documents_generated_legal_archive_representation_v2
AFTER INSERT OR UPDATE ON public.documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.guard_generated_legal_archive_representation_v2();

CREATE CONSTRAINT TRIGGER document_versions_generated_legal_archive_representation_v2
AFTER INSERT OR UPDATE OR DELETE ON public.document_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.guard_generated_legal_archive_representation_v2();

CREATE FUNCTION public.document_archive_job_scope_v2_is_valid(
  expected_company_id TEXT,
  expected_piece_id TEXT,
  expected_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT CASE
    WHEN expected_reason = 'quote-signed' THEN EXISTS (
      SELECT 1
        FROM public.quotes AS quote
       WHERE quote.id = expected_piece_id
         AND quote."companyId" = expected_company_id
         AND quote."signedAt" IS NOT NULL
         AND quote.status = 'signed'::public."QuoteStatus"
    )
    WHEN expected_reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c') THEN EXISTS (
      SELECT 1
        FROM public.invoices AS invoice
       WHERE invoice.id = expected_piece_id
         AND invoice."companyId" = expected_company_id
         AND invoice.number IS NOT NULL
         AND invoice."issuedAt" IS NOT NULL
         AND invoice.status <> 'draft'::public."InvoiceStatus"
         AND (
           (
             expected_reason = 'invoice-issued-pdf-only-b2c'
             AND invoice."archiveAudienceAtIssuance" = 'consumer'
           )
           OR (
             expected_reason = 'invoice-issued'
             AND invoice."archiveAudienceAtIssuance" = 'professional'
           )
         )
    )
    ELSE FALSE
  END;
$$;

REVOKE ALL ON FUNCTION public.document_archive_job_scope_v2_is_valid(TEXT, TEXT, TEXT)
  FROM PUBLIC;

CREATE FUNCTION public.guard_document_archive_job_scope_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  strict_scope BOOLEAN := FALSE;
  source_exists BOOLEAN := FALSE;
BEGIN
  -- La table de protocole est créée par la migration suivante. L'accès dynamique maintient cette
  -- migration elle-même compatible N-1 entre les deux commits Prisma.
  IF to_regclass('public.document_archive_protocol_state') IS NOT NULL THEN
    EXECUTE
      'SELECT "activeVersion" = 2 FROM public.document_archive_protocol_state WHERE id = 1'
      INTO strict_scope;
  END IF;

  IF strict_scope THEN
    source_exists := public.document_archive_job_scope_v2_is_valid(
      NEW."companyId", NEW."invoiceId", NEW.reason
    );
  ELSIF NEW.reason = 'quote-signed' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.quotes AS quote
       WHERE quote.id = NEW."invoiceId"
         AND quote."companyId" = NEW."companyId"
         AND quote.status = 'signed'::public."QuoteStatus"
         AND quote."signedAt" IS NOT NULL
    ) INTO source_exists;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.invoices AS invoice
       WHERE invoice.id = NEW."invoiceId"
         AND invoice."companyId" = NEW."companyId"
         AND invoice.number IS NOT NULL
         AND invoice."issuedAt" IS NOT NULL
         AND invoice.status <> 'draft'::public."InvoiceStatus"
    ) INTO source_exists;
  END IF;

  IF NOT coalesce(source_exists, false) THEN
    RAISE EXCEPTION 'document archive reason does not match its issued piece and customer type'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_jobs_customer_scope_valid';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_document_archive_job_scope_v2() FROM PUBLIC;

CREATE TRIGGER document_archive_jobs_customer_scope_valid
BEFORE INSERT OR UPDATE OF "companyId", "invoiceId", reason
ON public.document_archive_jobs
FOR EACH ROW
EXECUTE FUNCTION public.guard_document_archive_job_scope_v2();

-- V2 enveloppe les capacités existantes : l'algorithme de lease/digest reste unique, mais aucun
-- appel runtime ne peut désormais contourner la preuve de périmètre client.
CREATE FUNCTION public.document_archive_job_enqueue_v2(
  input_id TEXT,
  input_company_id TEXT,
  input_piece_id TEXT,
  input_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '')
       IS DISTINCT FROM input_company_id THEN
    RAISE EXCEPTION 'document archive enqueue identity rejected'
      USING ERRCODE = '42501';
  END IF;

  IF NOT coalesce(public.document_archive_job_scope_v2_is_valid(
    input_company_id, input_piece_id, input_reason
  ), false) THEN
    RAISE EXCEPTION 'document archive reason does not match its issued piece and customer type'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_jobs_customer_scope_valid';
  END IF;

  -- Pendant l'expand, un ordre N-1 non prouvé peut porter l'ancien scope `invoice-issued` pour
  -- un B2C. Le writer V2 le réarme sous le motif exact avant d'appeler l'algorithme d'enqueue.
  -- Une preuve ou un artefact existant interdit toute réécriture et force la revue d'activation.
  IF input_reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c') THEN
    UPDATE public.document_archive_jobs AS job
       SET reason = input_reason,
           status = 'pending'::public."DocumentArchiveJobStatus",
           "leaseToken" = NULL,
           "lastError" = NULL,
           "nextAttemptAt" = statement_timestamp(),
           "updatedAt" = statement_timestamp()
     WHERE job."companyId" = input_company_id
       AND job."invoiceId" = input_piece_id
       AND job.reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c')
       AND job.reason <> input_reason
       AND job."integrityProof" IS NULL
       AND job."integrityProofSha256" IS NULL
       AND job."completedAt" IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.document_archive_job_artifacts AS artifact
          WHERE artifact."jobId" = job.id
            AND artifact."companyId" = job."companyId"
       );
  END IF;

  RETURN public.document_archive_job_enqueue_v1(
    input_id, input_company_id, input_piece_id, input_reason
  );
END;
$$;

CREATE FUNCTION public.document_archive_job_complete_v2(
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
     AND job."companyId" = input_company_id;
  IF NOT FOUND OR NOT coalesce(public.document_archive_job_scope_v2_is_valid(
    input_company_id, job_piece_id, job_reason
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

REVOKE ALL ON FUNCTION public.document_archive_job_enqueue_v2(TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_archive_job_complete_v2(TEXT, TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC;

-- Ferme dans la transaction de création les grants RPC issus des default privileges Supabase.
-- Les deux validateurs profonds sont volontairement non tenant-scopés et ne doivent jamais
-- devenir des oracles Data API, même pendant les migrations suivantes.
DO $$
DECLARE
  protected_names CONSTANT TEXT[] := ARRAY[
    'guard_generated_invoice_facturx_scope_v1',
    'guard_document_invoice_pdf_attestation_immutable_v1',
    'attest_generated_invoice_pdf_v1',
    'generated_legal_archive_representation_v2_is_valid',
    'guard_generated_legal_archive_representation_v2',
    'document_archive_job_scope_v2_is_valid',
    'guard_document_archive_job_scope_v2',
    'document_archive_job_enqueue_v2',
    'document_archive_job_complete_v2'
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
    RAISE EXCEPTION 'archive customer-scope RPC inventory drift';
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
