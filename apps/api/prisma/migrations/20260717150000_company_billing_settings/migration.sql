-- Réglages facturation canoniques. Les valeurs initiales ci-dessous sont une politique produit
-- explicite persistée en BDD, jamais un choix prétendument saisi par le propriétaire ni un
-- fallback mobile. Le propriétaire peut ensuite les modifier via PATCH + CAS.
CREATE TYPE "InvoicePdfAccentColor" AS ENUM ('navy', 'green', 'purple', 'orange');

CREATE TABLE "company_billing_settings" (
  "companyId" TEXT NOT NULL,
  "showRibOnInvoices" BOOLEAN NOT NULL DEFAULT false,
  "showInsuranceOnInvoices" BOOLEAN NOT NULL DEFAULT true,
  "pdfAccentColor" "InvoicePdfAccentColor" NOT NULL DEFAULT 'navy',
  "defaultQuoteValidityDays" INTEGER NOT NULL DEFAULT 30,
  "defaultDepositPercent" INTEGER NOT NULL DEFAULT 30,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "company_billing_settings_pkey" PRIMARY KEY ("companyId"),
  CONSTRAINT "company_billing_settings_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "company_billing_settings_validity_days_check"
    CHECK ("defaultQuoteValidityDays" BETWEEN 1 AND 365),
  CONSTRAINT "company_billing_settings_deposit_percent_check"
    CHECK ("defaultDepositPercent" BETWEEN 0 AND 100),
  CONSTRAINT "company_billing_settings_revision_check"
    CHECK ("revision" >= 1)
);

INSERT INTO "company_billing_settings" ("companyId")
SELECT id FROM "companies"
ON CONFLICT ("companyId") DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_company_billing_settings_cas()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."companyId" IS DISTINCT FROM OLD."companyId" THEN
    RAISE EXCEPTION 'company_billing_settings companyId is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'company_billing_settings createdAt is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'company_billing_settings revision must increment by exactly one' USING ERRCODE = '23514';
  END IF;
  IF NEW."updatedAt" < OLD."updatedAt" THEN
    RAISE EXCEPTION 'company_billing_settings updatedAt cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_billing_settings_cas_guard
BEFORE UPDATE ON "company_billing_settings"
FOR EACH ROW EXECUTE FUNCTION enforce_company_billing_settings_cas();

-- Fail-closed dès cette migration, avant même le passage ultérieur de prisma/rls.sql.
ALTER TABLE "company_billing_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_billing_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY company_billing_settings_select ON "company_billing_settings" FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY company_billing_settings_insert ON "company_billing_settings" FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY company_billing_settings_update ON "company_billing_settings" FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
