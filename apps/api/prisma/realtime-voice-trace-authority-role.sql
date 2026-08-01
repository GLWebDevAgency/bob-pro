\set ON_ERROR_STOP on

-- PostgreSQL 16 / Supabase : le créateur reçoit seulement SET au moment du CREATE ROLE. Aucun
-- GRANT d'adhésion ne cible le déployeur `postgres`, ce que supautils refuserait.
SET createrole_self_grant = 'set';

SELECT pg_catalog.format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  authority.role_name
)
  FROM (VALUES
    ('bob_realtime_voice_trace_maintenance'),
    ('bob_realtime_voice_trace_key_readiness'),
    ('bob_realtime_voice_trace_reader')
  ) AS authority(role_name)
 WHERE pg_catalog.to_regrole(authority.role_name) IS NULL
\gexec

-- Au rejeu, seules les propriétés qu'un déployeur CREATEROLE non-superuser peut réaffirmer sont
-- mutées. Les attributs réservés sont certifiés ensuite et provoquent un refus en cas de dérive.
SELECT pg_catalog.format(
  'ALTER ROLE %I NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT',
  authority.role_name
)
  FROM (VALUES
    ('bob_realtime_voice_trace_maintenance'),
    ('bob_realtime_voice_trace_key_readiness'),
    ('bob_realtime_voice_trace_reader')
  ) AS authority(role_name)
\gexec

DO $realtime_voice_trace_authority_role_certificate$
DECLARE
  authority_name TEXT;
  authority pg_catalog.pg_roles%ROWTYPE;
  deployer_oid OID;
  deployer_is_superuser BOOLEAN;
BEGIN
  SELECT role.oid, role.rolsuper
    INTO STRICT deployer_oid, deployer_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = current_user;
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
       OR authority.rolbypassrls THEN
      RAISE EXCEPTION 'Realtime Voice Trace authority role privilege drift: %', authority_name;
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
      RAISE EXCEPTION 'Realtime Voice Trace authority unavailable through creator SET: %',
        authority_name;
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
      RAISE EXCEPTION 'Realtime Voice Trace authority membership drift: %', authority_name;
    END IF;
  END LOOP;
END;
$realtime_voice_trace_authority_role_certificate$;
