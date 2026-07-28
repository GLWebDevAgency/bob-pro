#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${BOB_RELEASE_SHA:?BOB_RELEASE_SHA exact 40-char release SHA is required}"
: "${BOB_RELEASE_RUN_ID:?BOB_RELEASE_RUN_ID is required}"
: "${BOB_RELEASE_RUN_ATTEMPT:?BOB_RELEASE_RUN_ATTEMPT is required}"
: "${BOB_RELEASE_EXPECTED_ENV:?BOB_RELEASE_EXPECTED_ENV is required}"

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

# Cette vérification et les trois activations partagent le même processus `railway run`, donc le
# même snapshot de DATABASE_URL/DIRECT_URL, de cible et de configuration. Aucun cutover ne peut
# commencer sur une base ou une configuration différente de celle certifiée au predeploy.
node apps/api/scripts/assert-database-pair.mjs
node apps/api/scripts/release-phase-receipt.mjs verify

DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA="$BOB_RELEASE_SHA" \
  sh apps/api/scripts/activate-document-archive-v2.sh
INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA="$BOB_RELEASE_SHA" \
  sh apps/api/scripts/activate-invoice-settlement-v2.sh
sh apps/api/scripts/activate-notification-outbox-v2.sh

echo "Bob Pro API release protocols V2 activated from the certified predeploy receipt"
