-- Bob AgentMission M1-B — namespace de commande déterminé par le type d'événement.
-- L'ACK écran consomme un commandId HTTP v4 bien que son acteur soit `system`. UUID v8 reste
-- temporairement accepté pour cet ACK afin que le writer N-1 continue pendant le rollout.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_envelope_v2_check CHECK (
    "eventVersion" = 1
    AND "actor" IN (
      -- BEGIN GENERATED AGENT_MISSION_ACTORS
      'user_voice',
      'user_tap',
      'system'
      -- END GENERATED AGENT_MISSION_ACTORS
    )
    AND (
      (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_USER_EVENT_TYPES
          'mission_started',
          'mission_joined',
          'draft_resume_selected',
          'draft_discard_requested',
          'draft_discard_cancelled',
          'draft_discard_confirmed',
          'customer_not_found',
          'customer_choice_presented',
          'customer_selected',
          'decision_invalidated',
          'mission_cancelled'
          -- END GENERATED AGENT_MISSION_CORRELATION_USER_EVENT_TYPES
        )
        AND "actor" IN (
          -- BEGIN GENERATED AGENT_MISSION_USER_ACTORS
          'user_voice',
          'user_tap'
          -- END GENERATED AGENT_MISSION_USER_ACTORS
        )
        AND "commandId"::TEXT
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
      OR (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES
          'screen_acknowledged'
          -- END GENERATED AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES
        )
        AND "actor" = 'system'
        AND (
          "commandId"::TEXT
            ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
          OR "commandId"::TEXT
            ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        )
      )
      OR (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES
          'mission_expired'
          -- END GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES
        )
        AND "actor" = 'system'
        AND "commandId"::TEXT
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
    )
    AND "requestFingerprintHmac"::TEXT ~ '^[a-f0-9]{64}$'
    AND "fingerprintKeyVersion" BETWEEN 1 AND 2147483647
    AND "fingerprintCanonicalizationVersion" = 1
    AND "sequence" = "missionRevisionAfter"
    AND (
      (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
          'mission_started'
          -- END GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
        )
        AND "missionRevisionBefore" = 0
        AND "missionRevisionAfter" = 1
      )
      OR (
        "eventType" NOT IN (
          -- BEGIN GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
          'mission_started'
          -- END GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
        )
        AND "missionRevisionBefore" BETWEEN 1 AND 2147483646
        AND "missionRevisionAfter" = "missionRevisionBefore" + 1
      )
    )
  ) NOT VALID;

COMMIT;
