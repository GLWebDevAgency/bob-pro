-- Rollback opérationnel fail-closed : exécuter AVANT de remettre une révision N-1 en ligne.
-- Les opérations métier continuent à pouvoir créer des jobs, mais toute livraison est spoulée.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT set_config('app.notification_outbox_cutover_bypass', 'activation', true);

LOCK TABLE "notification_jobs" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "notification_jobs" ADD COLUMN IF NOT EXISTS "cutoverResumeAt" TIMESTAMP(3);

-- Un résultat provider déjà tenté devient indémontrable pour N-1 : quarantaine, jamais reprise.
UPDATE "notification_jobs"
SET status = 'failed',
    "nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999',
    "leaseToken" = NULL,
    "cutoverResumeAt" = NULL,
    "lastError" = '[manual-review:rollback-provider-outcome-uncertain] Rollback N-1; rejeu automatique interdit.',
    "updatedAt" = statement_timestamp()
WHERE status IN ('pending', 'failed')
  AND "providerAttemptedAt" IS NOT NULL;

-- Les jobs jamais soumis au provider sont repris à la prochaine activation v2.
UPDATE "notification_jobs"
SET "cutoverResumeAt" = "nextAttemptAt",
    "nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999',
    "leaseToken" = NULL,
    "lastError" = '[cutover-spooled:v2] Livraison suspendue pour rollback applicatif N-1.',
    "updatedAt" = statement_timestamp()
WHERE status IN ('pending', 'failed')
  AND "providerAttemptedAt" IS NULL
  AND payload IS NOT NULL
  AND "nextAttemptAt" < TIMESTAMP '9999-12-31 23:59:59.999';

DO $$
BEGIN
  IF to_regprocedure('notification_jobs_spool_v2_cutover()') IS NULL THEN
    RAISE EXCEPTION 'notification_jobs_spool_v2_cutover() absente; rollback N-1 refusé';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'notification_jobs'::regclass
       AND tgname = 'notification_jobs_cutover_spool_v2'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER notification_jobs_cutover_spool_v2
    BEFORE INSERT OR UPDATE ON "notification_jobs"
    FOR EACH ROW EXECUTE FUNCTION notification_jobs_spool_v2_cutover();
  END IF;
END;
$$;

DROP POLICY IF EXISTS tenant_isolation ON "notification_jobs";
CREATE POLICY tenant_isolation ON "notification_jobs"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

COMMIT;

SELECT
  count(*) FILTER (WHERE "lastError" LIKE '[manual-review:%') AS manual_review_jobs,
  count(*) FILTER (WHERE "lastError" LIKE '[cutover-spooled:v2]%') AS spooled_jobs
FROM "notification_jobs";
