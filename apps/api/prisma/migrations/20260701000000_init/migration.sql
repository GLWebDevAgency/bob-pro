-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LegalForm" AS ENUM ('EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro');

-- CreateEnum
CREATE TYPE "VatRegime" AS ENUM ('franchise', 'reel_simpl', 'reel_normal');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('b2c', 'b2b', 'b2g');

-- CreateEnum
CREATE TYPE "DocKind" AS ENUM ('quote', 'invoice', 'deposit_invoice', 'credit_note', 'situation');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'sent', 'viewed', 'signed', 'refused', 'expired');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'late', 'cancelled');

-- CreateEnum
CREATE TYPE "LineCategory" AS ENUM ('labor', 'supply', 'travel', 'disbursement', 'subscription');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'transfer', 'cash');

-- CreateEnum
CREATE TYPE "PublicAccessScope" AS ENUM ('quote_signature');

-- CreateEnum
CREATE TYPE "PublicAccessResourceType" AS ENUM ('quote');

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalForm" "LegalForm" NOT NULL,
    "siren" CHAR(9) NOT NULL,
    "siret" CHAR(14) NOT NULL,
    "apeCode" TEXT,
    "trade" TEXT NOT NULL,
    "vatRegime" "VatRegime" NOT NULL,
    "rcsOrRm" TEXT,
    "addrLine1" TEXT NOT NULL,
    "addrZip" TEXT NOT NULL,
    "addrCity" TEXT NOT NULL,
    "iban" TEXT,
    "bic" TEXT,
    "insurerName" TEXT,
    "policyNo" TEXT,
    "coverage" TEXT,
    "policyExpiresAt" TIMESTAMP(3),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL,
    "name" TEXT NOT NULL,
    "siren" CHAR(9),
    "isInternational" BOOLEAN NOT NULL DEFAULT false,
    "addrLine1" TEXT NOT NULL,
    "addrZip" TEXT NOT NULL,
    "addrCity" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "ptLabel" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "avgDelayDays" INTEGER NOT NULL DEFAULT 0,
    "outstanding" INTEGER NOT NULL DEFAULT 0,
    "isSubcontractingBtp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "number" TEXT,
    "validUntil" TIMESTAMP(3),
    "depositPct" INTEGER,
    "signerName" TEXT,
    "signedAt" TIMESTAMP(3),
    "totalsHt" INTEGER NOT NULL DEFAULT 0,
    "totalsVat" INTEGER NOT NULL DEFAULT 0,
    "totalsTtc" INTEGER NOT NULL DEFAULT 0,
    "totalsNetToPay" INTEGER NOT NULL DEFAULT 0,
    "vatByRate" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "DocKind" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "number" TEXT,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "parentQuoteId" TEXT,
    "depositPct" INTEGER,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "totalsHt" INTEGER NOT NULL DEFAULT 0,
    "totalsVat" INTEGER NOT NULL DEFAULT 0,
    "totalsTtc" INTEGER NOT NULL DEFAULT 0,
    "totalsNetToPay" INTEGER NOT NULL DEFAULT 0,
    "vatByRate" JSONB NOT NULL DEFAULT '{}',
    "legalMentions" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_items" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT,
    "invoiceId" TEXT,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "category" "LineCategory" NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "unit" TEXT,
    "unitPriceHt" INTEGER NOT NULL,
    "vatRate" DECIMAL(4,2) NOT NULL,

    CONSTRAINT "line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_access_tokens" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "resourceType" "PublicAccessResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "scope" "PublicAccessScope" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "supplierSiren" CHAR(9),
    "documentDate" TEXT NOT NULL,
    "totalTtcCents" INTEGER NOT NULL,
    "totalHtCents" INTEGER,
    "vatCents" INTEGER,
    "vatRatePct" DOUBLE PRECISION,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'to_pay',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_counters" (
    "companyId" TEXT NOT NULL,
    "counterKey" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("companyId","counterKey","fiscalYear")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_siret_key" ON "companies"("siret");

-- CreateIndex
CREATE INDEX "customers_companyId_idx" ON "customers"("companyId");

-- CreateIndex
CREATE INDEX "customers_companyId_type_idx" ON "customers"("companyId", "type");

-- CreateIndex
CREATE INDEX "quotes_companyId_status_idx" ON "quotes"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_companyId_number_key" ON "quotes"("companyId", "number");

-- CreateIndex
CREATE INDEX "invoices_companyId_status_idx" ON "invoices"("companyId", "status");

-- CreateIndex
CREATE INDEX "invoices_dueAt_idx" ON "invoices"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_companyId_number_key" ON "invoices"("companyId", "number");

-- CreateIndex
CREATE INDEX "line_items_quoteId_idx" ON "line_items"("quoteId");

-- CreateIndex
CREATE INDEX "line_items_invoiceId_idx" ON "line_items"("invoiceId");

-- CreateIndex
CREATE INDEX "payments_invoiceId_idx" ON "payments"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_companyId_idempotencyKey_key" ON "payments"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "public_access_tokens_tokenHash_key" ON "public_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "public_access_tokens_companyId_resourceType_resourceId_scop_idx" ON "public_access_tokens"("companyId", "resourceType", "resourceId", "scope");

-- CreateIndex
CREATE INDEX "expenses_companyId_idx" ON "expenses"("companyId");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

