\set ON_ERROR_STOP on

-- Certification de production strictement metadata-only : aucune fixture, aucun DDL et aucun
-- verrou de table ne sont autorisés dans le rituel de release live.
BEGIN TRANSACTION READ ONLY;
SELECT pg_catalog.set_config('bob.openai_native_release_app_role', :'app_role', true);
SET LOCAL ROLE bob_openai_native_maintenance_directory;

DO $$
DECLARE
  app_role_name TEXT := NULLIF(
    pg_catalog.current_setting('bob.openai_native_release_app_role', true),
    ''
  );
  exposed_role TEXT;
  database_oid OID;
  directory_function_oids OID[] := ARRAY[
    'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
    'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
    'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
  ];
  trigger_helper_function_oids OID[] := ARRAY[
    'public.assert_realtime_native_delivery_fence_v1(text,character,uuid,text,integer,character,character,integer)'::regprocedure,
    'public.guard_realtime_native_delivery_v1()'::regprocedure,
    'public.guard_realtime_native_speech_slo_v1()'::regprocedure,
    'public.guard_realtime_native_delivery_delete_v1()'::regprocedure,
    'public.deny_realtime_native_delivery_truncate_v1()'::regprocedure
  ];
BEGIN
  IF app_role_name IS NULL OR pg_catalog.to_regrole(app_role_name) IS NULL THEN
    RAISE EXCEPTION 'OpenAI native release requires an existing runtime app role';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = app_role_name
       AND (
         role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
         OR role.rolreplication OR role.rolbypassrls
       )
  ) THEN
    RAISE EXCEPTION 'OpenAI native runtime role authority drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS privileged_role
     WHERE (
       privileged_role.rolsuper OR privileged_role.rolcreatedb
       OR privileged_role.rolcreaterole OR privileged_role.rolreplication
       OR privileged_role.rolbypassrls
     )
       AND pg_catalog.pg_has_role(app_role_name, privileged_role.oid, 'SET')
  ) THEN
    RAISE EXCEPTION 'OpenAI native runtime role can assume a privileged role';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = 'bob_openai_native_maintenance_directory'
       AND (
         role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
         OR role.rolinherit OR role.rolreplication OR role.rolbypassrls
       )
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory role attribute drift';
  END IF;
  IF (SELECT count(*)
        FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid =
         'bob_openai_native_maintenance_directory'::regrole
         AND membership.member = pg_catalog.to_regrole(session_user)
         AND NOT membership.admin_option
         AND NOT membership.inherit_option
         AND membership.set_option) <> 1
     OR (SELECT count(*)
           FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid =
            'bob_openai_native_maintenance_directory'::regrole) <> 1
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member =
          'bob_openai_native_maintenance_directory'::regrole
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory membership drift';
  END IF;
  SELECT oid INTO STRICT database_oid
    FROM pg_catalog.pg_database
   WHERE datname = current_database();
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_shdepend AS ownership
     WHERE ownership.refclassid = 'pg_authid'::regclass
       AND ownership.refobjid = 'bob_openai_native_maintenance_directory'::regrole
       AND ownership.deptype = 'o'
       AND (ownership.dbid = 0 OR ownership.dbid = database_oid)
       AND NOT (
         ownership.dbid = database_oid
         AND ownership.classid = 'pg_proc'::regclass
         AND ownership.objid = ANY(directory_function_oids)
         AND ownership.objsubid = 0
       )
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory owns an unexpected object';
  END IF;

  IF (SELECT count(*)
        FROM pg_catalog.pg_trigger AS trigger
        JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
       WHERE relation.oid = 'public.realtime_native_speech_deliveries'::regclass
         AND NOT trigger.tgisinternal) <> 4 THEN
    RAISE EXCEPTION 'OpenAI native delivery trigger set drift';
  END IF;
  IF (SELECT relation.relrowsecurity AND relation.relforcerowsecurity
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_native_speech_deliveries'::regclass)
     IS DISTINCT FROM TRUE
     OR (SELECT count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid =
            'public.realtime_native_speech_deliveries'::regclass) <> 6
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('realtime_native_speech_delivery_select', 'r', TRUE,
            'd552ce3359dc662963f0146f9fc7615f', '3a7ac8a2092fc743e423336f473c7dac'),
           ('realtime_native_speech_delivery_insert', 'a', TRUE,
            '3a7ac8a2092fc743e423336f473c7dac', 'd552ce3359dc662963f0146f9fc7615f'),
           ('realtime_native_speech_delivery_update', 'w', TRUE,
            'd552ce3359dc662963f0146f9fc7615f', 'd552ce3359dc662963f0146f9fc7615f'),
           ('realtime_native_speech_delivery_due_directory_select', 'r', TRUE,
            '8b27d4b5f6f67958d41ebb1de1f52340', '3a7ac8a2092fc743e423336f473c7dac'),
           ('realtime_native_speech_delivery_delete_tenant', 'd', TRUE,
            'd552ce3359dc662963f0146f9fc7615f', '3a7ac8a2092fc743e423336f473c7dac'),
           ('realtime_native_speech_delivery_delete_retention_fence', 'd', FALSE,
            'c9ffc42220ebe224b25d2a5393e8d505', '3a7ac8a2092fc743e423336f473c7dac')
         ) AS expected(
           policy_name, policy_command, permissive, using_md5, check_md5
         )
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid =
             'public.realtime_native_speech_deliveries'::regclass
             AND policy.polname = expected.policy_name
             AND policy.polcmd = expected.policy_command
             AND policy.polpermissive = expected.permissive
             AND policy.polroles = ARRAY[0::OID]
             AND pg_catalog.md5(COALESCE(
               pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '<NULL>'
             )) = expected.using_md5
             AND pg_catalog.md5(COALESCE(
               pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '<NULL>'
             )) = expected.check_md5
        )
     ) THEN
    RAISE EXCEPTION 'OpenAI native delivery RLS policy drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        VALUES
          ('00_realtime_native_speech_deliveries_guard_v1', 23::smallint,
           'guard_realtime_native_delivery_v1', '3709ffccd4c9ebeef50ac6cbd907ba51'),
          ('01_realtime_native_speech_deliveries_slo_guard_v1', 23::smallint,
           'guard_realtime_native_speech_slo_v1', '1e691b5af9ac02ac2a32c661187890b1'),
          ('02_realtime_native_speech_deliveries_delete_guard_v1', 11::smallint,
           'guard_realtime_native_delivery_delete_v1', '0342ea8af041efc48bc98570df8bab88'),
          ('03_realtime_native_speech_deliveries_truncate_guard_v1', 34::smallint,
           'deny_realtime_native_delivery_truncate_v1', '9cbd29277b0eac5c8bb6787ee0e85bd6')
      ) AS expected(trigger_name, trigger_type, function_name, function_body_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger
         JOIN pg_catalog.pg_proc AS function ON function.oid = trigger.tgfoid
         JOIN pg_catalog.pg_namespace AS function_namespace
           ON function_namespace.oid = function.pronamespace
        WHERE trigger.tgrelid = 'public.realtime_native_speech_deliveries'::regclass
          AND trigger.tgname = expected.trigger_name
          AND trigger.tgtype = expected.trigger_type
          AND trigger.tgenabled = 'O'
          AND trigger.tgqual IS NULL
          AND trigger.tgnargs = 0
          AND NOT trigger.tgdeferrable
          AND NOT trigger.tginitdeferred
          AND function_namespace.nspname = 'public'
          AND function.proname = expected.function_name
          AND pg_catalog.md5(function.prosrc) = expected.function_body_md5
     )
  ) THEN
    RAISE EXCEPTION 'OpenAI native delivery trigger binding drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.assert_realtime_native_delivery_fence_v1(text,character,uuid,text,integer,character,character,integer)'::regprocedure,
         TRUE, ARRAY['search_path=pg_catalog, public']::TEXT[], 'ff12cb80e8571754191c282ea22be058'),
        ('public.guard_realtime_native_delivery_v1()'::regprocedure,
         TRUE, ARRAY['search_path=pg_catalog, public']::TEXT[], '3709ffccd4c9ebeef50ac6cbd907ba51'),
        ('public.guard_realtime_native_speech_slo_v1()'::regprocedure,
         FALSE, ARRAY['search_path=pg_catalog, public']::TEXT[], '1e691b5af9ac02ac2a32c661187890b1'),
        ('public.guard_realtime_native_delivery_delete_v1()'::regprocedure,
         TRUE, ARRAY['search_path=pg_catalog, public', 'row_security=on']::TEXT[], '0342ea8af041efc48bc98570df8bab88'),
        ('public.deny_realtime_native_delivery_truncate_v1()'::regprocedure,
         TRUE, ARRAY['search_path=pg_catalog, public']::TEXT[], '9cbd29277b0eac5c8bb6787ee0e85bd6')
      ) AS expected(function_oid, security_definer, function_config, body_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function
         JOIN pg_catalog.pg_language AS language ON language.oid = function.prolang
        WHERE function.oid = expected.function_oid
          AND function.proowner = pg_catalog.to_regrole(session_user)
          AND function.prosecdef = expected.security_definer
          AND function.proconfig IS NOT DISTINCT FROM expected.function_config
          AND function.provolatile = 'v'
          AND function.proparallel = 'u'
          AND language.lanname = 'plpgsql'
          AND pg_catalog.md5(function.prosrc) = expected.body_md5
     )
  ) THEN
    RAISE EXCEPTION 'OpenAI native delivery helper authority drift';
  END IF;
  IF (SELECT count(*)
        FROM pg_catalog.pg_proc AS function
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
       ) AS privilege
       WHERE function.oid = ANY(trigger_helper_function_oids)
         AND privilege.privilege_type = 'EXECUTE'
         AND NOT privilege.is_grantable
         AND privilege.grantee = function.proowner) <> 5
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
        ) AS privilege
        WHERE function.oid = ANY(trigger_helper_function_oids)
          AND (
            privilege.privilege_type <> 'EXECUTE'
            OR privilege.is_grantable
            OR privilege.grantee <> function.proowner
          )
  ) THEN
    RAISE EXCEPTION 'OpenAI native delivery helper ACL drift';
  END IF;

  IF (SELECT count(*)
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.realtime_native_speech_deliveries'::regclass
         AND attribute.attname = 'subjectKeyVersion'
         AND attribute.atttypid = 'pg_catalog.int4'::regtype
         AND NOT attribute.attnotnull
         AND NOT attribute.atthasdef
         AND attribute.attgenerated = '') <> 1 THEN
    RAISE EXCEPTION 'OpenAI native subject key version column drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.realtime_native_speech_deliveries'::regclass,
         'realtime_native_speech_deliveries_subject_key_version_check',
         '2972c3527e2009f686bbd6f03adf5d26'),
        ('public.realtime_mistral_conversation_key_version_floors'::regclass,
         'mistral_key_floor_key_space_check',
         '1c774360bfeb6d229e1784de8ccd7352'),
        ('public.realtime_mistral_conversation_key_bindings'::regclass,
         'mistral_key_binding_key_space_check',
         '1c774360bfeb6d229e1784de8ccd7352')
      ) AS expected(relation_oid, constraint_name, definition_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = expected.relation_oid
          AND constraint_row.conname = expected.constraint_name
          AND constraint_row.contype = 'c'
          AND constraint_row.convalidated
          AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_row.oid)) =
            expected.definition_md5
     )
  ) THEN
    RAISE EXCEPTION 'OpenAI native key lifecycle constraint drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('realtime_native_speech_deliveries_subject_key_version_idx',
         'CREATE INDEX realtime_native_speech_deliveries_subject_key_version_idx ON public.realtime_native_speech_deliveries USING btree ("subjectKeyVersion")'),
        ('realtime_native_speech_proof_key_retention_idx',
         'CREATE INDEX realtime_native_speech_proof_key_retention_idx ON public.realtime_native_speech_deliveries USING btree ("proofKeyVersion") WHERE (phase <> ALL (ARRAY[''delivered''::text, ''cancelled''::text, ''failed''::text, ''expired''::text]))')
      ) AS expected(index_name, index_definition)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS index_relation
         JOIN pg_catalog.pg_index AS index_row ON index_row.indexrelid = index_relation.oid
        WHERE index_relation.relname = expected.index_name
          AND index_row.indrelid = 'public.realtime_native_speech_deliveries'::regclass
          AND index_row.indisvalid
          AND index_row.indisready
          AND NOT index_row.indisunique
          AND pg_catalog.pg_get_indexdef(index_row.indexrelid) = expected.index_definition
     )
  ) THEN
    RAISE EXCEPTION 'OpenAI native key lifecycle index drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.retained_bob_live_subject_hmac_key_bindings()'::regprocedure,
         'cdea8f78f1171d1b1bba67b6325b4243'),
        ('public.retained_openai_native_proof_hmac_key_bindings()'::regprocedure,
         '9cff02acd0457904fa53911a6da4a48a')
      ) AS expected(function_oid, body_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function
         JOIN pg_catalog.pg_language AS language ON language.oid = function.prolang
        WHERE function.oid = expected.function_oid
          AND function.proowner = pg_catalog.to_regrole(session_user)
          AND function.prosecdef
          AND function.proconfig IS NOT DISTINCT FROM ARRAY[
            'search_path=pg_catalog, public', 'row_security=off'
          ]::TEXT[]
          AND function.provolatile = 's'
          AND function.proparallel = 'u'
          AND language.lanname = 'sql'
          AND pg_catalog.md5(function.prosrc) = expected.body_md5
          AND pg_catalog.pg_get_function_result(function.oid) =
            'TABLE("keyVersion" integer, "keyFingerprint" text)'
     )
  ) THEN
    RAISE EXCEPTION 'OpenAI native retained key authority drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.retained_bob_live_subject_hmac_key_bindings()'::regprocedure),
        ('public.retained_openai_native_proof_hmac_key_bindings()'::regprocedure)
      ) AS expected(function_oid)
     WHERE NOT pg_catalog.has_function_privilege(
       app_role_name, expected.function_oid, 'EXECUTE'
     )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_proc AS function
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
           ) AS privilege
           WHERE function.oid = expected.function_oid
             AND (
               privilege.privilege_type <> 'EXECUTE'
               OR privilege.is_grantable
               OR privilege.grantee NOT IN (
                 function.proowner, pg_catalog.to_regrole(app_role_name)
               )
             )
        )
  ) THEN
    RAISE EXCEPTION 'OpenAI native retained key ACL drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.realtime_mistral_conversation_key_version_floors'::regclass),
        ('public.realtime_mistral_conversation_key_bindings'::regclass)
      ) AS expected(relation_oid)
     WHERE NOT pg_catalog.has_table_privilege(app_role_name, expected.relation_oid, 'SELECT')
        OR pg_catalog.has_table_privilege(
          app_role_name,
          expected.relation_oid,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
  ) THEN
    RAISE EXCEPTION 'OpenAI native key registry ACL drift';
  END IF;

  IF (SELECT count(*)
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
         'public.realtime_native_speech_deliveries'::regclass
         AND constraint_row.conname =
           'realtime_native_speech_deliveries_local_observation_shape_check'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_row.oid)) =
           '5538a9eb3a7080e2094c480e381894c1') <> 1 THEN
    RAISE EXCEPTION 'OpenAI native local observation constraint drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
         'abfb296cc0651d6b03dd3f88d4e7debb',
         'TABLE("companyId" text, "hasMore" boolean, "claimId" uuid)'),
        ('public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
         '11acc625a955d02e94d4ef54d6c8b565', 'boolean'),
        ('public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure,
         'ccb980468730e9e954ceb725761df6b9', 'boolean')
      ) AS expected(function_oid, body_md5, result_type)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function
         JOIN pg_catalog.pg_language AS language ON language.oid = function.prolang
        WHERE function.oid = expected.function_oid
          AND function.proowner = 'bob_openai_native_maintenance_directory'::regrole
          AND function.prosecdef
          AND function.proconfig IS NOT DISTINCT FROM ARRAY[
            'search_path=pg_catalog', 'row_security=on', 'statement_timeout=4s'
          ]::TEXT[]
          AND function.provolatile = 'v'
          AND function.proparallel = 'u'
          AND language.lanname = 'plpgsql'
          AND pg_catalog.md5(function.prosrc) = expected.body_md5
          AND pg_catalog.pg_get_function_result(function.oid) = expected.result_type
     )
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory authority drift';
  END IF;

  IF (SELECT count(*)
        FROM pg_catalog.pg_proc AS function
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
       ) AS privilege
       WHERE function.oid = ANY(directory_function_oids)
         AND privilege.privilege_type = 'EXECUTE'
         AND NOT privilege.is_grantable
         AND privilege.grantee IN (
           function.proowner,
           pg_catalog.to_regrole(app_role_name)
         )) <> 6
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
        ) AS privilege
        WHERE function.oid = ANY(directory_function_oids)
          AND (
            privilege.privilege_type <> 'EXECUTE'
            OR privilege.is_grantable
            OR privilege.grantee NOT IN (
              function.proowner,
              pg_catalog.to_regrole(app_role_name)
            )
          )
     )
     OR EXISTS (
       SELECT 1
         FROM unnest(directory_function_oids) AS expected(function_oid)
        WHERE NOT has_function_privilege(app_role_name, expected.function_oid, 'EXECUTE')
     )
     OR pg_has_role(
       app_role_name,
       'bob_openai_native_maintenance_directory',
       'SET'
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory ACL drift';
  END IF;
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM unnest(directory_function_oids) AS expected(function_oid)
          WHERE has_function_privilege(exposed_role, expected.function_oid, 'EXECUTE')
       ) THEN
      RAISE EXCEPTION 'OpenAI native maintenance directory exposed to role %', exposed_role;
    END IF;
  END LOOP;

  IF NOT has_table_privilege(
       app_role_name, 'public.realtime_native_speech_deliveries', 'DELETE'
     )
     OR has_table_privilege(
       app_role_name,
       'public.realtime_native_speech_deliveries',
       'TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'OpenAI native runtime table ACL drift';
  END IF;
  IF (SELECT relation.relrowsecurity AND relation.relforcerowsecurity
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_native_speech_maintenance_cursors'::regclass)
     IS DISTINCT FROM TRUE
     OR (SELECT count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid =
            'public.realtime_native_speech_maintenance_cursors'::regclass) <> 2
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('realtime_native_speech_maintenance_cursor_directory_select', 'r',
            '(CURRENT_USER = ''bob_openai_native_maintenance_directory''::name)', NULL::TEXT),
           ('realtime_native_speech_maintenance_cursor_directory_update', 'w',
            '(CURRENT_USER = ''bob_openai_native_maintenance_directory''::name)',
            '(CURRENT_USER = ''bob_openai_native_maintenance_directory''::name)')
         ) AS expected(policy_name, policy_command, policy_using, policy_check)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid =
             'public.realtime_native_speech_maintenance_cursors'::regclass
             AND policy.polname = expected.policy_name
             AND policy.polcmd = expected.policy_command
             AND policy.polpermissive
             AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
                 IS NOT DISTINCT FROM expected.policy_using
             AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
                 IS NOT DISTINCT FROM expected.policy_check
        )
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance cursor RLS drift';
  END IF;
  IF has_table_privilege(
       app_role_name,
       'public.realtime_native_speech_maintenance_cursors',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR NOT has_table_privilege(
       'bob_openai_native_maintenance_directory',
       'public.realtime_native_speech_maintenance_cursors',
       'SELECT,UPDATE'
     )
     OR has_table_privilege(
       'bob_openai_native_maintenance_directory',
       'public.realtime_native_speech_maintenance_cursors',
       'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance cursor ACL drift';
  END IF;
  IF (SELECT count(*)
        FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
       ) AS privilege
       WHERE relation.oid = 'public.realtime_native_speech_maintenance_cursors'::regclass
         AND privilege.grantee =
           'bob_openai_native_maintenance_directory'::regrole
         AND privilege.privilege_type IN ('SELECT', 'UPDATE')
         AND NOT privilege.is_grantable) <> 2
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) AS privilege
        WHERE relation.oid = 'public.realtime_native_speech_maintenance_cursors'::regclass
          AND privilege.grantee <> relation.relowner
          AND (
            privilege.grantee <>
              'bob_openai_native_maintenance_directory'::regrole
            OR privilege.privilege_type NOT IN ('SELECT', 'UPDATE')
            OR privilege.is_grantable
          )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid =
          'public.realtime_native_speech_maintenance_cursors'::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attacl IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance cursor exact ACL drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.realtime_native_speech_deliveries'::regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND has_column_privilege(
         'bob_openai_native_maintenance_directory',
         attribute.attrelid,
         attribute.attnum,
         'SELECT'
       ) IS DISTINCT FROM (attribute.attname = ANY (
         ARRAY['deliveryId', 'companyId', 'phase', 'expiresAt', 'retentionExpiresAt']::TEXT[]
       ))
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance delivery column ACL drift';
  END IF;
  IF (SELECT count(*)
        FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
       WHERE attribute.attrelid = 'public.realtime_native_speech_deliveries'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attname = ANY (
           ARRAY['deliveryId', 'companyId', 'phase', 'expiresAt', 'retentionExpiresAt']::TEXT[]
         )
         AND privilege.grantee =
           'bob_openai_native_maintenance_directory'::regrole
         AND privilege.privilege_type = 'SELECT'
         AND NOT privilege.is_grantable) <> 5
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        WHERE attribute.attrelid = 'public.realtime_native_speech_deliveries'::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND (
            attribute.attname <> ALL (
              ARRAY['deliveryId', 'companyId', 'phase', 'expiresAt', 'retentionExpiresAt']::TEXT[]
            )
            OR privilege.grantee <>
              'bob_openai_native_maintenance_directory'::regrole
            OR privilege.privilege_type <> 'SELECT'
            OR privilege.is_grantable
          )
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance delivery exact column ACL drift';
  END IF;

  IF (SELECT count(*) FROM public.realtime_native_speech_maintenance_cursors) <> 2
     OR (SELECT array_agg(cursor.lane ORDER BY cursor.lane)
           FROM public.realtime_native_speech_maintenance_cursors AS cursor)
        IS DISTINCT FROM ARRAY['expiry', 'retention']::TEXT[]
     OR EXISTS (
       SELECT 1
         FROM public.realtime_native_speech_maintenance_cursors AS cursor
        WHERE cursor.revision < 0
          OR ((cursor."afterDueAt" IS NULL) <> (cursor."afterCompanyId" IS NULL))
          OR ((cursor."afterDueAt" IS NULL) <> (cursor."afterDeliveryId" IS NULL))
          OR ((cursor."cycleUpperDueAt" IS NULL) <>
              (cursor."cycleUpperCompanyId" IS NULL))
          OR ((cursor."cycleUpperDueAt" IS NULL) <>
              (cursor."cycleUpperDeliveryId" IS NULL))
          OR ((cursor."claimId" IS NULL) <> (cursor."claimExpiresAt" IS NULL))
          OR ((cursor."claimId" IS NULL) <> (cursor."pendingHasMore" IS NULL))
          OR ((cursor."claimId" IS NULL) <>
              (cardinality(cursor."pendingCompanyIds") = 0))
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance cursor state drift';
  END IF;

  IF (SELECT count(*)
        FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.realtime_control_grants'::regclass
         AND conname = 'realtime_control_grants_provider_stream_v1_disabled_check'
         AND convalidated
         AND pg_catalog.pg_get_constraintdef(oid) =
           'CHECK (("deliveryKind" <> ''provider_stream''::text))') <> 1 THEN
    RAISE EXCEPTION 'OpenAI native provider_stream V1 fence drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('realtime_native_speech_maintenance_cursor_claim_check',
         '4340c077c54312c389c586dbef569727'),
        ('realtime_native_speech_maintenance_cursor_lane_check',
         'f628cfd9ea3cf0fcce9db2603e41c002'),
        ('realtime_native_speech_maintenance_cursor_revision_check',
         'f02ee38442083518cf544f73183f7d08'),
        ('realtime_native_speech_maintenance_cursor_tuple_check',
         '33d50b82e8faa38cec428d94577dc4c8')
      ) AS expected(constraint_name, definition_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid =
          'public.realtime_native_speech_maintenance_cursors'::regclass
          AND constraint_row.conname = expected.constraint_name
          AND constraint_row.contype = 'c'
          AND constraint_row.convalidated
          AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_row.oid)) =
            expected.definition_md5
     )
  )
  OR (SELECT count(*)
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
         'public.realtime_native_speech_maintenance_cursors'::regclass
         AND constraint_row.contype = 'c') <> 4 THEN
    RAISE EXCEPTION 'OpenAI native maintenance cursor constraint drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('realtime_native_speech_deliveries_tenant_reaper_idx',
         'CREATE INDEX realtime_native_speech_deliveries_tenant_reaper_idx ON public.realtime_native_speech_deliveries USING btree ("companyId", "expiresAt", "deliveryId") WHERE (phase <> ALL (ARRAY[''delivered''::text, ''cancelled''::text, ''failed''::text, ''expired''::text]))'),
        ('realtime_native_speech_deliveries_tenant_retention_terminal_idx',
         'CREATE INDEX realtime_native_speech_deliveries_tenant_retention_terminal_idx ON public.realtime_native_speech_deliveries USING btree ("companyId", "retentionExpiresAt", "deliveryId") WHERE (phase = ANY (ARRAY[''delivered''::text, ''cancelled''::text, ''failed''::text, ''expired''::text]))'),
        ('realtime_native_speech_due_expiry_directory_idx',
         'CREATE INDEX realtime_native_speech_due_expiry_directory_idx ON public.realtime_native_speech_deliveries USING btree ("expiresAt", "companyId", "deliveryId") WHERE (phase <> ALL (ARRAY[''delivered''::text, ''cancelled''::text, ''failed''::text, ''expired''::text]))'),
        ('realtime_native_speech_due_retention_directory_idx',
         'CREATE INDEX realtime_native_speech_due_retention_directory_idx ON public.realtime_native_speech_deliveries USING btree ("retentionExpiresAt", "companyId", "deliveryId") WHERE (phase = ANY (ARRAY[''delivered''::text, ''cancelled''::text, ''failed''::text, ''expired''::text]))')
      ) AS expected(index_name, index_definition)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS index_relation
         JOIN pg_catalog.pg_index AS index_definition
           ON index_definition.indexrelid = index_relation.oid
        WHERE index_relation.relname = expected.index_name
          AND index_definition.indrelid =
            'public.realtime_native_speech_deliveries'::regclass
          AND index_definition.indisvalid
          AND index_definition.indisready
          AND NOT index_definition.indisunique
          AND index_definition.indpred IS NOT NULL
          AND pg_catalog.pg_get_indexdef(index_definition.indexrelid) = expected.index_definition
     )
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance index drift';
  END IF;
END;
$$;

RESET ROLE;
ROLLBACK;
