-- Bob AgentMission M2-A-3 — cutover du CHECK après validation et writers N-1.
-- Le flag bob.agent_missions.quote.m2a reste OFF.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $bob_m2a3_cutover_release_flags_owner$
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
     AND relation.relname = 'release_flags'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A3_CUTOVER_RELEASE_FLAGS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A3_CUTOVER_RELEASE_FLAGS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a3_cutover_release_flags_owner$;

ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;

DO $bob_m2a3_cutover_release_flag_exact$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM public.release_flags AS flag
     WHERE flag.key = 'bob.agent_missions.quote.m2a'
  ) <> 3
  OR EXISTS (
    SELECT 1
      FROM public.release_flags AS flag
     WHERE flag.key = 'bob.agent_missions.quote.m2a'
       AND (
         flag.environment::TEXT NOT IN ('development', 'staging', 'production')
         OR flag.enabled
         OR flag."killSwitch"
         OR flag.version <> 1
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'AGENT_MISSION_M2A3_CUTOVER_FLAG_NOT_EXACTLY_OFF';
  END IF;
END;
$bob_m2a3_cutover_release_flag_exact$;

ALTER TABLE public.release_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_flags FORCE ROW LEVEL SECURITY;
RESET ROLE;

DO $bob_m2a3_cutover_events_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A3_CUTOVER_EVENTS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A3_CUTOVER_EVENTS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a3_cutover_events_owner$;
ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_data_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_data_m2a3_check
    TO agent_mission_events_data_check;
RESET ROLE;

COMMIT;
