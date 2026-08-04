#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
: "${APP_DATABASE_ROLE:?APP_DATABASE_ROLE non-superuser runtime role is required}"
: "${DOCUMENT_ARCHIVE_SNAPSHOT_V2_ACTIVATION_RELEASE_SHA:?40-char release SHA is required}"

command -v psql >/dev/null 2>&1 || {
  echo "psql is required" >&2
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "openssl is required to certify migration checksums" >&2
  exit 1
}

case "$DOCUMENT_ARCHIVE_SNAPSHOT_V2_ACTIVATION_RELEASE_SHA" in
  *[!0-9a-f]*|'')
    echo "DOCUMENT_ARCHIVE_SNAPSHOT_V2_ACTIVATION_RELEASE_SHA must be lowercase hexadecimal" >&2
    exit 1
    ;;
esac
if [ "${#DOCUMENT_ARCHIVE_SNAPSHOT_V2_ACTIVATION_RELEASE_SHA}" -ne 40 ]; then
  echo "DOCUMENT_ARCHIVE_SNAPSHOT_V2_ACTIVATION_RELEASE_SHA must contain exactly 40 characters" >&2
  exit 1
fi

snapshot_migration_checksum() {
  migration_name="$1"
  migration_file="apps/api/prisma/migrations/$migration_name/migration.sql"
  if [ ! -f "$migration_file" ]; then
    echo "document archive snapshot migration is missing: $migration_name" >&2
    return 1
  fi

  checksum="$(openssl dgst -sha256 -r "$migration_file" | awk '{print $1}')"
  case "$checksum" in
    *[!0-9a-f]*|'')
      echo "cannot compute a canonical migration checksum: $migration_name" >&2
      return 1
      ;;
  esac
  if [ "${#checksum}" -ne 64 ]; then
    echo "cannot compute a canonical migration checksum: $migration_name" >&2
    return 1
  fi
  printf '%s' "$checksum"
}

expand_migration='20260804010000_document_archive_snapshot_intent_expand'
validate_migration='20260804010100_document_archive_snapshot_intent_validate'
expand_sha256="$(snapshot_migration_checksum "$expand_migration")"
validate_sha256="$(snapshot_migration_checksum "$validate_migration")"

# Le verrou des jobs draine les writers N-1 avant le CAS de protocole. Migration checksums,
# absence de legacy incomplet, retrait des anciennes capacités et passage terminal V2 partagent
# le même COMMIT : une anomalie conserve intégralement la phase expand.
psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v app_role="$APP_DATABASE_ROLE" \
  -v release_sha="$DOCUMENT_ARCHIVE_SNAPSHOT_V2_ACTIVATION_RELEASE_SHA" \
  -v expand_migration="$expand_migration" \
  -v validate_migration="$validate_migration" \
  -v expand_sha256="$expand_sha256" \
  -v validate_sha256="$validate_sha256" <<'SQL'
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '130s';

SELECT set_config('bob.archive_snapshot_activation_app_role', :'app_role', true);
SELECT set_config('bob.archive_snapshot_activation_release_sha', :'release_sha', true);
SELECT set_config('bob.archive_snapshot_expand_migration', :'expand_migration', true);
SELECT set_config('bob.archive_snapshot_validate_migration', :'validate_migration', true);
SELECT set_config('bob.archive_snapshot_expand_sha256', :'expand_sha256', true);
SELECT set_config('bob.archive_snapshot_validate_sha256', :'validate_sha256', true);

DO $owner_bootstrap$
DECLARE
  owner_oid OID;
  owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT owner_oid, owner_name
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.document_archive_jobs'::regclass;
  IF owner_name IS NULL
     OR (session_user::regrole <> owner_oid
       AND NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET')) THEN
    RAISE EXCEPTION 'archive snapshot schema owner is unavailable to the deployer';
  END IF;
  IF NOT pg_catalog.has_table_privilege(
       session_user,
       'public._prisma_migrations',
       'SELECT, UPDATE'
     ) THEN
    RAISE EXCEPTION 'archive snapshot deployer cannot freeze the Prisma migration ledger';
  END IF;
  PERFORM pg_catalog.set_config('bob.archive_snapshot_owner_name', owner_name, true);
END;
$owner_bootstrap$;

-- Le déployeur possède le ledger Prisma : il le fige et vérifie les checksums avant de prendre
-- le rôle propriétaire des objets archive. Aucun GRANT temporaire ne matérialise ou ne dérive
-- l'ACL implicite de `_prisma_migrations`.
LOCK TABLE public._prisma_migrations IN SHARE MODE;
DO $migration_gate$
DECLARE
  expected RECORD;
  applied_count INTEGER;
  applied_checksum TEXT;
BEGIN
  FOR expected IN
    SELECT * FROM (
      VALUES
        (
          current_setting('bob.archive_snapshot_expand_migration'),
          current_setting('bob.archive_snapshot_expand_sha256')
        ),
        (
          current_setting('bob.archive_snapshot_validate_migration'),
          current_setting('bob.archive_snapshot_validate_sha256')
        )
    ) AS migrations(name, checksum)
  LOOP
    SELECT count(*)::INTEGER, min(migration.checksum)
      INTO applied_count, applied_checksum
      FROM public._prisma_migrations AS migration
     WHERE migration.migration_name = expected.name
       AND migration.finished_at IS NOT NULL
       AND migration.rolled_back_at IS NULL;
    IF applied_count <> 1 OR applied_checksum IS DISTINCT FROM expected.checksum THEN
      RAISE EXCEPTION 'archive snapshot migration is missing or divergent: %', expected.name;
    END IF;
  END LOOP;
END;
$migration_gate$;

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I',
  current_setting('bob.archive_snapshot_owner_name')
) \gexec

LOCK TABLE public.document_archive_jobs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_archive_render_snapshots IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_archive_snapshot_protocol_state IN SHARE ROW EXCLUSIVE MODE;

DO $activation$
DECLARE
  runtime_role pg_catalog.pg_roles%ROWTYPE;
  direct_role pg_catalog.pg_roles%ROWTYPE;
  protocol RECORD;
  function_signature TEXT;
  relation_name TEXT;
  exposed_role TEXT;
  runtime_role_name TEXT := current_setting('bob.archive_snapshot_activation_app_role');
  release_sha TEXT := current_setting('bob.archive_snapshot_activation_release_sha');
  invoker_trigger_functions CONSTANT TEXT[] := ARRAY[
    'public.enforce_document_archive_snapshot_protocol_monotonicity()',
    'public.prevent_document_archive_snapshot_mutation()',
    'public.prevent_document_archive_artifact_intent_mutation()'
  ]::TEXT[];
  privileged_functions CONSTANT TEXT[] := ARRAY[
    'public.guard_document_archive_job_snapshot_required_v1()',
    'public.document_archive_job_enqueue_v3(text,text,text,text,smallint,smallint,text,text)',
    'public.document_archive_artifact_intents_prepare_v1(text,text,text,text,jsonb)',
    'public.document_archive_artifact_intents_list_v1(text,text)',
    'public.document_archive_job_complete_v3(text,text,text,jsonb,text)',
    'public.prevent_generated_legal_storage_object_mutation()'
  ]::TEXT[];
BEGIN
  SELECT * INTO STRICT direct_role
    FROM pg_catalog.pg_roles
   WHERE rolname = session_user;
  IF NOT (direct_role.rolsuper OR direct_role.rolbypassrls) THEN
    RAISE EXCEPTION 'DIRECT_URL must use SUPERUSER or BYPASSRLS archive authority';
  END IF;

  SELECT * INTO runtime_role
    FROM pg_catalog.pg_roles
   WHERE rolname = runtime_role_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APP_DATABASE_ROLE does not exist';
  END IF;
  IF runtime_role.rolsuper OR runtime_role.rolbypassrls THEN
    RAISE EXCEPTION 'APP_DATABASE_ROLE must be NOSUPERUSER and NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.document_archive_protocol_state AS archive_protocol
     WHERE archive_protocol.id = 1
       AND archive_protocol."activeVersion" = 2
       AND archive_protocol."activatedAt" IS NOT NULL
       AND btrim(archive_protocol."activatedByReleaseSha"::TEXT) ~ '^[0-9a-f]{40}$'
  ) THEN
    RAISE EXCEPTION 'base document archive protocol V2 must be terminal before snapshot cutover';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'document_archive_render_snapshots',
    'document_archive_artifact_intents',
    'document_archive_snapshot_protocol_state'
  ]::TEXT[] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = relation_name
         AND relation.relkind = 'r'
         AND relation.relrowsecurity
         AND relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'archive snapshot relation is not FORCE RLS: %', relation_name;
    END IF;
  END LOOP;

  FOREACH function_signature IN ARRAY invoker_trigger_functions LOOP
    IF pg_catalog.to_regprocedure(function_signature) IS NULL THEN
      RAISE EXCEPTION 'archive snapshot trigger function is missing: %', function_signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function
       WHERE function.oid = pg_catalog.to_regprocedure(function_signature)
         AND NOT function.prosecdef
         AND function.proconfig @> ARRAY['search_path=pg_catalog, public']::TEXT[]
    ) THEN
      RAISE EXCEPTION 'archive snapshot trigger function posture is unsafe: %', function_signature;
    END IF;
    FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
      IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
         AND pg_catalog.has_function_privilege(exposed_role, function_signature, 'EXECUTE') THEN
        RAISE EXCEPTION '% retains archive snapshot function %', exposed_role, function_signature;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH function_signature IN ARRAY privileged_functions LOOP
    IF pg_catalog.to_regprocedure(function_signature) IS NULL THEN
      RAISE EXCEPTION 'archive snapshot function is missing: %', function_signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
       WHERE function.oid = pg_catalog.to_regprocedure(function_signature)
         AND function.prosecdef
         AND function.proconfig @> ARRAY['row_security=off']::TEXT[]
         AND (owner.rolsuper OR owner.rolbypassrls)
    ) THEN
      RAISE EXCEPTION 'archive snapshot function authority is unsafe: %', function_signature;
    END IF;
    FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
      IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
         AND pg_catalog.has_function_privilege(exposed_role, function_signature, 'EXECUTE') THEN
        RAISE EXCEPTION '% retains archive snapshot function %', exposed_role, function_signature;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_enqueue_v3(text,text,text,text,smallint,smallint,text,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       runtime_role_name,
       'public.document_archive_artifact_intents_prepare_v1(text,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       runtime_role_name,
       'public.document_archive_artifact_intents_list_v1(text,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_complete_v3(text,text,text,jsonb,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'runtime V3 archive snapshot capabilities are incomplete';
  END IF;

  SELECT state."activeVersion", state."activatedByReleaseSha"
    INTO STRICT protocol
    FROM public.document_archive_snapshot_protocol_state AS state
   WHERE state.id = 1
   FOR UPDATE;

  IF protocol."activeVersion" = 2 THEN
    -- Une release ultérieure revalide le rail sans réécrire la preuve historique du premier
    -- cutover. Le SHA fourni ne sert à l'écriture que pendant la transition V1 -> V2.
    IF protocol."activatedByReleaseSha" IS NULL
       OR btrim(protocol."activatedByReleaseSha") !~ '^[0-9a-f]{40}$' THEN
      RAISE EXCEPTION 'archive snapshot protocol terminal proof is invalid';
    END IF;
  ELSIF protocol."activeVersion" = 1 THEN
    IF EXISTS (
      SELECT 1
        FROM public.document_archive_jobs AS job
        LEFT JOIN public.document_archive_render_snapshots AS snapshot
          ON snapshot."jobId" = job.id AND snapshot."companyId" = job."companyId"
       WHERE snapshot."jobId" IS NULL
         AND job."leaseToken" IS NOT NULL
         AND job."nextAttemptAt" > statement_timestamp()
    ) THEN
      RAISE EXCEPTION 'an active N-1 document archive lease still exists';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.document_archive_jobs AS job
        LEFT JOIN public.document_archive_render_snapshots AS snapshot
          ON snapshot."jobId" = job.id AND snapshot."companyId" = job."companyId"
       WHERE snapshot."jobId" IS NULL
         AND (
           job.status <> 'done'::public."DocumentArchiveJobStatus"
           OR job."integrityProof" IS NULL
           OR job."integrityProofSha256" IS NULL
           OR job."completedAt" IS NULL
         )
    ) THEN
      RAISE EXCEPTION 'an incomplete N-1 document archive job has no sealed snapshot';
    END IF;

    UPDATE public.document_archive_snapshot_protocol_state
       SET "activeVersion" = 2,
           "activatedAt" = statement_timestamp(),
           "activatedByReleaseSha" = release_sha
     WHERE id = 1 AND "activeVersion" = 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'archive snapshot protocol activation CAS failed';
    END IF;
  ELSE
    RAISE EXCEPTION 'archive snapshot protocol version is unsupported: %', protocol."activeVersion";
  END IF;

  EXECUTE pg_catalog.format(
    'REVOKE EXECUTE ON FUNCTION public.document_archive_job_enqueue_v2(text,text,text,text) FROM %I',
    runtime_role_name
  );
  EXECUTE pg_catalog.format(
    'REVOKE EXECUTE ON FUNCTION public.document_archive_job_complete_v2(text,text,text,jsonb,text) FROM %I',
    runtime_role_name
  );

  IF pg_catalog.has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_enqueue_v2(text,text,text,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_complete_v2(text,text,text,jsonb,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'runtime N-1 archive capabilities remain executable after cutover';
  END IF;
END;
$activation$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $postcondition$
DECLARE
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.document_archive_snapshot_protocol_state AS state
     WHERE state.id = 1
       AND state."activeVersion" = 2
       AND state."activatedAt" IS NOT NULL
       AND btrim(state."activatedByReleaseSha") ~ '^[0-9a-f]{40}$'
  ) THEN
    RAISE EXCEPTION 'archive snapshot protocol terminal receipt is missing';
  END IF;
END;
$postcondition$;

RESET ROLE;
SQL

activation_receipt="$({
  psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_catalog.format('SET ROLE %I', owner.rolname)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.document_archive_snapshot_protocol_state'::regclass
\gexec
SELECT btrim("activatedByReleaseSha")
  FROM public.document_archive_snapshot_protocol_state
 WHERE id = 1 AND "activeVersion" = 2;
RESET ROLE;
SQL
} | tr -d '\r\n')"
case "$activation_receipt" in
  *[!0-9a-f]*|'')
    echo "Document archive snapshot protocol terminal receipt cannot be read" >&2
    exit 1
    ;;
esac
if [ "${#activation_receipt}" -ne 40 ]; then
  echo "Document archive snapshot protocol terminal receipt is malformed" >&2
  exit 1
fi

echo "Document archive snapshot protocol V2 validated for current release; initial activation receipt=${activation_receipt}."
