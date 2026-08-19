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

if [ "$LOCAL_CLUSTER_STARTED" = "true" ]; then
  "$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.agent_missions (
  "companyId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL
);
SQL
  "$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 \
    -f "$ROOT_DIR/apps/api/prisma/migrations/20260729110000_agent_mission_global_foreground_expand/migration.sql"

  missing_owner_output=""
  if missing_owner_output="$(
    "$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X -v ON_ERROR_STOP=1 \
      -f "$ROOT_DIR/apps/api/prisma/migrations/20260729110000_agent_mission_global_foreground_expand/migration.sql" \
      2>&1
  )"; then
    echo "AgentMission K2 accepted a deployer without SET access to the table owner" >&2
    exit 1
  fi
  case "$missing_owner_output" in
    *"AGENT_MISSION_K2_SCHEMA_OWNER_UNAVAILABLE"*) ;;
    *)
      echo "$missing_owner_output" >&2
      echo "AgentMission K2 missing-owner refusal was not deterministic" >&2
      exit 1
      ;;
  esac

  "$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DROP TABLE public.agent_missions;
CREATE TABLE public.agent_missions (
  "companyId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL
);
ALTER TABLE public.agent_missions OWNER TO bob_deployer;
GRANT CREATE ON SCHEMA public TO bob_deployer;
SQL
  "$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X -v ON_ERROR_STOP=1 \
    -f "$ROOT_DIR/apps/api/prisma/migrations/20260729110000_agent_mission_global_foreground_expand/migration.sql"
  "$PSQL_BIN" "$SUPER_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $bob_agent_mission_k2_ci_owner$
DECLARE
  table_owner OID;
  index_owner OID;
BEGIN
  SELECT relation.relowner
    INTO STRICT table_owner
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.agent_missions'::pg_catalog.regclass;
  SELECT relation.relowner
    INTO STRICT index_owner
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid =
     'public.agent_missions_one_active_owner_key'::pg_catalog.regclass;
  IF table_owner <> index_owner
     OR table_owner <> pg_catalog.to_regrole('bob_deployer') THEN
    RAISE EXCEPTION 'AGENT_MISSION_K2_CI_OWNER_PARITY_FAILED';
  END IF;
END;
$bob_agent_mission_k2_ci_owner$;
DROP TABLE public.agent_missions;
REVOKE CREATE ON SCHEMA public FROM bob_deployer;
SQL
fi

"$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET createrole_self_grant = 'set';
CREATE ROLE bob_schema_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- Jarvis U1-e (SPEC_U1E §4) : autorite de l'annuaire de retention des payloads. Creee ICI, par
-- le DEPLOYEUR et sous `createrole_self_grant='set'` — exactement comme
-- `ensure_jarvis_payload_retention_directory_role` en release. L'adhesion SET du createur naît
-- IMPLICITEMENT (elle est requise par le seul `ALTER FUNCTION … OWNER TO` du provisionnement) :
-- un GRANT d'adhesion explicite vers le deployeur est INTERDIT par le contrat Supabase du depot
-- (supabase-owner-membership-release-safety) — Supabase tue la connexion sur un tel GRANT.
CREATE ROLE bob_jarvis_payload_retention_directory
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
SQL
"$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-release-flag-authority-role.sql"
"$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-fingerprint-readiness-authority-role.sql"
"$PSQL_BIN" "$DEPLOYER_BOOTSTRAP_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/catalogue-search-token-authority-role.sql"

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
CREATE TYPE public."LineCategory" AS ENUM (
  'labor',
  'supply',
  'travel',
  'disbursement',
  'subscription'
);
-- Jarvis U1-d : l'executeur d'effet ecrit la fiche client par le use case CANONIQUE
-- (Customer.of + PrismaCustomerRepository) ; le type legal du client est un enum en production.
CREATE TYPE public."CustomerType" AS ENUM ('b2c', 'b2b', 'b2g');

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE OR REPLACE FUNCTION public.immutable_unaccent(TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $immutable_unaccent$
  SELECT public.unaccent('public.unaccent', $1)
$immutable_unaccent$;

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

-- Surface client minimale mais réelle consommée par la recherche M1-C. Le certificat exerce la
-- requête PostgreSQL de production (unaccent + pg_trgm) et son isolation tenant, pas un double.
CREATE TABLE public.customers (
  "id" TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- Jarvis U1-d : la preuve d'effet ECRIT reellement une fiche par le use case canonique, donc
  -- par le mapper Prisma reel — le harnais porte les colonnes que ce mapper ecrit. Elles sont
  -- NULLABLE ici (plusieurs sont NOT NULL en production) parce que les inserts N-1 du harnais
  -- ne posent que id/companyId/name : le harnais reste un SOUS-ENSEMBLE de la release, jamais
  -- une surface plus permissive sur ce qu'il prouve.
  "type" public."CustomerType",
  "siren" CHAR(9),
  "siret" CHAR(14),
  "tvaIntracom" TEXT,
  "isInternational" BOOLEAN NOT NULL DEFAULT false,
  "addrLine1" TEXT,
  "addrZip" TEXT,
  "addrCity" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "contactName" TEXT,
  "ptLabel" TEXT,
  "paymentTermsDays" INTEGER,
  "paymentTermsEndOfMonth" BOOLEAN,
  "paymentTermsLabel" TEXT,
  "billingChannelType" TEXT,
  "billingChorusServiceCode" TEXT,
  "billingPortailNom" TEXT,
  "billingPortailUrl" TEXT,
  "requiresPurchaseOrder" BOOLEAN,
  "isSubcontractingBtp" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT customers_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies("id") ON DELETE RESTRICT,
  CONSTRAINT uniq_customer_id_company UNIQUE ("id", "companyId")
);
CREATE INDEX customers_name_trgm_idx
  ON public.customers
  USING GIN (public.immutable_unaccent(lower("name")) gin_trgm_ops);

-- Surface catalogue N-1 exacte consommée par M2-A. La table existe avant le train avec ses
-- anciens CHECK : ni `subscription`, ni TVA 2,1 ne sont acceptés avant le cutover.
CREATE TABLE public.catalogue_prestations (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "category" public."LineCategory" NOT NULL,
  "unit" TEXT,
  "unitPriceHt" INTEGER NOT NULL,
  "vatRate" DECIMAL(4,2) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT catalogue_prestations_pkey PRIMARY KEY ("id"),
  CONSTRAINT uniq_catalogue_prestation_id_company UNIQUE ("id", "companyId"),
  CONSTRAINT catalogue_prestations_companyId_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT catalogue_prestations_category_check
    CHECK ("category" IN ('labor', 'supply', 'travel')),
  CONSTRAINT catalogue_prestations_label_check
    CHECK (
      char_length(btrim("label")) BETWEEN 1 AND 500
      AND "label" = btrim("label")
      AND "label" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT catalogue_prestations_unit_check
    CHECK (
      "unit" IS NULL OR (
        char_length(btrim("unit")) BETWEEN 1 AND 80
        AND "unit" = btrim("unit")
        AND "unit" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT catalogue_prestations_price_check
    CHECK ("unitPriceHt" BETWEEN 1 AND 1500000000),
  CONSTRAINT catalogue_prestations_vat_check
    CHECK ("vatRate" IN (0, 5.5, 10, 20)),
  CONSTRAINT catalogue_prestations_revision_check CHECK ("revision" >= 1)
);
CREATE INDEX catalogue_prestations_company_category_label_idx
  ON public.catalogue_prestations("companyId", "category", "label");

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

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.customers
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE public.catalogue_prestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalogue_prestations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.catalogue_prestations
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

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
-- SELECT ... FOR SHARE exige aussi un privilège UPDATE ; une colonne suffit à reproduire ce
-- droit sans élargir le harnais aux mutations client (la release réelle accorde déjà UPDATE).
GRANT SELECT, UPDATE ("id") ON TABLE public.customers TO bob_app;
-- Jarvis U1-d : l'executeur d'effet cree et edite la fiche client par le use case canonique.
-- La release REELLE accorde deja ces droits au role applicatif (ecran Clients, outil vocal
-- creer_client) : le harnais reproduit ce droit exact, il ne l'invente pas.
GRANT INSERT, UPDATE ON TABLE public.customers TO bob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.catalogue_prestations TO bob_app;
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
), (
  'writer-n1-neighbor', 'Writer N-1 voisin', 'EI', '901000017', '90100001700017',
  'certification', 'reel_normal', '2 rue N-1', '75002', 'Paris'
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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727130000_release_flag_cabinet_subject_revocation_fence/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727140000_agent_mission_realtime_lease_expand/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727150000_agent_mission_realtime_lease_validate/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727160000_realtime_admission_cancellation_fence_expand/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727170000_realtime_admission_cancellation_fence_validate/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727180000_agent_mission_event_command_namespace_expand/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727190000_agent_mission_event_command_namespace_validate/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727200000_agent_mission_event_command_namespace_cutover/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727210000_agent_mission_fingerprint_key_readiness/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727220000_agent_mission_bootstrap_receipt_expand/migration.sql"

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
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260727230000_agent_mission_bootstrap_receipt_validate/migration.sql"

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

certify_agent_mission_m1c_writer_blocked() {
  blocked_owner_user_id="$1"
  blocked_mission_id="$2"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v owner_user_id="$blocked_owner_user_id" \
    -v mission_id="$blocked_mission_id" <<'SQL'
BEGIN;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', :'owner_user_id', true);
SELECT set_config('bob.cert.m1c_mission_id', :'mission_id', true);
SELECT set_config('app.current_agent_mission_id', :'mission_id', true);
DO $agent_mission_m1c_pre_cutover_certificate$
DECLARE
  rejected BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO public.agent_missions (
      "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
      "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
      "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
    ) VALUES (
      current_setting('bob.cert.m1c_mission_id')::UUID,
      'writer-n1-company',
      current_setting('app.current_user_id'),
      'quote_creation',
      'active',
      'awaiting_quote_screen',
      1,
      1,
      jsonb_build_object(
        'schema', 'bob.agent-mission.quote-creation',
        'version', 1,
        'draft', jsonb_build_object(
          'sessionId', current_setting('app.current_user_id'),
          'slotRevision', 1,
          'contentRevision', 0
        ),
        'decision', 'null'::JSONB,
        'stagedCustomerResolution', jsonb_build_object('kind', 'none')
      ),
      NULL,
      clock_timestamp() + INTERVAL '24 hours',
      clock_timestamp() + INTERVAL '168 hours',
      NULL,
      clock_timestamp() + INTERVAL '2328 hours',
      clock_timestamp(),
      clock_timestamp()
    );
  EXCEPTION
    WHEN check_violation THEN
      rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M1C_WRITER_ACCEPTED_BEFORE_CUTOVER';
  END IF;
END;
$agent_mission_m1c_pre_cutover_certificate$;
ROLLBACK;
SQL
}

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260729100000_agent_mission_customer_resolution_expand/migration.sql"

# Expand : l'ancien writer reste accepté sous les huit nouvelles contraintes NOT VALID, tandis
# que le nouveau payload staged reste volontairement bloqué par les contraintes canoniques N-1.
certify_agent_mission_event_writer \
  writer-n1-m1c-expand \
  90000000-0000-4000-8000-000000000001 \
  90000000-0000-4000-8000-000000000002 \
  90000000-0000-4000-8000-000000000003 \
  90000000-0000-4000-8000-000000000004 \
  90000000-0000-4000-8000-000000000005 \
  90000000-0000-4000-8000-000000000006
certify_agent_mission_m1c_writer_blocked \
  writer-m1c-blocked-expand \
  90000000-0000-4000-8000-000000000007

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260729100100_agent_mission_customer_resolution_validate/migration.sql"

# Validate sans cutover : même compatibilité N-1 et même blocage volontaire du writer M1-C.
certify_agent_mission_event_writer \
  writer-n1-m1c-validate \
  a0000000-0000-4000-8000-000000000001 \
  a0000000-0000-4000-8000-000000000002 \
  a0000000-0000-4000-8000-000000000003 \
  a0000000-0000-4000-8000-000000000004 \
  a0000000-0000-4000-8000-000000000005 \
  a0000000-0000-4000-8000-000000000006
certify_agent_mission_m1c_writer_blocked \
  writer-m1c-blocked-validate \
  a0000000-0000-4000-8000-000000000007

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE bob_schema_owner' \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260729100200_agent_mission_customer_resolution_cutover/migration.sql"

# Cutover : N-1 reste accepté après le remplacement atomique des huit contraintes.
certify_agent_mission_event_writer \
  writer-n1-m1c-cutover \
  b0000000-0000-4000-8000-000000000001 \
  b0000000-0000-4000-8000-000000000002 \
  b0000000-0000-4000-8000-000000000003 \
  b0000000-0000-4000-8000-000000000004 \
  b0000000-0000-4000-8000-000000000005 \
  b0000000-0000-4000-8000-000000000006

canonical_m1c_constraint_count="$(
  "$PSQL_BIN" "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
  FROM pg_catalog.pg_constraint AS con
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = con.conrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
 WHERE namespace.nspname = 'public'
   AND relation.relname IN ('agent_missions', 'agent_mission_events')
   AND con.conname IN (
     'agent_missions_payload_check',
     'agent_missions_payload_closed_shape_check',
     'agent_missions_phase_payload_check',
     'agent_mission_events_type_check',
     'agent_mission_events_envelope_check',
     'agent_mission_events_data_check',
     'agent_mission_events_correlation_check',
     'agent_mission_events_draft_effect_check'
   )
   AND con.convalidated
   AND con.conname NOT LIKE '%\_m1c\_%' ESCAPE '\';
SQL
)"
if [ "$canonical_m1c_constraint_count" != "8" ]; then
  echo "AgentMission M1-C canonical validated constraint set is incomplete" >&2
  exit 1
fi

temporary_m1c_constraint_count="$(
  "$PSQL_BIN" "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
  FROM pg_catalog.pg_constraint AS con
 WHERE con.conname LIKE '%\_m1c\_%' ESCAPE '\';
SQL
)"
if [ "$temporary_m1c_constraint_count" != "0" ]; then
  echo "AgentMission M1-C temporary constraints survived cutover" >&2
  exit 1
fi

# K2 est exécutée par le déployeur NON-superuser. La migration prend elle-même son SET ROLE ;
# un appelant qui l'enveloppe d'un `SET ROLE` masquerait précisément l'écart Supabase visé.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260729110000_agent_mission_global_foreground_expand/migration.sql"

foreground_index_count="$(
  "$PSQL_BIN" "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
  FROM pg_catalog.pg_index AS index
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = index.indrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_class AS index_relation
    ON index_relation.oid = index.indexrelid
 WHERE namespace.nspname = 'public'
   AND relation.relname = 'agent_missions'
   AND index_relation.relname IN (
     'agent_missions_one_active_owner_key',
     'agent_missions_one_active_owner_kind_key'
   )
   AND index_relation.relowner = relation.relowner
   AND index.indisunique
   AND index.indisvalid
   AND index.indisready
   AND index.indpred IS NOT NULL
   AND pg_catalog.regexp_replace(
     pg_catalog.pg_get_expr(index.indpred, index.indrelid),
     '[[:space:]()"]',
     '',
     'g'
   ) = 'status=''active''::text';
SQL
)"
if [ "$foreground_index_count" != "2" ]; then
  echo "AgentMission K2 global or N-1 foreground index is not ready and valid" >&2
  exit 1
fi

# Writer N-1 exact après K2 : même payload historique, mêmes triggers finaux, FORCE RLS et rôle
# runtime non-superuser. L'index global ne doit jamais casser le rolling deploy quote-only.
certify_agent_mission_event_writer \
  writer-n1-k2-global \
  c0000000-0000-4000-8000-000000000001 \
  c0000000-0000-4000-8000-000000000002 \
  c0000000-0000-4000-8000-000000000003 \
  c0000000-0000-4000-8000-000000000004 \
  c0000000-0000-4000-8000-000000000005 \
  c0000000-0000-4000-8000-000000000006

# Le CHECK quote-only courant est relâché uniquement dans cette transaction, puis rollbacké.
# Cela prouve l'effet multi-kind du nouvel index sans introduire de kind fictif dans le schéma.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE bob_schema_owner;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_kind_check;

SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-k2-cross-kind', true);
SELECT set_config(
  'app.current_agent_mission_id',
  'c1000000-0000-4000-8000-000000000001',
  true
);
SELECT set_config('bob.cert.k2_started_at', clock_timestamp()::TEXT, true);

INSERT INTO public.agent_missions (
  "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
  "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
  "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
) VALUES (
  'c1000000-0000-4000-8000-000000000001'::UUID,
  'writer-n1-company',
  'writer-k2-cross-kind',
  'quote_creation',
  'active',
  'awaiting_quote_screen',
  1,
  1,
  jsonb_build_object(
    'schema', 'bob.agent-mission.quote-creation',
    'version', 1,
    'draft', jsonb_build_object(
      'sessionId', 'writer-k2-cross-kind',
      'slotRevision', 1,
      'contentRevision', 0
    ),
    'decision', 'null'::JSONB
  ),
  NULL,
  current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ + INTERVAL '24 hours',
  current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ + INTERVAL '168 hours',
  NULL,
  current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ + INTERVAL '2328 hours',
  current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ,
  current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
);

DO $agent_mission_k2_cross_kind$
DECLARE
  rejected BOOLEAN := FALSE;
  rejected_by TEXT;
BEGIN
  PERFORM set_config(
    'app.current_agent_mission_id',
    'c2000000-0000-4000-8000-000000000001',
    true
  );
  BEGIN
    INSERT INTO public.agent_missions (
      "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
      "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
      "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
    ) VALUES (
      'c2000000-0000-4000-8000-000000000001'::UUID,
      'writer-n1-company',
      'writer-k2-cross-kind',
      'maintenance_contract',
      'active',
      'awaiting_quote_screen',
      1,
      1,
      jsonb_build_object(
        'schema', 'bob.agent-mission.quote-creation',
        'version', 1,
        'draft', jsonb_build_object(
          'sessionId', 'writer-k2-cross-kind',
          'slotRevision', 1,
          'contentRevision', 0
        ),
        'decision', 'null'::JSONB
      ),
      NULL,
      current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ + INTERVAL '24 hours',
      current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ + INTERVAL '168 hours',
      NULL,
      current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ + INTERVAL '2328 hours',
      current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ,
      current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
    );
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS rejected_by = CONSTRAINT_NAME;
    IF rejected_by <> 'agent_missions_one_active_owner_key' THEN
      RAISE EXCEPTION 'AGENT_MISSION_K2_WRONG_UNIQUE_BACKSTOP:%', rejected_by;
    END IF;
    rejected := TRUE;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_K2_CROSS_KIND_ACTIVE_ACCEPTED';
  END IF;
END;
$agent_mission_k2_cross_kind$;

ROLLBACK;
SQL

# M2-A-0 : le train est rejoué tel qu'en release par bob_deployer non-superuser. Les helpers
# propriétaire dans chaque migration doivent prendre leur propre SET ROLE ; aucun `-c SET ROLE`
# externe ne doit masquer une incompatibilité Supabase.
certify_m2a_quote_draft_reader_n1() {
  reader_stage="$1"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v reader_stage="$reader_stage" <<'SQL'
BEGIN READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-n1-owner', true);
SELECT set_config('bob.cert.m2a_reader_stage', :'reader_stage', true);

DO $quote_draft_reader_n1$
DECLARE
  slot_payload_version INTEGER;
  slot_payload JSONB;
  slot_agent_mission_id UUID;
  expected_payload CONSTANT JSONB :=
    '{"schema":"bob.quote-draft","version":1,"draft":{"sessionId":"n1","contentRevision":0,"stagingRevision":0,"step":"client","customer":null,"lines":[],"lineMetadata":[],"lineForm":{"label":"","quantity":"1","unitPrice":"","category":"labor"},"vatDecision":null,"depositPct":30,"signMode":null}}'::JSONB;
BEGIN
  SELECT "payloadVersion", "payload", "agentMissionId"
    INTO STRICT slot_payload_version, slot_payload, slot_agent_mission_id
    FROM public.quote_draft_slots
   WHERE "companyId" = 'writer-n1-company'
     AND "ownerUserId" = 'writer-n1-owner';

  IF slot_payload_version <> 1
     OR slot_payload IS DISTINCT FROM expected_payload
     OR slot_agent_mission_id IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_READER_N1_DRIFT:%',
      current_setting('bob.cert.m2a_reader_stage');
  END IF;
END;
$quote_draft_reader_n1$;
COMMIT;
SQL
}

certify_m2a_catalogue_writer_n1() {
  catalogue_stage="$1"
  catalogue_id="$2"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v catalogue_stage="$catalogue_stage" \
    -v catalogue_id="$catalogue_id" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-catalogue', true);
SELECT set_config('bob.cert.m2a_catalogue_stage', :'catalogue_stage', true);
SELECT set_config('bob.cert.m2a_catalogue_id', :'catalogue_id', true);

-- Forme N-1 exacte : searchKey omis, catégorie/taux historiques et colonnes sans nouveauté.
INSERT INTO public.catalogue_prestations (
  "id", "companyId", "label", "category", "unit", "unitPriceHt", "vatRate",
  "revision", "createdAt", "updatedAt"
) VALUES (
  :'catalogue_id',
  'writer-n1-company',
  'Škoda Łódź — Straße ' || :'catalogue_stage',
  'labor',
  'heure',
  5500,
  20,
  1,
  clock_timestamp(),
  clock_timestamp()
);

DO $catalogue_writer_n1$
DECLARE
  actual_search_key TEXT;
BEGIN
  SELECT "searchKey"
   INTO STRICT actual_search_key
    FROM public.catalogue_prestations
   WHERE "companyId" = 'writer-n1-company'
     AND "id" = current_setting('bob.cert.m2a_catalogue_id');
  IF actual_search_key IS DISTINCT FROM
    'skoda lodz strasse ' || current_setting('bob.cert.m2a_catalogue_stage')
  THEN
    RAISE EXCEPTION 'CATALOGUE_M2A_SEARCH_KEY_PARITY_DRIFT:%', actual_search_key;
  END IF;
END;
$catalogue_writer_n1$;
COMMIT;
SQL
}

certify_m2a_catalogue_new_shape_blocked() {
  catalogue_stage="$1"
  catalogue_id="$2"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v catalogue_stage="$catalogue_stage" \
    -v catalogue_id="$catalogue_id" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-catalogue', true);
SELECT set_config('bob.cert.m2a_catalogue_stage', :'catalogue_stage', true);
SELECT set_config('bob.cert.m2a_catalogue_id', :'catalogue_id', true);

DO $catalogue_new_shape_blocked$
DECLARE
  rejected BOOLEAN := FALSE;
  rejected_by TEXT;
BEGIN
  BEGIN
    INSERT INTO public.catalogue_prestations (
      "id", "companyId", "label", "category", "unit", "unitPriceHt", "vatRate",
      "revision", "createdAt", "updatedAt"
    ) VALUES (
      current_setting('bob.cert.m2a_catalogue_id'),
      'writer-n1-company',
      'Abonnement avant cutover ' ||
        current_setting('bob.cert.m2a_catalogue_stage'),
      'subscription',
      'mois',
      2500,
      2.1,
      1,
      clock_timestamp(),
      clock_timestamp()
    );
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS rejected_by = CONSTRAINT_NAME;
    rejected := rejected_by IN (
      'catalogue_prestations_category_check',
      'catalogue_prestations_vat_check'
    );
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'CATALOGUE_M2A_NEW_SHAPE_ACCEPTED_BEFORE_CUTOVER:%',
      current_setting('bob.cert.m2a_catalogue_stage');
  END IF;
  IF EXISTS (
    SELECT 1
     FROM public.catalogue_prestations
     WHERE "companyId" = 'writer-n1-company'
       AND "id" = current_setting('bob.cert.m2a_catalogue_id')
  ) THEN
    RAISE EXCEPTION 'CATALOGUE_M2A_REJECTED_ROW_SURVIVED:%',
      current_setting('bob.cert.m2a_catalogue_stage');
  END IF;
END;
$catalogue_new_shape_blocked$;
COMMIT;
SQL
}

certify_m2a1_realtime_writer_n1() {
  writer_stage="$1"
  writer_session_id="$2"
  writer_subject_hash="$3"
  writer_lease_token_hash="$4"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v writer_stage="$writer_stage" \
    -v writer_session_id="$writer_session_id" \
    -v writer_subject_hash="$writer_subject_hash" \
    -v writer_lease_token_hash="$writer_lease_token_hash" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a1-realtime-n1', true);
SELECT set_config('bob.cert.m2a1_realtime_stage', :'writer_stage', true);
SELECT set_config('bob.cert.m2a1_realtime_session_id', :'writer_session_id', true);
SELECT set_config('bob.cert.m2a1_realtime_reserved_at', clock_timestamp()::TEXT, true);

-- Forme admission N-1 exacte : protocole 1, sans aucune valeur M2-A.
INSERT INTO public.realtime_session_leases (
  "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
  "providerId", "providerCallId", "reaperTokenHash", "reservedAt",
  "leaseExpiresAt", "hardExpiresAt", "activatedAt", "updatedAt", version,
  "agentMissionProtocolVersion", "agentMissionProtocolBoundAt",
  "agentMissionCapabilityHash", "agentMissionReleaseFlagVersion"
) VALUES (
  'writer-n1-company',
  :'writer_subject_hash',
  :'writer_session_id'::UUID,
  :'writer_lease_token_hash',
  'active',
  'openai',
  'm2a1-n1-' || :'writer_stage',
  NULL,
  current_setting('bob.cert.m2a1_realtime_reserved_at')::TIMESTAMPTZ,
  current_setting('bob.cert.m2a1_realtime_reserved_at')::TIMESTAMPTZ
    + INTERVAL '10 minutes',
  current_setting('bob.cert.m2a1_realtime_reserved_at')::TIMESTAMPTZ
    + INTERVAL '20 minutes',
  current_setting('bob.cert.m2a1_realtime_reserved_at')::TIMESTAMPTZ,
  current_setting('bob.cert.m2a1_realtime_reserved_at')::TIMESTAMPTZ,
  1,
  1,
  current_setting('bob.cert.m2a1_realtime_reserved_at')::TIMESTAMPTZ,
  repeat('a', 64),
  1
);

UPDATE public.realtime_session_leases
   SET "agentMissionBootstrapAcknowledgedAt" = clock_timestamp(),
       "updatedAt" = clock_timestamp(),
       version = 2
 WHERE "companyId" = 'writer-n1-company'
   AND "sessionId" = :'writer_session_id'::UUID;

DO $m2a1_realtime_writer_n1$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_session_leases
     WHERE "companyId" = 'writer-n1-company'
       AND "sessionId" =
         current_setting('bob.cert.m2a1_realtime_session_id')::UUID
       AND "agentMissionProtocolVersion" = 1
       AND "agentMissionBootstrapAcknowledgedAt" IS NOT NULL
       AND version = 2
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_REALTIME_WRITER_N1_DRIFT:%',
      current_setting('bob.cert.m2a1_realtime_stage');
  END IF;
END;
$m2a1_realtime_writer_n1$;
COMMIT;
SQL
}

certify_m2a1_catalogue_revision_fence() {
  catalogue_stage="$1"
  catalogue_id="$2"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v catalogue_stage="$catalogue_stage" \
    -v catalogue_id="$catalogue_id" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-catalogue', true);
SELECT set_config('bob.cert.m2a1_catalogue_stage', :'catalogue_stage', true);
SELECT set_config('bob.cert.m2a1_catalogue_id', :'catalogue_id', true);

UPDATE public.catalogue_prestations
   SET label = 'Remplacement certifié ' || :'catalogue_stage',
       revision = 2,
       "updatedAt" = clock_timestamp()
 WHERE "companyId" = 'writer-n1-company'
   AND id = :'catalogue_id'
   AND revision = 1;

DO $m2a1_catalogue_revision$
DECLARE
  rejected BOOLEAN := FALSE;
  rejection_message TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
     FROM public.catalogue_prestations
     WHERE "companyId" = 'writer-n1-company'
       AND id = current_setting('bob.cert.m2a1_catalogue_id')
       AND revision = 2
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_CATALOGUE_CAS_DRIFT:%',
      current_setting('bob.cert.m2a1_catalogue_stage');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.catalogue_prestation_search_tokens
     WHERE "companyId" = 'writer-n1-company'
       AND "catalogueItemId" =
         current_setting('bob.cert.m2a1_catalogue_id')
       AND token IN ('skoda', 'lodz', 'strasse')
  ) OR (
    SELECT pg_catalog.count(*)
      FROM public.catalogue_prestation_search_tokens
     WHERE "companyId" = 'writer-n1-company'
       AND "catalogueItemId" =
         current_setting('bob.cert.m2a1_catalogue_id')
       AND token IN (
         'remplacement',
         'certifie',
         current_setting('bob.cert.m2a1_catalogue_stage')
       )
  ) <> 3 THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_CATALOGUE_TOKEN_SYNC_DRIFT:%',
      current_setting('bob.cert.m2a1_catalogue_stage');
  END IF;

  BEGIN
    UPDATE public.catalogue_prestations
       SET revision = 4,
           "updatedAt" = clock_timestamp()
     WHERE "companyId" = 'writer-n1-company'
       AND id = current_setting('bob.cert.m2a1_catalogue_id');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
    rejected := rejection_message =
      'CATALOGUE_PRESTATION_IDENTITY_OR_REVISION_INVALID';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_CATALOGUE_REVISION_JUMP_ACCEPTED:%',
      current_setting('bob.cert.m2a1_catalogue_stage');
  END IF;
END;
$m2a1_catalogue_revision$;
COMMIT;
SQL
}

# Writer N-1 exact du train M2-A-2 : mission protocole 2 + événement M2-A-1 +
# work item qui connaît catalogueResolution mais omet volontairement les deux nouveaux reçus
# d'override. Il tourne sous bob_app, FORCE RLS et le trigger V3 à chacune des trois étapes.
certify_m2a1_quote_line_writer_n1() {
  writer_stage="$1"
  writer_owner="$2"
  writer_mission_id="$3"
  writer_start_event_id="$4"
  writer_line_event_id="$5"
  writer_work_id="$6"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v writer_stage="$writer_stage" \
    -v writer_owner="$writer_owner" \
    -v writer_mission_id="$writer_mission_id" \
    -v writer_start_event_id="$writer_start_event_id" \
    -v writer_line_event_id="$writer_line_event_id" \
    -v writer_work_id="$writer_work_id" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', :'writer_owner', true);
SELECT set_config('app.current_agent_mission_id', :'writer_mission_id', true);
SELECT set_config('bob.cert.m2a2_n1_stage', :'writer_stage', true);
SELECT set_config('bob.cert.m2a2_n1_work_id', :'writer_work_id', true);
SELECT set_config('bob.cert.m2a2_n1_started_at', clock_timestamp()::TEXT, true);

INSERT INTO public.agent_missions (
  "id", "companyId", "ownerUserId", "protocolVersion", "kind", "status", "phase",
  "revision", "payloadVersion", "payload", "currentBinding", "idleExpiresAt",
  "hardExpiresAt", "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
) VALUES (
  :'writer_mission_id'::UUID,
  'writer-n1-company',
  :'writer_owner',
  2,
  'quote_creation',
  'active',
  'awaiting_lines',
  1,
  1,
  jsonb_build_object(
    'schema', 'bob.agent-mission.quote-creation',
    'version', 1,
    'draft', jsonb_build_object(
      'sessionId', :'writer_owner',
      'slotRevision', 1,
      'contentRevision', 0
    ),
    'decision', 'null'::JSONB
  ),
  jsonb_build_object(
    'realtimeSessionId', :'writer_mission_id',
    'contextRevision', 1,
    'contextDigest', repeat('a', 64),
    'screenName', '/devis/new',
    'screenInstanceId', 'cert-' || :'writer_stage',
    'acknowledgedAt', '2026-07-30T06:00:00.000Z'
  ),
  current_setting('bob.cert.m2a2_n1_started_at')::TIMESTAMPTZ
    + INTERVAL '24 hours',
  current_setting('bob.cert.m2a2_n1_started_at')::TIMESTAMPTZ
    + INTERVAL '168 hours',
  NULL,
  current_setting('bob.cert.m2a2_n1_started_at')::TIMESTAMPTZ
    + INTERVAL '2328 hours',
  current_setting('bob.cert.m2a2_n1_started_at')::TIMESTAMPTZ,
  current_setting('bob.cert.m2a2_n1_started_at')::TIMESTAMPTZ
);

INSERT INTO public.quote_draft_slots (
  "companyId", "ownerUserId", "revision", "payloadVersion", "payload", "agentMissionId"
) VALUES (
  'writer-n1-company',
  :'writer_owner',
  1,
  1,
  jsonb_build_object(
    'schema', 'bob.quote-draft',
    'version', 1,
    'draft', jsonb_build_object(
      'sessionId', :'writer_owner',
      'contentRevision', 0,
      'stagingRevision', 0,
      'step', 'lines',
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
  :'writer_mission_id'::UUID
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
  :'writer_start_event_id'::UUID,
  'writer-n1-company',
  :'writer_owner',
  :'writer_mission_id'::UUID,
  1,
  'mission_started',
  1,
  'user_tap',
  gen_random_uuid(),
  repeat('1', 64),
  1,
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
  current_setting('bob.cert.m2a2_n1_started_at')::TIMESTAMPTZ,
  current_setting('bob.cert.m2a2_n1_started_at')::TIMESTAMPTZ
    + INTERVAL '2160 hours'
);

-- Forme M2-A-1 exacte : catalogueResolution existe, les reçus M2-A-2 sont omis.
INSERT INTO public.agent_mission_quote_line_work (
  "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
  "state", "origin", "catalogueResolution", "createdAt", "updatedAt"
) VALUES (
  :'writer_work_id'::UUID,
  'writer-n1-company',
  :'writer_owner',
  :'writer_mission_id'::UUID,
  1,
  1,
  'queued',
  'user_voice',
  'pending',
  clock_timestamp(),
  clock_timestamp()
);

SELECT set_config('bob.cert.m2a2_n1_line_at', clock_timestamp()::TEXT, true);
UPDATE public.agent_missions
   SET "revision" = 2,
       "idleExpiresAt" = LEAST(
         current_setting('bob.cert.m2a2_n1_line_at')::TIMESTAMPTZ
           + INTERVAL '24 hours',
         "hardExpiresAt"
       ),
       "updatedAt" =
         current_setting('bob.cert.m2a2_n1_line_at')::TIMESTAMPTZ
 WHERE "id" = :'writer_mission_id'::UUID
   AND "revision" = 1;

INSERT INTO public.agent_mission_events (
  "id", "companyId", "ownerUserId", "missionId", "sequence", "eventType",
  "eventVersion", "actor", "commandId", "requestFingerprintHmac",
  "fingerprintKeyVersion", "fingerprintCanonicalizationVersion",
  "missionRevisionBefore", "missionRevisionAfter", "draftSlotRevisionBefore",
  "draftSlotRevisionAfter", "draftContentRevisionBefore", "draftContentRevisionAfter",
  "realtimeSessionId", "turnId", "contextRevision", "contextDigest", "data",
  "occurredAt", "retentionExpiresAt"
) VALUES (
  :'writer_line_event_id'::UUID,
  'writer-n1-company',
  :'writer_owner',
  :'writer_mission_id'::UUID,
  2,
  'line_candidates_staged',
  1,
  'user_tap',
  gen_random_uuid(),
  repeat('2', 64),
  1,
  1,
  1,
  2,
  1,
  1,
  0,
  0,
  NULL,
  NULL,
  NULL,
  NULL,
  '{"kind":"line_candidates_staged","stagedCount":1,"firstQueueOrdinal":1,"lastQueueOrdinal":1}'::JSONB,
  current_setting('bob.cert.m2a2_n1_line_at')::TIMESTAMPTZ,
  current_setting('bob.cert.m2a2_n1_line_at')::TIMESTAMPTZ
    + INTERVAL '2160 hours'
);

DO $m2a2_writer_n1$
BEGIN
  IF (
    SELECT ROW(
      "catalogueCategoryOverrideConfirmed",
      "catalogueUnitOverrideConfirmed"
    )
      FROM public.agent_mission_quote_line_work
     WHERE "id" =
       current_setting('bob.cert.m2a2_n1_work_id')::UUID
  ) IS DISTINCT FROM ROW(false, false) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A2_WRITER_N1_DEFAULT_DRIFT:%',
      current_setting('bob.cert.m2a2_n1_stage');
  END IF;
END;
$m2a2_writer_n1$;
COMMIT;
SQL
}

# Forme ligne `line_cancelled` exacte au writer M2-A-2, rejouée sous bob_app non-superuser.
# La preuve SQL cible la compatibilité du CHECK de données à chaque étape du train ; les tests core
# couvrent séparément la transition métier complète.
certify_m2a2_line_cancel_event_writer_n1() {
  cancel_stage="$1"
  cancel_shape="$2"
  cancel_expected="$3"
  cancel_fixture_prefix="$4"

  case "$cancel_shape" in
    sealed|null_pair|mixed_id_null|mixed_null_hash) ;;
    *)
      echo "Unsupported M2-A-3 cancellation fixture shape: $cancel_shape" >&2
      exit 1
      ;;
  esac
  case "$cancel_expected" in
    accepted|rejected) ;;
    *)
      echo "Unsupported M2-A-3 cancellation expectation: $cancel_expected" >&2
      exit 1
      ;;
  esac
  case "$cancel_fixture_prefix" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *)
      echo "M2-A-3 cancellation fixture prefix must contain four lowercase hex chars" >&2
      exit 1
      ;;
  esac

  cancel_owner="writer-m2a3-${cancel_fixture_prefix}-${cancel_shape}"
  cancel_mission_id="${cancel_fixture_prefix}0000-0000-4000-8000-000000000001"
  cancel_start_event_id="${cancel_fixture_prefix}0000-0000-4000-8000-000000000002"
  cancel_line_event_id="${cancel_fixture_prefix}0000-0000-4000-8000-000000000003"
  cancel_work_id="${cancel_fixture_prefix}0000-0000-4000-8000-000000000004"
  cancel_event_id="${cancel_fixture_prefix}0000-0000-4000-8000-000000000005"
  cancel_choice_id="${cancel_fixture_prefix}0000-0000-4000-8000-000000000006"
  cancel_command_id="${cancel_fixture_prefix}0000-0000-4000-8000-000000000007"

  certify_m2a1_quote_line_writer_n1 \
    "$cancel_stage-$cancel_shape" \
    "$cancel_owner" \
    "$cancel_mission_id" \
    "$cancel_start_event_id" \
    "$cancel_line_event_id" \
    "$cancel_work_id"

  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v cancel_stage="$cancel_stage" \
    -v cancel_shape="$cancel_shape" \
    -v cancel_expected="$cancel_expected" \
    -v cancel_owner="$cancel_owner" \
    -v cancel_mission_id="$cancel_mission_id" \
    -v cancel_work_id="$cancel_work_id" \
    -v cancel_event_id="$cancel_event_id" \
    -v cancel_choice_id="$cancel_choice_id" \
    -v cancel_command_id="$cancel_command_id" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', :'cancel_owner', true);
SELECT set_config('app.current_agent_mission_id', :'cancel_mission_id', true);
SELECT set_config('bob.cert.m2a3_cancel_stage', :'cancel_stage', true);
SELECT set_config('bob.cert.m2a3_cancel_shape', :'cancel_shape', true);
SELECT set_config('bob.cert.m2a3_cancel_expected', :'cancel_expected', true);
SELECT set_config('bob.cert.m2a3_cancel_event_id', :'cancel_event_id', true);
SELECT set_config('bob.cert.m2a3_cancel_mission_id', :'cancel_mission_id', true);
SELECT set_config('bob.cert.m2a3_cancel_owner', :'cancel_owner', true);
SELECT set_config('bob.cert.m2a3_cancel_work_id', :'cancel_work_id', true);
SELECT set_config('bob.cert.m2a3_cancel_choice_id', :'cancel_choice_id', true);
SELECT set_config('bob.cert.m2a3_cancel_command_id', :'cancel_command_id', true);
SELECT set_config('bob.cert.m2a3_cancel_occurred_at', clock_timestamp()::TEXT, true);

DO $m2a3_cancel_event_writer_n1$
DECLARE
  cancellation_data JSONB;
  insert_accepted BOOLEAN := FALSE;
  rejected_constraint TEXT;
  stage TEXT := current_setting('bob.cert.m2a3_cancel_stage');
  shape TEXT := current_setting('bob.cert.m2a3_cancel_shape');
  expected TEXT := current_setting('bob.cert.m2a3_cancel_expected');
BEGIN
  cancellation_data := CASE shape
    WHEN 'sealed' THEN jsonb_build_object(
      'kind', 'line_cancelled',
      'pendingLineId',
        current_setting('bob.cert.m2a3_cancel_work_id')::UUID,
      'expectedWorkRevision', 1,
      'choiceId', current_setting('bob.cert.m2a3_cancel_choice_id')::UUID,
      'choiceSetHash', repeat('c', 64)
    )
    WHEN 'null_pair' THEN jsonb_build_object(
      'kind', 'line_cancelled',
      'pendingLineId',
        current_setting('bob.cert.m2a3_cancel_work_id')::UUID,
      'expectedWorkRevision', 1,
      'choiceId', 'null'::JSONB,
      'choiceSetHash', 'null'::JSONB
    )
    WHEN 'mixed_id_null' THEN jsonb_build_object(
      'kind', 'line_cancelled',
      'pendingLineId',
        current_setting('bob.cert.m2a3_cancel_work_id')::UUID,
      'expectedWorkRevision', 1,
      'choiceId', current_setting('bob.cert.m2a3_cancel_choice_id')::UUID,
      'choiceSetHash', 'null'::JSONB
    )
    WHEN 'mixed_null_hash' THEN jsonb_build_object(
      'kind', 'line_cancelled',
      'pendingLineId',
        current_setting('bob.cert.m2a3_cancel_work_id')::UUID,
      'expectedWorkRevision', 1,
      'choiceId', 'null'::JSONB,
      'choiceSetHash', repeat('c', 64)
    )
    ELSE NULL
  END;
  IF cancellation_data IS NULL THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A3_CANCEL_FIXTURE_SHAPE_DRIFT:%:%',
      stage, shape;
  END IF;

  BEGIN
    UPDATE public.agent_missions
       SET "revision" = 3,
           "idleExpiresAt" = LEAST(
             current_setting('bob.cert.m2a3_cancel_occurred_at')::TIMESTAMPTZ
               + INTERVAL '24 hours',
             "hardExpiresAt"
           ),
           "updatedAt" =
             current_setting('bob.cert.m2a3_cancel_occurred_at')::TIMESTAMPTZ
     WHERE "id" =
       current_setting('bob.cert.m2a3_cancel_mission_id')::UUID
       AND "revision" = 2;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'AGENT_MISSION_M2A3_CANCEL_MISSION_FENCE_DRIFT:%:%',
        stage, shape;
    END IF;

    INSERT INTO public.agent_mission_events (
      "id", "companyId", "ownerUserId", "missionId", "sequence", "eventType",
      "eventVersion", "actor", "commandId", "requestFingerprintHmac",
      "fingerprintKeyVersion", "fingerprintCanonicalizationVersion",
      "missionRevisionBefore", "missionRevisionAfter", "draftSlotRevisionBefore",
      "draftSlotRevisionAfter", "draftContentRevisionBefore",
      "draftContentRevisionAfter", "realtimeSessionId", "turnId", "contextRevision",
      "contextDigest", "data", "occurredAt", "retentionExpiresAt"
    ) VALUES (
      current_setting('bob.cert.m2a3_cancel_event_id')::UUID,
      'writer-n1-company',
      current_setting('bob.cert.m2a3_cancel_owner'),
      current_setting('bob.cert.m2a3_cancel_mission_id')::UUID,
      3,
      'line_cancelled',
      1,
      'user_tap',
      current_setting('bob.cert.m2a3_cancel_command_id')::UUID,
      repeat('3', 64),
      1,
      1,
      2,
      3,
      1,
      1,
      0,
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      cancellation_data,
      current_setting('bob.cert.m2a3_cancel_occurred_at')::TIMESTAMPTZ,
      current_setting('bob.cert.m2a3_cancel_occurred_at')::TIMESTAMPTZ
        + INTERVAL '2160 hours'
    );
    insert_accepted := TRUE;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
    IF expected = 'accepted' THEN
      RAISE EXCEPTION
        'AGENT_MISSION_M2A3_CANCEL_EXPECTED_ACCEPTED:%:%:%',
        stage, shape, rejected_constraint;
    END IF;
    IF shape = 'null_pair'
       AND stage IN ('pre-expand', 'expand', 'validate')
       AND rejected_constraint <> 'agent_mission_events_data_check' THEN
      RAISE EXCEPTION
        'AGENT_MISSION_M2A3_CANCEL_NULL_PAIR_WRONG_CONSTRAINT:%:%',
        stage, rejected_constraint;
    END IF;
    IF shape IN ('mixed_id_null', 'mixed_null_hash')
       AND stage IN ('expand', 'validate')
       AND rejected_constraint NOT IN (
         'agent_mission_events_data_check',
         'agent_mission_events_data_m2a3_check'
       ) THEN
      RAISE EXCEPTION
        'AGENT_MISSION_M2A3_CANCEL_MIXED_WRONG_CONSTRAINT:%:%:%',
        stage, shape, rejected_constraint;
    END IF;
    IF (
      stage = 'pre-expand'
      OR stage = 'cutover'
    ) AND rejected_constraint <> 'agent_mission_events_data_check' THEN
      RAISE EXCEPTION
        'AGENT_MISSION_M2A3_CANCEL_CANONICAL_CONSTRAINT_DRIFT:%:%:%',
        stage, shape, rejected_constraint;
    END IF;
  END;

  IF expected = 'rejected' AND insert_accepted THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A3_CANCEL_SHAPE_ACCEPTED:%:%',
      stage, shape;
  END IF;
  IF expected = 'accepted' AND NOT insert_accepted THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A3_CANCEL_SHAPE_REJECTED:%:%',
      stage, shape;
  END IF;
  IF expected = 'accepted' AND NOT EXISTS (
    SELECT 1
      FROM public.agent_mission_events
     WHERE "id" =
       current_setting('bob.cert.m2a3_cancel_event_id')::UUID
       AND "data" = cancellation_data
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A3_CANCEL_ACCEPTED_ROW_DRIFT:%:%',
      stage, shape;
  END IF;
  IF expected = 'rejected' AND (
    EXISTS (
      SELECT 1
        FROM public.agent_mission_events
       WHERE "id" =
         current_setting('bob.cert.m2a3_cancel_event_id')::UUID
    )
    OR (
      SELECT "revision"
        FROM public.agent_missions
       WHERE "id" =
         current_setting('bob.cert.m2a3_cancel_mission_id')::UUID
    ) <> 2
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A3_CANCEL_REJECTION_MUTATED:%:%',
      stage, shape;
  END IF;
END;
$m2a3_cancel_event_writer_n1$;
COMMIT;
SQL
}

certify_m2a3_flag_off() {
  flag_stage="$1"
  "$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -v flag_stage="$flag_stage" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('bob.cert.m2a3_flag_stage', :'flag_stage', true);
SET LOCAL ROLE bob_schema_owner;
ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;
DO $m2a3_flag_exact$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM public.release_flags AS flag
     WHERE flag.key = 'bob.agent_missions.quote.m2a'
       AND flag.environment::TEXT IN (
         'development',
         'staging',
         'production'
       )
       AND NOT flag.enabled
       AND NOT flag."killSwitch"
       AND flag.version = 1
       AND flag."updatedByUserId" = 'system:migration'
  ) <> 3
  OR (
    SELECT pg_catalog.count(*)
      FROM public.release_flags AS flag
     WHERE flag.key = 'bob.agent_missions.quote.m2a'
  ) <> 3
  OR EXISTS (
    SELECT 1
      FROM public.release_flag_subjects AS subject
      JOIN public.release_flags AS flag
        ON flag.id = subject."flagId"
     WHERE flag.key = 'bob.agent_missions.quote.m2a'
       AND subject.enabled
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A3_RELEASE_FLAG_NOT_OFF:%',
      current_setting('bob.cert.m2a3_flag_stage');
  END IF;
END;
$m2a3_flag_exact$;
ROLLBACK;

DO $m2a3_force_rls_restored$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid IN (
       'public.release_flags'::pg_catalog.regclass,
       'public.agent_mission_events'::pg_catalog.regclass
     )
       AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A3_FORCE_RLS_NOT_RESTORED';
  END IF;
END;
$m2a3_force_rls_restored$;
SQL
}

certify_m2a_quote_draft_reader_n1 pre-expand

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260729150000_agent_mission_quote_line_work_expand/migration.sql"

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.agent_mission_quote_line_work TO bob_app;
RESET ROLE;
SQL

certify_m2a_catalogue_writer_n1 \
  expand \
  catalogue-m2a-n1-expand
certify_m2a_quote_draft_reader_n1 expand
certify_m2a_catalogue_new_shape_blocked \
  expand \
  catalogue-m2a-new-expand

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260729150100_agent_mission_quote_line_work_validate/migration.sql"

certify_m2a_catalogue_writer_n1 \
  validate \
  catalogue-m2a-n1-validate
certify_m2a_quote_draft_reader_n1 validate
certify_m2a_catalogue_new_shape_blocked \
  validate \
  catalogue-m2a-new-validate

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260729150200_agent_mission_quote_line_work_cutover/migration.sql"

certify_m2a_catalogue_writer_n1 \
  cutover \
  catalogue-m2a-n1-cutover
certify_m2a_quote_draft_reader_n1 cutover

# La forme nouvellement autorisée et les ligatures rares sont prouvées après cutover.
"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-catalogue', true);
INSERT INTO public.catalogue_prestations (
  "id", "companyId", "label", "category", "unit", "unitPriceHt", "vatRate",
  "revision", "createdAt", "updatedAt"
) VALUES (
  'catalogue-m2a-new-cutover',
  'writer-n1-company',
  'Þing Đuro, Øresund',
  'subscription',
  'mois',
  2500,
  2.1,
  1,
  clock_timestamp(),
  clock_timestamp()
);
DO $catalogue_m2a_cutover$
BEGIN
  IF (
    SELECT "searchKey"
      FROM public.catalogue_prestations
     WHERE "companyId" = 'writer-n1-company'
       AND "id" = 'catalogue-m2a-new-cutover'
  ) IS DISTINCT FROM 'thing duro oresund' THEN
    RAISE EXCEPTION 'CATALOGUE_M2A_CUTOVER_SEARCH_KEY_DRIFT';
  END IF;
  IF (
    SELECT count(*)
      FROM public.catalogue_prestations
     WHERE "companyId" = 'writer-n1-company'
       AND pg_catalog.to_tsvector(
         'simple'::pg_catalog.regconfig,
         "searchKey"
       ) @@ pg_catalog.plainto_tsquery(
         'simple'::pg_catalog.regconfig,
         'lodz strasse'
       )
  ) <> 3 THEN
    RAISE EXCEPTION 'CATALOGUE_M2A_TOKEN_SEARCH_DRIFT';
  END IF;
END;
$catalogue_m2a_cutover$;
COMMIT;
SQL

catalogue_prefix_plan="$(
  "$PSQL_BIN" "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL enable_seqscan = off;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-catalogue', true);
EXPLAIN (COSTS OFF)
SELECT "id"
  FROM public.catalogue_prestations
 WHERE "companyId" = 'writer-n1-company'
   AND "searchKey" LIKE 'skoda%'
 ORDER BY "searchKey", "id"
 LIMIT 6;
ROLLBACK;
SQL
)"
case "$catalogue_prefix_plan" in
  *catalogue_prestations_company_search_prefix_idx*) ;;
  *)
    echo "$catalogue_prefix_plan" >&2
    echo "Catalogue M2-A prefix search does not use the tenant-first index" >&2
    exit 1
    ;;
esac

# Le parent réel est créé via le writer historique déjà certifié ; M2-A ne fabrique aucun second
# chemin de mission. Il reste actif et quote_creation pendant toutes les preuves work item.
certify_agent_mission_event_writer \
  writer-m2a-work \
  d0000000-0000-4000-8000-000000000001 \
  d0000000-0000-4000-8000-000000000002 \
  d0000000-0000-4000-8000-000000000003 \
  d0000000-0000-4000-8000-000000000004 \
  d0000000-0000-4000-8000-000000000005 \
  d0000000-0000-4000-8000-000000000006

"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-work', true);

DO $quote_line_work_capability$
DECLARE
  rejected BOOLEAN;
  affected_rows INTEGER;
  rejection_message TEXT;
BEGIN
  -- Sans capability puis avec une autre mission : refus fermé, aucun work item fantôme.
  rejected := FALSE;
  BEGIN
    INSERT INTO public.agent_mission_quote_line_work (
      "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
      "state", "origin", "createdAt", "updatedAt"
    ) VALUES (
      'd1000000-0000-4000-8000-000000000001'::UUID,
      'writer-n1-company',
      'writer-m2a-work',
      'd0000000-0000-4000-8000-000000000001'::UUID,
      1,
      1,
      'queued',
      'user_voice',
      clock_timestamp(),
      clock_timestamp()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := TRUE;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_MISSING_CAPABILITY_ACCEPTED';
  END IF;

  PERFORM set_config(
    'app.current_agent_mission_id',
    'd9999999-0000-4000-8000-000000000001',
    true
  );
  rejected := FALSE;
  BEGIN
    INSERT INTO public.agent_mission_quote_line_work (
      "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
      "state", "origin", "createdAt", "updatedAt"
    ) VALUES (
      'd1000000-0000-4000-8000-000000000001'::UUID,
      'writer-n1-company',
      'writer-m2a-work',
      'd0000000-0000-4000-8000-000000000001'::UUID,
      1,
      1,
      'queued',
      'user_voice',
      clock_timestamp(),
      clock_timestamp()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := TRUE;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_WRONG_CAPABILITY_ACCEPTED';
  END IF;

  PERFORM set_config(
    'app.current_agent_mission_id',
    'd0000000-0000-4000-8000-000000000001',
    true
  );

  -- Un parent absent échoue dans le trigger avant la FK ; la preuve valide le fence actif.
  PERFORM set_config(
    'app.current_agent_mission_id',
    'd0000000-0000-4000-8000-000000000099',
    true
  );
  rejected := FALSE;
  BEGIN
    INSERT INTO public.agent_mission_quote_line_work (
      "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
      "state", "origin", "createdAt", "updatedAt"
    ) VALUES (
      'd1000000-0000-4000-8000-000000000002'::UUID,
      'writer-n1-company',
      'writer-m2a-work',
      'd0000000-0000-4000-8000-000000000099'::UUID,
      1,
      1,
      'queued',
      'user_voice',
      clock_timestamp(),
      clock_timestamp()
    );
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
    rejected := rejection_message =
      'AGENT_MISSION_QUOTE_LINE_ACTIVE_PARENT_REQUIRED';
  END;
  PERFORM set_config(
    'app.current_agent_mission_id',
    'd0000000-0000-4000-8000-000000000001',
    true
  );
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_ACTIVE_PARENT_FENCE_NOT_PROVEN';
  END IF;

  INSERT INTO public.agent_mission_quote_line_work (
    "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
    "state", "origin", "createdAt", "updatedAt"
  ) VALUES (
    'd1000000-0000-4000-8000-000000000001'::UUID,
    'writer-n1-company',
    'writer-m2a-work',
    'd0000000-0000-4000-8000-000000000001'::UUID,
    1,
    1,
    'queued',
    'user_voice',
    clock_timestamp(),
    clock_timestamp()
  );

  -- CHECK(NULL) ne doit jamais accepter un triplet proposal partiel.
  rejected := FALSE;
  BEGIN
    INSERT INTO public.agent_mission_quote_line_work (
      "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
      "state", "origin", "serviceReference", "category", "quantityMilli", "unit",
      "unitPriceCents", "requestedVatRate", "priceBasis", "proposalId",
      "createdAt", "updatedAt"
    ) VALUES (
      'd1000000-0000-4000-8000-000000000002'::UUID,
      'writer-n1-company',
      'writer-m2a-work',
      'd0000000-0000-4000-8000-000000000001'::UUID,
      2,
      1,
      'awaiting_confirmation',
      'user_voice',
      'Main-d''œuvre plomberie',
      'labor',
      2000,
      'heure',
      5500,
      20,
      'per_unit',
      'd2000000-0000-4000-8000-000000000001'::UUID,
      clock_timestamp(),
      clock_timestamp()
    );
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS rejection_message = CONSTRAINT_NAME;
    rejected := rejection_message =
      'agent_mission_quote_line_work_proposal_check';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_PARTIAL_PROPOSAL_ACCEPTED';
  END IF;

  UPDATE public.agent_mission_quote_line_work
     SET "revision" = 2,
         "state" = 'awaiting_details',
         "requiredFact" = 'service_reference',
         "updatedAt" = clock_timestamp()
   WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID
     AND "revision" = 1;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_CAS_FIRST_UPDATE_FAILED';
  END IF;

  UPDATE public.agent_mission_quote_line_work
     SET "revision" = 2,
         "updatedAt" = clock_timestamp()
   WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID
     AND "revision" = 1;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_STALE_CAS_ACCEPTED';
  END IF;

  rejected := FALSE;
  BEGIN
    UPDATE public.agent_mission_quote_line_work
       SET "revision" = 4,
           "updatedAt" = clock_timestamp()
     WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
    rejected := rejection_message =
      'AGENT_MISSION_QUOTE_LINE_IDENTITY_OR_REVISION_INVALID';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_REVISION_JUMP_ACCEPTED';
  END IF;

  rejected := FALSE;
  BEGIN
    UPDATE public.agent_mission_quote_line_work
       SET "id" = 'd1000000-0000-4000-8000-000000000099'::UUID,
           "revision" = 3,
           "updatedAt" = clock_timestamp()
     WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
    rejected := rejection_message =
      'AGENT_MISSION_QUOTE_LINE_IDENTITY_OR_REVISION_INVALID';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_IDENTITY_MUTATION_ACCEPTED';
  END IF;
END;
$quote_line_work_capability$;

-- Owner isolation : une autre identité ne voit et ne mute aucune ligne.
SELECT set_config('app.current_user_id', 'writer-m2a-other-owner', true);
DO $quote_line_work_owner_isolation$
DECLARE
  affected_rows INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_mission_quote_line_work
     WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_CROSS_OWNER_READ_VISIBLE';
  END IF;
  UPDATE public.agent_mission_quote_line_work
     SET "revision" = 3,
         "updatedAt" = clock_timestamp()
   WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_CROSS_OWNER_WRITE_ACCEPTED';
  END IF;
END;
$quote_line_work_owner_isolation$;

-- Tenant isolation : même owner et UUID exacts restent invisibles si le tenant courant diffère.
SELECT set_config('app.current_user_id', 'writer-m2a-work', true);
SELECT set_config('app.current_company_id', 'writer-m2a-other-company', true);
DO $quote_line_work_tenant_isolation$
DECLARE
  affected_rows INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_mission_quote_line_work
     WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_CROSS_TENANT_READ_VISIBLE';
  END IF;
  UPDATE public.agent_mission_quote_line_work
     SET "revision" = 3,
         "updatedAt" = clock_timestamp()
   WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_CROSS_TENANT_WRITE_ACCEPTED';
  END IF;
END;
$quote_line_work_tenant_isolation$;

SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-work', true);
DELETE FROM public.agent_mission_quote_line_work
 WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID
   AND "revision" = 2;
DO $quote_line_work_delete$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_mission_quote_line_work
     WHERE "id" = 'd1000000-0000-4000-8000-000000000001'::UUID
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_DELETE_FAILED';
  END IF;
END;
$quote_line_work_delete$;
COMMIT;
SQL

# Parents terminal/cross-kind et cascade FK sont éprouvés sous l'owner NOLOGIN réel. La transaction
# est rollbackée : elle peut relâcher temporairement le CHECK quote-only pour simuler un futur kind
# sans publier une donnée ni contourner la lignée append-only.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE bob_schema_owner;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_kind_check;
-- L'owner reste non-superuser. NO FORCE est transactionnel et doit précéder les événements de
-- trigger en attente ; il permet uniquement le DELETE parent de rétention testé plus bas.
ALTER TABLE public.agent_missions NO FORCE ROW LEVEL SECURITY;
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('bob.cert.m2a_parent_started_at', clock_timestamp()::TEXT, true);

-- Parent terminal existant : la FK seule l'accepterait, le trigger doit le refuser.
SELECT set_config('app.current_user_id', 'writer-m2a-terminal-parent', true);
SELECT set_config(
  'app.current_agent_mission_id',
  'd3000000-0000-4000-8000-000000000001',
  true
);
INSERT INTO public.agent_missions (
  "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
  "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
  "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
) VALUES (
  'd3000000-0000-4000-8000-000000000001'::UUID,
  'writer-n1-company',
  'writer-m2a-terminal-parent',
  'quote_creation',
  'cancelled',
  'awaiting_quote_screen',
  1,
  1,
  '{"schema":"bob.agent-mission.quote-creation","version":1,"draft":{"sessionId":"writer-m2a-terminal-parent","slotRevision":1,"contentRevision":0},"decision":null}'::JSONB,
  NULL,
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '24 hours',
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '168 hours',
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '1 hour',
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '2161 hours',
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ,
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '1 hour'
);
DO $quote_line_terminal_parent$
DECLARE
  rejected BOOLEAN := FALSE;
  rejection_message TEXT;
BEGIN
  BEGIN
    INSERT INTO public.agent_mission_quote_line_work (
      "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
      "state", "origin", "createdAt", "updatedAt"
    ) VALUES (
      'd3100000-0000-4000-8000-000000000001'::UUID,
      'writer-n1-company',
      'writer-m2a-terminal-parent',
      'd3000000-0000-4000-8000-000000000001'::UUID,
      1,
      1,
      'queued',
      'user_voice',
      clock_timestamp(),
      clock_timestamp()
    );
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
    rejected := rejection_message =
      'AGENT_MISSION_QUOTE_LINE_ACTIVE_PARENT_REQUIRED';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_TERMINAL_PARENT_ACCEPTED';
  END IF;
END;
$quote_line_terminal_parent$;

-- Futur kind actif : la capability et la FK correspondent, mais ce work item reste quote-only.
SELECT set_config('app.current_user_id', 'writer-m2a-cross-kind-parent', true);
SELECT set_config(
  'app.current_agent_mission_id',
  'd4000000-0000-4000-8000-000000000001',
  true
);
INSERT INTO public.agent_missions (
  "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
  "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
  "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
) VALUES (
  'd4000000-0000-4000-8000-000000000001'::UUID,
  'writer-n1-company',
  'writer-m2a-cross-kind-parent',
  'maintenance_contract',
  'active',
  'awaiting_quote_screen',
  1,
  1,
  '{"schema":"bob.agent-mission.quote-creation","version":1,"draft":{"sessionId":"writer-m2a-cross-kind-parent","slotRevision":1,"contentRevision":0},"decision":null}'::JSONB,
  NULL,
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '24 hours',
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '168 hours',
  NULL,
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '2328 hours',
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ,
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ
);
DO $quote_line_cross_kind_parent$
DECLARE
  rejected BOOLEAN := FALSE;
  rejection_message TEXT;
BEGIN
  BEGIN
    INSERT INTO public.agent_mission_quote_line_work (
      "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
      "state", "origin", "createdAt", "updatedAt"
    ) VALUES (
      'd4100000-0000-4000-8000-000000000001'::UUID,
      'writer-n1-company',
      'writer-m2a-cross-kind-parent',
      'd4000000-0000-4000-8000-000000000001'::UUID,
      1,
      1,
      'queued',
      'user_voice',
      clock_timestamp(),
      clock_timestamp()
    );
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
    rejected := rejection_message =
      'AGENT_MISSION_QUOTE_LINE_ACTIVE_PARENT_REQUIRED';
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_CROSS_KIND_PARENT_ACCEPTED';
  END IF;
END;
$quote_line_cross_kind_parent$;

-- Suppression de rétention : le DELETE cascade traverse le trigger enfant sans capability
-- artificielle et ne laisse aucun fait éphémère orphelin.
SELECT set_config('app.current_user_id', 'writer-m2a-cascade-parent', true);
SELECT set_config(
  'app.current_agent_mission_id',
  'd5000000-0000-4000-8000-000000000001',
  true
);
INSERT INTO public.agent_missions (
  "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
  "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
  "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
) VALUES (
  'd5000000-0000-4000-8000-000000000001'::UUID,
  'writer-n1-company',
  'writer-m2a-cascade-parent',
  'quote_creation',
  'active',
  'awaiting_quote_screen',
  1,
  1,
  '{"schema":"bob.agent-mission.quote-creation","version":1,"draft":{"sessionId":"writer-m2a-cascade-parent","slotRevision":1,"contentRevision":0},"decision":null}'::JSONB,
  NULL,
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '24 hours',
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '168 hours',
  NULL,
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ + INTERVAL '2328 hours',
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ,
  current_setting('bob.cert.m2a_parent_started_at')::TIMESTAMPTZ
);
INSERT INTO public.agent_mission_quote_line_work (
  "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
  "state", "origin", "createdAt", "updatedAt"
) VALUES (
  'd5100000-0000-4000-8000-000000000001'::UUID,
  'writer-n1-company',
  'writer-m2a-cascade-parent',
  'd5000000-0000-4000-8000-000000000001'::UUID,
  1,
  1,
  'queued',
  'user_voice',
  clock_timestamp(),
  clock_timestamp()
);
SELECT set_config('app.current_agent_mission_id', '', true);
DELETE FROM public.agent_missions
 WHERE "id" = 'd5000000-0000-4000-8000-000000000001'::UUID;
DO $quote_line_cascade$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_mission_quote_line_work
     WHERE "id" = 'd5100000-0000-4000-8000-000000000001'::UUID
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_CASCADE_DELETE_FAILED';
  END IF;
END;
$quote_line_cascade$;

ROLLBACK;
SQL

# M2-A-1 : le work writer M2-A-0 n'a jamais été activé. La migration ferme explicitement cette
# forme dormante plutôt que d'inventer un backfill. La preuve négative doit voir la ligne malgré
# FORCE RLS, refuser tout le train, puis laisser la base octet-logiquement intacte.
m2a1_preflight_work_count="$(
  "$PSQL_BIN" "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE bob_schema_owner;
ALTER TABLE public.agent_mission_quote_line_work NO FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM public.agent_mission_quote_line_work;
ROLLBACK;
SQL
)"
if [ "$m2a1_preflight_work_count" != "0" ]; then
  echo "AgentMission M2-A-1 found an unexpected preexisting work item" >&2
  exit 1
fi

"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-work', true);
SELECT set_config(
  'app.current_agent_mission_id',
  'd0000000-0000-4000-8000-000000000001',
  true
);
INSERT INTO public.agent_mission_quote_line_work (
  "id", "companyId", "ownerUserId", "missionId", "ordinal", "revision",
  "state", "origin", "createdAt", "updatedAt"
) VALUES (
  'e9000000-0000-4000-8000-000000000001'::UUID,
  'writer-n1-company',
  'writer-m2a-work',
  'd0000000-0000-4000-8000-000000000001'::UUID,
  1,
  1,
  'queued',
  'user_voice',
  clock_timestamp(),
  clock_timestamp()
);
COMMIT;
SQL

M2A1_PREFLIGHT_LOG="$(
  mktemp "${TMPDIR:-/tmp}/bob-agent-mission-m2a1-preflight.XXXXXX"
)"
if "$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260730100000_agent_mission_catalogue_choice_expand/migration.sql" \
  >"$M2A1_PREFLIGHT_LOG" 2>&1
then
  cat "$M2A1_PREFLIGHT_LOG" >&2
  echo "AgentMission M2-A-1 accepted a dormant preexisting work item" >&2
  exit 1
fi
if ! grep -Fq \
  'AGENT_MISSION_M2A1_PREEXISTING_LINE_WORK_UNSUPPORTED' \
  "$M2A1_PREFLIGHT_LOG"
then
  cat "$M2A1_PREFLIGHT_LOG" >&2
  echo "AgentMission M2-A-1 preflight failed for an unrelated reason" >&2
  exit 1
fi
rm -f "$M2A1_PREFLIGHT_LOG"
M2A1_PREFLIGHT_LOG=""

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE bob_schema_owner;
ALTER TABLE public.agent_mission_quote_line_work NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;
DO $m2a1_preflight_rollback$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'agent_missions'
       AND column_name = 'protocolVersion'
  )
  OR EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'agent_mission_quote_line_work'
       AND column_name = 'catalogueResolution'
  )
  OR to_regprocedure(
    'public.guard_realtime_agent_mission_bootstrap_receipt_v2()'
  ) IS NOT NULL
  OR EXISTS (
    SELECT 1
      FROM public.release_flags
     WHERE key = 'bob.agent_missions.quote.m2a'
  )
  OR NOT EXISTS (
    SELECT 1
      FROM public.agent_mission_quote_line_work
     WHERE id = 'e9000000-0000-4000-8000-000000000001'::UUID
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_PREFLIGHT_ROLLBACK_DRIFT';
  END IF;
END;
$m2a1_preflight_rollback$;
ROLLBACK;
SQL

"$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a-work', true);
SELECT set_config(
  'app.current_agent_mission_id',
  'd0000000-0000-4000-8000-000000000001',
  true
);
DELETE FROM public.agent_mission_quote_line_work
 WHERE id = 'e9000000-0000-4000-8000-000000000001'::UUID;
DO $m2a1_preflight_cleanup$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_mission_quote_line_work
     WHERE id = 'e9000000-0000-4000-8000-000000000001'::UUID
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_PREFLIGHT_CLEANUP_FAILED';
  END IF;
END;
$m2a1_preflight_cleanup$;
COMMIT;
SQL

# Reproduit les défauts Supabase : privilège table + ACL colonne accordés à PostgREST avant la
# migration. Les DEFAULT PRIVILEGES empoisonnent aussi la future table/fonction ; l'expand doit
# refermer les trois niveaux, pas seulement les objets préexistants.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT SELECT ON TABLE
  public.agent_missions,
  public.agent_mission_events,
  public.agent_mission_quote_line_work,
  public.realtime_session_leases,
  public.catalogue_prestations
TO anon, authenticated, service_role;
GRANT UPDATE ("revision") ON TABLE public.agent_missions
  TO anon, authenticated, service_role;
GRANT REFERENCES ("missionId") ON TABLE public.agent_mission_events
  TO anon, authenticated, service_role;
GRANT UPDATE ("ordinal") ON TABLE public.agent_mission_quote_line_work
  TO anon, authenticated, service_role;
GRANT UPDATE ("version") ON TABLE public.realtime_session_leases
  TO anon, authenticated, service_role;
GRANT UPDATE ("revision") ON TABLE public.catalogue_prestations
  TO anon, authenticated, service_role;
RESET ROLE;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260730100000_agent_mission_catalogue_choice_expand/migration.sql"

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $m2a1_expand_acl_fence$
DECLARE
  exposed_role TEXT;
  relation_name TEXT;
  function_name TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH relation_name IN ARRAY ARRAY[
      'agent_missions',
      'agent_mission_events',
      'agent_mission_quote_line_work',
      'realtime_session_leases',
      'catalogue_prestations',
      'catalogue_prestation_search_tokens'
    ] LOOP
      IF has_table_privilege(
        exposed_role,
        'public.' || relation_name,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) THEN
        RAISE EXCEPTION 'AGENT_MISSION_M2A1_DATA_API_TABLE_ACL_SURVIVED:%:%',
          exposed_role, relation_name;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid =
               ('public.' || relation_name)::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND (
             has_column_privilege(
               exposed_role,
               'public.' || relation_name,
               attribute.attname,
               'SELECT'
             )
             OR has_column_privilege(
               exposed_role,
               'public.' || relation_name,
               attribute.attname,
               'INSERT'
             )
             OR has_column_privilege(
               exposed_role,
               'public.' || relation_name,
               attribute.attname,
               'UPDATE'
             )
             OR has_column_privilege(
               exposed_role,
               'public.' || relation_name,
               attribute.attname,
               'REFERENCES'
             )
           )
      ) THEN
        RAISE EXCEPTION 'AGENT_MISSION_M2A1_DATA_API_COLUMN_ACL_SURVIVED:%:%',
          exposed_role, relation_name;
      END IF;
    END LOOP;

    FOREACH function_name IN ARRAY ARRAY[
      'guard_agent_mission_mutation_v2',
      'guard_agent_mission_event_append_v2',
      'guard_agent_mission_quote_line_work_v2',
      'guard_realtime_agent_mission_bootstrap_receipt_v2',
      'guard_catalogue_prestation_revision_v1',
      'sync_catalogue_prestation_search_tokens_v1'
    ] LOOP
      IF has_function_privilege(
        exposed_role,
        ('public.' || function_name || '()')::pg_catalog.regprocedure,
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION 'AGENT_MISSION_M2A1_DATA_API_FUNCTION_ACL_SURVIVED:%:%',
          exposed_role, function_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$m2a1_expand_acl_fence$;

BEGIN;
SET LOCAL ROLE bob_schema_owner;
ALTER TABLE public.catalogue_prestation_search_tokens
  NO FORCE ROW LEVEL SECURITY;
DO $m2a1_catalogue_backfill$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM public.catalogue_prestation_search_tokens
     WHERE "companyId" = 'writer-n1-company'
       AND "catalogueItemId" = 'catalogue-m2a-n1-cutover'
       AND token IN ('skoda', 'lodz', 'strasse', 'cutover')
  ) <> 4 THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_CATALOGUE_BACKFILL_DRIFT';
  END IF;
END;
$m2a1_catalogue_backfill$;
ROLLBACK;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.catalogue_prestation_search_tokens TO bob_app;
RESET ROLE;
SQL

certify_agent_mission_event_writer \
  writer-m2a1-expand \
  e0000000-0000-4000-8000-000000000001 \
  e0000000-0000-4000-8000-000000000002 \
  e0000000-0000-4000-8000-000000000003 \
  e0000000-0000-4000-8000-000000000004 \
  e0000000-0000-4000-8000-000000000005 \
  e0000000-0000-4000-8000-000000000006
certify_m2a_catalogue_writer_n1 \
  m2a1expand \
  catalogue-m2a1-n1-expand
certify_m2a1_catalogue_revision_fence \
  m2a1expand \
  catalogue-m2a1-n1-expand
certify_m2a_quote_draft_reader_n1 m2a1expand
certify_m2a1_realtime_writer_n1 \
  m2a1expand \
  e0100000-0000-4000-8000-000000000001 \
  e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1 \
  e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260730100100_agent_mission_catalogue_choice_validate/migration.sql"

certify_agent_mission_event_writer \
  writer-m2a1-validate \
  e1000000-0000-4000-8000-000000000001 \
  e1000000-0000-4000-8000-000000000002 \
  e1000000-0000-4000-8000-000000000003 \
  e1000000-0000-4000-8000-000000000004 \
  e1000000-0000-4000-8000-000000000005 \
  e1000000-0000-4000-8000-000000000006
certify_m2a_catalogue_writer_n1 \
  m2a1validate \
  catalogue-m2a1-n1-validate
certify_m2a1_catalogue_revision_fence \
  m2a1validate \
  catalogue-m2a1-n1-validate
certify_m2a_quote_draft_reader_n1 m2a1validate
certify_m2a1_realtime_writer_n1 \
  m2a1validate \
  e1100000-0000-4000-8000-000000000001 \
  e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3 \
  e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260730100200_agent_mission_catalogue_choice_cutover/migration.sql"

certify_agent_mission_event_writer \
  writer-m2a1-cutover \
  e2000000-0000-4000-8000-000000000001 \
  e2000000-0000-4000-8000-000000000002 \
  e2000000-0000-4000-8000-000000000003 \
  e2000000-0000-4000-8000-000000000004 \
  e2000000-0000-4000-8000-000000000005 \
  e2000000-0000-4000-8000-000000000006
certify_m2a_catalogue_writer_n1 \
  m2a1cutover \
  catalogue-m2a1-n1-cutover
certify_m2a1_catalogue_revision_fence \
  m2a1cutover \
  catalogue-m2a1-n1-cutover
certify_m2a_quote_draft_reader_n1 m2a1cutover
certify_m2a1_realtime_writer_n1 \
  m2a1cutover \
  e2100000-0000-4000-8000-000000000001 \
  e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5 \
  e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6

# Le plan certifié reprend la forme exacte de l'adapter : trois branches indexables, intersection
# de tous les tokens distincts, déduplication par rang puis verrou des six vraies lignes. Deux
# tenants partagent volontairement les mêmes tokens pour rendre toute fuite observable.
for m2a1_plan_tenant in writer-n1-company writer-n1-neighbor
do
  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v plan_tenant="$m2a1_plan_tenant" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT set_config('app.current_company_id', :'plan_tenant', true);
SELECT set_config('app.current_user_id', 'writer-m2a1-index-cert', true);
INSERT INTO public.catalogue_prestations (
  "id", "companyId", "label", "category", "unit", "unitPriceHt", "vatRate",
  "revision", "createdAt", "updatedAt"
)
SELECT
  :'plan_tenant' || '-catalogue-m2a1-plan-' || ordinal::TEXT,
  :'plan_tenant',
  CASE
    WHEN ordinal % 997 = 0 THEN 'Pompe hydroforage cible ' || ordinal::TEXT
    ELSE 'Prestation catalogue générique ' || ordinal::TEXT
  END,
  'labor',
  'heure',
  5500,
  20,
  1,
  clock_timestamp(),
  clock_timestamp()
FROM pg_catalog.generate_series(1, 10000) AS ordinal;
COMMIT;
SQL
done
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
ANALYZE public.catalogue_prestations;
ANALYZE public.catalogue_prestation_search_tokens;
RESET ROLE;
SQL

m2a1_catalogue_plans="$(
  "$PSQL_BIN" "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', 'writer-n1-company', true);
SELECT set_config('app.current_user_id', 'writer-m2a1-index-cert', true);
PREPARE m2a1_catalogue_search(TEXT, TEXT, TEXT, TEXT, INTEGER) AS
WITH matching_ids AS (
  SELECT exact_match."id", 0::SMALLINT AS match_rank
    FROM public.catalogue_prestations AS exact_match
   WHERE exact_match."companyId" = $1
     AND exact_match."searchKey" = $2
  UNION ALL
  SELECT prefix_match."id", 1::SMALLINT AS match_rank
    FROM public.catalogue_prestations AS prefix_match
   WHERE prefix_match."companyId" = $1
     AND prefix_match."searchKey" ~>=~ $2
     AND prefix_match."searchKey" ~<~ ($2 || '{')
     AND prefix_match."searchKey" <> $2
  UNION ALL
  SELECT search_token."catalogueItemId", 2::SMALLINT AS match_rank
    FROM public.catalogue_prestation_search_tokens AS search_token
   WHERE search_token."companyId" = $1
     AND search_token.token IN ($3, $4)
   GROUP BY search_token."companyId", search_token."catalogueItemId"
  HAVING pg_catalog.count(*) = $5
),
ranked_ids AS (
  SELECT matching_id."id", pg_catalog.min(matching_id.match_rank) AS match_rank
    FROM matching_ids AS matching_id
   GROUP BY matching_id."id"
)
SELECT c."id", ranked_id.match_rank
  FROM ranked_ids AS ranked_id
  JOIN public.catalogue_prestations AS c
    ON c."companyId" = $1
   AND c."id" = ranked_id."id"
 ORDER BY
   ranked_id.match_rank ASC,
   c."searchKey" COLLATE "C" ASC,
   c."id" ASC
 LIMIT 6
 FOR SHARE OF c;

SELECT 'M2A1_PLAN_CUSTOM';
EXPLAIN (COSTS OFF)
EXECUTE m2a1_catalogue_search(
  'writer-n1-company',
  'hydroforage pompe',
  'hydroforage',
  'pompe',
  2
);
SET LOCAL plan_cache_mode = force_generic_plan;
SELECT 'M2A1_PLAN_GENERIC';
EXPLAIN (COSTS OFF)
EXECUTE m2a1_catalogue_search(
  'writer-n1-company',
  'hydroforage pompe',
  'hydroforage',
  'pompe',
  2
);
SELECT 'M2A1_PLAN_RESULT';
EXECUTE m2a1_catalogue_search(
  'writer-n1-company',
  'hydroforage pompe',
  'hydroforage',
  'pompe',
  2
);
SELECT 'M2A1_PLAN_RESULT_END';
ROLLBACK;
SQL
)"
m2a1_catalogue_custom_plan="$(
  printf '%s\n' "$m2a1_catalogue_plans" \
    | awk '
      $0 == "M2A1_PLAN_CUSTOM" { capture = 1; next }
      $0 == "M2A1_PLAN_GENERIC" { capture = 0 }
      capture { print }
    '
)"
m2a1_catalogue_generic_plan="$(
  printf '%s\n' "$m2a1_catalogue_plans" \
    | awk '
      $0 == "M2A1_PLAN_GENERIC" { capture = 1; next }
      $0 == "M2A1_PLAN_RESULT" { capture = 0 }
      capture { print }
    '
)"
for m2a1_catalogue_plan in \
  "$m2a1_catalogue_custom_plan" \
  "$m2a1_catalogue_generic_plan"
do
  case "$m2a1_catalogue_plan" in
    *catalogue_search_tokens_pkey*) ;;
    *)
      printf '%s\n' "$m2a1_catalogue_plans" >&2
      echo "AgentMission M2-A-1 token plan does not use the tenant-token primary key" >&2
      exit 1
      ;;
  esac
  case "$m2a1_catalogue_plan" in
    *"Seq Scan on catalogue_prestation_search_tokens"*)
      printf '%s\n' "$m2a1_catalogue_plans" >&2
      echo "AgentMission M2-A-1 token plan performs a sequential scan" >&2
      exit 1
      ;;
  esac
done
m2a1_catalogue_result="$(
  printf '%s\n' "$m2a1_catalogue_plans" \
    | awk '
      $0 == "M2A1_PLAN_RESULT" { capture = 1; next }
      $0 == "M2A1_PLAN_RESULT_END" { capture = 0 }
      capture { print }
    '
)"
m2a1_catalogue_result_count="$(
  printf '%s\n' "$m2a1_catalogue_result" \
    | grep -c '^writer-n1-company-catalogue-m2a1-plan-[0-9][0-9]*|2$' \
    || true
)"
if [ "$m2a1_catalogue_result_count" -ne 6 ]; then
  printf '%s\n' "$m2a1_catalogue_plans" >&2
  echo "AgentMission M2-A-1 token search result leaked or lost a tenant" >&2
  exit 1
fi

for m2a1_plan_tenant in writer-n1-company writer-n1-neighbor
do
  "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v plan_tenant="$m2a1_plan_tenant" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.current_company_id', :'plan_tenant', true);
SELECT set_config('app.current_user_id', 'writer-m2a1-index-cert', true);
DELETE FROM public.catalogue_prestations
 WHERE "companyId" = :'plan_tenant'
   AND id LIKE :'plan_tenant' || '-catalogue-m2a1-plan-%';
DO $m2a1_catalogue_plan_cleanup$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.catalogue_prestations
     WHERE "companyId" = current_setting('app.current_company_id')
       AND id LIKE current_setting('app.current_company_id') ||
         '-catalogue-m2a1-plan-%'
  ) OR EXISTS (
    SELECT 1
      FROM public.catalogue_prestation_search_tokens
     WHERE "companyId" = current_setting('app.current_company_id')
       AND "catalogueItemId" LIKE current_setting('app.current_company_id') ||
         '-catalogue-m2a1-plan-%'
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_CATALOGUE_PLAN_CLEANUP_FAILED';
  END IF;
END;
$m2a1_catalogue_plan_cleanup$;
COMMIT;
SQL
done

# M2-A-2 : le train ajoute seulement les reçus d'override et les formes fermées de détail /
# confirmation. Les trois étapes sont rejouées avant le provisionnement canonique afin que les
# certificats finaux observent exclusivement les triggers V3.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
RESET ROLE;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260730110000_agent_mission_line_confirmation_expand/migration.sql"

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $m2a2_expand_acl_fence$
DECLARE
  exposed_role TEXT;
  function_name TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH function_name IN ARRAY ARRAY[
      'guard_agent_mission_event_append_v3',
      'guard_agent_mission_quote_line_work_v3'
    ] LOOP
      IF has_function_privilege(
        exposed_role,
        ('public.' || function_name || '()')::pg_catalog.regprocedure,
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION 'AGENT_MISSION_M2A2_DATA_API_FUNCTION_ACL_SURVIVED:%:%',
          exposed_role, function_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$m2a2_expand_acl_fence$;

SET ROLE bob_schema_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role;
RESET ROLE;
SQL

certify_m2a1_quote_line_writer_n1 \
  expand \
  writer-m2a2-n1-expand \
  f3000000-0000-4000-8000-000000000001 \
  f3000000-0000-4000-8000-000000000002 \
  f3000000-0000-4000-8000-000000000003 \
  f3000000-0000-4000-8000-000000000004
certify_m2a_quote_draft_reader_n1 m2a2expand

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260730110100_agent_mission_line_confirmation_validate/migration.sql"

certify_m2a1_quote_line_writer_n1 \
  validate \
  writer-m2a2-n1-validate \
  f4000000-0000-4000-8000-000000000001 \
  f4000000-0000-4000-8000-000000000002 \
  f4000000-0000-4000-8000-000000000003 \
  f4000000-0000-4000-8000-000000000004
certify_m2a_quote_draft_reader_n1 m2a2validate

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260730110200_agent_mission_line_confirmation_cutover/migration.sql"

certify_m2a1_quote_line_writer_n1 \
  cutover \
  writer-m2a2-n1-cutover \
  f5000000-0000-4000-8000-000000000001 \
  f5000000-0000-4000-8000-000000000002 \
  f5000000-0000-4000-8000-000000000003 \
  f5000000-0000-4000-8000-000000000004
certify_m2a_quote_draft_reader_n1 m2a2cutover

# M2-A-3 : `line_cancelled` conserve la paire scellée M2-A-2 et ajoute uniquement null/null.
# Chaque forme exacte est tentée sous bob_app avant/après chaque étape ; les paires mixtes restent
# refusées et le flag public est certifié OFF, overrides compris.
certify_m2a3_flag_off pre-expand
certify_m2a2_line_cancel_event_writer_n1 \
  pre-expand sealed accepted a300
certify_m2a2_line_cancel_event_writer_n1 \
  pre-expand null_pair rejected a301
certify_m2a2_line_cancel_event_writer_n1 \
  pre-expand mixed_id_null rejected a302
certify_m2a2_line_cancel_event_writer_n1 \
  pre-expand mixed_null_hash rejected a303

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260731120000_agent_mission_line_cancel_choice_expand/migration.sql"

certify_m2a3_flag_off expand
certify_m2a2_line_cancel_event_writer_n1 \
  expand sealed accepted a310
certify_m2a2_line_cancel_event_writer_n1 \
  expand null_pair rejected a311
certify_m2a2_line_cancel_event_writer_n1 \
  expand mixed_id_null rejected a312
certify_m2a2_line_cancel_event_writer_n1 \
  expand mixed_null_hash rejected a313

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260731120100_agent_mission_line_cancel_choice_validate/migration.sql"

certify_m2a3_flag_off validate
certify_m2a2_line_cancel_event_writer_n1 \
  validate sealed accepted a320
certify_m2a2_line_cancel_event_writer_n1 \
  validate null_pair rejected a321
certify_m2a2_line_cancel_event_writer_n1 \
  validate mixed_id_null rejected a322
certify_m2a2_line_cancel_event_writer_n1 \
  validate mixed_null_hash rejected a323

"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260731120200_agent_mission_line_cancel_choice_cutover/migration.sql"

certify_m2a3_flag_off cutover
certify_m2a2_line_cancel_event_writer_n1 \
  cutover sealed accepted a330
certify_m2a2_line_cancel_event_writer_n1 \
  cutover null_pair accepted a331
certify_m2a2_line_cancel_event_writer_n1 \
  cutover mixed_id_null rejected a332
certify_m2a2_line_cancel_event_writer_n1 \
  cutover mixed_null_hash rejected a333

# Les flags restent exactement OFF et FORCE RLS doit avoir été restauré après l'écriture globale.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE bob_schema_owner;
ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;
DO $m2a1_flag_exact$
BEGIN
  IF (
    SELECT count(*)
      FROM public.release_flags
     WHERE key = 'bob.agent_missions.quote.m2a'
       AND NOT enabled
       AND NOT "killSwitch"
       AND version = 1
       AND "updatedByUserId" = 'system:migration'
  ) <> 3 THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_RELEASE_FLAG_DRIFT';
  END IF;
END;
$m2a1_flag_exact$;
ROLLBACK;

DO $m2a1_force_rls_restored$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid IN (
       'public.release_flags'::pg_catalog.regclass,
       'public.agent_missions'::pg_catalog.regclass,
       'public.agent_mission_events'::pg_catalog.regclass,
       'public.agent_mission_quote_line_work'::pg_catalog.regclass,
       'public.catalogue_prestations'::pg_catalog.regclass,
       'public.catalogue_prestation_search_tokens'::pg_catalog.regclass
     )
       AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A1_FORCE_RLS_NOT_RESTORED';
  END IF;
END;
$m2a1_force_rls_restored$;
SQL

"$PSQL_BIN" "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -f "$ROOT_DIR/apps/api/prisma/catalogue-search-token-authority-provision.sql"

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
  -v m2a_release_flag_version=1 \
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
GRANT EXECUTE ON FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v2()
  TO bob_agent_mission_realtime_acl_rogue;
RESET ROLE;
SQL
realtime_function_acl_drift_rejected=true
if "$PSQL_BIN" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_role=bob_app \
  -v release_env=staging \
  -v release_flag_version=1 \
  -v release_flag_kill_switch=false \
  -v m2a_release_flag_version=1 \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-release-cert.sql" \
  >/dev/null 2>&1
then
  realtime_function_acl_drift_rejected=false
fi
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE bob_schema_owner;
REVOKE EXECUTE ON FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v2()
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
  -v m2a_release_flag_version=1 \
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
  -v m2a_release_flag_version=1 \
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
  -v m2a_release_flag_version=1 \
  -f "$ROOT_DIR/apps/api/prisma/agent-mission-realtime-release-cert.sql"

# Jarvis U1-a (SPEC_U1_NOYAU_DURABLE_20260818) : expand en place + jarvis_work_items.
# Appliquees par le deployer non-superuser comme toutes les migrations de la sequence.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260818200000_jarvis_run_expand/migration.sql"
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260818200100_jarvis_run_validate/migration.sql"

# Jarvis U1-c (SPEC_U1C_ADMISSION_DISPATCH_20260818) : CHECK quote-shaped rendus
# kind-conditionnels (expand NOT VALID puis validate separe), puis backstop de
# premier plan elargi aux statuts non-liberants. Meme deployer non-superuser ;
# les preuves writer N-1 reelles qui suivent (fingerprint floor + writer barrier)
# rejouent sur l'etat POST-U1-c et prouvent la branche quote intacte.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260819000000_jarvis_admission_expand/migration.sql"
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260819000100_jarvis_admission_validate/migration.sql"
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260819000200_jarvis_foreground_backstop/migration.sql"

# Jarvis U1-d (SPEC_U1D_CALLERS_REELS_20260819) : magasin PII des payloads de proposition.
# Table neuve, owner-scopee, immuable (aucune policy UPDATE) et purgeable par retention.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260819100000_jarvis_proposal_payloads/migration.sql"

# Jarvis U1-e (SPEC_U1E_PARCOURS_VISIBLE_20260819 §2) : revision de la fiche client. Expand
# ADDITIF applique sur la surface `customers` N-1 du harnais — exactement ce que fera la
# release : la colonne nait a 1 par DEFAULT, aucune ligne existante n'est reecrite, et le
# writer N-1 (les INSERT du harnais, qui ne posent que id/companyId/name) reste accepte.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260819200000_customers_revision/migration.sql"

# Jarvis U1-e (SPEC_U1E §4) : annuaire d'autorite des proprietaires a purger. Applique comme en
# release — d'abord la migration (fonction SECURITY INVOKER, donc FERMEE a tout appelant), puis le
# provisionnement qui la bascule DEFINER. Entre les deux la fonction existe et refuse : c'est ce
# fail-closed que la preuve 4 verifie AVANT la bascule.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/apps/api/prisma/migrations/20260819210000_jarvis_payload_retention_directory/migration.sql"

# Preuve du fail-closed NATIF : tant que le provisionnement n'a pas eu lieu, meme le deployeur se
# fait refuser en 42501. Une fonction d'annuaire qui repondrait ici serait un chemin privilegie ne
# de la migration elle-meme — exactement ce que le patron interdit.
"$PSQL_BIN" "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $bob_u1e_directory_closed$
DECLARE
  refused BOOLEAN := FALSE;
BEGIN
  BEGIN
    PERFORM * FROM public.list_jarvis_payload_retention_owners_v1('cert-company', 10);
  EXCEPTION
    WHEN insufficient_privilege THEN refused := TRUE;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'JARVIS_U1E_DIRECTORY_NOT_FAIL_CLOSED_BEFORE_PROVISIONING';
  END IF;
END;
$bob_u1e_directory_closed$;
SQL

# Provisionnement : COPIE FIDELE de `provision_jarvis_payload_retention_directory` (release.sh),
# reduite au seul cluster de certification (role applicatif fige a `bob_app`). Toute divergence
# entre ce bloc et release.sh se paierait par une certification qui prouve autre chose que ce que
# le deploiement fait — c'est pourquoi l'ordre des gestes y est identique, geste pour geste.
"$PSQL_BIN" "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
-- CREATE temporaire : PostgreSQL exige que le nouveau proprietaire d'une fonction ait CREATE sur
-- son schema. Retire plus bas, dans la meme transaction.
SET LOCAL ROLE bob_schema_owner;
GRANT USAGE, CREATE ON SCHEMA public TO bob_jarvis_payload_retention_directory;
RESET ROLE;

ALTER FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER)
  OWNER TO bob_jarvis_payload_retention_directory;

SET LOCAL ROLE bob_jarvis_payload_retention_directory;
REVOKE ALL ON FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER) FROM PUBLIC;
ALTER FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER) SECURITY DEFINER;
ALTER FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER)
  SET row_security = on;
ALTER FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER)
  SET statement_timeout = '4s';
ALTER FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER)
  SET lock_timeout = '1s';

-- ACL = allowlist EXACTE (meme requete qu'en release) : tout grantee EXECUTE qui n'est pas le
-- definer saute, y compris les trois roles Data API que Supabase sert par defaut.
SELECT format('REVOKE ALL ON FUNCTION %s FROM %s CASCADE',
              function.oid::regprocedure,
              CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
                   ELSE quote_ident(grantee.rolname) END)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE function.oid =
   'public.list_jarvis_payload_retention_owners_v1(text,integer)'::regprocedure
   AND privilege.privilege_type = 'EXECUTE'
   AND privilege.grantee <> function.proowner
\gexec
REVOKE ALL PRIVILEGES ON FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER)
  FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER) TO bob_app;
RESET ROLE;

SET LOCAL ROLE bob_schema_owner;
REVOKE CREATE ON SCHEMA public FROM bob_jarvis_payload_retention_directory;
GRANT USAGE ON SCHEMA public TO bob_jarvis_payload_retention_directory;

-- Table remise a plat AVANT le grant par colonne : un privilege de table entier survivant rendrait
-- la restriction par colonne inoperante.
REVOKE ALL PRIVILEGES ON TABLE public.jarvis_proposal_payloads
  FROM bob_jarvis_payload_retention_directory CASCADE;
-- `payload` EXCLU : l'autorite lit des coordonnees, jamais du contenu.
GRANT SELECT ("companyId", "ownerUserId", "retentionExpiresAt")
  ON TABLE public.jarvis_proposal_payloads
  TO bob_jarvis_payload_retention_directory;
RESET ROLE;
SQL

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
  public.release_flag_audit_events,
  public.customers
TO bob_cert_auditor;
GRANT DELETE ON TABLE public.realtime_session_leases TO bob_cert_auditor;
-- Jarvis U1-a : la preuve FK RESTRICT tente un DELETE de mission qui doit mourir sur la
-- contrainte (23503), pas sur le droit (42501). Concession de certification uniquement,
-- meme precedent que le DELETE leases ci-dessus ; la base est jetable.
GRANT DELETE ON TABLE public.agent_missions TO bob_cert_auditor;
GRANT SELECT ON TABLE public.jarvis_work_items TO bob_cert_auditor;
-- Jarvis U1-c : le harnais §19.2 vieillit les leases PAR L'AUDITEUR (UPDATE de
-- leaseExpiresAt) pour prouver qu'une ligne authorized n'est jamais reprise ni
-- re-prepared. Concession de certification uniquement, même précédent que les DELETE
-- ci-dessus ; la base est jetable.
GRANT UPDATE ON TABLE public.jarvis_work_items TO bob_cert_auditor;
GRANT SELECT, INSERT ON TABLE public.companies, public.customers TO bob_cert_auditor;
-- Jarvis U1-d : l'auditeur relit les charges scellees, VIEILLIT leur retention et ALTERE leur
-- contenu au repos pour prouver que le sceau recalcule detecte l'un et l'autre (greffe G4).
-- Concession de certification uniquement — le role applicatif, lui, n'a AUCUN droit d'UPDATE
-- sur cette table (immuabilite) ; la base est jetable.
GRANT SELECT, UPDATE ON TABLE public.jarvis_proposal_payloads TO bob_cert_auditor;
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
JARVIS_PAYLOAD_RETENTION_DIRECTORY_CERT=true \
pnpm --filter @bob/api exec vitest run \
  src/persistence/prisma/agent-mission.persistence.postgres.test.ts \
  src/persistence/prisma/jarvis-run-expand.postgres.test.ts \
  src/persistence/prisma/jarvis-work-items.persistence.postgres.test.ts \
  src/persistence/prisma/jarvis-admission.postgres.test.ts \
  src/persistence/prisma/jarvis-proposal-payloads.postgres.test.ts \
  src/jobs/jarvis-customer-effect.executor.postgres.test.ts \
  src/persistence/prisma/jarvis-oracles.postgres.test.ts \
  src/persistence/prisma/jarvis-u1e.postgres.test.ts

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
