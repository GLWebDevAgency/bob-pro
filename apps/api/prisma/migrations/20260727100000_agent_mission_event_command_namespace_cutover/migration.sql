-- Bob AgentMission M1-B — cutover après validation. La contrainte V2 reste compatible writer N-1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_envelope_check;

ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_envelope_v2_check
  TO agent_mission_events_envelope_check;

COMMIT;
