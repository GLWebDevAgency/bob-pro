-- Phase EXPAND du protocole outbox v2.
--
-- Cette migration est volontairement compatible avec le binaire N-1 : elle ajoute les
-- colonnes comprises par N, met les anciens jobs ambigus en revue manuelle, puis installe un
-- spool DB. Pendant le rolling deploy, N-1 et N peuvent encore créer des notifications mais
-- aucun des deux ne peut les livrer. L'activation post-readiness supprime le spool, valide les
-- contraintes et active le fence RLS v2 (notification-outbox-v2-activate.sql).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "notification_jobs"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "providerAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "payloadFingerprint" TEXT,
  ADD COLUMN "cutoverResumeAt" TIMESTAMP(3);

-- Avant v2 aucune tentative provider n'était ancrée en base et Brevo ne recevait aucune clé
-- d'idempotence. Tout pending/failed historique est donc ambigu : jamais de replay automatique.
UPDATE "notification_jobs"
SET payload = NULL,
    "payloadFingerprint" = 'legacy:' || md5(
      id || ':' || "companyId" || ':' || kind || ':' || "dedupeKey" || ':' || recipient || ':' || subject
    ),
    status = 'failed',
    "nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999',
    "leaseToken" = NULL,
    "providerAttemptedAt" = NULL,
    "cutoverResumeAt" = NULL,
    "lastError" = left(
      '[manual-review:legacy-provider-window-unknown] Livraison antérieure incertaine; rejeu automatique interdit. '
      || coalesce("lastError", ''),
      2000
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE status IN ('pending', 'failed');

CREATE OR REPLACE FUNCTION notification_jobs_spool_v2_cutover()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sentinel CONSTANT timestamp := TIMESTAMP '9999-12-31 23:59:59.999';
  bypass text := current_setting('app.notification_outbox_cutover_bypass', true);
  valid_payload boolean;
BEGIN
  IF bypass IN ('activation', 'certification') THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('pending', 'failed') OR NEW."nextAttemptAt" >= sentinel THEN
    RETURN NEW;
  END IF;

  -- Un ré-enqueue N-1 ne doit jamais ressusciter un job historique déjà ambigu.
  IF TG_OP = 'UPDATE' AND coalesce(OLD."lastError", '') LIKE '[manual-review:%' THEN
    NEW.payload := NULL;
    NEW."nextAttemptAt" := sentinel;
    NEW."leaseToken" := NULL;
    NEW."providerAttemptedAt" := NULL;
    NEW."cutoverResumeAt" := NULL;
    NEW."lastError" := OLD."lastError";
    RETURN NEW;
  END IF;

  valid_payload := coalesce((
    jsonb_typeof(NEW.payload) = 'object'
    AND NEW.payload->>'channel' IN ('email', 'sms')
    AND NEW.payload->>'channel' = NEW.channel
    AND jsonb_typeof(NEW.payload->'to') = 'string'
    AND NEW.payload->>'to' = NEW.recipient
    AND jsonb_typeof(NEW.payload->'subject') = 'string'
    AND NEW.payload->>'subject' = NEW.subject
    AND jsonb_typeof(NEW.payload->'body') = 'string'
  ), false);

  IF NOT valid_payload OR (
    NEW.channel = 'email'
    AND NEW.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    NEW.payload := NULL;
    NEW.status := 'failed';
    NEW."nextAttemptAt" := sentinel;
    NEW."leaseToken" := NULL;
    NEW."providerAttemptedAt" := NULL;
    NEW."cutoverResumeAt" := NULL;
    NEW."lastError" := '[manual-review:invalid-payload] Payload créé pendant cutover invalide; rejeu interdit.';
    RETURN NEW;
  END IF;

  IF NEW.channel = 'email' THEN
    NEW.payload := jsonb_set(NEW.payload, '{idempotencyKey}', to_jsonb(lower(NEW.id)), true);
  END IF;
  NEW."payloadFingerprint" := coalesce(
    NEW."payloadFingerprint",
    'cutover-md5:' || md5(jsonb_build_array(
      NEW.payload->>'channel',
      NEW.payload->>'to',
      NEW.payload->>'subject',
      NEW.payload->>'body'
    )::text)
  );
  NEW."cutoverResumeAt" := NEW."nextAttemptAt";
  NEW."nextAttemptAt" := sentinel;
  NEW."leaseToken" := NULL;
  NEW."providerAttemptedAt" := NULL;
  NEW."lastError" := '[cutover-spooled:v2] Livraison suspendue jusqu''à activation de la révision v2.';
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_jobs_cutover_spool_v2
BEFORE INSERT OR UPDATE ON "notification_jobs"
FOR EACH ROW EXECUTE FUNCTION notification_jobs_spool_v2_cutover();

COMMIT;
