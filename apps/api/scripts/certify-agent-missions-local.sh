#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
PG_BIN_DIR="${PG_BIN_DIR:-}"
EXTERNAL_SUPER_URL="${AGENT_MISSION_CERT_SUPER_URL:-}"
CERT_ROOT=""
DATA_DIR=""
LOCAL_CLUSTER_STARTED=false
CONCURRENCY_LOG=""
CONCURRENCY_MANAGER_LOG=""
concurrent_writer_pid=""
concurrent_manager_pid=""

cleanup() {
  cleanup_status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$concurrent_manager_pid" ] \
    && kill -0 "$concurrent_manager_pid" 2>/dev/null; then
    kill "$concurrent_manager_pid" 2>/dev/null || true
  fi
  if [ -n "$concurrent_writer_pid" ] \
    && kill -0 "$concurrent_writer_pid" 2>/dev/null; then
    kill "$concurrent_writer_pid" 2>/dev/null || true
  fi
  if [ -n "$concurrent_manager_pid" ]; then
    wait "$concurrent_manager_pid" 2>/dev/null || true
  fi
  if [ -n "$concurrent_writer_pid" ]; then
    wait "$concurrent_writer_pid" 2>/dev/null || true
  fi
  if [ "$LOCAL_CLUSTER_STARTED" = "true" ]; then
    "$PG_BIN_DIR/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [ -n "$CERT_ROOT" ]; then
    rm -rf "$CERT_ROOT"
  fi
  if [ -n "$CONCURRENCY_LOG" ]; then
    rm -f "$CONCURRENCY_LOG"
  fi
  if [ -n "$CONCURRENCY_MANAGER_LOG" ]; then
    rm -f "$CONCURRENCY_MANAGER_LOG"
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
"$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-fingerprint-readiness-authority-role.sql"

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

# Le manager de rotation doit lire l'autorité globale exactement comme en release. Le rôle est
# créé par le déployeur non-superuser via createrole_self_grant=set, puis les objets lui sont
# transférés avant toute preuve closed|0.
PATH="$(dirname "$PSQL_BIN"):$PATH" \
DIRECT_URL="$DIRECT_URL" \
APP_DATABASE_ROLE=bob_app \
sh "$ROOT_DIR/apps/api/scripts/realtime-capacity-release.sh" provision

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

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726060000_realtime_admission_cancellation_fence_expand/migration.sql"

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT SELECT, INSERT, DELETE
  ON TABLE public.realtime_admission_cancellation_fences TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.realtime_reaper_tenant_schedule TO bob_app;
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.realtime_admission_cancellation_fences FROM bob_app;
RESET ROLE;
SQL

# Writer admission N-1 exact sous le trigger final de l'expand : sans fence il écrit ; avec un
# fence vivant il échoue avant lease, capacité et événement.
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
  'writer-n1-company', repeat('0', 64), '10000000-0000-4000-8000-000000000007'::uuid,
  repeat('1', 64), 'reserved', NULL, NULL, NULL, reserved_at,
  reserved_at + interval '30 seconds', reserved_at + interval '60 seconds',
  NULL, reserved_at, 1
FROM authoritative_clock;

WITH authoritative_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS cancelled_at
)
INSERT INTO public.realtime_admission_cancellation_fences (
  "companyId", "sessionId", "subjectHash", "cancelledAt", "expiresAt"
)
SELECT
  'writer-n1-company', '10000000-0000-4000-8000-000000000008'::uuid,
  repeat('b', 64), cancelled_at, cancelled_at + interval '2 hours'
FROM authoritative_clock;

DO $writer_n1_cancellation_expand$
BEGIN
  BEGIN
    INSERT INTO public.realtime_session_leases (
      "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
      "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
      "hardExpiresAt", "activatedAt", "updatedAt", version
    ) VALUES (
      'writer-n1-company', repeat('b', 64),
      '10000000-0000-4000-8000-000000000008'::uuid,
      repeat('2', 64), 'reserved', NULL, NULL, NULL, clock_timestamp(),
      clock_timestamp() + interval '30 seconds', clock_timestamp() + interval '60 seconds',
      NULL, clock_timestamp(), 1
    );
    RAISE EXCEPTION 'REALTIME_CANCELLATION_WRITER_N1_ACCEPTED_AFTER_EXPAND';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN NULL;
  END;
  IF EXISTS (
    SELECT 1
      FROM public.realtime_session_leases
     WHERE "sessionId" = '10000000-0000-4000-8000-000000000008'::uuid
  ) THEN
    RAISE EXCEPTION 'REALTIME_CANCELLATION_LEASE_SURVIVED_AFTER_EXPAND';
  END IF;
END;
$writer_n1_cancellation_expand$;
COMMIT;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726070000_realtime_admission_cancellation_fence_validate/migration.sql"

# Même preuve après VALIDATE : la migration intermédiaire et l'état final acceptent N-1 seulement
# quand le handle n'a jamais été annulé.
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
  'writer-n1-company', repeat('c', 64), '10000000-0000-4000-8000-000000000009'::uuid,
  repeat('3', 64), 'reserved', NULL, NULL, NULL, reserved_at,
  reserved_at + interval '30 seconds', reserved_at + interval '60 seconds',
  NULL, reserved_at, 1
FROM authoritative_clock;

WITH authoritative_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS cancelled_at
)
INSERT INTO public.realtime_admission_cancellation_fences (
  "companyId", "sessionId", "subjectHash", "cancelledAt", "expiresAt"
)
SELECT
  'writer-n1-company', '10000000-0000-4000-8000-000000000010'::uuid,
  repeat('e', 64), cancelled_at, cancelled_at + interval '2 hours'
FROM authoritative_clock;

DO $writer_n1_cancellation_validate$
BEGIN
  BEGIN
    INSERT INTO public.realtime_session_leases (
      "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
      "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
      "hardExpiresAt", "activatedAt", "updatedAt", version
    ) VALUES (
      'writer-n1-company', repeat('e', 64),
      '10000000-0000-4000-8000-000000000010'::uuid,
      repeat('4', 64), 'reserved', NULL, NULL, NULL, clock_timestamp(),
      clock_timestamp() + interval '30 seconds', clock_timestamp() + interval '60 seconds',
      NULL, clock_timestamp(), 1
    );
    RAISE EXCEPTION 'REALTIME_CANCELLATION_WRITER_N1_ACCEPTED_AFTER_VALIDATE';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN NULL;
  END;
  IF EXISTS (
    SELECT 1
      FROM public.realtime_session_leases
     WHERE "sessionId" = '10000000-0000-4000-8000-000000000010'::uuid
  ) THEN
    RAISE EXCEPTION 'REALTIME_CANCELLATION_LEASE_SURVIVED_AFTER_VALIDATE';
  END IF;
END;
$writer_n1_cancellation_validate$;
COMMIT;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726080000_agent_mission_event_command_namespace_expand/migration.sql"

# Les writers d'événement sont testés sur la vraie table, sous FORCE RLS et avec le rôle runtime
# non-superuser. La forme N-1 garde un commandId v8 pour screen_acknowledged ; la forme N utilise
# le commandId HTTP v4. Chaque invocation crée une mission et son brouillon réels, puis produit
# l'ACK dans la même transaction que la révision mission.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_missions TO bob_app;
GRANT SELECT, INSERT ON TABLE public.agent_mission_events TO bob_app;
RESET ROLE;
SQL

certify_agent_mission_event_writer() {
  writer_owner_user_id="$1"
  writer_mission_id="$2"
  writer_start_event_id="$3"
  writer_start_command_id="$4"
  writer_ack_event_id="$5"
  writer_ack_command_id="$6"
  writer_realtime_session_id="$7"
  writer_fingerprint_key_version="${8:-1}"
  writer_barrier_name="${9:-}"
  writer_application_name="${10:-bob-agent-mission-cert-writer}"

  case "$writer_fingerprint_key_version" in
    ''|*[!0-9]*|0)
      echo "AgentMission writer fingerprint key version is invalid" >&2
      exit 1
      ;;
  esac
  case "$writer_barrier_name" in
    *[!a-z0-9-]*)
      echo "AgentMission writer barrier name is invalid" >&2
      exit 1
      ;;
  esac

  PGAPPNAME="$writer_application_name" \
  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v owner_user_id="$writer_owner_user_id" \
    -v mission_id="$writer_mission_id" \
    -v start_event_id="$writer_start_event_id" \
    -v start_command_id="$writer_start_command_id" \
    -v ack_event_id="$writer_ack_event_id" \
    -v ack_command_id="$writer_ack_command_id" \
    -v realtime_session_id="$writer_realtime_session_id" \
    -v fingerprint_key_version="$writer_fingerprint_key_version" \
    -v writer_barrier_name="$writer_barrier_name" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', :'owner_user_id', true);
SELECT set_config('app.current_agent_mission_id', :'mission_id', true);
SELECT set_config('bob.cert.agent_mission_started_at', clock_timestamp()::TEXT, true);

INSERT INTO public.agent_missions (
  "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
  "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
  "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
) VALUES (
  :'mission_id'::UUID,
  'writer-n1-company',
  :'owner_user_id',
  'quote_creation',
  'active',
  'awaiting_quote_screen',
  1,
  1,
  jsonb_build_object(
    'schema', 'bob.agent-mission.quote-creation',
    'version', 1,
    'draft', jsonb_build_object(
      'sessionId', :'owner_user_id',
      'slotRevision', 1,
      'contentRevision', 0
    ),
    'decision', 'null'::JSONB
  ),
  NULL,
  current_setting('bob.cert.agent_mission_started_at')::TIMESTAMPTZ + INTERVAL '24 hours',
  current_setting('bob.cert.agent_mission_started_at')::TIMESTAMPTZ + INTERVAL '168 hours',
  NULL,
  current_setting('bob.cert.agent_mission_started_at')::TIMESTAMPTZ + INTERVAL '2328 hours',
  current_setting('bob.cert.agent_mission_started_at')::TIMESTAMPTZ,
  current_setting('bob.cert.agent_mission_started_at')::TIMESTAMPTZ
);

INSERT INTO public.quote_draft_slots (
  "companyId", "ownerUserId", "revision", "payloadVersion", "payload", "agentMissionId"
) VALUES (
  'writer-n1-company',
  :'owner_user_id',
  1,
  1,
  jsonb_build_object(
    'schema', 'bob.quote-draft',
    'version', 1,
    'draft', jsonb_build_object(
      'sessionId', :'owner_user_id',
      'contentRevision', 0,
      'stagingRevision', 0,
      'step', 'client',
      'customer', 'null'::JSONB,
      'lines', '[]'::JSONB,
      'lineMetadata', '[]'::JSONB,
      'lineForm', jsonb_build_object(
        'label', '',
        'quantity', '1',
        'unitPrice', '',
        'category', 'labor'
      ),
      'vatDecision', 'null'::JSONB,
      'depositPct', 30,
      'signMode', 'null'::JSONB
    )
  ),
  :'mission_id'::UUID
);

INSERT INTO public.agent_mission_events (
  "id", "companyId", "ownerUserId", "missionId", "sequence", "eventType",
  "eventVersion", "actor", "commandId", "requestFingerprintHmac",
  "fingerprintKeyVersion", "fingerprintCanonicalizationVersion",
  "missionRevisionBefore", "missionRevisionAfter", "draftSlotRevisionBefore",
  "draftSlotRevisionAfter", "draftContentRevisionBefore", "draftContentRevisionAfter",
  "realtimeSessionId", "turnId", "contextRevision", "contextDigest", "data",
  "occurredAt", "retentionExpiresAt"
) VALUES (
  :'start_event_id'::UUID,
  'writer-n1-company',
  :'owner_user_id',
  :'mission_id'::UUID,
  1,
  'mission_started',
  1,
  'user_tap',
  :'start_command_id'::UUID,
  repeat('1', 64),
  :'fingerprint_key_version'::INTEGER,
  1,
  0,
  1,
  NULL,
  1,
  NULL,
  0,
  NULL,
  NULL,
  NULL,
  NULL,
  '{"kind":"mission_started","startOutcome":"no_slot"}'::JSONB,
  current_setting('bob.cert.agent_mission_started_at')::TIMESTAMPTZ,
  current_setting('bob.cert.agent_mission_started_at')::TIMESTAMPTZ + INTERVAL '2160 hours'
);
SELECT set_config(
  'bob.cert.agent_mission_writer_barrier_name',
  :'writer_barrier_name',
  true
);
DO $agent_mission_cert_writer_barrier$
DECLARE
  barrier_name TEXT :=
    current_setting('bob.cert.agent_mission_writer_barrier_name');
  barrier_released BOOLEAN;
BEGIN
  IF barrier_name = '' THEN
    RETURN;
  END IF;
  LOOP
    EXECUTE
      'SELECT barrier.released FROM public.agent_mission_cert_rotation_barriers AS barrier WHERE barrier.name = $1'
      INTO barrier_released
      USING barrier_name;
    IF barrier_released IS NULL THEN
      RAISE EXCEPTION 'AGENT_MISSION_CERT_WRITER_BARRIER_MISSING';
    END IF;
    EXIT WHEN barrier_released;
    PERFORM pg_catalog.pg_sleep(0.05);
  END LOOP;
END;
$agent_mission_cert_writer_barrier$;
COMMIT;

BEGIN;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', :'owner_user_id', true);
SELECT set_config('app.current_agent_mission_id', :'mission_id', true);
SELECT set_config('bob.cert.agent_mission_id', :'mission_id', true);
SELECT set_config('bob.cert.agent_mission_ack_command_id', :'ack_command_id', true);
SELECT set_config('bob.cert.agent_mission_acknowledged_at', clock_timestamp()::TEXT, true);

UPDATE public.agent_missions
   SET "phase" = 'awaiting_customer',
       "revision" = 2,
       "currentBinding" = jsonb_build_object(
         'realtimeSessionId', :'realtime_session_id',
         'contextRevision', 1,
         'contextDigest', repeat('a', 64),
         'screenName', '/devis/new',
         'screenInstanceId', :'owner_user_id',
         'acknowledgedAt', to_char(
           timezone(
             'UTC',
             current_setting('bob.cert.agent_mission_acknowledged_at')::TIMESTAMPTZ
           ),
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
       ),
       "updatedAt" =
         current_setting('bob.cert.agent_mission_acknowledged_at')::TIMESTAMPTZ,
       "idleExpiresAt" = LEAST(
         current_setting('bob.cert.agent_mission_acknowledged_at')::TIMESTAMPTZ
           + INTERVAL '24 hours',
         "hardExpiresAt"
       )
 WHERE "id" = :'mission_id'::UUID;

INSERT INTO public.agent_mission_events (
  "id", "companyId", "ownerUserId", "missionId", "sequence", "eventType",
  "eventVersion", "actor", "commandId", "requestFingerprintHmac",
  "fingerprintKeyVersion", "fingerprintCanonicalizationVersion",
  "missionRevisionBefore", "missionRevisionAfter", "draftSlotRevisionBefore",
  "draftSlotRevisionAfter", "draftContentRevisionBefore", "draftContentRevisionAfter",
  "realtimeSessionId", "turnId", "contextRevision", "contextDigest", "data",
  "occurredAt", "retentionExpiresAt"
) VALUES (
  :'ack_event_id'::UUID,
  'writer-n1-company',
  :'owner_user_id',
  :'mission_id'::UUID,
  2,
  'screen_acknowledged',
  1,
  'system',
  :'ack_command_id'::UUID,
  repeat('2', 64),
  :'fingerprint_key_version'::INTEGER,
  1,
  1,
  2,
  1,
  1,
  0,
  0,
  :'realtime_session_id'::UUID,
  NULL,
  1,
  repeat('a', 64),
  '{"kind":"screen_acknowledged","nextPhase":"awaiting_customer"}'::JSONB,
  current_setting('bob.cert.agent_mission_acknowledged_at')::TIMESTAMPTZ,
  current_setting('bob.cert.agent_mission_acknowledged_at')::TIMESTAMPTZ
    + INTERVAL '2160 hours'
);

DO $writer_event_certificate$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.agent_missions AS mission
      JOIN public.agent_mission_events AS event
        ON event."missionId" = mission."id"
       AND event."companyId" = mission."companyId"
       AND event."ownerUserId" = mission."ownerUserId"
     WHERE mission."id" = current_setting('bob.cert.agent_mission_id')::UUID
       AND mission."revision" = 2
       AND mission."phase" = 'awaiting_customer'
       AND event."sequence" = 2
       AND event."eventType" = 'screen_acknowledged'
       AND event."commandId" =
         current_setting('bob.cert.agent_mission_ack_command_id')::UUID
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_WRITER_NOT_PROVEN';
  END IF;
END;
$writer_event_certificate$;
COMMIT;
SQL
}

certify_agent_mission_fingerprint_floor() {
  expected_minimum_writer_version="$1"
  expected_highest_writer_version="$2"
  expected_writer_enabled="$3"
  expected_bound_version_count="${4:-2}"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v expected_minimum="$expected_minimum_writer_version" \
    -v expected_highest="$expected_highest_writer_version" \
    -v expected_enabled="$expected_writer_enabled" \
    -v expected_bound_count="$expected_bound_version_count" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '3s';
SELECT set_config('bob.cert.expected_fingerprint_minimum', :'expected_minimum', true);
SELECT set_config('bob.cert.expected_fingerprint_highest', :'expected_highest', true);
SELECT set_config('bob.cert.expected_fingerprint_enabled', :'expected_enabled', true);
SELECT set_config(
  'bob.cert.expected_fingerprint_bound_count',
  :'expected_bound_count',
  true
);
DO $agent_mission_fingerprint_floor_runtime_certificate$
DECLARE
  row_count INTEGER;
BEGIN
  SELECT count(*)
    INTO row_count
    FROM public.agent_mission_fingerprint_key_readiness(ARRAY[1, 2]) AS readiness
   WHERE readiness."minimumWriterVersion" =
           current_setting('bob.cert.expected_fingerprint_minimum')::INTEGER
     AND readiness."highestWriterVersion" =
           current_setting('bob.cert.expected_fingerprint_highest')::INTEGER
     AND readiness."writerEnabled" =
           current_setting('bob.cert.expected_fingerprint_enabled')::BOOLEAN
     AND readiness."keyFingerprint" ~ '^[a-f0-9]{64}$';
  IF row_count <>
       current_setting('bob.cert.expected_fingerprint_bound_count')::INTEGER THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_RUNTIME_FLOOR_MISMATCH';
  END IF;
END;
$agent_mission_fingerprint_floor_runtime_certificate$;
ROLLBACK;
SQL
}

certify_agent_mission_fingerprint_writer_rejected() {
  rejected_fingerprint_key_version="$1"
  expected_sqlstate="$2"
  expected_constraint="$3"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v fingerprint_key_version="$rejected_fingerprint_key_version" \
    -v expected_sqlstate="$expected_sqlstate" \
    -v expected_constraint="$expected_constraint" <<'SQL'
BEGIN;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config(
  'app.current_user_id',
  'writer-n1-fingerprint-readiness',
  true
);
SELECT set_config(
  'bob.cert.expected_sqlstate',
  :'expected_sqlstate',
  true
);
SELECT set_config(
  'bob.cert.expected_constraint',
  :'expected_constraint',
  true
);
SELECT set_config(
  'bob.cert.rejected_fingerprint_key_version',
  :'fingerprint_key_version',
  true
);
DO $agent_mission_fingerprint_writer_rejection_certificate$
DECLARE
  observed_constraint TEXT;
  observed_sqlstate TEXT;
BEGIN
  BEGIN
    INSERT INTO public.agent_mission_events (
      "id", "companyId", "ownerUserId", "missionId", "sequence", "eventType",
      "eventVersion", "actor", "commandId", "requestFingerprintHmac",
      "fingerprintKeyVersion", "fingerprintCanonicalizationVersion",
      "missionRevisionBefore", "missionRevisionAfter", "draftSlotRevisionBefore",
      "draftSlotRevisionAfter", "draftContentRevisionBefore",
      "draftContentRevisionAfter", "realtimeSessionId", "turnId",
      "contextRevision", "contextDigest", "data", "occurredAt",
      "retentionExpiresAt"
    ) VALUES (
      '71000000-0000-4000-8000-000000000001'::UUID,
      'writer-n1-company',
      'writer-n1-fingerprint-readiness',
      '60000000-0000-4000-8000-000000000001'::UUID,
      3,
      'screen_acknowledged',
      1,
      'system',
      '71000000-0000-4000-8000-000000000002'::UUID,
      repeat('7', 64),
      current_setting(
        'bob.cert.rejected_fingerprint_key_version'
      )::INTEGER,
      1,
      2,
      3,
      1,
      1,
      0,
      0,
      '71000000-0000-4000-8000-000000000003'::UUID,
      NULL,
      1,
      repeat('7', 64),
      '{"kind":"screen_acknowledged","nextPhase":"awaiting_customer"}'::JSONB,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + INTERVAL '2160 hours'
    );
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_WRITER_UNEXPECTEDLY_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      observed_sqlstate = RETURNED_SQLSTATE,
      observed_constraint = CONSTRAINT_NAME;
    IF observed_sqlstate IS DISTINCT FROM current_setting('bob.cert.expected_sqlstate')
       OR observed_constraint IS DISTINCT FROM
         current_setting('bob.cert.expected_constraint') THEN
      RAISE EXCEPTION
        'AGENT_MISSION_FINGERPRINT_WRITER_REJECTION_MISMATCH:%:%',
        observed_sqlstate,
        observed_constraint;
    END IF;
  END;
END;
$agent_mission_fingerprint_writer_rejection_certificate$;
ROLLBACK;
SQL
}

wait_for_agent_mission_writer_pause() {
  writer_application_name="$1"
  writer_process_id="$2"
  wait_attempt=0
  while [ "$wait_attempt" -lt 200 ]; do
    writer_shared_lock_count="$(
      "$PSQL_BIN" "$SUPER_URL" -X -qAt -v ON_ERROR_STOP=1 \
        -v writer_application_name="$writer_application_name" <<'SQL'
SELECT count(*)
  FROM pg_catalog.pg_stat_activity AS activity
  JOIN pg_catalog.pg_locks AS lock
    ON lock.pid = activity.pid
 WHERE activity.application_name = :'writer_application_name'
   AND lock.locktype = 'advisory'
   AND lock.mode = 'ShareLock'
   AND lock.granted;
SQL
    )"
    if [ "$writer_shared_lock_count" = "1" ]; then
      return 0
    fi
    if ! kill -0 "$writer_process_id" 2>/dev/null; then
      wait "$writer_process_id" || true
      if [ -n "$CONCURRENCY_LOG" ] && [ -f "$CONCURRENCY_LOG" ]; then
        cat "$CONCURRENCY_LOG" >&2
      fi
      echo "AgentMission concurrent writer ended before holding its shared lock" >&2
      return 1
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep 0.05
  done
  echo "AgentMission concurrent writer shared-lock observation timed out" >&2
  return 1
}

wait_for_agent_mission_manager_exclusive_lock() {
  writer_application_name="$1"
  manager_process_id="$2"
  wait_attempt=0
  while [ "$wait_attempt" -lt 200 ]; do
    manager_waiting_lock_count="$(
      "$PSQL_BIN" "$SUPER_URL" -X -qAt -v ON_ERROR_STOP=1 \
        -v writer_application_name="$writer_application_name" <<'SQL'
SELECT count(*)
  FROM pg_catalog.pg_locks AS waiting
 WHERE waiting.locktype = 'advisory'
   AND waiting.mode = 'ExclusiveLock'
   AND NOT waiting.granted
   AND EXISTS (
     SELECT 1
       FROM pg_catalog.pg_locks AS held
       JOIN pg_catalog.pg_stat_activity AS activity
         ON activity.pid = held.pid
      WHERE activity.application_name = :'writer_application_name'
        AND held.locktype = waiting.locktype
        AND held.database = waiting.database
        AND held.classid = waiting.classid
        AND held.objid = waiting.objid
        AND held.objsubid = waiting.objsubid
        AND held.mode = 'ShareLock'
        AND held.granted
   );
SQL
    )"
    if [ "$manager_waiting_lock_count" = "1" ]; then
      return 0
    fi
    if ! kill -0 "$manager_process_id" 2>/dev/null; then
      wait "$manager_process_id" || true
      if [ -n "$CONCURRENCY_MANAGER_LOG" ] \
        && [ -f "$CONCURRENCY_MANAGER_LOG" ]; then
        cat "$CONCURRENCY_MANAGER_LOG" >&2
      fi
      echo "AgentMission fingerprint manager ended before waiting on the writer lock" >&2
      return 1
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep 0.05
  done
  echo "AgentMission fingerprint manager exclusive-lock observation timed out" >&2
  return 1
}

release_agent_mission_writer_barrier() {
  writer_barrier_name="$1"
  released_count="$(
    "$PSQL_BIN" "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
      -v writer_barrier_name="$writer_barrier_name" <<'SQL'
SET ROLE bob_schema_owner;
WITH released AS (
  UPDATE public.agent_mission_cert_rotation_barriers
     SET released = TRUE
   WHERE name = :'writer_barrier_name'
     AND NOT released
  RETURNING 1
)
SELECT count(*) FROM released;
RESET ROLE;
SQL
  )"
  if [ "$released_count" != "1" ]; then
    echo "AgentMission writer barrier was missing or already released" >&2
    return 1
  fi
}

# État intermédiaire : l'ancien writer v8 doit rester accepté quand les deux contraintes sont
# présentes, même avant VALIDATE.
certify_agent_mission_event_writer \
  writer-n1-event-expand \
  20000000-0000-4000-8000-000000000001 \
  20000000-0000-4000-8000-000000000002 \
  20000000-0000-4000-8000-000000000003 \
  20000000-0000-4000-8000-000000000004 \
  20000000-0000-8000-8000-000000000005 \
  20000000-0000-4000-8000-000000000006

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726090000_agent_mission_event_command_namespace_validate/migration.sql"

# État validé mais non cutover : la compatibilité du writer v8 reste obligatoire.
certify_agent_mission_event_writer \
  writer-n1-event-validate \
  30000000-0000-4000-8000-000000000001 \
  30000000-0000-4000-8000-000000000002 \
  30000000-0000-4000-8000-000000000003 \
  30000000-0000-4000-8000-000000000004 \
  30000000-0000-8000-8000-000000000005 \
  30000000-0000-4000-8000-000000000006

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726100000_agent_mission_event_command_namespace_cutover/migration.sql"

# État final : N-1 v8 reste accepté pendant le rolling deploy et N peut enfin persister le
# commandId HTTP v4 sans mensonge de namespace.
certify_agent_mission_event_writer \
  writer-n1-event-cutover \
  40000000-0000-4000-8000-000000000001 \
  40000000-0000-4000-8000-000000000002 \
  40000000-0000-4000-8000-000000000003 \
  40000000-0000-4000-8000-000000000004 \
  40000000-0000-8000-8000-000000000005 \
  40000000-0000-4000-8000-000000000006
certify_agent_mission_event_writer \
  writer-n-event-cutover \
  50000000-0000-4000-8000-000000000001 \
  50000000-0000-4000-8000-000000000002 \
  50000000-0000-4000-8000-000000000003 \
  50000000-0000-4000-8000-000000000004 \
  50000000-0000-4000-8000-000000000005 \
  50000000-0000-4000-8000-000000000006

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726110000_agent_mission_fingerprint_key_readiness/migration.sql"

# Même une migration fonctionnelle additive est éprouvée avec la forme exacte du writer N-1.
certify_agent_mission_event_writer \
  writer-n1-fingerprint-readiness \
  60000000-0000-4000-8000-000000000001 \
  60000000-0000-4000-8000-000000000002 \
  60000000-0000-4000-8000-000000000003 \
  60000000-0000-4000-8000-000000000004 \
  60000000-0000-8000-8000-000000000005 \
  60000000-0000-4000-8000-000000000006

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726120000_agent_mission_bootstrap_receipt_expand/migration.sql"

# Writer admission N-1 exact sous le trigger receipt final de l'expand : la nouvelle colonne est
# omise, reste NULL et ne confère donc aucune autorité. Le writer N prouve en plus que le reçu est
# écrit par l'horloge DB une seule fois et ne peut ni être prérempli, ni effacé.
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
  'writer-n1-company', repeat('1', 63) || 'a',
  '70000000-0000-4000-8000-000000000001'::uuid,
  repeat('2', 63) || 'a', 'reserved', NULL, NULL, NULL, reserved_at,
  reserved_at + interval '30 seconds', reserved_at + interval '60 seconds',
  NULL, reserved_at, 1
FROM authoritative_clock;

DO $writer_n1_bootstrap_receipt_expand$
DECLARE
  protocol_bound_at TIMESTAMPTZ;
  acknowledged_at TIMESTAMPTZ;
BEGIN
  IF (
    SELECT "agentMissionBootstrapAcknowledgedAt"
      FROM public.realtime_session_leases
     WHERE "sessionId" = '70000000-0000-4000-8000-000000000001'::uuid
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_WRITER_N1_EXPAND_RECEIPT_DRIFT';
  END IF;

  BEGIN
    INSERT INTO public.realtime_session_leases (
      "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
      "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
      "hardExpiresAt", "activatedAt", "updatedAt", version,
      "agentMissionProtocolVersion", "agentMissionProtocolBoundAt",
      "agentMissionCapabilityHash", "agentMissionReleaseFlagVersion",
      "agentMissionBootstrapAcknowledgedAt"
    ) VALUES (
      'writer-n1-company', repeat('3', 63) || 'a',
      '70000000-0000-4000-8000-000000000002'::uuid,
      repeat('4', 63) || 'a', 'reserved', NULL, NULL, NULL, clock_timestamp(),
      clock_timestamp() + interval '30 seconds', clock_timestamp() + interval '60 seconds',
      NULL, clock_timestamp(), 1, 1, clock_timestamp(), repeat('a', 64), 1,
      clock_timestamp()
    );
    RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_RECEIPT_INSERT_ACCEPTED_AFTER_EXPAND';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

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
    'writer-n1-company', repeat('5', 63) || 'a',
    '70000000-0000-4000-8000-000000000003'::uuid,
    repeat('6', 63) || 'a', 'active', 'openai', 'receipt-expand-call', NULL, reserved_at,
    reserved_at + interval '30 seconds', reserved_at + interval '60 seconds',
    reserved_at, reserved_at, 1, 1, reserved_at, repeat('b', 64), 1
  FROM authoritative_clock;

  SELECT "agentMissionProtocolBoundAt"
    INTO STRICT protocol_bound_at
    FROM public.realtime_session_leases
   WHERE "sessionId" = '70000000-0000-4000-8000-000000000003'::uuid;

  UPDATE public.realtime_session_leases
     SET "agentMissionBootstrapAcknowledgedAt" = protocol_bound_at - interval '1 day'
   WHERE "sessionId" = '70000000-0000-4000-8000-000000000003'::uuid
  RETURNING "agentMissionBootstrapAcknowledgedAt"
       INTO STRICT acknowledged_at;

  IF acknowledged_at IS NULL OR acknowledged_at < protocol_bound_at THEN
    RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_RECEIPT_DB_CLOCK_NOT_PROVEN';
  END IF;

  BEGIN
    UPDATE public.realtime_session_leases
       SET "agentMissionBootstrapAcknowledgedAt" = NULL
     WHERE "sessionId" = '70000000-0000-4000-8000-000000000003'::uuid;
    RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_RECEIPT_ERASE_ACCEPTED_AFTER_EXPAND';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$writer_n1_bootstrap_receipt_expand$;
COMMIT;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260726130000_agent_mission_bootstrap_receipt_validate/migration.sql"

# Writer N-1 exact après VALIDATE : même forme historique, même NULL honnête, sous l'état final.
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
  'writer-n1-company', repeat('7', 63) || 'a',
  '70000000-0000-4000-8000-000000000004'::uuid,
  repeat('8', 63) || 'a', 'reserved', NULL, NULL, NULL, reserved_at,
  reserved_at + interval '30 seconds', reserved_at + interval '60 seconds',
  NULL, reserved_at, 1
FROM authoritative_clock;

DO $writer_n1_bootstrap_receipt_validate$
BEGIN
  IF (
    SELECT "agentMissionBootstrapAcknowledgedAt"
      FROM public.realtime_session_leases
     WHERE "sessionId" = '70000000-0000-4000-8000-000000000004'::uuid
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_WRITER_N1_VALIDATE_RECEIPT_DRIFT';
  END IF;
END;
$writer_n1_bootstrap_receipt_validate$;
COMMIT;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-fingerprint-readiness-authority-provision.sql"

# Rejeu réel : un ancien ACL colonne survit à REVOKE table et un grantee arbitraire survit à une
# simple révocation des rôles connus. On empoisonne les deux surfaces ; le provisionneur doit
# restaurer les allowlists exactes sous chaque owner.
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE bob_agent_mission_writer_guard_rogue
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SQL
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
GRANT UPDATE ("minimumWriterVersion")
  ON TABLE public.agent_mission_fingerprint_key_version_floors
  TO bob_agent_mission_fingerprint_readiness;
GRANT INSERT ("keyFingerprint")
  ON TABLE public.agent_mission_fingerprint_key_bindings
  TO bob_agent_mission_fingerprint_readiness;
SET ROLE bob_agent_mission_fingerprint_readiness;
GRANT EXECUTE
  ON FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  TO bob_agent_mission_writer_guard_rogue;
RESET ROLE;
SQL
"$PSQL_BIN" "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-fingerprint-readiness-authority-provision.sql"
writer_guard_rogue_execute="$(
  "$PSQL_BIN" "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_catalog.has_function_privilege(
  (
    SELECT role.oid
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = 'bob_agent_mission_writer_guard_rogue'
  ),
  (
    SELECT function.oid
      FROM pg_catalog.pg_proc AS function
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = function.pronamespace
     WHERE namespace.nspname = 'public'
       AND function.proname =
         'guard_agent_mission_fingerprint_key_binding_present_v1'
       AND function.pronargs = 0
  ),
  'EXECUTE'
);
SQL
)"
if [ "$writer_guard_rogue_execute" != "f" ]; then
  echo "AgentMission writer guard retained an arbitrary EXECUTE grantee" >&2
  exit 1
fi
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 \
  -c 'DROP ROLE bob_agent_mission_writer_guard_rogue'

# Le manager importe @prisma/client. Sur un checkout CI propre, le client généré n'existe pas
# encore : le produire ici précède nécessairement la première preuve négative du manager.
(
  cd "$ROOT_DIR"
  pnpm --filter @bob/api generate
)

# Les writers N-1 certifiés plus haut ont volontairement produit de vrais events v1 avant que le
# registre de binding n'existe. Le chemin de release doit refuser cet état au lieu d'associer
# rétroactivement le secret fourni aujourd'hui. Le tripwire rend la preuve discriminante : si le
# manager tente le moindre INSERT avant sa lecture des versions retenues, il échoue avec une autre
# cause et le certificat casse.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE FUNCTION public.agent_mission_cert_binding_insert_tripwire_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $agent_mission_cert_binding_insert_tripwire$
BEGIN
  RAISE EXCEPTION 'AGENT_MISSION_CERT_BINDING_INSERT_REACHED'
    USING ERRCODE = '55000',
          CONSTRAINT = 'agent_mission_cert_binding_insert_reached';
END;
$agent_mission_cert_binding_insert_tripwire$;

CREATE TRIGGER agent_mission_cert_binding_insert_tripwire_v1
BEFORE INSERT ON public.agent_mission_fingerprint_key_bindings
FOR EACH ROW
EXECUTE FUNCTION public.agent_mission_cert_binding_insert_tripwire_v1();
SQL

CONCURRENCY_MANAGER_LOG="$(
  mktemp "${TMPDIR:-/tmp}/bob-agent-mission-prebinding-guard.XXXXXX"
)"
if BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
  BOB_AGENT_MISSION_HMAC_KEY_VERSION=1 \
  BOB_AGENT_MISSION_HMAC_KEYRING='{"1":"KSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSk"}' \
  BOB_LIVE_ENABLED=true \
  BOB_LIVE_PROVIDER=openai \
  DIRECT_URL="$DIRECT_URL" \
  node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage \
  >"$CONCURRENCY_MANAGER_LOG" 2>&1
then
  cat "$CONCURRENCY_MANAGER_LOG" >&2
  echo "AgentMission stage retroactively bound an event predating its registry" >&2
  exit 1
fi
if ! grep -Fq \
  'agent-mission-fingerprint-key:error:retained-key-unbound' \
  "$CONCURRENCY_MANAGER_LOG"
then
  cat "$CONCURRENCY_MANAGER_LOG" >&2
  echo "AgentMission prebinding guard failed for an unrelated reason" >&2
  exit 1
fi
rm -f "$CONCURRENCY_MANAGER_LOG"
CONCURRENCY_MANAGER_LOG=""

unbound_guard_binding_count="$(
  "$PSQL_BIN" "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) FROM public.agent_mission_fingerprint_key_bindings;
SQL
)"
if [ "$unbound_guard_binding_count" != "0" ]; then
  echo "AgentMission prebinding rejection still persisted a binding" >&2
  exit 1
fi

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DROP TRIGGER agent_mission_cert_binding_insert_tripwire_v1
  ON public.agent_mission_fingerprint_key_bindings;
DROP FUNCTION public.agent_mission_cert_binding_insert_tripwire_v1();

-- Fixture exclusive à cette base jetable : elle représente un binding v1 qui aurait existé avant
-- les writers historiques. Le chemin de release ne possède et ne doit jamais posséder ce bypass.
INSERT INTO public.agent_mission_fingerprint_key_bindings (
  "keyVersion",
  "keyFingerprint"
) VALUES (
  1,
  '3dabdc61748c357c67c0c81f568f6e2fa942decaf2b15c6009ab93140d3887c4'
);
SQL

# Le trigger final est déjà présent mais aucun floor n'est encore armé : le writer N-1 exact doit
# rester compatible jusqu'au premier stage, sans bypasser ensuite les versions durablement liées.
certify_agent_mission_event_writer \
  writer-n1-fingerprint-final-trigger \
  61000000-0000-4000-8000-000000000001 \
  61000000-0000-4000-8000-000000000002 \
  61000000-0000-4000-8000-000000000003 \
  61000000-0000-4000-8000-000000000004 \
  61000000-0000-8000-8000-000000000005 \
  61000000-0000-4000-8000-000000000006

# Barrières locales déterministes : le writer conserve le verrou advisory partagé dans sa
# transaction, tandis que le manager doit être observé en attente du verrou exclusif exact.
# Aucun sleep de durée arbitraire ne peut donc produire un faux vert selon la vitesse de Prisma.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
CREATE UNLOGGED TABLE public.agent_mission_cert_rotation_barriers (
  name TEXT PRIMARY KEY,
  released BOOLEAN NOT NULL DEFAULT FALSE
);
REVOKE ALL ON TABLE public.agent_mission_cert_rotation_barriers FROM PUBLIC;
REVOKE ALL ON TABLE public.agent_mission_cert_rotation_barriers
  FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.agent_mission_cert_rotation_barriers TO bob_app;
INSERT INTO public.agent_mission_cert_rotation_barriers (name)
VALUES ('snapshot-freshness'), ('stage-v2'), ('retire-v2');
RESET ROLE;
SQL

# Preuve discriminante du snapshot post-verrou : le writer v3 committe pendant que le premier
# stage, configuré volontairement avec la seule clé v1, attend son verrou exclusif. En
# READ COMMITTED le manager relit ensuite l'event v3 et doit le refuser comme retenu sans binding,
# avant sa boucle d'INSERT. Un snapshot pris avant l'attente accepterait à tort le stage.
CONCURRENCY_LOG="$(
  mktemp "${TMPDIR:-/tmp}/bob-agent-mission-snapshot-writer.XXXXXX"
)"
certify_agent_mission_event_writer \
  writer-fingerprint-snapshot-v3 \
  62000000-0000-4000-8000-000000000001 \
  62000000-0000-4000-8000-000000000002 \
  62000000-0000-4000-8000-000000000003 \
  62000000-0000-4000-8000-000000000004 \
  62000000-0000-8000-8000-000000000005 \
  62000000-0000-4000-8000-000000000006 \
  3 \
  snapshot-freshness \
  bob-agent-mission-fingerprint-snapshot-writer \
  >"$CONCURRENCY_LOG" 2>&1 &
concurrent_writer_pid=$!
wait_for_agent_mission_writer_pause \
  bob-agent-mission-fingerprint-snapshot-writer \
  "$concurrent_writer_pid"

CONCURRENCY_MANAGER_LOG="$(
  mktemp "${TMPDIR:-/tmp}/bob-agent-mission-snapshot-manager.XXXXXX"
)"
(
  BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
  BOB_AGENT_MISSION_HMAC_KEY_VERSION=1 \
  BOB_AGENT_MISSION_HMAC_KEYRING='{"1":"KSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSk"}' \
  BOB_LIVE_ENABLED=true \
  BOB_LIVE_PROVIDER=openai \
  DIRECT_URL="$DIRECT_URL" \
  node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage
) >"$CONCURRENCY_MANAGER_LOG" 2>&1 &
concurrent_manager_pid=$!
wait_for_agent_mission_manager_exclusive_lock \
  bob-agent-mission-fingerprint-snapshot-writer \
  "$concurrent_manager_pid"
release_agent_mission_writer_barrier snapshot-freshness

if wait "$concurrent_manager_pid"; then
  cat "$CONCURRENCY_MANAGER_LOG" >&2
  echo "AgentMission stage used a stale snapshot across its exclusive-lock wait" >&2
  exit 1
fi
if ! grep -Fq \
  'agent-mission-fingerprint-key:error:retained-key-unbound' \
  "$CONCURRENCY_MANAGER_LOG"
then
  cat "$CONCURRENCY_MANAGER_LOG" >&2
  echo "AgentMission snapshot race failed for an unrelated reason" >&2
  exit 1
fi
if ! wait "$concurrent_writer_pid"; then
  cat "$CONCURRENCY_LOG" >&2
  exit 1
fi
rm -f "$CONCURRENCY_LOG" "$CONCURRENCY_MANAGER_LOG"
CONCURRENCY_LOG=""
CONCURRENCY_MANAGER_LOG=""
concurrent_writer_pid=""
concurrent_manager_pid=""

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $agent_mission_cert_unbound_v3_certificate$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_mission_fingerprint_key_bindings
     WHERE "keyVersion" = 3
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CONCURRENT_STAGE_BOUND_V3_RETROACTIVELY';
  END IF;
END;
$agent_mission_cert_unbound_v3_certificate$;

-- Fixture exclusive à la poursuite du certificat jetable : elle simule un binding v3 antérieur
-- au writer concurrent désormais prouvé. Aucun script de release ne possède ce bypass.
INSERT INTO public.agent_mission_fingerprint_key_bindings (
  "keyVersion",
  "keyFingerprint"
) VALUES (
  3,
  'a0cfd501bcbf5ece1d0ec6cc0402fa11d37e34a25ccccaafbdb5183ca41c0f3f'
);
SQL

BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
BOB_AGENT_MISSION_HMAC_KEY_VERSION=1 \
BOB_AGENT_MISSION_HMAC_KEYRING='{"1":"KSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSk","3":"KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys"}' \
BOB_LIVE_ENABLED=true \
BOB_LIVE_PROVIDER=openai \
DIRECT_URL="$DIRECT_URL" \
node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage

if BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
  BOB_AGENT_MISSION_HMAC_KEY_VERSION=1 \
  BOB_AGENT_MISSION_HMAC_KEYRING='{"1":"KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio","3":"KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys"}' \
  BOB_LIVE_ENABLED=true \
  BOB_LIVE_PROVIDER=openai \
  DIRECT_URL="$DIRECT_URL" \
  node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage
then
  echo "AgentMission fingerprint stage accepted another material for version 1" >&2
  exit 1
fi

# Le registre et le floor restent protégés même contre le déployeur direct. Toutes les mutations
# négatives sont contenues dans une transaction rollbackée afin de préserver le scénario nominal.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $agent_mission_fingerprint_key_registry_certificate$
DECLARE
  rejected BOOLEAN;
  observed_constraint TEXT;
BEGIN
  rejected := false;
  BEGIN
    UPDATE public.agent_mission_fingerprint_key_bindings
       SET "keyFingerprint" = repeat('f', 64)
     WHERE "keyVersion" = 1;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
    rejected := observed_constraint =
      'agent_mission_fingerprint_key_binding_append_only';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_BINDING_UPDATE_ACCEPTED';
  END IF;

  rejected := false;
  BEGIN
    DELETE FROM public.agent_mission_fingerprint_key_bindings
     WHERE "keyVersion" = 1;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
    rejected := observed_constraint =
      'agent_mission_fingerprint_key_binding_append_only';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_BINDING_DELETE_ACCEPTED';
  END IF;

  rejected := false;
  BEGIN
    EXECUTE 'TRUNCATE TABLE public.agent_mission_fingerprint_key_bindings';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
    rejected := observed_constraint =
      'agent_mission_fingerprint_key_binding_append_only';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_BINDING_TRUNCATE_ACCEPTED';
  END IF;

  INSERT INTO public.agent_mission_fingerprint_key_bindings (
    "keyVersion",
    "keyFingerprint"
  ) VALUES (2, repeat('b', 64));
  UPDATE public.agent_mission_fingerprint_key_version_floors
     SET "highestWriterVersion" = 2
   WHERE "keySpace" = 'bob-agent-mission-fingerprint-hmac-v1';

  rejected := false;
  BEGIN
    UPDATE public.agent_mission_fingerprint_key_version_floors
       SET "highestWriterVersion" = 1
     WHERE "keySpace" = 'bob-agent-mission-fingerprint-hmac-v1';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
    rejected := observed_constraint =
      'agent_mission_fingerprint_key_floor_monotone';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_FLOOR_ROLLBACK_ACCEPTED';
  END IF;

  rejected := false;
  BEGIN
    UPDATE public.agent_mission_fingerprint_key_version_floors
       SET "highestWriterVersion" = 3
     WHERE "keySpace" = 'bob-agent-mission-fingerprint-hmac-v1';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
    rejected := observed_constraint =
      'agent_mission_fingerprint_key_floor_transition';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_FLOOR_GAP_ACCEPTED';
  END IF;

  rejected := false;
  BEGIN
    DELETE FROM public.agent_mission_fingerprint_key_version_floors
     WHERE "keySpace" = 'bob-agent-mission-fingerprint-hmac-v1';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
    rejected := observed_constraint =
      'agent_mission_fingerprint_key_floor_append_only';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_FLOOR_DELETE_ACCEPTED';
  END IF;
END;
$agent_mission_fingerprint_key_registry_certificate$;
ROLLBACK;
SQL

# Après stage [1,1], le trigger du journal accepte le writer courant mais refuse une version 2,
# avant toute autre validation d'enveloppe. Le test PostgreSQL Vitest qui suit prouve l'acceptation.
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config(
  'app.current_user_id',
  'writer-n1-fingerprint-readiness',
  true
);
DO $agent_mission_fingerprint_writer_floor_certificate$
DECLARE
  rejected BOOLEAN := false;
  observed_constraint TEXT;
BEGIN
  BEGIN
    INSERT INTO public.agent_mission_events (
      "id", "companyId", "ownerUserId", "missionId", "sequence", "eventType",
      "eventVersion", "actor", "commandId", "requestFingerprintHmac",
      "fingerprintKeyVersion", "fingerprintCanonicalizationVersion",
      "missionRevisionBefore", "missionRevisionAfter", "draftSlotRevisionBefore",
      "draftSlotRevisionAfter", "draftContentRevisionBefore",
      "draftContentRevisionAfter", "realtimeSessionId", "turnId",
      "contextRevision", "contextDigest", "data", "occurredAt",
      "retentionExpiresAt"
    ) VALUES (
      '70000000-0000-4000-8000-000000000001'::UUID,
      'writer-n1-company',
      'writer-n1-fingerprint-readiness',
      '60000000-0000-4000-8000-000000000001'::UUID,
      3,
      'screen_acknowledged',
      1,
      'system',
      '70000000-0000-4000-8000-000000000002'::UUID,
      repeat('7', 64),
      2,
      1,
      2,
      3,
      1,
      1,
      0,
      0,
      '70000000-0000-4000-8000-000000000003'::UUID,
      NULL,
      1,
      repeat('7', 64),
      '{"kind":"screen_acknowledged","nextPhase":"awaiting_customer"}'::JSONB,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + INTERVAL '2160 hours'
    );
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
    rejected := observed_constraint =
      'agent_mission_fingerprint_key_writer_range';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_WRITER_OUTSIDE_FLOOR_ACCEPTED';
  END IF;
END;
$agent_mission_fingerprint_writer_floor_certificate$;
ROLLBACK;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT USAGE ON SCHEMA public TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_draft_slots TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.realtime_session_leases TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.realtime_reaper_tenant_schedule TO bob_app;
GRANT SELECT ON TABLE public.realtime_admission_events TO bob_app;
GRANT SELECT ON TABLE public.realtime_mistral_ingress_tickets TO bob_app;
GRANT SELECT ON TABLE public.release_flags, public.release_flag_subjects TO bob_app;

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

# Un SET-only vers un owner ne donne aucun privilège effectif tant que le rôle n'est pas assumé.
# Le certificat doit néanmoins le détecter, car il permettrait ensuite de désactiver FORCE RLS.
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
GRANT bob_schema_owner TO bob_app WITH INHERIT FALSE, SET TRUE;
SQL
runtime_owner_membership_rejected=true
if "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-missions-release-cert.sql" \
  >/dev/null 2>&1
then
  runtime_owner_membership_rejected=false
fi
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
REVOKE bob_schema_owner FROM bob_app;
SQL
if [ "$runtime_owner_membership_rejected" != "true" ]; then
  echo "AgentMission release certificate accepted runtime SET membership to a table owner" >&2
  exit 1
fi

# Un rôle intermédiaire n'est propriétaire d'aucun objet protégé : l'ancien certificat ne le
# voyait donc pas. Avec BYPASSRLS + ACL, un simple SET ROLE suffisait pourtant à lire hors tenant.
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE bob_agent_mission_cert_rogue
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
GRANT bob_agent_mission_cert_rogue TO bob_app WITH INHERIT FALSE, SET TRUE;
SQL
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT SELECT ON TABLE public.agent_missions TO bob_agent_mission_cert_rogue;
RESET ROLE;
SQL
runtime_intermediate_membership_rejected=true
if "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-missions-release-cert.sql" \
  >/dev/null 2>&1
then
  runtime_intermediate_membership_rejected=false
fi
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
REVOKE SELECT ON TABLE public.agent_missions FROM bob_agent_mission_cert_rogue;
RESET ROLE;
SQL
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
REVOKE bob_agent_mission_cert_rogue FROM bob_app;
SQL
if [ "$runtime_intermediate_membership_rejected" != "true" ]; then
  echo "AgentMission release certificate accepted runtime SET through an intermediate role" >&2
  exit 1
fi

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT SELECT ON TABLE public.agent_missions TO bob_agent_mission_cert_rogue;
RESET ROLE;
SQL
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
GRANT bob_agent_mission_cert_rogue TO authenticated WITH INHERIT FALSE, SET TRUE;
SQL
data_api_intermediate_membership_rejected=true
if "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-missions-release-cert.sql" \
  >/dev/null 2>&1
then
  data_api_intermediate_membership_rejected=false
fi
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
REVOKE SELECT ON TABLE public.agent_missions FROM bob_agent_mission_cert_rogue;
RESET ROLE;
SQL
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
REVOKE bob_agent_mission_cert_rogue FROM authenticated;
DROP ROLE bob_agent_mission_cert_rogue;
SQL
if [ "$data_api_intermediate_membership_rejected" != "true" ]; then
  echo "AgentMission release certificate accepted Data API SET through an intermediate role" >&2
  exit 1
fi

"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -v release_env=staging \
  -v release_flag_version=1 \
  -v release_flag_kill_switch=false \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-release-cert.sql"

# Le certificat doit refuser tout ACL résiduel vers un rôle arbitraire, même si le runtime et les
# rôles Data API ne peuvent pas l'assumer aujourd'hui : une adhésion ultérieure ne doit jamais
# transformer un ancien GRANT oublié en capacité mission.
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE bob_agent_mission_realtime_acl_rogue
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SQL
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT EXECUTE ON FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1()
  TO bob_agent_mission_realtime_acl_rogue;
RESET ROLE;
SQL
realtime_function_acl_drift_rejected=true
if "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -v release_env=staging \
  -v release_flag_version=1 \
  -v release_flag_kill_switch=false \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-release-cert.sql" \
  >/dev/null 2>&1
then
  realtime_function_acl_drift_rejected=false
fi
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
REVOKE EXECUTE ON FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1()
  FROM bob_agent_mission_realtime_acl_rogue;
RESET ROLE;
SQL
if [ "$realtime_function_acl_drift_rejected" != "true" ]; then
  echo "AgentMission realtime certificate accepted a rogue trigger-function ACL" >&2
  exit 1
fi

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT DELETE ON TABLE public.realtime_session_leases
  TO bob_agent_mission_realtime_acl_rogue;
RESET ROLE;
SQL
realtime_relation_acl_drift_rejected=true
if "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -v release_env=staging \
  -v release_flag_version=1 \
  -v release_flag_kill_switch=false \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-release-cert.sql" \
  >/dev/null 2>&1
then
  realtime_relation_acl_drift_rejected=false
fi
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
REVOKE DELETE ON TABLE public.realtime_session_leases
  FROM bob_agent_mission_realtime_acl_rogue;
RESET ROLE;
SQL
if [ "$realtime_relation_acl_drift_rejected" != "true" ]; then
  echo "AgentMission realtime certificate accepted a rogue relation ACL" >&2
  exit 1
fi

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT SELECT ("agentMissionBootstrapAcknowledgedAt")
  ON TABLE public.realtime_session_leases
  TO bob_agent_mission_realtime_acl_rogue;
RESET ROLE;
SQL
realtime_column_acl_drift_rejected=true
if "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -v release_env=staging \
  -v release_flag_version=1 \
  -v release_flag_kill_switch=false \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-release-cert.sql" \
  >/dev/null 2>&1
then
  realtime_column_acl_drift_rejected=false
fi
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
REVOKE SELECT ("agentMissionBootstrapAcknowledgedAt")
  ON TABLE public.realtime_session_leases
  FROM bob_agent_mission_realtime_acl_rogue;
RESET ROLE;
SQL
"$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DROP ROLE bob_agent_mission_realtime_acl_rogue;
SQL
if [ "$realtime_column_acl_drift_rejected" != "true" ]; then
  echo "AgentMission realtime certificate accepted a rogue receipt-column ACL" >&2
  exit 1
fi

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

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT USAGE ON SCHEMA public TO bob_cert_auditor;
GRANT SELECT ON TABLE
  public.agent_missions,
  public.agent_mission_events,
  public.quote_draft_slots,
  public.realtime_admission_cancellation_fences,
  public.realtime_session_leases,
  public.realtime_mistral_ingress_tickets,
  public.release_flags,
  public.release_flag_subjects,
  public.release_flag_audit_events
TO bob_cert_auditor;
GRANT DELETE ON TABLE public.realtime_session_leases TO bob_cert_auditor;
GRANT SELECT, INSERT ON TABLE public.companies TO bob_cert_auditor;
RESET ROLE;
SQL

cd "$ROOT_DIR"
# Vitest API consomme les exports package réels de toutes ses dépendances workspace. Les construire
# dans l'ordre topologique rend la preuve reproductible depuis un checkout propre et interdit qu'un
# dist local périmé ou absent masque le source certifié (incidents UUID système v5/v8 et @bob/ai
# introuvable du 26/07/2026).
pnpm --filter "@bob/api^..." run build

DATABASE_URL="$DATABASE_URL" \
DIRECT_URL="$DIRECT_URL" \
AGENT_MISSION_CERT_ADMIN_URL="$CERT_ADMIN_URL" \
RUN_AGENT_MISSION_POSTGRES_CERT=true \
AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE=true \
pnpm --filter @bob/api exec vitest run \
  src/persistence/prisma/agent-mission.persistence.postgres.test.ts

# Cycle de rotation réel, après les tests métier qui utilisent volontairement la version 1.
# La preuve couvre deux connexions concurrentes, les snapshots après verrou, le retrait N-1 et
# l'arrêt/réactivation durable du writer. Les secrets restent des fixtures de certification
# locales et ne sont jamais affichés.
certify_agent_mission_fingerprint_floor 1 1 true 2

CONCURRENCY_LOG="$(
  mktemp "${TMPDIR:-/tmp}/bob-agent-mission-stage-writer.XXXXXX"
)"
certify_agent_mission_event_writer \
  writer-fingerprint-concurrent-stage-v1 \
  80000000-0000-4000-8000-000000000001 \
  80000000-0000-4000-8000-000000000002 \
  80000000-0000-4000-8000-000000000003 \
  80000000-0000-4000-8000-000000000004 \
  80000000-0000-8000-8000-000000000005 \
  80000000-0000-4000-8000-000000000006 \
  1 \
  stage-v2 \
  bob-agent-mission-fingerprint-stage-writer \
  >"$CONCURRENCY_LOG" 2>&1 &
concurrent_writer_pid=$!
wait_for_agent_mission_writer_pause \
  bob-agent-mission-fingerprint-stage-writer \
  "$concurrent_writer_pid"

CONCURRENCY_MANAGER_LOG="$(
  mktemp "${TMPDIR:-/tmp}/bob-agent-mission-stage-manager.XXXXXX"
)"
(
  BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
  BOB_AGENT_MISSION_HMAC_KEY_VERSION=2 \
  BOB_AGENT_MISSION_HMAC_KEYRING='{"1":"KSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSk","2":"KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio","3":"KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys"}' \
  BOB_LIVE_ENABLED=true \
  BOB_LIVE_PROVIDER=openai \
  DIRECT_URL="$DIRECT_URL" \
  node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage
) >"$CONCURRENCY_MANAGER_LOG" 2>&1 &
concurrent_manager_pid=$!
wait_for_agent_mission_manager_exclusive_lock \
  bob-agent-mission-fingerprint-stage-writer \
  "$concurrent_manager_pid"
release_agent_mission_writer_barrier stage-v2

if ! wait "$concurrent_manager_pid"; then
  cat "$CONCURRENCY_MANAGER_LOG" >&2
  exit 1
fi
if ! wait "$concurrent_writer_pid"; then
  cat "$CONCURRENCY_LOG" >&2
  exit 1
fi
rm -f "$CONCURRENCY_LOG" "$CONCURRENCY_MANAGER_LOG"
CONCURRENCY_LOG=""
CONCURRENCY_MANAGER_LOG=""
concurrent_writer_pid=""
concurrent_manager_pid=""
certify_agent_mission_fingerprint_floor 1 2 true 3

stage_writer_event_count="$(
  "$PSQL_BIN" "$CERT_ADMIN_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
  FROM public.agent_mission_events
 WHERE id = '80000000-0000-4000-8000-000000000002'::UUID
   AND "fingerprintKeyVersion" = 1;
SQL
)"
if [ "$stage_writer_event_count" != "1" ]; then
  echo "AgentMission stage did not wait for the committed shared writer" >&2
  exit 1
fi

# Le registre append-only interdit également de réutiliser le même matériau sous une autre
# version, indépendamment du parseur CLI.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $agent_mission_fingerprint_duplicate_material_certificate$
DECLARE
  observed_constraint TEXT;
  rejected BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO public.agent_mission_fingerprint_key_bindings (
      "keyVersion",
      "keyFingerprint"
    )
    SELECT 4, binding."keyFingerprint"
      FROM public.agent_mission_fingerprint_key_bindings AS binding
     WHERE binding."keyVersion" = 2;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
    rejected := observed_constraint =
      'agent_mission_fingerprint_key_binding_fingerprint_key';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_DUPLICATE_MATERIAL_ACCEPTED';
  END IF;
END;
$agent_mission_fingerprint_duplicate_material_certificate$;
ROLLBACK;
SQL

# Le master OFF ne peut pas graver un fence pendant que la capacité est encore ouverte : ce
# chemin est distinct du retire et doit lui aussi échouer fermé, sans muter le floor.
if BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=false \
  DIRECT_URL="$DIRECT_URL" \
  node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage \
  >/dev/null 2>&1
then
  echo "AgentMission fingerprint OFF accepted an open Bob Live capacity" >&2
  exit 1
fi
certify_agent_mission_fingerprint_floor 1 2 true 3

# Un retire ne peut pas fermer N tant que la capacité reste ouverte.
if BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
  BOB_AGENT_MISSION_HMAC_KEY_VERSION=2 \
  BOB_AGENT_MISSION_HMAC_KEYRING='{"1":"KSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSk","2":"KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio","3":"KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys"}' \
  BOB_LIVE_ENABLED=true \
  BOB_LIVE_PROVIDER=openai \
  DIRECT_URL="$DIRECT_URL" \
  node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" retire \
  >/dev/null 2>&1
then
  echo "AgentMission fingerprint retire accepted an open Bob Live capacity" >&2
  exit 1
fi
certify_agent_mission_fingerprint_floor 1 2 true 3

PATH="$(dirname "$PSQL_BIN"):$PATH" \
DIRECT_URL="$DIRECT_URL" \
sh "$ROOT_DIR/apps/api/scripts/realtime-capacity-release.sh" close-existing

# Le certificat a volontairement écrit des leases N-1 avant l'installation de l'autorité globale.
# Une base de certification est jetable : l'auditeur BYPASSRLS les draine après fermeture, par
# DELETE (jamais TRUNCATE), afin d'exercer les triggers de projection `usedSessions` réels.
"$PSQL_BIN" "$CERT_ADMIN_URL" -X -v ON_ERROR_STOP=1 \
  -c 'DELETE FROM public.realtime_session_leases'

# Une version encore référencée par les events doit rester dans le keyring de lecture, même si le
# writer correspondant est sur le point d'être retiré.
if BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
  BOB_AGENT_MISSION_HMAC_KEY_VERSION=2 \
  BOB_AGENT_MISSION_HMAC_KEYRING='{"2":"KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio","3":"KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys"}' \
  BOB_LIVE_ENABLED=true \
  BOB_LIVE_PROVIDER=openai \
  DIRECT_URL="$DIRECT_URL" \
  node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" retire \
  >/dev/null 2>&1
then
  echo "AgentMission fingerprint retire dropped a retained key version" >&2
  exit 1
fi

CONCURRENCY_LOG="$(
  mktemp "${TMPDIR:-/tmp}/bob-agent-mission-retire-writer.XXXXXX"
)"
certify_agent_mission_event_writer \
  writer-fingerprint-concurrent-retire-v2 \
  81000000-0000-4000-8000-000000000001 \
  81000000-0000-4000-8000-000000000002 \
  81000000-0000-4000-8000-000000000003 \
  81000000-0000-4000-8000-000000000004 \
  81000000-0000-8000-8000-000000000005 \
  81000000-0000-4000-8000-000000000006 \
  2 \
  retire-v2 \
  bob-agent-mission-fingerprint-retire-writer \
  >"$CONCURRENCY_LOG" 2>&1 &
concurrent_writer_pid=$!
wait_for_agent_mission_writer_pause \
  bob-agent-mission-fingerprint-retire-writer \
  "$concurrent_writer_pid"

CONCURRENCY_MANAGER_LOG="$(
  mktemp "${TMPDIR:-/tmp}/bob-agent-mission-retire-manager.XXXXXX"
)"
(
  BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
  BOB_AGENT_MISSION_HMAC_KEY_VERSION=2 \
  BOB_AGENT_MISSION_HMAC_KEYRING='{"1":"KSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSk","2":"KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio","3":"KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys"}' \
  BOB_LIVE_ENABLED=true \
  BOB_LIVE_PROVIDER=openai \
  DIRECT_URL="$DIRECT_URL" \
  node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" retire
) >"$CONCURRENCY_MANAGER_LOG" 2>&1 &
concurrent_manager_pid=$!
wait_for_agent_mission_manager_exclusive_lock \
  bob-agent-mission-fingerprint-retire-writer \
  "$concurrent_manager_pid"
release_agent_mission_writer_barrier retire-v2

if ! wait "$concurrent_manager_pid"; then
  cat "$CONCURRENCY_MANAGER_LOG" >&2
  exit 1
fi
if ! wait "$concurrent_writer_pid"; then
  cat "$CONCURRENCY_LOG" >&2
  exit 1
fi
rm -f "$CONCURRENCY_LOG" "$CONCURRENCY_MANAGER_LOG"
CONCURRENCY_LOG=""
CONCURRENCY_MANAGER_LOG=""
concurrent_writer_pid=""
concurrent_manager_pid=""
certify_agent_mission_fingerprint_floor 2 2 true 3
certify_agent_mission_fingerprint_writer_rejected \
  1 \
  23514 \
  agent_mission_fingerprint_key_writer_range

retire_writer_event_count="$(
  "$PSQL_BIN" "$CERT_ADMIN_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
  FROM public.agent_mission_events
 WHERE id = '81000000-0000-4000-8000-000000000002'::UUID
   AND "fingerprintKeyVersion" = 2;
SQL
)"
if [ "$retire_writer_event_count" != "1" ]; then
  echo "AgentMission retire did not wait for the committed shared writer" >&2
  exit 1
fi

# Le hard-disable grave un fence writer seulement après closed|0. Il reste ensuite idempotent :
# Bob Live peut être rouvert pour d'autres usages sans que le retry OFF exige un second drain.
BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=false \
DIRECT_URL="$DIRECT_URL" \
node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage
certify_agent_mission_fingerprint_floor 2 2 false 3
certify_agent_mission_fingerprint_writer_rejected \
  2 \
  55000 \
  agent_mission_fingerprint_key_writer_disabled

PATH="$(dirname "$PSQL_BIN"):$PATH" \
DIRECT_URL="$DIRECT_URL" \
BOB_LIVE_ENABLED=true \
BOB_LIVE_PROVIDER=openai \
OPENAI_REALTIME_MODEL=gpt-realtime \
BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS=100 \
BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS=1000 \
BOB_LIVE_CAPACITY_CONFIG_VERSION=1 \
sh "$ROOT_DIR/apps/api/scripts/realtime-capacity-release.sh" configure

BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=false \
DIRECT_URL="$DIRECT_URL" \
node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage
certify_agent_mission_fingerprint_floor 2 2 false 3

BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true \
BOB_AGENT_MISSION_HMAC_KEY_VERSION=2 \
BOB_AGENT_MISSION_HMAC_KEYRING='{"1":"KSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSk","2":"KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio","3":"KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys"}' \
BOB_LIVE_ENABLED=true \
BOB_LIVE_PROVIDER=openai \
DIRECT_URL="$DIRECT_URL" \
node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage
certify_agent_mission_fingerprint_floor 2 2 true 3
certify_agent_mission_event_writer \
  writer-fingerprint-reenabled-v2 \
  82000000-0000-4000-8000-000000000001 \
  82000000-0000-4000-8000-000000000002 \
  82000000-0000-4000-8000-000000000003 \
  82000000-0000-4000-8000-000000000004 \
  82000000-0000-8000-8000-000000000005 \
  82000000-0000-4000-8000-000000000006 \
  2

PATH="$(dirname "$PSQL_BIN"):$PATH" \
DIRECT_URL="$DIRECT_URL" \
sh "$ROOT_DIR/apps/api/scripts/realtime-capacity-release.sh" close-existing
BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=false \
DIRECT_URL="$DIRECT_URL" \
node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage
certify_agent_mission_fingerprint_floor 2 2 false 3

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
DROP TABLE public.agent_mission_cert_rotation_barriers;
RESET ROLE;
SQL

"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-missions-release-cert.sql"
