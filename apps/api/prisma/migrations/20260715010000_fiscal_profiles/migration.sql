-- BOB EXPERT FISCAL (Phase 1A) — profil fiscal persisté par tenant.
-- Additive uniquement : aucune table/colonne existante modifiée ou supprimée.

-- CreateTable
CREATE TABLE "fiscal_profiles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "legalForm" JSONB NOT NULL,
    "taxRegime" JSONB NOT NULL,
    "socialStatus" JSONB NOT NULL,
    "activityNature" JSONB NOT NULL,
    "vatRegime" JSONB NOT NULL,
    "acre" JSONB NOT NULL,
    "versementLiberatoire" JSONB NOT NULL,
    "fiscalYearEnd" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_profiles_companyId_key" ON "fiscal_profiles"("companyId");

-- AddForeignKey
ALTER TABLE "fiscal_profiles" ADD CONSTRAINT "fiscal_profiles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
