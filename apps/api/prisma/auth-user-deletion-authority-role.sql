\set ON_ERROR_STOP on

-- PostgreSQL 16 / Supabase : le créateur reçoit uniquement SET au CREATE ROLE. Aucun GRANT
-- d'adhésion explicite ne cible le rôle managé `postgres`.
SET createrole_self_grant = 'set';

SELECT pg_catalog.format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_auth_user_deletion_authority'
)
WHERE pg_catalog.to_regrole('bob_auth_user_deletion_authority') IS NULL
\gexec

ALTER ROLE bob_auth_user_deletion_authority
  NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT;

DO $auth_user_deletion_authority_role_shape$
DECLARE
  authority pg_catalog.pg_roles%ROWTYPE;
  deployer_oid OID;
  deployer_is_superuser BOOLEAN;
BEGIN
  SELECT * INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_auth_user_deletion_authority';
  SELECT role.oid, role.rolsuper
    INTO STRICT deployer_oid, deployer_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = current_user;

  IF authority.rolcanlogin
     OR authority.rolsuper
     OR authority.rolcreatedb
     OR authority.rolcreaterole
     OR authority.rolinherit
     OR authority.rolreplication
     OR authority.rolbypassrls THEN
    RAISE EXCEPTION 'Auth user deletion authority role privilege drift';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, authority.oid, 'SET')
     OR (
       NOT deployer_is_superuser
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = authority.oid
            AND membership.member = deployer_oid
            AND membership.set_option
            AND NOT membership.inherit_option
       )
     ) THEN
    RAISE EXCEPTION
      'bob_auth_user_deletion_authority requires implicit SET membership from this deployer';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = authority.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
     WHERE membership.roleid = authority.oid
       AND member_role.rolname NOT IN (current_user, 'postgres')
  ) THEN
    RAISE EXCEPTION 'Auth user deletion authority role membership drift';
  END IF;
END;
$auth_user_deletion_authority_role_shape$;
