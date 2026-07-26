#!/usr/bin/env sh
set -eu

: "${DIRECT_URL:?DIRECT_URL non-superuser deployer URL is required}"

if [ "${GITHUB_ACTIONS:-false}" != "true" ] \
  && [ "${BOB_RLS_OWNER_SPLIT_CERT_CONFIRMATION:-}" != "EPHEMERAL_LOCAL_ONLY" ]; then
  echo "RLS owner-split certification is restricted to CI or an explicitly confirmed ephemeral database" >&2
  exit 1
fi

psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $rls_owner_split_target$
DECLARE
  deployer pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT *
    INTO STRICT deployer
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF current_database() <> 'bob_ephemeral_ci'
     OR current_user <> 'postgres'
     OR deployer.rolsuper
     OR NOT deployer.rolcreaterole THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_REQUIRES_EPHEMERAL_SUPABASE_CI';
  END IF;
END;
$rls_owner_split_target$;

SET LOCAL createrole_self_grant = 'set';
SELECT pg_catalog.format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_rls_schema_owner_cert'
)
WHERE pg_catalog.to_regrole('bob_rls_schema_owner_cert') IS NULL
\gexec

DO $rls_owner_split_membership$
DECLARE
  deployer_oid OID := current_user::pg_catalog.regrole;
  owner_oid OID := 'bob_rls_schema_owner_cert'::pg_catalog.regrole;
BEGIN
  IF NOT pg_catalog.pg_has_role(deployer_oid, owner_oid, 'SET')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.roleid = owner_oid
          AND membership.member = deployer_oid
          AND membership.admin_option
          AND membership.set_option
          AND NOT membership.inherit_option
     ) THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_IMPLICIT_SET_MEMBERSHIP_MISSING';
  END IF;
END;
$rls_owner_split_membership$;

-- La base est jetable et le postdeploy est déjà achevé. Seuls les objets encore possédés par le
-- déployeur sont déplacés ; les autorités NOLOGIN spécialisées conservent leurs objets.
SELECT pg_catalog.format(
  'ALTER TABLE %s OWNER TO bob_rls_schema_owner_cert',
  relation.oid::pg_catalog.regclass
)
  FROM pg_catalog.pg_class AS relation
 WHERE relation.relnamespace = 'public'::pg_catalog.regnamespace
   AND relation.relkind IN ('r', 'p')
   AND relation.relowner = current_user::pg_catalog.regrole
 ORDER BY relation.oid
\gexec

SELECT pg_catalog.format(
  'ALTER %s %I.%I(%s) OWNER TO bob_rls_schema_owner_cert',
  CASE function.prokind
    WHEN 'p' THEN 'PROCEDURE'
    ELSE 'FUNCTION'
  END,
  namespace.nspname,
  function.proname,
  pg_catalog.pg_get_function_identity_arguments(function.oid)
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = function.pronamespace
 WHERE namespace.nspname = 'public'
   AND function.prokind IN ('f', 'p', 'w')
   AND function.proowner = current_user::pg_catalog.regrole
 ORDER BY function.oid
\gexec
SQL

# C'est volontairement le vrai fichier de release, sous la vraie identité non-superuser.
psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -f apps/api/prisma/rls.sql

psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
DO $rls_owner_split_certificate$
BEGIN
  IF (
    SELECT relation.relowner = current_user::pg_catalog.regrole
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = 'public.agent_missions'::pg_catalog.regclass
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = 'public.agent_missions'::pg_catalog.regclass
       AND relation.relrowsecurity
       AND relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERTIFICATE_FAILED';
  END IF;
END;
$rls_owner_split_certificate$;
SQL

echo "RLS owner-split replay certified with a non-superuser deployer"
