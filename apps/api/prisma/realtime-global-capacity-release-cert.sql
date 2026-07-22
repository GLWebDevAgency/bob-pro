\set ON_ERROR_STOP on

-- Certificat live en lecture seule. Il prouve l'autorité, sa projection exacte et sa surface ACL
-- sans créer de lease ni modifier le singleton de production.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_catalog.set_config('bob.realtime.capacity_release_app_role', :'app_role', true);
SELECT pg_catalog.set_config(
  'bob.realtime.capacity_release_lease_count',
  (SELECT count(*)::TEXT FROM public.realtime_session_leases),
  true
);
SET LOCAL ROLE bob_realtime_capacity;

DO $$
DECLARE
  app_role_name TEXT := NULLIF(
    pg_catalog.current_setting('bob.realtime.capacity_release_app_role', true),
    ''
  );
  capacity_role pg_catalog.pg_roles%ROWTYPE;
  capacity_relation pg_catalog.pg_class%ROWTYPE;
  lease_count INTEGER := pg_catalog.current_setting(
    'bob.realtime.capacity_release_lease_count'
  )::INTEGER;
  capacity_row public.realtime_global_capacity%ROWTYPE;
  function_oids OID[] := ARRAY[
    'public.sync_realtime_global_capacity_v1()'::regprocedure,
    'public.deny_realtime_session_lease_truncate_v1()'::regprocedure,
    'public.preflight_realtime_global_capacity_v1(text,text,integer,integer,integer)'::regprocedure,
    'public.inspect_realtime_global_capacity_v1()'::regprocedure
  ];
BEGIN
  IF app_role_name IS NULL OR pg_catalog.to_regrole(app_role_name) IS NULL THEN
    RAISE EXCEPTION 'Realtime capacity release requires an existing runtime app role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = app_role_name
       AND (role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
            OR role.rolreplication OR role.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Realtime capacity runtime role privilege drift';
  END IF;
  IF pg_catalog.pg_has_role(app_role_name, 'bob_realtime_capacity', 'MEMBER')
     OR pg_catalog.pg_has_role(app_role_name, 'bob_realtime_capacity', 'SET') THEN
    RAISE EXCEPTION 'Realtime capacity authority is assumable by runtime';
  END IF;

  SELECT * INTO STRICT capacity_role
    FROM pg_catalog.pg_roles WHERE rolname = 'bob_realtime_capacity';
  IF capacity_role.rolcanlogin OR capacity_role.rolsuper OR capacity_role.rolcreatedb
     OR capacity_role.rolcreaterole OR capacity_role.rolinherit
     OR capacity_role.rolreplication OR capacity_role.rolbypassrls THEN
    RAISE EXCEPTION 'Realtime capacity role privilege drift';
  END IF;
  IF (
    SELECT count(*) FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = 'bob_realtime_capacity'::regrole
       AND membership.member = pg_catalog.to_regrole(session_user)
       AND NOT membership.admin_option
       AND NOT membership.inherit_option
       AND membership.set_option
  ) <> 1 OR (
    SELECT count(*) FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = 'bob_realtime_capacity'::regrole
  ) <> 1 OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = 'bob_realtime_capacity'::regrole
  ) THEN
    RAISE EXCEPTION 'Realtime capacity role membership drift';
  END IF;
  IF NOT pg_catalog.has_schema_privilege('bob_realtime_capacity', 'public', 'USAGE')
     OR pg_catalog.has_schema_privilege('bob_realtime_capacity', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Realtime capacity schema ACL drift';
  END IF;

  SELECT * INTO STRICT capacity_relation
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.realtime_global_capacity'::regclass;
  IF capacity_relation.relkind <> 'r'
     OR capacity_relation.relpersistence <> 'p'
     OR capacity_relation.relowner <> 'bob_realtime_capacity'::regrole
     OR capacity_relation.relnatts <> 12
     OR capacity_relation.relchecks <> 5
     OR NOT capacity_relation.relrowsecurity
     OR NOT capacity_relation.relforcerowsecurity
     OR capacity_relation.relispartition
     OR capacity_relation.relhasrules
     OR capacity_relation.relhassubclass THEN
    RAISE EXCEPTION 'Realtime capacity singleton relation drift';
  END IF;
  IF (
    SELECT count(*) FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = capacity_relation.oid
       AND policy.polname = 'realtime_global_capacity_owner'
       AND policy.polcmd = '*'
       AND policy.polpermissive
       AND policy.polroles = ARRAY[0::OID]
       AND policy.polqual IS NOT NULL
       AND policy.polwithcheck IS NOT NULL
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
           LIKE '%bob_realtime_capacity%'
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
           LIKE '%pg_get_userbyid%'
       AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
           LIKE '%bob_realtime_capacity%'
  ) <> 1 OR (
    SELECT count(*) FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = capacity_relation.oid
  ) <> 1 THEN
    RAISE EXCEPTION 'Realtime capacity owner policy drift';
  END IF;
  IF pg_catalog.has_table_privilege(
       app_role_name,
       'public.realtime_global_capacity',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
     ) OR EXISTS (
       SELECT 1
         FROM pg_catalog.aclexplode(COALESCE(
           capacity_relation.relacl,
           pg_catalog.acldefault('r', capacity_relation.relowner)
         )) AS privilege
        WHERE privilege.grantee <> capacity_relation.relowner
     ) THEN
    RAISE EXCEPTION 'Realtime capacity singleton ACL drift';
  END IF;

  SELECT * INTO STRICT capacity_row
    FROM public.realtime_global_capacity WHERE id = 1;
  IF capacity_row.mode <> 'closed'
     OR capacity_row."usedSessions" <> lease_count
     OR capacity_row."usedSessions" < 0
     OR capacity_row.revision < 0 THEN
    RAISE EXCEPTION 'Realtime capacity release projection must be exact and closed';
  END IF;
  IF NOT (
    (
      capacity_row."providerId" IS NULL
      AND capacity_row."providerModel" IS NULL
      AND capacity_row."globalMaxSessions" IS NULL
      AND capacity_row."providerMaxSessions" IS NULL
      AND capacity_row."configVersion" IS NULL
      AND capacity_row."retryAfterSeconds" IS NULL
      AND capacity_row."activatedAt" IS NULL
    ) OR (
      capacity_row."providerId" IN ('openai', 'mistral')
      AND length(capacity_row."providerModel") BETWEEN 1 AND 100
      AND capacity_row."globalMaxSessions" BETWEEN 1 AND 1000
      AND capacity_row."providerMaxSessions" BETWEEN capacity_row."globalMaxSessions" AND 10000
      AND capacity_row."configVersion" BETWEEN 1 AND 2147483647
      AND capacity_row."retryAfterSeconds" BETWEEN 1 AND 60
      AND capacity_row."activatedAt" IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Realtime capacity closed configuration shape drift';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_trigger AS trigger
     WHERE trigger.tgrelid = 'public.realtime_session_leases'::regclass
       AND trigger.tgname IN (
         '00_realtime_global_capacity_insert',
         '00_realtime_global_capacity_delete',
         '00_realtime_global_capacity_truncate'
       )
       AND NOT trigger.tgisinternal
  ) <> 3 OR EXISTS (
    SELECT 1
      FROM (VALUES
        ('00_realtime_global_capacity_insert', 4::SMALLINT, NULL::NAME, 'new_rows'::NAME,
         'sync_realtime_global_capacity_v1', 'bf3b206d8989cd6b9ec9aa56fba7607f'),
        ('00_realtime_global_capacity_delete', 8::SMALLINT, 'old_rows'::NAME, NULL::NAME,
         'sync_realtime_global_capacity_v1', 'bf3b206d8989cd6b9ec9aa56fba7607f'),
        ('00_realtime_global_capacity_truncate', 34::SMALLINT, NULL::NAME, NULL::NAME,
         'deny_realtime_session_lease_truncate_v1', '8d8c7e08c0b8e0e0ec42f0ecca2c102b')
      ) AS expected(trigger_name, trigger_type, old_table, new_table, function_name, body_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger
         JOIN pg_catalog.pg_proc AS function ON function.oid = trigger.tgfoid
        WHERE trigger.tgrelid = 'public.realtime_session_leases'::regclass
          AND trigger.tgname = expected.trigger_name
          AND trigger.tgtype = expected.trigger_type
          AND trigger.tgenabled = 'A'
          AND trigger.tgoldtable IS NOT DISTINCT FROM expected.old_table
          AND trigger.tgnewtable IS NOT DISTINCT FROM expected.new_table
          AND trigger.tgqual IS NULL
          AND trigger.tgnargs = 0
          AND NOT trigger.tgdeferrable
          AND NOT trigger.tginitdeferred
          AND function.proname = expected.function_name
          AND pg_catalog.md5(function.prosrc) = expected.body_md5
     )
  ) THEN
    RAISE EXCEPTION 'Realtime capacity trigger binding drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.sync_realtime_global_capacity_v1()'::regprocedure,
         ARRAY['search_path=pg_catalog', 'row_security=on',
               'statement_timeout=4s', 'lock_timeout=1s']::TEXT[],
         'plpgsql', 'trigger', 'bf3b206d8989cd6b9ec9aa56fba7607f'),
        ('public.deny_realtime_session_lease_truncate_v1()'::regprocedure,
         ARRAY['search_path=pg_catalog', 'row_security=on']::TEXT[],
         'plpgsql', 'trigger', '8d8c7e08c0b8e0e0ec42f0ecca2c102b'),
        ('public.preflight_realtime_global_capacity_v1(text,text,integer,integer,integer)'::regprocedure,
         ARRAY['search_path=pg_catalog', 'row_security=on',
               'statement_timeout=2s', 'lock_timeout=750ms']::TEXT[],
         'plpgsql', 'TABLE(status text, "retryAt" timestamp with time zone)',
         'abbb1df919a5581868569d09f02d416c'),
        ('public.inspect_realtime_global_capacity_v1()'::regprocedure,
         ARRAY['search_path=pg_catalog', 'row_security=on',
               'statement_timeout=2s', 'lock_timeout=750ms']::TEXT[],
         'sql',
         'TABLE(mode text, "providerId" text, "providerModel" text, "globalMaxSessions" integer, "providerMaxSessions" integer, "configVersion" integer, "retryAfterSeconds" integer, "usedSessions" integer, revision bigint, "updatedAt" timestamp with time zone)',
         '0dc9ff0f0c48cf32377c8ce3c741af32')
      ) AS expected(function_oid, function_config, language_name, result_type, body_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function
         JOIN pg_catalog.pg_language AS language ON language.oid = function.prolang
        WHERE function.oid = expected.function_oid
          AND function.proowner = 'bob_realtime_capacity'::regrole
          AND function.prosecdef
          AND function.proconfig IS NOT DISTINCT FROM expected.function_config
          AND function.provolatile = 'v'
          AND function.proparallel = 'u'
          AND language.lanname = expected.language_name
          AND pg_catalog.pg_get_function_result(function.oid) = expected.result_type
          AND pg_catalog.md5(function.prosrc) = expected.body_md5
     )
  ) THEN
    RAISE EXCEPTION 'Realtime capacity function authority drift';
  END IF;
  IF (
    SELECT count(*)
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
       function.proacl,
       pg_catalog.acldefault('f', function.proowner)
     )) AS privilege
     WHERE function.oid = ANY(function_oids)
       AND privilege.privilege_type = 'EXECUTE'
       AND NOT privilege.is_grantable
       AND (
         privilege.grantee = function.proowner
         OR (
           privilege.grantee = pg_catalog.to_regrole(app_role_name)
           AND function.oid IN (
             'public.preflight_realtime_global_capacity_v1(text,text,integer,integer,integer)'::regprocedure,
             'public.inspect_realtime_global_capacity_v1()'::regprocedure
           )
         )
       )
  ) <> 6 OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
       function.proacl,
       pg_catalog.acldefault('f', function.proowner)
     )) AS privilege
     WHERE function.oid = ANY(function_oids)
       AND (
         privilege.privilege_type <> 'EXECUTE'
         OR privilege.is_grantable
         OR NOT (
           privilege.grantee = function.proowner
           OR (
             privilege.grantee = pg_catalog.to_regrole(app_role_name)
             AND function.oid IN (
               'public.preflight_realtime_global_capacity_v1(text,text,integer,integer,integer)'::regprocedure,
               'public.inspect_realtime_global_capacity_v1()'::regprocedure
             )
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'Realtime capacity function ACL drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.realtime_session_leases'::regclass
       AND constraint_row.confrelid = 'public.companies'::regclass
       AND constraint_row.conname = 'realtime_session_leases_companyId_fkey'
       AND constraint_row.contype = 'f'
       AND constraint_row.confdeltype = 'r'
       AND constraint_row.confupdtype = 'c'
       AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'Realtime capacity lease company fence drift';
  END IF;
END;
$$;

ROLLBACK;
