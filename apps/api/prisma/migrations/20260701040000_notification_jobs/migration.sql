-- Outbox durable des notifications sortantes Bob.
-- Additif : aucune table financière existante n'est modifiée.

CREATE TYPE "NotificationJobStatus" AS ENUM ('pending', 'done', 'failed');

CREATE TABLE "notification_jobs" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "payload" JSONB,
  "status" "NotificationJobStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uniq_notification_job" ON "notification_jobs"("companyId", "kind", "dedupeKey");
CREATE INDEX "notification_jobs_companyId_status_nextAttemptAt_idx" ON "notification_jobs"("companyId", "status", "nextAttemptAt");

ALTER TABLE "notification_jobs"
  ADD CONSTRAINT "notification_jobs_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
