#!/usr/bin/env sh
set -eu

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }

FIRST_OUTPUT="$(mktemp)"
SECOND_OUTPUT="$(mktemp)"

cleanup() {
  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
DELETE FROM cabinets WHERE id = 'rls-concurrency-cabinet';
COMMIT;
SQL
  rm -f "$FIRST_OUTPUT" "$SECOND_OUTPUT"
}
trap cleanup EXIT INT TERM

cleanup
trap cleanup EXIT INT TERM

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO cabinets (
  id, name, "timeZone", status, "createdByUserId", "bootstrapCompletedAt", version, "createdAt", "updatedAt"
) VALUES (
  'rls-concurrency-cabinet', 'Concurrency cert', 'Europe/Paris', 'active', 'rls-concurrency-admin-a',
  CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO cabinet_members (
  id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
) VALUES
  ('rls-concurrency-admin-a', 'rls-concurrency-cabinet', 'rls-concurrency-user-a', NULL, 'admin', 'active', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rls-concurrency-admin-b', 'rls-concurrency-cabinet', 'rls-concurrency-user-b', NULL, 'admin', 'active', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
SQL

set +e
(
  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 >"$FIRST_OUTPUT" 2>&1 <<'SQL'
BEGIN;
UPDATE cabinet_members
   SET status = 'revoked', "revokedAt" = CURRENT_TIMESTAMP, version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-concurrency-admin-a';
SELECT pg_sleep(1);
COMMIT;
SQL
) &
FIRST_PID=$!
(
  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 >"$SECOND_OUTPUT" 2>&1 <<'SQL'
BEGIN;
UPDATE cabinet_members
   SET status = 'revoked', "revokedAt" = CURRENT_TIMESTAMP, version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-concurrency-admin-b';
SELECT pg_sleep(1);
COMMIT;
SQL
) &
SECOND_PID=$!

wait "$FIRST_PID"
FIRST_STATUS=$?
wait "$SECOND_PID"
SECOND_STATUS=$?
set -e

if grep -q 'deadlock detected' "$FIRST_OUTPUT" "$SECOND_OUTPUT"; then
  echo "Cabinet last-admin concurrency cert detected a deadlock" >&2
  exit 1
fi
if [ "$FIRST_STATUS" -eq 0 ] && [ "$SECOND_STATUS" -eq 0 ]; then
  echo "Cabinet last-admin concurrency cert allowed both revocations" >&2
  exit 1
fi
if [ "$FIRST_STATUS" -ne 0 ] && [ "$SECOND_STATUS" -ne 0 ]; then
  echo "Cabinet last-admin concurrency cert rejected both revocations" >&2
  exit 1
fi
if ! grep -q 'cannot revoke or demote the last active cabinet admin' "$FIRST_OUTPUT" "$SECOND_OUTPUT"; then
  echo "Cabinet last-admin concurrency cert failed for an unexpected reason" >&2
  exit 1
fi

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM cabinet_members
       WHERE "cabinetId" = 'rls-concurrency-cabinet' AND role = 'admin' AND status = 'active') <> 1 THEN
    RAISE EXCEPTION 'Cabinet concurrency cert: expected exactly one active admin';
  END IF;
  IF (SELECT "activeCount" FROM cabinet_admin_guards WHERE "cabinetId" = 'rls-concurrency-cabinet') <> 1 THEN
    RAISE EXCEPTION 'Cabinet concurrency cert: serialized guard is inconsistent';
  END IF;
END;
$$;
SQL

echo "Cabinet last-admin concurrency certification passed"
