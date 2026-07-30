-- Bob AgentMission M2-A-1 — validation séparée, sans cutover.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $bob_m2a1_validate_missions_owner$
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
     AND relation.relname = 'agent_missions'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A1_VALIDATE_MISSIONS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A1_VALIDATE_MISSIONS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a1_validate_missions_owner$;

ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_protocol_m2a1_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_phase_m2a1_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_payload_closed_shape_m2a1_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_phase_payload_m2a1_check;

RESET ROLE;

DO $bob_m2a1_validate_events_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A1_VALIDATE_EVENTS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A1_VALIDATE_EVENTS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a1_validate_events_owner$;

ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_type_m2a1_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_envelope_m2a1_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_data_m2a1_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_correlation_m2a1_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_draft_effect_m2a1_check;

RESET ROLE;

DO $bob_m2a1_validate_line_work_owner$
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
     AND relation.relname = 'agent_mission_quote_line_work'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A1_VALIDATE_LINE_WORK_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A1_VALIDATE_LINE_WORK_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a1_validate_line_work_owner$;

ALTER TABLE public.agent_mission_quote_line_work
  VALIDATE CONSTRAINT agent_mission_quote_line_work_ordinal_m2a1_check;
ALTER TABLE public.agent_mission_quote_line_work
  VALIDATE CONSTRAINT agent_mission_quote_line_work_catalogue_resolution_m2a1_check;
ALTER TABLE public.agent_mission_quote_line_work
  VALIDATE CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a1_check;

RESET ROLE;

DO $bob_m2a1_validate_realtime_leases_owner$
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
     AND relation.relname = 'realtime_session_leases'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A1_VALIDATE_REALTIME_LEASES_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A1_VALIDATE_REALTIME_LEASES_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a1_validate_realtime_leases_owner$;

ALTER TABLE public.realtime_session_leases
  VALIDATE CONSTRAINT realtime_leases_agent_mission_capability_m2a1_check;
ALTER TABLE public.realtime_session_leases
  VALIDATE CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_m2a1_check;

RESET ROLE;

COMMIT;
