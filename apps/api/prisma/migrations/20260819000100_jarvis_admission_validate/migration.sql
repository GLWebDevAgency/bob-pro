-- Jarvis U1-c — validate séparé (convention expand/validate maison, U1-a 20260818200100).
-- Les VALIDATE ne prennent qu'un SHARE UPDATE EXCLUSIVE : sûrs sous trafic writer N-1.
-- La branche quote de chaque contrainte étant VERBATIM, chaque ligne historique qui
-- satisfaisait l'ancien prédicat satisfait le nouveau : la validation ne peut échouer
-- que si une ligne violait déjà l'état N-1 — auquel cas elle DOIT échouer.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Même élévation contrôlée que l'expand (contrat Supabase non-superuser).
DO $bob_jarvis_u1c_validate_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'agent_missions'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'JARVIS_U1C_VALIDATE_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1C_VALIDATE_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1c_validate_owner$;

ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_protocol_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_phase_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_payload_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_payload_closed_shape_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_phase_payload_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_timestamps_check;

ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_type_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_envelope_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_data_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_correlation_check;
ALTER TABLE public.agent_mission_events
  VALIDATE CONSTRAINT agent_mission_events_draft_effect_check;

COMMIT;
