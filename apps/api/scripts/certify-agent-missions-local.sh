#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
PG_BIN_DIR="${PG_BIN_DIR:-}"
EXTERNAL_SUPER_URL="${AGENT_MISSION_CERT_SUPER_URL:-}"
CERT_ROOT=""
DATA_DIR=""
LOCAL_CLUSTER_STARTED=false

cleanup() {
  cleanup_status=$?
  trap - EXIT HUP INT TERM
  if [ "$LOCAL_CLUSTER_STARTED" = "true" ]; then
    "$PG_BIN_DIR/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [ -n "$CERT_ROOT" ]; then
    rm -rf "$CERT_ROOT"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT HUP INT TERM

if [ -n "$EXTERNAL_SUPER_URL" ]; then
  : "${AGENT_MISSION_CERT_DEPLOYER_BOOTSTRAP_URL:?required with AGENT_MISSION_CERT_SUPER_URL}"
  : "${AGENT_MISSION_CERT_DIRECT_URL:?required with AGENT_MISSION_CERT_SUPER_URL}"
  : "${AGENT_MISSION_CERT_RUNTIME_URL:?required with AGENT_MISSION_CERT_SUPER_URL}"
  : "${AGENT_MISSION_CERT_AUDITOR_URL:?required with AGENT_MISSION_CERT_SUPER_URL}"
  if [ -n "$PG_BIN_DIR" ]; then
    PSQL_BIN="$PG_BIN_DIR/psql"
  else
    PSQL_BIN="$(command -v psql || true)"
  fi
  if [ -z "$PSQL_BIN" ] || [ ! -x "$PSQL_BIN" ]; then
    echo "psql client is required for external AgentMission certification" >&2
    exit 1
  fi
  SUPER_URL="$EXTERNAL_SUPER_URL"
  DEPLOYER_BOOTSTRAP_URL="$AGENT_MISSION_CERT_DEPLOYER_BOOTSTRAP_URL"
  DIRECT_URL="$AGENT_MISSION_CERT_DIRECT_URL"
  DATABASE_URL="$AGENT_MISSION_CERT_RUNTIME_URL"
  CERT_ADMIN_URL="$AGENT_MISSION_CERT_AUDITOR_URL"
else
  if [ -n "${AGENT_MISSION_CERT_DEPLOYER_BOOTSTRAP_URL:-}" ] \
    || [ -n "${AGENT_MISSION_CERT_DIRECT_URL:-}" ] \
    || [ -n "${AGENT_MISSION_CERT_RUNTIME_URL:-}" ] \
    || [ -n "${AGENT_MISSION_CERT_AUDITOR_URL:-}" ]; then
    echo "External AgentMission certificate URLs require AGENT_MISSION_CERT_SUPER_URL" >&2
    exit 1
  fi

  if [ -z "$PG_BIN_DIR" ]; then
    discovered_pg_bin_dir=""
    if [ -x /opt/homebrew/opt/postgresql@17/bin/initdb ]; then
      PG_BIN_DIR=/opt/homebrew/opt/postgresql@17/bin
    elif command -v initdb >/dev/null 2>&1; then
      discovered_pg_bin_dir="$(dirname "$(command -v initdb)")"
    fi
    if [ -z "$PG_BIN_DIR" ] && [ -n "$discovered_pg_bin_dir" ] \
      && [ -x "$discovered_pg_bin_dir/postgres" ]; then
      PG_BIN_DIR="$discovered_pg_bin_dir"
    elif [ -z "$PG_BIN_DIR" ]; then
      echo "PostgreSQL 17 initdb/pg_ctl/psql are required" >&2
      exit 1
    fi
  fi

  for binary in postgres initdb pg_ctl psql createdb; do
    if [ ! -x "$PG_BIN_DIR/$binary" ]; then
      echo "$PG_BIN_DIR/$binary is required" >&2
      exit 1
    fi
  done

  postgres_major="$(
    "$PG_BIN_DIR/postgres" --version \
      | sed -E 's/^postgres \(PostgreSQL\) ([0-9]+)(\..*)?$/\1/'
  )"
  if [ "$postgres_major" != "17" ]; then
    echo "PostgreSQL 17 is required; found: $("$PG_BIN_DIR/postgres" --version)" >&2
    exit 1
  fi

  CERT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/bob-agent-mission-cert.XXXXXX")"
  DATA_DIR="$CERT_ROOT/data"
  SOCKET_DIR="$CERT_ROOT/socket"
  PORT="${AGENT_MISSION_CERT_PORT:-55441}"
  mkdir "$SOCKET_DIR"

  "$PG_BIN_DIR/initdb" -A trust -U postgres -D "$DATA_DIR" >/dev/null
  "$PG_BIN_DIR/pg_ctl" \
    -D "$DATA_DIR" \
    -o "-F -p $PORT -k $SOCKET_DIR" \
    -w start >/dev/null
  LOCAL_CLUSTER_STARTED=true

  PSQL_BIN="$PG_BIN_DIR/psql"
  SUPER_URL="postgresql://postgres@localhost:$PORT/postgres?host=$SOCKET_DIR"
  DEPLOYER_BOOTSTRAP_URL="postgresql://bob_deployer@localhost:$PORT/postgres?host=$SOCKET_DIR"
fi

server_version_num="$(
  "$PSQL_BIN" "$SUPER_URL" -X -qAt -v ON_ERROR_STOP=1 -c 'SHOW server_version_num'
)"
case "$server_version_num" in
  17????) ;;
  *)
    echo "PostgreSQL 17 runtime is required; server_version_num=$server_version_num" >&2
    exit 1
    ;;
esac

"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE bob_deployer
  LOGIN NOSUPERUSER CREATEDB CREATEROLE NOINHERIT BYPASSRLS;
CREATE ROLE bob_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
CREATE ROLE bob_cert_auditor
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE bob_mistral_bootstrap_reaper
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE bob_realtime_reaper_directory
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SQL

"$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET createrole_self_grant = 'set';
CREATE ROLE bob_schema_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SQL
"$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-release-flag-authority-role.sql"

owner_membership_count="$(
  "$PSQL_BIN" "$SUPER_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role
    ON member_role.oid = membership.member
  JOIN pg_catalog.pg_roles AS granted_role
    ON granted_role.oid = membership.roleid
 WHERE member_role.rolname = 'bob_deployer'
   AND granted_role.rolname = 'bob_schema_owner'
   AND membership.set_option
   AND NOT membership.inherit_option;
SQL
)"
if [ "$owner_membership_count" != "1" ]; then
  echo "createrole_self_grant='set' did not create the expected deployer membership" >&2
  exit 1
fi

authority_membership_count="$(
  "$PSQL_BIN" "$SUPER_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role
    ON member_role.oid = membership.member
  JOIN pg_catalog.pg_roles AS granted_role
    ON granted_role.oid = membership.roleid
 WHERE member_role.rolname = 'bob_deployer'
   AND granted_role.rolname = 'bob_agent_mission_release_flag_authority'
   AND membership.set_option
   AND NOT membership.inherit_option;
SQL
)"
if [ "$authority_membership_count" != "1" ]; then
  echo "AgentMission authority requires implicit SET membership for the deployer" >&2
  exit 1
fi

if [ -z "$EXTERNAL_SUPER_URL" ]; then
  "$PG_BIN_DIR/createdb" \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -U postgres \
    -O bob_schema_owner \
    bob_agent_mission_cert

  DIRECT_URL="postgresql://bob_deployer@localhost:$PORT/bob_agent_mission_cert?host=$SOCKET_DIR"
  DATABASE_URL="postgresql://bob_app@localhost:$PORT/bob_agent_mission_cert?host=$SOCKET_DIR"
  CERT_ADMIN_URL="postgresql://bob_cert_auditor@localhost:$PORT/bob_agent_mission_cert?host=$SOCKET_DIR"
else
  "$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_catalog.format(
  'CREATE DATABASE %I OWNER %I',
  'bob_agent_mission_cert',
  'bob_schema_owner'
)
\gexec
SQL
fi

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;

-- Supabase accorde ces privilèges Data API par défaut aux nouveaux objets du schéma public.
-- Le certificat doit partir d'un état exposé, puis prouver que la migration le referme.
ALTER DEFAULT PRIVILEGES FOR ROLE bob_schema_owner IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE bob_schema_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TYPE public."ReleaseEnvironment" AS ENUM (
  'development',
  'staging',
  'production'
);
CREATE TYPE public."ReleaseFlagSubjectType" AS ENUM ('user', 'cabinet');

CREATE TABLE public.companies (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "legalForm" TEXT NOT NULL,
  "siren" CHAR(9) NOT NULL,
  "siret" CHAR(14) NOT NULL UNIQUE,
  "trade" TEXT NOT NULL,
  "vatRegime" TEXT NOT NULL,
  "addrLine1" TEXT NOT NULL,
  "addrZip" TEXT NOT NULL,
  "addrCity" TEXT NOT NULL,
  "closedAt" TIMESTAMPTZ(6),
  "closureReason" TEXT
);

CREATE TABLE public.cabinets (
  id TEXT PRIMARY KEY
);

CREATE TABLE public.release_flags (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  environment public."ReleaseEnvironment" NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  "killSwitch" BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT release_flags_key_check CHECK (
    length(key) <= 80 AND key ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
  ),
  CONSTRAINT release_flags_version_check CHECK (version >= 1),
  CONSTRAINT release_flags_key_environment_key UNIQUE (key, environment)
);

CREATE TABLE public.release_flag_subjects (
  id TEXT PRIMARY KEY,
  "flagId" TEXT NOT NULL REFERENCES public.release_flags(id) ON DELETE CASCADE,
  "subjectType" public."ReleaseFlagSubjectType" NOT NULL,
  "subjectId" TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT release_flag_subjects_flag_subject_key
    UNIQUE ("flagId", "subjectType", "subjectId")
);

CREATE TABLE public.release_flag_audit_events (
  id TEXT PRIMARY KEY,
  "flagId" TEXT NOT NULL REFERENCES public.release_flags(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (
    operation IN ('set-global', 'set-kill-switch', 'set-subject', 'remove-subject')
  ),
  "beforeState" JSONB NOT NULL CHECK (jsonb_typeof("beforeState") = 'object'),
  "afterState" JSONB NOT NULL CHECK (jsonb_typeof("afterState") = 'object'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION public.cabinet_guard_release_flag_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.key <> OLD.key
     OR NEW.environment <> OLD.environment
     OR NEW."createdAt" <> OLD."createdAt"
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid release flag update';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_flags_guard_update
BEFORE UPDATE ON public.release_flags
FOR EACH ROW EXECUTE FUNCTION public.cabinet_guard_release_flag_update();

GRANT CREATE ON SCHEMA public TO bob_deployer;
RESET ROLE;
CREATE OR REPLACE FUNCTION public.cabinet_delete_release_flag_subjects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  DELETE FROM public.release_flag_subjects
   WHERE "subjectType" = 'cabinet'
     AND "subjectId" = OLD.id;
  RETURN OLD;
END;
$$;
SET ROLE bob_schema_owner;
CREATE TRIGGER cabinets_delete_release_flag_subjects
AFTER DELETE ON public.cabinets
FOR EACH ROW EXECUTE FUNCTION public.cabinet_delete_release_flag_subjects();

CREATE TABLE public.quote_draft_slots (
  "companyId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "payloadVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT quote_draft_slots_pkey PRIMARY KEY ("companyId", "ownerUserId"),
  CONSTRAINT quote_draft_slots_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies("id")
);

ALTER TABLE public.quote_draft_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_draft_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_draft_slot_owner_select ON public.quote_draft_slots FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_insert ON public.quote_draft_slots FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_update ON public.quote_draft_slots FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_delete ON public.quote_draft_slots FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );

ALTER TABLE public.release_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY release_flag_identity_select ON public.release_flags FOR SELECT
  USING (nullif(current_setting('app.current_user_id', true), '') IS NOT NULL);
CREATE POLICY release_flag_agent_mission_authority_select ON public.release_flags FOR SELECT
  USING (current_user = 'bob_agent_mission_release_flag_authority');
CREATE POLICY release_flag_agent_mission_authority_lock ON public.release_flags FOR UPDATE
  USING (current_user = 'bob_agent_mission_release_flag_authority')
  WITH CHECK (current_user = 'bob_agent_mission_release_flag_authority');
CREATE POLICY release_flag_schema_owner_all ON public.release_flags FOR ALL
  USING (current_user = 'bob_schema_owner')
  WITH CHECK (current_user = 'bob_schema_owner');
ALTER TABLE public.release_flag_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_flag_subjects FORCE ROW LEVEL SECURITY;
CREATE POLICY release_flag_subject_select ON public.release_flag_subjects FOR SELECT
  USING (
    "subjectType" = 'user'
    AND "subjectId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY release_flag_subject_schema_owner_all ON public.release_flag_subjects FOR ALL
  USING (current_user = 'bob_schema_owner')
  WITH CHECK (current_user = 'bob_schema_owner');
ALTER TABLE public.release_flag_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_flag_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY release_flag_audit_schema_owner_all ON public.release_flag_audit_events FOR ALL
  USING (current_user = 'bob_schema_owner')
  WITH CHECK (current_user = 'bob_schema_owner');

GRANT USAGE ON SCHEMA public TO bob_app;
-- PostgreSQL exige SELECT + UPDATE pour SELECT ... FOR SHARE. Le runtime production possède
-- déjà UPDATE sur companies (la clôture monotone l'utilise) ; le harnais reproduit ce droit exact.
GRANT SELECT, UPDATE ON TABLE public.companies TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_draft_slots TO bob_app;
GRANT SELECT ON TABLE public.release_flags, public.release_flag_subjects TO bob_app;

-- Prisma migrate deploy se connecte comme bob_deployer (non-superuser/BYPASSRLS) et crée les
-- nouveaux helpers sous ce rôle avant leur transfert post-migration.
GRANT CREATE ON SCHEMA public TO bob_deployer;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.release_flags,
  public.release_flag_subjects,
  public.release_flag_audit_events
TO bob_deployer;

INSERT INTO public.companies (
  "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
  "addrLine1", "addrZip", "addrCity"
) VALUES (
  'writer-n1-company', 'Writer N-1', 'EI', '901000009', '90100000900009',
  'certification', 'reel_normal', '1 rue N-1', '75001', 'Paris'
);

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies FORCE ROW LEVEL SECURITY;
CREATE POLICY company_select ON public.companies FOR SELECT
  USING ("id" = current_setting('app.current_company_id', true));
CREATE POLICY company_update ON public.companies FOR UPDATE
  USING ("id" = current_setting('app.current_company_id', true))
  WITH CHECK ("id" = current_setting('app.current_company_id', true));
SQL

# Le writer N-1 est prouvé contre la vraie lignée Realtime antérieure à M1-B : schéma, contraintes
# et neuf triggers finaux (sideband, provider, Mistral, reaper et capacité globale).
for realtime_migration in \
  20260713220000_realtime_admission_leases \
  20260713223000_realtime_screen_context \
  20260713230000_realtime_durable_speech \
  20260714010000_realtime_speech_fencing_hardening \
  20260714020000_realtime_provider_identity \
  20260714030000_realtime_mistral_ingress_tickets \
  20260722030000_realtime_reaper_directory \
  20260722040000_realtime_global_capacity
do
  "$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -c 'SET ROLE bob_schema_owner' \
    -f "$ROOT_DIR/apps/api/prisma/migrations/$realtime_migration/migration.sql"
done

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
UPDATE public.realtime_global_capacity
   SET mode = 'active',
       "providerId" = 'openai',
       "providerModel" = 'gpt-realtime',
       "globalMaxSessions" = 100,
       "providerMaxSessions" = 1000,
       "configVersion" = 1,
       "retryAfterSeconds" = 5,
       "activatedAt" = clock_timestamp(),
       revision = revision + 1,
       "updatedAt" = clock_timestamp()
 WHERE id = 1;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.realtime_session_leases TO bob_app;
RESET ROLE;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726010000_agent_missions_expand/migration.sql"

# Writer N-1 exact, exécuté par le runtime non-superuser sous les triggers finaux de l'expand,
# avant validation de la FK.
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-n1-owner', true);
INSERT INTO public.quote_draft_slots (
  "companyId", "ownerUserId", "revision", "payloadVersion", "payload"
) VALUES (
  'writer-n1-company',
  'writer-n1-owner',
  1,
  1,
  '{"schema":"bob.quote-draft","version":1,"draft":{"sessionId":"n1","contentRevision":0,"stagingRevision":0,"step":"client","customer":null,"lines":[],"lineMetadata":[],"lineForm":{"label":"","quantity":"1","unitPrice":"","category":"labor"},"vatDecision":null,"depositPct":30,"signMode":null}}'
);
UPDATE public.quote_draft_slots
   SET "revision" = 2
 WHERE "companyId" = 'writer-n1-company'
   AND "ownerUserId" = 'writer-n1-owner'
   AND "agentMissionId" IS NULL;
COMMIT;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726020000_agent_missions_validate/migration.sql"

# Même writer N-1 après la validation séparée : la preuve couvre ainsi l'état intermédiaire
# (expand appliqué, FK non validée) et l'état final exact du train.
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-n1-owner', true);
DO $$
DECLARE
  affected_rows INTEGER;
BEGIN
  UPDATE public.quote_draft_slots
     SET "revision" = 3
   WHERE "companyId" = 'writer-n1-company'
     AND "ownerUserId" = 'writer-n1-owner'
     AND "agentMissionId" IS NULL;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'AGENT_MISSION_WRITER_N1_FINAL_STATE_NOT_PROVEN';
  END IF;
END;
$$;
COMMIT;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726030000_release_flag_cabinet_subject_revocation_fence/migration.sql"

# La révocation d'un cabinet invalide la version parente et journalise chaque override dans la
# même transaction. Ce chemin ne doit jamais supprimer silencieusement un ciblage encore admis.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
INSERT INTO public.cabinets(id) VALUES ('agent-mission-cabinet-delete-cert');
INSERT INTO public.release_flag_subjects (
  id,
  "flagId",
  "subjectType",
  "subjectId",
  enabled,
  version,
  "updatedByUserId",
  "createdAt",
  "updatedAt"
) VALUES
  (
    'agent-mission-cabinet-delete-subject-development',
    'bob-agent-missions-quote-v1-development',
    'cabinet',
    'agent-mission-cabinet-delete-cert',
    TRUE,
    1,
    'system:cert',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'agent-mission-cabinet-delete-subject-production',
    'bob-agent-missions-quote-v1-production',
    'cabinet',
    'agent-mission-cabinet-delete-cert',
    FALSE,
    1,
    'system:cert',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );
DELETE FROM public.cabinets WHERE id = 'agent-mission-cabinet-delete-cert';
DO $cabinet_delete_certificate$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.release_flag_subjects
     WHERE id IN (
       'agent-mission-cabinet-delete-subject-development',
       'agent-mission-cabinet-delete-subject-production'
     )
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CABINET_DELETE_OVERRIDE_SURVIVED';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.release_flags
     WHERE id IN (
       'bob-agent-missions-quote-v1-development',
       'bob-agent-missions-quote-v1-production'
     )
       AND version <> 2
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CABINET_DELETE_FLAG_VERSION_DRIFT';
  END IF;
  IF (
    SELECT count(*)
      FROM public.release_flag_audit_events
     WHERE "flagId" IN (
       'bob-agent-missions-quote-v1-development',
       'bob-agent-missions-quote-v1-production'
     )
       AND operation = 'remove-subject'
       AND "beforeState" ->> 'subjectId' = 'agent-mission-cabinet-delete-cert'
       AND ("beforeState" ->> 'flagVersion')::INTEGER = 1
       AND ("afterState" ->> 'flagVersion')::INTEGER = 2
  ) <> 2 THEN
    RAISE EXCEPTION 'AGENT_MISSION_CABINET_DELETE_AUDIT_DRIFT';
  END IF;
END;
$cabinet_delete_certificate$;
RESET ROLE;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726040000_agent_mission_realtime_lease_expand/migration.sql"

# Writer admission N-1 exact après expand : les quatre colonnes ajoutées sont omises et restent
# NULL. La forme N+1 null/null est identique, tandis qu'un demi-binding doit déjà être rejeté.
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-n1-owner', true);

WITH authoritative_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS reserved_at
)
INSERT INTO public.realtime_session_leases (
  "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
  "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
  "hardExpiresAt", "activatedAt", "updatedAt", version
)
SELECT
  'writer-n1-company', repeat('1', 64), '10000000-0000-4000-8000-000000000001'::uuid,
  repeat('2', 64), 'reserved', NULL, NULL, NULL, reserved_at,
  reserved_at + interval '30 seconds', reserved_at + interval '60 seconds',
  NULL, reserved_at, 1
FROM authoritative_clock;

INSERT INTO public.realtime_session_leases (
  "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
  "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
  "hardExpiresAt", "activatedAt", "updatedAt", version,
  "agentMissionProtocolVersion", "agentMissionProtocolBoundAt",
  "agentMissionCapabilityHash", "agentMissionReleaseFlagVersion"
) VALUES (
  'writer-n1-company', repeat('3', 64), '10000000-0000-4000-8000-000000000002'::uuid,
  repeat('4', 64), 'reserved', NULL, NULL, NULL, clock_timestamp(),
  clock_timestamp() + interval '30 seconds', clock_timestamp() + interval '60 seconds',
  NULL, clock_timestamp(), 1, NULL, NULL, NULL, NULL
);

WITH authoritative_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS reserved_at
)
INSERT INTO public.realtime_session_leases (
  "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
  "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
  "hardExpiresAt", "activatedAt", "updatedAt", version,
  "agentMissionProtocolVersion", "agentMissionProtocolBoundAt",
  "agentMissionCapabilityHash", "agentMissionReleaseFlagVersion"
)
SELECT
  'writer-n1-company', repeat('5', 64), '10000000-0000-4000-8000-000000000003'::uuid,
  repeat('6', 64), 'reserved', NULL, NULL, NULL, reserved_at,
  reserved_at + interval '30 seconds', reserved_at + interval '60 seconds',
  NULL, reserved_at, 1, 1, reserved_at, repeat('a', 64), 1
FROM authoritative_clock;

DO $writer_n1_expand$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.realtime_session_leases
     WHERE "sessionId" IN (
       '10000000-0000-4000-8000-000000000001'::uuid,
       '10000000-0000-4000-8000-000000000002'::uuid
     )
       AND (
         "agentMissionProtocolVersion" IS NOT NULL
         OR "agentMissionProtocolBoundAt" IS NOT NULL
         OR "agentMissionCapabilityHash" IS NOT NULL
         OR "agentMissionReleaseFlagVersion" IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_WRITER_N1_EXPAND_NULL_SHAPE_DRIFT';
  END IF;

  BEGIN
    INSERT INTO public.realtime_session_leases (
      "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
      "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
      "hardExpiresAt", "activatedAt", "updatedAt", version,
      "agentMissionProtocolVersion", "agentMissionProtocolBoundAt",
      "agentMissionCapabilityHash", "agentMissionReleaseFlagVersion"
    ) VALUES (
      'writer-n1-company', repeat('7', 64), '10000000-0000-4000-8000-000000000004'::uuid,
      repeat('8', 64), 'reserved', NULL, NULL, NULL, clock_timestamp(),
      clock_timestamp() + interval '30 seconds', clock_timestamp() + interval '60 seconds',
      NULL, clock_timestamp(), 1, 1, NULL, repeat('b', 64), 1
    );
    RAISE EXCEPTION 'AGENT_MISSION_PARTIAL_BINDING_ACCEPTED_AFTER_EXPAND';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.realtime_session_leases
       SET "agentMissionProtocolVersion" = 1,
           "agentMissionProtocolBoundAt" = "reservedAt",
           "agentMissionCapabilityHash" = repeat('f', 64),
           "agentMissionReleaseFlagVersion" = 1
     WHERE "sessionId" = '10000000-0000-4000-8000-000000000001'::uuid;
    RAISE EXCEPTION 'AGENT_MISSION_NULL_LEASE_PROMOTED_AFTER_EXPAND';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.realtime_session_leases
       SET "agentMissionCapabilityHash" = repeat('0', 64),
           "agentMissionReleaseFlagVersion" = 2
     WHERE "sessionId" = '10000000-0000-4000-8000-000000000003'::uuid;
    RAISE EXCEPTION 'AGENT_MISSION_V1_BINDING_REWRITTEN_AFTER_EXPAND';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$writer_n1_expand$;
COMMIT;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726050000_agent_mission_realtime_lease_validate/migration.sql"

# Writer N-1 exact après validate et nouvelle preuve de fermeture des NULL partiels.
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-n1-owner', true);

WITH authoritative_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS reserved_at
)
INSERT INTO public.realtime_session_leases (
  "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
  "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
  "hardExpiresAt", "activatedAt", "updatedAt", version
)
SELECT
  'writer-n1-company', repeat('9', 64), '10000000-0000-4000-8000-000000000005'::uuid,
  repeat('c', 64), 'reserved', NULL, NULL, NULL, reserved_at,
  reserved_at + interval '30 seconds', reserved_at + interval '60 seconds',
  NULL, reserved_at, 1
FROM authoritative_clock;

DO $writer_n1_validate$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.realtime_session_leases
     WHERE "sessionId" = '10000000-0000-4000-8000-000000000005'::uuid
       AND (
         "agentMissionProtocolVersion" IS NOT NULL
         OR "agentMissionProtocolBoundAt" IS NOT NULL
         OR "agentMissionCapabilityHash" IS NOT NULL
         OR "agentMissionReleaseFlagVersion" IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_WRITER_N1_VALIDATE_NULL_SHAPE_DRIFT';
  END IF;

  BEGIN
    INSERT INTO public.realtime_session_leases (
      "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
      "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
      "hardExpiresAt", "activatedAt", "updatedAt", version,
      "agentMissionProtocolVersion", "agentMissionProtocolBoundAt",
      "agentMissionCapabilityHash", "agentMissionReleaseFlagVersion"
    ) VALUES (
      'writer-n1-company', repeat('d', 64), '10000000-0000-4000-8000-000000000006'::uuid,
      repeat('e', 64), 'reserved', NULL, NULL, NULL, clock_timestamp(),
      clock_timestamp() + interval '30 seconds', clock_timestamp() + interval '60 seconds',
      NULL, clock_timestamp(), 1, NULL, clock_timestamp(), NULL, NULL
    );
    RAISE EXCEPTION 'AGENT_MISSION_PARTIAL_BINDING_ACCEPTED_AFTER_VALIDATE';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.realtime_session_leases
       SET "agentMissionProtocolVersion" = 1,
           "agentMissionProtocolBoundAt" = "reservedAt",
           "agentMissionCapabilityHash" = repeat('f', 64),
           "agentMissionReleaseFlagVersion" = 1
     WHERE "sessionId" = '10000000-0000-4000-8000-000000000005'::uuid;
    RAISE EXCEPTION 'AGENT_MISSION_NULL_LEASE_PROMOTED_AFTER_VALIDATE';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.realtime_session_leases
       SET "agentMissionCapabilityHash" = repeat('0', 64),
           "agentMissionReleaseFlagVersion" = 2
     WHERE "sessionId" = '10000000-0000-4000-8000-000000000003'::uuid;
    RAISE EXCEPTION 'AGENT_MISSION_V1_BINDING_REWRITTEN_AFTER_VALIDATE';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$writer_n1_validate$;
COMMIT;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT USAGE ON SCHEMA public TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_draft_slots TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.realtime_session_leases TO bob_app;
GRANT SELECT ON TABLE public.release_flags, public.release_flag_subjects TO bob_app;

GRANT USAGE ON SCHEMA public TO bob_cert_auditor;
GRANT SELECT ON TABLE
  public.agent_missions,
  public.agent_mission_events,
  public.quote_draft_slots,
  public.realtime_session_leases,
  public.release_flags,
  public.release_flag_subjects,
  public.release_flag_audit_events
TO bob_cert_auditor;
GRANT SELECT, INSERT ON TABLE public.companies TO bob_cert_auditor;
GRANT SELECT ("companyId", "sessionId") ON TABLE public.realtime_session_leases
  TO bob_mistral_bootstrap_reaper;
RESET ROLE;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-missions-runtime-grants.sql"
"$PSQL_BIN" "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-rls-replay.sql"
"$PSQL_BIN" "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-release-flag-authority-provision.sql"
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-missions-release-cert.sql"
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -v release_env=staging \
  -v release_flag_version=1 \
  -v release_flag_kill_switch=false \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-release-cert.sql"
# AGENT_MISSION_CERT_NON_INITIAL_VERSION : une certification rejouable doit suivre la version
# autoritaire courante, y compris quand un incident maintient volontairement le kill switch armé.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
UPDATE public.release_flags
   SET version = version + 1,
       "killSwitch" = TRUE,
       "updatedByUserId" = 'system:local-cert',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE key = 'bob.agent_missions.quote.v1'
   AND environment = 'staging'::public."ReleaseEnvironment";
RESET ROLE;
SQL
agent_mission_release_flag_snapshot="$(
  "$PSQL_BIN" "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_catalog.format(
         '%s|%s',
         flag.version,
         CASE WHEN flag."killSwitch" THEN 'true' ELSE 'false' END
       )
  FROM public.release_flags AS flag
 WHERE flag.key = 'bob.agent_missions.quote.v1'
   AND flag.environment = 'staging'::public."ReleaseEnvironment";
SQL
)"
agent_mission_release_flag_version="${agent_mission_release_flag_snapshot%%|*}"
agent_mission_release_flag_kill_switch="${agent_mission_release_flag_snapshot#*|}"
case "$agent_mission_release_flag_version" in
  ''|*[!0-9]*|0)
    echo "AgentMission staging release flag version is missing or invalid" >&2
    exit 1
    ;;
esac
case "$agent_mission_release_flag_kill_switch" in
  true|false) ;;
  *)
    echo "AgentMission staging release flag kill switch is missing or invalid" >&2
    exit 1
    ;;
esac
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -v release_env=staging \
  -v release_flag_version="$agent_mission_release_flag_version" \
  -v release_flag_kill_switch="$agent_mission_release_flag_kill_switch" \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-release-cert.sql"

cd "$ROOT_DIR"
# Vitest API consomme l'export package réel de @bob/core. Le construire ici rend la preuve
# reproductible depuis un checkout propre et interdit qu'un dist local périmé masque le source
# certifié (incident UUID système v5/v8 du 26/07/2026).
pnpm --filter @bob/core build
pnpm --filter @bob/api generate

DATABASE_URL="$DATABASE_URL" \
DIRECT_URL="$DIRECT_URL" \
AGENT_MISSION_CERT_ADMIN_URL="$CERT_ADMIN_URL" \
RUN_AGENT_MISSION_POSTGRES_CERT=true \
AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE=true \
pnpm --filter @bob/api exec vitest run \
  src/persistence/prisma/agent-mission.persistence.postgres.test.ts
