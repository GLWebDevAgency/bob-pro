#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }

index_is_invalid() {
  psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 -v index_name="$1" <<'SQL'
SELECT CASE WHEN EXISTS (
  SELECT 1
    FROM pg_index idx
    JOIN pg_class index_class ON index_class.oid = idx.indexrelid
   WHERE index_class.relname = :'index_name'
     AND NOT idx.indisvalid
) THEN 'true' ELSE 'false' END;
SQL
}

if [ "$(index_is_invalid notification_jobs_due_deliverable_idx)" = "true" ]; then
  PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' \
    psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
      -c 'DROP INDEX CONCURRENTLY IF EXISTS "notification_jobs_due_deliverable_idx"'
fi
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' \
  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_jobs_due_deliverable_idx" ON "notification_jobs" ("companyId", "nextAttemptAt", "createdAt") WHERE status IN ('"'"'pending'"'"', '"'"'failed'"'"') AND payload IS NOT NULL'

if [ "$(index_is_invalid notification_jobs_recent_idx)" = "true" ]; then
  PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' \
    psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
      -c 'DROP INDEX CONCURRENTLY IF EXISTS "notification_jobs_recent_idx"'
fi
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' \
  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_jobs_recent_idx" ON "notification_jobs" ("companyId", "createdAt" DESC)'

psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/notification-outbox-v2-activate.sql

verified="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'notification_jobs'::regclass
       AND tgname = 'notification_jobs_cutover_spool_v2'
       AND NOT tgisinternal
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'notification_jobs'
       AND column_name = 'cutoverResumeAt'
  )
  AND (SELECT count(*) FROM pg_constraint
        WHERE conrelid = 'notification_jobs'::regclass
          AND conname IN ('notification_jobs_payload_shape', 'notification_jobs_lease_shape')
          AND convalidated) = 2
  AND (SELECT count(*) FROM pg_index idx
       JOIN pg_class index_class ON index_class.oid = idx.indexrelid
       WHERE index_class.relname IN ('notification_jobs_due_deliverable_idx', 'notification_jobs_recent_idx')
         AND idx.indisvalid) = 2
  AND pg_get_expr(
    (SELECT polqual FROM pg_policy
      WHERE polrelid = 'notification_jobs'::regclass AND polname = 'tenant_isolation'),
    'notification_jobs'::regclass
  ) LIKE '%notification_outbox_version%'
THEN 'true' ELSE 'false' END;
SQL
)"

if [ "$verified" != "true" ]; then
  echo "notification outbox v2 activation certification failed" >&2
  exit 1
fi

echo "Notification outbox v2 activated and certified"
