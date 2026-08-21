\set ON_ERROR_STOP on

-- Jarvis U1-l — certificat live, metadata-only. Aucune fixture ni mutation de curseur/source.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '4s';
SET LOCAL lock_timeout = '1s';
SELECT pg_catalog.set_config('bob.jarvis_dispatch_release_app_role', :'app_role', true);
SET LOCAL ROLE bob_jarvis_dispatch_directory;

DO $bob_jarvis_dispatch_release_certificate$
DECLARE
  app_role_name TEXT := NULLIF(
    pg_catalog.current_setting('bob.jarvis_dispatch_release_app_role', true),
    ''
  );
  authority pg_catalog.pg_roles%ROWTYPE;
  expected_source_columns CONSTANT TEXT[] := ARRAY[
    'companyId',
    'ownerUserId',
    'runId',
    'status',
    'nextAttemptAt',
    'leaseExpiresAt',
    'authorizedAt',
    'authorizationDigest',
    'resultDigest',
    'signalAppliedAt',
    'updatedAt'
  ];
  expected_functions CONSTANT pg_catalog.regprocedure[] := ARRAY[
    'public.list_jarvis_dispatch_coordinates_v1(text,integer)'::pg_catalog.regprocedure,
    'public.claim_jarvis_dispatch_coordinates_v2(text,integer,uuid)'::pg_catalog.regprocedure,
    'public.renew_jarvis_dispatch_coordinates_claim_v2(text,uuid)'::pg_catalog.regprocedure,
    'public.start_jarvis_dispatch_coordinate_v2(text,uuid,integer)'::pg_catalog.regprocedure,
    'public.ack_jarvis_dispatch_coordinates_v2(text,uuid)'::pg_catalog.regprocedure
  ];
  expected_function_names CONSTANT TEXT[] := ARRAY[
    'list_jarvis_dispatch_coordinates_v1',
    'claim_jarvis_dispatch_coordinates_v2',
    'renew_jarvis_dispatch_coordinates_claim_v2',
    'start_jarvis_dispatch_coordinate_v2',
    'ack_jarvis_dispatch_coordinates_v2'
  ];
  attribute_row RECORD;
  function_oid pg_catalog.regprocedure;
BEGIN
  IF app_role_name IS NULL OR pg_catalog.to_regrole(app_role_name) IS NULL THEN
    RAISE EXCEPTION 'Jarvis dispatch release requires an existing runtime app role';
  END IF;

  SELECT * INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_jarvis_dispatch_directory';
  IF authority.rolcanlogin OR authority.rolsuper OR authority.rolcreatedb
     OR authority.rolcreaterole OR authority.rolinherit OR authority.rolreplication
     OR authority.rolbypassrls THEN
    RAISE EXCEPTION 'Jarvis dispatch directory role privilege drift';
  END IF;
  IF pg_catalog.pg_has_role(app_role_name, authority.oid, 'MEMBER')
     OR pg_catalog.pg_has_role(app_role_name, authority.oid, 'SET') THEN
    RAISE EXCEPTION 'Runtime can inherit or SET ROLE to Jarvis dispatch directory';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = authority.oid
       AND membership.member <> pg_catalog.to_regrole(session_user)
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = authority.oid
       AND membership.member = pg_catalog.to_regrole(session_user)
       AND membership.set_option
       AND NOT membership.inherit_option
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = authority.oid
       AND membership.inherit_option
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = authority.oid
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch directory membership drift';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(authority.oid, 'public', 'USAGE')
     OR pg_catalog.has_schema_privilege(authority.oid, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Jarvis dispatch directory schema ACL drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS cursor
      JOIN pg_catalog.pg_class AS source
        ON source.oid = 'public.jarvis_work_items'::pg_catalog.regclass
     WHERE cursor.oid = 'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
       AND cursor.relkind = 'r'
       AND cursor.relpersistence = 'p'
       AND cursor.relowner = source.relowner
       AND cursor.relnatts = 16
       AND cursor.relchecks = 4
       AND cursor.relrowsecurity
       AND cursor.relforcerowsecurity
       AND NOT cursor.relispartition
       AND cursor.relpartbound IS NULL
       AND NOT cursor.relhasrules
       AND NOT cursor.relhassubclass
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch cursor table metadata drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        (1, 'companyId', 'text', TRUE, NULL::TEXT, 'pg_catalog."default"'),
        (2, 'afterOwnerUserId', 'text', FALSE, NULL::TEXT, 'pg_catalog."C"'),
        (3, 'afterRunId', 'uuid', FALSE, NULL::TEXT, NULL::TEXT),
        (4, 'cycleUpperOwnerUserId', 'text', FALSE, NULL::TEXT, 'pg_catalog."C"'),
        (5, 'cycleUpperRunId', 'uuid', FALSE, NULL::TEXT, NULL::TEXT),
        (6, 'cycleCutoffAt', 'timestamp with time zone', FALSE, NULL::TEXT, NULL::TEXT),
        (7, 'pendingOwnerUserIds', 'text[]', TRUE, 'ARRAY[]::text[]', 'pg_catalog."C"'),
        (8, 'pendingRunIds', 'uuid[]', TRUE, 'ARRAY[]::uuid[]', NULL::TEXT),
        (9, 'pendingAfterOwnerUserId', 'text', FALSE, NULL::TEXT, 'pg_catalog."C"'),
        (10, 'pendingAfterRunId', 'uuid', FALSE, NULL::TEXT, NULL::TEXT),
        (11, 'pendingHasMore', 'boolean', FALSE, NULL::TEXT, NULL::TEXT),
        (12, 'pendingNextPosition', 'integer', FALSE, NULL::TEXT, NULL::TEXT),
        (13, 'claimId', 'uuid', FALSE, NULL::TEXT, NULL::TEXT),
        (14, 'claimExpiresAt', 'timestamp with time zone', FALSE, NULL::TEXT, NULL::TEXT),
        (15, 'claimHardExpiresAt', 'timestamp with time zone', FALSE, NULL::TEXT, NULL::TEXT),
        (16, 'revision', 'bigint', TRUE, '0', NULL::TEXT)
      ) AS expected(
        attribute_number,
        attribute_name,
        data_type,
        is_not_null,
        default_expression,
        collation_name
      )
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         LEFT JOIN pg_catalog.pg_attrdef AS default_value
           ON default_value.adrelid = attribute.attrelid
          AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid =
              'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
          AND attribute.attnum = expected.attribute_number
          AND NOT attribute.attisdropped
          AND attribute.attname = expected.attribute_name
          AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) =
              expected.data_type
          AND attribute.attnotnull = expected.is_not_null
          AND pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
              IS NOT DISTINCT FROM expected.default_expression
          AND CASE
                WHEN expected.collation_name IS NULL THEN attribute.attcollation = 0
                ELSE attribute.attcollation = expected.collation_name::pg_catalog.regcollation
              END
          AND attribute.attidentity = ''
          AND attribute.attgenerated = ''
     )
  ) OR (
    SELECT count(*)
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  ) <> 16 THEN
    RAISE EXCEPTION 'Jarvis dispatch cursor column drift';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_catalog.pg_constraint AS constraint_catalog
     WHERE constraint_catalog.conrelid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
       AND constraint_catalog.convalidated
       AND constraint_catalog.conname IN (
         'jarvis_dispatch_directory_cursors_pkey',
         'jarvis_dispatch_directory_cursors_companyId_fkey',
         'jarvis_dispatch_directory_cursors_arrays_check',
         'jarvis_dispatch_directory_cursors_tuples_check',
         'jarvis_dispatch_directory_cursors_pending_check',
         'jarvis_dispatch_directory_cursors_revision_check'
       )
  ) <> 6 OR (
    SELECT count(*)
      FROM pg_catalog.pg_constraint AS constraint_catalog
     WHERE constraint_catalog.conrelid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
  ) <> 6 OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS foreign_key
     WHERE foreign_key.conrelid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
       AND foreign_key.conname = 'jarvis_dispatch_directory_cursors_companyId_fkey'
       AND foreign_key.contype = 'f'
       AND foreign_key.confrelid = 'public.companies'::pg_catalog.regclass
       AND foreign_key.confupdtype = 'c'
       AND foreign_key.confdeltype = 'c'
  ) OR EXISTS (
    SELECT expected.constraint_name
      FROM (VALUES
        ('jarvis_dispatch_directory_cursors_arrays_check', '0ff65e8202f56bc2950690fc0956e4e8'),
        ('jarvis_dispatch_directory_cursors_companyId_fkey', '4492a1f280bbd7c5ae45b6cc8a9b5eaa'),
        ('jarvis_dispatch_directory_cursors_pending_check', 'a8e81e5b838a98881d66b991f444958b'),
        ('jarvis_dispatch_directory_cursors_pkey', '8a690960af1ae65a3a48773aed102864'),
        ('jarvis_dispatch_directory_cursors_revision_check', 'f02ee38442083518cf544f73183f7d08'),
        ('jarvis_dispatch_directory_cursors_tuples_check', 'ed2455c90765b40023650b3c332cd381')
      ) AS expected(constraint_name, definition_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_catalog
        WHERE constraint_catalog.conrelid =
              'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
          AND constraint_catalog.conname = expected.constraint_name
          AND constraint_catalog.convalidated
          AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_catalog.oid)) =
              expected.definition_md5
     )
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch cursor constraint drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_catalog
     WHERE trigger_catalog.tgrelid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
       AND NOT trigger_catalog.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch cursor user-trigger drift';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
       AND policy.polpermissive
       AND policy.polroles = ARRAY[0]::OID[]
       AND policy.polname IN (
         'jarvis_dispatch_directory_cursors_select',
         'jarvis_dispatch_directory_cursors_insert',
         'jarvis_dispatch_directory_cursors_update'
       )
       AND policy.polcmd = CASE policy.polname
         WHEN 'jarvis_dispatch_directory_cursors_select' THEN 'r'::"char"
         WHEN 'jarvis_dispatch_directory_cursors_insert' THEN 'a'::"char"
         ELSE 'w'::"char"
       END
       AND COALESCE(
             pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
             pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
           ) = '(CURRENT_USER = ''bob_jarvis_dispatch_directory''::name)'
       AND (
         policy.polname <> 'jarvis_dispatch_directory_cursors_update'
         OR pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) =
            '(CURRENT_USER = ''bob_jarvis_dispatch_directory''::name)'
       )
  ) <> 3 OR (
    SELECT count(*)
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
  ) <> 3 OR EXISTS (
    SELECT expected.policy_name
      FROM (VALUES
        ('jarvis_dispatch_directory_cursors_insert', '4b942d6eca3a2378f0c7a9018710ec26'),
        ('jarvis_dispatch_directory_cursors_select', '999dc5f2f8e19305f785e3b4ae08e5b9'),
        ('jarvis_dispatch_directory_cursors_update', '38eeae820541139260e90618e8c9d81f')
      ) AS expected(policy_name, definition_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
              'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
          AND policy.polname = expected.policy_name
          AND pg_catalog.md5(
                pg_catalog.concat_ws(
                  '|',
                  policy.polpermissive::TEXT,
                  policy.polcmd::TEXT,
                  policy.polroles::TEXT,
                  pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
                  pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
                )
              ) = expected.definition_md5
     )
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch cursor policy drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS source
     WHERE source.oid = 'public.jarvis_work_items'::pg_catalog.regclass
       AND source.relrowsecurity
       AND source.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = 'public.jarvis_work_items'::pg_catalog.regclass
       AND policy.polname = 'jarvis_work_items_dispatch_directory_select'
       AND policy.polpermissive
       AND policy.polcmd = 'r'
       AND policy.polroles = ARRAY[0]::OID[]
       AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) IS NULL
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) LIKE
           '%CURRENT_USER = ''bob_jarvis_dispatch_directory''::name%'
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) LIKE
           '%status = ''authorized''::text%'
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) LIKE
           '%"resultDigest" IS NULL%'
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) LIKE
           '%"leaseExpiresAt" < statement_timestamp()%'
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) LIKE
           '%"signalAppliedAt" IS NULL%'
       AND pg_catalog.md5(
             pg_catalog.concat_ws(
               '|',
               policy.polpermissive::TEXT,
               policy.polcmd::TEXT,
               policy.polroles::TEXT,
               pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
               pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
             )
           ) = 'a9a49daab0757150f3673d68095b9f89'
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch source policy drift: %', (
      SELECT pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
        FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = 'public.jarvis_work_items'::pg_catalog.regclass
         AND policy.polname = 'jarvis_work_items_dispatch_directory_select'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS index_catalog
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_catalog.indexrelid
     WHERE index_catalog.indrelid = 'public.jarvis_work_items'::pg_catalog.regclass
       AND index_relation.relname = 'jarvis_work_items_dispatch_directory_keyset_idx'
       AND index_catalog.indisvalid
       AND index_catalog.indisready
       AND index_catalog.indislive
       AND NOT index_catalog.indisunique
       AND index_catalog.indnkeyatts = 3
       AND index_catalog.indnatts = 3
       AND index_catalog.indpred IS NOT NULL
       AND pg_catalog.md5(pg_catalog.pg_get_indexdef(index_catalog.indexrelid)) =
           'c62039877f001aec4b2df6b8b8394a81'
       AND pg_catalog.pg_get_indexdef(index_catalog.indexrelid, 1, false) = '"companyId"'
       AND pg_catalog.pg_get_indexdef(index_catalog.indexrelid, 2, false) =
           '"ownerUserId"'
       AND index_catalog.indcollation[1] = 'pg_catalog."C"'::pg_catalog.regcollation
       AND pg_catalog.pg_get_indexdef(index_catalog.indexrelid, 3, false) = '"runId"'
       AND pg_catalog.pg_get_expr(
             index_catalog.indpred,
             index_catalog.indrelid
           ) LIKE '%(status = ''authorized''::text)%'
       AND pg_catalog.pg_get_expr(
             index_catalog.indpred,
             index_catalog.indrelid
           ) LIKE '%("resultDigest" IS NULL)%'
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch keyset index drift: % / % / %',
      (
        SELECT pg_catalog.pg_get_indexdef(index_catalog.indexrelid)
          FROM pg_catalog.pg_index AS index_catalog
          JOIN pg_catalog.pg_class AS index_relation
            ON index_relation.oid = index_catalog.indexrelid
         WHERE index_catalog.indrelid = 'public.jarvis_work_items'::pg_catalog.regclass
           AND index_relation.relname = 'jarvis_work_items_dispatch_directory_keyset_idx'
      ),
      (
        SELECT pg_catalog.pg_get_expr(index_catalog.indpred, index_catalog.indrelid)
          FROM pg_catalog.pg_index AS index_catalog
          JOIN pg_catalog.pg_class AS index_relation
            ON index_relation.oid = index_catalog.indexrelid
         WHERE index_catalog.indrelid = 'public.jarvis_work_items'::pg_catalog.regclass
           AND index_relation.relname = 'jarvis_work_items_dispatch_directory_keyset_idx'
      ),
      (
        SELECT pg_catalog.concat_ws(
          ' | ',
          pg_catalog.pg_get_indexdef(index_catalog.indexrelid, 1, false),
          pg_catalog.pg_get_indexdef(index_catalog.indexrelid, 2, false),
          pg_catalog.pg_get_indexdef(index_catalog.indexrelid, 3, false),
          index_catalog.indnkeyatts::TEXT,
          index_catalog.indnatts::TEXT
        )
          FROM pg_catalog.pg_index AS index_catalog
          JOIN pg_catalog.pg_class AS index_relation
            ON index_relation.oid = index_catalog.indexrelid
         WHERE index_catalog.indrelid = 'public.jarvis_work_items'::pg_catalog.regclass
           AND index_relation.relname = 'jarvis_work_items_dispatch_directory_keyset_idx'
      );
  END IF;

  IF (
    SELECT count(*)
      FROM pg_catalog.pg_proc AS function
      JOIN pg_catalog.pg_language AS language ON language.oid = function.prolang
     WHERE function.oid = ANY(expected_functions)
       AND function.proowner = authority.oid
       AND function.prosecdef
       AND NOT function.proisstrict
       AND function.provolatile = 'v'
       AND function.proparallel = 'u'
       AND NOT function.proleakproof
       AND function.prokind = 'f'
       AND language.lanname = 'plpgsql'
       AND pg_catalog.cardinality(function.proconfig) = 4
       AND function.proconfig @> ARRAY[
         'search_path=pg_catalog',
         'row_security=on',
         'statement_timeout=4s',
         'lock_timeout=1s'
       ]::TEXT[]
  ) <> 5 THEN
    RAISE EXCEPTION 'Jarvis dispatch function owner/config drift';
  END IF;
  IF (
    SELECT count(*)
      FROM pg_catalog.pg_proc AS function
     WHERE function.pronamespace = 'public'::pg_catalog.regnamespace
       AND function.proname = ANY(expected_function_names)
  ) <> 5 OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.pronamespace = 'public'::pg_catalog.regnamespace
       AND function.proname = ANY(expected_function_names)
       AND NOT (function.oid = ANY(expected_functions))
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch function overload inventory drift';
  END IF;
  IF EXISTS (
    SELECT expected.function_oid
      FROM (VALUES
        ('public.ack_jarvis_dispatch_coordinates_v2(text,uuid)'::pg_catalog.regprocedure, '0ee547ae70a6fd3e8d9c97f2a1b76b7c'),
        ('public.claim_jarvis_dispatch_coordinates_v2(text,integer,uuid)'::pg_catalog.regprocedure, '216d56a5d18473e2da4f92d7008035bc'),
        ('public.list_jarvis_dispatch_coordinates_v1(text,integer)'::pg_catalog.regprocedure, 'ab9a39997396b44db23e23a52d7eeaa6'),
        ('public.renew_jarvis_dispatch_coordinates_claim_v2(text,uuid)'::pg_catalog.regprocedure, '7ac2585958e0c4cc3290a59644b865f9'),
        ('public.start_jarvis_dispatch_coordinate_v2(text,uuid,integer)'::pg_catalog.regprocedure, '9f3cb2fb44cf8c2389369efc4e3f4eaa')
      ) AS expected(function_oid, body_md5)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function
        WHERE function.oid = expected.function_oid
          AND pg_catalog.md5(function.prosrc) = expected.body_md5
     )
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch function body drift: %', (
      SELECT pg_catalog.string_agg(
        function.oid::pg_catalog.regprocedure::TEXT || '=' || pg_catalog.md5(function.prosrc),
        ',' ORDER BY function.oid::pg_catalog.regprocedure::TEXT
      )
        FROM pg_catalog.pg_proc AS function
       WHERE function.oid = ANY(expected_functions)
    );
  END IF;
  IF pg_catalog.pg_get_function_result(
       'public.list_jarvis_dispatch_coordinates_v1(text,integer)'::pg_catalog.regprocedure
     ) <> 'TABLE("ownerUserId" text, "runId" text)'
     OR pg_catalog.pg_get_function_result(
       'public.claim_jarvis_dispatch_coordinates_v2(text,integer,uuid)'::pg_catalog.regprocedure
     ) <> 'TABLE(status text, "companyId" text, "claimId" uuid, "position" integer, "pageSize" integer, "ownerUserId" text, "runId" uuid, "hasMore" boolean, replayed boolean, "databaseNow" timestamp with time zone, "claimHardExpiresAt" timestamp with time zone)'
     OR pg_catalog.pg_get_function_result(
       'public.renew_jarvis_dispatch_coordinates_claim_v2(text,uuid)'::pg_catalog.regprocedure
     ) <> 'boolean'
     OR pg_catalog.pg_get_function_result(
       'public.start_jarvis_dispatch_coordinate_v2(text,uuid,integer)'::pg_catalog.regprocedure
     ) <> 'boolean'
     OR pg_catalog.pg_get_function_result(
       'public.ack_jarvis_dispatch_coordinates_v2(text,uuid)'::pg_catalog.regprocedure
     ) <> 'boolean' THEN
    RAISE EXCEPTION 'Jarvis dispatch function result drift: % / % / % / % / %',
      pg_catalog.pg_get_function_result(
        'public.list_jarvis_dispatch_coordinates_v1(text,integer)'::pg_catalog.regprocedure
      ),
      pg_catalog.pg_get_function_result(
        'public.claim_jarvis_dispatch_coordinates_v2(text,integer,uuid)'::pg_catalog.regprocedure
      ),
      pg_catalog.pg_get_function_result(
        'public.renew_jarvis_dispatch_coordinates_claim_v2(text,uuid)'::pg_catalog.regprocedure
      ),
      pg_catalog.pg_get_function_result(
        'public.start_jarvis_dispatch_coordinate_v2(text,uuid,integer)'::pg_catalog.regprocedure
      ),
      pg_catalog.pg_get_function_result(
        'public.ack_jarvis_dispatch_coordinates_v2(text,uuid)'::pg_catalog.regprocedure
      );
  END IF;

  FOREACH function_oid IN ARRAY expected_functions LOOP
    IF NOT pg_catalog.has_function_privilege(app_role_name, function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Runtime lacks Jarvis dispatch EXECUTE on %', function_oid;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
       ) AS privilege
       WHERE function.oid = function_oid
         AND privilege.privilege_type = 'EXECUTE'
         AND (
           privilege.grantee NOT IN (function.proowner, pg_catalog.to_regrole(app_role_name))
           OR (
             privilege.grantee = pg_catalog.to_regrole(app_role_name)
             AND privilege.is_grantable
           )
         )
    ) THEN
      RAISE EXCEPTION 'Jarvis dispatch function EXECUTE allowlist drift on %', function_oid;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
       authority.oid, 'public.jarvis_dispatch_directory_cursors', 'SELECT'
     ) OR NOT pg_catalog.has_table_privilege(
       authority.oid, 'public.jarvis_dispatch_directory_cursors', 'INSERT'
     ) OR NOT pg_catalog.has_table_privilege(
       authority.oid, 'public.jarvis_dispatch_directory_cursors', 'UPDATE'
     ) OR pg_catalog.has_table_privilege(
       authority.oid, 'public.jarvis_dispatch_directory_cursors', 'DELETE'
     ) OR pg_catalog.has_table_privilege(
       authority.oid, 'public.jarvis_dispatch_directory_cursors', 'TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       authority.oid, 'public.jarvis_dispatch_directory_cursors', 'REFERENCES'
     ) OR pg_catalog.has_table_privilege(
       authority.oid, 'public.jarvis_dispatch_directory_cursors', 'TRIGGER'
     ) OR pg_catalog.has_table_privilege(
       app_role_name, 'public.jarvis_dispatch_directory_cursors',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'Jarvis dispatch cursor table ACL drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
     WHERE relation.oid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
       AND (
         privilege.grantee NOT IN (relation.relowner, authority.oid)
         OR (
           privilege.grantee = authority.oid
           AND (
             privilege.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')
             OR privilege.is_grantable
           )
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
     WHERE attribute.attrelid =
           'public.jarvis_dispatch_directory_cursors'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND privilege.grantee <> (
         SELECT relation.relowner
           FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = attribute.attrelid
       )
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch cursor rogue table/column ACL';
  END IF;

  IF pg_catalog.has_table_privilege(
       authority.oid,
       'public.jarvis_work_items',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'Jarvis dispatch authority has a forbidden source table grant';
  END IF;
  FOR attribute_row IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.jarvis_work_items'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege(
         authority.oid,
         'public.jarvis_work_items',
         attribute_row.attname,
         'SELECT'
       ) <> (attribute_row.attname = ANY(expected_source_columns)) THEN
      RAISE EXCEPTION 'Jarvis dispatch source column SELECT drift on %', attribute_row.attname;
    END IF;
    IF pg_catalog.has_column_privilege(
         authority.oid,
         'public.jarvis_work_items',
         attribute_row.attname,
         'INSERT,UPDATE,REFERENCES'
       ) THEN
      RAISE EXCEPTION 'Jarvis dispatch source column write drift on %', attribute_row.attname;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
     WHERE attribute.attrelid = 'public.jarvis_work_items'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND privilege.grantee = authority.oid
       AND (privilege.privilege_type <> 'SELECT' OR privilege.is_grantable)
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch source column grant-option drift';
  END IF;
  IF EXISTS (
    SELECT expected.column_name
      FROM pg_catalog.unnest(expected_source_columns) AS expected(column_name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.jarvis_work_items'::pg_catalog.regclass
          AND attribute.attname = expected.column_name
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     )
  ) THEN
    RAISE EXCEPTION 'Jarvis dispatch expected source column missing';
  END IF;

  -- Exerce les deux surfaces autorisées sous le rôle réel. La policy source peut rendre zéro
  -- ligne ; le succès du parse/ACL est la preuve recherchée, sans fixture ni donnée lue.
  PERFORM 1 FROM public.jarvis_dispatch_directory_cursors WHERE FALSE;
  PERFORM "companyId", "ownerUserId", "runId", "updatedAt"
    FROM public.jarvis_work_items
   WHERE FALSE;
END;
$bob_jarvis_dispatch_release_certificate$;

ROLLBACK;
