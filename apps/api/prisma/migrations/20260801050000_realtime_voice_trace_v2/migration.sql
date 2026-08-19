-- GENERATED LISTS: apps/api/scripts/generate-realtime-voice-trace-migration-values.mjs
-- Bob Live Realtime Voice Trace V2 — expand-only, append-only et dormant hors staging.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.realtime_voice_trace_events (
  id UUID PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "traceAttemptId" UUID NOT NULL,
  "sessionHandle" UUID,
  "ownerEpoch" INTEGER NOT NULL,
  "eventOrdinal" INTEGER NOT NULL,
  "turnId" UUID,
  "eventKind" VARCHAR(40) NOT NULL,
  "eventDigest" CHAR(64) NOT NULL,
  "eventDigestKeyVersion" INTEGER NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  "durationMs" INTEGER,
  "contextRevision" INTEGER,
  "contextDigest" CHAR(64),
  provider VARCHAR(16),
  transport VARCHAR(16),
  "speechDelivery" VARCHAR(40),
  "realtimeModel" VARCHAR(100),
  "plannerDisposition" VARCHAR(32),
  "plannerAuthority" VARCHAR(16),
  "plannerModel" VARCHAR(100),
  "plannerStepIndex" INTEGER,
  "plannerStepCount" INTEGER,
  "plannerIntent" VARCHAR(64),
  "missionKind" VARCHAR(100),
  "runKind" VARCHAR(16),
  "controlKind" VARCHAR(24),
  stage VARCHAR(32),
  outcome VARCHAR(24),
  "failureClass" VARCHAR(64),
  "interruptionReason" VARCHAR(32),
  "sessionCloseReason" VARCHAR(32),
  "encryptionKeyVersion" INTEGER,
  "transcriptCiphertext" TEXT,
  "canonicalReplyCiphertext" TEXT,
  "retentionExpiresAt" TIMESTAMPTZ(6) NOT NULL
    DEFAULT (pg_catalog.transaction_timestamp() + INTERVAL '720 hours'),
  CONSTRAINT realtime_voice_trace_events_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT realtime_voice_trace_attempt_ordinal
    UNIQUE ("companyId", "traceAttemptId", "eventOrdinal"),
  CONSTRAINT realtime_voice_trace_event_kind_check CHECK (
    "eventKind" IN (
    -- REALTIME_TRACE_EVENT_KINDS_START
      'session_bootstrap_failed',
      'session_ready',
      'context_applied',
      'turn_transcript_final',
      'turn_semantic_plan',
      'turn_agent_result',
      'turn_speech_ready',
      'turn_speech_delivered',
      'turn_interrupted',
      'provider_failed',
      'security_rejected',
      'session_closed'
    -- REALTIME_TRACE_EVENT_KINDS_END
    )
  ),
  CONSTRAINT realtime_voice_trace_digest_check CHECK (
    "eventDigest" ~ '^[a-f0-9]{64}$'
    AND "eventDigestKeyVersion" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT realtime_voice_trace_owner_epoch_check CHECK (
    "ownerEpoch" BETWEEN 0 AND 2147483647
    AND (
      "ownerEpoch" > 0
      OR "eventKind" IN (
        'session_bootstrap_failed', 'provider_failed', 'security_rejected'
      )
    )
  ),
  CONSTRAINT realtime_voice_trace_ordinal_check CHECK (
    "eventOrdinal" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT realtime_voice_trace_occurrence_check CHECK (
    "occurredAt" >= "ingestedAt" - INTERVAL '24 hours'
    AND "occurredAt" <= "ingestedAt" + INTERVAL '5 minutes'
    AND "retentionExpiresAt" = "ingestedAt" + INTERVAL '720 hours'
  ),
  CONSTRAINT realtime_voice_trace_duration_check CHECK (
    "durationMs" IS NULL OR "durationMs" BETWEEN 0 AND 86400000
  ),
  CONSTRAINT realtime_voice_trace_context_check CHECK (
    ("contextRevision" IS NULL) = ("contextDigest" IS NULL)
    AND ("contextRevision" IS NULL OR "contextRevision" BETWEEN 1 AND 2147483647)
    AND ("contextDigest" IS NULL OR "contextDigest" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT realtime_voice_trace_provider_check CHECK (
    provider IS NULL OR provider IN (
    -- REALTIME_TRACE_PROVIDERS_START
      'openai'
    -- REALTIME_TRACE_PROVIDERS_END
    )
  ),
  CONSTRAINT realtime_voice_trace_transport_check CHECK (
    transport IS NULL OR transport IN (
    -- REALTIME_TRACE_TRANSPORTS_START
      'webrtc'
    -- REALTIME_TRACE_TRANSPORTS_END
    )
  ),
  CONSTRAINT realtime_voice_trace_speech_delivery_check CHECK (
    "speechDelivery" IS NULL OR "speechDelivery" IN (
    -- REALTIME_TRACE_SPEECH_DELIVERIES_START
      'audited-signed-url-v1',
      'openai-native-webrtc-v1'
    -- REALTIME_TRACE_SPEECH_DELIVERIES_END
    )
  ),
  CONSTRAINT realtime_voice_trace_stage_check CHECK (
    stage IS NULL OR stage IN (
    -- REALTIME_TRACE_STAGES_START
      'admission',
      'provider_call',
      'sideband_bootstrap',
      'sideband_owner',
      'context',
      'transcription',
      'planner',
      'agent',
      'speech_prepare',
      'speech_dispatch',
      'speech_delivery',
      'security',
      'session'
    -- REALTIME_TRACE_STAGES_END
    )
  ),
  CONSTRAINT realtime_voice_trace_outcome_check CHECK (
    outcome IS NULL OR outcome IN (
    -- REALTIME_TRACE_OUTCOMES_START
      'ready',
      'failed',
      'aborted',
      'rejected',
      'unavailable',
      'already_ready',
      'delivered',
      'cancelled',
      'closed'
    -- REALTIME_TRACE_OUTCOMES_END
    )
  ),
  CONSTRAINT realtime_voice_trace_failure_class_check CHECK (
    "failureClass" IS NULL OR "failureClass" IN (
    -- REALTIME_TRACE_FAILURE_CLASSES_START
      'admission_rejected',
      'bootstrap_aborted',
      'provider_create_failed',
      'provider_registration_missing',
      'sideband_timeout',
      'sideband_send_failed',
      'sideband_policy_drift',
      'sideband_provider_error',
      'sideband_network_error',
      'sideband_closed_before_ready',
      'sideband_activation_failed',
      'sideband_owner_busy',
      'sideband_owner_rejected',
      'sideband_owner_unavailable',
      'sideband_context_lost',
      'sideband_context_stale',
      'sideband_context_rejected',
      'sideband_context_unavailable',
      'context_fence_rejected',
      'planner_unavailable',
      'planner_rejected',
      'transcription_failed',
      'agent_failed',
      'speech_publish_failed',
      'speech_delivery_failed',
      'control_seal_failed',
      'speech_cancel_failed',
      'provider_event_error',
      'hangup_failed',
      'unexpected_tool_call',
      'session_policy_drift',
      'malformed_event',
      'unauthorized_response',
      'dangerous_conversation_item',
      'turn_budget_exceeded',
      'owner_lease_lost',
      'unknown'
    -- REALTIME_TRACE_FAILURE_CLASSES_END
    )
  ),
  CONSTRAINT realtime_voice_trace_interruption_check CHECK (
    "interruptionReason" IS NULL OR "interruptionReason" IN (
    -- REALTIME_TRACE_INTERRUPTION_REASONS_START
      'barge_in',
      'user_cancel',
      'context_changed',
      'superseded',
      'session_end',
      'playback_error'
    -- REALTIME_TRACE_INTERRUPTION_REASONS_END
    )
  ),
  CONSTRAINT realtime_voice_trace_planner_disposition_check CHECK (
    "plannerDisposition" IS NULL OR "plannerDisposition" IN (
    -- REALTIME_TRACE_PLANNER_DISPOSITIONS_START
      'mission_frame',
      'global_plan',
      'out_of_scope',
      'rejected',
      'unavailable'
    -- REALTIME_TRACE_PLANNER_DISPOSITIONS_END
    )
  ),
  CONSTRAINT realtime_voice_trace_planner_authority_check CHECK (
    "plannerAuthority" IS NULL OR "plannerAuthority" IN (
    -- REALTIME_TRACE_PLANNER_AUTHORITIES_START
      'mission',
      'global',
      'none'
    -- REALTIME_TRACE_PLANNER_AUTHORITIES_END
    )
  ),
  CONSTRAINT realtime_voice_trace_run_kind_check CHECK (
    "runKind" IS NULL OR "runKind" IN (
    -- REALTIME_TRACE_RUN_KINDS_START
      'answer',
      'proposed',
      'done',
      'failed'
    -- REALTIME_TRACE_RUN_KINDS_END
    )
  ),
  CONSTRAINT realtime_voice_trace_control_kind_check CHECK (
    "controlKind" IS NULL OR "controlKind" IN (
    -- REALTIME_TRACE_CONTROL_KINDS_START
      'none',
      'navigate',
      'proposal',
      'navigate_proposal'
    -- REALTIME_TRACE_CONTROL_KINDS_END
    )
  ),
  CONSTRAINT realtime_voice_trace_close_reason_check CHECK (
    "sessionCloseReason" IS NULL OR "sessionCloseReason" IN (
    -- REALTIME_TRACE_SESSION_CLOSE_REASONS_START
      'user',
      'kill_switch',
      'superseded',
      'max_duration',
      'shutdown'
    -- REALTIME_TRACE_SESSION_CLOSE_REASONS_END
    )
  ),
  CONSTRAINT realtime_voice_trace_session_shape_check CHECK (
    "eventKind" = 'session_bootstrap_failed' OR "sessionHandle" IS NOT NULL
  ),
  CONSTRAINT realtime_voice_trace_turn_shape_check CHECK (
    "eventKind" NOT IN (
      'turn_transcript_final', 'turn_semantic_plan', 'turn_agent_result',
      'turn_speech_ready', 'turn_speech_delivered', 'turn_interrupted'
    ) OR "turnId" IS NOT NULL
  ),
  CONSTRAINT realtime_voice_trace_session_ready_shape_check CHECK (
    "eventKind" <> 'session_ready' OR (
      provider = 'openai'
      AND transport = 'webrtc'
      AND "speechDelivery" IS NOT NULL
      AND "realtimeModel" ~ '^[a-z][a-z0-9_.-]{0,99}$'
      AND outcome = 'ready'
    )
  ),
  CONSTRAINT realtime_voice_trace_realtime_model_shape_check CHECK (
    ("eventKind" = 'session_ready') = ("realtimeModel" IS NOT NULL)
  ),
  CONSTRAINT realtime_voice_trace_context_shape_check CHECK (
    "eventKind" <> 'context_applied' OR (
      "contextRevision" IS NOT NULL
      AND "contextDigest" IS NOT NULL
      AND outcome = 'ready'
    )
  ),
  CONSTRAINT realtime_voice_trace_planner_shape_check CHECK (
    (
      "eventKind" = 'turn_semantic_plan'
      AND "plannerDisposition" IS NOT NULL
      AND "plannerAuthority" IS NOT NULL
      AND (
        (
          "plannerDisposition" IN ('rejected', 'unavailable')
          AND (
            "plannerModel" IS NULL
            OR "plannerModel" ~ '^[a-z][a-z0-9_.-]{0,99}$'
          )
        )
        OR (
          "plannerDisposition" NOT IN ('rejected', 'unavailable')
          AND "plannerModel" ~ '^[a-z][a-z0-9_.-]{0,99}$'
        )
      )
      AND "durationMs" IS NOT NULL
      AND ("plannerStepIndex" IS NULL OR "plannerStepIndex" BETWEEN 0 AND 7)
      AND ("plannerStepCount" IS NULL OR "plannerStepCount" BETWEEN 1 AND 8)
      AND (
        "plannerStepIndex" IS NULL
        OR (
          "plannerStepCount" IS NOT NULL
          AND "plannerStepIndex" < "plannerStepCount"
        )
      )
      AND ("plannerIntent" IS NULL OR "plannerIntent" ~ '^[a-z][a-z0-9_]{0,63}$')
      AND ("missionKind" IS NULL OR "missionKind" IN (
      -- REALTIME_TRACE_MISSION_KINDS_START
      'quote_creation@1',
      'customer_contact@1'
    -- REALTIME_TRACE_MISSION_KINDS_END
      ))
    ) OR (
      "eventKind" <> 'turn_semantic_plan'
      AND "plannerDisposition" IS NULL
      AND "plannerAuthority" IS NULL
      AND "plannerModel" IS NULL
      AND "plannerStepIndex" IS NULL
      AND "plannerStepCount" IS NULL
      AND "plannerIntent" IS NULL
      AND "missionKind" IS NULL
    )
  ),
  CONSTRAINT realtime_voice_trace_agent_result_shape_check CHECK (
    (
      "eventKind" = 'turn_agent_result'
      AND "runKind" IS NOT NULL
      AND "controlKind" IS NOT NULL
      AND outcome IN ('ready', 'failed')
    ) OR (
      "eventKind" <> 'turn_agent_result'
      AND "runKind" IS NULL
      AND "controlKind" IS NULL
    )
  ),
  CONSTRAINT realtime_voice_trace_speech_shape_check CHECK (
    (
      "eventKind" = 'turn_speech_ready'
      AND "speechDelivery" IS NOT NULL
      AND outcome IN ('ready', 'already_ready')
    ) OR (
      "eventKind" = 'turn_speech_delivered'
      AND "speechDelivery" IS NOT NULL
      AND outcome = 'delivered'
    ) OR "eventKind" NOT IN ('turn_speech_ready', 'turn_speech_delivered')
  ),
  CONSTRAINT realtime_voice_trace_interruption_shape_check CHECK (
    ("eventKind" = 'turn_interrupted') = ("interruptionReason" IS NOT NULL)
  ),
  CONSTRAINT realtime_voice_trace_session_close_shape_check CHECK (
    (
      "eventKind" = 'session_closed'
      AND "sessionCloseReason" IS NOT NULL
      AND outcome = 'closed'
    ) OR (
      "eventKind" <> 'session_closed'
      AND "sessionCloseReason" IS NULL
    )
  ),
  CONSTRAINT realtime_voice_trace_failure_shape_check CHECK (
    "eventKind" NOT IN (
      'session_bootstrap_failed', 'provider_failed', 'security_rejected'
    ) OR (stage IS NOT NULL AND "failureClass" IS NOT NULL)
  ),
  CONSTRAINT realtime_voice_trace_ciphertext_shape_check CHECK (
    (
      "eventKind" = 'turn_transcript_final'
      AND "transcriptCiphertext" ~
        '^v[1-9][0-9]{0,9}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'
      AND pg_catalog.octet_length("transcriptCiphertext") BETWEEN 45 AND 21386
      AND pg_catalog.split_part("transcriptCiphertext", '.', 1) =
        'v' || "encryptionKeyVersion"::TEXT
      AND "canonicalReplyCiphertext" IS NULL
      AND "encryptionKeyVersion" BETWEEN 1 AND 2147483647
    ) OR (
      "eventKind" = 'turn_agent_result'
      AND "canonicalReplyCiphertext" ~
        '^v[1-9][0-9]{0,9}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'
      AND pg_catalog.octet_length("canonicalReplyCiphertext") BETWEEN 45 AND 12852
      AND pg_catalog.split_part("canonicalReplyCiphertext", '.', 1) =
        'v' || "encryptionKeyVersion"::TEXT
      AND "transcriptCiphertext" IS NULL
      AND "encryptionKeyVersion" BETWEEN 1 AND 2147483647
    ) OR (
      "eventKind" NOT IN ('turn_transcript_final', 'turn_agent_result')
      AND "transcriptCiphertext" IS NULL
      AND "canonicalReplyCiphertext" IS NULL
      AND "encryptionKeyVersion" IS NULL
    )
  )
);

CREATE INDEX realtime_voice_trace_subject_time_idx
  ON public.realtime_voice_trace_events ("companyId", "userId", "occurredAt");
CREATE INDEX realtime_voice_trace_session_order_idx
  ON public.realtime_voice_trace_events (
    "companyId", "sessionHandle", "ownerEpoch", "eventOrdinal"
  );
CREATE INDEX realtime_voice_trace_retention_idx
  ON public.realtime_voice_trace_events ("retentionExpiresAt", id);

CREATE TABLE public.realtime_voice_trace_access_audits (
  id UUID PRIMARY KEY,
  "requestId" UUID NOT NULL UNIQUE,
  "companyId" TEXT NOT NULL,
  "subjectUserId" UUID NOT NULL,
  "sessionHandle" UUID NOT NULL,
  actor VARCHAR(63) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  ticket VARCHAR(64) NOT NULL,
  "includedContent" BOOLEAN NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "accessedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  "retentionExpiresAt" TIMESTAMPTZ(6) NOT NULL
    DEFAULT (pg_catalog.transaction_timestamp() + INTERVAL '2160 hours'),
  CONSTRAINT realtime_voice_trace_access_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT realtime_voice_trace_access_actor_check CHECK (
    actor ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
  ),
  CONSTRAINT realtime_voice_trace_access_reason_check CHECK (
    reason = 'investigate_staging_voice_failure'
  ),
  CONSTRAINT realtime_voice_trace_access_ticket_check CHECK (
    ticket ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$'
  ),
  CONSTRAINT realtime_voice_trace_access_row_count_check CHECK (
    "rowCount" BETWEEN 0 AND 1000
  ),
  CONSTRAINT realtime_voice_trace_access_retention_check CHECK (
    "retentionExpiresAt" = "accessedAt" + INTERVAL '2160 hours'
  )
);

CREATE INDEX realtime_voice_trace_access_session_idx
  ON public.realtime_voice_trace_access_audits (
    "companyId", "sessionHandle", "accessedAt"
  );
CREATE INDEX realtime_voice_trace_access_subject_idx
  ON public.realtime_voice_trace_access_audits (
    "companyId", "subjectUserId", "accessedAt"
  );
CREATE INDEX realtime_voice_trace_access_retention_idx
  ON public.realtime_voice_trace_access_audits ("retentionExpiresAt", id);

REVOKE ALL PRIVILEGES ON TABLE public.realtime_voice_trace_events FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.realtime_voice_trace_access_audits FROM PUBLIC;
ALTER TABLE public.realtime_voice_trace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_voice_trace_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_voice_trace_access_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_voice_trace_access_audits FORCE ROW LEVEL SECURITY;

CREATE POLICY realtime_voice_trace_owner_all
  ON public.realtime_voice_trace_events FOR ALL
  USING (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_voice_trace_events'::pg_catalog.regclass
    ))
  )
  WITH CHECK (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_voice_trace_events'::pg_catalog.regclass
    ))
  );
CREATE POLICY realtime_voice_trace_subject_select
  ON public.realtime_voice_trace_events FOR SELECT
  USING (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
    AND "userId" = NULLIF(current_setting('app.current_user_id', TRUE), '')::UUID
  );
CREATE POLICY realtime_voice_trace_subject_insert
  ON public.realtime_voice_trace_events FOR INSERT
  WITH CHECK (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
    AND "userId" = NULLIF(current_setting('app.current_user_id', TRUE), '')::UUID
  );
CREATE POLICY realtime_voice_trace_reader_select
  ON public.realtime_voice_trace_events FOR SELECT
  USING (current_user = 'bob_realtime_voice_trace_reader');
CREATE POLICY realtime_voice_trace_readiness_select
  ON public.realtime_voice_trace_events FOR SELECT
  USING (current_user = 'bob_realtime_voice_trace_key_readiness');
CREATE POLICY realtime_voice_trace_maintenance_select
  ON public.realtime_voice_trace_events FOR SELECT
  USING (current_user = 'bob_realtime_voice_trace_maintenance');
CREATE POLICY realtime_voice_trace_maintenance_lock
  ON public.realtime_voice_trace_events FOR UPDATE
  USING (current_user = 'bob_realtime_voice_trace_maintenance')
  WITH CHECK (FALSE);
CREATE POLICY realtime_voice_trace_maintenance_delete
  ON public.realtime_voice_trace_events FOR DELETE
  USING (current_user = 'bob_realtime_voice_trace_maintenance');

CREATE POLICY realtime_voice_trace_access_owner_all
  ON public.realtime_voice_trace_access_audits FOR ALL
  USING (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid =
         'public.realtime_voice_trace_access_audits'::pg_catalog.regclass
    ))
  )
  WITH CHECK (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid =
         'public.realtime_voice_trace_access_audits'::pg_catalog.regclass
    ))
  );
CREATE POLICY realtime_voice_trace_access_reader_insert
  ON public.realtime_voice_trace_access_audits FOR INSERT
  WITH CHECK (current_user = 'bob_realtime_voice_trace_reader');
CREATE POLICY realtime_voice_trace_access_maintenance_select
  ON public.realtime_voice_trace_access_audits FOR SELECT
  USING (current_user = 'bob_realtime_voice_trace_maintenance');
CREATE POLICY realtime_voice_trace_access_maintenance_lock
  ON public.realtime_voice_trace_access_audits FOR UPDATE
  USING (current_user = 'bob_realtime_voice_trace_maintenance')
  WITH CHECK (FALSE);
CREATE POLICY realtime_voice_trace_access_maintenance_delete
  ON public.realtime_voice_trace_access_audits FOR DELETE
  USING (current_user = 'bob_realtime_voice_trace_maintenance');

CREATE FUNCTION public.prepare_realtime_voice_trace_event_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  previous_ordinal INTEGER;
  previous_session UUID;
  previous_owner_epoch INTEGER;
  previous_provider TEXT;
  previous_transport TEXT;
  previous_delivery TEXT;
BEGIN
  NEW."ingestedAt" := pg_catalog.transaction_timestamp();
  NEW."retentionExpiresAt" := NEW."ingestedAt" + INTERVAL '720 hours';
  IF NEW."occurredAt" < NEW."ingestedAt" - INTERVAL '24 hours'
     OR NEW."occurredAt" > NEW."ingestedAt" + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'realtime voice trace occurrence rejected' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW."companyId" || ':' || NEW."traceAttemptId"::TEXT, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.realtime_voice_trace_events AS existing
     WHERE existing."companyId" = NEW."companyId"
       AND existing."traceAttemptId" = NEW."traceAttemptId"
       AND existing."eventOrdinal" = NEW."eventOrdinal"
  ) THEN
    RETURN NEW;
  END IF;

  SELECT pg_catalog.max(trace."eventOrdinal")
    INTO previous_ordinal
    FROM public.realtime_voice_trace_events AS trace
   WHERE trace."companyId" = NEW."companyId"
     AND trace."traceAttemptId" = NEW."traceAttemptId";
  IF NEW."eventOrdinal" <> coalesce(previous_ordinal + 1, 1) THEN
    RAISE EXCEPTION 'realtime voice trace ordinal rejected' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.realtime_voice_trace_events AS trace
     WHERE trace."companyId" = NEW."companyId"
       AND trace."traceAttemptId" = NEW."traceAttemptId"
       AND trace."userId" <> NEW."userId"
  ) THEN
    RAISE EXCEPTION 'realtime voice trace subject drift' USING ERRCODE = '23514';
  END IF;
  SELECT trace."sessionHandle"
    INTO previous_session
    FROM public.realtime_voice_trace_events AS trace
   WHERE trace."companyId" = NEW."companyId"
     AND trace."traceAttemptId" = NEW."traceAttemptId"
     AND trace."sessionHandle" IS NOT NULL
   LIMIT 1;
  IF previous_session IS NOT NULL
     AND NEW."sessionHandle" IS DISTINCT FROM previous_session THEN
    RAISE EXCEPTION 'realtime voice trace session drift' USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.max(trace."ownerEpoch")
    INTO previous_owner_epoch
    FROM public.realtime_voice_trace_events AS trace
   WHERE trace."companyId" = NEW."companyId"
     AND trace."traceAttemptId" = NEW."traceAttemptId";
  IF previous_owner_epoch > 0 AND NEW."ownerEpoch" <> previous_owner_epoch THEN
    RAISE EXCEPTION 'realtime voice trace owner drift' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.realtime_voice_trace_events AS trace
     WHERE trace."companyId" = NEW."companyId"
       AND trace."traceAttemptId" = NEW."traceAttemptId"
       AND trace."eventKind" = 'session_closed'
  ) THEN
    RAISE EXCEPTION 'realtime voice trace attempt already closed' USING ERRCODE = '23514';
  END IF;
  IF NEW."eventKind" IN ('session_ready', 'session_closed') AND EXISTS (
    SELECT 1
      FROM public.realtime_voice_trace_events AS trace
     WHERE trace."companyId" = NEW."companyId"
       AND trace."traceAttemptId" = NEW."traceAttemptId"
       AND trace."eventKind" = NEW."eventKind"
  ) THEN
    RAISE EXCEPTION 'realtime voice trace singleton event repeated' USING ERRCODE = '23514';
  END IF;

  SELECT trace.provider, trace.transport, trace."speechDelivery"
    INTO previous_provider, previous_transport, previous_delivery
    FROM public.realtime_voice_trace_events AS trace
   WHERE trace."companyId" = NEW."companyId"
     AND trace."traceAttemptId" = NEW."traceAttemptId"
     AND (
       trace.provider IS NOT NULL
       OR trace.transport IS NOT NULL
       OR trace."speechDelivery" IS NOT NULL
     )
   ORDER BY trace."eventOrdinal"
   LIMIT 1;
  IF previous_provider IS NOT NULL
     AND NEW.provider IS NOT NULL
     AND NEW.provider <> previous_provider THEN
    RAISE EXCEPTION 'realtime voice trace provider drift' USING ERRCODE = '23514';
  END IF;
  IF previous_transport IS NOT NULL
     AND NEW.transport IS NOT NULL
     AND NEW.transport <> previous_transport THEN
    RAISE EXCEPTION 'realtime voice trace transport drift' USING ERRCODE = '23514';
  END IF;
  IF previous_delivery IS NOT NULL
     AND NEW."speechDelivery" IS NOT NULL
     AND NEW."speechDelivery" <> previous_delivery THEN
    RAISE EXCEPTION 'realtime voice trace delivery drift' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.prepare_realtime_voice_trace_access_audit_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.actor := session_user;
  NEW."accessedAt" := pg_catalog.transaction_timestamp();
  NEW."retentionExpiresAt" := NEW."accessedAt" + INTERVAL '2160 hours';
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.deny_realtime_voice_trace_mutation_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION public.guard_realtime_voice_trace_delete_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  deletion_reason TEXT := current_setting('app.realtime_voice_trace_delete_reason', TRUE);
BEGIN
  IF current_user = 'bob_realtime_voice_trace_maintenance'
     AND deletion_reason = 'retention' THEN
    IF OLD."retentionExpiresAt" > pg_catalog.transaction_timestamp() THEN
      RAISE EXCEPTION 'realtime voice trace premature purge rejected' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF current_user = 'bob_realtime_voice_trace_maintenance'
     AND deletion_reason IN ('account_closure', 'subject_erasure') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'realtime voice trace delete authority rejected' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_realtime_voice_trace_event_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_realtime_voice_trace_access_audit_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_realtime_voice_trace_mutation_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_voice_trace_delete_v2() FROM PUBLIC;

CREATE TRIGGER realtime_voice_trace_prepare_event
BEFORE INSERT ON public.realtime_voice_trace_events
FOR EACH ROW EXECUTE FUNCTION public.prepare_realtime_voice_trace_event_v2();
CREATE TRIGGER realtime_voice_trace_update_denied
BEFORE UPDATE ON public.realtime_voice_trace_events
FOR EACH ROW EXECUTE FUNCTION public.deny_realtime_voice_trace_mutation_v2();
CREATE TRIGGER realtime_voice_trace_truncate_denied
BEFORE TRUNCATE ON public.realtime_voice_trace_events
FOR EACH STATEMENT EXECUTE FUNCTION public.deny_realtime_voice_trace_mutation_v2();
CREATE TRIGGER realtime_voice_trace_delete_guard
BEFORE DELETE ON public.realtime_voice_trace_events
FOR EACH ROW EXECUTE FUNCTION public.guard_realtime_voice_trace_delete_v2();

CREATE TRIGGER realtime_voice_trace_access_prepare
BEFORE INSERT ON public.realtime_voice_trace_access_audits
FOR EACH ROW EXECUTE FUNCTION public.prepare_realtime_voice_trace_access_audit_v2();
CREATE TRIGGER realtime_voice_trace_access_update_denied
BEFORE UPDATE ON public.realtime_voice_trace_access_audits
FOR EACH ROW EXECUTE FUNCTION public.deny_realtime_voice_trace_mutation_v2();
CREATE TRIGGER realtime_voice_trace_access_truncate_denied
BEFORE TRUNCATE ON public.realtime_voice_trace_access_audits
FOR EACH STATEMENT EXECUTE FUNCTION public.deny_realtime_voice_trace_mutation_v2();
CREATE TRIGGER realtime_voice_trace_access_delete_guard
BEFORE DELETE ON public.realtime_voice_trace_access_audits
FOR EACH ROW EXECUTE FUNCTION public.guard_realtime_voice_trace_delete_v2();

CREATE FUNCTION public.erase_realtime_voice_trace_subject_v2(
  subject_company_id TEXT,
  subject_user_id UUID,
  deletion_reason TEXT
)
RETURNS TABLE ("deletedEvents" INTEGER, "deletedAccessAudits" INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $$
DECLARE
  deleted_events INTEGER;
  deleted_audits INTEGER;
BEGIN
  IF subject_company_id IS NULL OR subject_company_id !~ '^[A-Za-z0-9-]{1,64}$'
     OR subject_user_id IS NULL
     OR deletion_reason NOT IN ('account_closure', 'subject_erasure')
     OR subject_company_id IS DISTINCT FROM
        NULLIF(current_setting('app.current_company_id', TRUE), '')
     OR subject_user_id IS DISTINCT FROM
        NULLIF(current_setting('app.current_user_id', TRUE), '')::UUID THEN
    RAISE EXCEPTION 'realtime voice trace subject erasure rejected' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'app.realtime_voice_trace_delete_reason', deletion_reason, TRUE
  );
  -- Même ordre de verrouillage que la purge globale : événements puis audits. L'ordre inverse
  -- créait un cycle purge↔clôture de compte sous concurrence.
  DELETE FROM public.realtime_voice_trace_events AS trace
   WHERE trace."companyId" = subject_company_id
     AND trace."userId" = subject_user_id;
  GET DIAGNOSTICS deleted_events = ROW_COUNT;
  DELETE FROM public.realtime_voice_trace_access_audits AS audit
   WHERE audit."companyId" = subject_company_id
     AND audit."subjectUserId" = subject_user_id;
  GET DIAGNOSTICS deleted_audits = ROW_COUNT;
  RETURN QUERY SELECT deleted_events, deleted_audits;
END;
$$;

CREATE FUNCTION public.purge_realtime_voice_trace_v2(batch_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $$
DECLARE
  deleted_events INTEGER := 0;
  deleted_audits INTEGER := 0;
  event_limit INTEGER;
  audit_limit INTEGER;
  remaining INTEGER;
  filled INTEGER;
BEGIN
  IF batch_limit IS NULL OR batch_limit < 2 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'realtime voice trace purge batch rejected' USING ERRCODE = '22023';
  END IF;
  -- Réserver un budget à CHAQUE stock : un flux continu d'événements ne doit jamais empêcher
  -- les audits arrivés à 90 jours d'expirer. La somme reste strictement bornée à batch_limit.
  event_limit := (batch_limit + 1) / 2;
  audit_limit := batch_limit - event_limit;
  PERFORM pg_catalog.set_config(
    'app.realtime_voice_trace_delete_reason', 'retention', TRUE
  );
  WITH candidate AS (
    SELECT trace.id
      FROM public.realtime_voice_trace_events AS trace
     WHERE trace."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
     ORDER BY trace."retentionExpiresAt", trace.id
     FOR UPDATE SKIP LOCKED
     LIMIT event_limit
  ), deleted AS (
    DELETE FROM public.realtime_voice_trace_events AS trace
     USING candidate
     WHERE trace.id = candidate.id
       AND trace."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
     RETURNING trace.id
  )
  SELECT pg_catalog.count(*)::INTEGER INTO deleted_events FROM deleted;

  WITH candidate AS (
    SELECT audit.id
      FROM public.realtime_voice_trace_access_audits AS audit
     WHERE audit."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
     ORDER BY audit."retentionExpiresAt", audit.id
     FOR UPDATE SKIP LOCKED
     LIMIT audit_limit
  ), deleted AS (
    DELETE FROM public.realtime_voice_trace_access_audits AS audit
     USING candidate
     WHERE audit.id = candidate.id
       AND audit."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
     RETURNING audit.id
  )
  SELECT pg_catalog.count(*)::INTEGER INTO deleted_audits FROM deleted;

  -- Réutiliser la capacité non consommée sans reprendre le quota équitable déjà tenté par
  -- chaque stock. Les événements remplissent d'abord le reliquat ; s'ils n'en ont pas besoin,
  -- les audits le récupèrent. Le total ne dépasse jamais batch_limit.
  remaining := batch_limit - deleted_events - deleted_audits;
  IF remaining > 0 THEN
    WITH candidate AS (
      SELECT trace.id
        FROM public.realtime_voice_trace_events AS trace
       WHERE trace."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
       ORDER BY trace."retentionExpiresAt", trace.id
       FOR UPDATE SKIP LOCKED
       LIMIT remaining
    ), deleted AS (
      DELETE FROM public.realtime_voice_trace_events AS trace
       USING candidate
       WHERE trace.id = candidate.id
         AND trace."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
       RETURNING trace.id
    )
    SELECT pg_catalog.count(*)::INTEGER INTO filled FROM deleted;
    deleted_events := deleted_events + filled;
    remaining := remaining - filled;
  END IF;
  IF remaining > 0 THEN
    WITH candidate AS (
      SELECT audit.id
        FROM public.realtime_voice_trace_access_audits AS audit
       WHERE audit."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
       ORDER BY audit."retentionExpiresAt", audit.id
       FOR UPDATE SKIP LOCKED
       LIMIT remaining
    ), deleted AS (
      DELETE FROM public.realtime_voice_trace_access_audits AS audit
       USING candidate
       WHERE audit.id = candidate.id
         AND audit."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
       RETURNING audit.id
    )
    SELECT pg_catalog.count(*)::INTEGER INTO filled FROM deleted;
    deleted_audits := deleted_audits + filled;
  END IF;
  RETURN deleted_events + deleted_audits;
END;
$$;

CREATE FUNCTION public.inspect_realtime_voice_trace_retention_v2()
RETURNS TABLE (due INTEGER, "oldestExpiredAt" TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '3s'
SET lock_timeout = '1s'
AS $$
  WITH due_rows AS (
    SELECT trace."retentionExpiresAt" AS expired_at
      FROM public.realtime_voice_trace_events AS trace
     WHERE trace."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
    UNION ALL
    SELECT audit."retentionExpiresAt" AS expired_at
      FROM public.realtime_voice_trace_access_audits AS audit
     WHERE audit."retentionExpiresAt" <= pg_catalog.transaction_timestamp()
  )
  SELECT CASE
           WHEN pg_catalog.count(*) > 2147483647::BIGINT THEN 2147483647
           ELSE pg_catalog.count(*)::INTEGER
         END,
         pg_catalog.min(expired_at)
    FROM due_rows;
$$;

CREATE FUNCTION public.assert_realtime_voice_trace_key_versions_v2(
  configured_versions INTEGER[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '3s'
SET lock_timeout = '1s'
AS $$
BEGIN
  IF configured_versions IS NULL
     OR pg_catalog.cardinality(configured_versions) < 1
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(configured_versions) AS version
        WHERE version IS NULL OR version < 1
     )
     OR pg_catalog.cardinality(configured_versions) <>
        (
          SELECT pg_catalog.count(DISTINCT version)
            FROM pg_catalog.unnest(configured_versions) AS version
        ) THEN
    RAISE EXCEPTION 'realtime voice trace configured key versions rejected'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.realtime_voice_trace_events AS trace
     WHERE NOT trace."eventDigestKeyVersion" = ANY(configured_versions)
        OR (
          trace."encryptionKeyVersion" IS NOT NULL
          AND NOT trace."encryptionKeyVersion" = ANY(configured_versions)
        )
  ) THEN
    RAISE EXCEPTION 'realtime voice trace retained key version missing'
      USING ERRCODE = '55000';
  END IF;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION public.read_realtime_voice_trace_session_v2(
  access_request_id UUID,
  subject_company_id TEXT,
  subject_user_id UUID,
  subject_session_handle UUID,
  access_reason TEXT,
  access_ticket TEXT,
  include_content BOOLEAN
)
RETURNS TABLE (
  id UUID,
  "traceAttemptId" UUID,
  "sessionHandle" UUID,
  "ownerEpoch" INTEGER,
  "eventOrdinal" INTEGER,
  "eventKind" VARCHAR(40),
  "turnId" UUID,
  "occurredAt" TIMESTAMPTZ,
  "durationMs" INTEGER,
  "contextRevision" INTEGER,
  "contextDigest" CHAR(64),
  "speechDelivery" VARCHAR(40),
  "plannerDisposition" VARCHAR(32),
  "plannerAuthority" VARCHAR(16),
  "plannerIntent" VARCHAR(64),
  "missionKind" VARCHAR(100),
  "runKind" VARCHAR(16),
  "controlKind" VARCHAR(24),
  stage VARCHAR(32),
  outcome VARCHAR(24),
  "failureClass" VARCHAR(64),
  "interruptionReason" VARCHAR(32),
  "eventDigestKeyVersion" INTEGER,
  "encryptionKeyVersion" INTEGER,
  "transcriptCiphertext" TEXT,
  "canonicalReplyCiphertext" TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $$
DECLARE
  matching_rows INTEGER;
  selected_rows JSONB;
BEGIN
  IF access_request_id IS NULL
     OR subject_company_id IS NULL
     OR subject_company_id !~ '^[A-Za-z0-9-]{1,64}$'
     OR subject_user_id IS NULL
     OR subject_session_handle IS NULL
     OR access_reason <> 'investigate_staging_voice_failure'
     OR access_ticket IS NULL
     OR access_ticket !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$'
     OR include_content IS NULL THEN
    RAISE EXCEPTION 'realtime voice trace access request rejected' USING ERRCODE = '22023';
  END IF;
  -- Un seul snapshot borné alimente à la fois rowCount et le jeu retourné. Le JSONB est une
  -- variable locale au SECURITY DEFINER, jamais une colonne/payload libre ni une table temporaire.
  -- Sa forme reste fermée ici et le contrat de retour reste entièrement typé.
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', selected.id,
           'trace_attempt_id', selected."traceAttemptId",
           'session_handle', selected."sessionHandle",
           'owner_epoch', selected."ownerEpoch",
           'event_ordinal', selected."eventOrdinal",
           'event_kind', selected."eventKind",
           'turn_id', selected."turnId",
           'occurred_at', selected."occurredAt",
           'duration_ms', selected."durationMs",
           'context_revision', selected."contextRevision",
           'context_digest', selected."contextDigest",
           'speech_delivery', selected."speechDelivery",
           'planner_disposition', selected."plannerDisposition",
           'planner_authority', selected."plannerAuthority",
           'planner_intent', selected."plannerIntent",
           'mission_kind', selected."missionKind",
           'run_kind', selected."runKind",
           'control_kind', selected."controlKind",
           'event_stage', selected.stage,
           'event_outcome', selected.outcome,
           'failure_class', selected."failureClass",
           'interruption_reason', selected."interruptionReason",
           'digest_version', selected."eventDigestKeyVersion",
           'encryption_version', selected."encryptionKeyVersion",
           'transcript_ciphertext', CASE
             WHEN include_content THEN selected."transcriptCiphertext" ELSE NULL
           END,
           'reply_ciphertext', CASE
             WHEN include_content THEN selected."canonicalReplyCiphertext" ELSE NULL
           END
         ) ORDER BY selected."eventOrdinal"), '[]'::JSONB)
    INTO selected_rows
    FROM (
      SELECT trace.id,
             trace."traceAttemptId",
             trace."sessionHandle",
             trace."ownerEpoch",
             trace."eventOrdinal",
             trace."eventKind",
             trace."turnId",
             trace."occurredAt",
             trace."durationMs",
             trace."contextRevision",
             trace."contextDigest",
             trace."speechDelivery",
             trace."plannerDisposition",
             trace."plannerAuthority",
             trace."plannerIntent",
             trace."missionKind",
             trace."runKind",
             trace."controlKind",
             trace.stage,
             trace.outcome,
             trace."failureClass",
             trace."interruptionReason",
             trace."eventDigestKeyVersion",
             trace."encryptionKeyVersion",
             trace."transcriptCiphertext",
             trace."canonicalReplyCiphertext"
        FROM public.realtime_voice_trace_events AS trace
       WHERE trace."companyId" = subject_company_id
         AND trace."userId" = subject_user_id
         AND trace."sessionHandle" = subject_session_handle
       ORDER BY trace."eventOrdinal"
       LIMIT 1001
    ) AS selected;
  matching_rows := pg_catalog.jsonb_array_length(selected_rows);
  IF matching_rows > 1000 THEN
    RAISE EXCEPTION 'realtime voice trace access row limit exceeded' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.realtime_voice_trace_access_audits (
    id, "requestId", "companyId", "subjectUserId", "sessionHandle",
    reason, ticket, "includedContent", "rowCount"
  ) VALUES (
    pg_catalog.gen_random_uuid(), access_request_id, subject_company_id, subject_user_id,
    subject_session_handle, access_reason, access_ticket,
    include_content, matching_rows
  );
  RETURN QUERY
  SELECT selected.id,
         selected.trace_attempt_id,
         selected.session_handle,
         selected.owner_epoch,
         selected.event_ordinal,
         selected.event_kind,
         selected.turn_id,
         selected.occurred_at,
         selected.duration_ms,
         selected.context_revision,
         selected.context_digest,
         selected.speech_delivery,
         selected.planner_disposition,
         selected.planner_authority,
         selected.planner_intent,
         selected.mission_kind,
         selected.run_kind,
         selected.control_kind,
         selected.event_stage,
         selected.event_outcome,
         selected.failure_class,
         selected.interruption_reason,
         selected.digest_version,
         selected.encryption_version,
         selected.transcript_ciphertext,
         selected.reply_ciphertext
    FROM pg_catalog.jsonb_to_recordset(selected_rows) AS selected(
      id UUID,
      trace_attempt_id UUID,
      session_handle UUID,
      owner_epoch INTEGER,
      event_ordinal INTEGER,
      event_kind VARCHAR(40),
      turn_id UUID,
      occurred_at TIMESTAMPTZ,
      duration_ms INTEGER,
      context_revision INTEGER,
      context_digest CHAR(64),
      speech_delivery VARCHAR(40),
      planner_disposition VARCHAR(32),
      planner_authority VARCHAR(16),
      planner_intent VARCHAR(64),
      mission_kind VARCHAR(100),
      run_kind VARCHAR(16),
      control_kind VARCHAR(24),
      event_stage VARCHAR(32),
      event_outcome VARCHAR(24),
      failure_class VARCHAR(64),
      interruption_reason VARCHAR(32),
      digest_version INTEGER,
      encryption_version INTEGER,
      transcript_ciphertext TEXT,
      reply_ciphertext TEXT
    )
   ORDER BY selected.event_ordinal;
END;
$$;

REVOKE ALL ON FUNCTION public.erase_realtime_voice_trace_subject_v2(TEXT, UUID, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_realtime_voice_trace_v2(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inspect_realtime_voice_trace_retention_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_realtime_voice_trace_key_versions_v2(INTEGER[])
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v2(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;

DO $realtime_voice_trace_data_api_fence$
DECLARE
  exposed_role TEXT;
  protected_function REGPROCEDURE;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NULL THEN CONTINUE; END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.realtime_voice_trace_events FROM %I CASCADE',
      exposed_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.realtime_voice_trace_access_audits FROM %I CASCADE',
      exposed_role
    );
    FOR protected_function IN
      SELECT function_oid
        FROM pg_catalog.unnest(ARRAY[
          'public.prepare_realtime_voice_trace_event_v2()'::REGPROCEDURE,
          'public.prepare_realtime_voice_trace_access_audit_v2()'::REGPROCEDURE,
          'public.deny_realtime_voice_trace_mutation_v2()'::REGPROCEDURE,
          'public.guard_realtime_voice_trace_delete_v2()'::REGPROCEDURE,
          'public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
          'public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
          'public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
          'public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE,
          'public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE
        ]) AS function_oid
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
        protected_function,
        exposed_role
      );
    END LOOP;
  END LOOP;
END;
$realtime_voice_trace_data_api_fence$;

COMMIT;
