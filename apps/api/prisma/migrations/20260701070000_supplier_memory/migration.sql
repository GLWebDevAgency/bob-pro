-- Durable multi-tenant memory for recurrent suppliers.
-- Additive migration: no backfill, no existing table rewrite.

CREATE TABLE "supplier_memory_profiles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "siren" CHAR(9),
    "category" TEXT NOT NULL,
    "vatRatePct" DOUBLE PRECISION,
    "seen" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_memory_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uniq_supplier_memory_company_key" ON "supplier_memory_profiles"("companyId", "key");
CREATE INDEX "supplier_memory_profiles_companyId_idx" ON "supplier_memory_profiles"("companyId");

ALTER TABLE "supplier_memory_profiles"
  ADD CONSTRAINT "supplier_memory_profiles_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
