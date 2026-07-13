#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }

psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/notification-outbox-v2-deactivate.sql

verified="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT CASE WHEN
  EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'notification_jobs'::regclass
       AND tgname = 'notification_jobs_cutover_spool_v2'
       AND NOT tgisinternal
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'notification_jobs'
       AND column_name = 'cutoverResumeAt'
  )
  AND pg_get_expr(
    (SELECT polqual FROM pg_policy
      WHERE polrelid = 'notification_jobs'::regclass AND polname = 'tenant_isolation'),
    'notification_jobs'::regclass
  ) NOT LIKE '%notification_outbox_version%'
  AND NOT EXISTS (
    SELECT 1 FROM notification_jobs
     WHERE status IN ('pending', 'failed')
       AND "nextAttemptAt" < TIMESTAMP '9999-12-31 23:59:59.999'
  )
THEN 'true' ELSE 'false' END;
SQL
)"

if [ "$verified" != "true" ]; then
  echo "notification outbox v2 rollback spool certification failed" >&2
  exit 1
fi

echo "Notification outbox v2 safely spooled for N-1 rollback"
