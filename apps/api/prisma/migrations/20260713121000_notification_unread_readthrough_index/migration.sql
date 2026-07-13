-- Accélère le preview exact et la mutation read-through sans indexer les lignes déjà lues.
-- L'ordre ASC correspond au prédicat temporel `createdAt < cutoff`; companyId ferme le tenant.
CREATE INDEX IF NOT EXISTS "notification_jobs_unread_createdAt_idx"
  ON "notification_jobs" ("companyId", "createdAt")
  WHERE "readAt" IS NULL;
