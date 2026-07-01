-- CreateEnum
CREATE TYPE "DocumentArchiveJobStatus" AS ENUM ('pending', 'done', 'failed');

-- CreateTable
CREATE TABLE "document_archive_jobs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'invoice-issued',
    "status" "DocumentArchiveJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_archive_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_archive_jobs_companyId_invoiceId_reason_key" ON "document_archive_jobs"("companyId", "invoiceId", "reason");

-- CreateIndex
CREATE INDEX "document_archive_jobs_companyId_status_nextAttemptAt_idx" ON "document_archive_jobs"("companyId", "status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "document_archive_jobs" ADD CONSTRAINT "document_archive_jobs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
