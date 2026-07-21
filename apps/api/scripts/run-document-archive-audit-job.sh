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

trap cleanup_archive_audit_job_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export RELEASE_SHA="$RAILWAY_GIT_COMMIT_SHA"
export DOCUMENT_ARCHIVE_AUDIT_DEPLOYMENT_ID="$RAILWAY_DEPLOYMENT_ID"
export DOCUMENT_ARCHIVE_AUDIT_OUTPUT="$work_dir/report.json"
export DOCUMENT_ARCHIVE_AUDIT_APPLY_ATTESTATIONS=true

node apps/api/dist/document-archive-audit.main.js
