-- Clôture archive v3 — un rôle runtime ne mute plus directement l'outbox. Quatre capacités
-- SECURITY DEFININER bornées portent enqueue/lease/échec/terminaison. La terminaison recalcule
-- le digest canonique en base et matérialise chaque artefact avec des FK fortes vers l'original
-- et sa version. Cela prouve la cohérence du manifeste avec les métadonnées SQL immuables ; cela
-- ne transforme pas le stockage objet en WORM et ne remplace pas sa relecture applicative.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE UNIQUE INDEX "uniq_document_version_document_id"
  ON public.document_versions("documentId", id);

CREATE UNIQUE INDEX "uniq_document_archive_job_company"
  ON public.document_archive_jobs(id, "companyId");

-- Le canal de sortie est figé dans le motif : une facture B2C sans endpoint n'a qu'un original
-- PDF local. Elle ne doit jamais être forcée dans un faux manifeste PDF+XML.
ALTER TABLE public.document_archive_jobs
  DROP CONSTRAINT "document_archive_jobs_reason_valid",
  DROP CONSTRAINT "document_archive_jobs_integrity_proof_shape";

CREATE FUNCTION public.document_archive_integrity_proof_for_reason_v2_is_valid(
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
  proof_key_count INTEGER;
  artifact_key_count INTEGER;
BEGIN
  IF expected_reason IN ('invoice-issued', 'quote-signed') THEN
    RETURN public.document_archive_integrity_proof_v1_is_valid(
      expected_company_id, expected_piece_id, expected_reason, proof
    );
  END IF;
  IF expected_reason <> 'invoice-issued-pdf-only-b2c'
     OR jsonb_typeof(proof) <> 'object' THEN
    RETURN FALSE;
  END IF;

  SELECT count(*) INTO proof_key_count FROM jsonb_object_keys(proof);
  IF proof_key_count <> 6
     OR proof->>'version' <> '1'
     OR proof->>'algorithm' <> 'sha256'
     OR proof->>'companyId' <> expected_company_id
     OR proof->>'pieceId' <> expected_piece_id
     OR proof->>'reason' <> expected_reason
     OR jsonb_typeof(proof->'artifacts') <> 'array'
     OR jsonb_array_length(proof->'artifacts') <> 1 THEN
    RETURN FALSE;
  END IF;

  artifact := proof->'artifacts'->0;
  IF jsonb_typeof(artifact) <> 'object' THEN RETURN FALSE; END IF;
  SELECT count(*) INTO artifact_key_count FROM jsonb_object_keys(artifact);
  RETURN artifact_key_count = 9
    AND artifact ?& ARRAY[
      'kind', 'documentId', 'versionId', 'version',
      'storageKey', 'mimeType', 'byteSize', 'sha256', 'contentProfile'
    ]
    AND artifact->>'kind' = 'invoice_pdf'
    AND artifact->>'mimeType' = 'application/pdf'
    AND artifact->>'contentProfile' = 'plain_pdf'
    AND artifact->>'version' = '1'
    AND jsonb_typeof(artifact->'byteSize') = 'number'
    AND (artifact->>'byteSize')::numeric = trunc((artifact->>'byteSize')::numeric)
    AND (artifact->>'byteSize')::numeric BETWEEN 1 AND 9007199254740991
    AND btrim(coalesce(artifact->>'documentId', '')) <> ''
    AND btrim(coalesce(artifact->>'versionId', '')) <> ''
    AND btrim(coalesce(artifact->>'storageKey', '')) <> ''
    AND (artifact->>'storageKey') LIKE (
      'companies/' || expected_company_id || '/documents/'
      || (artifact->>'documentId') || '/%'
    )
    AND (artifact->>'storageKey') NOT LIKE '%..%'
    AND (artifact->>'storageKey') NOT LIKE '%//%'
    AND coalesce(artifact->>'sha256', '') ~ '^[0-9a-f]{64}$';
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

ALTER TABLE public.document_archive_jobs
  ADD CONSTRAINT "document_archive_jobs_reason_valid"
    CHECK (reason IN (
      'invoice-issued', 'invoice-issued-pdf-only-b2c', 'quote-signed'
    )),
  ADD CONSTRAINT "document_archive_jobs_integrity_proof_shape"
    CHECK (
      "integrityProof" IS NULL
      OR coalesce(public.document_archive_integrity_proof_for_reason_v2_is_valid(
        "companyId", "invoiceId", reason, "integrityProof"
      ), false)
    );

-- Une facture ne peut pas changer silencieusement de périmètre après le premier ordre. Le scope
-- PDF seul / PDF+XML est une décision d'émission figée, pas une préférence mutable du worker.
CREATE UNIQUE INDEX "uniq_document_archive_invoice_scope"
  ON public.document_archive_jobs("companyId", "invoiceId")
  WHERE reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c');

CREATE TABLE public.document_archive_job_artifacts (
  "jobId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  kind TEXT NOT NULL,
  "contentProfile" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "document_archive_job_artifacts_pkey" PRIMARY KEY ("jobId", kind),
  CONSTRAINT "document_archive_job_artifacts_job_company_fkey"
    FOREIGN KEY ("jobId", "companyId")
    REFERENCES public.document_archive_jobs(id, "companyId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "document_archive_job_artifacts_document_company_fkey"
    FOREIGN KEY ("companyId", "documentId")
    REFERENCES public.documents("companyId", id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "document_archive_job_artifacts_version_document_fkey"
    FOREIGN KEY ("documentId", "versionId")
    REFERENCES public.document_versions("documentId", id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "document_archive_job_artifacts_kind_valid"
    CHECK (kind IN ('invoice_pdf', 'facturx_xml', 'signed_quote')),
  CONSTRAINT "document_archive_job_artifacts_content_profile_valid"
    CHECK (
      (kind = 'invoice_pdf' AND "contentProfile" IN ('plain_pdf', 'facturx_pdfa3'))
      OR (kind = 'facturx_xml' AND "contentProfile" = 'facturx_xml')
      OR (kind = 'signed_quote' AND "contentProfile" = 'plain_pdf')
    ),
  CONSTRAINT "document_archive_job_artifacts_version_valid"
    CHECK ("versionNumber" = 1),
  CONSTRAINT "document_archive_job_artifacts_mime_valid"
    CHECK (
      (kind = 'facturx_xml' AND "mimeType" = 'application/xml')
      OR (kind IN ('invoice_pdf', 'signed_quote') AND "mimeType" = 'application/pdf')
    ),
  CONSTRAINT "document_archive_job_artifacts_size_valid" CHECK ("byteSize" > 0),
  CONSTRAINT "document_archive_job_artifacts_sha256_valid"
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "uniq_document_archive_job_artifact_document" UNIQUE ("jobId", "documentId"),
  CONSTRAINT "uniq_document_archive_job_artifact_version" UNIQUE ("jobId", "versionId")
);

CREATE INDEX "document_archive_job_artifacts_company_job_idx"
  ON public.document_archive_job_artifacts("companyId", "jobId");

-- Projection privée : aucun accès Data API n'est admis entre la migration et l'installation des
-- policies tenant par release.sh. Les fonctions SECURITY DEFINER restent l'unique writer.
ALTER TABLE public.document_archive_job_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_job_artifacts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.document_archive_job_artifacts FROM PUBLIC;
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.document_archive_job_artifacts FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

-- Reproduit exactement documentArchiveIntegrityProofSha256 : JSON.stringify d'un tableau
-- canonique, avec artefacts triés par kind. `to_jsonb(text)::text` fournit l'échappement JSON
-- des chaînes ; SHA-256 est la primitive native pg_catalog, sans extension facultative.
CREATE FUNCTION public.document_archive_integrity_proof_v1_sha256(proof JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  artifacts_canonical TEXT;
  canonical TEXT;
BEGIN
  IF jsonb_typeof(proof) <> 'object'
     OR jsonb_typeof(proof->'artifacts') <> 'array' THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(string_agg(
    '['
      || to_jsonb(artifact->>'kind')::text || ','
      || to_jsonb(artifact->>'contentProfile')::text || ','
      || to_jsonb(artifact->>'documentId')::text || ','
      || to_jsonb(artifact->>'versionId')::text || ','
      || coalesce(artifact->>'version', 'null') || ','
      || to_jsonb(artifact->>'storageKey')::text || ','
      || to_jsonb(artifact->>'mimeType')::text || ','
      || coalesce(artifact->>'byteSize', 'null') || ','
      || to_jsonb(artifact->>'sha256')::text
      || ']',
    ',' ORDER BY artifact->>'kind' COLLATE "C"
  ), '')
    INTO artifacts_canonical
    FROM jsonb_array_elements(proof->'artifacts') AS item(artifact);

  canonical := '['
    || coalesce(proof->>'version', 'null') || ','
    || to_jsonb(proof->>'algorithm')::text || ','
    || to_jsonb(proof->>'companyId')::text || ','
    || to_jsonb(proof->>'pieceId')::text || ','
    || to_jsonb(proof->>'reason')::text || ',['
    || artifacts_canonical || ']]';

  RETURN encode(sha256(convert_to(canonical, 'UTF8')), 'hex');
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.document_archive_job_enqueue_v1(
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
DECLARE
  changed_rows INTEGER;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '') IS DISTINCT FROM input_company_id
     OR btrim(input_id) = ''
     OR btrim(input_piece_id) = ''
     OR input_reason NOT IN (
       'invoice-issued', 'invoice-issued-pdf-only-b2c', 'quote-signed'
     ) THEN
    RAISE EXCEPTION 'document archive enqueue identity rejected'
      USING ERRCODE = '42501';
  END IF;

  IF input_reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c') AND NOT EXISTS (
    SELECT 1 FROM public.invoices AS invoice
     WHERE invoice.id = input_piece_id
       AND invoice."companyId" = input_company_id
       AND invoice.number IS NOT NULL
       AND invoice."issuedAt" IS NOT NULL
       AND invoice.status <> 'draft'::public."InvoiceStatus"
  ) THEN
    RAISE EXCEPTION 'document archive invoice source missing or not issued'
      USING ERRCODE = '23503';
  ELSIF input_reason = 'quote-signed' AND NOT EXISTS (
    SELECT 1 FROM public.quotes AS quote
     WHERE quote.id = input_piece_id
       AND quote."companyId" = input_company_id
       AND quote.status = 'signed'::public."QuoteStatus"
       AND quote."signedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'document archive quote source missing or not signed'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.document_archive_jobs (
    id, "companyId", "invoiceId", reason, status, attempts,
    "nextAttemptAt", "createdAt", "updatedAt"
  ) VALUES (
    input_id, input_company_id, input_piece_id, input_reason,
    'pending'::public."DocumentArchiveJobStatus", 0,
    statement_timestamp(), statement_timestamp(), statement_timestamp()
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows = 1 THEN RETURN TRUE; END IF;

  IF EXISTS (
    SELECT 1
      FROM public.document_archive_jobs AS job
     WHERE job."companyId" = input_company_id
       AND job."invoiceId" = input_piece_id
       AND job.reason = input_reason
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

CREATE FUNCTION public.document_archive_job_claim_v1(
  input_id TEXT,
  input_company_id TEXT,
  expected_updated_at TIMESTAMP(3),
  lease_milliseconds BIGINT,
  input_lease_token TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  changed_rows INTEGER;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '') IS DISTINCT FROM input_company_id
     OR lease_milliseconds < 1
     OR lease_milliseconds > 1800000
     OR btrim(input_lease_token) = '' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.document_archive_jobs
     SET status = 'failed'::public."DocumentArchiveJobStatus",
         "leaseToken" = input_lease_token,
         "nextAttemptAt" = statement_timestamp()
           + (lease_milliseconds * INTERVAL '1 millisecond'),
         "updatedAt" = statement_timestamp()
   WHERE id = input_id
     AND "companyId" = input_company_id
     AND "updatedAt" = expected_updated_at
     AND "nextAttemptAt" <= statement_timestamp()
     AND "integrityProof" IS NULL
     AND status IN (
       'pending'::public."DocumentArchiveJobStatus",
       'failed'::public."DocumentArchiveJobStatus",
       'done'::public."DocumentArchiveJobStatus"
     );
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RETURN changed_rows = 1;
END;
$$;

CREATE FUNCTION public.document_archive_job_fail_v1(
  input_id TEXT,
  input_company_id TEXT,
  input_lease_token TEXT,
  retry_milliseconds BIGINT,
  input_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  changed_rows INTEGER;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '') IS DISTINCT FROM input_company_id
     OR retry_milliseconds < 1
     OR retry_milliseconds > 86400000 THEN
    RETURN FALSE;
  END IF;

  UPDATE public.document_archive_jobs
     SET status = 'failed'::public."DocumentArchiveJobStatus",
         attempts = attempts + 1,
         "leaseToken" = NULL,
         "nextAttemptAt" = statement_timestamp()
           + (retry_milliseconds * INTERVAL '1 millisecond'),
         "lastError" = left(input_error, 2000),
         "integrityProof" = NULL,
         "integrityProofSha256" = NULL,
         "completedAt" = NULL,
         "updatedAt" = statement_timestamp()
   WHERE id = input_id
     AND "companyId" = input_company_id
     AND "leaseToken" = input_lease_token
     AND status IN (
       'pending'::public."DocumentArchiveJobStatus",
       'failed'::public."DocumentArchiveJobStatus"
     )
     AND "nextAttemptAt" > statement_timestamp();
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RETURN changed_rows = 1;
END;
$$;

CREATE FUNCTION public.document_archive_job_complete_v1(
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
  expected_link_type TEXT;
  matched_artifacts INTEGER;
  changed_rows INTEGER;
  computed_sha256 TEXT;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '') IS DISTINCT FROM input_company_id
     OR btrim(input_lease_token) = '' THEN
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
  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF NOT coalesce(public.document_archive_integrity_proof_for_reason_v2_is_valid(
    input_company_id, job_piece_id, job_reason, input_proof
  ), false) THEN
    RETURN FALSE;
  END IF;

  computed_sha256 := public.document_archive_integrity_proof_v1_sha256(input_proof);
  IF computed_sha256 IS NULL
     OR computed_sha256 IS DISTINCT FROM expected_proof_sha256 THEN
    RETURN FALSE;
  END IF;

  IF job_reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c') THEN
    expected_link_type := 'invoice';
    IF NOT EXISTS (
      SELECT 1 FROM public.invoices AS invoice
       WHERE invoice.id = job_piece_id
         AND invoice."companyId" = input_company_id
         AND invoice.number IS NOT NULL
         AND invoice."issuedAt" IS NOT NULL
         AND invoice.status <> 'draft'::public."InvoiceStatus"
    ) THEN RETURN FALSE; END IF;
  ELSIF job_reason = 'quote-signed' THEN
    expected_link_type := 'quote';
    IF NOT EXISTS (
      SELECT 1 FROM public.quotes AS quote
       WHERE quote.id = job_piece_id
         AND quote."companyId" = input_company_id
         AND quote.status = 'signed'::public."QuoteStatus"
         AND quote."signedAt" IS NOT NULL
    ) THEN RETURN FALSE; END IF;
  ELSE
    RETURN FALSE;
  END IF;

  -- Chaque tuple annoncé doit être l'exact snapshot de l'original ET de sa version initiale.
  -- Les colonnes légales correspondantes sont gelées par la migration 1333.
  SELECT count(*)::integer
    INTO matched_artifacts
    FROM jsonb_array_elements(input_proof->'artifacts') AS item(artifact)
    JOIN public.documents AS document
      ON document.id = item.artifact->>'documentId'
     AND document."companyId" = input_company_id
     AND document.kind::text = item.artifact->>'kind'
     AND document.origin = 'generated'::public."StoredDocumentOrigin"
     AND document.status = 'active'::public."StoredDocumentStatus"
     AND document."linkedEntityType"::text = expected_link_type
     AND document."linkedEntityId" = job_piece_id
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
     -- Le reason de la version est l'attestation durable du chemin de génération. Accepter
     -- `invoice-issued` pour un job B2C permettrait à un ancien PDF/A-3 hybride de se faire passer
     -- pour le PDF simple attendu.
     AND version.reason = job_reason;

  IF matched_artifacts <> jsonb_array_length(input_proof->'artifacts')
     OR EXISTS (
       SELECT 1 FROM public.document_archive_job_artifacts AS artifact
        WHERE artifact."jobId" = input_id
     ) THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.document_archive_job_artifacts (
    "jobId", "companyId", kind, "contentProfile", "documentId", "versionId", "versionNumber",
    "storageKey", "mimeType", "byteSize", sha256, "createdAt"
  )
  SELECT input_id,
         input_company_id,
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
    FROM jsonb_array_elements(input_proof->'artifacts') AS item(artifact);

  UPDATE public.document_archive_jobs
     SET status = 'done'::public."DocumentArchiveJobStatus",
         "leaseToken" = NULL,
         "lastError" = NULL,
         "integrityProof" = input_proof,
         "integrityProofSha256" = computed_sha256,
         "completedAt" = statement_timestamp(),
         "updatedAt" = statement_timestamp()
   WHERE id = input_id
     AND "companyId" = input_company_id
     AND "leaseToken" = input_lease_token
     AND status IN (
       'pending'::public."DocumentArchiveJobStatus",
       'failed'::public."DocumentArchiveJobStatus"
     );
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'document archive completion lost its lease'
      USING ERRCODE = '40001';
  END IF;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.document_archive_integrity_proof_v1_sha256(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_archive_integrity_proof_for_reason_v2_is_valid(
  TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_archive_job_enqueue_v1(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_archive_job_claim_v1(TEXT, TEXT, TIMESTAMP, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_archive_job_fail_v1(TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_archive_job_complete_v1(TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;

-- Les capacités d'outbox sont accordées ensuite au rôle applicatif dédié par release.sh. Les
-- rôles Data API ne les héritent jamais, y compris entre cette migration et le rail final 1342.
DO $$
DECLARE
  protected_names CONSTANT TEXT[] := ARRAY[
    'document_archive_integrity_proof_for_reason_v2_is_valid',
    'document_archive_integrity_proof_v1_sha256',
    'document_archive_job_enqueue_v1',
    'document_archive_job_claim_v1',
    'document_archive_job_fail_v1',
    'document_archive_job_complete_v1'
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
    RAISE EXCEPTION 'archive closure RPC inventory drift';
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
