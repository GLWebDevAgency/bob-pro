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
    FROM pg_catalog.pg_index AS catalog_index
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = catalog_index.indexrelid
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
   WHERE catalog_index.indrelid = 'public.notification_jobs'::regclass
     AND index_namespace.nspname = 'public'
     AND index_relation.relname = :'index_name'
     AND (
       NOT catalog_index.indisvalid
       OR NOT catalog_index.indisready
       OR NOT catalog_index.indislive
     )
) THEN 'true' ELSE 'false' END;
SQL
}

indexes_are_verified() {
  psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT CASE WHEN
  EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS catalog_index
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = catalog_index.indexrelid
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_relation.relnamespace
     WHERE catalog_index.indrelid = 'public.notification_jobs'::regclass
       AND index_namespace.nspname = 'public'
       AND index_relation.relname = 'notification_jobs_due_deliverable_idx'
       AND catalog_index.indisvalid
       AND catalog_index.indisready
       AND catalog_index.indislive
       AND NOT catalog_index.indisunique
       AND catalog_index.indnkeyatts = 3
       AND catalog_index.indnatts = 3
       AND catalog_index.indoption::TEXT = '0 0 0'
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 1, false) = '"companyId"'
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 2, false) = '"nextAttemptAt"'
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 3, false) = '"createdAt"'
       AND pg_catalog.pg_get_expr(catalog_index.indpred, catalog_index.indrelid) =
         '((status = ANY (ARRAY[''pending''::text, ''failed''::text])) AND (payload IS NOT NULL))'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS catalog_index
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = catalog_index.indexrelid
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_relation.relnamespace
     WHERE catalog_index.indrelid = 'public.notification_jobs'::regclass
       AND index_namespace.nspname = 'public'
       AND index_relation.relname = 'notification_jobs_recent_idx'
       AND catalog_index.indisvalid
       AND catalog_index.indisready
       AND catalog_index.indislive
       AND NOT catalog_index.indisunique
       AND catalog_index.indnkeyatts = 2
       AND catalog_index.indnatts = 2
       AND catalog_index.indoption::TEXT = '0 3'
       AND catalog_index.indpred IS NULL
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 1, false) = '"companyId"'
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 2, false) = '"createdAt"'
  )
THEN 'true' ELSE 'false' END;
SQL
}

constraints_match_expected() {
  psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 -v require_all="$1" <<'SQL'
WITH expected_constraint(conname, definition) AS (
  VALUES
    (
      'notification_jobs_payload_shape',
      $payload_shape$CHECK (((payload IS NULL) OR COALESCE(((jsonb_typeof(payload) = 'object'::text) AND ((payload ->> 'channel'::text) = ANY (ARRAY['email'::text, 'sms'::text])) AND ((payload ->> 'channel'::text) = channel) AND (jsonb_typeof((payload -> 'to'::text)) = 'string'::text) AND ((payload ->> 'to'::text) = recipient) AND (jsonb_typeof((payload -> 'subject'::text)) = 'string'::text) AND ((payload ->> 'subject'::text) = subject) AND (jsonb_typeof((payload -> 'body'::text)) = 'string'::text) AND ("payloadFingerprint" IS NOT NULL) AND (length("payloadFingerprint") > 0) AND ((channel <> 'email'::text) OR (((payload ->> 'idempotencyKey'::text) = lower(id)) AND ((payload ->> 'idempotencyKey'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)))), false)))$payload_shape$
    ),
    (
      'notification_jobs_lease_shape',
      $lease_shape$CHECK ((("leaseToken" IS NULL) OR ((payload IS NOT NULL) AND ("providerAttemptedAt" IS NOT NULL) AND (status = ANY (ARRAY['pending'::"NotificationJobStatus", 'failed'::"NotificationJobStatus"])))))$lease_shape$
    )
),
actual_constraint AS (
  SELECT
    table_constraint.conname,
    table_constraint.contype,
    table_constraint.convalidated,
    pg_catalog.pg_get_constraintdef(table_constraint.oid, false) AS definition
  FROM pg_catalog.pg_constraint AS table_constraint
  JOIN expected_constraint
    ON expected_constraint.conname = table_constraint.conname
  WHERE table_constraint.conrelid = 'public.notification_jobs'::regclass
)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1
    FROM actual_constraint
    JOIN expected_constraint USING (conname)
    WHERE actual_constraint.contype <> 'c'
       OR actual_constraint.definition <> expected_constraint.definition
  )
  AND (
    :'require_all' <> 'true'
    OR (
      SELECT count(*)
      FROM actual_constraint
      JOIN expected_constraint USING (conname)
      WHERE actual_constraint.contype = 'c'
        AND actual_constraint.convalidated
        AND actual_constraint.definition = expected_constraint.definition
    ) = 2
  )
THEN 'true' ELSE 'false' END;
SQL
}

activation_is_verified() {
  if [ "$(constraints_match_expected true)" != "true" ]; then
    printf '%s\n' false
    return
  fi
  psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
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
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS catalog_index
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = catalog_index.indexrelid
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_relation.relnamespace
     WHERE catalog_index.indrelid = 'public.notification_jobs'::regclass
       AND index_namespace.nspname = 'public'
       AND index_relation.relname = 'notification_jobs_due_deliverable_idx'
       AND catalog_index.indisvalid
       AND catalog_index.indisready
       AND catalog_index.indislive
       AND NOT catalog_index.indisunique
       AND catalog_index.indnkeyatts = 3
       AND catalog_index.indnatts = 3
       AND catalog_index.indoption::TEXT = '0 0 0'
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 1, false) = '"companyId"'
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 2, false) = '"nextAttemptAt"'
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 3, false) = '"createdAt"'
       AND pg_catalog.pg_get_expr(catalog_index.indpred, catalog_index.indrelid) =
         '((status = ANY (ARRAY[''pending''::text, ''failed''::text])) AND (payload IS NOT NULL))'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS catalog_index
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = catalog_index.indexrelid
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_relation.relnamespace
     WHERE catalog_index.indrelid = 'public.notification_jobs'::regclass
       AND index_namespace.nspname = 'public'
       AND index_relation.relname = 'notification_jobs_recent_idx'
       AND catalog_index.indisvalid
       AND catalog_index.indisready
       AND catalog_index.indislive
       AND NOT catalog_index.indisunique
       AND catalog_index.indnkeyatts = 2
       AND catalog_index.indnatts = 2
       AND catalog_index.indoption::TEXT = '0 3'
       AND catalog_index.indpred IS NULL
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 1, false) = '"companyId"'
       AND pg_catalog.pg_get_indexdef(catalog_index.indexrelid, 2, false) = '"createdAt"'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = 'public.notification_jobs'::regclass
       AND policy.polname = 'tenant_isolation'
       AND policy.polpermissive
       AND policy.polcmd = '*'
       AND policy.polroles = ARRAY[0::OID]
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) =
         '(("companyId" = current_setting(''app.current_company_id''::text, true)) AND (current_setting(''app.notification_outbox_version''::text, true) = ''2''::text))'
       AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) =
         '(("companyId" = current_setting(''app.current_company_id''::text, true)) AND (current_setting(''app.notification_outbox_version''::text, true) = ''2''::text))'
  )
THEN 'true' ELSE 'false' END;
SQL
}

cutover_shape() {
  psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT format(
  '%s|%s',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'notification_jobs'::regclass
       AND tgname = 'notification_jobs_cutover_spool_v2'
       AND NOT tgisinternal
  ) THEN 'trigger' ELSE 'no-trigger' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'notification_jobs'
       AND column_name = 'cutoverResumeAt'
  ) THEN 'column' ELSE 'no-column' END
);
SQL
}

if [ "$(activation_is_verified)" = "true" ]; then
  echo "Notification outbox v2 already activated and certified"
  exit 0
fi

if [ "$(cutover_shape)" != "trigger|column" ]; then
  echo "notification outbox v2 has neither a certified active shape nor a complete expand shape" >&2
  exit 1
fi

if [ "$(constraints_match_expected false)" != "true" ]; then
  echo "notification outbox v2 constraint definition drift blocks activation" >&2
  exit 1
fi

if [ "$(index_is_invalid notification_jobs_due_deliverable_idx)" = "true" ]; then
  PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' \
    psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
      -c 'DROP INDEX CONCURRENTLY IF EXISTS public."notification_jobs_due_deliverable_idx"'
fi
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' \
  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_jobs_due_deliverable_idx" ON public."notification_jobs" ("companyId", "nextAttemptAt", "createdAt") WHERE status IN ('"'"'pending'"'"', '"'"'failed'"'"') AND payload IS NOT NULL'

if [ "$(index_is_invalid notification_jobs_recent_idx)" = "true" ]; then
  PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' \
    psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
      -c 'DROP INDEX CONCURRENTLY IF EXISTS public."notification_jobs_recent_idx"'
fi
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' \
  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_jobs_recent_idx" ON public."notification_jobs" ("companyId", "createdAt" DESC)'

if [ "$(indexes_are_verified)" != "true" ]; then
  echo "notification outbox v2 index definition certification failed before activation" >&2
  exit 1
fi

psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/notification-outbox-v2-activate.sql

if [ "$(activation_is_verified)" != "true" ]; then
  echo "notification outbox v2 activation certification failed" >&2
  exit 1
fi

echo "Notification outbox v2 activated and certified"
