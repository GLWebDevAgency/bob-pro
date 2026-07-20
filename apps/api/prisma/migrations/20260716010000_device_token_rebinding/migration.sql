-- Confidentialité push : une installation ne peut recevoir les notifications que du dernier
-- tenant auquel elle s'est explicitement liée. Le lock rend le nettoyage + changement d'unicité
-- atomique face aux anciennes écritures pendant le déploiement.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "devices" IN ACCESS EXCLUSIVE MODE;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "expoPushToken"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    ) AS rank
  FROM "devices"
)
DELETE FROM "devices" AS device
USING ranked
WHERE device.id = ranked.id
  AND ranked.rank > 1;

-- L'index composé historique reste pendant la phase expand : le binaire N-1 peut encore cibler
-- son upsert sans casser un rolling deploy. L'unicité globale ci-dessous est l'autorité nouvelle.
CREATE UNIQUE INDEX "devices_expo_push_token_key" ON "devices"("expoPushToken");

COMMIT;
