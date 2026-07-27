-- Bob AgentMission M1-B — validation séparée du nouveau namespace de commandes.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_envelope_v2_check;

COMMIT;
