-- Un seul statement top-level : PostgreSQL peut construire cet index sans bloquer les writers.
CREATE INDEX CONCURRENTLY realtime_native_speech_deliveries_tenant_reaper_idx
  ON public.realtime_native_speech_deliveries(
    "companyId", "expiresAt", "deliveryId"
  )
  WHERE phase NOT IN ('delivered', 'cancelled', 'failed', 'expired');
