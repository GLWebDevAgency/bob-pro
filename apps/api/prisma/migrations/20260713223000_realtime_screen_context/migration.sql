-- Bob Live — contexte d'écran durable, éphémère et strictement lié au bail realtime.
-- Le JSON est déjà validé/assaini par @bob/ai ; le digest fence les retries de même révision.

ALTER TABLE "realtime_session_leases"
  ADD COLUMN "contextSchemaVersion" INTEGER,
  ADD COLUMN "contextRevision" INTEGER,
  ADD COLUMN "contextPayload" JSONB,
  ADD COLUMN "contextDigest" CHAR(64),
  ADD COLUMN "contextUpdatedAt" TIMESTAMPTZ;

ALTER TABLE "realtime_session_leases"
  ADD CONSTRAINT "realtime_session_leases_context_shape_check"
  CHECK (
    (
      "contextSchemaVersion" IS NULL
      AND "contextRevision" IS NULL
      AND "contextPayload" IS NULL
      AND "contextDigest" IS NULL
      AND "contextUpdatedAt" IS NULL
    )
    OR (
      "contextSchemaVersion" IS NOT NULL
      AND "contextSchemaVersion" = 1
      AND "contextRevision" IS NOT NULL
      AND "contextRevision" > 0
      AND "contextPayload" IS NOT NULL
      AND jsonb_typeof("contextPayload") = 'object'
      AND "contextDigest" IS NOT NULL
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
      AND "contextUpdatedAt" IS NOT NULL
      AND "contextUpdatedAt" >= "reservedAt"
    )
  );

COMMENT ON COLUMN "realtime_session_leases"."contextPayload" IS
  'AgentContext v1 assaini; donnée UI non fiable, jamais une autorisation métier.';
COMMENT ON COLUMN "realtime_session_leases"."contextDigest" IS
  'SHA-256 des octets JSON canoniques pour idempotence exacte à révision égale.';
