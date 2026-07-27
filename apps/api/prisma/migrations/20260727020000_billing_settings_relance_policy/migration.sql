-- PR-06 « Encaisser » — cadence de relance PARAMÉTRABLE par société + interrupteur des relances
-- automatiques. Migration ADDITIVE : colonnes nulles = DEFAULT_RELANCE_POLICY inchangée (les
-- writers N-1 continuent d'insérer sans elles) ; `relanceAutoEnabled` DEFAULT true = le cron
-- garde exactement son comportement historique. Le CHECK force la COHÉRENCE de la politique :
-- tous les seuils ensemble, strictement croissants (une escalade désordonnée enverrait la mise
-- en demeure avant la relance ferme), bornés 1..365.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.company_billing_settings
  ADD COLUMN "relanceCordialAfterDays" INTEGER,
  ADD COLUMN "relanceNeutreAfterDays" INTEGER,
  ADD COLUMN "relanceFermeAfterDays" INTEGER,
  ADD COLUMN "relanceMiseEnDemeureAfterDays" INTEGER,
  ADD COLUMN "relanceAutoEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.company_billing_settings
  ADD CONSTRAINT company_billing_settings_relance_policy_shape CHECK (
    (
      "relanceCordialAfterDays" IS NULL
      AND "relanceNeutreAfterDays" IS NULL
      AND "relanceFermeAfterDays" IS NULL
      AND "relanceMiseEnDemeureAfterDays" IS NULL
    )
    OR (
      "relanceCordialAfterDays" BETWEEN 1 AND 365
      AND "relanceNeutreAfterDays" BETWEEN 1 AND 365
      AND "relanceFermeAfterDays" BETWEEN 1 AND 365
      AND "relanceMiseEnDemeureAfterDays" BETWEEN 1 AND 365
      AND "relanceCordialAfterDays" < "relanceNeutreAfterDays"
      AND "relanceNeutreAfterDays" < "relanceFermeAfterDays"
      AND "relanceFermeAfterDays" < "relanceMiseEnDemeureAfterDays"
    )
  );

COMMIT;
