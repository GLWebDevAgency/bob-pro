-- Phase CONTRACT/ACTIVATE du protocole outbox v2.
-- Exécutée uniquement après que /health/ready a prouvé la nouvelle révision Railway.
-- Transition transactionnelle à usage unique. L'opérateur activate-notification-outbox-v2.sh
-- porte l'idempotence : il certifie l'état terminal avant d'appeler ce fichier et refuse toute
-- forme intermédiaire incomplète.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT set_config('app.notification_outbox_cutover_bypass', 'activation', true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'notification_jobs'::regclass
       AND tgname = 'notification_jobs_cutover_spool_v2'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'notification outbox v2 expand trigger is missing; use the idempotent activation operator';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_db_role_setting setting,
           unnest(setting.setconfig) AS configured(value)
     WHERE configured.value LIKE 'app.notification_outbox_version=%'
  ) THEN
    RAISE EXCEPTION 'app.notification_outbox_version must never be persisted with ALTER ROLE/DATABASE';
  END IF;
END;
$$;

-- Bloque brièvement les writers au moment exact où le trigger est retiré et le fence RLS posé.
-- lock_timeout rend l'étape relançable si une transaction historique est encore active.
LOCK TABLE "notification_jobs" IN SHARE ROW EXCLUSIVE MODE;

-- Les payloads impossibles à prouver sont neutralisés avant validation de la contrainte.
UPDATE "notification_jobs"
SET payload = NULL,
    status = 'failed',
    "nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999',
    "leaseToken" = NULL,
    "providerAttemptedAt" = NULL,
    "cutoverResumeAt" = NULL,
    "lastError" = left(
      '[manual-review:invalid-payload] Payload invalide à l''activation v2; rejeu automatique interdit. '
      || coalesce("lastError", ''),
      2000
    ),
    "updatedAt" = statement_timestamp()
WHERE status IN ('pending', 'failed')
  AND NOT coalesce((
    jsonb_typeof(payload) = 'object'
    AND payload->>'channel' IN ('email', 'sms')
    AND payload->>'channel' = channel
    AND jsonb_typeof(payload->'to') = 'string'
    AND payload->>'to' = recipient
    AND jsonb_typeof(payload->'subject') = 'string'
    AND payload->>'subject' = subject
    AND jsonb_typeof(payload->'body') = 'string'
    AND "payloadFingerprint" IS NOT NULL
    AND length("payloadFingerprint") > 0
    AND (
      channel <> 'email'
      OR (
        payload->>'idempotencyKey' = lower(id)
        AND payload->>'idempotencyKey' ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    )
  ), false);

-- Un job terminal ne conserve jamais le contenu sensible du message.
UPDATE "notification_jobs"
SET payload = NULL,
    "leaseToken" = NULL,
    "updatedAt" = statement_timestamp()
WHERE status = 'done' AND (payload IS NOT NULL OR "leaseToken" IS NOT NULL);

-- Les seuls jobs repris automatiquement sont ceux créés pendant le cutover, jamais les legacy.
UPDATE "notification_jobs"
SET "nextAttemptAt" = "cutoverResumeAt",
    "cutoverResumeAt" = NULL,
    "lastError" = NULL,
    "updatedAt" = statement_timestamp()
WHERE "lastError" LIKE '[cutover-spooled:v2]%'
  AND "cutoverResumeAt" IS NOT NULL
  AND payload IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'notification_jobs'::regclass
       AND conname = 'notification_jobs_payload_shape'
  ) THEN
    ALTER TABLE "notification_jobs"
      ADD CONSTRAINT "notification_jobs_payload_shape"
      CHECK (
        payload IS NULL
        OR coalesce((
          jsonb_typeof(payload) = 'object'
          AND payload->>'channel' IN ('email', 'sms')
          AND payload->>'channel' = channel
          AND jsonb_typeof(payload->'to') = 'string'
          AND payload->>'to' = recipient
          AND jsonb_typeof(payload->'subject') = 'string'
          AND payload->>'subject' = subject
          AND jsonb_typeof(payload->'body') = 'string'
          AND "payloadFingerprint" IS NOT NULL
          AND length("payloadFingerprint") > 0
          AND (
            channel <> 'email'
            OR (
              payload->>'idempotencyKey' = lower(id)
              AND payload->>'idempotencyKey' ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
          )
        ), false)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'notification_jobs'::regclass
       AND conname = 'notification_jobs_lease_shape'
  ) THEN
    ALTER TABLE "notification_jobs"
      ADD CONSTRAINT "notification_jobs_lease_shape"
      CHECK (
        "leaseToken" IS NULL
        OR (
          payload IS NOT NULL
          AND "providerAttemptedAt" IS NOT NULL
          AND status IN ('pending', 'failed')
        )
      ) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE "notification_jobs" VALIDATE CONSTRAINT "notification_jobs_payload_shape";
ALTER TABLE "notification_jobs" VALIDATE CONSTRAINT "notification_jobs_lease_shape";

DROP TRIGGER IF EXISTS notification_jobs_cutover_spool_v2 ON "notification_jobs";
-- La fonction reste installée sans trigger : le runbook de rollback peut réarmer le spool
-- atomiquement avant de remettre une révision N-1 en ligne.
ALTER TABLE "notification_jobs" DROP COLUMN IF EXISTS "cutoverResumeAt";

DROP POLICY IF EXISTS tenant_isolation ON "notification_jobs";
CREATE POLICY tenant_isolation ON "notification_jobs"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND current_setting('app.notification_outbox_version', true) = '2'
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND current_setting('app.notification_outbox_version', true) = '2'
  );

COMMIT;

SELECT
  count(*) FILTER (WHERE "lastError" LIKE '[manual-review:%') AS manual_review_jobs,
  count(*) FILTER (WHERE status IN ('pending', 'failed') AND "nextAttemptAt" < TIMESTAMP '9999-01-01') AS retryable_jobs
FROM "notification_jobs";
