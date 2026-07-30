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
  mission_table_oid OID;
  mission_guard_oid OID;
  mission_trigger_count INTEGER;
  event_table_oid OID;
  event_guard_oid OID;
  event_trigger_count INTEGER;
  quote_line_work_table_oid OID;
  quote_line_work_guard_oid OID;
  quote_line_work_trigger_count INTEGER;
  quote_line_work_policy_count INTEGER;
  catalogue_table_oid OID;
  catalogue_guard_oid OID;
  catalogue_search_token_table_oid OID;
  catalogue_search_token_sync_oid OID;
  catalogue_search_token_authority_oid OID;
  catalogue_trigger_count INTEGER;
  catalogue_search_token_policy_count INTEGER;
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
  catalogue_search_token_authority_oid :=
    pg_catalog.to_regrole('bob_catalogue_search_token_sync');
  IF catalogue_search_token_authority_oid IS NULL
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_roles AS authority
        WHERE authority.oid = catalogue_search_token_authority_oid
          AND (
            authority.rolcanlogin
            OR authority.rolsuper
            OR authority.rolcreatedb
            OR authority.rolcreaterole
            OR authority.rolinherit
            OR authority.rolreplication
            OR authority.rolbypassrls
          )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = catalogue_search_token_authority_oid
     )
     OR pg_catalog.pg_has_role(
       runtime_role.oid,
       catalogue_search_token_authority_oid,
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       runtime_role.oid,
       catalogue_search_token_authority_oid,
       'SET'
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CATALOGUE_SEARCH_TOKEN_AUTHORITY_DRIFT';
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

  mission_table_oid := pg_catalog.to_regclass('public.agent_missions');
  mission_guard_oid :=
    pg_catalog.to_regprocedure('public.guard_agent_mission_mutation_v2()');
  SELECT pg_catalog.count(*)::INTEGER
    INTO mission_trigger_count
    FROM pg_catalog.pg_trigger AS trigger
   WHERE trigger.tgrelid = mission_table_oid
     AND trigger.tgname IN (
       'agent_missions_mutation_guard_v1',
       'agent_missions_mutation_guard_v2'
     )
     AND NOT trigger.tgisinternal;
  IF mission_guard_oid IS NULL
     OR mission_trigger_count <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger
        WHERE trigger.tgrelid = mission_table_oid
          AND trigger.tgname = 'agent_missions_mutation_guard_v2'
          AND NOT trigger.tgisinternal
          AND trigger.tgenabled = 'O'
          AND trigger.tgtype = 23
          AND trigger.tgfoid = mission_guard_oid
          AND trigger.tgqual IS NULL
          AND trigger.tgnargs = 0
          AND trigger.tgattr = ''::pg_catalog.int2vector
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_MUTATION_GUARD_TRIGGER_DRIFT';
  END IF;

  event_table_oid := pg_catalog.to_regclass('public.agent_mission_events');
  event_guard_oid :=
    pg_catalog.to_regprocedure('public.guard_agent_mission_event_append_v3()');
  SELECT pg_catalog.count(*)::INTEGER
    INTO event_trigger_count
    FROM pg_catalog.pg_trigger AS trigger
   WHERE trigger.tgrelid = event_table_oid
     AND trigger.tgname IN (
       'agent_mission_events_append_guard_v1',
       'agent_mission_events_append_guard_v3'
     )
     AND NOT trigger.tgisinternal;
  IF event_guard_oid IS NULL
     OR event_trigger_count <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger
        WHERE trigger.tgrelid = event_table_oid
          AND trigger.tgname = 'agent_mission_events_append_guard_v3'
          AND NOT trigger.tgisinternal
          AND trigger.tgenabled = 'O'
          AND trigger.tgtype = 7
          AND trigger.tgfoid = event_guard_oid
          AND trigger.tgqual IS NULL
          AND trigger.tgnargs = 0
          AND trigger.tgattr = ''::pg_catalog.int2vector
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_APPEND_GUARD_TRIGGER_DRIFT';
  END IF;

  quote_line_work_table_oid :=
    pg_catalog.to_regclass('public.agent_mission_quote_line_work');
  quote_line_work_guard_oid :=
    pg_catalog.to_regprocedure('public.guard_agent_mission_quote_line_work_v3()');
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
          AND trigger.tgname = 'agent_mission_quote_line_work_guard_v3'
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

  catalogue_table_oid := pg_catalog.to_regclass('public.catalogue_prestations');
  catalogue_guard_oid :=
    pg_catalog.to_regprocedure('public.guard_catalogue_prestation_revision_v1()');
  SELECT pg_catalog.count(*)::INTEGER
    INTO catalogue_trigger_count
    FROM pg_catalog.pg_trigger AS trigger
   WHERE trigger.tgrelid = catalogue_table_oid
     AND NOT trigger.tgisinternal;
  IF catalogue_guard_oid IS NULL
     OR catalogue_trigger_count <> 2
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger
        WHERE trigger.tgrelid = catalogue_table_oid
          AND trigger.tgname = 'catalogue_prestations_revision_guard_v1'
          AND NOT trigger.tgisinternal
          AND trigger.tgenabled = 'O'
          AND trigger.tgtype = 19
          AND trigger.tgfoid = catalogue_guard_oid
          AND trigger.tgqual IS NULL
          AND trigger.tgnargs = 0
          AND trigger.tgattr = ''::pg_catalog.int2vector
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CATALOGUE_REVISION_GUARD_TRIGGER_DRIFT';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.oid = catalogue_guard_oid
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
    RAISE EXCEPTION 'AGENT_MISSION_CATALOGUE_REVISION_GUARD_FUNCTION_DRIFT';
  END IF;

  catalogue_search_token_table_oid :=
    pg_catalog.to_regclass('public.catalogue_prestation_search_tokens');
  catalogue_search_token_sync_oid :=
    pg_catalog.to_regprocedure(
      'public.sync_catalogue_prestation_search_tokens_v1()'
    );
  IF catalogue_search_token_table_oid IS NULL
     OR catalogue_search_token_sync_oid IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger
         JOIN pg_catalog.pg_attribute AS attribute
           ON attribute.attrelid = trigger.tgrelid
          AND attribute.attname = 'label'
          AND NOT attribute.attisdropped
        WHERE trigger.tgrelid = catalogue_table_oid
          AND trigger.tgname = 'catalogue_prestations_search_tokens_sync_v1'
          AND NOT trigger.tgisinternal
          AND trigger.tgenabled = 'O'
          AND trigger.tgtype = 21
          AND trigger.tgfoid = catalogue_search_token_sync_oid
          AND trigger.tgqual IS NULL
          AND trigger.tgnargs = 0
          AND trigger.tgattr::TEXT = attribute.attnum::TEXT
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CATALOGUE_SEARCH_TOKEN_TRIGGER_DRIFT';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.oid = catalogue_search_token_sync_oid
       AND procedure.proowner = catalogue_search_token_authority_oid
       AND procedure.prosecdef
       AND NOT procedure.proleakproof
       AND procedure.provolatile = 'v'
       AND procedure.proparallel = 'u'
       AND procedure.pronargs = 0
       AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       AND procedure.proconfig = ARRAY[
         'search_path=pg_catalog',
         'row_security=on'
       ]::TEXT[]
       AND pg_catalog.md5(procedure.prosrc) =
         '94327712057244bbe60cc428a22df471'
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CATALOGUE_SEARCH_TOKEN_FUNCTION_DRIFT';
  END IF;
  IF (
    SELECT relation.relowner = catalogue_search_token_authority_oid
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = catalogue_search_token_table_oid
  )
  OR NOT pg_catalog.has_schema_privilege(
    catalogue_search_token_authority_oid,
    'public',
    'USAGE'
  )
  OR pg_catalog.has_schema_privilege(
    catalogue_search_token_authority_oid,
    'public',
    'CREATE'
  )
  OR NOT pg_catalog.has_table_privilege(
    catalogue_search_token_authority_oid,
    catalogue_search_token_table_oid,
    'DELETE'
  )
  OR pg_catalog.has_table_privilege(
    catalogue_search_token_authority_oid,
    catalogue_search_token_table_oid,
    'SELECT,INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER'
  )
  OR NOT pg_catalog.has_column_privilege(
    catalogue_search_token_authority_oid,
    catalogue_search_token_table_oid,
    'companyId',
    'SELECT,INSERT'
  )
  OR NOT pg_catalog.has_column_privilege(
    catalogue_search_token_authority_oid,
    catalogue_search_token_table_oid,
    'catalogueItemId',
    'SELECT,INSERT'
  )
  OR NOT pg_catalog.has_column_privilege(
    catalogue_search_token_authority_oid,
    catalogue_search_token_table_oid,
    'token',
    'INSERT'
  )
  OR pg_catalog.has_column_privilege(
    catalogue_search_token_authority_oid,
    catalogue_search_token_table_oid,
    'token',
    'SELECT,UPDATE,REFERENCES'
  )
  OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(
         function.proacl,
         pg_catalog.acldefault('f', function.proowner)
       )
     ) AS privilege
     WHERE function.oid = catalogue_search_token_sync_oid
       AND privilege.privilege_type = 'EXECUTE'
       AND privilege.grantee <> catalogue_search_token_authority_oid
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CATALOGUE_SEARCH_TOKEN_AUTHORITY_ACL_DRIFT';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS database_constraint
     WHERE database_constraint.conrelid = catalogue_search_token_table_oid
       AND database_constraint.conname = 'catalogue_search_tokens_item_company_fkey'
       AND database_constraint.contype = 'f'
       AND database_constraint.confrelid = catalogue_table_oid
       AND database_constraint.confdeltype = 'c'
       AND database_constraint.confupdtype = 'c'
       AND database_constraint.convalidated
       AND NOT database_constraint.condeferrable
       AND NOT database_constraint.condeferred
       AND database_constraint.conkey = ARRAY[
         (
           SELECT attribute.attnum
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = catalogue_search_token_table_oid
              AND attribute.attname = 'catalogueItemId'
              AND NOT attribute.attisdropped
         ),
         (
           SELECT attribute.attnum
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = catalogue_search_token_table_oid
              AND attribute.attname = 'companyId'
              AND NOT attribute.attisdropped
         )
       ]::SMALLINT[]
       AND database_constraint.confkey = ARRAY[
         (
           SELECT attribute.attnum
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = catalogue_table_oid
              AND attribute.attname = 'id'
              AND NOT attribute.attisdropped
         ),
         (
           SELECT attribute.attnum
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = catalogue_table_oid
              AND attribute.attname = 'companyId'
              AND NOT attribute.attisdropped
         )
       ]::SMALLINT[]
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS database_constraint
     WHERE database_constraint.conrelid = catalogue_search_token_table_oid
       AND database_constraint.conname = 'catalogue_search_tokens_pkey'
       AND database_constraint.contype = 'p'
       AND database_constraint.convalidated
       AND NOT database_constraint.condeferrable
       AND NOT database_constraint.condeferred
       AND database_constraint.conkey = ARRAY[
         (
           SELECT attribute.attnum
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = catalogue_search_token_table_oid
              AND attribute.attname = 'companyId'
              AND NOT attribute.attisdropped
         ),
         (
           SELECT attribute.attnum
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = catalogue_search_token_table_oid
              AND attribute.attname = 'token'
              AND NOT attribute.attisdropped
         ),
         (
           SELECT attribute.attnum
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = catalogue_search_token_table_oid
              AND attribute.attname = 'catalogueItemId'
              AND NOT attribute.attisdropped
         )
       ]::SMALLINT[]
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS database_constraint
     WHERE database_constraint.conrelid = catalogue_search_token_table_oid
       AND database_constraint.conname = 'catalogue_search_tokens_token_check'
       AND database_constraint.contype = 'c'
       AND database_constraint.convalidated
       AND NOT database_constraint.condeferrable
       AND NOT database_constraint.condeferred
       AND pg_catalog.pg_get_constraintdef(database_constraint.oid) LIKE
         '%char_length(token)%1000%token ~ ''^[a-z0-9]+$''%'
  ) OR (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = catalogue_search_token_table_oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  ) <> 3
  OR (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = catalogue_search_token_table_oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attnotnull
       AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
       AND attribute.attname IN ('companyId', 'catalogueItemId', 'token')
  ) <> 3
  OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_indexes AS index
     WHERE index.schemaname = 'public'
       AND index.tablename = 'catalogue_prestation_search_tokens'
       AND index.indexname = 'catalogue_search_tokens_pkey'
       AND index.indexdef LIKE
         '%("companyId", token, "catalogueItemId")%'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_indexes AS index
     WHERE index.schemaname = 'public'
       AND index.tablename = 'catalogue_prestation_search_tokens'
       AND index.indexname = 'catalogue_search_tokens_company_item_idx'
       AND index.indexdef LIKE '%("companyId", "catalogueItemId")%'
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CATALOGUE_SEARCH_TOKEN_STORAGE_DRIFT';
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

  SELECT pg_catalog.count(*)::INTEGER
    INTO catalogue_search_token_policy_count
    FROM pg_catalog.pg_policy AS policy
   WHERE policy.polrelid = catalogue_search_token_table_oid;
  IF catalogue_search_token_policy_count <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = catalogue_search_token_table_oid
          AND policy.polname = 'tenant_isolation'
          AND policy.polcmd = '*'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[0::OID]
          AND pg_catalog.regexp_replace(
            pg_catalog.replace(
              pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
              '::text',
              ''
            ),
            '[[:space:]()"]',
            '',
            'g'
          ) = 'companyId=current_setting''app.current_company_id'',true'
          AND pg_catalog.regexp_replace(
            pg_catalog.replace(
              pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
              '::text',
              ''
            ),
            '[[:space:]()"]',
            '',
            'g'
          ) = 'companyId=current_setting''app.current_company_id'',true'
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CATALOGUE_SEARCH_TOKEN_POLICY_DRIFT';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'agent_missions',
    'agent_mission_events',
    'agent_mission_quote_line_work',
    'catalogue_prestations',
    'catalogue_prestation_search_tokens',
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

  FOREACH privilege_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE'
  ]::TEXT[] LOOP
    IF NOT pg_catalog.has_table_privilege(
      current_user,
      'public.catalogue_prestations',
      privilege_name
    ) THEN
      RAISE EXCEPTION
        'AGENT_MISSION_RUNTIME_REQUIRED_PRIVILEGE_MISSING:catalogue_prestations:%',
        privilege_name;
    END IF;
  END LOOP;
  FOREACH privilege_name IN ARRAY ARRAY[
    'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(
      current_user,
      'public.catalogue_prestations',
      privilege_name
    ) THEN
      RAISE EXCEPTION
        'AGENT_MISSION_RUNTIME_FORBIDDEN_PRIVILEGE:catalogue_prestations:%',
        privilege_name;
    END IF;
  END LOOP;
  IF pg_catalog.has_any_column_privilege(
    current_user,
    'public.catalogue_prestations',
    'REFERENCES'
  ) THEN
    RAISE EXCEPTION
      'AGENT_MISSION_RUNTIME_COLUMN_PRIVILEGE_FORBIDDEN:catalogue_prestations:REFERENCES';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    current_user,
    'public.catalogue_prestation_search_tokens',
    'SELECT'
  ) THEN
    RAISE EXCEPTION
      'AGENT_MISSION_RUNTIME_REQUIRED_PRIVILEGE_MISSING:catalogue_prestation_search_tokens:SELECT';
  END IF;
  FOREACH privilege_name IN ARRAY ARRAY[
    'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(
      current_user,
      'public.catalogue_prestation_search_tokens',
      privilege_name
    ) THEN
      RAISE EXCEPTION
        'AGENT_MISSION_RUNTIME_FORBIDDEN_PRIVILEGE:catalogue_prestation_search_tokens:%',
        privilege_name;
    END IF;
  END LOOP;
  IF pg_catalog.has_any_column_privilege(
    current_user,
    'public.catalogue_prestation_search_tokens',
    'INSERT,UPDATE,REFERENCES'
  ) THEN
    RAISE EXCEPTION
      'AGENT_MISSION_RUNTIME_COLUMN_PRIVILEGE_FORBIDDEN:catalogue_prestation_search_tokens';
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
         'catalogue_prestations',
         'catalogue_prestation_search_tokens',
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
         'catalogue_prestations',
         'catalogue_prestation_search_tokens',
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
    'guard_agent_mission_mutation_v2()',
    'guard_quote_draft_agent_mission_v1()',
    'guard_agent_mission_quote_line_work_v3()',
    'reject_agent_mission_event_mutation_v1()',
    'guard_agent_mission_event_append_v3()',
    'require_agent_mission_event_v1()',
    'guard_catalogue_prestation_revision_v1()',
    'sync_catalogue_prestation_search_tokens_v1()',
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
           'public.catalogue_prestations'::pg_catalog.regclass,
           'public.catalogue_prestation_search_tokens'::pg_catalog.regclass,
           'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass,
           'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
         )
        UNION
        SELECT function.proowner AS owner_oid
          FROM pg_catalog.pg_proc AS function
         WHERE function.oid IN (
           'public.guard_agent_mission_mutation_v2()'::pg_catalog.regprocedure,
           'public.guard_quote_draft_agent_mission_v1()'::pg_catalog.regprocedure,
           'public.guard_agent_mission_quote_line_work_v3()'::pg_catalog.regprocedure,
           'public.reject_agent_mission_event_mutation_v1()'::pg_catalog.regprocedure,
           'public.guard_agent_mission_event_append_v3()'::pg_catalog.regprocedure,
           'public.require_agent_mission_event_v1()'::pg_catalog.regprocedure,
           'public.guard_catalogue_prestation_revision_v1()'::pg_catalog.regprocedure,
           'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure,
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
             'public.catalogue_prestations'::pg_catalog.regclass,
             'public.catalogue_prestation_search_tokens'::pg_catalog.regclass,
             'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass,
             'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
           )
          UNION
          SELECT function.proowner AS owner_oid
            FROM pg_catalog.pg_proc AS function
           WHERE function.oid IN (
             'public.guard_agent_mission_mutation_v2()'::pg_catalog.regprocedure,
             'public.guard_quote_draft_agent_mission_v1()'::pg_catalog.regprocedure,
             'public.guard_agent_mission_quote_line_work_v3()'::pg_catalog.regprocedure,
             'public.reject_agent_mission_event_mutation_v1()'::pg_catalog.regprocedure,
             'public.guard_agent_mission_event_append_v3()'::pg_catalog.regprocedure,
             'public.require_agent_mission_event_v1()'::pg_catalog.regprocedure,
             'public.guard_catalogue_prestation_revision_v1()'::pg_catalog.regprocedure,
             'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure,
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
      'catalogue_prestations',
      'catalogue_prestation_search_tokens',
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
      'guard_agent_mission_mutation_v2()',
      'guard_quote_draft_agent_mission_v1()',
      'guard_agent_mission_quote_line_work_v3()',
      'reject_agent_mission_event_mutation_v1()',
      'guard_agent_mission_event_append_v3()',
      'require_agent_mission_event_v1()',
      'guard_catalogue_prestation_revision_v1()',
      'sync_catalogue_prestation_search_tokens_v1()',
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
