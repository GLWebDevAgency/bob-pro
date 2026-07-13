#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DATABASE_URL:?DATABASE_URL runtime app-role is required}"
: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
: "${RUN_RLS_CERT:?RUN_RLS_CERT=true is required}"
: "${RLS_CERT_CLEANUP:?RLS_CERT_CLEANUP=true is required}"

if [ "$RUN_RLS_CERT" != "true" ] || [ "$RLS_CERT_CLEANUP" != "true" ]; then
  echo "RUN_RLS_CERT=true and RLS_CERT_CLEANUP=true are mandatory" >&2
  exit 1
fi

cleanup_rls_cert() {
  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert-cleanup.sql
}

grant_app_role() {
  if [ -z "${APP_DATABASE_ROLE:-}" ]; then
    echo "APP_DATABASE_ROLE unset; skipping explicit runtime grants"
    return 0
  fi

  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -v app_role="$APP_DATABASE_ROLE" <<'SQL'
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
-- Ces registres sont append-only pour le role runtime. Les policies RLS seules ne
-- suffisent pas : un futur changement de policy ne doit pas reactiver leur mutation.
REVOKE UPDATE, DELETE ON TABLE public.document_analyses, public.expense_creation_requests FROM :"app_role";
REVOKE DELETE ON TABLE public.realtime_speech_artifacts FROM :"app_role";
REVOKE UPDATE, DELETE ON TABLE
  public.realtime_control_grants,
  public.realtime_control_consumptions,
  public.realtime_voice_usage_events
FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE ON TABLE public.realtime_voice_usage_daily FROM :"app_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
SQL
}

certify_cabinet_worker_scope() {
  : "${CABINET_RELEASE_ENV:?CABINET_RELEASE_ENV is required}"
  : "${CABINET_INVITATION_WORKER_ENABLED:?CABINET_INVITATION_WORKER_ENABLED is required}"
  local_job_ids="${JOB_CABINET_IDS:-}"
  local_worker_id="${CABINET_INVITATION_WORKER_USER_ID:-}"
  distinct_job_count="$(printf '%s' "$local_job_ids" | tr ',' '\n' | awk '
    { gsub(/^[[:space:]]+|[[:space:]]+$/, "") }
    NF && !seen[$0]++ { count += 1 }
    END { print count + 0 }
  ')"
  if [ "$distinct_job_count" -gt 100 ]; then
    echo "JOB_CABINET_IDS is limited to 100 distinct pilot cabinets" >&2
    return 1
  fi
  if [ "$CABINET_INVITATION_WORKER_ENABLED" = "true" ]; then
    if [ -z "$local_job_ids" ] || [ -z "$local_worker_id" ]; then
      echo "enabled Cabinet worker requires JOB_CABINET_IDS and CABINET_INVITATION_WORKER_USER_ID" >&2
      return 1
    fi
  elif [ "$CABINET_INVITATION_WORKER_ENABLED" = "false" ]; then
    local_job_ids=""
    local_worker_id=""
  else
    echo "CABINET_INVITATION_WORKER_ENABLED must be true or false" >&2
    return 1
  fi

  invalid_global="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 -v release_env="$CABINET_RELEASE_ENV" <<'SQL'
SELECT count(*) FROM release_flags
 WHERE key = 'cabinet.slice0'
   AND environment = :'release_env'::"ReleaseEnvironment"
   AND enabled = true;
SQL
)"
  if [ "$invalid_global" != "0" ]; then
    echo "cabinet.slice0 global enablement is forbidden while outbox retention is pilot-scoped" >&2
    return 1
  fi

  invalid_targets="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -v release_env="$CABINET_RELEASE_ENV" -v job_ids="$local_job_ids" -v worker_id="$local_worker_id" <<'SQL'
SELECT count(*)
  FROM release_flag_subjects subject
  JOIN release_flags flag ON flag.id = subject."flagId"
 WHERE flag.key = 'cabinet.slice0'
   AND flag.environment = :'release_env'::"ReleaseEnvironment"
   AND subject.enabled = true
   AND (
     subject."subjectType" <> 'cabinet'
     OR NOT (subject."subjectId" = ANY(string_to_array(:'job_ids', ',')))
     OR NOT EXISTS (
       SELECT 1 FROM cabinets cabinet
       JOIN cabinet_members member ON member."cabinetId" = cabinet.id
        WHERE cabinet.id = subject."subjectId"
          AND cabinet.status = 'active'
          AND member."userId" = :'worker_id'
          AND member.role = 'admin'
          AND member.status = 'active'
     )
   );
SQL
)"
  if [ "$invalid_targets" != "0" ]; then
    echo "enabled cabinet pilots must be worker-covered cabinets with an active service admin" >&2
    return 1
  fi

  if [ "$CABINET_INVITATION_WORKER_ENABLED" = "true" ]; then
    invalid_jobs="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
      -v job_ids="$local_job_ids" -v worker_id="$local_worker_id" <<'SQL'
SELECT count(*)
  FROM unnest(string_to_array(:'job_ids', ',')) AS configured("cabinetId")
 WHERE btrim(configured."cabinetId") <> ''
   AND NOT EXISTS (
     SELECT 1 FROM cabinets cabinet
     JOIN cabinet_members member ON member."cabinetId" = cabinet.id
      WHERE cabinet.id = btrim(configured."cabinetId")
        AND cabinet.status = 'active'
        AND member."userId" = :'worker_id'
        AND member.role = 'admin'
        AND member.status = 'active'
   );
SQL
)"
    if [ "$invalid_jobs" != "0" ]; then
      echo "every JOB_CABINET_IDS entry requires an active ADMIN worker membership" >&2
      return 1
    fi
  fi
}

command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

pnpm --filter @bob/api exec prisma migrate deploy
grant_app_role
psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f apps/api/prisma/rls.sql

trap cleanup_rls_cert EXIT INT TERM
cleanup_rls_cert
node apps/api/scripts/bootstrap-cabinet-pilots.mjs
certify_cabinet_worker_scope
DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/certify-cabinet-concurrency.sh
DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/certify-release-flag-ops.sh
psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert-cabinet-seed.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert.sql
psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/cabinet-rls-cert-privileged.sql
cleanup_rls_cert
trap - EXIT INT TERM

echo "Bob Pro API release checks passed"
