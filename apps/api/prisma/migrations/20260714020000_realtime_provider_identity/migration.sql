-- Bob Live — identité durable du provider pour permettre OpenAI et Mistral sans collision.
-- Migration corrective après le hardening acoustique : une session déjà liée était forcément
-- OpenAI avant l'introduction de cette colonne. Les réservations non liées restent provider-less.

BEGIN;

ALTER TABLE "realtime_session_leases"
  ADD COLUMN "providerId" TEXT;

UPDATE "realtime_session_leases"
   SET "providerId" = 'openai'
 WHERE "providerCallId" IS NOT NULL;

ALTER TABLE "realtime_session_leases"
  DROP CONSTRAINT "realtime_session_leases_provider_call_id_key",
  DROP CONSTRAINT "realtime_session_leases_state_shape_check",
  ADD CONSTRAINT "realtime_session_leases_provider_id_check"
    CHECK ("providerId" IS NULL OR "providerId" IN ('openai', 'mistral')),
  ADD CONSTRAINT "realtime_session_leases_provider_call_identity_key"
    UNIQUE ("providerId", "providerCallId"),
  ADD CONSTRAINT "realtime_session_leases_state_shape_check"
    CHECK (
      (
        "state" = 'reserved'
        AND "providerId" IS NULL
        AND "providerCallId" IS NULL
        AND "reaperTokenHash" IS NULL
        AND "activatedAt" IS NULL
      )
      OR (
        "state" = 'bound'
        AND "providerId" IS NOT NULL
        AND "providerCallId" IS NOT NULL
        AND "reaperTokenHash" IS NULL
        AND "activatedAt" IS NULL
      )
      OR (
        "state" = 'active'
        AND "providerId" IS NOT NULL
        AND "providerCallId" IS NOT NULL
        AND "reaperTokenHash" IS NULL
        AND "activatedAt" IS NOT NULL
      )
      OR (
        "state" = 'reaping'
        AND "providerId" IS NOT NULL
        AND "providerCallId" IS NOT NULL
        AND "reaperTokenHash" IS NOT NULL
      )
    );

-- Après le bind initial, l'identité distante est immuable. Elle doit rester exactement la même
-- pendant activate/renew/reaping afin qu'une réplique ne puisse jamais terminer le mauvais appel.
CREATE FUNCTION guard_realtime_provider_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."providerId" IS NULL AND OLD."providerCallId" IS NULL THEN
    IF NEW."providerId" IS NOT NULL OR NEW."providerCallId" IS NOT NULL THEN
      IF OLD."state" <> 'reserved'
        OR NEW."state" <> 'bound'
        OR NEW."providerId" IS NULL
        OR NEW."providerCallId" IS NULL
      THEN
        RAISE EXCEPTION 'provider identity must be bound atomically from reserved state'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."providerId" IS DISTINCT FROM OLD."providerId"
    OR NEW."providerCallId" IS DISTINCT FROM OLD."providerCallId"
  THEN
    RAISE EXCEPTION 'bound provider identity is immutable' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_session_leases_provider_identity_guard
BEFORE UPDATE OF "providerId", "providerCallId", "state"
ON "realtime_session_leases"
FOR EACH ROW
EXECUTE FUNCTION guard_realtime_provider_identity();

COMMIT;
