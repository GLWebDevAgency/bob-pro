\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.set_config('app.release_runtime_role', :'app_role', TRUE);

DO $auth_user_deletion_inventory$
DECLARE
  protected_function REGPROCEDURE;
BEGIN
  IF pg_catalog.to_regrole(
       pg_catalog.current_setting('app.release_runtime_role', TRUE)
     ) IS NULL
     OR pg_catalog.to_regrole('bob_auth_user_deletion_authority') IS NULL
     OR pg_catalog.to_regclass('public.auth_user_deletion_jobs') IS NULL THEN
    RAISE EXCEPTION 'Auth user deletion protected inventory is incomplete';
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
    IF protected_function IS NULL THEN
      RAISE EXCEPTION 'Auth user deletion function inventory is incomplete';
    END IF;
  END LOOP;
END;
$auth_user_deletion_inventory$;

-- Retire chaque ancien ACL de table et de colonne avant de reconstruire l'allowlist.
SELECT DISTINCT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.auth_user_deletion_jobs FROM %s CASCADE; RESET ROLE;',
  owner.rolname,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.format('%I', grantee.rolname)
  END
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(
     relation.relacl,
     pg_catalog.acldefault('r', relation.relowner)
   )
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE relation.oid = 'public.auth_user_deletion_jobs'::REGCLASS
   AND privilege.grantee <> relation.relowner
   AND (privilege.grantee = 0 OR grantee.rolname IS NOT NULL)
\gexec

SELECT DISTINCT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.auth_user_deletion_jobs FROM %s CASCADE; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.format('%I', grantee.rolname)
  END
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE relation.oid = 'public.auth_user_deletion_jobs'::REGCLASS
   AND (privilege.grantee = 0 OR grantee.rolname IS NOT NULL)
\gexec

-- Nettoie les capacités de l'autorité sur les trois relations adjacentes, puis réaccorde le strict
-- minimum utilisé par ses fonctions SECURITY DEFINER.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.%I FROM bob_auth_user_deletion_authority; RESET ROLE;',
  owner.rolname,
  relation.relname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.relname IN ('companies', 'cabinet_members', 'notification_jobs')
 ORDER BY relation.relname
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM bob_auth_user_deletion_authority; RESET ROLE;',
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
 WHERE relation.relname IN ('companies', 'cabinet_members', 'notification_jobs')
 ORDER BY relation.relname, attribute.attnum
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT SELECT, INSERT, UPDATE ON TABLE public.auth_user_deletion_jobs TO bob_auth_user_deletion_authority; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.auth_user_deletion_jobs'::REGCLASS
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT SELECT ON TABLE public.%I TO bob_auth_user_deletion_authority; RESET ROLE;',
  owner.rolname,
  relation.relname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.relname IN ('companies', 'cabinet_members', 'notification_jobs')
 ORDER BY relation.relname
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT UPDATE (id) ON TABLE public.companies TO bob_auth_user_deletion_authority; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.companies'::REGCLASS
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT UPDATE (status, payload, recipient, subject, "payloadFingerprint", "leaseToken", "lastError", "updatedAt") ON TABLE public.notification_jobs TO bob_auth_user_deletion_authority; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.notification_jobs'::REGCLASS
\gexec

-- Le runtime ne voit jamais la table, y compris via un ancien ACL colonne.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.auth_user_deletion_jobs FROM %I; RESET ROLE;',
  owner.rolname,
  pg_catalog.current_setting('app.release_runtime_role', TRUE)
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.auth_user_deletion_jobs'::REGCLASS
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.auth_user_deletion_jobs FROM %I; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  pg_catalog.current_setting('app.release_runtime_role', TRUE)
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 WHERE relation.oid = 'public.auth_user_deletion_jobs'::REGCLASS
 ORDER BY attribute.attnum
\gexec

-- Propriétaire et configuration exacts. La migration crée déjà les fonctions sous l'autorité ;
-- toute dérive d'owner est fermée au lieu d'être masquée par un superuser de CI.
DO $auth_user_deletion_function_owner$
DECLARE
  protected_function REGPROCEDURE;
BEGIN
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
    IF (SELECT function.proowner FROM pg_catalog.pg_proc AS function
         WHERE function.oid = protected_function)
       <> 'bob_auth_user_deletion_authority'::REGROLE THEN
      RAISE EXCEPTION 'Auth user deletion function owner drift: %', protected_function;
    END IF;
  END LOOP;
END;
$auth_user_deletion_function_owner$;

SET LOCAL ROLE bob_auth_user_deletion_authority;

-- Rejouer la configuration ferme une dérive sans toucher aux corps versionnés de migration.
ALTER FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT)
  SECURITY DEFINER;
ALTER FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT)
  SET search_path = pg_catalog;
ALTER FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT)
  SET row_security = on;
ALTER FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT)
  SET lock_timeout = '1s';
ALTER FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT)
  SET statement_timeout = '4s';
ALTER FUNCTION public.guard_notification_job_open_company_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.guard_notification_job_open_company_v1()
  SET search_path = pg_catalog;
ALTER FUNCTION public.guard_notification_job_open_company_v1() SET row_security = on;
ALTER FUNCTION public.guard_notification_job_open_company_v1() SET lock_timeout = '1s';
ALTER FUNCTION public.guard_notification_job_open_company_v1() SET statement_timeout = '4s';
ALTER FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1()
  SET search_path = pg_catalog;
ALTER FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1() SET row_security = on;
ALTER FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1() SET lock_timeout = '1s';
ALTER FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1() SET statement_timeout = '4s';
ALTER FUNCTION public.guard_cabinet_member_auth_deletion_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.guard_cabinet_member_auth_deletion_v1()
  SET search_path = pg_catalog;
ALTER FUNCTION public.guard_cabinet_member_auth_deletion_v1() SET row_security = on;
ALTER FUNCTION public.guard_cabinet_member_auth_deletion_v1() SET lock_timeout = '1s';
ALTER FUNCTION public.guard_cabinet_member_auth_deletion_v1() SET statement_timeout = '4s';
ALTER FUNCTION public.claim_auth_user_deletions_v1(INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION public.claim_auth_user_deletions_v1(INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.claim_auth_user_deletions_v1(INTEGER) SET row_security = on;
ALTER FUNCTION public.claim_auth_user_deletions_v1(INTEGER) SET lock_timeout = '1s';
ALTER FUNCTION public.claim_auth_user_deletions_v1(INTEGER) SET statement_timeout = '4s';
ALTER FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID)
  SECURITY DEFINER;
ALTER FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID)
  SET search_path = pg_catalog;
ALTER FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID) SET row_security = on;
ALTER FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID) SET lock_timeout = '1s';
ALTER FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID) SET statement_timeout = '4s';
ALTER FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER) SET row_security = on;
ALTER FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER) SET lock_timeout = '1s';
ALTER FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER) SET statement_timeout = '4s';

-- ACL fonctions exacte : retire tout grantee non-owner, y compris un rôle historique inconnu de
-- l'allowlist. Sans ce nettoyage, un ancien LOGIN pourrait conserver EXECUTE sur les RPC globales
-- SECURITY DEFINER et claim/ack des suppressions hors du runtime officiel.
SELECT DISTINCT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
  function.oid::REGPROCEDURE,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.format('%I', grantee.rolname)
  END
)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE function.oid IN (
   'public.auth_user_deletion_subject_hash_v1(text)'::REGPROCEDURE,
   'public.enqueue_auth_user_deletion_internal_v1(uuid,text,text)'::REGPROCEDURE,
   'public.request_auth_user_deletion_v1(uuid,text,text)'::REGPROCEDURE,
   'public.guard_notification_job_open_company_v1()'::REGPROCEDURE,
   'public.enqueue_auth_user_deletion_on_company_close_v1()'::REGPROCEDURE,
   'public.guard_cabinet_member_auth_deletion_v1()'::REGPROCEDURE,
   'public.claim_auth_user_deletions_v1(integer)'::REGPROCEDURE,
   'public.complete_auth_user_deletion_v1(uuid,uuid)'::REGPROCEDURE,
   'public.retry_auth_user_deletion_v1(uuid,uuid,text,integer)'::REGPROCEDURE
 )
   AND privilege.grantee <> function.proowner
   AND (privilege.grantee = 0 OR grantee.rolname IS NOT NULL)
 ORDER BY 1
\gexec

REVOKE ALL PRIVILEGES ON FUNCTION public.auth_user_deletion_subject_hash_v1(TEXT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.enqueue_auth_user_deletion_internal_v1(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.guard_notification_job_open_company_v1() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.guard_cabinet_member_auth_deletion_v1() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_auth_user_deletions_v1(INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.auth_user_deletion_subject_hash_v1(TEXT) FROM :"app_role";
REVOKE ALL PRIVILEGES ON FUNCTION public.enqueue_auth_user_deletion_internal_v1(UUID, TEXT, TEXT) FROM :"app_role";
REVOKE ALL PRIVILEGES ON FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT) FROM :"app_role";
REVOKE ALL PRIVILEGES ON FUNCTION public.guard_notification_job_open_company_v1() FROM :"app_role";
REVOKE ALL PRIVILEGES ON FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1() FROM :"app_role";
REVOKE ALL PRIVILEGES ON FUNCTION public.guard_cabinet_member_auth_deletion_v1() FROM :"app_role";
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_auth_user_deletions_v1(INTEGER) FROM :"app_role";
REVOKE ALL PRIVILEGES ON FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID) FROM :"app_role";
REVOKE ALL PRIVILEGES ON FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER) FROM :"app_role";

GRANT EXECUTE ON FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT) TO :"app_role";
GRANT EXECUTE ON FUNCTION public.claim_auth_user_deletions_v1(INTEGER) TO :"app_role";
GRANT EXECUTE ON FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID) TO :"app_role";
GRANT EXECUTE ON FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER) TO :"app_role";

SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
  function.oid::REGPROCEDURE,
  role.rolname
)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN pg_catalog.pg_roles AS role
 WHERE function.oid IN (
   'public.auth_user_deletion_subject_hash_v1(text)'::REGPROCEDURE,
   'public.enqueue_auth_user_deletion_internal_v1(uuid,text,text)'::REGPROCEDURE,
   'public.request_auth_user_deletion_v1(uuid,text,text)'::REGPROCEDURE,
   'public.guard_notification_job_open_company_v1()'::REGPROCEDURE,
   'public.enqueue_auth_user_deletion_on_company_close_v1()'::REGPROCEDURE,
   'public.guard_cabinet_member_auth_deletion_v1()'::REGPROCEDURE,
   'public.claim_auth_user_deletions_v1(integer)'::REGPROCEDURE,
   'public.complete_auth_user_deletion_v1(uuid,uuid)'::REGPROCEDURE,
   'public.retry_auth_user_deletion_v1(uuid,uuid,text,integer)'::REGPROCEDURE
 )
   AND role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

RESET ROLE;

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE CREATE ON SCHEMA public FROM bob_auth_user_deletion_authority; GRANT USAGE ON SCHEMA public TO bob_auth_user_deletion_authority; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 WHERE namespace.nspname = 'public'
\gexec

-- Inventaire historique sous FORCE RLS. Les deux policies larges existent et disparaissent dans
-- cette transaction non publiée ; l'autorité est NOLOGIN et aucun runtime ne peut SET ROLE.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; DROP POLICY IF EXISTS auth_user_deletion_release_inventory ON public.companies; CREATE POLICY auth_user_deletion_release_inventory ON public.companies FOR SELECT TO bob_auth_user_deletion_authority USING (TRUE); RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.companies'::REGCLASS
\gexec
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; DROP POLICY IF EXISTS auth_user_deletion_release_inventory ON public.cabinet_members; CREATE POLICY auth_user_deletion_release_inventory ON public.cabinet_members FOR SELECT TO bob_auth_user_deletion_authority USING (TRUE); RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.cabinet_members'::REGCLASS
\gexec

SET LOCAL ROLE bob_auth_user_deletion_authority;
DO $auth_user_deletion_historical_inventory$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.companies AS company
     WHERE company."closedAt" IS NOT NULL
       AND (
         company.id !~ '^company-[A-Za-z0-9-]{1,56}$'
         OR NOT EXISTS (
           SELECT 1
             FROM public.auth_user_deletion_jobs AS job
            WHERE job."companyId" = company.id
         )
       )
  ) THEN
    RAISE EXCEPTION
      'Historical closed Company lacks a canonical durable Auth deletion receipt';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.companies AS company
      JOIN public.cabinet_members AS member
        ON member."userId" = pg_catalog.substr(company.id, 9)
       AND member.status::TEXT IN ('active', 'suspended')
     WHERE company."closedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Historical closed Company still has an active Cabinet membership';
  END IF;
END;
$auth_user_deletion_historical_inventory$;
RESET ROLE;

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; DROP POLICY auth_user_deletion_release_inventory ON public.companies; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.companies'::REGCLASS
\gexec
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; DROP POLICY auth_user_deletion_release_inventory ON public.cabinet_members; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.cabinet_members'::REGCLASS
\gexec

DO $auth_user_deletion_acl_certificate$
DECLARE
  authority pg_catalog.pg_roles%ROWTYPE;
  runtime_role TEXT := pg_catalog.current_setting('app.release_runtime_role', TRUE);
  protected_function REGPROCEDURE;
  public_rpc REGPROCEDURE;
  function_config TEXT[];
  function_security_definer BOOLEAN;
  function_volatility "char";
  company_update_columns TEXT[];
  cabinet_update_columns TEXT[];
  notification_update_columns TEXT[];
BEGIN
  SELECT * INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_auth_user_deletion_authority';
  IF authority.rolcanlogin
     OR authority.rolsuper
     OR authority.rolcreatedb
     OR authority.rolcreaterole
     OR authority.rolinherit
     OR authority.rolreplication
     OR authority.rolbypassrls
     OR pg_catalog.has_schema_privilege(authority.rolname, 'public', 'CREATE')
     OR NOT pg_catalog.has_schema_privilege(authority.rolname, 'public', 'USAGE') THEN
    RAISE EXCEPTION 'Auth user deletion authority profile drift';
  END IF;
  IF pg_catalog.pg_has_role(runtime_role, authority.oid, 'SET')
     OR pg_catalog.has_table_privilege(
       runtime_role, 'public.auth_user_deletion_jobs',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
     )
     OR pg_catalog.has_any_column_privilege(
       runtime_role, 'public.auth_user_deletion_jobs',
       'SELECT,INSERT,UPDATE,REFERENCES'
     ) THEN
    RAISE EXCEPTION 'Auth user deletion runtime direct authority drift';
  END IF;
  IF (SELECT relation.relowner FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.auth_user_deletion_jobs'::REGCLASS) = authority.oid
     OR NOT pg_catalog.has_table_privilege(
       authority.rolname, 'public.auth_user_deletion_jobs', 'SELECT,INSERT,UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname, 'public.auth_user_deletion_jobs',
       'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
     )
     OR pg_catalog.has_any_column_privilege(
       authority.rolname, 'public.auth_user_deletion_jobs', 'REFERENCES'
     ) THEN
    RAISE EXCEPTION 'Auth user deletion table ownership or ACL drift';
  END IF;

  -- Relations adjacentes : lecture seulement, sauf les colonnes strictement nécessaires aux
  -- verrous Company et à la minimisation Notification. Un GRANT UPDATE(closedAt) ou UPDATE table
  -- entier doit faire échouer la release, pas seulement une capacité manquante.
  IF NOT pg_catalog.has_table_privilege(authority.rolname, 'public.companies', 'SELECT')
     OR NOT pg_catalog.has_table_privilege(authority.rolname, 'public.cabinet_members', 'SELECT')
     OR NOT pg_catalog.has_table_privilege(authority.rolname, 'public.notification_jobs', 'SELECT')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.companies', 'INSERT')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.companies', 'UPDATE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.companies', 'DELETE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.companies', 'TRUNCATE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.companies', 'REFERENCES')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.companies', 'TRIGGER')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.companies', 'MAINTAIN')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.cabinet_members', 'INSERT')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.cabinet_members', 'UPDATE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.cabinet_members', 'DELETE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.cabinet_members', 'TRUNCATE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.cabinet_members', 'REFERENCES')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.cabinet_members', 'TRIGGER')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.cabinet_members', 'MAINTAIN')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.notification_jobs', 'INSERT')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.notification_jobs', 'UPDATE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.notification_jobs', 'DELETE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.notification_jobs', 'TRUNCATE')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.notification_jobs', 'REFERENCES')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.notification_jobs', 'TRIGGER')
     OR pg_catalog.has_table_privilege(authority.rolname, 'public.notification_jobs', 'MAINTAIN')
     OR pg_catalog.has_any_column_privilege(authority.rolname, 'public.companies', 'INSERT')
     OR pg_catalog.has_any_column_privilege(authority.rolname, 'public.companies', 'REFERENCES')
     OR pg_catalog.has_any_column_privilege(authority.rolname, 'public.cabinet_members', 'INSERT')
     OR pg_catalog.has_any_column_privilege(authority.rolname, 'public.cabinet_members', 'REFERENCES')
     OR pg_catalog.has_any_column_privilege(authority.rolname, 'public.notification_jobs', 'INSERT')
     OR pg_catalog.has_any_column_privilege(authority.rolname, 'public.notification_jobs', 'REFERENCES') THEN
    RAISE EXCEPTION 'Auth user deletion adjacent table ACL drift';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(attribute.attname ORDER BY attribute.attname), ARRAY[]::TEXT[])
    INTO company_update_columns
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.companies'::REGCLASS
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
     AND pg_catalog.has_column_privilege(
       authority.rolname, 'public.companies', attribute.attname, 'UPDATE'
     );
  SELECT COALESCE(pg_catalog.array_agg(attribute.attname ORDER BY attribute.attname), ARRAY[]::TEXT[])
    INTO cabinet_update_columns
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.cabinet_members'::REGCLASS
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
     AND pg_catalog.has_column_privilege(
       authority.rolname, 'public.cabinet_members', attribute.attname, 'UPDATE'
     );
  SELECT COALESCE(pg_catalog.array_agg(attribute.attname ORDER BY attribute.attname), ARRAY[]::TEXT[])
    INTO notification_update_columns
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.notification_jobs'::REGCLASS
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
     AND pg_catalog.has_column_privilege(
       authority.rolname, 'public.notification_jobs', attribute.attname, 'UPDATE'
     );
  IF company_update_columns <> ARRAY['id']::TEXT[]
     OR cabinet_update_columns <> ARRAY[]::TEXT[]
     OR notification_update_columns <> ARRAY[
       'lastError', 'leaseToken', 'payload', 'payloadFingerprint',
       'recipient', 'status', 'subject', 'updatedAt'
     ]::TEXT[] THEN
    RAISE EXCEPTION 'Auth user deletion adjacent column ACL drift: companies %, cabinet %, notifications %',
      company_update_columns, cabinet_update_columns, notification_update_columns;
  END IF;

  -- Les policies dédiées sont certifiées par rôle, commande et matière. Une policy absente,
  -- USING(TRUE) ou un claim qui oublie closedAt doit rendre la certification rouge.
  IF (SELECT COALESCE(pg_catalog.array_agg(policy.polname::TEXT ORDER BY policy.polname::TEXT), ARRAY[]::TEXT[])
        FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = 'public.companies'::REGCLASS
         AND authority.oid = ANY(policy.polroles)) <> ARRAY[
           'company_auth_deletion_closed_claim_select',
           'company_auth_deletion_subject_select',
           'company_auth_deletion_subject_update'
         ]::TEXT[]
     OR (SELECT COALESCE(pg_catalog.array_agg(policy.polname::TEXT ORDER BY policy.polname::TEXT), ARRAY[]::TEXT[])
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.cabinet_members'::REGCLASS
            AND authority.oid = ANY(policy.polroles))
          <> ARRAY['cabinet_member_auth_deletion_subject_select']::TEXT[]
     OR (SELECT COALESCE(pg_catalog.array_agg(policy.polname::TEXT ORDER BY policy.polname::TEXT), ARRAY[]::TEXT[])
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.notification_jobs'::REGCLASS
            AND authority.oid = ANY(policy.polroles)) <> ARRAY[
              'notification_job_auth_deletion_subject_select',
              'notification_job_auth_deletion_subject_update'
            ]::TEXT[]
     OR (SELECT COALESCE(pg_catalog.array_agg(policy.polname::TEXT ORDER BY policy.polname::TEXT), ARRAY[]::TEXT[])
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.auth_user_deletion_jobs'::REGCLASS
            AND authority.oid = ANY(policy.polroles)) <> ARRAY[
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
         AND policy.polroles = ARRAY[authority.oid]::OID[]
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
            AND policy.polroles = ARRAY[authority.oid]::OID[]
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
            AND policy.polroles = ARRAY[authority.oid]::OID[]
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
            AND policy.polroles = ARRAY[authority.oid]::OID[]
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
            AND policy.polroles = ARRAY[authority.oid]::OID[]
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
            AND policy.polroles = ARRAY[authority.oid]::OID[]
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
            AND policy.polroles = ARRAY[authority.oid]::OID[]
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) = 'true') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.auth_user_deletion_jobs'::REGCLASS
            AND policy.polname = 'auth_user_deletion_authority_insert'
            AND policy.polcmd = 'a'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority.oid]::OID[]
            AND policy.polqual IS NULL
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)) = 'true') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
          WHERE policy.polrelid = 'public.auth_user_deletion_jobs'::REGCLASS
            AND policy.polname = 'auth_user_deletion_authority_update'
            AND policy.polcmd = 'w'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[authority.oid]::OID[]
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)) = 'true'
            AND pg_catalog.lower(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)) = 'true') <> 1 THEN
    RAISE EXCEPTION 'Auth user deletion RLS policy drift';
  END IF;

  -- OID de fonction, événements, niveau ROW et état enabled exacts. Le nom seul n'est pas
  -- une preuve : un trigger DISABLED ou recâblé doit échouer.
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
    RAISE EXCEPTION 'Auth user deletion trigger contract drift';
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
     WHERE function.oid = protected_function;
    IF (SELECT function.proowner FROM pg_catalog.pg_proc AS function
         WHERE function.oid = protected_function) <> authority.oid
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.pg_proc AS function
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              function.proacl,
              pg_catalog.acldefault('f', function.proowner)
            )
          ) AS privilege
          WHERE function.oid = protected_function
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Auth user deletion function owner/ACL drift: %', protected_function;
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
                authority.oid,
                pg_catalog.to_regrole(runtime_role)::OID
              ]::OID[])
         ) THEN
        RAISE EXCEPTION 'Auth user deletion public RPC ACL allowlist drift: %',
          protected_function;
      END IF;
    ELSIF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
       ) AS privilege
       WHERE function.oid = protected_function
         AND privilege.grantee <> authority.oid
    ) THEN
      RAISE EXCEPTION 'Auth user deletion internal function ACL allowlist drift: %',
        protected_function;
    END IF;
    IF protected_function = 'public.auth_user_deletion_subject_hash_v1(text)'::REGPROCEDURE THEN
      IF function_security_definer
         OR function_volatility <> 's'
         OR pg_catalog.cardinality(function_config) <> 1
         OR NOT function_config @> ARRAY['search_path=pg_catalog']::TEXT[] THEN
        RAISE EXCEPTION 'Auth user deletion hash function configuration drift';
      END IF;
    ELSIF protected_function =
          'public.enqueue_auth_user_deletion_internal_v1(uuid,text,text)'::REGPROCEDURE THEN
      IF function_security_definer
         OR function_volatility <> 'v'
         OR pg_catalog.cardinality(function_config) <> 2
         OR NOT function_config @> ARRAY[
           'search_path=pg_catalog', 'row_security=on'
         ]::TEXT[] THEN
        RAISE EXCEPTION 'Auth user deletion internal function configuration drift';
      END IF;
    ELSE
      IF NOT function_security_definer
         OR function_volatility <> 'v'
         OR pg_catalog.cardinality(function_config) <> 4
         OR NOT function_config @> ARRAY[
           'search_path=pg_catalog', 'row_security=on',
           'lock_timeout=1s', 'statement_timeout=4s'
         ]::TEXT[] THEN
        RAISE EXCEPTION 'Auth user deletion privileged function configuration drift: %',
          protected_function;
      END IF;
    END IF;
  END LOOP;

  FOREACH public_rpc IN ARRAY ARRAY[
    'public.request_auth_user_deletion_v1(uuid,text,text)'::REGPROCEDURE,
    'public.claim_auth_user_deletions_v1(integer)'::REGPROCEDURE,
    'public.complete_auth_user_deletion_v1(uuid,uuid)'::REGPROCEDURE,
    'public.retry_auth_user_deletion_v1(uuid,uuid,text,integer)'::REGPROCEDURE
  ] LOOP
    IF NOT pg_catalog.has_function_privilege(runtime_role, public_rpc, 'EXECUTE') THEN
      RAISE EXCEPTION 'Auth user deletion runtime RPC missing: %', public_rpc;
    END IF;
  END LOOP;
  FOREACH protected_function IN ARRAY ARRAY[
    'public.auth_user_deletion_subject_hash_v1(text)'::REGPROCEDURE,
    'public.enqueue_auth_user_deletion_internal_v1(uuid,text,text)'::REGPROCEDURE,
    'public.guard_notification_job_open_company_v1()'::REGPROCEDURE,
    'public.enqueue_auth_user_deletion_on_company_close_v1()'::REGPROCEDURE,
    'public.guard_cabinet_member_auth_deletion_v1()'::REGPROCEDURE
  ] LOOP
    IF pg_catalog.has_function_privilege(runtime_role, protected_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Auth user deletion internal function exposed: %', protected_function;
    END IF;
  END LOOP;

END;
$auth_user_deletion_acl_certificate$;

COMMIT;
