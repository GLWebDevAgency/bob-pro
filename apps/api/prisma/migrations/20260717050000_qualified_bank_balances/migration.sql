-- Preuves bancaires qualifiées. Append-only, tenantées, et aucune donnée initiale inventée.
CREATE TYPE "BankBalanceSource" AS ENUM (
  'manual_confirmed',
  'bank_statement',
  'bank_connector'
);

CREATE TYPE "BankBalanceReconciliationStatus" AS ENUM (
  'unreconciled',
  'partially_reconciled',
  'reconciled'
);

CREATE TABLE "bank_balance_snapshots" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "source" "BankBalanceSource" NOT NULL,
  "reconciliationStatus" "BankBalanceReconciliationStatus" NOT NULL,
  "observedAt" TIMESTAMPTZ(6) NOT NULL,
  "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_balance_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_balance_snapshots_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "bank_balance_snapshots_amount_safe_integer_check"
    CHECK ("amountCents" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "bank_balance_snapshots_currency_check" CHECK ("currency" = 'EUR'),
  CONSTRAINT "bank_balance_snapshots_observation_check" CHECK ("observedAt" <= "recordedAt")
);

CREATE INDEX "bank_balance_snapshots_company_latest_idx"
  ON "bank_balance_snapshots"("companyId", "observedAt" DESC, "recordedAt" DESC, "id" DESC);

ALTER TABLE "bank_balance_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_balance_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_balance_snapshot_select ON "bank_balance_snapshots"
  FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY bank_balance_snapshot_insert ON "bank_balance_snapshots"
  FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Intention append-only également au niveau privilèges. Le script release réapplique ce REVOKE
-- après son GRANT générique sur toutes les tables.
