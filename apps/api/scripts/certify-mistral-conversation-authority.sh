#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DATABASE_URL:?DATABASE_URL runtime app-role is required}"
: "${DIRECT_URL:?DIRECT_URL privileged admin URL is required}"

RUN_POSTGRES_MISTRAL_CONVERSATION_CERT=true \
  pnpm --filter @bob/api exec vitest run \
    src/voice/realtime/mistral-conversation-authority.postgres.test.ts \
    src/voice/realtime/mistral-conversation-resume-ticket.postgres.test.ts
