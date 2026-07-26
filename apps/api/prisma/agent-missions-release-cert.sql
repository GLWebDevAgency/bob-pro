\set ON_ERROR_STOP on

SELECT current_user = :'app_role' AS agent_mission_runtime_role_matches
\gset
\if :agent_mission_runtime_role_matches
\else
  \echo 'AgentMission ACL certificate must connect through DATABASE_URL as APP_DATABASE_ROLE'
  \quit 3
\endif

BEGIN READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $agent_mission_acl_certificate$
DECLARE
  table_name TEXT;
  table_oid OID;
  function_name TEXT;
  function_oid OID;
  privilege_name TEXT;
  exposed_role_name TEXT;
  exposed_role_oid OID;
  runtime_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT *
    INTO STRICT runtime_role
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF runtime_role.rolsuper OR runtime_role.rolbypassrls THEN
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_ROLE_MUST_ENFORCE_RLS';
  END IF;

  FOREACH table_name IN ARRAY ARRAY['agent_missions', 'agent_mission_events']::TEXT[] LOOP
    table_oid := pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name));
    IF table_oid IS NULL THEN
      RAISE EXCEPTION 'AGENT_MISSION_TABLE_MISSING:%', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class
       WHERE oid = table_oid
         AND relrowsecurity
         AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_FORCE_RLS_MISSING:%', table_name;
    END IF;
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE']::TEXT[] LOOP
    IF NOT pg_catalog.has_table_privilege(
      current_user,
      'public.agent_missions',
      privilege_name
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_REQUIRED_PRIVILEGE_MISSING:agent_missions:%',
        privilege_name;
    END IF;
  END LOOP;
  FOREACH privilege_name IN ARRAY ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(current_user, 'public.agent_missions', privilege_name) THEN
      RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_FORBIDDEN_PRIVILEGE:agent_missions:%',
        privilege_name;
    END IF;
  END LOOP;
  IF pg_catalog.has_any_column_privilege(
    current_user,
    'public.agent_missions',
    'REFERENCES'
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_COLUMN_PRIVILEGE_FORBIDDEN:agent_missions:REFERENCES';
  END IF;

  FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT']::TEXT[] LOOP
    IF NOT pg_catalog.has_table_privilege(
      current_user,
      'public.agent_mission_events',
      privilege_name
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_REQUIRED_PRIVILEGE_MISSING:agent_mission_events:%',
        privilege_name;
    END IF;
  END LOOP;
  FOREACH privilege_name IN ARRAY ARRAY[
    'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(
      current_user,
      'public.agent_mission_events',
      privilege_name
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_FORBIDDEN_PRIVILEGE:agent_mission_events:%',
        privilege_name;
    END IF;
  END LOOP;
  FOREACH privilege_name IN ARRAY ARRAY['UPDATE', 'REFERENCES']::TEXT[] LOOP
    IF pg_catalog.has_any_column_privilege(
      current_user,
      'public.agent_mission_events',
      privilege_name
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_COLUMN_PRIVILEGE_FORBIDDEN:agent_mission_events:%',
        privilege_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS privilege
     WHERE namespace.nspname = 'public'
       AND relation.relname IN ('agent_missions', 'agent_mission_events')
       AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_PUBLIC_TABLE_PRIVILEGE_FORBIDDEN';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
     WHERE namespace.nspname = 'public'
       AND relation.relname IN ('agent_missions', 'agent_mission_events')
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_PUBLIC_COLUMN_PRIVILEGE_FORBIDDEN';
  END IF;

  FOREACH function_name IN ARRAY ARRAY[
    'guard_agent_mission_mutation_v1()',
    'guard_quote_draft_agent_mission_v1()',
    'reject_agent_mission_event_mutation_v1()',
    'guard_agent_mission_event_append_v1()',
    'require_agent_mission_event_v1()'
  ]::TEXT[] LOOP
    function_oid := pg_catalog.to_regprocedure('public.' || function_name);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'AGENT_MISSION_FUNCTION_MISSING:%', function_name;
    END IF;
    IF pg_catalog.has_function_privilege(current_user, function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_FUNCTION_EXECUTE_FORBIDDEN:%', function_name;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(
           function.proacl,
           pg_catalog.acldefault('f', function.proowner)
         )
       ) AS privilege
       WHERE function.oid = function_oid
         AND privilege.grantee = 0
         AND privilege.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_PUBLIC_FUNCTION_EXECUTE_FORBIDDEN:%', function_name;
    END IF;
  END LOOP;

  FOREACH exposed_role_name IN ARRAY ARRAY[
    'anon', 'authenticated', 'service_role'
  ]::TEXT[] LOOP
    exposed_role_oid := pg_catalog.to_regrole(exposed_role_name);
    IF exposed_role_oid IS NULL THEN
      RAISE EXCEPTION 'AGENT_MISSION_DATA_API_ROLE_MISSING:%', exposed_role_name;
    END IF;
    FOREACH table_name IN ARRAY ARRAY['agent_missions', 'agent_mission_events']::TEXT[] LOOP
      FOREACH privilege_name IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]::TEXT[] LOOP
        IF pg_catalog.has_table_privilege(
          exposed_role_oid,
          pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)),
          privilege_name
        ) THEN
          RAISE EXCEPTION 'AGENT_MISSION_DATA_API_TABLE_PRIVILEGE_FORBIDDEN:%:%:%',
            exposed_role_name, table_name, privilege_name;
        END IF;
      END LOOP;
      FOREACH privilege_name IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      ]::TEXT[] LOOP
        IF pg_catalog.has_any_column_privilege(
          exposed_role_oid,
          pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)),
          privilege_name
        ) THEN
          RAISE EXCEPTION 'AGENT_MISSION_DATA_API_COLUMN_PRIVILEGE_FORBIDDEN:%:%:%',
            exposed_role_name, table_name, privilege_name;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH function_name IN ARRAY ARRAY[
      'guard_agent_mission_mutation_v1()',
      'guard_quote_draft_agent_mission_v1()',
      'reject_agent_mission_event_mutation_v1()',
      'guard_agent_mission_event_append_v1()',
      'require_agent_mission_event_v1()'
    ]::TEXT[] LOOP
      IF pg_catalog.has_function_privilege(
        exposed_role_oid,
        pg_catalog.to_regprocedure('public.' || function_name),
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION 'AGENT_MISSION_DATA_API_FUNCTION_EXECUTE_FORBIDDEN:%:%',
          exposed_role_name, function_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$agent_mission_acl_certificate$;

ROLLBACK;
