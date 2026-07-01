#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DATABASE_URL:?DATABASE_URL runtime app-role is required}"
: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"

cleanup_rls_cert() {
  if [ "${RLS_CERT_CLEANUP:-true}" = "false" ]; then
    return 0
  fi
  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert-cleanup.sql
}

grant_app_role() {
  if [ -z "${APP_DATABASE_ROLE:-}" ]; then
    echo "APP_DATABASE_ROLE unset; skipping explicit runtime grants"
    return 0
  fi

  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -v app_role="$APP_DATABASE_ROLE" <<'SQL'
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
SQL
}

command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }

pnpm --filter @bob/api exec prisma migrate deploy
grant_app_role
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f apps/api/prisma/rls.sql

if [ "${RUN_RLS_CERT:-true}" != "false" ]; then
  trap cleanup_rls_cert EXIT INT TERM
  cleanup_rls_cert
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert.sql
  cleanup_rls_cert
  trap - EXIT INT TERM
else
  echo "RUN_RLS_CERT=false; skipping runtime RLS certification"
fi

echo "Bob Pro API release checks passed"
