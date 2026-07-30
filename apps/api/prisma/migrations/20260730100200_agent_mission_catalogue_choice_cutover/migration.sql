-- Bob AgentMission M2-A-1 — cutover atomique après validation.
-- Le feature flag M2-A reste OFF ; aucun writer V2 n’est activé par cette migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $bob_m2a1_cutover_missions_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A1_CUTOVER_MISSIONS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A1_CUTOVER_MISSIONS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a1_cutover_missions_owner$;

ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_phase_check,
  DROP CONSTRAINT agent_missions_payload_closed_shape_check,
  DROP CONSTRAINT agent_missions_phase_payload_check;
ALTER TABLE public.agent_missions
  RENAME CONSTRAINT agent_missions_protocol_m2a1_check
    TO agent_missions_protocol_check;
ALTER TABLE public.agent_missions
  RENAME CONSTRAINT agent_missions_phase_m2a1_check
    TO agent_missions_phase_check;
ALTER TABLE public.agent_missions
  RENAME CONSTRAINT agent_missions_payload_closed_shape_m2a1_check
    TO agent_missions_payload_closed_shape_check;
ALTER TABLE public.agent_missions
  RENAME CONSTRAINT agent_missions_phase_payload_m2a1_check
    TO agent_missions_phase_payload_check;

DROP FUNCTION public.guard_agent_mission_mutation_v1();

RESET ROLE;

DO $bob_m2a1_cutover_events_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A1_CUTOVER_EVENTS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A1_CUTOVER_EVENTS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a1_cutover_events_owner$;

ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_type_check,
  DROP CONSTRAINT agent_mission_events_envelope_check,
  DROP CONSTRAINT agent_mission_events_data_check,
  DROP CONSTRAINT agent_mission_events_correlation_check,
  DROP CONSTRAINT agent_mission_events_draft_effect_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_type_m2a1_check
    TO agent_mission_events_type_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_envelope_m2a1_check
    TO agent_mission_events_envelope_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_data_m2a1_check
    TO agent_mission_events_data_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_correlation_m2a1_check
    TO agent_mission_events_correlation_check;
ALTER TABLE public.agent_mission_events
  RENAME CONSTRAINT agent_mission_events_draft_effect_m2a1_check
    TO agent_mission_events_draft_effect_check;

DROP FUNCTION public.guard_agent_mission_event_append_v1();

RESET ROLE;

DO $bob_m2a1_cutover_line_work_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A1_CUTOVER_LINE_WORK_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A1_CUTOVER_LINE_WORK_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a1_cutover_line_work_owner$;

ALTER TABLE public.agent_mission_quote_line_work
  DROP CONSTRAINT agent_mission_quote_line_work_ordinal_check,
  DROP CONSTRAINT agent_mission_quote_line_work_state_coherence_check;
ALTER TABLE public.agent_mission_quote_line_work
  RENAME CONSTRAINT agent_mission_quote_line_work_ordinal_m2a1_check
    TO agent_mission_quote_line_work_ordinal_check;
ALTER TABLE public.agent_mission_quote_line_work
  RENAME CONSTRAINT agent_mission_quote_line_work_catalogue_resolution_m2a1_check
    TO agent_mission_quote_line_work_catalogue_resolution_check;
ALTER TABLE public.agent_mission_quote_line_work
  RENAME CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a1_check
    TO agent_mission_quote_line_work_state_coherence_check;
DROP FUNCTION public.guard_agent_mission_quote_line_work_v1();

RESET ROLE;

DO $bob_m2a1_cutover_realtime_leases_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A1_CUTOVER_REALTIME_LEASES_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A1_CUTOVER_REALTIME_LEASES_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a1_cutover_realtime_leases_owner$;

ALTER TABLE public.realtime_session_leases
  DROP CONSTRAINT realtime_session_leases_agent_mission_capability_shape_check,
  DROP CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_check;
ALTER TABLE public.realtime_session_leases
  RENAME CONSTRAINT realtime_leases_agent_mission_capability_m2a1_check
    TO realtime_session_leases_agent_mission_capability_shape_check;
ALTER TABLE public.realtime_session_leases
  RENAME CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_m2a1_check
    TO realtime_leases_agent_mission_bootstrap_receipt_check;
DROP FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1();

RESET ROLE;

COMMIT;
