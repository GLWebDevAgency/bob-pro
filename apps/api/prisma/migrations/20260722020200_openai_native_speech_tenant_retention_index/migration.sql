-- Un seul statement top-level : PostgreSQL peut construire cet index sans bloquer les writers.
CREATE INDEX CONCURRENTLY realtime_native_speech_deliveries_tenant_retention_terminal_idx
  ON public.realtime_native_speech_deliveries(
    "companyId", "retentionExpiresAt", "deliveryId"
  )
  WHERE phase IN ('delivered', 'cancelled', 'failed', 'expired');
