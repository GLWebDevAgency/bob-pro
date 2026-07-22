-- La validation utilise le verrou PostgreSQL SHARE UPDATE EXCLUSIVE : elle laisse les INSERT,
-- UPDATE et DELETE N-1 avancer. Toute ligne historique provider_stream fait échouer fermé le train.
ALTER TABLE public.realtime_control_grants
  VALIDATE CONSTRAINT realtime_control_grants_provider_stream_v1_disabled_check;
