-- Expand-only : la facturation GPT Realtime sépare texte, audio, image et cache.
--
-- Les kinds agrégés historiques restent valides pour les writers N-1 et les providers qui ne
-- publient pas cette ventilation. Le writer GPT natif N n'émet que les huit dimensions
-- non-chevauchantes ajoutées ici.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL row_security = off;

ALTER TABLE public.realtime_voice_usage_events
  ADD CONSTRAINT realtime_voice_usage_events_kind_check_cost_v1
  CHECK ("kind" IN (
    'realtime_audio_in_seconds', 'realtime_audio_out_seconds',
    'realtime_tokens_in', 'realtime_tokens_out',
    'realtime_uncached_text_tokens_in',
    'realtime_uncached_audio_tokens_in',
    'realtime_uncached_image_tokens_in',
    'realtime_cached_text_tokens_in',
    'realtime_cached_audio_tokens_in',
    'realtime_cached_image_tokens_in',
    'realtime_text_tokens_out',
    'realtime_audio_tokens_out',
    'llm_tokens_in', 'llm_tokens_out', 'stt_seconds', 'tts_characters'
  )) NOT VALID;

ALTER TABLE public.realtime_voice_usage_daily
  ADD CONSTRAINT realtime_voice_usage_daily_shape_check_cost_v1
  CHECK (
    "subjectHash"::TEXT ~ '^[a-f0-9]{64}$'
    AND "subjectKeyVersion" BETWEEN 1 AND 2147483647
    AND "plan" IN ('free', 'solo', 'pro', 'business')
    AND "kind" IN (
      'realtime_audio_in_seconds', 'realtime_audio_out_seconds',
      'realtime_tokens_in', 'realtime_tokens_out',
      'realtime_uncached_text_tokens_in',
      'realtime_uncached_audio_tokens_in',
      'realtime_uncached_image_tokens_in',
      'realtime_cached_text_tokens_in',
      'realtime_cached_audio_tokens_in',
      'realtime_cached_image_tokens_in',
      'realtime_text_tokens_out',
      'realtime_audio_tokens_out',
      'llm_tokens_in', 'llm_tokens_out', 'stt_seconds', 'tts_characters'
    )
    AND "source" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    AND "amount" >= 0
    AND "eventCount" > 0
    AND "firstEventAt" <= "lastEventAt"
    AND "aggregatedAt" >= "firstEventAt"
    AND "retentionExpiresAt" = ("usageDate" + INTERVAL '400 days')
    AND "version" > 0
  ) NOT VALID;

ALTER TABLE public.realtime_voice_usage_events
  VALIDATE CONSTRAINT realtime_voice_usage_events_kind_check_cost_v1;

ALTER TABLE public.realtime_voice_usage_daily
  VALIDATE CONSTRAINT realtime_voice_usage_daily_shape_check_cost_v1;

ALTER TABLE public.realtime_voice_usage_events
  DROP CONSTRAINT realtime_voice_usage_events_kind_check;

ALTER TABLE public.realtime_voice_usage_events
  RENAME CONSTRAINT realtime_voice_usage_events_kind_check_cost_v1
  TO realtime_voice_usage_events_kind_check;

ALTER TABLE public.realtime_voice_usage_daily
  DROP CONSTRAINT realtime_voice_usage_daily_shape_check;

ALTER TABLE public.realtime_voice_usage_daily
  RENAME CONSTRAINT realtime_voice_usage_daily_shape_check_cost_v1
  TO realtime_voice_usage_daily_shape_check;

COMMIT;
