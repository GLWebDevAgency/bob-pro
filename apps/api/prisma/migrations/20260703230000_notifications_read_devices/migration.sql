-- C25 : fil de notifications lisible côté mobile (lu/non-lu) + appareils push Expo.
ALTER TABLE "notification_jobs" ADD COLUMN "readAt" TIMESTAMP(3);

CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "expoPushToken" TEXT NOT NULL,
    "platform" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "devices_companyId_expoPushToken_key" ON "devices"("companyId", "expoPushToken");

CREATE INDEX "devices_companyId_idx" ON "devices"("companyId");

ALTER TABLE "devices" ADD CONSTRAINT "devices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
