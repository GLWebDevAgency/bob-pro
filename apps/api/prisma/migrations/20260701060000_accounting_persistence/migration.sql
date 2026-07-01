-- Persistance du socle comptable Bob : plan de comptes tenanté + écritures en partie double.
-- Additif : aucune table financière existante n'est modifiée.

CREATE TYPE "AccountingAccountKind" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TYPE "AccountingNormalSide" AS ENUM ('debit', 'credit', 'mixed');

CREATE TYPE "AccountingJournal" AS ENUM ('sales', 'purchases', 'bank', 'misc');

CREATE TYPE "AccountingSourceType" AS ENUM ('invoice', 'expense', 'payment', 'bank_transaction', 'manual_adjustment');

CREATE TABLE "accounting_accounts" (
  "companyId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "kind" "AccountingAccountKind" NOT NULL,
  "normalSide" "AccountingNormalSide" NOT NULL,
  "parentCode" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "postingAllowed" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "accounting_accounts_pkey" PRIMARY KEY ("companyId", "code")
);

CREATE TABLE "accounting_entries" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "journal" "AccountingJournal" NOT NULL,
  "sourceType" "AccountingSourceType" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "entryDate" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "accounting_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "accounting_entry_lines" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "account" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "debitCents" INTEGER NOT NULL,
  "creditCents" INTEGER NOT NULL,

  CONSTRAINT "accounting_entry_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "accounting_accounts_companyId_parentCode_idx" ON "accounting_accounts"("companyId", "parentCode");
CREATE INDEX "accounting_accounts_companyId_active_postingAllowed_idx" ON "accounting_accounts"("companyId", "active", "postingAllowed");

CREATE UNIQUE INDEX "uniq_accounting_entry_id_company" ON "accounting_entries"("id", "companyId");
CREATE INDEX "accounting_entries_companyId_journal_entryDate_idx" ON "accounting_entries"("companyId", "journal", "entryDate");
CREATE INDEX "accounting_entries_companyId_sourceType_sourceId_idx" ON "accounting_entries"("companyId", "sourceType", "sourceId");

CREATE UNIQUE INDEX "uniq_accounting_entry_line_position" ON "accounting_entry_lines"("entryId", "position");
CREATE INDEX "accounting_entry_lines_companyId_account_idx" ON "accounting_entry_lines"("companyId", "account");

ALTER TABLE "accounting_accounts"
  ADD CONSTRAINT "accounting_accounts_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_entries"
  ADD CONSTRAINT "accounting_entries_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_entry_lines"
  ADD CONSTRAINT "accounting_entry_lines_entryId_companyId_fkey"
  FOREIGN KEY ("entryId", "companyId") REFERENCES "accounting_entries"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
