-- Ordre keyset exact : aucun GROUP BY, OFFSET ou scan global du backlog.
CREATE INDEX CONCURRENTLY realtime_native_speech_due_retention_directory_idx
  ON public.realtime_native_speech_deliveries(
    "retentionExpiresAt", "companyId", "deliveryId"
  )
  WHERE phase IN ('delivered', 'cancelled', 'failed', 'expired');
