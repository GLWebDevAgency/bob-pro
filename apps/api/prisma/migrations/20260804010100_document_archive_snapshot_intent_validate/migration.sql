-- Validation séparée des contraintes expand, compatible avec le writer N-1.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

DO $document_archive_snapshot_validate_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'document_archive_render_snapshots'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_ARCHIVE_SNAPSHOT_VALIDATE_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;
  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_ARCHIVE_SNAPSHOT_VALIDATE_OWNER_NOT_ASSUMED';
  END IF;
END;
$document_archive_snapshot_validate_owner$;

ALTER TABLE public.document_archive_render_snapshots
  VALIDATE CONSTRAINT "document_archive_render_snapshots_job_fkey";
ALTER TABLE public.document_archive_render_snapshots
  VALIDATE CONSTRAINT "document_archive_render_snapshot_versions_valid";
ALTER TABLE public.document_archive_render_snapshots
  VALIDATE CONSTRAINT "document_archive_render_snapshot_reason_valid";
ALTER TABLE public.document_archive_render_snapshots
  VALIDATE CONSTRAINT "document_archive_render_snapshot_digest_valid";
ALTER TABLE public.document_archive_render_snapshots
  VALIDATE CONSTRAINT "document_archive_render_snapshot_payload_size_valid";
ALTER TABLE public.document_archive_render_snapshots
  VALIDATE CONSTRAINT "document_archive_render_snapshot_payload_json_valid";

ALTER TABLE public.document_archive_artifact_intents
  VALIDATE CONSTRAINT "document_archive_artifact_intents_snapshot_fkey";
ALTER TABLE public.document_archive_artifact_intents
  VALIDATE CONSTRAINT "document_archive_artifact_intent_kind_valid";
ALTER TABLE public.document_archive_artifact_intents
  VALIDATE CONSTRAINT "document_archive_artifact_intent_profile_valid";
ALTER TABLE public.document_archive_artifact_intents
  VALIDATE CONSTRAINT "document_archive_artifact_intent_version_valid";
ALTER TABLE public.document_archive_artifact_intents
  VALIDATE CONSTRAINT "document_archive_artifact_intent_bytes_valid";
ALTER TABLE public.document_archive_artifact_intents
  VALIDATE CONSTRAINT "document_archive_artifact_intent_digest_valid";

RESET ROLE;

COMMIT;
