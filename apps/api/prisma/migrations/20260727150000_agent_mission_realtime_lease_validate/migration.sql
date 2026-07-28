-- Bob AgentMission M1-B — validation séparée de la forme nullable writer N-1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.realtime_session_leases
  VALIDATE CONSTRAINT realtime_session_leases_agent_mission_capability_shape_check;

COMMIT;
