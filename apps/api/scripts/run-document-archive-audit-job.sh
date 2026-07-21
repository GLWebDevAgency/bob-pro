#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

. apps/api/scripts/lib/preserve-cleanup-status.sh

: "${RAILWAY_DEPLOYMENT_ID:?RAILWAY_DEPLOYMENT_ID is required}"
: "${RAILWAY_GIT_COMMIT_SHA:?RAILWAY_GIT_COMMIT_SHA is required}"
: "${DIRECT_URL:?DIRECT_URL privileged audit URL is required}"
: "${DATABASE_URL:?DATABASE_URL runtime URL is required}"
: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF:?DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
: "${DOCUMENT_ARCHIVE_MUSTANG_JAR:?Bundled Mustang validator is required}"
: "${DOCUMENT_ARCHIVE_FNFE_BUNDLE:?Bundled FNFE rules are required}"
: "${DOCUMENT_ARCHIVE_VALIDATOR_SANDBOX:?Validator sandbox is required}"

case "$RAILWAY_GIT_COMMIT_SHA" in
  *[!0-9a-f]*|'')
    echo "RAILWAY_GIT_COMMIT_SHA must be a lowercase hexadecimal SHA" >&2
    exit 1
    ;;
esac
if [ "${#RAILWAY_GIT_COMMIT_SHA}" -ne 40 ]; then
  echo "RAILWAY_GIT_COMMIT_SHA must contain exactly 40 characters" >&2
  exit 1
fi

work_dir="$(mktemp -d /tmp/bob-document-archive-audit.XXXXXX)"
cleanup_archive_audit_job() {
  rm -rf "$work_dir"
}

cleanup_archive_audit_job_on_exit() {
  original_status=$?
  trap - EXIT HUP INT TERM
  preserve_exit_status_after_cleanup "$original_status" cleanup_archive_audit_job
}

audit_pid=''
forward_archive_audit_signal() {
  signal_name="$1"
  signal_status="$2"

  # PID 1 doit rester vivant jusqu'à ce que Node ait réellement libéré ses connexions et le
  # verrou advisory PostgreSQL. Les signaux suivants sont ignorés pendant cette courte phase ;
  # l'orchestrateur conserve toujours son dernier recours SIGKILL sur le conteneur entier.
  trap '' HUP INT TERM
  if [ -n "$audit_pid" ] && kill -0 "$audit_pid" 2>/dev/null; then
    kill -"$signal_name" "$audit_pid" 2>/dev/null || true
    wait "$audit_pid" 2>/dev/null || true
  fi
  exit "$signal_status"
}

trap cleanup_archive_audit_job_on_exit EXIT
trap 'forward_archive_audit_signal HUP 129' HUP
trap 'forward_archive_audit_signal INT 130' INT
trap 'forward_archive_audit_signal TERM 143' TERM

export RELEASE_SHA="$RAILWAY_GIT_COMMIT_SHA"
export DOCUMENT_ARCHIVE_AUDIT_DEPLOYMENT_ID="$RAILWAY_DEPLOYMENT_ID"
export DOCUMENT_ARCHIVE_AUDIT_OUTPUT="$work_dir/report.json"
export DOCUMENT_ARCHIVE_AUDIT_APPLY_ATTESTATIONS=true

node apps/api/dist/document-archive-audit.main.js &
audit_pid=$!
if wait "$audit_pid"; then
  audit_status=0
else
  audit_status=$?
fi
audit_pid=''
exit "$audit_status"
