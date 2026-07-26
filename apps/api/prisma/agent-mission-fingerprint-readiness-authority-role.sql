\set ON_ERROR_STOP on

-- Le rôle global est créé par le déployeur non-superuser avec une adhésion SET implicite.
-- Aucun GRANT/REVOKE d'adhésion ne cible postgres, conformément aux contraintes Supabase.
SET createrole_self_grant = 'set';

SELECT pg_catalog.format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_agent_mission_fingerprint_readiness'
)
WHERE NOT EXISTS (
  SELECT 1
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_agent_mission_fingerprint_readiness'
)
\gexec

DO $agent_mission_fingerprint_readiness_membership$
DECLARE
  deployer_oid OID;
  deployer_is_superuser BOOLEAN;
  authority_oid OID;
BEGIN
  SELECT role.oid, role.rolsuper
    INTO STRICT deployer_oid, deployer_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = current_user;
  SELECT role.oid
    INTO STRICT authority_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_agent_mission_fingerprint_readiness';

  IF NOT pg_catalog.pg_has_role(current_user, authority_oid, 'SET')
     OR (
       NOT deployer_is_superuser
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = authority_oid
            AND membership.member = deployer_oid
            AND membership.set_option
            AND NOT membership.inherit_option
       )
     ) THEN
    RAISE EXCEPTION
      'bob_agent_mission_fingerprint_readiness requires implicit SET membership from this deployer';
  END IF;
END;
$agent_mission_fingerprint_readiness_membership$;

SELECT pg_catalog.format(
  'REVOKE %I FROM %I CASCADE',
  parent_role.rolname,
  'bob_agent_mission_fingerprint_readiness'
)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent_role ON parent_role.oid = membership.roleid
 WHERE membership.member = 'bob_agent_mission_fingerprint_readiness'::pg_catalog.regrole
   AND parent_role.rolname <> 'postgres'
\gexec

SELECT pg_catalog.format(
  'REVOKE %I FROM %I CASCADE',
  'bob_agent_mission_fingerprint_readiness',
  member_role.rolname
)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
 WHERE membership.roleid = 'bob_agent_mission_fingerprint_readiness'::pg_catalog.regrole
   AND member_role.rolname NOT IN (current_user, 'postgres')
\gexec

DO $agent_mission_fingerprint_readiness_role_shape$
DECLARE
  authority pg_catalog.pg_roles%ROWTYPE;
  authority_oid OID;
BEGIN
  SELECT *
    INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_agent_mission_fingerprint_readiness';
  authority_oid := authority.oid;

  IF authority.rolcanlogin
     OR authority.rolsuper
     OR authority.rolcreatedb
     OR authority.rolcreaterole
     OR authority.rolinherit
     OR authority.rolreplication
     OR authority.rolbypassrls THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness role privilege drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = authority_oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
     WHERE membership.roleid = authority_oid
       AND member_role.rolname <> current_user
  ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness has an unexpected membership';
  END IF;
END;
$agent_mission_fingerprint_readiness_role_shape$;
