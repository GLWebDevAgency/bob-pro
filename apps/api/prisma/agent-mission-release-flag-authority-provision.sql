\set ON_ERROR_STOP on

SELECT pg_catalog.set_config('app.release_runtime_role', :'app_role', true);

DO $agent_mission_release_flag_inventory$
DECLARE
  function_owner OID;
BEGIN
  IF pg_catalog.to_regrole(current_setting('app.release_runtime_role', true)) IS NULL THEN
    RAISE EXCEPTION 'AgentMission release flag runtime role is missing';
  END IF;
  SELECT function.proowner
    INTO STRICT function_owner
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.revalidate_agent_mission_release_flag_v1(text,text,integer)'::pg_catalog.regprocedure;
  IF function_owner NOT IN (
    (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user),
    'bob_agent_mission_release_flag_authority'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'AgentMission release flag helper has an unexpected owner';
  END IF;
END;
$agent_mission_release_flag_inventory$;

-- Les ACL de tables sont modifiées sous leur propriétaire exact, jamais après un transfert sans
-- SET ROLE. L'autorité ne voit que la ligne parente ; ni overrides ni audit.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT USAGE, CREATE ON SCHEMA public TO bob_agent_mission_release_flag_authority; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 WHERE namespace.nspname = 'public'
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.%I FROM bob_agent_mission_release_flag_authority; RESET ROLE;',
  owner.rolname,
  relation.relname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.relname IN (
   'release_flags',
   'release_flag_subjects',
   'release_flag_audit_events'
 )
 ORDER BY relation.relname
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM bob_agent_mission_release_flag_authority; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  relation.relname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 WHERE relation.relname IN (
   'release_flags',
   'release_flag_subjects',
   'release_flag_audit_events'
 )
 ORDER BY relation.relname, attribute.attnum
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT SELECT ON TABLE public.release_flags TO bob_agent_mission_release_flag_authority; GRANT UPDATE (id) ON TABLE public.release_flags TO bob_agent_mission_release_flag_authority; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.relname = 'release_flags'
\gexec

SELECT pg_catalog.format(
  'ALTER FUNCTION %s OWNER TO bob_agent_mission_release_flag_authority',
  function.oid::pg_catalog.regprocedure
)
  FROM pg_catalog.pg_proc AS function
 WHERE function.oid =
   'public.revalidate_agent_mission_release_flag_v1(text,text,integer)'::pg_catalog.regprocedure
   AND function.proowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec

SET LOCAL ROLE bob_agent_mission_release_flag_authority;
REVOKE ALL ON FUNCTION public.revalidate_agent_mission_release_flag_v1(
  TEXT,
  TEXT,
  INTEGER
) FROM PUBLIC;
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION public.revalidate_agent_mission_release_flag_v1(TEXT, TEXT, INTEGER) FROM %I',
  role.rolname
)
  FROM pg_catalog.pg_roles AS role
 WHERE role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec
REVOKE ALL ON FUNCTION public.revalidate_agent_mission_release_flag_v1(
  TEXT,
  TEXT,
  INTEGER
) FROM :"app_role";
GRANT EXECUTE ON FUNCTION public.revalidate_agent_mission_release_flag_v1(
  TEXT,
  TEXT,
  INTEGER
) TO :"app_role";
ALTER FUNCTION public.revalidate_agent_mission_release_flag_v1(TEXT, TEXT, INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION public.revalidate_agent_mission_release_flag_v1(TEXT, TEXT, INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.revalidate_agent_mission_release_flag_v1(TEXT, TEXT, INTEGER)
  SET row_security = on;
ALTER FUNCTION public.revalidate_agent_mission_release_flag_v1(TEXT, TEXT, INTEGER)
  SET lock_timeout = '1s';
ALTER FUNCTION public.revalidate_agent_mission_release_flag_v1(TEXT, TEXT, INTEGER)
  SET statement_timeout = '3s';
RESET ROLE;

-- CREATE n'était requis que pour devenir propriétaire du helper. Il ne reste jamais durablement
-- sur le rôle d'autorité.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE CREATE ON SCHEMA public FROM bob_agent_mission_release_flag_authority; GRANT USAGE ON SCHEMA public TO bob_agent_mission_release_flag_authority; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 WHERE namespace.nspname = 'public'
\gexec

DO $agent_mission_release_flag_acl_certificate$
DECLARE
  app_role_name TEXT := current_setting('app.release_runtime_role', true);
  authority pg_catalog.pg_roles%ROWTYPE;
  helper pg_catalog.pg_proc%ROWTYPE;
  exposed_role TEXT;
  column_name TEXT;
BEGIN
  SELECT *
    INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_agent_mission_release_flag_authority';
  SELECT *
    INTO STRICT helper
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.revalidate_agent_mission_release_flag_v1(text,text,integer)'::pg_catalog.regprocedure;

  IF helper.proowner <> authority.oid
     OR NOT helper.prosecdef
     OR helper.proconfig IS NULL
     OR NOT helper.proconfig @> ARRAY[
       'search_path=pg_catalog',
       'row_security=on',
       'lock_timeout=1s',
       'statement_timeout=3s'
     ]::TEXT[] THEN
    RAISE EXCEPTION 'AgentMission release flag helper authority drift';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(authority.rolname, 'public', 'USAGE')
     OR pg_catalog.has_schema_privilege(authority.rolname, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'AgentMission release flag authority schema ACL drift';
  END IF;
  IF NOT pg_catalog.has_table_privilege(
       authority.rolname,
       'public.release_flags',
       'SELECT'
     )
     OR NOT pg_catalog.has_column_privilege(
       authority.rolname,
       'public.release_flags',
       'id',
       'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.release_flags',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.release_flag_subjects',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.release_flag_audit_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'AgentMission release flag authority table ACL drift';
  END IF;
  FOR column_name IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.release_flags'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    IF (
      column_name = 'id'
      AND NOT pg_catalog.has_column_privilege(
        authority.rolname,
        'public.release_flags',
        column_name,
        'UPDATE'
      )
    ) OR (
      column_name <> 'id'
      AND pg_catalog.has_column_privilege(
        authority.rolname,
        'public.release_flags',
        column_name,
        'UPDATE'
      )
    ) OR pg_catalog.has_column_privilege(
      authority.rolname,
      'public.release_flags',
      column_name,
      'INSERT,REFERENCES'
    ) THEN
      RAISE EXCEPTION
        'AgentMission release flag authority column ACL drift on %',
        column_name;
    END IF;
  END LOOP;
  IF pg_catalog.has_any_column_privilege(
       authority.rolname,
       'public.release_flag_subjects',
       'SELECT,INSERT,UPDATE,REFERENCES'
     )
     OR pg_catalog.has_any_column_privilege(
       authority.rolname,
       'public.release_flag_audit_events',
       'SELECT,INSERT,UPDATE,REFERENCES'
     ) THEN
    RAISE EXCEPTION 'AgentMission release flag authority inherited a forbidden column ACL';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       app_role_name,
       helper.oid,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'AgentMission release flag helper is unavailable to runtime';
  END IF;
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
       AND pg_catalog.has_function_privilege(exposed_role, helper.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% can execute AgentMission release flag helper', exposed_role;
    END IF;
  END LOOP;
END;
$agent_mission_release_flag_acl_certificate$;
