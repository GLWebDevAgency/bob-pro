-- Voice Trace — motifs de fermeture client exacts, expand compatible writer N-1.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.realtime_voice_trace_events
  ADD CONSTRAINT realtime_voice_trace_close_reason_check_v2
  CHECK (
    "sessionCloseReason" IS NULL OR "sessionCloseReason" IN (
    -- REALTIME_TRACE_SESSION_CLOSE_REASONS_START
      'user',
      'automatic_failure',
      'lifecycle',
      'policy',
      'kill_switch',
      'superseded',
      'max_duration',
      'shutdown'
    -- REALTIME_TRACE_SESSION_CLOSE_REASONS_END
    )
  ) NOT VALID;

ALTER TABLE public.realtime_voice_trace_events
  DROP CONSTRAINT realtime_voice_trace_close_reason_check;

COMMIT;
