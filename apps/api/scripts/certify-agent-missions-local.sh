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
SQL

"$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET createrole_self_grant = 'set';
CREATE ROLE bob_schema_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SQL

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

GRANT USAGE ON SCHEMA public TO bob_app;
-- PostgreSQL exige SELECT + UPDATE pour SELECT ... FOR SHARE. Le runtime production possède
-- déjà UPDATE sur companies (la clôture monotone l'utilise) ; le harnais reproduit ce droit exact.
GRANT SELECT, UPDATE ON TABLE public.companies TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_draft_slots TO bob_app;

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

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT USAGE ON SCHEMA public TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_draft_slots TO bob_app;

GRANT USAGE ON SCHEMA public TO bob_cert_auditor;
GRANT SELECT ON TABLE
  public.agent_missions,
  public.agent_mission_events,
  public.quote_draft_slots
TO bob_cert_auditor;
GRANT SELECT, INSERT ON TABLE public.companies TO bob_cert_auditor;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-missions-runtime-grants.sql"
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/agent-missions-release-cert.sql"

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
