-- Bob AgentMission M1-C — cutover atomique après validation, flag M1-C toujours OFF.
-- Les contraintes finales continuent d'accepter les payloads et événements du writer N-1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_payload_check,
  DROP CONSTRAINT agent_missions_payload_closed_shape_check,
  DROP CONSTRAINT agent_missions_phase_payload_check;

ALTER TABLE public.agent_missions
  RENAME CONSTRAINT agent_missions_payload_m1c_check
    TO agent_missions_payload_check;
ALTER TABLE public.agent_missions
  RENAME CONSTRAINT agent_missions_payload_closed_shape_m1c_check
    TO agent_missions_payload_closed_shape_check;
ALTER TABLE public.agent_missions
  RENAME CONSTRAINT agent_missions_phase_payload_m1c_check
    TO agent_missions_phase_payload_check;

ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_type_check,
  DROP CONSTRAINT agent_mission_events_envelope_check,
  DROP CONSTRAINT agent_mission_events_data_check,
  DROP CONSTRAINT agent_mission_events_correlation_check,
  DROP CONSTRAINT agent_mission_events_draft_effect_check;

ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_type_m1c_check
    TO agent_mission_events_type_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_envelope_m1c_check
    TO agent_mission_events_envelope_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_data_m1c_check
    TO agent_mission_events_data_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_correlation_m1c_check
    TO agent_mission_events_correlation_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_draft_effect_m1c_check
    TO agent_mission_events_draft_effect_check;

COMMIT;
