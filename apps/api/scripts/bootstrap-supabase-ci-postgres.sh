#!/usr/bin/env sh
set -eu

: "${CI_POSTGRES_SUPER_URL:?CI_POSTGRES_SUPER_URL ephemeral bootstrap URL is required}"
: "${CI_POSTGRES_ADMIN_URL:?CI_POSTGRES_ADMIN_URL ephemeral internal admin URL is required}"
: "${DIRECT_URL:?DIRECT_URL release URL is required}"

# Ce harnais ne doit jamais devenir un outil d'exploitation. Il reproduit uniquement, sur le
# PostgreSQL loopback jetable de GitHub Actions, le profil Supabase où `postgres` est le déployeur
# LOGIN non-superuser (CREATEROLE + BYPASSRLS) et où un superuser interne distinct reste caché.
node - "$CI_POSTGRES_SUPER_URL" "$CI_POSTGRES_ADMIN_URL" "$DIRECT_URL" <<'NODE'
const [bootstrapRaw, adminRaw, directRaw] = process.argv.slice(2);
const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);

const parse = (raw, name, expectedUser) => {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${name} must target loopback; remote databases are forbidden`);
  }
  if (decodeURIComponent(parsed.username) !== expectedUser) {
    throw new Error(`${name} must use the expected ephemeral identity`);
  }
  return parsed;
};

const bootstrap = parse(bootstrapRaw, 'CI_POSTGRES_SUPER_URL', 'postgres');
const admin = parse(adminRaw, 'CI_POSTGRES_ADMIN_URL', 'bob_ci_supabase_admin');
const direct = parse(directRaw, 'DIRECT_URL', 'postgres');
for (const candidate of [admin, direct]) {
  if (
    bootstrap.hostname.toLowerCase() !== candidate.hostname.toLowerCase()
    || bootstrap.port !== candidate.port
    || bootstrap.pathname !== candidate.pathname
  ) {
    throw new Error('all Supabase CI URLs must target the same ephemeral database');
  }
}
NODE

psql "$CI_POSTGRES_SUPER_URL" -X --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
DO $bootstrap$
DECLARE
  bootstrap_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT *
    INTO STRICT bootstrap_role
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF current_user <> 'postgres' OR NOT bootstrap_role.rolsuper THEN
    RAISE EXCEPTION 'SUPABASE_CI_BOOTSTRAP_REQUIRES_EPHEMERAL_POSTGRES_SUPERUSER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'bob_ci_supabase_admin'
  ) THEN
    CREATE ROLE bob_ci_supabase_admin
      LOGIN PASSWORD 'bob_ci_supabase_admin'
      SUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$bootstrap$;
SQL

psql "$CI_POSTGRES_ADMIN_URL" -X --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
-- L'image PostgreSQL réserve OID 10 au bootstrap superuser, qui ne peut jamais être rétrogradé.
-- Supabase utilise au contraire un superuser interne distinct et expose un rôle `postgres`
-- non-superuser. Renommer OID 10 puis recréer `postgres` reproduit réellement ce contrat.
ALTER ROLE postgres RENAME TO bob_ci_bootstrap_superuser;
CREATE ROLE postgres
  LOGIN PASSWORD 'postgres'
  NOSUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS
  IN ROLE pg_monitor;
-- Supabase autorise ce SET borné via son contrôle managé, même lorsque l'ACL paramétrique
-- standard ne le reflète pas. PostgreSQL vanilla reçoit ici l'ACL équivalente afin que les
-- certificats de cleanup exercent le même geste sans transmettre SUPERUSER au déployeur.
GRANT SET ON PARAMETER session_replication_role TO postgres;

SELECT pg_catalog.format(
  'ALTER DATABASE %I OWNER TO %I',
  current_database(),
  'postgres'
)
\gexec

DO $data_api$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(api_role) IS NULL THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        api_role
      );
    END IF;
  END LOOP;
END;
$data_api$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

SELECT pg_catalog.format(
  'ALTER DATABASE %I SET createrole_self_grant = %L',
  current_database(),
  'set'
)
\gexec

-- Les deux superusers internes deviennent inaccessibles dès la fin de ce bootstrap one-shot.
ALTER ROLE bob_ci_bootstrap_superuser NOLOGIN;
ALTER ROLE bob_ci_supabase_admin NOLOGIN;
SQL

psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $certificate$
DECLARE
  api_role TEXT;
  expected RECORD;
  deployer pg_catalog.pg_roles%ROWTYPE;
  internal_admin pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT *
    INTO STRICT deployer
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF current_user <> 'postgres'
     OR deployer.rolsuper
     OR NOT deployer.rolcreatedb
     OR NOT deployer.rolcreaterole
     OR NOT deployer.rolreplication
     OR NOT deployer.rolbypassrls
     OR NOT pg_catalog.pg_has_role(current_user, 'pg_monitor', 'MEMBER')
     OR NOT pg_catalog.has_parameter_privilege(
       current_user,
       'session_replication_role',
       'SET'
     ) THEN
    RAISE EXCEPTION 'SUPABASE_CI_DEPLOYER_PROFILE_MISMATCH';
  END IF;
  IF current_setting('createrole_self_grant') <> 'set' THEN
    RAISE EXCEPTION 'SUPABASE_CI_SELF_GRANT_PROFILE_MISMATCH';
  END IF;

  SELECT *
    INTO STRICT internal_admin
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_ci_supabase_admin';
  IF internal_admin.rolcanlogin OR NOT internal_admin.rolsuper THEN
    RAISE EXCEPTION 'SUPABASE_CI_INTERNAL_ADMIN_PROFILE_MISMATCH';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(api_role) IS NULL
       OR NOT pg_catalog.has_schema_privilege(api_role, 'public', 'USAGE') THEN
      RAISE EXCEPTION 'SUPABASE_CI_DATA_API_ROLE_MISSING:%', api_role;
    END IF;

    FOR expected IN
      SELECT *
        FROM (
          VALUES
            ('r'::"char", 'SELECT'::TEXT),
            ('r'::"char", 'INSERT'::TEXT),
            ('r'::"char", 'UPDATE'::TEXT),
            ('r'::"char", 'DELETE'::TEXT),
            ('r'::"char", 'TRUNCATE'::TEXT),
            ('r'::"char", 'REFERENCES'::TEXT),
            ('r'::"char", 'TRIGGER'::TEXT),
            ('S'::"char", 'USAGE'::TEXT),
            ('S'::"char", 'SELECT'::TEXT),
            ('S'::"char", 'UPDATE'::TEXT),
            ('f'::"char", 'EXECUTE'::TEXT)
        ) AS expected_acl(object_type, privilege_type)
    LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_default_acl AS defaults
         CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS privilege
          JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
         WHERE defaults.defaclrole = pg_catalog.to_regrole('postgres')
           AND defaults.defaclnamespace = pg_catalog.to_regnamespace('public')
           AND defaults.defaclobjtype = expected.object_type
           AND grantee.rolname = api_role
           AND privilege.privilege_type = expected.privilege_type
      ) THEN
        RAISE EXCEPTION 'SUPABASE_CI_DEFAULT_ACL_MISSING:%:%:%',
          api_role, expected.object_type, expected.privilege_type;
      END IF;
    END LOOP;
  END LOOP;
END;
$certificate$;
SQL

echo "Ephemeral Supabase deployer profile certified"
