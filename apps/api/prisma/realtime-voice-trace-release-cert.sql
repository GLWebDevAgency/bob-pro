\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';
SELECT pg_catalog.set_config('app.release_runtime_role', :'app_role', true);
SELECT pg_catalog.set_config('app.release_environment', :'release_env', true);

DO $realtime_voice_trace_release_certificate$
DECLARE
  runtime_name TEXT := NULLIF(current_setting('app.release_runtime_role', TRUE), '');
  release_environment TEXT := current_setting('app.release_environment', TRUE);
  authority_name TEXT;
  authority pg_catalog.pg_roles%ROWTYPE;
  runtime pg_catalog.pg_roles%ROWTYPE;
  relation_name TEXT;
  relation pg_catalog.pg_class%ROWTYPE;
  column_name TEXT;
  expected_insert BOOLEAN;
  expected_select BOOLEAN;
  expected_update BOOLEAN;
  expected_delete BOOLEAN;
  protected_function REGPROCEDURE;
  expected_owner TEXT;
  exposed_role TEXT;
  actual_policies TEXT[];
  actual_triggers TEXT[];
  authority_column RECORD;
  expected_policy RECORD;
  actual_policy RECORD;
  expected_trigger RECORD;
  required_token TEXT;
  actual_qual TEXT;
  actual_check TEXT;
BEGIN
  IF release_environment NOT IN ('development', 'staging', 'production') THEN
    RAISE EXCEPTION 'Realtime Voice Trace release environment rejected';
  END IF;
  IF runtime_name IS NULL OR pg_catalog.to_regrole(runtime_name) IS NULL THEN
    RAISE EXCEPTION 'Realtime Voice Trace runtime role is required for certification';
  END IF;
  SELECT * INTO STRICT runtime
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = runtime_name;
  IF runtime.rolsuper OR runtime.rolbypassrls THEN
    RAISE EXCEPTION 'Realtime Voice Trace runtime must be non-superuser and non-bypass';
  END IF;

  FOREACH authority_name IN ARRAY ARRAY[
    'bob_realtime_voice_trace_maintenance',
    'bob_realtime_voice_trace_key_readiness',
    'bob_realtime_voice_trace_reader'
  ]::TEXT[] LOOP
    SELECT * INTO STRICT authority
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = authority_name;
    IF authority.rolcanlogin
       OR authority.rolsuper
       OR authority.rolcreatedb
       OR authority.rolcreaterole
       OR authority.rolinherit
       OR authority.rolreplication
       OR authority.rolbypassrls
       OR pg_catalog.pg_has_role(runtime_name, authority.oid, 'MEMBER')
       OR pg_catalog.pg_has_role(runtime_name, authority.oid, 'SET')
       OR NOT pg_catalog.has_schema_privilege(authority_name, 'public', 'USAGE')
       OR pg_catalog.has_schema_privilege(authority_name, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'Realtime Voice Trace authority profile drift: %', authority_name;
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY ARRAY[
    'realtime_voice_trace_events',
    'realtime_voice_trace_access_audits'
  ]::TEXT[] LOOP
    SELECT * INTO STRICT relation
      FROM pg_catalog.pg_class AS candidate
     WHERE candidate.oid = pg_catalog.to_regclass('public.' || relation_name);
    IF relation.relkind <> 'r'
       OR NOT relation.relrowsecurity
       OR NOT relation.relforcerowsecurity
       OR relation.relowner IN (
         'bob_realtime_voice_trace_maintenance'::REGROLE,
         'bob_realtime_voice_trace_key_readiness'::REGROLE,
         'bob_realtime_voice_trace_reader'::REGROLE
       ) THEN
      RAISE EXCEPTION 'Realtime Voice Trace relation authority drift: %', relation_name;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege(
       runtime_name, 'public.realtime_voice_trace_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR NOT pg_catalog.has_any_column_privilege(
       runtime_name, 'public.realtime_voice_trace_events', 'INSERT'
     )
     OR NOT pg_catalog.has_column_privilege(
       runtime_name, 'public.realtime_voice_trace_events', 'id', 'SELECT'
     )
     OR NOT pg_catalog.has_column_privilege(
       runtime_name, 'public.realtime_voice_trace_events', 'eventDigest', 'SELECT'
     )
     OR NOT pg_catalog.has_column_privilege(
       runtime_name, 'public.realtime_voice_trace_events', 'eventDigestKeyVersion', 'SELECT'
     )
     OR NOT pg_catalog.has_column_privilege(
       runtime_name, 'public.realtime_voice_trace_events', 'companyId', 'SELECT'
     )
     OR NOT pg_catalog.has_column_privilege(
       runtime_name, 'public.realtime_voice_trace_events', 'traceAttemptId', 'SELECT'
     )
     OR NOT pg_catalog.has_column_privilege(
       runtime_name, 'public.realtime_voice_trace_events', 'eventOrdinal', 'SELECT'
     )
     OR pg_catalog.has_any_column_privilege(
       runtime_name, 'public.realtime_voice_trace_access_audits',
       'SELECT,INSERT,UPDATE,REFERENCES'
     )
     OR pg_catalog.has_table_privilege(
       runtime_name, 'public.realtime_voice_trace_access_audits',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'Realtime Voice Trace runtime table ACL drift';
  END IF;

  FOR column_name IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.realtime_voice_trace_events'::REGCLASS
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  LOOP
    expected_select := column_name IN (
      'id', 'companyId', 'traceAttemptId', 'eventOrdinal',
      'eventDigest', 'eventDigestKeyVersion'
    );
    expected_insert := column_name NOT IN ('ingestedAt', 'retentionExpiresAt');
    IF pg_catalog.has_column_privilege(
         runtime_name, 'public.realtime_voice_trace_events', column_name, 'SELECT'
       ) <> expected_select
       OR pg_catalog.has_column_privilege(
         runtime_name, 'public.realtime_voice_trace_events', column_name, 'INSERT'
       ) <> expected_insert
       OR pg_catalog.has_column_privilege(
         runtime_name, 'public.realtime_voice_trace_events', column_name, 'UPDATE,REFERENCES'
       ) THEN
      RAISE EXCEPTION 'Realtime Voice Trace runtime column ACL drift: %', column_name;
    END IF;
  END LOOP;

  FOREACH authority_name IN ARRAY ARRAY[
    'bob_realtime_voice_trace_maintenance',
    'bob_realtime_voice_trace_key_readiness',
    'bob_realtime_voice_trace_reader'
  ]::TEXT[] LOOP
    FOREACH relation_name IN ARRAY ARRAY[
      'realtime_voice_trace_events',
      'realtime_voice_trace_access_audits'
    ]::TEXT[] LOOP
      expected_delete := authority_name = 'bob_realtime_voice_trace_maintenance';
      IF pg_catalog.has_table_privilege(
           authority_name, 'public.' || relation_name, 'DELETE'
         ) <> expected_delete
         OR pg_catalog.has_table_privilege(
           authority_name, 'public.' || relation_name, 'SELECT'
         )
         OR pg_catalog.has_table_privilege(
           authority_name, 'public.' || relation_name, 'INSERT'
         )
         OR pg_catalog.has_table_privilege(
           authority_name, 'public.' || relation_name, 'UPDATE'
         )
         OR pg_catalog.has_table_privilege(
           authority_name, 'public.' || relation_name, 'TRUNCATE'
         )
         OR pg_catalog.has_table_privilege(
           authority_name, 'public.' || relation_name, 'REFERENCES'
         )
         OR pg_catalog.has_table_privilege(
           authority_name, 'public.' || relation_name, 'TRIGGER'
         ) THEN
        RAISE EXCEPTION 'Realtime Voice Trace authority table ACL drift: %/%',
          authority_name, relation_name;
      END IF;
    END LOOP;

    FOR authority_column IN
      SELECT protected_relation.relname AS relation_name, attribute.attname AS column_name
        FROM pg_catalog.pg_class AS protected_relation
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = protected_relation.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       WHERE protected_relation.oid IN (
         'public.realtime_voice_trace_events'::REGCLASS,
         'public.realtime_voice_trace_access_audits'::REGCLASS
       )
       ORDER BY protected_relation.relname, attribute.attnum
    LOOP
      expected_select := (
        authority_name = 'bob_realtime_voice_trace_maintenance'
        AND (
          (
            authority_column.relation_name = 'realtime_voice_trace_events'
            AND authority_column.column_name IN (
              'id', 'companyId', 'userId', 'retentionExpiresAt'
            )
          )
          OR (
            authority_column.relation_name = 'realtime_voice_trace_access_audits'
            AND authority_column.column_name IN (
              'id', 'companyId', 'subjectUserId', 'retentionExpiresAt'
            )
          )
        )
      ) OR (
        authority_name = 'bob_realtime_voice_trace_key_readiness'
        AND authority_column.relation_name = 'realtime_voice_trace_events'
        AND authority_column.column_name IN (
          'eventDigestKeyVersion', 'encryptionKeyVersion'
        )
      ) OR (
        authority_name = 'bob_realtime_voice_trace_reader'
        AND authority_column.relation_name = 'realtime_voice_trace_events'
        AND authority_column.column_name IN (
          'id', 'companyId', 'userId', 'traceAttemptId', 'sessionHandle', 'ownerEpoch',
          'eventOrdinal', 'eventKind', 'turnId', 'occurredAt', 'durationMs',
          'contextRevision', 'contextDigest', 'speechDelivery', 'plannerDisposition',
          'plannerAuthority', 'plannerIntent', 'missionKind', 'runKind', 'controlKind',
          'stage', 'outcome', 'failureClass', 'interruptionReason',
          'eventDigestKeyVersion', 'encryptionKeyVersion', 'transcriptCiphertext',
          'canonicalReplyCiphertext'
        )
      );
      expected_insert := (
        authority_name = 'bob_realtime_voice_trace_reader'
        AND authority_column.relation_name = 'realtime_voice_trace_access_audits'
        AND authority_column.column_name IN (
          'id', 'requestId', 'companyId', 'subjectUserId', 'sessionHandle',
          'reason', 'ticket', 'includedContent', 'rowCount'
        )
      );
      expected_update := (
        authority_name = 'bob_realtime_voice_trace_maintenance'
        AND authority_column.column_name = 'id'
      );
      IF pg_catalog.has_column_privilege(
           authority_name,
           'public.' || authority_column.relation_name,
           authority_column.column_name,
           'SELECT'
         ) <> expected_select
         OR pg_catalog.has_column_privilege(
           authority_name,
           'public.' || authority_column.relation_name,
           authority_column.column_name,
           'INSERT'
         ) <> expected_insert
         OR pg_catalog.has_column_privilege(
           authority_name,
           'public.' || authority_column.relation_name,
           authority_column.column_name,
           'UPDATE'
         ) <> expected_update
         OR pg_catalog.has_column_privilege(
           authority_name,
           'public.' || authority_column.relation_name,
           authority_column.column_name,
           'REFERENCES'
         ) THEN
        RAISE EXCEPTION 'Realtime Voice Trace authority column ACL drift: %/%/%',
          authority_name, authority_column.relation_name, authority_column.column_name;
      END IF;
    END LOOP;
  END LOOP;

  -- Un ancien rôle arbitraire ne doit survivre ni dans les ACL table ni dans une ACL colonne.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS protected_relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(
         protected_relation.relacl,
         pg_catalog.acldefault('r', protected_relation.relowner)
       )
     ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
     WHERE protected_relation.oid IN (
       'public.realtime_voice_trace_events'::REGCLASS,
       'public.realtime_voice_trace_access_audits'::REGCLASS
     )
       AND privilege.grantee <> protected_relation.relowner
       AND coalesce(grantee.rolname, 'PUBLIC') <>
         'bob_realtime_voice_trace_maintenance'
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
     WHERE attribute.attrelid IN (
       'public.realtime_voice_trace_events'::REGCLASS,
       'public.realtime_voice_trace_access_audits'::REGCLASS
     )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND coalesce(grantee.rolname, 'PUBLIC') NOT IN (
         runtime_name,
         'bob_realtime_voice_trace_maintenance',
         'bob_realtime_voice_trace_key_readiness',
         'bob_realtime_voice_trace_reader'
       )
  ) THEN
    RAISE EXCEPTION 'Realtime Voice Trace unexpected ACL grantee';
  END IF;

  FOR protected_function, expected_owner IN
    SELECT function_oid, owner_name
      FROM (VALUES
        ('public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
          'bob_realtime_voice_trace_maintenance'),
        ('public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
          'bob_realtime_voice_trace_maintenance'),
        ('public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
          'bob_realtime_voice_trace_maintenance'),
        ('public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE,
          'bob_realtime_voice_trace_key_readiness'),
        ('public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE,
          'bob_realtime_voice_trace_reader')
      ) AS expected(function_oid, owner_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function
       WHERE function.oid = protected_function
         AND function.proowner = expected_owner::REGROLE
         AND function.prosecdef
         AND function.proconfig @> ARRAY['search_path=pg_catalog', 'row_security=on']::TEXT[]
    ) THEN
      RAISE EXCEPTION 'Realtime Voice Trace function authority drift: %', protected_function;
    END IF;
    FOREACH exposed_role IN ARRAY ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::TEXT[] LOOP
      IF exposed_role = 'PUBLIC' THEN
        IF EXISTS (
          SELECT 1
            FROM pg_catalog.pg_proc AS function
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
           ) AS privilege
           WHERE function.oid = protected_function
             AND privilege.grantee = 0
             AND privilege.privilege_type = 'EXECUTE'
        ) THEN
          RAISE EXCEPTION 'PUBLIC executes Realtime Voice Trace function %', protected_function;
        END IF;
      ELSIF pg_catalog.to_regrole(exposed_role) IS NOT NULL
            AND pg_catalog.has_function_privilege(exposed_role, protected_function, 'EXECUTE') THEN
        RAISE EXCEPTION '% executes Realtime Voice Trace function %',
          exposed_role, protected_function;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
     WHERE function.oid IN (
       'public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
       'public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
       'public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
       'public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE,
       'public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE
     )
       AND privilege.privilege_type = 'EXECUTE'
       AND privilege.grantee <> function.proowner
       AND NOT (
         grantee.rolname = runtime_name
         AND function.oid IN (
           'public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
           'public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
           'public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
           'public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE
         )
       )
       AND NOT (
         release_environment = 'staging'
         AND grantee.rolname = session_user
         AND function.oid =
           'public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE
       )
  ) THEN
    RAISE EXCEPTION 'Realtime Voice Trace unexpected function executor';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS protected_relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(
         protected_relation.relacl,
         pg_catalog.acldefault('r', protected_relation.relowner)
       )
     ) AS privilege
     WHERE protected_relation.oid IN (
       'public.realtime_voice_trace_events'::REGCLASS,
       'public.realtime_voice_trace_access_audits'::REGCLASS
     )
       AND privilege.grantee <> protected_relation.relowner
       AND privilege.is_grantable
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
     WHERE attribute.attrelid IN (
       'public.realtime_voice_trace_events'::REGCLASS,
       'public.realtime_voice_trace_access_audits'::REGCLASS
     )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND privilege.is_grantable
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid IN (
       'public.prepare_realtime_voice_trace_event_v2()'::REGPROCEDURE,
       'public.prepare_realtime_voice_trace_access_audit_v2()'::REGPROCEDURE,
       'public.deny_realtime_voice_trace_mutation_v2()'::REGPROCEDURE,
       'public.guard_realtime_voice_trace_delete_v2()'::REGPROCEDURE,
       'public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
       'public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
       'public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
       'public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE,
       'public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE
     )
       AND privilege.grantee <> function.proowner
       AND privilege.is_grantable
  ) THEN
    RAISE EXCEPTION 'Realtime Voice Trace ACL grant option drift';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       runtime_name,
       'public.erase_realtime_voice_trace_subject_v2(text,uuid,text)', 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       runtime_name, 'public.purge_realtime_voice_trace_v2(integer)', 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       runtime_name, 'public.inspect_realtime_voice_trace_retention_v2()', 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       runtime_name,
       'public.assert_realtime_voice_trace_key_versions_v2(integer[])', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       runtime_name,
       'public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Realtime Voice Trace runtime function ACL drift';
  END IF;

  SELECT pg_catalog.array_agg(policy.policyname ORDER BY policy.policyname)
    INTO actual_policies
    FROM pg_catalog.pg_policies AS policy
   WHERE policy.schemaname = 'public'
     AND policy.tablename IN (
       'realtime_voice_trace_events', 'realtime_voice_trace_access_audits'
     );
  IF actual_policies IS DISTINCT FROM ARRAY[
    'realtime_voice_trace_access_maintenance_delete',
    'realtime_voice_trace_access_maintenance_lock',
    'realtime_voice_trace_access_maintenance_select',
    'realtime_voice_trace_access_owner_all',
    'realtime_voice_trace_access_reader_insert',
    'realtime_voice_trace_maintenance_delete',
    'realtime_voice_trace_maintenance_lock',
    'realtime_voice_trace_maintenance_select',
    'realtime_voice_trace_owner_all',
    'realtime_voice_trace_reader_select',
    'realtime_voice_trace_readiness_select',
    'realtime_voice_trace_subject_insert',
    'realtime_voice_trace_subject_select'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'Realtime Voice Trace policy inventory drift';
  END IF;

  FOR expected_policy IN
    SELECT * FROM (VALUES
      ('realtime_voice_trace_events', 'realtime_voice_trace_owner_all', '*',
        ARRAY['current_user', 'pg_get_userbyid', 'realtime_voice_trace_events']::TEXT[],
        ARRAY['current_user', 'pg_get_userbyid', 'realtime_voice_trace_events']::TEXT[]),
      ('realtime_voice_trace_events', 'realtime_voice_trace_subject_select', 'r',
        ARRAY['app.current_company_id', 'app.current_user_id']::TEXT[], ARRAY[]::TEXT[]),
      ('realtime_voice_trace_events', 'realtime_voice_trace_subject_insert', 'a',
        ARRAY[]::TEXT[], ARRAY['app.current_company_id', 'app.current_user_id']::TEXT[]),
      ('realtime_voice_trace_events', 'realtime_voice_trace_reader_select', 'r',
        ARRAY['bob_realtime_voice_trace_reader']::TEXT[], ARRAY[]::TEXT[]),
      ('realtime_voice_trace_events', 'realtime_voice_trace_readiness_select', 'r',
        ARRAY['bob_realtime_voice_trace_key_readiness']::TEXT[], ARRAY[]::TEXT[]),
      ('realtime_voice_trace_events', 'realtime_voice_trace_maintenance_select', 'r',
        ARRAY['bob_realtime_voice_trace_maintenance']::TEXT[], ARRAY[]::TEXT[]),
      ('realtime_voice_trace_events', 'realtime_voice_trace_maintenance_lock', 'w',
        ARRAY['bob_realtime_voice_trace_maintenance']::TEXT[], ARRAY['false']::TEXT[]),
      ('realtime_voice_trace_events', 'realtime_voice_trace_maintenance_delete', 'd',
        ARRAY['bob_realtime_voice_trace_maintenance']::TEXT[], ARRAY[]::TEXT[]),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_owner_all', '*',
        ARRAY['current_user', 'pg_get_userbyid', 'realtime_voice_trace_access_audits']::TEXT[],
        ARRAY['current_user', 'pg_get_userbyid', 'realtime_voice_trace_access_audits']::TEXT[]),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_reader_insert', 'a',
        ARRAY[]::TEXT[], ARRAY['bob_realtime_voice_trace_reader']::TEXT[]),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_maintenance_select', 'r',
        ARRAY['bob_realtime_voice_trace_maintenance']::TEXT[], ARRAY[]::TEXT[]),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_maintenance_lock', 'w',
        ARRAY['bob_realtime_voice_trace_maintenance']::TEXT[], ARRAY['false']::TEXT[]),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_maintenance_delete', 'd',
        ARRAY['bob_realtime_voice_trace_maintenance']::TEXT[], ARRAY[]::TEXT[])
    ) AS expected(
      relation_name, policy_name, command, qual_tokens, check_tokens
    )
  LOOP
    SELECT policy.polcmd::TEXT AS command,
           policy.polpermissive AS permissive,
           policy.polroles AS roles,
           pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS qual,
           pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
      INTO STRICT actual_policy
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid =
       pg_catalog.to_regclass('public.' || expected_policy.relation_name)
       AND policy.polname = expected_policy.policy_name;
    IF actual_policy.command <> expected_policy.command
       OR NOT actual_policy.permissive
       OR actual_policy.roles IS DISTINCT FROM ARRAY[0]::OID[]
       OR (
         pg_catalog.cardinality(expected_policy.qual_tokens) = 0
         AND actual_policy.qual IS NOT NULL
       )
       OR (
         pg_catalog.cardinality(expected_policy.check_tokens) = 0
         AND actual_policy.check_expression IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'Realtime Voice Trace policy semantic drift: %',
        expected_policy.policy_name;
    END IF;
    actual_qual := pg_catalog.lower(pg_catalog.regexp_replace(
      coalesce(actual_policy.qual, ''), '[[:space:]]+', '', 'g'
    ));
    FOREACH required_token IN ARRAY expected_policy.qual_tokens LOOP
      IF pg_catalog.strpos(actual_qual, required_token) = 0 THEN
        RAISE EXCEPTION 'Realtime Voice Trace policy USING drift: %',
          expected_policy.policy_name;
      END IF;
    END LOOP;
    actual_check := pg_catalog.lower(pg_catalog.regexp_replace(
      coalesce(actual_policy.check_expression, ''), '[[:space:]]+', '', 'g'
    ));
    FOREACH required_token IN ARRAY expected_policy.check_tokens LOOP
      IF pg_catalog.strpos(actual_check, required_token) = 0 THEN
        RAISE EXCEPTION 'Realtime Voice Trace policy WITH CHECK drift: %',
          expected_policy.policy_name;
      END IF;
    END LOOP;
  END LOOP;

  SELECT pg_catalog.array_agg(trigger.tgname ORDER BY trigger.tgname)
    INTO actual_triggers
    FROM pg_catalog.pg_trigger AS trigger
   WHERE trigger.tgrelid IN (
     'public.realtime_voice_trace_events'::REGCLASS,
     'public.realtime_voice_trace_access_audits'::REGCLASS
   )
     AND NOT trigger.tgisinternal
     AND trigger.tgenabled <> 'D';
  IF actual_triggers IS DISTINCT FROM ARRAY[
    'realtime_voice_trace_access_delete_guard',
    'realtime_voice_trace_access_prepare',
    'realtime_voice_trace_access_truncate_denied',
    'realtime_voice_trace_access_update_denied',
    'realtime_voice_trace_delete_guard',
    'realtime_voice_trace_prepare_event',
    'realtime_voice_trace_truncate_denied',
    'realtime_voice_trace_update_denied'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'Realtime Voice Trace trigger inventory drift';
  END IF;

  FOR expected_trigger IN
    SELECT * FROM (VALUES
      ('realtime_voice_trace_events', 'realtime_voice_trace_prepare_event',
        'public.prepare_realtime_voice_trace_event_v2()'::REGPROCEDURE, 7),
      ('realtime_voice_trace_events', 'realtime_voice_trace_update_denied',
        'public.deny_realtime_voice_trace_mutation_v2()'::REGPROCEDURE, 19),
      ('realtime_voice_trace_events', 'realtime_voice_trace_truncate_denied',
        'public.deny_realtime_voice_trace_mutation_v2()'::REGPROCEDURE, 34),
      ('realtime_voice_trace_events', 'realtime_voice_trace_delete_guard',
        'public.guard_realtime_voice_trace_delete_v2()'::REGPROCEDURE, 11),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_prepare',
        'public.prepare_realtime_voice_trace_access_audit_v2()'::REGPROCEDURE, 7),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_update_denied',
        'public.deny_realtime_voice_trace_mutation_v2()'::REGPROCEDURE, 19),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_truncate_denied',
        'public.deny_realtime_voice_trace_mutation_v2()'::REGPROCEDURE, 34),
      ('realtime_voice_trace_access_audits', 'realtime_voice_trace_access_delete_guard',
        'public.guard_realtime_voice_trace_delete_v2()'::REGPROCEDURE, 11)
    ) AS expected(relation_name, trigger_name, function_oid, trigger_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_trigger AS trigger
       WHERE trigger.tgrelid =
         pg_catalog.to_regclass('public.' || expected_trigger.relation_name)
         AND trigger.tgname = expected_trigger.trigger_name
         AND trigger.tgfoid = expected_trigger.function_oid
         AND trigger.tgtype = expected_trigger.trigger_type
         AND trigger.tgenabled = 'O'
         AND NOT trigger.tgisinternal
    ) THEN
      RAISE EXCEPTION 'Realtime Voice Trace trigger semantic drift: %',
        expected_trigger.trigger_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid IN (
       'public.prepare_realtime_voice_trace_event_v2()'::REGPROCEDURE,
       'public.prepare_realtime_voice_trace_access_audit_v2()'::REGPROCEDURE,
       'public.deny_realtime_voice_trace_mutation_v2()'::REGPROCEDURE,
       'public.guard_realtime_voice_trace_delete_v2()'::REGPROCEDURE
     )
       AND privilege.privilege_type = 'EXECUTE'
       AND privilege.grantee <> function.proowner
  ) THEN
    RAISE EXCEPTION 'Realtime Voice Trace trigger function ACL drift';
  END IF;

  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL AND (
      pg_catalog.has_table_privilege(
        exposed_role, 'public.realtime_voice_trace_events',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
      OR pg_catalog.has_any_column_privilege(
        exposed_role, 'public.realtime_voice_trace_events',
        'SELECT,INSERT,UPDATE,REFERENCES'
      )
      OR pg_catalog.has_table_privilege(
        exposed_role, 'public.realtime_voice_trace_access_audits',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
      OR pg_catalog.has_any_column_privilege(
        exposed_role, 'public.realtime_voice_trace_access_audits',
        'SELECT,INSERT,UPDATE,REFERENCES'
      )
    ) THEN
      RAISE EXCEPTION 'Realtime Voice Trace Data API exposure: %', exposed_role;
    END IF;
  END LOOP;
END;
$realtime_voice_trace_release_certificate$;

ROLLBACK;
