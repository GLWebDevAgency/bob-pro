-- Quarantaine Archive FLY — journal privé append-only et fence exact-key.
-- Additif et inerte pour les writers N-1 tant qu'aucun plan n'est scellé.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- Supabase : les objets privés Archive partagent l'owner NOLOGIN/BYPASSRLS canonique.
DO $document_archive_quarantine_owner$
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

  owner_had_schema_create := pg_catalog.has_schema_privilege(schema_owner_oid, 'public', 'CREATE');
  PERFORM pg_catalog.set_config(
    'bob.document_archive_quarantine_owner_had_schema_create',
    CASE WHEN owner_had_schema_create THEN 'true' ELSE 'false' END,
    true
  );
  IF NOT owner_had_schema_create THEN
    EXECUTE pg_catalog.format('GRANT CREATE ON SCHEMA public TO %I', schema_owner_name);
    IF NOT pg_catalog.has_schema_privilege(schema_owner_oid, 'public', 'CREATE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_ARCHIVE_QUARANTINE_SCHEMA_CREATE_GRANT_FAILED';
    END IF;
  END IF;
  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_ARCHIVE_QUARANTINE_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;
  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_ARCHIVE_QUARANTINE_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$document_archive_quarantine_owner$;

-- Un plan doit pointer vers UNE preuve d'audit unique. Deux FK indépendantes permettraient
-- autrement de combiner le deployment d'une preuve avec les digests d'une autre.
ALTER TABLE public.document_archive_audit_evidence
  ADD CONSTRAINT document_archive_audit_evidence_quarantine_exact_key
  UNIQUE (
    "deploymentId", "releaseSha", "inventoryDigest", "reportSha256",
    "storageBucket", "databaseIdentity"
  );

CREATE TABLE public.document_archive_quarantine_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "companyIdSha256" CHAR(64) NOT NULL,
  "sourceBucket" TEXT NOT NULL,
  "destinationBucket" TEXT NOT NULL,
  "manifestDigest" CHAR(64) NOT NULL,
  "databaseIdentity" UUID NOT NULL,
  "databaseSnapshotDigest" CHAR(64) NOT NULL,
  "auditDeploymentId" UUID NOT NULL,
  "releaseSha" CHAR(40) NOT NULL,
  "auditInventoryDigest" CHAR(64) NOT NULL,
  "auditReportSha256" CHAR(64) NOT NULL,
  "entryCount" SMALLINT NOT NULL,
  "copyReceiptKey" TEXT NOT NULL,
  "deletedReceiptKey" TEXT NOT NULL,
  "finalReceiptKey" TEXT NOT NULL,
  "privateManifest" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT document_archive_quarantine_operation_manifest_key UNIQUE ("manifestDigest"),
  CONSTRAINT document_archive_quarantine_operation_audit_key UNIQUE ("auditDeploymentId"),
  CONSTRAINT document_archive_quarantine_operation_identity_key UNIQUE (
    id, "companyId", "sourceBucket", "destinationBucket", "manifestDigest"
  ),
  CONSTRAINT document_archive_quarantine_operation_environment CHECK (environment = 'staging'),
  CONSTRAINT document_archive_quarantine_operation_company CHECK (
    length("companyId") BETWEEN 1 AND 256 AND "companyId" !~ '[/\\]'
  ),
  CONSTRAINT document_archive_quarantine_operation_release_sha CHECK (
    "releaseSha" ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT document_archive_quarantine_operation_digests CHECK (
    "manifestDigest" ~ '^[0-9a-f]{64}$'
    AND "companyIdSha256" ~ '^[0-9a-f]{64}$'
    AND "databaseSnapshotDigest" ~ '^[0-9a-f]{64}$'
    AND "auditInventoryDigest" ~ '^[0-9a-f]{64}$'
    AND "auditReportSha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT document_archive_quarantine_operation_buckets CHECK (
    "sourceBucket" ~ '^[a-z0-9][a-z0-9._-]{0,62}$'
    AND "destinationBucket" ~ '^[a-z0-9][a-z0-9._-]{0,62}$'
    AND "sourceBucket" <> "destinationBucket"
  ),
  CONSTRAINT document_archive_quarantine_operation_entry_count CHECK ("entryCount" = 5),
  CONSTRAINT document_archive_quarantine_operation_receipts CHECK (
    "copyReceiptKey" = 'receipts/' || btrim("manifestDigest"::text) || '/copied-verified.json'
    AND "deletedReceiptKey" =
      'receipts/' || btrim("manifestDigest"::text) || '/deleted-verified.json'
    AND "finalReceiptKey" = 'receipts/' || btrim("manifestDigest"::text) || '/completed.json'
  ),
  CONSTRAINT document_archive_quarantine_operation_manifest_shape CHECK (
    pg_catalog.jsonb_typeof("privateManifest") = 'object'
    AND "privateManifest"->>'schemaVersion' = '2'
    AND "privateManifest"->>'environment' = environment
    AND "privateManifest"->>'releaseSha' = btrim("releaseSha"::text)
    AND "privateManifest"->>'databaseSnapshotDigest' =
      btrim("databaseSnapshotDigest"::text)
    AND "privateManifest"->>'auditDeploymentId' = "auditDeploymentId"::text
    AND "privateManifest"->>'auditReportSha256' = btrim("auditReportSha256"::text)
    AND "privateManifest"->>'sourceAuditInventoryDigest' =
      btrim("auditInventoryDigest"::text)
    AND "privateManifest"->>'sourceBucket' = "sourceBucket"
    AND "privateManifest"->>'destinationBucket' = "destinationBucket"
    AND "privateManifest"->>'companyIdSha256' = btrim("companyIdSha256"::text)
    AND "privateManifest"->>'confirmationDigest' = btrim("manifestDigest"::text)
    AND pg_catalog.jsonb_typeof("privateManifest"->'entries') = 'array'
    AND pg_catalog.jsonb_array_length("privateManifest"->'entries') = "entryCount"
  ),
  CONSTRAINT document_archive_quarantine_operation_database_fkey
    FOREIGN KEY ("databaseIdentity")
    REFERENCES public.document_archive_protocol_state("databaseIdentity")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT document_archive_quarantine_operation_audit_exact_fkey
    FOREIGN KEY (
      "auditDeploymentId", "releaseSha", "auditInventoryDigest", "auditReportSha256",
      "sourceBucket", "databaseIdentity"
    )
    REFERENCES public.document_archive_audit_evidence(
      "deploymentId", "releaseSha", "inventoryDigest", "reportSha256",
      "storageBucket", "databaseIdentity"
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.document_archive_quarantine_entries (
  "operationId" UUID NOT NULL,
  ordinal SMALLINT NOT NULL,
  "companyId" TEXT NOT NULL,
  "sourceBucket" TEXT NOT NULL,
  "destinationBucket" TEXT NOT NULL,
  "manifestDigest" CHAR(64) NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "sourceKeySha256" CHAR(64) NOT NULL,
  "destinationKey" TEXT NOT NULL,
  "sourceObjectId" UUID NOT NULL,
  "sourceObjectVersion" TEXT,
  "sourceCreatedAt" TIMESTAMPTZ NOT NULL,
  "sourceUpdatedAt" TIMESTAMPTZ NOT NULL,
  "sourceMetadata" JSONB NOT NULL,
  "sourceUserMetadata" JSONB NOT NULL,
  "sourceStorageMetadataDigest" CHAR(64) NOT NULL,
  "byteSha256" CHAR(64) NOT NULL,
  "byteSize" BIGINT NOT NULL,
  "contentType" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT document_archive_quarantine_entries_pkey PRIMARY KEY ("operationId", ordinal),
  CONSTRAINT document_archive_quarantine_entry_source_key UNIQUE ("sourceBucket", "sourceKey"),
  CONSTRAINT document_archive_quarantine_entry_source_hash UNIQUE ("sourceKeySha256"),
  CONSTRAINT document_archive_quarantine_entry_destination_key UNIQUE (
    "destinationBucket", "destinationKey"
  ),
  CONSTRAINT document_archive_quarantine_entry_operation_fkey
    FOREIGN KEY (
      "operationId", "companyId", "sourceBucket", "destinationBucket", "manifestDigest"
    ) REFERENCES public.document_archive_quarantine_operations(
      id, "companyId", "sourceBucket", "destinationBucket", "manifestDigest"
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT document_archive_quarantine_entry_ordinal CHECK (ordinal BETWEEN 1 AND 5),
  CONSTRAINT document_archive_quarantine_entry_source_path CHECK (
    starts_with("sourceKey", 'companies/' || "companyId" || '/documents/')
    AND "sourceKey" ~ '^companies/[^/]+/documents/[^/]+/v1/[0-9a-f]{64}\.pdf$'
    AND right("sourceKey", 68) = btrim("byteSha256"::text) || '.pdf'
    AND "sourceKey" !~ '(^/|//|(^|/)\.\.?(/|$))'
  ),
  CONSTRAINT document_archive_quarantine_entry_destination_path CHECK (
    "destinationKey" ~ '^v2/[0-9a-f]{64}/[0-9a-f]{64}/[0-9a-f]{64}\.pdf$'
    AND right("destinationKey", 68) = btrim("byteSha256"::text) || '.pdf'
    AND "destinationKey" !~ '(^/|//|(^|/)\.\.?(/|$))'
  ),
  CONSTRAINT document_archive_quarantine_entry_digests CHECK (
    "sourceKeySha256" ~ '^[0-9a-f]{64}$'
    AND "sourceStorageMetadataDigest" ~ '^[0-9a-f]{64}$'
    AND "byteSha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT document_archive_quarantine_entry_bytes CHECK ("byteSize" > 0),
  CONSTRAINT document_archive_quarantine_entry_mime CHECK ("contentType" = 'application/pdf'),
  CONSTRAINT document_archive_quarantine_entry_version CHECK (
    "sourceObjectVersion" IS NULL OR length("sourceObjectVersion") BETWEEN 1 AND 256
  )
);

CREATE TABLE public.document_archive_quarantine_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "operationId" UUID NOT NULL,
  kind TEXT NOT NULL,
  ordinal SMALLINT NOT NULL,
  "objectId" UUID,
  "objectVersion" TEXT,
  "objectCreatedAt" TIMESTAMPTZ,
  "objectUpdatedAt" TIMESTAMPTZ,
  "objectMetadata" JSONB,
  "objectUserMetadata" JSONB,
  "byteSha256" CHAR(64),
  "byteSize" BIGINT,
  "contentType" TEXT,
  evidence JSONB NOT NULL,
  "evidenceSha256" CHAR(64) NOT NULL,
  "workflowIdentity" JSONB,
  "finalAuditDeploymentId" UUID,
  "finalAuditReleaseSha" CHAR(40),
  "finalAuditInventoryDigest" CHAR(64),
  "finalAuditReportSha256" CHAR(64),
  "finalAuditStorageBucket" TEXT,
  "finalAuditDatabaseIdentity" UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT document_archive_quarantine_event_operation_fkey
    FOREIGN KEY ("operationId")
    REFERENCES public.document_archive_quarantine_operations(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT document_archive_quarantine_event_key UNIQUE ("operationId", kind, ordinal),
  CONSTRAINT document_archive_quarantine_event_kind CHECK (
    kind IN (
      'plan_authorized', 'authorized', 'destination_verified', 'copied_verified', 'source_deleted',
      'deleted_verified', 'final_audit_verified', 'completed'
    )
  ),
  CONSTRAINT document_archive_quarantine_event_ordinal CHECK (
    (kind IN (
      'plan_authorized', 'authorized', 'copied_verified', 'deleted_verified',
      'final_audit_verified', 'completed'
    ) AND ordinal = 0)
    OR (kind IN ('destination_verified', 'source_deleted') AND ordinal BETWEEN 1 AND 5)
  ),
  CONSTRAINT document_archive_quarantine_event_digest CHECK (
    "evidenceSha256" ~ '^[0-9a-f]{64}$'
    AND btrim("evidenceSha256"::text) =
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(evidence::text, 'UTF8')), 'hex')
  ),
  CONSTRAINT document_archive_quarantine_event_evidence CHECK (
    pg_catalog.jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT document_archive_quarantine_event_shape CHECK (
    (
      kind IN ('plan_authorized', 'authorized')
      AND pg_catalog.jsonb_typeof("workflowIdentity") = 'object'
      AND "objectId" IS NULL
      AND "objectVersion" IS NULL
      AND "objectCreatedAt" IS NULL
      AND "objectUpdatedAt" IS NULL
      AND "objectMetadata" IS NULL
      AND "objectUserMetadata" IS NULL
      AND "byteSha256" IS NULL
      AND "byteSize" IS NULL
      AND "contentType" IS NULL
      AND "finalAuditDeploymentId" IS NULL
      AND "finalAuditReleaseSha" IS NULL
      AND "finalAuditInventoryDigest" IS NULL
      AND "finalAuditReportSha256" IS NULL
      AND "finalAuditStorageBucket" IS NULL
      AND "finalAuditDatabaseIdentity" IS NULL
    ) OR (
      kind = 'final_audit_verified'
      AND "workflowIdentity" IS NULL
      AND "objectId" IS NULL
      AND "objectVersion" IS NULL
      AND "objectCreatedAt" IS NULL
      AND "objectUpdatedAt" IS NULL
      AND "objectMetadata" IS NULL
      AND "objectUserMetadata" IS NULL
      AND "byteSha256" IS NULL
      AND "byteSize" IS NULL
      AND "contentType" IS NULL
      AND "finalAuditDeploymentId" IS NOT NULL
      AND "finalAuditReleaseSha" ~ '^[0-9a-f]{40}$'
      AND "finalAuditInventoryDigest" ~ '^[0-9a-f]{64}$'
      AND "finalAuditReportSha256" ~ '^[0-9a-f]{64}$'
      AND "finalAuditStorageBucket" IS NOT NULL
      AND "finalAuditDatabaseIdentity" IS NOT NULL
    ) OR (
      kind NOT IN ('plan_authorized', 'authorized', 'final_audit_verified')
      AND "workflowIdentity" IS NULL
      AND "objectId" IS NOT NULL
      AND "objectCreatedAt" IS NOT NULL
      AND "objectUpdatedAt" IS NOT NULL
      AND "objectMetadata" IS NOT NULL
      AND "objectUserMetadata" IS NOT NULL
      AND "byteSha256" ~ '^[0-9a-f]{64}$'
      AND "byteSize" > 0
      AND (
        (kind IN ('destination_verified', 'source_deleted') AND "contentType" = 'application/pdf')
        OR (kind IN ('copied_verified', 'deleted_verified', 'completed')
          AND "contentType" = 'application/json')
      )
      AND "finalAuditDeploymentId" IS NULL
      AND "finalAuditReleaseSha" IS NULL
      AND "finalAuditInventoryDigest" IS NULL
      AND "finalAuditReportSha256" IS NULL
      AND "finalAuditStorageBucket" IS NULL
      AND "finalAuditDatabaseIdentity" IS NULL
    )
  ),
  CONSTRAINT document_archive_quarantine_event_final_audit_fkey
    FOREIGN KEY (
      "finalAuditDeploymentId", "finalAuditReleaseSha", "finalAuditInventoryDigest",
      "finalAuditReportSha256", "finalAuditStorageBucket", "finalAuditDatabaseIdentity"
    ) REFERENCES public.document_archive_audit_evidence(
      "deploymentId", "releaseSha", "inventoryDigest", "reportSha256",
      "storageBucket", "databaseIdentity"
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX document_archive_quarantine_events_operation_kind_idx
  ON public.document_archive_quarantine_events("operationId", kind, ordinal);
CREATE INDEX IF NOT EXISTS document_archive_job_artifacts_storage_key_idx
  ON public.document_archive_job_artifacts("storageKey");

CREATE FUNCTION public.prevent_document_archive_quarantine_ledger_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'document archive quarantine ledger is append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'document_archive_quarantine_ledger_immutable';
END;
$$;

CREATE FUNCTION public.guard_document_archive_quarantine_event_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind IN ('plan_authorized', 'authorized') AND NOT EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_operations AS operation
     WHERE operation.id = NEW."operationId"
       AND NEW.evidence->>'manifestDigest' = btrim(operation."manifestDigest"::text)
       AND NEW.evidence->>'authorizationChannel' = 'github-actions:workflow_dispatch'
       AND NEW.evidence->>'tokenSha256' = NEW."workflowIdentity"->>'tokenSha256'
       AND NEW."workflowIdentity"->>'issuer' = 'https://token.actions.githubusercontent.com'
       AND NEW."workflowIdentity"->>'audience' = 'bob-document-archive-quarantine-staging'
       AND NEW."workflowIdentity"->>'repository' = 'GLWebDevAgency/bob-pro'
       AND NEW."workflowIdentity"->>'repositoryId' = '1286748365'
       AND NEW."workflowIdentity"->>'repositoryOwnerId' = '84627817'
       AND NEW."workflowIdentity"->>'subject' =
         'repo:GLWebDevAgency/bob-pro:environment:staging'
       AND NEW."workflowIdentity"->>'ref' = 'refs/heads/main'
       AND NEW."workflowIdentity"->>'sha' = btrim(operation."releaseSha"::text)
       AND NEW."workflowIdentity"->>'environment' = 'staging'
       AND NEW."workflowIdentity"->>'workflowRef' =
         'GLWebDevAgency/bob-pro/.github/workflows/'
         'document-archive-quarantine-staging.yml@refs/heads/main'
       AND NEW."workflowIdentity"->>'workflowSha' = btrim(operation."releaseSha"::text)
       AND NEW."workflowIdentity"->>'eventName' = 'workflow_dispatch'
       AND NEW."workflowIdentity"->>'actorId' = '84627817'
       AND NEW."workflowIdentity"->>'actor' ~
         '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
       AND NEW."workflowIdentity"->>'runId' ~ '^[1-9][0-9]{0,19}$'
       AND (NEW."workflowIdentity"->>'runAttempt')::integer >= 1
       AND NEW."workflowIdentity"->>'tokenSha256' ~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'quarantine authority must be exact and bound to the sealed plan'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_authority_exact';
  END IF;
  IF NEW.kind = 'authorized' AND NOT EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_events AS planned
     WHERE planned."operationId" = NEW."operationId"
       AND planned.kind = 'plan_authorized'
       AND planned.ordinal = 0
       AND planned."workflowIdentity"->>'issuer' = NEW."workflowIdentity"->>'issuer'
       AND planned."workflowIdentity"->>'audience' = NEW."workflowIdentity"->>'audience'
       AND planned."workflowIdentity"->>'repository' = NEW."workflowIdentity"->>'repository'
       AND planned."workflowIdentity"->>'repositoryId' =
         NEW."workflowIdentity"->>'repositoryId'
       AND planned."workflowIdentity"->>'repositoryOwnerId' =
         NEW."workflowIdentity"->>'repositoryOwnerId'
       AND planned."workflowIdentity"->>'subject' = NEW."workflowIdentity"->>'subject'
       AND planned."workflowIdentity"->>'ref' = NEW."workflowIdentity"->>'ref'
       AND planned."workflowIdentity"->>'sha' = NEW."workflowIdentity"->>'sha'
       AND planned."workflowIdentity"->>'environment' = NEW."workflowIdentity"->>'environment'
       AND planned."workflowIdentity"->>'workflowRef' = NEW."workflowIdentity"->>'workflowRef'
       AND planned."workflowIdentity"->>'workflowSha' = NEW."workflowIdentity"->>'workflowSha'
       AND planned."workflowIdentity"->>'eventName' = NEW."workflowIdentity"->>'eventName'
       AND planned."workflowIdentity"->>'actorId' = NEW."workflowIdentity"->>'actorId'
       AND planned."workflowIdentity"->>'tokenSha256' IS DISTINCT FROM
         NEW."workflowIdentity"->>'tokenSha256'
  ) THEN
    RAISE EXCEPTION 'apply authority must match the durable plan and carry a distinct OIDC proof'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_apply_authority_matches_plan';
  END IF;
  IF NEW.kind = 'source_deleted'
     AND current_setting('bob.document_archive_quarantine_source_delete', true)
       IS DISTINCT FROM NEW."operationId"::text || ':' || NEW.ordinal::text THEN
    RAISE EXCEPTION 'source_deleted must be emitted by the Storage DELETE trigger'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_source_delete_origin';
  END IF;
  IF NEW.kind = 'final_audit_verified' AND (
    NOT EXISTS (
      SELECT 1
        FROM public.document_archive_quarantine_events AS deleted
       WHERE deleted."operationId" = NEW."operationId"
         AND deleted.kind = 'deleted_verified'
    ) OR NOT EXISTS (
      SELECT 1
        FROM public.document_archive_quarantine_operations AS operation
        JOIN public.document_archive_audit_evidence AS audit
          ON audit."deploymentId" = NEW."finalAuditDeploymentId"
         AND audit."releaseSha" = NEW."finalAuditReleaseSha"
         AND audit."inventoryDigest" = NEW."finalAuditInventoryDigest"
         AND audit."reportSha256" = NEW."finalAuditReportSha256"
         AND audit."storageBucket" = NEW."finalAuditStorageBucket"
         AND audit."databaseIdentity" = NEW."finalAuditDatabaseIdentity"
        JOIN public.document_archive_quarantine_events AS deleted
          ON deleted."operationId" = operation.id
         AND deleted.kind = 'deleted_verified'
       WHERE operation.id = NEW."operationId"
         AND operation."releaseSha" = audit."releaseSha"
         AND operation."sourceBucket" = audit."storageBucket"
         AND operation."databaseIdentity" = audit."databaseIdentity"
         AND audit."protocolVersion" = 2
         AND audit.mode = 'protocol-v2-verified'
         AND audit."readyForActivation" = true
         AND audit."issueCodes" = ARRAY[]::text[]
         AND (audit.counts->>'storageOrphans')::integer = 0
         AND (audit.counts->>'missingStoredObjects')::integer = 0
         AND (audit.counts->>'p0Issues')::integer = 0
         AND audit."createdAt" >= audit."auditedAt"
         AND audit."auditedAt" >= deleted."createdAt"
    )
  ) THEN
    RAISE EXCEPTION 'final audit evidence must be exact, clean and posterior to deletion'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_final_audit_required';
  END IF;
  IF NEW.kind = 'completed' AND NOT EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_events AS final_audit
     WHERE final_audit."operationId" = NEW."operationId"
       AND final_audit.kind = 'final_audit_verified'
  ) THEN
    RAISE EXCEPTION 'completed requires an exact global final audit'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_completion_audit_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_archive_quarantine_operations_immutable
BEFORE UPDATE OR DELETE ON public.document_archive_quarantine_operations
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_ledger_mutation_v1();
CREATE TRIGGER document_archive_quarantine_entries_immutable
BEFORE UPDATE OR DELETE ON public.document_archive_quarantine_entries
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_ledger_mutation_v1();
CREATE TRIGGER document_archive_quarantine_events_insert_guard
BEFORE INSERT ON public.document_archive_quarantine_events
FOR EACH ROW EXECUTE FUNCTION public.guard_document_archive_quarantine_event_insert_v1();
CREATE TRIGGER document_archive_quarantine_events_immutable
BEFORE UPDATE OR DELETE ON public.document_archive_quarantine_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_ledger_mutation_v1();

-- L'opération et ses cinq entrées se créent dans une même transaction. Ce trigger différé
-- interdit tout plan partiel ou divergent du manifeste privé.
CREATE FUNCTION public.guard_document_archive_quarantine_plan_complete_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  persisted_count INTEGER;
BEGIN
  -- Même un appel SQL direct ne peut ouvrir deux opérations terminales concurrentes.
  -- Le verrou est identique à celui du runtime et sérialise le test d'existence.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bob-document-archive-quarantine', 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_operations AS operation
     WHERE operation.id <> NEW.id
       AND NOT EXISTS (
         SELECT 1
           FROM public.document_archive_quarantine_events AS event
          WHERE event."operationId" = operation.id
            AND event.kind = 'completed'
       )
  ) THEN
    RAISE EXCEPTION 'another document archive quarantine operation remains incomplete'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_single_open_operation';
  END IF;

  SELECT count(*)::integer INTO persisted_count
    FROM public.document_archive_quarantine_entries AS entry
   WHERE entry."operationId" = NEW.id;

  IF persisted_count <> NEW."entryCount"
     OR NOT EXISTS (
       SELECT 1
         FROM public.document_archive_quarantine_events AS event
        WHERE event."operationId" = NEW.id
          AND event.kind = 'plan_authorized'
          AND event.ordinal = 0
          AND pg_catalog.jsonb_typeof(event."workflowIdentity") = 'object'
          AND event."workflowIdentity"->>'sha' = btrim(NEW."releaseSha"::text)
          AND event."workflowIdentity"->>'workflowSha' = btrim(NEW."releaseSha"::text)
          AND event."workflowIdentity"->>'eventName' = 'workflow_dispatch'
          AND event."workflowIdentity"->>'actorId' = '84627817'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(NEW."privateManifest"->'entries')
              WITH ORDINALITY AS planned(value, ordinal)
         LEFT JOIN public.document_archive_quarantine_entries AS entry
           ON entry."operationId" = NEW.id
          AND entry.ordinal = planned.ordinal
        WHERE entry."operationId" IS NULL
           OR entry."companyId" IS DISTINCT FROM NEW."companyId"
           OR entry."sourceBucket" IS DISTINCT FROM NEW."sourceBucket"
           OR entry."destinationBucket" IS DISTINCT FROM NEW."destinationBucket"
           OR btrim(entry."manifestDigest"::text) IS DISTINCT FROM
                btrim(NEW."manifestDigest"::text)
           OR entry."sourceKey" IS DISTINCT FROM planned.value->>'sourceKey'
           OR btrim(entry."sourceKeySha256"::text) IS DISTINCT FROM
                planned.value->>'sourceKeySha256'
           OR entry."destinationKey" IS DISTINCT FROM planned.value->>'destinationKey'
           OR btrim(entry."byteSha256"::text) IS DISTINCT FROM planned.value->>'sha256'
           OR entry."byteSize" IS DISTINCT FROM (planned.value->>'byteSize')::bigint
           OR entry."contentType" IS DISTINCT FROM planned.value->>'contentType'
           OR entry."sourceObjectId" IS DISTINCT FROM
                (planned.value->>'sourceObjectId')::uuid
           OR entry."sourceObjectVersion" IS DISTINCT FROM
                planned.value->>'sourceObjectVersion'
           OR entry."sourceCreatedAt" IS DISTINCT FROM
                (planned.value->>'sourceCreatedAt')::timestamptz
           OR entry."sourceUpdatedAt" IS DISTINCT FROM
                (planned.value->>'sourceUpdatedAt')::timestamptz
           OR entry."sourceMetadata" IS DISTINCT FROM planned.value->'sourceMetadata'
           OR entry."sourceUserMetadata" IS DISTINCT FROM planned.value->'sourceUserMetadata'
           OR btrim(entry."sourceStorageMetadataDigest"::text) IS DISTINCT FROM
                planned.value->>'sourceStorageMetadataDigest'
     ) THEN
    RAISE EXCEPTION 'document archive quarantine plan is incomplete or divergent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_plan_complete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER document_archive_quarantine_plan_complete
AFTER INSERT ON public.document_archive_quarantine_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.guard_document_archive_quarantine_plan_complete_v1();

-- Toute référence SQL ajoutée après le scellement est refusée. Les entrées ne sont jamais retirées,
-- donc la garde reste active après la quarantaine.
CREATE FUNCTION public.prevent_document_archive_quarantine_reference_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_entries AS entry
     WHERE entry."sourceKey" = NEW."storageKey"
  ) THEN
    RAISE EXCEPTION 'quarantined storage source cannot receive a SQL reference'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_reference_fence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_archive_quarantine_documents_reference_fence
BEFORE INSERT OR UPDATE OF "storageKey" ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_reference_v1();
CREATE TRIGGER document_archive_quarantine_versions_reference_fence
BEFORE INSERT OR UPDATE OF "storageKey" ON public.document_versions
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_reference_v1();
CREATE TRIGGER document_archive_quarantine_photos_reference_fence
BEFORE INSERT OR UPDATE OF "storageKey" ON public.chantier_photos
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_reference_v1();
CREATE TRIGGER document_archive_quarantine_intents_reference_fence
BEFORE INSERT OR UPDATE OF "storageKey" ON public.document_archive_artifact_intents
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_reference_v1();
CREATE TRIGGER document_archive_quarantine_job_artifacts_reference_fence
BEFORE INSERT OR UPDATE OF "storageKey" ON public.document_archive_job_artifacts
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_reference_v1();

-- Aucun worker Archive ne peut prendre un nouveau lease entre le snapshot global exact et la
-- preuve finale. Le plan verrouille d'abord la table et exige zéro lease déjà vivant.
CREATE FUNCTION public.prevent_document_archive_worker_during_quarantine_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF NEW."leaseToken" IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken")
     AND EXISTS (
       SELECT 1
         FROM public.document_archive_quarantine_operations AS operation
        WHERE NOT EXISTS (
          SELECT 1
            FROM public.document_archive_quarantine_events AS event
           WHERE event."operationId" = operation.id
             AND event.kind = 'completed'
        )
     ) THEN
    RAISE EXCEPTION 'archive worker leases are closed during exact-key quarantine'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_worker_closed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_archive_quarantine_worker_lease_fence
BEFORE INSERT OR UPDATE OF "leaseToken" ON public.document_archive_jobs
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_worker_during_quarantine_v1();

-- La destination de quarantaine reste privée et immuable durablement. Le bucket source est gelé
-- uniquement jusqu'à l'audit final : aucune bascule public/delete ne peut courir avec les DELETE.
CREATE FUNCTION public.prevent_document_archive_quarantine_bucket_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  old_bucket_id TEXT := OLD.id;
  old_bucket_name TEXT := OLD.name;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_operations AS operation
     WHERE operation."destinationBucket" IN (old_bucket_id, old_bucket_name)
  ) THEN
    RAISE EXCEPTION 'quarantine destination bucket is immutable and private'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_destination_bucket_immutable';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_operations AS operation
     WHERE operation."sourceBucket" IN (old_bucket_id, old_bucket_name)
       AND NOT EXISTS (
         SELECT 1
           FROM public.document_archive_quarantine_events AS event
          WHERE event."operationId" = operation.id
            AND event.kind = 'completed'
       )
  ) THEN
    RAISE EXCEPTION 'archive source bucket is frozen during exact-key quarantine'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_source_bucket_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Conserve d'abord la garde légale historique, puis autorise uniquement le DELETE source exact.
-- Le trigger ne relit jamais Storage : OLD + événements figés suffisent, sans droit vendor caché.
CREATE OR REPLACE FUNCTION public.prevent_generated_legal_storage_object_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  old_bucket TEXT;
  old_key TEXT;
  new_bucket TEXT;
  new_key TEXT;
  old_row JSONB;
  quarantine RECORD;
  deleted_count INTEGER;
  destination_count INTEGER;
  event_evidence JSONB;
  quarantine_fences_valid BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_bucket := OLD.bucket_id;
    old_key := OLD.name;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_bucket := NEW.bucket_id;
    new_key := NEW.name;
  END IF;

  -- Invariant légal existant : UPDATE/DELETE d'un original référencé reste impossible.
  IF TG_OP <> 'INSERT' AND (
    EXISTS (
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
    )
  ) THEN
    RAISE EXCEPTION 'generated legal storage objects are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_legal_storage_object_immutable';
  END IF;

  -- Une source scellée ne peut être créée/recréée ni modifiée, y compris par renommage.
  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_operations AS operation
      JOIN public.document_archive_quarantine_entries AS entry
        ON entry."operationId" = operation.id
     WHERE (operation."sourceBucket", entry."sourceKey") IN (
       (new_bucket, new_key), (old_bucket, old_key)
     )
  ) THEN
    RAISE EXCEPTION 'quarantine source objects cannot be inserted or updated'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_source_immutable';
  END IF;

  -- Après vérification SQL atomique, toute destination et tout reçu deviennent immuables.
  IF EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_operations AS operation
      JOIN public.document_archive_quarantine_entries AS entry
        ON entry."operationId" = operation.id
      JOIN public.document_archive_quarantine_events AS event
        ON event."operationId" = operation.id
       AND event.kind = 'destination_verified'
       AND event.ordinal = entry.ordinal
     WHERE (operation."destinationBucket", entry."destinationKey") IN (
       (new_bucket, new_key), (old_bucket, old_key)
     )
  ) OR EXISTS (
    SELECT 1
      FROM public.document_archive_quarantine_operations AS operation
      JOIN public.document_archive_quarantine_events AS event
        ON event."operationId" = operation.id
       AND (
         (event.kind = 'copied_verified' AND operation."copyReceiptKey" IN (old_key, new_key))
         OR (event.kind = 'deleted_verified'
           AND operation."deletedReceiptKey" IN (old_key, new_key))
         OR (event.kind = 'completed' AND operation."finalReceiptKey" IN (old_key, new_key))
       )
     WHERE operation."destinationBucket" IN (old_bucket, new_bucket)
  ) THEN
    RAISE EXCEPTION 'verified quarantine destination objects are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_destination_immutable';
  END IF;

  IF TG_OP <> 'DELETE' THEN RETURN NEW; END IF;

  SELECT operation.id AS "operationId", operation."sourceBucket",
         operation."destinationBucket", entry.ordinal, entry."sourceKey",
         entry."sourceKeySha256", entry."destinationKey", entry."sourceObjectId",
         entry."sourceObjectVersion", entry."sourceCreatedAt", entry."sourceUpdatedAt",
         entry."sourceMetadata", entry."sourceUserMetadata", entry."byteSha256",
         entry."byteSize", entry."contentType"
    INTO quarantine
    FROM public.document_archive_quarantine_operations AS operation
    JOIN public.document_archive_quarantine_entries AS entry
      ON entry."operationId" = operation.id
   WHERE operation."sourceBucket" = old_bucket
     AND entry."sourceKey" = old_key;
  IF NOT FOUND THEN RETURN OLD; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.document_archive_quarantine_events AS event
     WHERE event."operationId" = quarantine."operationId" AND event.kind = 'authorized'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.document_archive_quarantine_events AS event
     WHERE event."operationId" = quarantine."operationId" AND event.kind = 'copied_verified'
  ) THEN
    RAISE EXCEPTION 'quarantine source delete requires authenticated copied evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_copy_required';
  END IF;

  SELECT count(*)::integer INTO destination_count
    FROM public.document_archive_quarantine_events AS event
   WHERE event."operationId" = quarantine."operationId"
     AND event.kind = 'destination_verified';
  IF destination_count <> 5 OR NOT EXISTS (
    SELECT 1 FROM public.document_archive_quarantine_events AS event
     WHERE event."operationId" = quarantine."operationId"
       AND event.kind = 'destination_verified'
       AND event.ordinal = quarantine.ordinal
  ) THEN
    RAISE EXCEPTION 'five exact quarantine destinations are required before delete'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_destinations_required';
  END IF;

  SELECT count(*)::integer INTO deleted_count
    FROM public.document_archive_quarantine_events AS event
   WHERE event."operationId" = quarantine."operationId"
     AND event.kind = 'source_deleted';
  IF quarantine.ordinal <> deleted_count + 1 OR EXISTS (
    SELECT 1
      FROM pg_catalog.generate_series(1, deleted_count) AS expected(ordinal)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.document_archive_quarantine_events AS event
        WHERE event."operationId" = quarantine."operationId"
          AND event.kind = 'source_deleted'
          AND event.ordinal = expected.ordinal
     )
  ) THEN
    RAISE EXCEPTION 'quarantine deletes must follow the canonical ordinal prefix'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_delete_order';
  END IF;

  -- Le DELETE est la frontière irréversible : il recertifie dans SA transaction le catalogue
  -- exact des huit fences. Le pré-vol applicatif reste utile pour l'observabilité, mais une
  -- désactivation DDL postérieure à ce pré-vol ne doit jamais ouvrir une fenêtre de suppression.
  WITH expected(
    schema_name,
    relation_name,
    trigger_name,
    function_oid,
    trigger_type,
    update_column
  ) AS (
    VALUES
      (
        'storage',
        'objects',
        'generated_legal_storage_object_immutable',
        'public.prevent_generated_legal_storage_object_mutation()'::pg_catalog.regprocedure,
        31,
        NULL::text
      ),
      (
        'storage',
        'buckets',
        'document_archive_quarantine_bucket_fence',
        'public.prevent_document_archive_quarantine_bucket_mutation_v1()'::pg_catalog.regprocedure,
        27,
        NULL::text
      ),
      (
        'public',
        'documents',
        'document_archive_quarantine_documents_reference_fence',
        'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
        23,
        'storageKey'
      ),
      (
        'public',
        'document_versions',
        'document_archive_quarantine_versions_reference_fence',
        'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
        23,
        'storageKey'
      ),
      (
        'public',
        'chantier_photos',
        'document_archive_quarantine_photos_reference_fence',
        'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
        23,
        'storageKey'
      ),
      (
        'public',
        'document_archive_artifact_intents',
        'document_archive_quarantine_intents_reference_fence',
        'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
        23,
        'storageKey'
      ),
      (
        'public',
        'document_archive_job_artifacts',
        'document_archive_quarantine_job_artifacts_reference_fence',
        'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
        23,
        'storageKey'
      ),
      (
        'public',
        'document_archive_jobs',
        'document_archive_quarantine_worker_lease_fence',
        'public.prevent_document_archive_worker_during_quarantine_v1()'::pg_catalog.regprocedure,
        23,
        'leaseToken'
      )
  ), exact_inventory AS (
    SELECT count(*)::integer AS expected_count,
           count(trigger.oid)::integer AS exact_count
      FROM expected
      LEFT JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.nspname = expected.schema_name
      LEFT JOIN pg_catalog.pg_class AS relation
        ON relation.relnamespace = namespace.oid
       AND relation.relname = expected.relation_name
       AND relation.relkind IN ('r', 'p')
      LEFT JOIN pg_catalog.pg_attribute AS update_attribute
        ON update_attribute.attrelid = relation.oid
       AND update_attribute.attname = expected.update_column
       AND update_attribute.attnum > 0
       AND NOT update_attribute.attisdropped
      LEFT JOIN pg_catalog.pg_trigger AS trigger
        ON trigger.tgrelid = relation.oid
       AND trigger.tgname = expected.trigger_name
       AND trigger.tgfoid = expected.function_oid
       AND trigger.tgtype::integer = expected.trigger_type
       AND trigger.tgenabled = 'O'
       AND NOT trigger.tgisinternal
       AND trigger.tgqual IS NULL
       AND trigger.tgnargs = 0
       AND trigger.tgconstraint = 0
       AND NOT trigger.tgdeferrable
       AND NOT trigger.tginitdeferred
       AND trigger.tgoldtable IS NULL
       AND trigger.tgnewtable IS NULL
       AND (expected.update_column IS NULL OR update_attribute.attnum IS NOT NULL)
       AND trigger.tgattr::text = CASE
         WHEN expected.update_column IS NULL THEN ''
         ELSE update_attribute.attnum::text
       END
  ), named_inventory AS (
    SELECT count(*)::integer AS named_count
      FROM pg_catalog.pg_trigger AS trigger
     WHERE NOT trigger.tgisinternal
       AND trigger.tgname IN (
         'generated_legal_storage_object_immutable',
         'document_archive_quarantine_bucket_fence',
         'document_archive_quarantine_documents_reference_fence',
         'document_archive_quarantine_versions_reference_fence',
         'document_archive_quarantine_photos_reference_fence',
         'document_archive_quarantine_intents_reference_fence',
         'document_archive_quarantine_job_artifacts_reference_fence',
         'document_archive_quarantine_worker_lease_fence'
       )
  )
  SELECT exact_inventory.expected_count = 8
     AND exact_inventory.exact_count = 8
     AND named_inventory.named_count = 8
    INTO quarantine_fences_valid
    FROM exact_inventory
    CROSS JOIN named_inventory;

  IF quarantine_fences_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'quarantine database fences are absent or disabled'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_fences_required';
  END IF;

  old_row := pg_catalog.to_jsonb(OLD);
  IF old_bucket IS DISTINCT FROM quarantine."sourceBucket"
     OR old_key IS DISTINCT FROM quarantine."sourceKey"
     OR NULLIF(old_row->>'id', '')::uuid IS DISTINCT FROM quarantine."sourceObjectId"
     OR old_row->>'version' IS DISTINCT FROM quarantine."sourceObjectVersion"
     OR (old_row->>'created_at')::timestamptz IS DISTINCT FROM quarantine."sourceCreatedAt"
     OR (old_row->>'updated_at')::timestamptz IS DISTINCT FROM quarantine."sourceUpdatedAt"
     OR coalesce(old_row->'metadata', 'null'::jsonb) IS DISTINCT FROM
          quarantine."sourceMetadata"
     OR coalesce(old_row->'user_metadata', 'null'::jsonb) IS DISTINCT FROM
          quarantine."sourceUserMetadata" THEN
    RAISE EXCEPTION 'quarantine source storage facts changed'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_source_facts_exact';
  END IF;

  IF EXISTS (SELECT 1 FROM public.documents WHERE "storageKey" = old_key)
     OR EXISTS (SELECT 1 FROM public.document_versions WHERE "storageKey" = old_key)
     OR EXISTS (SELECT 1 FROM public.chantier_photos WHERE "storageKey" = old_key)
     OR EXISTS (
       SELECT 1 FROM public.document_archive_artifact_intents WHERE "storageKey" = old_key
     )
     OR EXISTS (
       SELECT 1 FROM public.document_archive_job_artifacts WHERE "storageKey" = old_key
     ) THEN
    RAISE EXCEPTION 'quarantine source acquired a SQL reference'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_quarantine_reference_fence';
  END IF;

  event_evidence := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'operationId', quarantine."operationId",
    'ordinal', quarantine.ordinal,
    'sourceKeySha256', btrim(quarantine."sourceKeySha256"::text),
    'sourceObjectId', quarantine."sourceObjectId",
    'deletedAt', statement_timestamp()
  );
  PERFORM pg_catalog.set_config(
    'bob.document_archive_quarantine_source_delete',
    quarantine."operationId"::text || ':' || quarantine.ordinal::text,
    true
  );
  INSERT INTO public.document_archive_quarantine_events (
    "operationId", kind, ordinal, "objectId", "objectVersion", "objectCreatedAt",
    "objectUpdatedAt", "objectMetadata", "objectUserMetadata", "byteSha256", "byteSize",
    "contentType", evidence, "evidenceSha256"
  ) VALUES (
    quarantine."operationId", 'source_deleted', quarantine.ordinal,
    quarantine."sourceObjectId", quarantine."sourceObjectVersion", quarantine."sourceCreatedAt",
    quarantine."sourceUpdatedAt", quarantine."sourceMetadata", quarantine."sourceUserMetadata",
    quarantine."byteSha256", quarantine."byteSize", quarantine."contentType", event_evidence,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(event_evidence::text, 'UTF8')),
      'hex'
    )
  );
  RETURN OLD;
END;
$$;

ALTER TABLE public.document_archive_quarantine_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_quarantine_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_quarantine_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_quarantine_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_quarantine_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_quarantine_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.document_archive_quarantine_operations,
  public.document_archive_quarantine_entries,
  public.document_archive_quarantine_events
FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.document_archive_quarantine_events_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.prevent_document_archive_quarantine_ledger_mutation_v1(),
  public.guard_document_archive_quarantine_event_insert_v1(),
  public.guard_document_archive_quarantine_plan_complete_v1(),
  public.prevent_document_archive_quarantine_reference_v1(),
  public.prevent_document_archive_worker_during_quarantine_v1(),
  public.prevent_document_archive_quarantine_bucket_mutation_v1(),
  public.prevent_generated_legal_storage_object_mutation()
FROM PUBLIC;

DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE '
        'public.document_archive_quarantine_operations, '
        'public.document_archive_quarantine_entries, '
        'public.document_archive_quarantine_events FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE '
        'public.document_archive_quarantine_events_id_seq FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION '
        'public.prevent_document_archive_quarantine_ledger_mutation_v1(), '
        'public.guard_document_archive_quarantine_event_insert_v1(), '
        'public.guard_document_archive_quarantine_plan_complete_v1(), '
        'public.prevent_document_archive_quarantine_reference_v1(), '
        'public.prevent_document_archive_worker_during_quarantine_v1(), '
        'public.prevent_document_archive_quarantine_bucket_mutation_v1(), '
        'public.prevent_generated_legal_storage_object_mutation() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE public.document_archive_quarantine_operations IS
  'Plans exact-key privés et append-only pour une quarantaine Storage staging auditée.';
COMMENT ON TABLE public.document_archive_quarantine_entries IS
  'Cinq sources et destinations privées scellées avant toute copie ou suppression Storage.';
COMMENT ON TABLE public.document_archive_quarantine_events IS
  'Journal privé append-only authorization/copy/delete/final-audit/completed de la quarantaine.';
COMMENT ON FUNCTION public.prevent_generated_legal_storage_object_mutation() IS
  'Fail-closed fence: immutable legal originals and exact-key quarantine DELETE authorization.';

-- Supabase owner-split : la fonction appartient à l'owner Archive tandis que storage.objects
-- appartient au rôle vendor supabase_storage_admin, que le déployeur ne doit jamais pouvoir SET.
-- Le déployeur possède en revanche TRIGGER sur la table. PostgreSQL contrôle aussi EXECUTE sur la
-- fonction au CREATE OR REPLACE : l'owner Archive l'accorde donc temporairement à session_user.
DO $document_archive_quarantine_storage_trigger$
DECLARE
  archive_owner_oid OID;
  trigger_function_oid OID :=
    'public.prevent_generated_legal_storage_object_mutation()'::pg_catalog.regprocedure;
  bucket_function_oid OID :=
    'public.prevent_document_archive_quarantine_bucket_mutation_v1()'::pg_catalog.regprocedure;
  deployer_had_execute BOOLEAN;
  deployer_had_bucket_execute BOOLEAN;
BEGIN
  IF pg_catalog.to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42P01',
      MESSAGE = 'DOCUMENT_ARCHIVE_QUARANTINE_STORAGE_OBJECTS_MISSING';
  END IF;

  SELECT function.proowner
    INTO STRICT archive_owner_oid
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid = trigger_function_oid;

  IF current_user::pg_catalog.regrole <> archive_owner_oid
     OR NOT pg_catalog.pg_has_role(session_user, archive_owner_oid, 'SET')
     OR NOT pg_catalog.has_table_privilege(session_user, 'storage.objects', 'TRIGGER')
     OR NOT pg_catalog.has_table_privilege(session_user, 'storage.buckets', 'TRIGGER') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_ARCHIVE_QUARANTINE_STORAGE_TRIGGER_AUTHORITY_UNAVAILABLE';
  END IF;

  deployer_had_execute := pg_catalog.has_function_privilege(
    session_user,
    trigger_function_oid,
    'EXECUTE'
  );
  PERFORM pg_catalog.set_config(
    'bob.document_archive_quarantine_deployer_had_trigger_execute',
    CASE WHEN deployer_had_execute THEN 'true' ELSE 'false' END,
    true
  );
  IF NOT deployer_had_execute THEN
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.prevent_generated_legal_storage_object_mutation() TO %I',
      session_user
    );
  END IF;
  deployer_had_bucket_execute := pg_catalog.has_function_privilege(
    session_user,
    bucket_function_oid,
    'EXECUTE'
  );
  PERFORM pg_catalog.set_config(
    'bob.document_archive_quarantine_deployer_had_bucket_execute',
    CASE WHEN deployer_had_bucket_execute THEN 'true' ELSE 'false' END,
    true
  );
  IF NOT deployer_had_bucket_execute THEN
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION '
      'public.prevent_document_archive_quarantine_bucket_mutation_v1() TO %I',
      session_user
    );
  END IF;
END;
$document_archive_quarantine_storage_trigger$;

RESET ROLE;

CREATE OR REPLACE TRIGGER generated_legal_storage_object_immutable
BEFORE INSERT OR UPDATE OR DELETE ON storage.objects
FOR EACH ROW EXECUTE FUNCTION public.prevent_generated_legal_storage_object_mutation();
CREATE OR REPLACE TRIGGER document_archive_quarantine_bucket_fence
BEFORE UPDATE OR DELETE ON storage.buckets
FOR EACH ROW EXECUTE FUNCTION public.prevent_document_archive_quarantine_bucket_mutation_v1();

DO $document_archive_quarantine_storage_trigger_acl_restore$
DECLARE
  archive_owner_oid OID;
  archive_owner_name TEXT;
  deployer_had_execute BOOLEAN := coalesce(
    current_setting('bob.document_archive_quarantine_deployer_had_trigger_execute', true),
    ''
  ) = 'true';
  deployer_had_bucket_execute BOOLEAN := coalesce(
    current_setting('bob.document_archive_quarantine_deployer_had_bucket_execute', true),
    ''
  ) = 'true';
BEGIN
  SELECT function.proowner, pg_catalog.pg_get_userbyid(function.proowner)
    INTO STRICT archive_owner_oid, archive_owner_name
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.prevent_generated_legal_storage_object_mutation()'::pg_catalog.regprocedure;
  IF archive_owner_name IS NULL
     OR NOT pg_catalog.pg_has_role(session_user, archive_owner_oid, 'SET') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_ARCHIVE_QUARANTINE_FUNCTION_OWNER_UNAVAILABLE';
  END IF;
  IF NOT deployer_had_execute THEN
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', archive_owner_name);
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION public.prevent_generated_legal_storage_object_mutation() FROM %I',
      session_user
    );
    RESET ROLE;
  END IF;
  IF NOT deployer_had_bucket_execute THEN
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', archive_owner_name);
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION '
      'public.prevent_document_archive_quarantine_bucket_mutation_v1() FROM %I',
      session_user
    );
    RESET ROLE;
  END IF;
END;
$document_archive_quarantine_storage_trigger_acl_restore$;

DO $document_archive_quarantine_owner_restore$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
  owner_had_schema_create BOOLEAN := coalesce(
    current_setting('bob.document_archive_quarantine_owner_had_schema_create', true),
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
        MESSAGE = 'DOCUMENT_ARCHIVE_QUARANTINE_SCHEMA_ACL_RESTORE_FAILED';
    END IF;
  END IF;
END;
$document_archive_quarantine_owner_restore$;

COMMIT;
