-- Ordre keyset exact : aucun GROUP BY, OFFSET ou scan global du backlog.
CREATE INDEX CONCURRENTLY realtime_native_speech_due_expiry_directory_idx
  ON public.realtime_native_speech_deliveries(
    "expiresAt", "companyId", "deliveryId"
  )
  WHERE phase NOT IN ('delivered', 'cancelled', 'failed', 'expired');
