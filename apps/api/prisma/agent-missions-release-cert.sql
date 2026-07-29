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
  owner_role_oid OID;
  reachable_role_oid OID;
  runtime_role pg_catalog.pg_roles%ROWTYPE;
  readiness_authority_oid OID :=
    pg_catalog.to_regrole('bob_agent_mission_fingerprint_readiness');
  readiness_row_count INTEGER;
  readiness_invalid_count INTEGER;
  quote_line_work_table_oid OID;
  quote_line_work_guard_oid OID;
  quote_line_work_trigger_count INTEGER;
  quote_line_work_policy_count INTEGER;
BEGIN
  SELECT *
    INTO STRICT runtime_role
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF runtime_role.rolsuper OR runtime_role.rolbypassrls THEN
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_ROLE_MUST_ENFORCE_RLS';
  END IF;
  IF readiness_authority_oid IS NULL
     OR pg_catalog.pg_has_role(
       runtime_role.oid,
       readiness_authority_oid,
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       runtime_role.oid,
       readiness_authority_oid,
       'SET'
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_READINESS_AUTHORITY_MEMBERSHIP_FORBIDDEN';
  END IF;
  -- L'allowlist de membership du runtime est vide. Même un rôle intermédiaire non-owner peut
  -- porter BYPASSRLS ou des ACL protégées, puis devenir effectif après SET ROLE. pg_has_role
  -- évalue toute la chaîne, pas seulement pg_auth_members au premier niveau.
  FOR reachable_role_oid IN
    SELECT role.oid
      FROM pg_catalog.pg_roles AS role
     WHERE role.oid <> runtime_role.oid
       AND (
         pg_catalog.pg_has_role(runtime_role.oid, role.oid, 'MEMBER')
         OR pg_catalog.pg_has_role(runtime_role.oid, role.oid, 'SET')
       )
  LOOP
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_ROLE_MEMBERSHIP_FORBIDDEN:%',
      pg_catalog.pg_get_userbyid(reachable_role_oid);
  END LOOP;

  quote_line_work_table_oid :=
    pg_catalog.to_regclass('public.agent_mission_quote_line_work');
  quote_line_work_guard_oid :=
    pg_catalog.to_regprocedure('public.guard_agent_mission_quote_line_work_v1()');
  SELECT pg_catalog.count(*)::INTEGER
    INTO quote_line_work_trigger_count
    FROM pg_catalog.pg_trigger AS trigger
   WHERE trigger.tgrelid = quote_line_work_table_oid
     AND NOT trigger.tgisinternal;
  IF quote_line_work_guard_oid IS NULL
     OR quote_line_work_trigger_count <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger
        WHERE trigger.tgrelid = quote_line_work_table_oid
          AND trigger.tgname = 'agent_mission_quote_line_work_guard_v1'
          AND NOT trigger.tgisinternal
          AND trigger.tgenabled = 'O'
          AND trigger.tgtype = 31
          AND trigger.tgfoid = quote_line_work_guard_oid
          AND trigger.tgqual IS NULL
          AND trigger.tgnargs = 0
          AND trigger.tgattr = ''::pg_catalog.int2vector
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_WORK_GUARD_TRIGGER_DRIFT';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.oid = quote_line_work_guard_oid
       AND NOT procedure.prosecdef
       AND NOT procedure.proleakproof
       AND procedure.provolatile = 'v'
       AND procedure.proparallel = 'u'
       AND procedure.pronargs = 0
       AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       AND procedure.proconfig = ARRAY[
         'search_path=pg_catalog, public'
       ]::TEXT[]
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_WORK_GUARD_FUNCTION_DRIFT';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER
    INTO quote_line_work_policy_count
    FROM pg_catalog.pg_policy AS policy
   WHERE policy.polrelid = quote_line_work_table_oid;
  IF quote_line_work_policy_count <> 4 THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_WORK_POLICY_INVENTORY_DRIFT';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (
        VALUES
          (
            'agent_mission_quote_line_work_owner_select'::TEXT,
            'r'::"char",
            'companyId=current_setting''app.current_company_id'',trueANDownerUserId=NULLIFcurrent_setting''app.current_user_id'',true,'''''::TEXT,
            NULL::TEXT
          ),
          (
            'agent_mission_quote_line_work_owner_insert'::TEXT,
            'a'::"char",
            NULL::TEXT,
            'companyId=current_setting''app.current_company_id'',trueANDownerUserId=NULLIFcurrent_setting''app.current_user_id'',true,''''ANDmissionId=NULLIFcurrent_setting''app.current_agent_mission_id'',true,'''''::TEXT
          ),
          (
            'agent_mission_quote_line_work_owner_update'::TEXT,
            'w'::"char",
            'companyId=current_setting''app.current_company_id'',trueANDownerUserId=NULLIFcurrent_setting''app.current_user_id'',true,''''ANDmissionId=NULLIFcurrent_setting''app.current_agent_mission_id'',true,'''''::TEXT,
            'companyId=current_setting''app.current_company_id'',trueANDownerUserId=NULLIFcurrent_setting''app.current_user_id'',true,''''ANDmissionId=NULLIFcurrent_setting''app.current_agent_mission_id'',true,'''''::TEXT
          ),
          (
            'agent_mission_quote_line_work_owner_delete'::TEXT,
            'd'::"char",
            'companyId=current_setting''app.current_company_id'',trueANDownerUserId=NULLIFcurrent_setting''app.current_user_id'',true,''''ANDmissionId=NULLIFcurrent_setting''app.current_agent_mission_id'',true,'''''::TEXT,
            NULL::TEXT
          )
      ) AS expected(policy_name, policy_command, expected_using, expected_check)
      LEFT JOIN pg_catalog.pg_policy AS policy
        ON policy.polrelid = quote_line_work_table_oid
       AND policy.polname = expected.policy_name
       AND policy.polcmd = expected.policy_command
     WHERE policy.oid IS NULL
        OR NOT policy.polpermissive
        OR policy.polroles IS DISTINCT FROM ARRAY[0::OID]
        OR (
          CASE
            WHEN policy.polqual IS NULL THEN NULL
            ELSE pg_catalog.regexp_replace(
              pg_catalog.replace(
                pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
                '::text',
                ''
              ),
              '[[:space:]()"]',
              '',
              'g'
            )
          END
        ) IS DISTINCT FROM expected.expected_using
        OR (
          CASE
            WHEN policy.polwithcheck IS NULL THEN NULL
            ELSE pg_catalog.regexp_replace(
              pg_catalog.replace(
                pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
                '::text',
                ''
              ),
              '[[:space:]()"]',
              '',
              'g'
            )
          END
        ) IS DISTINCT FROM expected.expected_check
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_WORK_POLICY_DEFINITION_DRIFT';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'agent_missions',
    'agent_mission_events',
    'agent_mission_quote_line_work',
    'agent_mission_fingerprint_key_version_floors',
    'agent_mission_fingerprint_key_bindings'
  ]::TEXT[] LOOP
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

  FOREACH table_name IN ARRAY ARRAY[
    'agent_mission_fingerprint_key_version_floors',
    'agent_mission_fingerprint_key_bindings'
  ]::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(
         current_user,
         pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)),
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_any_column_privilege(
         current_user,
         pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)),
         'SELECT,INSERT,UPDATE,REFERENCES'
       ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_CRYPTO_TABLE_PRIVILEGE_FORBIDDEN:%',
        table_name;
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

  FOREACH privilege_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE'
  ]::TEXT[] LOOP
    IF NOT pg_catalog.has_table_privilege(
      current_user,
      'public.agent_mission_quote_line_work',
      privilege_name
    ) THEN
      RAISE EXCEPTION
        'AGENT_MISSION_RUNTIME_REQUIRED_PRIVILEGE_MISSING:agent_mission_quote_line_work:%',
        privilege_name;
    END IF;
  END LOOP;
  FOREACH privilege_name IN ARRAY ARRAY[
    'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(
      current_user,
      'public.agent_mission_quote_line_work',
      privilege_name
    ) THEN
      RAISE EXCEPTION
        'AGENT_MISSION_RUNTIME_FORBIDDEN_PRIVILEGE:agent_mission_quote_line_work:%',
        privilege_name;
    END IF;
  END LOOP;
  IF pg_catalog.has_any_column_privilege(
    current_user,
    'public.agent_mission_quote_line_work',
    'REFERENCES'
  ) THEN
    RAISE EXCEPTION
      'AGENT_MISSION_RUNTIME_COLUMN_PRIVILEGE_FORBIDDEN:agent_mission_quote_line_work:REFERENCES';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS privilege
     WHERE namespace.nspname = 'public'
       AND relation.relname IN (
         'agent_missions',
         'agent_mission_events',
         'agent_mission_quote_line_work',
         'agent_mission_fingerprint_key_version_floors',
         'agent_mission_fingerprint_key_bindings'
       )
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
       AND relation.relname IN (
         'agent_missions',
         'agent_mission_events',
         'agent_mission_quote_line_work',
         'agent_mission_fingerprint_key_version_floors',
         'agent_mission_fingerprint_key_bindings'
       )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_PUBLIC_COLUMN_PRIVILEGE_FORBIDDEN';
  END IF;

  FOREACH function_name IN ARRAY ARRAY[
    'guard_agent_mission_mutation_v1()',
    'guard_quote_draft_agent_mission_v1()',
    'guard_agent_mission_quote_line_work_v1()',
    'reject_agent_mission_event_mutation_v1()',
    'guard_agent_mission_event_append_v1()',
    'require_agent_mission_event_v1()',
    'guard_agent_mission_fingerprint_key_floor_v1()',
    'guard_agent_mission_fingerprint_key_binding_immutable_v1()',
    'guard_agent_mission_fingerprint_key_binding_present_v1()'
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

  function_name := 'guard_agent_mission_fingerprint_key_binding_present_v1()';
  function_oid := pg_catalog.to_regprocedure('public.' || function_name);
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid = function_oid
       AND function.prosecdef
       AND function.provolatile = 'v'
       AND function.proconfig @> ARRAY[
         'search_path=pg_catalog',
         'row_security=on',
         'lock_timeout=1s',
         'statement_timeout=3s'
       ]::TEXT[]
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_WRITER_GUARD_HARDENING_DRIFT';
  END IF;

  function_name := 'agent_mission_fingerprint_key_readiness(integer[])';
  function_oid := pg_catalog.to_regprocedure('public.' || function_name);
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'AGENT_MISSION_FUNCTION_MISSING:%', function_name;
  END IF;
  IF NOT pg_catalog.has_function_privilege(current_user, function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_FUNCTION_EXECUTE_MISSING:%', function_name;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid = function_oid
       AND function.prosecdef
       AND function.provolatile = 'v'
       AND function.proconfig @> ARRAY[
         'search_path=pg_catalog',
         'row_security=on',
         'lock_timeout=1s',
         'statement_timeout=3s'
       ]::TEXT[]
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_READINESS_FUNCTION_HARDENING_DRIFT';
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
       AND privilege.privilege_type = 'EXECUTE'
       AND privilege.grantee NOT IN (
         function.proowner,
         (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user)
       )
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(
         function.proacl,
         pg_catalog.acldefault('f', function.proowner)
       )
     ) AS privilege
     WHERE function.oid = function_oid
       AND privilege.privilege_type = 'EXECUTE'
       AND privilege.grantee = (
         SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
       )
       AND privilege.is_grantable
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_READINESS_FUNCTION_ACL_DRIFT';
  END IF;

  -- Un rôle NOINHERIT peut ne présenter aucun privilège effectif avant SET ROLE, puis devenir
  -- owner et désactiver RLS/triggers. L'inventaire porte donc sur les owners eux-mêmes, pas
  -- seulement sur has_*_privilege dans l'identité courante.
  FOR owner_role_oid IN
    SELECT DISTINCT protected_owner.owner_oid
      FROM (
        SELECT relation.relowner AS owner_oid
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid IN (
           'public.agent_missions'::pg_catalog.regclass,
           'public.agent_mission_events'::pg_catalog.regclass,
           'public.agent_mission_quote_line_work'::pg_catalog.regclass,
           'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass,
           'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
         )
        UNION
        SELECT function.proowner AS owner_oid
          FROM pg_catalog.pg_proc AS function
         WHERE function.oid IN (
           'public.guard_agent_mission_mutation_v1()'::pg_catalog.regprocedure,
           'public.guard_quote_draft_agent_mission_v1()'::pg_catalog.regprocedure,
           'public.guard_agent_mission_quote_line_work_v1()'::pg_catalog.regprocedure,
           'public.reject_agent_mission_event_mutation_v1()'::pg_catalog.regprocedure,
           'public.guard_agent_mission_event_append_v1()'::pg_catalog.regprocedure,
           'public.require_agent_mission_event_v1()'::pg_catalog.regprocedure,
           'public.guard_agent_mission_fingerprint_key_floor_v1()'::pg_catalog.regprocedure,
           'public.guard_agent_mission_fingerprint_key_binding_immutable_v1()'::pg_catalog.regprocedure,
           'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure,
           'public.agent_mission_fingerprint_key_readiness(integer[])'::pg_catalog.regprocedure
         )
      ) AS protected_owner
  LOOP
    IF pg_catalog.pg_has_role(runtime_role.oid, owner_role_oid, 'MEMBER')
       OR pg_catalog.pg_has_role(runtime_role.oid, owner_role_oid, 'SET') THEN
      RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_OWNER_MEMBERSHIP_FORBIDDEN:%',
        pg_catalog.pg_get_userbyid(owner_role_oid);
    END IF;
  END LOOP;

  -- Exécution réelle via DATABASE_URL : les métadonnées seules ne prouvent pas FORCE RLS.
  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE readiness."keyVersion" < 1
              OR readiness."keyVersion" > 2147483647
              OR (
                readiness."keyFingerprint" IS NOT NULL
                AND readiness."keyFingerprint" !~ '^[a-f0-9]{64}$'
              )
              OR readiness.retained IS NULL
              OR (
                (readiness."minimumWriterVersion" IS NULL)
                <> (readiness."highestWriterVersion" IS NULL)
              )
              OR (
                (readiness."minimumWriterVersion" IS NULL)
                <> (readiness."writerEnabled" IS NULL)
              )
              OR (
                readiness."minimumWriterVersion" IS NOT NULL
                AND (
                  readiness."minimumWriterVersion" < 1
                  OR readiness."highestWriterVersion"
                    < readiness."minimumWriterVersion"
                  OR readiness."highestWriterVersion"::BIGINT
                    > readiness."minimumWriterVersion"::BIGINT + 1
                )
              )
         )::INTEGER
    INTO readiness_row_count, readiness_invalid_count
    FROM public.agent_mission_fingerprint_key_readiness(
      ARRAY[1]::INTEGER[]
    ) AS readiness;
  IF readiness_row_count < 1
     OR readiness_row_count > 34
     OR readiness_invalid_count <> 0 THEN
    RAISE EXCEPTION 'AGENT_MISSION_READINESS_RUNTIME_EXECUTION_INVALID';
  END IF;

  FOREACH exposed_role_name IN ARRAY ARRAY[
    'anon', 'authenticated', 'service_role'
  ]::TEXT[] LOOP
    exposed_role_oid := pg_catalog.to_regrole(exposed_role_name);
    IF exposed_role_oid IS NULL THEN
      RAISE EXCEPTION 'AGENT_MISSION_DATA_API_ROLE_MISSING:%', exposed_role_name;
    END IF;
    FOR reachable_role_oid IN
      SELECT role.oid
        FROM pg_catalog.pg_roles AS role
       WHERE role.oid <> exposed_role_oid
         AND (
           pg_catalog.pg_has_role(exposed_role_oid, role.oid, 'MEMBER')
           OR pg_catalog.pg_has_role(exposed_role_oid, role.oid, 'SET')
         )
    LOOP
      RAISE EXCEPTION 'AGENT_MISSION_DATA_API_ROLE_MEMBERSHIP_FORBIDDEN:%:%',
        exposed_role_name,
        pg_catalog.pg_get_userbyid(reachable_role_oid);
    END LOOP;
    FOR owner_role_oid IN
      SELECT DISTINCT protected_owner.owner_oid
        FROM (
          SELECT relation.relowner AS owner_oid
            FROM pg_catalog.pg_class AS relation
           WHERE relation.oid IN (
             'public.agent_missions'::pg_catalog.regclass,
             'public.agent_mission_events'::pg_catalog.regclass,
             'public.agent_mission_quote_line_work'::pg_catalog.regclass,
             'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass,
             'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
           )
          UNION
          SELECT function.proowner AS owner_oid
            FROM pg_catalog.pg_proc AS function
           WHERE function.oid IN (
             'public.guard_agent_mission_mutation_v1()'::pg_catalog.regprocedure,
             'public.guard_quote_draft_agent_mission_v1()'::pg_catalog.regprocedure,
             'public.guard_agent_mission_quote_line_work_v1()'::pg_catalog.regprocedure,
             'public.reject_agent_mission_event_mutation_v1()'::pg_catalog.regprocedure,
             'public.guard_agent_mission_event_append_v1()'::pg_catalog.regprocedure,
             'public.require_agent_mission_event_v1()'::pg_catalog.regprocedure,
             'public.guard_agent_mission_fingerprint_key_floor_v1()'::pg_catalog.regprocedure,
             'public.guard_agent_mission_fingerprint_key_binding_immutable_v1()'::pg_catalog.regprocedure,
             'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure,
             'public.agent_mission_fingerprint_key_readiness(integer[])'::pg_catalog.regprocedure
           )
        ) AS protected_owner
    LOOP
      IF pg_catalog.pg_has_role(exposed_role_oid, owner_role_oid, 'MEMBER')
         OR pg_catalog.pg_has_role(exposed_role_oid, owner_role_oid, 'SET') THEN
        RAISE EXCEPTION 'AGENT_MISSION_DATA_API_OWNER_MEMBERSHIP_FORBIDDEN:%:%',
          exposed_role_name,
          pg_catalog.pg_get_userbyid(owner_role_oid);
      END IF;
    END LOOP;
    FOREACH table_name IN ARRAY ARRAY[
      'agent_missions',
      'agent_mission_events',
      'agent_mission_quote_line_work',
      'agent_mission_fingerprint_key_version_floors',
      'agent_mission_fingerprint_key_bindings'
    ]::TEXT[] LOOP
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
      'guard_agent_mission_quote_line_work_v1()',
      'reject_agent_mission_event_mutation_v1()',
      'guard_agent_mission_event_append_v1()',
      'require_agent_mission_event_v1()',
      'guard_agent_mission_fingerprint_key_floor_v1()',
      'guard_agent_mission_fingerprint_key_binding_immutable_v1()',
      'guard_agent_mission_fingerprint_key_binding_present_v1()'
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
    function_name := 'agent_mission_fingerprint_key_readiness(integer[])';
    IF pg_catalog.has_function_privilege(
      exposed_role_oid,
      pg_catalog.to_regprocedure('public.' || function_name),
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_DATA_API_FUNCTION_EXECUTE_FORBIDDEN:%:%',
        exposed_role_name, function_name;
    END IF;
  END LOOP;
END;
$agent_mission_acl_certificate$;

ROLLBACK;
