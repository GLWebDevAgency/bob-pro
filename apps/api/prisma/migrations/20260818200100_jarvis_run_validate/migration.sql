-- Jarvis U1-a — validate séparé (convention expand/validate maison).
-- Les VALIDATE ne prennent qu'un SHARE UPDATE EXCLUSIVE : sûrs sous trafic writer N-1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Même élévation contrôlée que l'expand (contrat Supabase non-superuser).
DO $bob_jarvis_u1a_validate_owner$
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
        MESSAGE = 'JARVIS_U1A_VALIDATE_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1A_VALIDATE_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1a_validate_owner$;

ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_definition_version_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_kind_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_status_check;

COMMIT;
