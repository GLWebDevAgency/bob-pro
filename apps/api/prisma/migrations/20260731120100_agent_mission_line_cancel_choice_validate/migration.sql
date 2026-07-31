-- Bob AgentMission M2-A-3 — validation séparée du CHECK événement.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $bob_m2a3_validate_events_owner$
DECLARE
  owner_oid OID;
  owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT owner_oid, owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'agent_mission_events'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A3_VALIDATE_EVENTS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A3_VALIDATE_EVENTS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a3_validate_events_owner$;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_data_m2a3_check;
RESET ROLE;

COMMIT;
