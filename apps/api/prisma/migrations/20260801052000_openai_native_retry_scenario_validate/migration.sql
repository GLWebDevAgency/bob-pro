-- Validation différée du CHECK étendu ; aucune réécriture des lignes historiques.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.realtime_native_speech_deliveries
  VALIDATE CONSTRAINT realtime_native_speech_deliveries_dimension_check_v2;

ALTER TABLE public.realtime_native_speech_deliveries
  RENAME CONSTRAINT realtime_native_speech_deliveries_dimension_check_v2
  TO realtime_native_speech_deliveries_dimension_check;

COMMIT;
