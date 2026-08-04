-- Archive renderer snapshot V1 — expand compatible N-1.
-- Le protocole archive V2 existant est terminal : ce rail append-only distinct ne le rouvre pas.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- Supabase : le déployeur n'est ni superuser ni propriétaire des objets protégés. Toute la
-- migration s'exécute sous le propriétaire canonique déjà porté par document_archive_jobs.
DO $document_archive_snapshot_expand_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
  owner_had_schema_create BOOLEAN;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'document_archive_jobs'
     AND relation.relkind IN ('r', 'p');

  owner_had_schema_create := pg_catalog.has_schema_privilege(
    schema_owner_oid,
    'public',
    'CREATE'
  );
  PERFORM pg_catalog.set_config(
    'bob.document_archive_snapshot_owner_had_schema_create',
    CASE WHEN owner_had_schema_create THEN 'true' ELSE 'false' END,
    true
  );
  IF NOT owner_had_schema_create THEN
    -- Fenêtre transactionnelle minimale : Supabase retire CREATE au NOLOGIN owner au repos.
    -- Le déployeur propriétaire du schéma l'accorde uniquement pour ce train, puis le reprend
    -- avant COMMIT sans toucher à USAGE.
    EXECUTE pg_catalog.format('GRANT CREATE ON SCHEMA public TO %I', schema_owner_name);
    IF NOT pg_catalog.has_schema_privilege(schema_owner_oid, 'public', 'CREATE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_ARCHIVE_SNAPSHOT_SCHEMA_CREATE_GRANT_FAILED';
    END IF;
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_ARCHIVE_SNAPSHOT_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;
  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_ARCHIVE_SNAPSHOT_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$document_archive_snapshot_expand_owner$;

CREATE TABLE public.document_archive_render_snapshots (
  "jobId" TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "pieceId" TEXT NOT NULL,
  reason TEXT NOT NULL,
  "schemaVersion" SMALLINT NOT NULL,
  "rendererVersion" SMALLINT NOT NULL,
  payload TEXT NOT NULL,
  "payloadSha256" CHAR(64) NOT NULL,
  "renderAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "uniq_document_archive_render_snapshot_company"
    UNIQUE ("jobId", "companyId"),
  CONSTRAINT "uniq_document_archive_render_snapshot_digest"
    UNIQUE ("jobId", "companyId", "payloadSha256")
);

CREATE INDEX "document_archive_render_snapshots_company_piece_idx"
  ON public.document_archive_render_snapshots("companyId", "pieceId");

CREATE TABLE public.document_archive_artifact_intents (
  "jobId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "snapshotSha256" CHAR(64) NOT NULL,
  kind TEXT NOT NULL,
  "contentProfile" TEXT NOT NULL,
  "documentId" TEXT NOT NULL UNIQUE,
  "versionId" TEXT NOT NULL UNIQUE,
  "versionNumber" SMALLINT NOT NULL,
  filename TEXT NOT NULL,
  "storageKey" TEXT NOT NULL UNIQUE,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  "preparedAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "document_archive_artifact_intents_pkey" PRIMARY KEY ("jobId", kind)
);

CREATE INDEX "document_archive_artifact_intents_company_job_idx"
  ON public.document_archive_artifact_intents("companyId", "jobId");

CREATE TABLE public.document_archive_snapshot_protocol_state (
  id SMALLINT PRIMARY KEY,
  "activeVersion" SMALLINT NOT NULL,
  "activatedAt" TIMESTAMPTZ,
  "activatedByReleaseSha" CHAR(40),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "document_archive_snapshot_protocol_singleton" CHECK (id = 1),
  CONSTRAINT "document_archive_snapshot_protocol_version" CHECK ("activeVersion" IN (1, 2)),
  CONSTRAINT "document_archive_snapshot_protocol_activation_shape" CHECK (
    ("activeVersion" = 1 AND "activatedAt" IS NULL AND "activatedByReleaseSha" IS NULL)
    OR (
      "activeVersion" = 2
      AND "activatedAt" IS NOT NULL
      AND "activatedByReleaseSha" ~ '^[0-9a-f]{40}$'
    )
  )
);

INSERT INTO public.document_archive_snapshot_protocol_state (id, "activeVersion") VALUES (1, 1);

-- Checks/FK ajoutés NOT VALID ; la migration suivante les valide séparément.
ALTER TABLE public.document_archive_render_snapshots
  ADD CONSTRAINT "document_archive_render_snapshots_job_fkey"
    FOREIGN KEY ("jobId", "companyId")
    REFERENCES public.document_archive_jobs(id, "companyId")
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "document_archive_render_snapshot_versions_valid"
    CHECK ("schemaVersion" = 1 AND "rendererVersion" = 1) NOT VALID,
  ADD CONSTRAINT "document_archive_render_snapshot_reason_valid"
    CHECK (reason IN (
      -- DOCUMENT_ARCHIVE_REASON_CHECK_START
      'invoice-issued',
      'invoice-issued-pdf-only-b2c',
      'quote-signed'
      -- DOCUMENT_ARCHIVE_REASON_CHECK_END
    )) NOT VALID,
  ADD CONSTRAINT "document_archive_render_snapshot_digest_valid"
    CHECK ("payloadSha256" ~ '^[0-9a-f]{64}$') NOT VALID,
  ADD CONSTRAINT "document_archive_render_snapshot_payload_size_valid"
    CHECK (octet_length(payload) BETWEEN 2 AND 1048576) NOT VALID,
  ADD CONSTRAINT "document_archive_render_snapshot_payload_json_valid"
    CHECK (pg_catalog.jsonb_typeof(payload::jsonb) = 'object') NOT VALID;

ALTER TABLE public.document_archive_artifact_intents
  ADD CONSTRAINT "document_archive_artifact_intents_snapshot_fkey"
    FOREIGN KEY ("jobId", "companyId", "snapshotSha256")
    REFERENCES public.document_archive_render_snapshots("jobId", "companyId", "payloadSha256")
    ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "document_archive_artifact_intent_kind_valid"
    CHECK (kind IN (
      -- DOCUMENT_ARCHIVE_KIND_CHECK_START
      'invoice_pdf',
      'facturx_xml',
      'signed_quote'
      -- DOCUMENT_ARCHIVE_KIND_CHECK_END
    )) NOT VALID,
  ADD CONSTRAINT "document_archive_artifact_intent_profile_valid"
    CHECK ("contentProfile" IN (
      -- DOCUMENT_ARCHIVE_PROFILE_CHECK_START
      'plain_pdf',
      'facturx_pdfa3',
      'facturx_xml'
      -- DOCUMENT_ARCHIVE_PROFILE_CHECK_END
    )) NOT VALID,
  ADD CONSTRAINT "document_archive_artifact_intent_version_valid"
    CHECK ("versionNumber" = 1) NOT VALID,
  ADD CONSTRAINT "document_archive_artifact_intent_bytes_valid"
    CHECK ("byteSize" > 0) NOT VALID,
  ADD CONSTRAINT "document_archive_artifact_intent_digest_valid"
    CHECK (sha256 ~ '^[0-9a-f]{64}$' AND "snapshotSha256" ~ '^[0-9a-f]{64}$') NOT VALID;

CREATE FUNCTION public.enforce_document_archive_snapshot_protocol_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document archive snapshot protocol state is append-only'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_snapshot_protocol_monotone';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."activeVersion" < OLD."activeVersion"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."activeVersion" = 2 AND NEW IS DISTINCT FROM OLD)
     OR (OLD."activeVersion" = 1 AND NEW."activeVersion" = 1 AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'document archive snapshot protocol cannot be rewritten or downgraded'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_snapshot_protocol_monotone';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_archive_snapshot_protocol_monotonicity
BEFORE UPDATE OR DELETE ON public.document_archive_snapshot_protocol_state
FOR EACH ROW EXECUTE FUNCTION public.enforce_document_archive_snapshot_protocol_monotonicity();

CREATE FUNCTION public.prevent_document_archive_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'document archive render snapshots are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'document_archive_render_snapshot_immutable';
END;
$$;

CREATE TRIGGER document_archive_render_snapshot_immutable
BEFORE UPDATE OR DELETE ON public.document_archive_render_snapshots
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_snapshot_mutation();

CREATE FUNCTION public.prevent_document_archive_artifact_intent_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'document archive artifact intents are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'document_archive_artifact_intent_immutable';
END;
$$;

CREATE TRIGGER document_archive_artifact_intent_immutable
BEFORE UPDATE OR DELETE ON public.document_archive_artifact_intents
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_artifact_intent_mutation();

-- Après activation, un writer N-1 qui tente un INSERT sans snapshot échoue au COMMIT.
CREATE FUNCTION public.guard_document_archive_job_snapshot_required_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.document_archive_snapshot_protocol_state AS protocol
     WHERE protocol.id = 1 AND protocol."activeVersion" = 2
  ) AND NOT EXISTS (
    SELECT 1
      FROM public.document_archive_render_snapshots AS snapshot
     WHERE snapshot."jobId" = NEW.id
       AND snapshot."companyId" = NEW."companyId"
  ) THEN
    RAISE EXCEPTION 'document archive render snapshot is required after cutover'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_job_snapshot_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER document_archive_job_snapshot_required
AFTER INSERT ON public.document_archive_jobs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.guard_document_archive_job_snapshot_required_v1();

CREATE FUNCTION public.document_archive_job_enqueue_v3(
  input_id TEXT,
  input_company_id TEXT,
  input_piece_id TEXT,
  input_reason TEXT,
  input_snapshot_schema_version SMALLINT,
  input_renderer_version SMALLINT,
  input_snapshot_payload TEXT,
  input_snapshot_sha256 TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  parsed_payload JSONB;
  existing_job RECORD;
  accepted BOOLEAN;
  persisted_job_id TEXT;
  inserted_rows INTEGER;
  expected_artifact_count INTEGER;
  artifact JSONB;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '')
       IS DISTINCT FROM input_company_id
     OR btrim(coalesce(input_id, '')) = ''
     OR btrim(coalesce(input_piece_id, '')) = ''
     OR coalesce(input_reason, '') NOT IN (
       -- DOCUMENT_ARCHIVE_REASON_ENQUEUE_START
       'invoice-issued',
       'invoice-issued-pdf-only-b2c',
       'quote-signed'
       -- DOCUMENT_ARCHIVE_REASON_ENQUEUE_END
     )
     OR input_snapshot_schema_version <> 1
     OR input_renderer_version <> 1
     OR coalesce(input_snapshot_sha256, '') !~ '^[0-9a-f]{64}$'
     OR octet_length(coalesce(input_snapshot_payload, '')) NOT BETWEEN 2 AND 1048576
     OR encode(sha256(convert_to(input_snapshot_payload, 'UTF8')), 'hex')
          IS DISTINCT FROM input_snapshot_sha256 THEN
    RETURN FALSE;
  END IF;

  BEGIN
    parsed_payload := input_snapshot_payload::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  IF pg_catalog.jsonb_typeof(parsed_payload) IS DISTINCT FROM 'object'
     OR NOT (parsed_payload ?& ARRAY[
       'schemaVersion', 'rendererVersion', 'companyId', 'pieceId', 'reason',
       'metadataCreatedAt', 'artifacts', 'payload'
     ]::TEXT[])
     OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(parsed_payload)) <> 8
     OR parsed_payload->>'schemaVersion' IS DISTINCT FROM '1'
     OR parsed_payload->>'rendererVersion' IS DISTINCT FROM '1'
     OR parsed_payload->>'companyId' IS DISTINCT FROM input_company_id
     OR parsed_payload->>'pieceId' IS DISTINCT FROM input_piece_id
     OR parsed_payload->>'reason' IS DISTINCT FROM input_reason
     OR pg_catalog.jsonb_typeof(parsed_payload->'metadataCreatedAt') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(parsed_payload->'artifacts') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(parsed_payload->'payload') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(parsed_payload->'payload'->'data') IS DISTINCT FROM 'object'
     OR parsed_payload->'payload'->'data'->>'documentCreatedAt'
          IS DISTINCT FROM parsed_payload->>'metadataCreatedAt' THEN
    RETURN FALSE;
  END IF;

  expected_artifact_count := CASE input_reason
    WHEN 'invoice-issued' THEN 2
    WHEN 'invoice-issued-pdf-only-b2c' THEN 1
    WHEN 'quote-signed' THEN 1
    ELSE 0
  END;
  IF expected_artifact_count = 0
     OR pg_catalog.jsonb_array_length(parsed_payload->'artifacts') <> expected_artifact_count
     OR (
       SELECT count(DISTINCT value->>'kind')
         FROM pg_catalog.jsonb_array_elements(parsed_payload->'artifacts')
     ) <> expected_artifact_count
     OR (
       SELECT count(DISTINCT value->>'documentId')
         FROM pg_catalog.jsonb_array_elements(parsed_payload->'artifacts')
     ) <> expected_artifact_count
     OR (
       SELECT count(DISTINCT value->>'versionId')
         FROM pg_catalog.jsonb_array_elements(parsed_payload->'artifacts')
     ) <> expected_artifact_count THEN
    RETURN FALSE;
  END IF;

  IF input_reason = 'quote-signed' THEN
    IF NOT (parsed_payload->'payload' ?& ARRAY['kind', 'data']::TEXT[])
       OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(parsed_payload->'payload')) <> 2
       OR parsed_payload->'payload'->>'kind' IS DISTINCT FROM 'quote'
       OR (parsed_payload->'artifacts'->0->>'kind') IS DISTINCT FROM 'signed_quote' THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF NOT (parsed_payload->'payload' ?& ARRAY['kind', 'data', 'facturXXml']::TEXT[])
       OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(parsed_payload->'payload')) <> 3
       OR parsed_payload->'payload'->>'kind' IS DISTINCT FROM 'invoice'
       OR (SELECT count(*)
             FROM pg_catalog.jsonb_array_elements(parsed_payload->'artifacts') AS item(value)
            WHERE item.value->>'kind' = 'invoice_pdf') <> 1
       OR (
         input_reason = 'invoice-issued'
         AND (
           pg_catalog.jsonb_typeof(parsed_payload->'payload'->'facturXXml') IS DISTINCT FROM 'string'
           OR coalesce(parsed_payload->'payload'->>'facturXXml', '') = ''
           OR (SELECT count(*)
                 FROM pg_catalog.jsonb_array_elements(parsed_payload->'artifacts') AS item(value)
                WHERE item.value->>'kind' = 'facturx_xml') <> 1
         )
       )
       OR (
         input_reason = 'invoice-issued-pdf-only-b2c'
         AND parsed_payload->'payload'->'facturXXml' IS DISTINCT FROM 'null'::jsonb
       ) THEN
      RETURN FALSE;
    END IF;
  END IF;

  FOR artifact IN
    SELECT value FROM pg_catalog.jsonb_array_elements(parsed_payload->'artifacts')
  LOOP
    IF pg_catalog.jsonb_typeof(artifact) IS DISTINCT FROM 'object'
       OR NOT (artifact ?& ARRAY[
         'kind', 'expectedContentProfile', 'documentId', 'versionId', 'filename', 'mimeType',
         'linkedEntityType', 'documentDate', 'issuedAt'
       ]::TEXT[])
       OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(artifact)) <> 9
       OR coalesce(artifact->>'kind', '') NOT IN (
         -- DOCUMENT_ARCHIVE_KIND_ENQUEUE_START
         'invoice_pdf',
         'facturx_xml',
         'signed_quote'
         -- DOCUMENT_ARCHIVE_KIND_ENQUEUE_END
       )
       OR coalesce(artifact->>'expectedContentProfile', '') NOT IN (
         -- DOCUMENT_ARCHIVE_PROFILE_ENQUEUE_START
         'plain_pdf',
         'facturx_pdfa3',
         'facturx_xml'
         -- DOCUMENT_ARCHIVE_PROFILE_ENQUEUE_END
       )
       OR btrim(coalesce(artifact->>'documentId', '')) = ''
       OR length(artifact->>'documentId') > 200
       OR btrim(coalesce(artifact->>'versionId', '')) = ''
       OR length(artifact->>'versionId') > 200
       OR btrim(coalesce(artifact->>'filename', '')) = ''
       OR length(artifact->>'filename') > 255
       OR coalesce(artifact->>'mimeType', '') NOT IN ('application/pdf', 'application/xml')
       OR coalesce(artifact->>'linkedEntityType', '') NOT IN ('invoice', 'quote')
       OR coalesce(pg_catalog.jsonb_typeof(artifact->'documentDate'), '') NOT IN ('string', 'null')
       OR coalesce(pg_catalog.jsonb_typeof(artifact->'issuedAt'), '') NOT IN ('string', 'null')
       OR (
         artifact->>'kind' = 'facturx_xml'
         AND (
           artifact->>'expectedContentProfile' <> 'facturx_xml'
           OR artifact->>'mimeType' <> 'application/xml'
           OR artifact->>'linkedEntityType' <> 'invoice'
         )
       )
       OR (
         artifact->>'kind' = 'signed_quote'
         AND (
           artifact->>'expectedContentProfile' <> 'plain_pdf'
           OR artifact->>'mimeType' <> 'application/pdf'
           OR artifact->>'linkedEntityType' <> 'quote'
           OR input_reason <> 'quote-signed'
         )
       )
       OR (
         artifact->>'kind' = 'invoice_pdf'
         AND (
           artifact->>'mimeType' <> 'application/pdf'
           OR artifact->>'linkedEntityType' <> 'invoice'
           OR artifact->>'expectedContentProfile' <> CASE input_reason
             WHEN 'invoice-issued' THEN 'facturx_pdfa3'
             ELSE 'plain_pdf'
           END
         )
       ) THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  -- Toute ligne préexistante sans snapshot est legacy : on ne la complète jamais avec des
  -- données relues après l'événement. Pour les factures, les deux motifs partagent le même scope.
  SELECT job.id, job.reason, snapshot."payloadSha256", snapshot.payload,
         snapshot."schemaVersion", snapshot."rendererVersion"
    INTO existing_job
    FROM public.document_archive_jobs AS job
    LEFT JOIN public.document_archive_render_snapshots AS snapshot ON snapshot."jobId" = job.id
   WHERE job."companyId" = input_company_id
     AND job."invoiceId" = input_piece_id
     AND (
       job.reason = input_reason
       OR (
         input_reason IN (
           -- DOCUMENT_ARCHIVE_INVOICE_REASON_INPUT_START
           'invoice-issued',
           'invoice-issued-pdf-only-b2c'
           -- DOCUMENT_ARCHIVE_INVOICE_REASON_INPUT_END
         )
         AND job.reason IN (
           -- DOCUMENT_ARCHIVE_INVOICE_REASON_JOB_START
           'invoice-issued',
           'invoice-issued-pdf-only-b2c'
           -- DOCUMENT_ARCHIVE_INVOICE_REASON_JOB_END
         )
       )
     )
   FOR UPDATE OF job;

  IF FOUND THEN
    RETURN existing_job.reason = input_reason
      AND existing_job."schemaVersion" = input_snapshot_schema_version
      AND existing_job."rendererVersion" = input_renderer_version
      AND existing_job."payloadSha256" = input_snapshot_sha256
      AND existing_job.payload = input_snapshot_payload;
  END IF;

  accepted := public.document_archive_job_enqueue_v2(
    input_id, input_company_id, input_piece_id, input_reason
  );
  IF NOT coalesce(accepted, false) THEN RETURN FALSE; END IF;

  SELECT job.id
    INTO persisted_job_id
    FROM public.document_archive_jobs AS job
   WHERE job."companyId" = input_company_id
     AND job."invoiceId" = input_piece_id
     AND job.reason = input_reason
   FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  INSERT INTO public.document_archive_render_snapshots (
    "jobId", "companyId", "pieceId", reason, "schemaVersion", "rendererVersion",
    payload, "payloadSha256", "renderAt"
  ) VALUES (
    persisted_job_id, input_company_id, input_piece_id, input_reason,
    input_snapshot_schema_version, input_renderer_version,
    input_snapshot_payload, input_snapshot_sha256,
    (parsed_payload->>'metadataCreatedAt')::timestamptz
  )
  ON CONFLICT ("jobId") DO NOTHING;
  GET DIAGNOSTICS inserted_rows = ROW_COUNT;

  IF inserted_rows = 1 THEN
    IF public.document_archive_protocol_v2_is_active() THEN
      -- Les colonnes timestamp(3) peuvent arrondir statement_timestamp() vers le milliseconde
      -- suivant. Sans cette borne, un LIST exécuté juste après COMMIT peut momentanément ne pas
      -- voir le nouvel ordre. Cette réarme est strictement post-cutover : pendant la phase V1,
      -- le trigger historique doit conserver son sentinel 9999 et aucun writer N ne doit le
      -- contourner en ajoutant un snapshot.
      UPDATE public.document_archive_jobs AS job
         SET "nextAttemptAt" = least(
               job."nextAttemptAt",
               statement_timestamp() - INTERVAL '1 millisecond'
             ),
             "updatedAt" = statement_timestamp()
       WHERE job.id = persisted_job_id
         AND job."companyId" = input_company_id;
      IF NOT FOUND THEN RETURN FALSE; END IF;
    END IF;
    RETURN TRUE;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.document_archive_render_snapshots AS snapshot
     WHERE snapshot."jobId" = persisted_job_id
       AND snapshot."companyId" = input_company_id
       AND snapshot."schemaVersion" = input_snapshot_schema_version
       AND snapshot."rendererVersion" = input_renderer_version
       AND snapshot."payloadSha256" = input_snapshot_sha256
       AND snapshot.payload = input_snapshot_payload
  );
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN FALSE;
END;
$$;

CREATE FUNCTION public.document_archive_artifact_intents_prepare_v1(
  input_job_id TEXT,
  input_company_id TEXT,
  input_lease_token TEXT,
  input_snapshot_sha256 TEXT,
  input_intents JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  job_reason TEXT;
  snapshot_payload JSONB;
  expected_count INTEGER;
  existing_count INTEGER;
  item JSONB;
  plan JSONB;
  expected_key TEXT;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '')
       IS DISTINCT FROM input_company_id
     OR btrim(coalesce(input_lease_token, '')) = ''
     OR coalesce(input_snapshot_sha256, '') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(input_intents) IS DISTINCT FROM 'array' THEN
    RETURN FALSE;
  END IF;

  SELECT job.reason, snapshot.payload::jsonb
    INTO job_reason, snapshot_payload
    FROM public.document_archive_jobs AS job
    JOIN public.document_archive_render_snapshots AS snapshot ON snapshot."jobId" = job.id
   WHERE job.id = input_job_id
     AND job."companyId" = input_company_id
     AND job."leaseToken" = input_lease_token
     AND job."nextAttemptAt" > statement_timestamp()
     AND job.status IN (
       'pending'::public."DocumentArchiveJobStatus",
       'failed'::public."DocumentArchiveJobStatus"
     )
     AND snapshot."companyId" = input_company_id
     AND snapshot."payloadSha256" = input_snapshot_sha256
   FOR UPDATE OF job;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  expected_count := CASE job_reason WHEN 'invoice-issued' THEN 2 ELSE 1 END;
  IF pg_catalog.jsonb_array_length(input_intents) <> expected_count
     OR pg_catalog.jsonb_array_length(snapshot_payload->'artifacts') <> expected_count
     OR (SELECT count(DISTINCT value->>'kind') FROM pg_catalog.jsonb_array_elements(input_intents))
          <> expected_count
     OR (SELECT count(DISTINCT value->>'documentId') FROM pg_catalog.jsonb_array_elements(input_intents))
          <> expected_count
     OR (SELECT count(DISTINCT value->>'versionId') FROM pg_catalog.jsonb_array_elements(input_intents))
          <> expected_count
     OR (SELECT count(DISTINCT value->>'storageKey') FROM pg_catalog.jsonb_array_elements(input_intents))
          <> expected_count THEN
    RETURN FALSE;
  END IF;

  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(input_intents) LOOP
    IF pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR NOT (item ?& ARRAY[
         'kind', 'contentProfile', 'documentId', 'versionId', 'version', 'filename',
         'storageKey', 'mimeType', 'byteSize', 'sha256'
       ]::TEXT[])
       OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(item)) <> 10
       OR coalesce(item->>'kind', '') NOT IN (
         -- DOCUMENT_ARCHIVE_KIND_INTENT_START
         'invoice_pdf',
         'facturx_xml',
         'signed_quote'
         -- DOCUMENT_ARCHIVE_KIND_INTENT_END
       )
       OR coalesce(item->>'contentProfile', '') NOT IN (
         -- DOCUMENT_ARCHIVE_PROFILE_INTENT_START
         'plain_pdf',
         'facturx_pdfa3',
         'facturx_xml'
         -- DOCUMENT_ARCHIVE_PROFILE_INTENT_END
       )
       OR item->>'version' IS DISTINCT FROM '1'
       OR coalesce(item->>'documentId', '') = ''
       OR coalesce(item->>'versionId', '') = ''
       OR coalesce(item->>'filename', '') = ''
       OR coalesce(item->>'mimeType', '') NOT IN ('application/pdf', 'application/xml')
       OR coalesce(item->>'sha256', '') !~ '^[0-9a-f]{64}$'
       OR coalesce(item->>'byteSize', '') !~ '^[1-9][0-9]*$'
       OR (item->>'byteSize')::numeric > 2147483647 THEN
      RETURN FALSE;
    END IF;

    SELECT value INTO plan
      FROM pg_catalog.jsonb_array_elements(snapshot_payload->'artifacts')
     WHERE value->>'kind' = item->>'kind';
    IF NOT FOUND
       OR plan->>'documentId' IS DISTINCT FROM item->>'documentId'
       OR plan->>'versionId' IS DISTINCT FROM item->>'versionId'
       OR plan->>'filename' IS DISTINCT FROM item->>'filename'
       OR plan->>'mimeType' IS DISTINCT FROM item->>'mimeType'
       OR plan->>'expectedContentProfile' IS DISTINCT FROM item->>'contentProfile' THEN
      RETURN FALSE;
    END IF;

    expected_key := pg_catalog.format(
      'companies/%s/documents/%s/v1/%s.%s',
      input_company_id,
      item->>'documentId',
      item->>'sha256',
      CASE item->>'mimeType' WHEN 'application/pdf' THEN 'pdf' ELSE 'xml' END
    );
    IF item->>'storageKey' IS DISTINCT FROM expected_key THEN RETURN FALSE; END IF;
  END LOOP;

  SELECT count(*) INTO existing_count
    FROM public.document_archive_artifact_intents AS intent
   WHERE intent."jobId" = input_job_id;
  IF existing_count > 0 THEN
    IF existing_count <> expected_count THEN RETURN FALSE; END IF;
    RETURN NOT EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements(input_intents) AS requested(value)
        LEFT JOIN public.document_archive_artifact_intents AS intent
          ON intent."jobId" = input_job_id
         AND intent.kind = requested.value->>'kind'
       WHERE intent."jobId" IS NULL
          OR intent."companyId" IS DISTINCT FROM input_company_id
          OR intent."snapshotSha256" IS DISTINCT FROM input_snapshot_sha256
          OR intent."contentProfile" IS DISTINCT FROM requested.value->>'contentProfile'
          OR intent."documentId" IS DISTINCT FROM requested.value->>'documentId'
          OR intent."versionId" IS DISTINCT FROM requested.value->>'versionId'
          OR intent."versionNumber" IS DISTINCT FROM (requested.value->>'version')::smallint
          OR intent.filename IS DISTINCT FROM requested.value->>'filename'
          OR intent."storageKey" IS DISTINCT FROM requested.value->>'storageKey'
          OR intent."mimeType" IS DISTINCT FROM requested.value->>'mimeType'
          OR intent."byteSize" IS DISTINCT FROM (requested.value->>'byteSize')::integer
          OR intent.sha256 IS DISTINCT FROM requested.value->>'sha256'
    );
  END IF;

  INSERT INTO public.document_archive_artifact_intents (
    "jobId", "companyId", "snapshotSha256", kind, "contentProfile", "documentId",
    "versionId", "versionNumber", filename, "storageKey", "mimeType", "byteSize", sha256
  )
  SELECT input_job_id, input_company_id, input_snapshot_sha256,
         value->>'kind', value->>'contentProfile', value->>'documentId', value->>'versionId',
         (value->>'version')::smallint, value->>'filename', value->>'storageKey',
         value->>'mimeType', (value->>'byteSize')::integer, value->>'sha256'
    FROM pg_catalog.jsonb_array_elements(input_intents);
  RETURN TRUE;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR numeric_value_out_of_range THEN
    RETURN FALSE;
END;
$$;

CREATE FUNCTION public.document_archive_artifact_intents_list_v1(
  input_job_id TEXT,
  input_company_id TEXT
)
RETURNS TABLE(
  "jobId" TEXT,
  "companyId" TEXT,
  "snapshotSha256" TEXT,
  kind TEXT,
  "contentProfile" TEXT,
  "documentId" TEXT,
  "versionId" TEXT,
  "versionNumber" SMALLINT,
  filename TEXT,
  "storageKey" TEXT,
  "mimeType" TEXT,
  "byteSize" INTEGER,
  sha256 TEXT,
  "preparedAt" TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT intent."jobId", intent."companyId", intent."snapshotSha256"::text, intent.kind,
         intent."contentProfile", intent."documentId", intent."versionId",
         intent."versionNumber", intent.filename, intent."storageKey", intent."mimeType",
         intent."byteSize", intent.sha256::text, intent."preparedAt"
    FROM public.document_archive_artifact_intents AS intent
   WHERE nullif(current_setting('app.current_company_id', true), '') = input_company_id
     AND intent."jobId" = input_job_id
     AND intent."companyId" = input_company_id
   ORDER BY intent.kind ASC
$$;

CREATE FUNCTION public.document_archive_job_complete_v3(
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
  intent_count INTEGER;
BEGIN
  IF nullif(current_setting('app.current_company_id', true), '')
       IS DISTINCT FROM input_company_id
     OR pg_catalog.jsonb_typeof(input_proof) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(input_proof->'artifacts') IS DISTINCT FROM 'array' THEN
    RETURN FALSE;
  END IF;
  SELECT count(*) INTO intent_count
    FROM public.document_archive_artifact_intents AS intent
   WHERE intent."jobId" = input_id AND intent."companyId" = input_company_id;
  IF intent_count = 0
     OR pg_catalog.jsonb_array_length(input_proof->'artifacts') <> intent_count
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(input_proof->'artifacts') AS artifact(value)
         LEFT JOIN public.document_archive_artifact_intents AS intent
           ON intent."jobId" = input_id
          AND intent."companyId" = input_company_id
          AND intent.kind = artifact.value->>'kind'
         LEFT JOIN public.documents AS document
           ON document.id = intent."documentId"
          AND document."companyId" = intent."companyId"
        WHERE intent."jobId" IS NULL
           OR document.id IS NULL
           OR document.filename IS DISTINCT FROM intent.filename
           OR intent."contentProfile" IS DISTINCT FROM artifact.value->>'contentProfile'
           OR intent."documentId" IS DISTINCT FROM artifact.value->>'documentId'
           OR intent."versionId" IS DISTINCT FROM artifact.value->>'versionId'
           OR intent."versionNumber"::text IS DISTINCT FROM artifact.value->>'version'
           OR intent."storageKey" IS DISTINCT FROM artifact.value->>'storageKey'
           OR intent."mimeType" IS DISTINCT FROM artifact.value->>'mimeType'
           OR intent."byteSize"::text IS DISTINCT FROM artifact.value->>'byteSize'
           OR intent.sha256 IS DISTINCT FROM artifact.value->>'sha256'
     ) THEN
    RETURN FALSE;
  END IF;
  RETURN public.document_archive_job_complete_v2(
    input_id, input_company_id, input_lease_token, input_proof, expected_proof_sha256
  );
END;
$$;

-- Ferme la fenêtre Storage entre intention SQL et matérialisation du Document.
CREATE OR REPLACE FUNCTION public.prevent_generated_legal_storage_object_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  old_key TEXT := OLD.name;
  new_key TEXT := CASE WHEN TG_OP = 'UPDATE' THEN NEW.name ELSE NULL END;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.documents AS document
     WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
       AND document.kind IN (
         'invoice_pdf'::public."StoredDocumentKind",
         'facturx_xml'::public."StoredDocumentKind",
         'signed_quote'::public."StoredDocumentKind"
       )
       AND document."storageKey" IN (old_key, new_key)
  ) OR EXISTS (
    SELECT 1
      FROM public.document_archive_artifact_intents AS intent
     WHERE intent."storageKey" IN (old_key, new_key)
  ) THEN
    RAISE EXCEPTION 'generated legal storage objects are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_legal_storage_object_immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- RLS/ACL fermés dès l'expand. Le runtime écrit uniquement via les capacités SECURITY DEFINER.
ALTER TABLE public.document_archive_render_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_render_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_artifact_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_artifact_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_snapshot_protocol_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_snapshot_protocol_state FORCE ROW LEVEL SECURITY;

CREATE POLICY document_archive_render_snapshots_tenant_select
  ON public.document_archive_render_snapshots FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));

REVOKE ALL ON TABLE
  public.document_archive_render_snapshots,
  public.document_archive_artifact_intents,
  public.document_archive_snapshot_protocol_state
FROM PUBLIC;

REVOKE ALL ON FUNCTION
  public.enforce_document_archive_snapshot_protocol_monotonicity(),
  public.prevent_document_archive_snapshot_mutation(),
  public.prevent_document_archive_artifact_intent_mutation(),
  public.guard_document_archive_job_snapshot_required_v1(),
  public.document_archive_job_enqueue_v3(TEXT, TEXT, TEXT, TEXT, SMALLINT, SMALLINT, TEXT, TEXT),
  public.document_archive_artifact_intents_prepare_v1(TEXT, TEXT, TEXT, TEXT, JSONB),
  public.document_archive_artifact_intents_list_v1(TEXT, TEXT),
  public.document_archive_job_complete_v3(TEXT, TEXT, TEXT, JSONB, TEXT),
  public.prevent_generated_legal_storage_object_mutation()
FROM PUBLIC;

DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON TABLE public.document_archive_render_snapshots, '
        'public.document_archive_artifact_intents, '
        'public.document_archive_snapshot_protocol_state FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION '
        'public.enforce_document_archive_snapshot_protocol_monotonicity(), '
        'public.prevent_document_archive_snapshot_mutation(), '
        'public.prevent_document_archive_artifact_intent_mutation(), '
        'public.guard_document_archive_job_snapshot_required_v1(), '
        'public.document_archive_job_enqueue_v3(TEXT,TEXT,TEXT,TEXT,SMALLINT,SMALLINT,TEXT,TEXT), '
        'public.document_archive_artifact_intents_prepare_v1(TEXT,TEXT,TEXT,TEXT,JSONB), '
        'public.document_archive_artifact_intents_list_v1(TEXT,TEXT), '
        'public.document_archive_job_complete_v3(TEXT,TEXT,TEXT,JSONB,TEXT), '
        'public.prevent_generated_legal_storage_object_mutation() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE public.document_archive_render_snapshots IS
  'Append-only canonical renderer inputs captured atomically with legal issue/sign.';
COMMENT ON TABLE public.document_archive_artifact_intents IS
  'Append-only storage intentions persisted under lease before any legal artifact upload.';

RESET ROLE;

DO $document_archive_snapshot_expand_owner_restore$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
  owner_had_schema_create BOOLEAN := coalesce(
    current_setting('bob.document_archive_snapshot_owner_had_schema_create', true),
    ''
  ) = 'true';
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'document_archive_jobs'
     AND relation.relkind IN ('r', 'p');

  IF NOT owner_had_schema_create THEN
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', schema_owner_name);
    IF pg_catalog.has_schema_privilege(schema_owner_oid, 'public', 'CREATE')
       OR NOT pg_catalog.has_schema_privilege(schema_owner_oid, 'public', 'USAGE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_ARCHIVE_SNAPSHOT_SCHEMA_ACL_RESTORE_FAILED';
    END IF;
  END IF;
END;
$document_archive_snapshot_expand_owner_restore$;

COMMIT;
