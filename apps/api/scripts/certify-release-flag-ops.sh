#!/usr/bin/env sh
set -eu

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

KEY='cabinet.cert-ops'
ENVIRONMENT='development'
ACTOR='system:release-flag-cert'
REASON='Certification transactionnelle des release flags'
WORKER_ID='79e27b85-d458-445e-a759-e8b1a49e1641'
FIRST_OUTPUT="$(mktemp)"
SECOND_OUTPUT="$(mktemp)"

cleanup() {
  psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
DELETE FROM release_flag_audit_events WHERE "flagId" = 'rls-ops-flag';
DELETE FROM release_flag_audit_events WHERE "flagId" IN ('rls-ops-live-flag', 'rls-ops-bootstrap-flag');
DELETE FROM release_flags WHERE id IN ('rls-ops-flag', 'rls-ops-live-flag', 'rls-ops-bootstrap-flag');
DELETE FROM cabinets WHERE id IN (
  'rls-ops-cabinet', 'rls-ops-delete-race', '44444444-4444-4444-8444-444444444444'
);
COMMIT;
SQL
  rm -f "$FIRST_OUTPUT" "$SECOND_OUTPUT"
}
trap cleanup EXIT INT TERM
cleanup
trap cleanup EXIT INT TERM

psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO release_flags (
  id, key, environment, enabled, "killSwitch", version, "updatedByUserId", "createdAt", "updatedAt"
) VALUES (
  'rls-ops-flag', '$KEY', '$ENVIRONMENT', false, false, 1, '$ACTOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
), (
  'rls-ops-live-flag', 'cabinet.cert-live', 'staging', false, false, 1, '$ACTOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
), (
  'rls-ops-bootstrap-flag', 'cabinet.cert-bootstrap', 'staging', false, false, 1, '$ACTOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO cabinets (
  id, name, "timeZone", status, "createdByUserId", "bootstrapCompletedAt", version, "createdAt", "updatedAt"
) VALUES
  ('rls-ops-cabinet', 'Ops cert', 'Europe/Paris', 'active', '$WORKER_ID', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rls-ops-delete-race', 'Ops delete race', 'Europe/Paris', 'active', '$WORKER_ID', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO cabinet_members (
  id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
) VALUES
  ('rls-ops-worker', 'rls-ops-cabinet', '$WORKER_ID', NULL, 'admin', 'active', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rls-ops-race-worker', 'rls-ops-delete-race', '$WORKER_ID', NULL, 'admin', 'active', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
SQL

run_op() {
  DIRECT_URL="$DIRECT_URL" node apps/api/scripts/release-flag-ops.mjs "$@" \
    --key "$KEY" --environment "$ENVIRONMENT" --actor "$ACTOR" --reason "$REASON" >/dev/null
}

run_op set-global --enabled false --expected-version 1
run_op set-kill-switch --enabled true --expected-version 2
run_op set-subject --enabled true --subject-type cabinet --subject-id rls-ops-cabinet --expected-version 3
run_op set-subject --enabled false --subject-type cabinet --subject-id rls-ops-cabinet --expected-version 4
run_op set-subject --enabled true --subject-type cabinet --subject-id rls-ops-cabinet --expected-version 5
run_op remove-subject --subject-type cabinet --subject-id rls-ops-cabinet --expected-version 6
run_op set-subject --enabled true --subject-type user --subject-id rls-ops-user --expected-version 7
run_op set-subject --enabled false --subject-type user --subject-id rls-ops-user --expected-version 8
run_op remove-subject --subject-type user --subject-id rls-ops-user --expected-version 9

if run_op set-subject --enabled true --subject-type cabinet --subject-id rls-ops-missing --expected-version 10 2>/dev/null; then
  echo "Release flag ops cert accepted a missing cabinet target" >&2
  exit 1
fi

run_op set-kill-switch --enabled false --expected-version 10

run_live_op() {
  BOB_INTERNAL_RELEASE_FLAG_PREFLIGHT_CERT=true \
  CABINET_INVITATION_WORKER_ENABLED="${CERT_WORKER_ENABLED:-false}" \
  CABINET_INVITATION_WORKER_USER_ID="${CERT_WORKER_ID:-}" \
  JOB_CABINET_IDS="${CERT_JOB_CABINETS:-}" \
  DIRECT_URL="$DIRECT_URL" node apps/api/scripts/release-flag-ops.mjs "$@" \
    --key cabinet.cert-live --environment staging --actor "$ACTOR" --reason "$REASON" >/dev/null
}

# Preflight effectif live : unsafe rollback, kill-switch permet la remédiation, sa réouverture
# reste refusée jusqu'à ce que worker + cabinet + membership admin soient tous cohérents.
if run_live_op set-subject --enabled true --subject-type cabinet --subject-id rls-ops-cabinet --expected-version 1 2>/dev/null; then
  echo "Release flag live preflight accepted an uncovered cabinet" >&2
  exit 1
fi
run_live_op set-kill-switch --enabled true --expected-version 1
run_live_op set-subject --enabled true --subject-type cabinet --subject-id rls-ops-cabinet --expected-version 2
if run_live_op set-kill-switch --enabled false --expected-version 3 2>/dev/null; then
  echo "Release flag live preflight reopened an uncovered pilot" >&2
  exit 1
fi
CERT_WORKER_ENABLED=true CERT_WORKER_ID="$WORKER_ID" CERT_JOB_CABINETS=rls-ops-cabinet \
  run_live_op set-kill-switch --enabled false --expected-version 3

psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
BEGIN
  IF (SELECT version FROM release_flags WHERE id = 'rls-ops-live-flag') <> 4 THEN
    RAISE EXCEPTION 'Release flag live preflight: rollback/version mismatch';
  END IF;
  IF (SELECT count(*) FROM release_flag_audit_events WHERE "flagId" = 'rls-ops-live-flag') <> 3 THEN
    RAISE EXCEPTION 'Release flag live preflight: audit mismatch';
  END IF;
END;
$$;
SQL

# Bootstrap pilote audité + idempotent : tenant, fondateur, worker et override dans un COMMIT.
BOOTSTRAP_CABINET='44444444-4444-4444-8444-444444444444'
BOOTSTRAP_FOUNDER='55555555-5555-4555-8555-555555555555'
bootstrap_pilot() {
  BOB_INTERNAL_CABINET_BOOTSTRAP_CERT=true \
  CABINET_INVITATION_WORKER_ENABLED=true \
  CABINET_INVITATION_WORKER_USER_ID="$WORKER_ID" \
  JOB_CABINET_IDS="$BOOTSTRAP_CABINET" \
  DIRECT_URL="$DIRECT_URL" node apps/api/scripts/bootstrap-cabinet-pilot.mjs \
    --cabinet-id "$BOOTSTRAP_CABINET" --name 'Cabinet bootstrap cert' \
    --founder-user-id "$BOOTSTRAP_FOUNDER" --worker-user-id "$WORKER_ID" \
    --environment staging --expected-flag-version 1 --actor "$ACTOR" --reason "$REASON" >/dev/null
}
bootstrap_pilot
bootstrap_pilot

psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
BEGIN
  IF (SELECT version FROM release_flags WHERE id = 'rls-ops-bootstrap-flag') <> 2 THEN
    RAISE EXCEPTION 'Pilot bootstrap cert: idempotency/version mismatch';
  END IF;
  IF (SELECT count(*) FROM cabinet_members WHERE "cabinetId" = '44444444-4444-4444-8444-444444444444') <> 2 THEN
    RAISE EXCEPTION 'Pilot bootstrap cert: membership mismatch';
  END IF;
  IF (SELECT "activeCount" FROM cabinet_admin_guards WHERE "cabinetId" = '44444444-4444-4444-8444-444444444444') <> 2 THEN
    RAISE EXCEPTION 'Pilot bootstrap cert: admin guard mismatch';
  END IF;
  IF (SELECT count(*) FROM release_flag_subjects subject
      WHERE subject."flagId" = 'rls-ops-bootstrap-flag'
        AND subject."subjectId" = '44444444-4444-4444-8444-444444444444' AND subject.enabled) <> 1 THEN
    RAISE EXCEPTION 'Pilot bootstrap cert: override mismatch';
  END IF;
  IF (SELECT count(*) FROM release_flag_audit_events WHERE "flagId" = 'rls-ops-bootstrap-flag') <> 1 THEN
    RAISE EXCEPTION 'Pilot bootstrap cert: release audit mismatch';
  END IF;
END;
$$;
SQL

set +e
(
  run_op set-global --enabled true --expected-version 11 >"$FIRST_OUTPUT" 2>&1
) &
FIRST_PID=$!
(
  run_op set-global --enabled false --expected-version 11 >"$SECOND_OUTPUT" 2>&1
) &
SECOND_PID=$!
wait "$FIRST_PID"
FIRST_STATUS=$?
wait "$SECOND_PID"
SECOND_STATUS=$?
set -e

if [ "$FIRST_STATUS" -eq 0 ] && [ "$SECOND_STATUS" -eq 0 ]; then
  echo "Release flag ops cert lost an expected-version race" >&2
  exit 1
fi
if [ "$FIRST_STATUS" -ne 0 ] && [ "$SECOND_STATUS" -ne 0 ]; then
  echo "Release flag ops cert rejected both serialized mutations" >&2
  exit 1
fi

psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
BEGIN
  IF (SELECT version FROM release_flags WHERE id = 'rls-ops-flag') <> 12 THEN
    RAISE EXCEPTION 'Release flag ops cert: aggregate version mismatch';
  END IF;
  IF (SELECT count(*) FROM release_flag_audit_events WHERE "flagId" = 'rls-ops-flag') <> 11 THEN
    RAISE EXCEPTION 'Release flag ops cert: audit count mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM release_flag_subjects WHERE "flagId" = 'rls-ops-flag') THEN
    RAISE EXCEPTION 'Release flag ops cert: subject removal mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM release_flag_audit_events
     WHERE "flagId" = 'rls-ops-flag'
       AND operation IN ('set-subject', 'remove-subject')
       AND (NOT ("beforeState" ? 'flagVersion') OR NOT ("afterState" ? 'flagVersion'))
  ) THEN
    RAISE EXCEPTION 'Release flag ops cert: subject audit lacks flag versions';
  END IF;
END;
$$;
SQL

# Delete-vs-set : l'ops prend Cabinet→membership ; si DELETE tient déjà Cabinet, l'ops attend puis
# échoue après suppression. Aucun override orphelin et aucun bump/audit ne doivent survivre.
(
  psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
BEGIN;
SELECT id FROM cabinets WHERE id = 'rls-ops-delete-race' FOR UPDATE;
SELECT pg_sleep(1);
DELETE FROM cabinets WHERE id = 'rls-ops-delete-race';
COMMIT;
SQL
) &
DELETE_PID=$!
sleep 0.2
if run_op set-subject --enabled true --subject-type cabinet --subject-id rls-ops-delete-race --expected-version 12 2>/dev/null; then
  echo "Release flag ops cert created an override during cabinet deletion" >&2
  exit 1
fi
wait "$DELETE_PID"

psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM release_flag_subjects
     WHERE "flagId" = 'rls-ops-flag' AND "subjectId" = 'rls-ops-delete-race'
  ) THEN
    RAISE EXCEPTION 'Release flag ops cert: orphan override after delete race';
  END IF;
  IF (SELECT version FROM release_flags WHERE id = 'rls-ops-flag') <> 12 THEN
    RAISE EXCEPTION 'Release flag ops cert: missing target changed aggregate version';
  END IF;
END;
$$;
SQL

echo "Release flag operations certification passed"
