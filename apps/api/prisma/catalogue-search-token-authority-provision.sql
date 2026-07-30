\set ON_ERROR_STOP on

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_catalog.set_config('app.release_runtime_role', :'app_role', true);

DO $catalogue_search_token_authority_inventory$
DECLARE
  function_owner OID;
BEGIN
  IF pg_catalog.to_regrole(current_setting('app.release_runtime_role', true)) IS NULL THEN
    RAISE EXCEPTION 'Catalogue search token runtime role is missing';
  END IF;
  IF pg_catalog.to_regrole('bob_catalogue_search_token_sync') IS NULL THEN
    RAISE EXCEPTION 'Catalogue search token authority role is missing';
  END IF;
  IF pg_catalog.to_regclass(
       'public.catalogue_prestation_search_tokens'
     ) IS NULL
     OR pg_catalog.to_regclass('public.catalogue_prestations') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.sync_catalogue_prestation_search_tokens_v1()'
     ) IS NULL THEN
    RAISE EXCEPTION 'Catalogue search token protected inventory is incomplete';
  END IF;

  SELECT function.proowner
    INTO STRICT function_owner
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure;
  IF function_owner <> 'bob_catalogue_search_token_sync'::pg_catalog.regrole
     AND NOT pg_catalog.pg_has_role(session_user, function_owner, 'SET') THEN
    RAISE EXCEPTION 'Catalogue search token function owner is unavailable to deployer';
  END IF;
END;
$catalogue_search_token_authority_inventory$;

-- CREATE n'existe que le temps du transfert d'ownership de la fonction. Les privilèges table
-- sont nettoyés sous le propriétaire exact, y compris les anciens GRANT colonne qui survivraient
-- à un simple REVOKE table.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT USAGE, CREATE ON SCHEMA public TO bob_catalogue_search_token_sync; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 WHERE namespace.nspname = 'public'
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.catalogue_prestation_search_tokens FROM bob_catalogue_search_token_sync; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid =
   'public.catalogue_prestation_search_tokens'::pg_catalog.regclass
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.catalogue_prestation_search_tokens FROM bob_catalogue_search_token_sync; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 WHERE relation.oid =
   'public.catalogue_prestation_search_tokens'::pg_catalog.regclass
 ORDER BY attribute.attnum
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT SELECT ("companyId", "catalogueItemId"), INSERT ("companyId", "catalogueItemId", token), DELETE ON TABLE public.catalogue_prestation_search_tokens TO bob_catalogue_search_token_sync; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid =
   'public.catalogue_prestation_search_tokens'::pg_catalog.regclass
\gexec

-- La fonction peut avoir été créée sous bob_schema_owner par la migration. PostgreSQL vérifie la
-- capacité SET du current_role (pas seulement du session_user) vers le nouvel owner. L'adhésion
-- suivante existe uniquement dans cette transaction, sur l'ancien owner NOLOGIN, puis est
-- révoquée immédiatement après le transfert. Aucun GRANT ne cible le déployeur Supabase.
SELECT pg_catalog.format(
  'GRANT bob_catalogue_search_token_sync TO %I WITH INHERIT FALSE, SET TRUE',
  owner.rolname
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid =
   'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure
   AND function.proowner <>
     'bob_catalogue_search_token_sync'::pg_catalog.regrole
   AND function.proowner <> session_user::pg_catalog.regrole
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; ALTER FUNCTION %s OWNER TO bob_catalogue_search_token_sync; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid =
   'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure
   AND function.proowner <>
     'bob_catalogue_search_token_sync'::pg_catalog.regrole
\gexec

SELECT pg_catalog.format(
  'REVOKE bob_catalogue_search_token_sync FROM %I',
  member.rolname
)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
 WHERE membership.roleid = 'bob_catalogue_search_token_sync'::pg_catalog.regrole
   AND member.rolname NOT IN (session_user, 'postgres')
\gexec

SET LOCAL ROLE bob_catalogue_search_token_sync;

-- Allowlist exacte : la fonction est un trigger interne, jamais une API callable.
SELECT DISTINCT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
  function.oid::pg_catalog.regprocedure,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.quote_ident(grantee.rolname)
  END
)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   coalesce(
     function.proacl,
     pg_catalog.acldefault('f', function.proowner)
   )
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE function.oid =
   'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure
   AND privilege.grantee <> function.proowner
 ORDER BY 1
\gexec

REVOKE ALL PRIVILEGES
  ON FUNCTION public.sync_catalogue_prestation_search_tokens_v1()
  FROM PUBLIC;
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION public.sync_catalogue_prestation_search_tokens_v1() FROM %I',
  role.rolname
)
  FROM pg_catalog.pg_roles AS role
 WHERE role.rolname IN (
   current_setting('app.release_runtime_role', true),
   'anon',
   'authenticated',
   'service_role'
 )
   AND role.rolname <> 'bob_catalogue_search_token_sync'
\gexec

ALTER FUNCTION public.sync_catalogue_prestation_search_tokens_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.sync_catalogue_prestation_search_tokens_v1()
  SET search_path = pg_catalog;
ALTER FUNCTION public.sync_catalogue_prestation_search_tokens_v1()
  SET row_security = on;
RESET ROLE;

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE CREATE ON SCHEMA public FROM bob_catalogue_search_token_sync; GRANT USAGE ON SCHEMA public TO bob_catalogue_search_token_sync; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 WHERE namespace.nspname = 'public'
\gexec

DO $catalogue_search_token_authority_certificate$
DECLARE
  authority pg_catalog.pg_roles%ROWTYPE;
  authority_oid OID;
  helper pg_catalog.pg_proc%ROWTYPE;
  table_owner OID;
  column_name TEXT;
  exposed_grantee OID;
BEGIN
  SELECT *
    INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_catalogue_search_token_sync';
  authority_oid := authority.oid;
  SELECT *
    INTO STRICT helper
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure;
  SELECT relation.relowner
    INTO STRICT table_owner
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid =
     'public.catalogue_prestation_search_tokens'::pg_catalog.regclass;

  IF authority.rolcanlogin
     OR authority.rolsuper
     OR authority.rolcreatedb
     OR authority.rolcreaterole
     OR authority.rolinherit
     OR authority.rolreplication
     OR authority.rolbypassrls
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = authority_oid
     )
     OR table_owner = authority_oid THEN
    RAISE EXCEPTION 'Catalogue search token authority profile drift';
  END IF;

  IF helper.proowner <> authority_oid
     OR NOT helper.prosecdef
     OR helper.proconfig IS NULL
     OR NOT helper.proconfig @> ARRAY[
       'search_path=pg_catalog',
       'row_security=on'
     ]::TEXT[]
     OR pg_catalog.md5(helper.prosrc) <>
       '94327712057244bbe60cc428a22df471' THEN
    RAISE EXCEPTION 'Catalogue search token function authority or body drift';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       authority.rolname,
       'public',
       'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       authority.rolname,
       'public',
       'CREATE'
     ) THEN
    RAISE EXCEPTION 'Catalogue search token authority schema ACL drift';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       authority.rolname,
       'public.catalogue_prestation_search_tokens',
       'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.catalogue_prestation_search_tokens',
       'SELECT,INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.catalogue_prestations',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_any_column_privilege(
       authority.rolname,
       'public.catalogue_prestations',
       'SELECT,INSERT,UPDATE,REFERENCES'
     ) THEN
    RAISE EXCEPTION 'Catalogue search token authority table ACL drift';
  END IF;

  FOR column_name IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid =
           'public.catalogue_prestation_search_tokens'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  LOOP
    IF (
      column_name IN ('companyId', 'catalogueItemId')
      AND NOT pg_catalog.has_column_privilege(
        authority.rolname,
        'public.catalogue_prestation_search_tokens',
        column_name,
        'SELECT'
      )
    ) OR (
      column_name = 'token'
      AND pg_catalog.has_column_privilege(
        authority.rolname,
        'public.catalogue_prestation_search_tokens',
        column_name,
        'SELECT'
      )
    ) OR NOT pg_catalog.has_column_privilege(
      authority.rolname,
      'public.catalogue_prestation_search_tokens',
      column_name,
      'INSERT'
    ) OR pg_catalog.has_column_privilege(
      authority.rolname,
      'public.catalogue_prestation_search_tokens',
      column_name,
      'UPDATE,REFERENCES'
    ) THEN
      RAISE EXCEPTION
        'Catalogue search token authority column ACL drift on %',
        column_name;
    END IF;
  END LOOP;

  FOR exposed_grantee IN
    SELECT DISTINCT privilege.grantee
      FROM pg_catalog.aclexplode(
        coalesce(
          helper.proacl,
          pg_catalog.acldefault('f', helper.proowner)
        )
      ) AS privilege
     WHERE privilege.privilege_type = 'EXECUTE'
       AND privilege.grantee <> authority_oid
  LOOP
    RAISE EXCEPTION
      'Catalogue search token function has unexpected EXECUTE grantee %',
      exposed_grantee;
  END LOOP;
END;
$catalogue_search_token_authority_certificate$;
