-- Bob AgentMission M1-C — validation séparée des unions élargies, sans cutover.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_payload_m1c_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_payload_closed_shape_m1c_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_phase_payload_m1c_check;

ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_type_m1c_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_envelope_m1c_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_data_m1c_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_correlation_m1c_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_draft_effect_m1c_check;

COMMIT;
