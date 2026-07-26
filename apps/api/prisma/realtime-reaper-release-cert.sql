\set ON_ERROR_STOP on

-- Certificat live metadata-only : aucune fixture, aucun DDL, aucune mutation de curseur/source.
BEGIN TRANSACTION READ ONLY;
SELECT pg_catalog.set_config('bob.realtime_reaper_release_app_role', :'app_role', true);
SET LOCAL ROLE bob_realtime_reaper_directory;

DO $$
DECLARE
  app_role_name TEXT := NULLIF(
    pg_catalog.current_setting('bob.realtime_reaper_release_app_role', true),
    ''
  );
  directory pg_catalog.pg_roles%ROWTYPE;
  exposed_role TEXT;
  relation_name TEXT;
  privilege_name TEXT;
BEGIN
  IF app_role_name IS NULL OR pg_catalog.to_regrole(app_role_name) IS NULL THEN
    RAISE EXCEPTION 'Realtime reaper release requires an existing runtime app role';
  END IF;
  SELECT * INTO STRICT directory
    FROM pg_catalog.pg_roles WHERE rolname = 'bob_realtime_reaper_directory';
  IF directory.rolcanlogin OR directory.rolsuper OR directory.rolcreatedb
     OR directory.rolcreaterole OR directory.rolinherit OR directory.rolreplication
     OR directory.rolbypassrls THEN
    RAISE EXCEPTION 'Realtime reaper directory role privilege drift';
  END IF;
  IF pg_catalog.pg_has_role(app_role_name, 'bob_realtime_reaper_directory', 'MEMBER')
     OR pg_catalog.pg_has_role(app_role_name, 'bob_realtime_reaper_directory', 'SET') THEN
    RAISE EXCEPTION 'Runtime can inherit or SET ROLE to realtime reaper directory';
  END IF;
  -- Sur Supabase le rôle de déploiement n'est PAS superuser : PostgreSQL lui accorde
  -- d'office l'ADMIN OPTION en créant le rôle, et cette ligne est inamovible (tout
  -- GRANT/REVOKE d'adhésion visant postgres est fatalement intercepté). L'invariant
  -- certifié : seul session_user est membre, avec SET (transfert d'ownership), jamais
  -- d'INHERIT, et le rôle n'est membre de rien. L'ADMIN du créateur est toléré — il
  -- n'ouvre aucune capacité au rôle runtime.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = 'bob_realtime_reaper_directory'::regrole
       AND membership.member <> pg_catalog.to_regrole(session_user)
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = 'bob_realtime_reaper_directory'::regrole
       AND membership.member = pg_catalog.to_regrole(session_user)
       AND NOT membership.inherit_option
       AND membership.set_option
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = 'bob_realtime_reaper_directory'::regrole
       AND membership.inherit_option
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = 'bob_realtime_reaper_directory'::regrole
  ) THEN
    RAISE EXCEPTION 'Realtime reaper directory membership drift';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(
       'bob_realtime_reaper_directory', 'public', 'USAGE'
     ) OR pg_catalog.has_schema_privilege(
       'bob_realtime_reaper_directory', 'public', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'Realtime reaper directory schema ACL drift';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_class AS relation
     WHERE relation.oid IN (
       'public.realtime_reaper_tenant_schedule'::regclass,
       'public.realtime_reaper_directory_cursor'::regclass
     )
       AND relation.relkind = 'r'
       AND relation.relpersistence = 'p'
       AND relation.reloptions IS NULL
       AND NOT relation.relispartition AND relation.relpartbound IS NULL
       AND NOT relation.relhasrules AND NOT relation.relhassubclass
       AND relation.relam = (
         SELECT method.oid FROM pg_catalog.pg_am AS method WHERE method.amname = 'heap'
       )
       AND relation.relowner = pg_catalog.to_regrole(session_user)
       AND relation.relnatts = CASE relation.relname
         WHEN 'realtime_reaper_tenant_schedule' THEN 4
         WHEN 'realtime_reaper_directory_cursor' THEN 17
       END
       AND relation.relchecks = CASE relation.relname
         WHEN 'realtime_reaper_tenant_schedule' THEN 2
         WHEN 'realtime_reaper_directory_cursor' THEN 4
       END
       AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) <> 2 THEN
    RAISE EXCEPTION 'Realtime reaper schedule/cursor FORCE RLS missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('realtime_reaper_tenant_schedule', 1, 'companyId', 'text', TRUE, NULL::TEXT),
        ('realtime_reaper_tenant_schedule', 2, 'oldestAdmissionAt',
         'timestamp with time zone', FALSE, NULL::TEXT),
        ('realtime_reaper_tenant_schedule', 3, 'nextLeaseDueAt',
         'timestamp with time zone', FALSE, NULL::TEXT),
        ('realtime_reaper_tenant_schedule', 4, 'revision', 'bigint', TRUE, '0'),
        ('realtime_reaper_directory_cursor', 1, 'singleton', 'boolean', TRUE, 'true'),
        ('realtime_reaper_directory_cursor', 2, 'afterAdmissionCompanyId',
         'text', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 3, 'cycleUpperAdmissionCompanyId',
         'text', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 4, 'cycleAdmissionCutoffAt',
         'timestamp with time zone', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 5, 'afterLeaseCompanyId',
         'text', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 6, 'cycleUpperLeaseCompanyId',
         'text', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 7, 'cycleLeaseCutoffAt',
         'timestamp with time zone', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 8, 'preferLease', 'boolean', TRUE, 'true'),
        ('realtime_reaper_directory_cursor', 9, 'pendingCompanyIds',
         'text[]', TRUE, 'ARRAY[]::text[]'),
        ('realtime_reaper_directory_cursor', 10, 'pendingAfterAdmissionCompanyId',
         'text', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 11, 'pendingAfterLeaseCompanyId',
         'text', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 12, 'pendingAdmissionHasMore',
         'boolean', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 13, 'pendingLeaseHasMore',
         'boolean', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 14, 'pendingPreferLease',
         'boolean', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 15, 'claimId', 'uuid', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 16, 'claimExpiresAt',
         'timestamp with time zone', FALSE, NULL::TEXT),
        ('realtime_reaper_directory_cursor', 17, 'revision', 'bigint', TRUE, '0')
      ) AS expected(
        table_name, attribute_number, attribute_name, data_type, is_not_null, default_expression
      )
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         LEFT JOIN pg_catalog.pg_attrdef AS default_value
           ON default_value.adrelid = attribute.attrelid
          AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('public.%I', expected.table_name)
              )
          AND attribute.attnum = expected.attribute_number
          AND NOT attribute.attisdropped
          AND attribute.attname = expected.attribute_name
          AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) =
              expected.data_type
          AND attribute.attcollation = CASE
                WHEN expected.data_type IN ('text', 'text[]')
                  THEN 'pg_catalog."default"'::regcollation
                ELSE 0
              END
          AND attribute.attstorage = CASE
                WHEN expected.data_type IN ('text', 'text[]') THEN 'x'::"char"
                ELSE 'p'::"char"
              END
          AND attribute.attcompression = ''::"char"
          AND attribute.attnotnull = expected.is_not_null
          AND pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
              IS NOT DISTINCT FROM expected.default_expression
          AND attribute.attidentity = '' AND attribute.attgenerated = ''
          AND attribute.attacl IS NULL
     )
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
  ) <> 4 OR (
    SELECT count(*) FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.realtime_reaper_directory_cursor'::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
  ) <> 17 THEN
    RAISE EXCEPTION 'Realtime reaper schedule/cursor schema drift';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = 'public.realtime_reaper_directory_cursor'::regclass
  ) <> 2 OR EXISTS (
    SELECT 1
      FROM (VALUES
        ('realtime_reaper_directory_cursor_select', 'r',
         'fd331cc3a5abedf571ad790ace00cdba', NULL::TEXT),
        ('realtime_reaper_directory_cursor_update', 'w',
         'fd331cc3a5abedf571ad790ace00cdba', 'fd331cc3a5abedf571ad790ace00cdba')
      ) AS expected(policy_name, policy_command, qual_md5, with_check_md5)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = 'public.realtime_reaper_directory_cursor'::regclass
          AND policy.polname = expected.policy_name
          AND policy.polcmd = expected.policy_command
          AND policy.polpermissive
          AND policy.polroles = ARRAY[0]::OID[]
          AND pg_catalog.md5(
                pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
              ) IS NOT DISTINCT FROM expected.qual_md5
          AND pg_catalog.md5(
                pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
              ) IS NOT DISTINCT FROM expected.with_check_md5
     )
  ) THEN
    RAISE EXCEPTION 'Realtime reaper cursor policy drift';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = 'public.realtime_reaper_tenant_schedule'::regclass
  ) <> 5 OR EXISTS (
    SELECT 1
      FROM (VALUES
        ('realtime_reaper_tenant_schedule_authority', '*',
         '9ead0fd2078ea6f3b7359f14fc5454eb', '9ead0fd2078ea6f3b7359f14fc5454eb'),
        ('realtime_reaper_tenant_schedule_tenant_select', 'r',
         '0785a471ff387a729d251ca7d1c5dcee', NULL::TEXT),
        ('realtime_reaper_tenant_schedule_tenant_insert', 'a',
         NULL::TEXT, '0785a471ff387a729d251ca7d1c5dcee'),
        ('realtime_reaper_tenant_schedule_tenant_update', 'w',
         '0785a471ff387a729d251ca7d1c5dcee', '0785a471ff387a729d251ca7d1c5dcee'),
        ('realtime_reaper_tenant_schedule_tenant_delete', 'd',
         '0785a471ff387a729d251ca7d1c5dcee', NULL::TEXT)
      ) AS expected(policy_name, policy_command, qual_md5, with_check_md5)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = 'public.realtime_reaper_tenant_schedule'::regclass
          AND policy.polname = expected.policy_name
          AND policy.polcmd = expected.policy_command
          AND policy.polpermissive
          AND policy.polroles = ARRAY[0]::OID[]
          AND pg_catalog.md5(
                pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
              ) IS NOT DISTINCT FROM expected.qual_md5
          AND pg_catalog.md5(
                pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
              ) IS NOT DISTINCT FROM expected.with_check_md5
     )
  ) THEN
    RAISE EXCEPTION 'Realtime reaper schedule policy drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.list_realtime_reaper_tenants_v1(integer,uuid)'::regprocedure,
         '7586a250e42047213cf32866604bb239',
         'TABLE("companyId" text, "hasMore" boolean, "claimId" uuid)', TRUE),
        ('public.ack_realtime_reaper_tenants_v1(uuid)'::regprocedure,
         '68a6cb5e563bcfa3dce58581e756f1d8', 'boolean', FALSE),
        ('public.renew_realtime_reaper_tenants_claim_v1(uuid)'::regprocedure,
         '039378c926eb3f969e69a45eda2e31eb', 'boolean', FALSE),
        ('public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure,
         '5976fa53e22b8b131655cbcda637d49c', 'trigger', FALSE)
      ) AS expected(function_oid, body_md5, result_type, returns_set)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function
         JOIN pg_catalog.pg_language AS language ON language.oid = function.prolang
        WHERE function.oid = expected.function_oid
          AND function.proowner = 'bob_realtime_reaper_directory'::regrole
          AND function.prosecdef
          AND function.proconfig IS NOT DISTINCT FROM ARRAY[
            'search_path=pg_catalog', 'row_security=on', 'statement_timeout=4s',
            'lock_timeout=1s'
          ]::TEXT[]
          AND function.provolatile = 'v'
          AND function.proparallel = 'u'
          AND function.prokind = 'f' AND NOT function.proleakproof
          AND NOT function.proisstrict AND function.pronargdefaults = 0
          AND function.proretset = expected.returns_set
          AND language.lanname = 'plpgsql'
          AND pg_catalog.md5(function.prosrc) = expected.body_md5
          AND pg_catalog.pg_get_function_result(function.oid) = expected.result_type
     )
  ) THEN
    RAISE EXCEPTION 'Realtime reaper function authority or body drift';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid IN (
       'public.list_realtime_reaper_tenants_v1(integer,uuid)'::regprocedure,
       'public.ack_realtime_reaper_tenants_v1(uuid)'::regprocedure,
       'public.renew_realtime_reaper_tenants_claim_v1(uuid)'::regprocedure
     )
       AND privilege.privilege_type = 'EXECUTE'
       AND NOT privilege.is_grantable
       AND privilege.grantor = function.proowner
       AND privilege.grantee IN (function.proowner, pg_catalog.to_regrole(app_role_name))
  ) <> 6 OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid IN (
       'public.list_realtime_reaper_tenants_v1(integer,uuid)'::regprocedure,
       'public.ack_realtime_reaper_tenants_v1(uuid)'::regprocedure,
       'public.renew_realtime_reaper_tenants_claim_v1(uuid)'::regprocedure
     )
       AND (
         privilege.privilege_type <> 'EXECUTE' OR privilege.is_grantable
         OR privilege.grantor <> function.proowner
         OR privilege.grantee NOT IN (function.proowner, pg_catalog.to_regrole(app_role_name))
       )
  ) THEN
    RAISE EXCEPTION 'Realtime reaper RPC ACL drift';
  END IF;
  IF (
    SELECT count(*)
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid = 'public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure
       AND privilege.privilege_type = 'EXECUTE'
       AND NOT privilege.is_grantable
       AND privilege.grantor = function.proowner
       AND privilege.grantee = function.proowner
  ) <> 1 OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid = 'public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure
       AND (privilege.privilege_type <> 'EXECUTE' OR privilege.is_grantable
            OR privilege.grantor <> function.proowner
            OR privilege.grantee <> function.proowner)
  ) THEN
    RAISE EXCEPTION 'Realtime reaper schedule trigger function ACL drift';
  END IF;

  IF pg_catalog.has_table_privilege(
       app_role_name, 'public.realtime_reaper_directory_cursor',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'Realtime reaper cursor leaked to runtime';
  END IF;
  FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'UPDATE']::TEXT[] LOOP
    IF NOT pg_catalog.has_table_privilege(
         'bob_realtime_reaper_directory', 'public.realtime_reaper_directory_cursor',
         privilege_name
       ) THEN
      RAISE EXCEPTION 'Realtime reaper cursor required ACL missing: %', privilege_name;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege(
       'bob_realtime_reaper_directory', 'public.realtime_reaper_directory_cursor',
       'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) OR (
    SELECT count(*)
      FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS privilege
     WHERE relation.oid = 'public.realtime_reaper_directory_cursor'::regclass
       AND privilege.grantee <> relation.relowner
  ) <> 2 OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS privilege
     WHERE relation.oid = 'public.realtime_reaper_directory_cursor'::regclass
       AND privilege.grantee <> relation.relowner
       AND (
         privilege.grantee <> 'bob_realtime_reaper_directory'::regrole
         OR privilege.privilege_type NOT IN ('SELECT', 'UPDATE')
         OR privilege.grantor <> relation.relowner
         OR privilege.is_grantable
       )
  ) THEN
    RAISE EXCEPTION 'Realtime reaper cursor directory ACL drift';
  END IF;

  FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::TEXT[] LOOP
    IF NOT pg_catalog.has_table_privilege(
         'bob_realtime_reaper_directory', 'public.realtime_reaper_tenant_schedule',
         privilege_name
       ) OR NOT pg_catalog.has_table_privilege(
         app_role_name, 'public.realtime_reaper_tenant_schedule', privilege_name
       ) THEN
      RAISE EXCEPTION 'Realtime reaper schedule required ACL missing: %', privilege_name;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege(
       'bob_realtime_reaper_directory', 'public.realtime_reaper_tenant_schedule',
       'TRUNCATE,REFERENCES,TRIGGER'
     ) OR pg_catalog.has_table_privilege(
       app_role_name, 'public.realtime_reaper_tenant_schedule',
       'TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'Realtime reaper schedule excessive ACL';
  END IF;
  IF (
    SELECT count(*)
      FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS privilege
     WHERE relation.oid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND privilege.grantee <> relation.relowner
  ) <> 8 OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS privilege
     WHERE relation.oid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND privilege.grantee <> relation.relowner
       AND (
         privilege.grantee NOT IN (
           'bob_realtime_reaper_directory'::regrole,
           pg_catalog.to_regrole(app_role_name)
         )
         OR privilege.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
         OR privilege.grantor <> relation.relowner
         OR privilege.is_grantable
       )
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Realtime reaper schedule exact ACL drift';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'realtime_admission_events',
    'realtime_admission_cancellation_fences',
    'realtime_session_leases',
    'realtime_mistral_conversation_bootstrap_tickets',
    'realtime_mistral_conversation_missions'
  ]::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(
         'bob_realtime_reaper_directory',
         pg_catalog.format('public.%I', relation_name),
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = pg_catalog.to_regclass(
               pg_catalog.format('public.%I', relation_name)
             )
         AND attribute.attnum > 0 AND NOT attribute.attisdropped
         AND pg_catalog.has_column_privilege(
           'bob_realtime_reaper_directory', attribute.attrelid, attribute.attnum,
           'SELECT,INSERT,UPDATE,REFERENCES'
         )
    ) OR EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
       ) AS privilege
       WHERE relation.oid = pg_catalog.to_regclass(
               pg_catalog.format('public.%I', relation_name)
             )
         AND privilege.grantee IN (0, 'bob_realtime_reaper_directory'::regrole)
         AND privilege.privilege_type = 'MAINTAIN'
    ) THEN
      RAISE EXCEPTION 'Realtime reaper directory leaked source access: %', relation_name;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger
     WHERE trigger.tgrelid IN (
       'public.realtime_reaper_tenant_schedule'::regclass,
       'public.realtime_reaper_directory_cursor'::regclass
     )
       AND NOT trigger.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Realtime reaper authority table has an unexpected user trigger';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid IN (
       'public.realtime_admission_events'::regclass,
       'public.realtime_session_leases'::regclass
     )
       AND policy.polname IN (
         'realtime_admission_event_reaper_directory_select',
         'realtime_admission_event_reaper_schedule_select',
         'realtime_session_lease_reaper_directory_select',
         'realtime_session_lease_reaper_schedule_select'
       )
  ) THEN
    RAISE EXCEPTION 'Realtime reaper obsolete source policy remains';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_trigger AS trigger
     WHERE trigger.tgfoid =
             'public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure
       AND NOT trigger.tgisinternal
  ) <> 6 OR EXISTS (
    SELECT 1
      FROM (VALUES
        ('realtime_admission_events', 'realtime_admission_event_reaper_schedule_insert',
         4, NULL::TEXT, 'new_rows', '3d8c548c2eb7f5b3149f61e6e685315f'),
        ('realtime_admission_events', 'realtime_admission_event_reaper_schedule_update',
         16, 'old_rows', 'new_rows', '29583e5e06773701af73527f89758d94'),
        ('realtime_admission_events', 'realtime_admission_event_reaper_schedule_delete',
         8, 'old_rows', NULL::TEXT, 'e01848d082a9a8f2773442a72f567bf6'),
        ('realtime_session_leases', 'realtime_session_lease_reaper_schedule_insert',
         4, NULL::TEXT, 'new_rows', 'e52a31cba1822866ea7ec8742507ac2b'),
        ('realtime_session_leases', 'realtime_session_lease_reaper_schedule_update',
         16, 'old_rows', 'new_rows', 'a58c30465ca126deaf026af2dfc97373'),
        ('realtime_session_leases', 'realtime_session_lease_reaper_schedule_delete',
         8, 'old_rows', NULL::TEXT, '21194ede343ec279f8964d5a9d744411')
      ) AS expected(
        table_name, trigger_name, trigger_type, old_table, new_table, definition_md5
      )
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger AS trigger
        WHERE trigger.tgrelid = pg_catalog.to_regclass(
                pg_catalog.format('public.%I', expected.table_name)
              )
          AND trigger.tgname = expected.trigger_name
          AND trigger.tgtype = expected.trigger_type
          AND trigger.tgfoid =
              'public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure
          AND trigger.tgenabled = 'O' AND NOT trigger.tgisinternal
          AND trigger.tgoldtable IS NOT DISTINCT FROM expected.old_table
          AND trigger.tgnewtable IS NOT DISTINCT FROM expected.new_table
          AND trigger.tgnargs = 0 AND pg_catalog.octet_length(trigger.tgargs) = 0
          AND trigger.tgqual IS NULL AND trigger.tgattr = ''::int2vector
          AND trigger.tgconstraint = 0 AND trigger.tgconstrrelid = 0
          AND trigger.tgconstrindid = 0 AND NOT trigger.tgdeferrable
          AND NOT trigger.tginitdeferred AND trigger.tgparentid = 0
          AND pg_catalog.md5(pg_catalog.pg_get_triggerdef(trigger.oid, TRUE)) =
              expected.definition_md5
     )
  ) THEN
    RAISE EXCEPTION 'Realtime reaper schedule trigger inventory drift';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_index AS index
     WHERE index.indexrelid IN (
       'public.realtime_reaper_schedule_admission_due_idx'::regclass,
       'public.realtime_reaper_schedule_lease_due_idx'::regclass
     )
       AND index.indrelid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND index.indisvalid AND index.indisready AND index.indislive
       AND NOT index.indisunique AND NOT index.indcheckxmin
       AND index.indnkeyatts = 2 AND index.indnatts = 2
       AND index.indpred IS NOT NULL
  ) <> 2 OR pg_catalog.regexp_replace(
    pg_catalog.pg_get_indexdef('public.realtime_reaper_schedule_admission_due_idx'::regclass),
    '\s+', '', 'g'
  ) IS DISTINCT FROM pg_catalog.regexp_replace(
    $index$CREATE INDEX realtime_reaper_schedule_admission_due_idx ON public.realtime_reaper_tenant_schedule USING btree ("companyId", "oldestAdmissionAt") WHERE ("oldestAdmissionAt" IS NOT NULL)$index$,
    '\s+', '', 'g'
  ) OR pg_catalog.regexp_replace(
    pg_catalog.pg_get_indexdef('public.realtime_reaper_schedule_lease_due_idx'::regclass),
    '\s+', '', 'g'
  ) IS DISTINCT FROM pg_catalog.regexp_replace(
    $index$CREATE INDEX realtime_reaper_schedule_lease_due_idx ON public.realtime_reaper_tenant_schedule USING btree ("companyId", "nextLeaseDueAt") WHERE ("nextLeaseDueAt" IS NOT NULL)$index$,
    '\s+', '', 'g'
  ) OR pg_catalog.regexp_replace(
    pg_catalog.pg_get_indexdef('public.realtime_reaper_tenant_schedule_pkey'::regclass),
    '\s+', '', 'g'
  ) IS DISTINCT FROM pg_catalog.regexp_replace(
    $index$CREATE UNIQUE INDEX realtime_reaper_tenant_schedule_pkey ON public.realtime_reaper_tenant_schedule USING btree ("companyId")$index$,
    '\s+', '', 'g'
  ) OR pg_catalog.regexp_replace(
    pg_catalog.pg_get_indexdef('public.realtime_reaper_directory_cursor_pkey'::regclass),
    '\s+', '', 'g'
  ) IS DISTINCT FROM pg_catalog.regexp_replace(
    $index$CREATE UNIQUE INDEX realtime_reaper_directory_cursor_pkey ON public.realtime_reaper_directory_cursor USING btree (singleton)$index$,
    '\s+', '', 'g'
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_index AS index
     WHERE index.indrelid = 'public.realtime_reaper_tenant_schedule'::regclass
  ) <> 3 OR (
    SELECT count(*) FROM pg_catalog.pg_index AS index
     WHERE index.indrelid = 'public.realtime_reaper_directory_cursor'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'Realtime reaper schedule index drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND constraint_row.conname = 'realtime_reaper_tenant_schedule_pkey'
       AND constraint_row.contype = 'p' AND constraint_row.convalidated
       AND pg_catalog.pg_get_constraintdef(constraint_row.oid) = 'PRIMARY KEY ("companyId")'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND constraint_row.conname = 'realtime_reaper_tenant_schedule_due_check'
       AND constraint_row.contype = 'c' AND constraint_row.convalidated
       AND constraint_row.conkey = ARRAY[2, 3]::SMALLINT[]
       AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_row.oid)) =
           'c3163eba95a28ec9464fb6cbc85e2dde'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND constraint_row.conname = 'realtime_reaper_tenant_schedule_company_fkey'
       AND constraint_row.contype = 'f' AND constraint_row.convalidated
       AND constraint_row.confrelid = 'public.companies'::regclass
       AND constraint_row.conkey = ARRAY[1]::SMALLINT[]
       AND constraint_row.confkey = ARRAY[1]::SMALLINT[]
       AND constraint_row.confupdtype = 'c' AND constraint_row.confdeltype = 'c'
       AND constraint_row.confmatchtype = 's'
       AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
       AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_row.oid)) =
           '4492a1f280bbd7c5ae45b6cc8a9b5eaa'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.realtime_reaper_tenant_schedule'::regclass
       AND constraint_row.conname = 'realtime_reaper_tenant_schedule_revision_check'
       AND constraint_row.contype = 'c' AND constraint_row.convalidated
       AND pg_catalog.pg_get_constraintdef(constraint_row.oid) = 'CHECK ((revision >= 0))'
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.realtime_reaper_tenant_schedule'::regclass
  ) <> 4 THEN
    RAISE EXCEPTION 'Realtime reaper schedule constraint drift';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.realtime_reaper_tenant_schedule AS schedule
     WHERE schedule.revision < 0
        OR (schedule."oldestAdmissionAt" IS NULL AND schedule."nextLeaseDueAt" IS NULL)
  ) THEN
    RAISE EXCEPTION 'Realtime reaper schedule state drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('realtime_reaper_directory_claim_check',
         '6764942f9e0779a3828c83572a018bfe'),
        ('realtime_reaper_directory_cursor_check',
         'd11e459ae18d0e07f05204e89b6edc47'),
        ('realtime_reaper_directory_revision_check',
         'f02ee38442083518cf544f73183f7d08'),
        ('realtime_reaper_directory_singleton_check',
         'ae6f6dfbe38290d5bfa8f3e96d1aff91')
      ) AS expected(constraint_name, definition_md5)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.realtime_reaper_directory_cursor'::regclass
          AND constraint_row.conname = expected.constraint_name
          AND constraint_row.contype = 'c' AND constraint_row.convalidated
          AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_row.oid)) =
              expected.definition_md5
     )
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.realtime_reaper_directory_cursor'::regclass
       AND constraint_row.conname = 'realtime_reaper_directory_cursor_pkey'
       AND constraint_row.contype = 'p' AND constraint_row.convalidated
       AND constraint_row.conkey = ARRAY[1]::SMALLINT[]
       AND pg_catalog.pg_get_constraintdef(constraint_row.oid) = 'PRIMARY KEY (singleton)'
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.realtime_reaper_directory_cursor'::regclass
  ) <> 5 THEN
    RAISE EXCEPTION 'Realtime reaper cursor constraint drift';
  END IF;
  IF (SELECT count(*) FROM public.realtime_reaper_directory_cursor) <> 1 OR EXISTS (
    SELECT 1 FROM public.realtime_reaper_directory_cursor AS cursor
     WHERE NOT cursor.singleton OR cursor.revision < 0
       OR ((cursor."claimId" IS NULL) <> (cursor."claimExpiresAt" IS NULL))
       OR ((cursor."claimId" IS NULL) <> (cursor."pendingPreferLease" IS NULL))
       OR ((cursor."claimId" IS NULL) <>
           (cardinality(cursor."pendingCompanyIds") = 0))
  ) THEN
    RAISE EXCEPTION 'Realtime reaper cursor state drift';
  END IF;

  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL AND (
      pg_catalog.has_table_privilege(
        exposed_role, 'public.realtime_reaper_tenant_schedule',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) OR pg_catalog.has_table_privilege(
        exposed_role, 'public.realtime_reaper_directory_cursor',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) OR pg_catalog.has_table_privilege(
        exposed_role, 'public.realtime_admission_cancellation_fences',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) OR EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'public.list_realtime_reaper_tenants_v1(integer,uuid)'::regprocedure::oid,
          'public.ack_realtime_reaper_tenants_v1(uuid)'::regprocedure::oid,
          'public.renew_realtime_reaper_tenants_claim_v1(uuid)'::regprocedure::oid,
          'public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure::oid,
          'public.sync_realtime_admission_cancellation_schedule_v1()'::regprocedure::oid
        ]) AS candidate(oid)
         WHERE pg_catalog.has_function_privilege(exposed_role, candidate.oid, 'EXECUTE')
      )
    ) THEN
      RAISE EXCEPTION 'Exposed role can access realtime reaper authority: %', exposed_role;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
