-- Validation différée des motifs de fermeture client ; aucune réécriture historique.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.realtime_voice_trace_events
  VALIDATE CONSTRAINT realtime_voice_trace_close_reason_check_v2;

ALTER TABLE public.realtime_voice_trace_events
  RENAME CONSTRAINT realtime_voice_trace_close_reason_check_v2
  TO realtime_voice_trace_close_reason_check;

COMMIT;
