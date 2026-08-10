\set ON_ERROR_STOP on

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_catalog.set_config('app.release_runtime_role', :'app_role', TRUE);

DO $auth_user_deletion_runtime_certificate$
DECLARE
  runtime_role TEXT := pg_catalog.current_setting('app.release_runtime_role', TRUE);
  authority_oid OID;
  public_rpc REGPROCEDURE;
  internal_function REGPROCEDURE;
  protected_function REGPROCEDURE;
  function_config TEXT[];
  function_security_definer BOOLEAN;
  function_volatility "char";
  company_update_columns TEXT[];
  cabinet_update_columns TEXT[];
  notification_update_columns TEXT[];
BEGIN
  IF current_user <> runtime_role THEN
    RAISE EXCEPTION 'DATABASE_URL must connect as APP_DATABASE_ROLE for Auth deletion certification';
  END IF;
  SELECT role.oid INTO STRICT authority_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_auth_user_deletion_authority';
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles AS role
        WHERE role.oid = authority_oid
          AND (
            role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
            OR role.rolinherit OR role.rolreplication OR role.rolbypassrls
          )
     )
     OR pg_catalog.has_schema_privilege(
       'bob_auth_user_deletion_authority', 'public', 'CREATE'
     )
     OR NOT pg_catalog.has_schema_privilege(
       'bob_auth_user_deletion_authority', 'public', 'USAGE'
     )
     OR pg_catalog.pg_has_role(current_user, authority_oid, 'SET')
     OR pg_catalog.has_table_privilege(
       current_user,
       'public.auth_user_deletion_jobs',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
     )
     OR pg_catalog.has_any_column_privilege(
       current_user,
       'public.auth_user_deletion_jobs',
       'SELECT,INSERT,UPDATE,REFERENCES'
     ) THEN
    RAISE EXCEPTION 'Runtime retains direct Auth deletion authority';
  END IF;

  FOREACH public_rpc IN ARRAY ARRAY[
    'public.request_auth_user_deletion_v1(uuid,text,text)'::REGPROCEDURE,
    'public.claim_auth_user_deletions_v1(integer)'::REGPROCEDURE,
    'public.complete_auth_user_deletion_v1(uuid,uuid)'::REGPROCEDURE,
    'public.retry_auth_user_deletion_v1(uuid,uuid,text,integer)'::REGPROCEDURE
  ] LOOP
    IF NOT pg_catalog.has_function_privilege(current_user, public_rpc, 'EXECUTE') THEN
      RAISE EXCEPTION 'Runtime Auth deletion RPC missing: %', public_rpc;
    END IF;
  END LOOP;

  FOREACH internal_function IN ARRAY ARRAY[
    'public.auth_user_deletion_subject_hash_v1(text)'::REGPROCEDURE,
    'public.enqueue_auth_user_deletion_internal_v1(uuid,text,text)'::REGPROCEDURE,
    'public.guard_notification_job_open_company_v1()'::REGPROCEDURE,
    'public.enqueue_auth_user_deletion_on_company_close_v1()'::REGPROCEDURE,
    'public.guard_cabinet_member_auth_deletion_v1()'::REGPROCEDURE
  ] LOOP
    IF pg_catalog.has_function_privilege(current_user, internal_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Runtime can execute an internal Auth deletion function: %', internal_function;
    END IF;
  END LOOP;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = 'public.auth_user_deletion_jobs'::REGCLASS
          AND relation.relowner <> authority_oid
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
     )
     OR NOT pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.auth_user_deletion_jobs',
       'SELECT,INSERT,UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.auth_user_deletion_jobs',
       'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
     )
     OR pg_catalog.has_any_column_privilege(
       'bob_auth_user_deletion_authority', 'public.auth_user_deletion_jobs', 'REFERENCES'
     ) THEN
    RAISE EXCEPTION 'Auth deletion protected table contract drift';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'REFERENCES'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'MAINTAIN'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'REFERENCES'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'MAINTAIN'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'REFERENCES'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'MAINTAIN'
     )
     OR pg_catalog.has_any_column_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'INSERT'
     )
     OR pg_catalog.has_any_column_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', 'REFERENCES'
     )
     OR pg_catalog.has_any_column_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'INSERT'
     )
     OR pg_catalog.has_any_column_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', 'REFERENCES'
     )
     OR pg_catalog.has_any_column_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'INSERT'
     )
     OR pg_catalog.has_any_column_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', 'REFERENCES'
     ) THEN
    RAISE EXCEPTION 'Auth deletion adjacent table ACL drift';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(attribute.attname ORDER BY attribute.attname), ARRAY[]::TEXT[])
    INTO company_update_columns
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.companies'::REGCLASS
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
     AND pg_catalog.has_column_privilege(
       'bob_auth_user_deletion_authority', 'public.companies', attribute.attname, 'UPDATE'
     );
  SELECT COALESCE(pg_catalog.array_agg(attribute.attname ORDER BY attribute.attname), ARRAY[]::TEXT[])
    INTO cabinet_update_columns
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.cabinet_members'::REGCLASS
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
     AND pg_catalog.has_column_privilege(
       'bob_auth_user_deletion_authority', 'public.cabinet_members', attribute.attname, 'UPDATE'
     );
  SELECT COALESCE(pg_catalog.array_agg(attribute.attname ORDER BY attribute.attname), ARRAY[]::TEXT[])
    INTO notification_update_columns
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.notification_jobs'::REGCLASS
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
     AND pg_catalog.has_column_privilege(
       'bob_auth_user_deletion_authority', 'public.notification_jobs', attribute.attname, 'UPDATE'
     );
  IF company_update_columns <> ARRAY['id']::TEXT[]
     OR cabinet_update_columns <> ARRAY[]::TEXT[]
     OR notification_update_columns <> ARRAY[
       'lastError', 'leaseToken', 'payload', 'payloadFingerprint',
       'recipient', 'status', 'subject', 'updatedAt'
     ]::TEXT[] THEN
    RAISE EXCEPTION 'Auth deletion adjacent column ACL drift: companies %, cabinet %, notifications %',
      company_update_columns, cabinet_update_columns, notification_update_columns;
  END IF;

  IF (SELECT COALESCE(pg_catalog.array_agg(policy.polname::TEXT ORDER BY policy.polname::TEXT), ARRAY[]::TEXT[])
        FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = 'public.companies'::REGCLASS
         AND authority_oid = ANY(policy.polroles)) <> ARRAY[
           'company_auth_deletion_closed_claim_select',
           'company_auth_deletion_subject_select',
           'company_auth_deletion_subject_update'
         ]::TEXT[]
     OR (SELECT COALESCE(pg_catalog.array_agg(policy.polname::TEXT ORDER BY policy.polname::TEXT), ARRAY[]::TEXT[])
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.cabinet_members'::REGCLASS
            AND authority_oid = ANY(policy.polroles))
          <> ARRAY['cabinet_member_auth_deletion_subject_select']::TEXT[]
     OR (SELECT COALESCE(pg_catalog.array_agg(policy.polname::TEXT ORDER BY policy.polname::TEXT), ARRAY[]::TEXT[])
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.notification_jobs'::REGCLASS
            AND authority_oid = ANY(policy.polroles)) <> ARRAY[
              'notification_job_auth_deletion_subject_select',
              'notification_job_auth_deletion_subject_update'
            ]::TEXT[]
     OR (SELECT COALESCE(pg_catalog.array_agg(policy.polname::TEXT ORDER BY policy.polname::TEXT), ARRAY[]::TEXT[])
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.auth_user_deletion_jobs'::REGCLASS
            AND authority_oid = ANY(policy.polroles)) <> ARRAY[
              'auth_user_deletion_authority_insert',
              'auth_user_deletion_authority_select',
              'auth_user_deletion_authority_update'
            ]::TEXT[]
     OR (SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = 'public.companies'::REGCLASS
         AND policy.polname = 'company_auth_deletion_subject_select'
         AND policy.polcmd = 'r'
         AND policy.polpermissive
         AND policy.polroles = ARRAY[authority_oid]::OID[]
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
               LIKE '%app.auth_user_deletion_company_id%'
         AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) <> 'true'
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) NOT ILIKE '% OR %') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.companies'::REGCLASS
            AND policy.polname = 'company_auth_deletion_closed_claim_select'
            AND policy.polcmd = 'r'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority_oid]::OID[]
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) LIKE '%closedAt%IS NOT NULL%'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
                  LIKE '%app.auth_user_deletion_claim_mode%'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) LIKE '%closed-company-v1%'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) NOT ILIKE '% OR %') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.companies'::REGCLASS
            AND policy.polname = 'company_auth_deletion_subject_update'
            AND policy.polcmd = 'w'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority_oid]::OID[]
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
                  LIKE '%app.auth_user_deletion_company_id%'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
                  LIKE '%app.auth_user_deletion_company_id%'
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) <> 'true'
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)) <> 'true'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) NOT ILIKE '% OR %'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) NOT ILIKE '% OR %') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.cabinet_members'::REGCLASS
            AND policy.polname = 'cabinet_member_auth_deletion_subject_select'
            AND policy.polcmd = 'r'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority_oid]::OID[]
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
                  LIKE '%app.auth_user_deletion_subject_id%'
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) <> 'true'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) NOT ILIKE '% OR %') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.notification_jobs'::REGCLASS
            AND policy.polname = 'notification_job_auth_deletion_subject_select'
            AND policy.polcmd = 'r'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority_oid]::OID[]
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
                  LIKE '%app.auth_user_deletion_company_id%'
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) <> 'true'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) NOT ILIKE '% OR %') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.notification_jobs'::REGCLASS
            AND policy.polname = 'notification_job_auth_deletion_subject_update'
            AND policy.polcmd = 'w'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority_oid]::OID[]
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
                  LIKE '%app.auth_user_deletion_company_id%'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
                  LIKE '%app.auth_user_deletion_company_id%'
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) <> 'true'
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)) <> 'true'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) NOT ILIKE '% OR %'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) NOT ILIKE '% OR %') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.auth_user_deletion_jobs'::REGCLASS
            AND policy.polname = 'auth_user_deletion_authority_select'
            AND policy.polcmd = 'r'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority_oid]::OID[]
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) = 'true') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.auth_user_deletion_jobs'::REGCLASS
            AND policy.polname = 'auth_user_deletion_authority_insert'
            AND policy.polcmd = 'a'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority_oid]::OID[]
            AND policy.polqual IS NULL
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)) = 'true') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.auth_user_deletion_jobs'::REGCLASS
            AND policy.polname = 'auth_user_deletion_authority_update'
            AND policy.polcmd = 'w'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority_oid]::OID[]
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) = 'true'
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)) = 'true') <> 1 THEN
    RAISE EXCEPTION 'Auth deletion RLS policy drift';
  END IF;

  FOREACH protected_function IN ARRAY ARRAY[
    'public.auth_user_deletion_subject_hash_v1(text)'::REGPROCEDURE,
    'public.enqueue_auth_user_deletion_internal_v1(uuid,text,text)'::REGPROCEDURE,
    'public.request_auth_user_deletion_v1(uuid,text,text)'::REGPROCEDURE,
    'public.guard_notification_job_open_company_v1()'::REGPROCEDURE,
    'public.enqueue_auth_user_deletion_on_company_close_v1()'::REGPROCEDURE,
    'public.guard_cabinet_member_auth_deletion_v1()'::REGPROCEDURE,
    'public.claim_auth_user_deletions_v1(integer)'::REGPROCEDURE,
    'public.complete_auth_user_deletion_v1(uuid,uuid)'::REGPROCEDURE,
    'public.retry_auth_user_deletion_v1(uuid,uuid,text,integer)'::REGPROCEDURE
  ] LOOP
    SELECT function.proconfig, function.prosecdef, function.provolatile
      INTO function_config, function_security_definer, function_volatility
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid = protected_function
       AND function.proowner = authority_oid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Auth deletion function owner drift: %', protected_function;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
       ) AS privilege
       WHERE function.oid = protected_function
         AND privilege.grantee = 0
         AND privilege.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'Auth deletion PUBLIC function ACL drift: %', protected_function;
    END IF;
    IF protected_function = ANY(ARRAY[
         'public.request_auth_user_deletion_v1(uuid,text,text)'::REGPROCEDURE,
         'public.claim_auth_user_deletions_v1(integer)'::REGPROCEDURE,
         'public.complete_auth_user_deletion_v1(uuid,uuid)'::REGPROCEDURE,
         'public.retry_auth_user_deletion_v1(uuid,uuid,text,integer)'::REGPROCEDURE
       ]) THEN
      IF (SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_proc AS function
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
           ) AS privilege
           WHERE function.oid = protected_function
             AND privilege.grantee = pg_catalog.to_regrole(runtime_role)
             AND privilege.privilege_type = 'EXECUTE'
             AND NOT privilege.is_grantable) <> 1
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc AS function
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
            ) AS privilege
            WHERE function.oid = protected_function
              AND privilege.grantee <> ALL(ARRAY[
                authority_oid,
                pg_catalog.to_regrole(runtime_role)::OID
              ]::OID[])
         ) THEN
        RAISE EXCEPTION 'Auth deletion public RPC ACL allowlist drift: %',
          protected_function;
      END IF;
    ELSIF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
       ) AS privilege
       WHERE function.oid = protected_function
         AND privilege.grantee <> authority_oid
    ) THEN
      RAISE EXCEPTION 'Auth deletion internal function ACL allowlist drift: %',
        protected_function;
    END IF;
    IF protected_function = 'public.auth_user_deletion_subject_hash_v1(text)'::REGPROCEDURE THEN
      IF function_security_definer
         OR function_volatility <> 's'
         OR pg_catalog.cardinality(function_config) <> 1
         OR NOT function_config @> ARRAY['search_path=pg_catalog']::TEXT[] THEN
        RAISE EXCEPTION 'Auth deletion hash function configuration drift';
      END IF;
    ELSIF protected_function =
          'public.enqueue_auth_user_deletion_internal_v1(uuid,text,text)'::REGPROCEDURE THEN
      IF function_security_definer
         OR function_volatility <> 'v'
         OR pg_catalog.cardinality(function_config) <> 2
         OR NOT function_config @> ARRAY[
           'search_path=pg_catalog', 'row_security=on'
         ]::TEXT[] THEN
        RAISE EXCEPTION 'Auth deletion internal function configuration drift';
      END IF;
    ELSE
      IF NOT function_security_definer
         OR function_volatility <> 'v'
         OR pg_catalog.cardinality(function_config) <> 4
         OR NOT function_config @> ARRAY[
           'search_path=pg_catalog', 'row_security=on',
           'lock_timeout=1s', 'statement_timeout=4s'
         ]::TEXT[] THEN
        RAISE EXCEPTION 'Auth deletion privileged function configuration drift: %',
          protected_function;
      END IF;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger
     WHERE trigger.tgrelid = 'public.companies'::REGCLASS
       AND trigger.tgname = 'companies_auth_user_deletion_n1_v1'
       AND trigger.tgfoid = 'public.enqueue_auth_user_deletion_on_company_close_v1()'::REGPROCEDURE
       AND trigger.tgenabled = 'O'
       AND trigger.tgtype = 17
       AND trigger.tgattr::TEXT = (
         SELECT attribute.attnum::TEXT FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.companies'::REGCLASS
            AND attribute.attname = 'closedAt'
            AND NOT attribute.attisdropped
       )
       AND pg_catalog.lower(pg_catalog.pg_get_triggerdef(trigger.oid, FALSE))
             LIKE '%old."closedat" is null%'
       AND pg_catalog.lower(pg_catalog.pg_get_triggerdef(trigger.oid, FALSE))
             LIKE '%new."closedat" is not null%'
       AND NOT trigger.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger
     WHERE trigger.tgrelid = 'public.notification_jobs'::REGCLASS
       AND trigger.tgname = '00_notification_jobs_open_company_v1'
       AND trigger.tgfoid = 'public.guard_notification_job_open_company_v1()'::REGPROCEDURE
       AND trigger.tgenabled = 'O'
       AND trigger.tgtype = 23
       AND trigger.tgattr::TEXT = ''
       AND NOT trigger.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger
     WHERE trigger.tgrelid = 'public.cabinet_members'::REGCLASS
       AND trigger.tgname = '00_cabinet_members_auth_deletion_fence'
       AND trigger.tgfoid = 'public.guard_cabinet_member_auth_deletion_v1()'::REGPROCEDURE
       AND trigger.tgenabled = 'O'
       AND trigger.tgtype = 31
       AND trigger.tgattr::TEXT = ''
       AND NOT trigger.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Auth deletion trigger contract drift';
  END IF;
END;
$auth_user_deletion_runtime_certificate$;

ROLLBACK;
