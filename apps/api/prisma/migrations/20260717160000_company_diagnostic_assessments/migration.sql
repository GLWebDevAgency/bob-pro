-- Un diagnostic n'existe qu'après validation explicite de toutes les questions applicables.
-- IMPORTANT : aucun backfill/seed — absence de ligne = « jamais réalisé », pas score zéro.
CREATE TABLE "company_diagnostic_assessments" (
  "companyId" TEXT NOT NULL,
  "answers" JSONB NOT NULL,
  "score" INTEGER NOT NULL,
  "receptionScore" INTEGER NOT NULL,
  "emissionScore" INTEGER NOT NULL,
  "dataQualityScore" INTEGER NOT NULL,
  "sourceFingerprint" CHAR(64) NOT NULL,
  "rulesetVersion" INTEGER NOT NULL,
  "sourceAsOf" DATE NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "company_diagnostic_assessments_pkey" PRIMARY KEY ("companyId"),
  CONSTRAINT "company_diagnostic_assessments_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    -- CloseAccount marque companies.closedAt et conserve les preuves métier ; aucun hard-delete.
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "company_diagnostic_assessments_revision_check"
    CHECK ("revision" >= 1),
  CONSTRAINT "company_diagnostic_assessments_score_check"
    CHECK ("score" BETWEEN 0 AND 100),
  CONSTRAINT "company_diagnostic_assessments_reception_score_check"
    CHECK ("receptionScore" BETWEEN 0 AND 100),
  CONSTRAINT "company_diagnostic_assessments_emission_score_check"
    CHECK ("emissionScore" BETWEEN 0 AND 100),
  CONSTRAINT "company_diagnostic_assessments_data_quality_score_check"
    CHECK ("dataQualityScore" BETWEEN 0 AND 100),
  CONSTRAINT "company_diagnostic_assessments_fingerprint_check"
    CHECK ("sourceFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "company_diagnostic_assessments_ruleset_check"
    CHECK ("rulesetVersion" >= 1),
  CONSTRAINT "company_diagnostic_assessments_answers_check"
    CHECK (
      jsonb_typeof("answers") = 'object'
      AND "answers" ?& ARRAY['platform', 'accountant']
      AND ("answers" - ARRAY['platform', 'offAppSales', 'accountant']) = '{}'::jsonb
      AND jsonb_typeof("answers" -> 'platform') = 'string'
      AND ("answers" ->> 'platform') IN ('yes', 'no', 'unknown')
      AND jsonb_typeof("answers" -> 'accountant') = 'string'
      AND ("answers" ->> 'accountant') IN ('yes', 'no', 'unknown')
      AND (
        NOT ("answers" ? 'offAppSales')
        OR (
          jsonb_typeof("answers" -> 'offAppSales') = 'string'
          AND ("answers" ->> 'offAppSales') IN ('yes', 'no', 'unknown')
        )
      )
    )
);

-- La BDD refuse une mise à jour qui contournerait le compare-and-swap applicatif.
CREATE OR REPLACE FUNCTION enforce_company_diagnostic_assessment_cas()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."companyId" IS DISTINCT FROM OLD."companyId" THEN
    RAISE EXCEPTION 'company diagnostic companyId is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'company diagnostic createdAt is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'company diagnostic revision must increment by exactly one' USING ERRCODE = '23514';
  END IF;
  IF NEW."updatedAt" < OLD."updatedAt" THEN
    RAISE EXCEPTION 'company diagnostic updatedAt cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_diagnostic_assessment_cas_guard
BEFORE UPDATE ON "company_diagnostic_assessments"
FOR EACH ROW EXECUTE FUNCTION enforce_company_diagnostic_assessment_cas();

-- Fail-closed dès la migration. Le rôle runtime n'a volontairement aucune policy DELETE.
ALTER TABLE "company_diagnostic_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_diagnostic_assessments" FORCE ROW LEVEL SECURITY;

CREATE POLICY company_diagnostic_assessment_select ON "company_diagnostic_assessments" FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY company_diagnostic_assessment_insert ON "company_diagnostic_assessments" FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY company_diagnostic_assessment_update ON "company_diagnostic_assessments" FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
