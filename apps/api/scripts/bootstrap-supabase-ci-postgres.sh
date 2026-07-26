#!/usr/bin/env sh
set -eu

: "${CI_POSTGRES_SUPER_URL:?CI_POSTGRES_SUPER_URL ephemeral bootstrap URL is required}"
: "${CI_POSTGRES_ADMIN_URL:?CI_POSTGRES_ADMIN_URL ephemeral internal admin URL is required}"
: "${DIRECT_URL:?DIRECT_URL release URL is required}"

if [ "${GITHUB_ACTIONS:-false}" != "true" ] \
  && [ "${BOB_SUPABASE_CI_BOOTSTRAP_CONFIRMATION:-}" != "EPHEMERAL_LOOPBACK_ONLY" ]; then
  echo "Supabase CI bootstrap is restricted to GitHub Actions or an explicitly confirmed ephemeral local cluster" >&2
  exit 1
fi

# Ce harnais ne doit jamais devenir un outil d'exploitation. Il reproduit uniquement, sur le
# PostgreSQL loopback jetable de GitHub Actions, le profil Supabase où `postgres` est le déployeur
# LOGIN non-superuser (CREATEROLE + BYPASSRLS) et où un superuser interne distinct reste caché.
node - "$CI_POSTGRES_SUPER_URL" "$CI_POSTGRES_ADMIN_URL" "$DIRECT_URL" <<'NODE'
const [bootstrapRaw, adminRaw, directRaw] = process.argv.slice(2);
const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
const allowedDatabases = new Set([
  '/bob_ephemeral_ci',
  '/bob_ephemeral_global_capacity',
  '/bob_ephemeral_key_rotation',
]);

const parse = (raw, name, expectedUser, expectedPassword) => {
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
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${name} must not contain connection parameters or fragments`);
  }
  if (parsed.port === '') {
    throw new Error(`${name} must use an explicit ephemeral port`);
  }
  if (!allowedDatabases.has(parsed.pathname)) {
    throw new Error(`${name} must target an allowlisted ephemeral CI database`);
  }
  if (decodeURIComponent(parsed.username) !== expectedUser) {
    throw new Error(`${name} must use the expected ephemeral identity`);
  }
  if (decodeURIComponent(parsed.password) !== expectedPassword) {
    throw new Error(`${name} must use the expected ephemeral credential`);
  }
  return parsed;
};

const bootstrap = parse(
  bootstrapRaw,
  'CI_POSTGRES_SUPER_URL',
  'postgres',
  'postgres',
);
const admin = parse(
  adminRaw,
  'CI_POSTGRES_ADMIN_URL',
  'bob_ci_supabase_admin',
  'bob_ci_supabase_admin',
);
const direct = parse(directRaw, 'DIRECT_URL', 'postgres', 'postgres');
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

# Aucun PG* ambiant ne peut substituer un service, un socket ou un autre endpoint aux URI validées.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGOPTIONS

bootstrap_network_mode=loopback
if [ "${GITHUB_ACTIONS:-false}" = "true" ]; then
  # Le runner atteint le service PostgreSQL via localhost, mais Docker DNAT présente au serveur
  # deux adresses RFC1918. Les URI restent strictement loopback et sans paramètre libpq.
  bootstrap_network_mode=github-actions-service
fi

psql "$CI_POSTGRES_SUPER_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v bootstrap_network_mode="$bootstrap_network_mode" <<'SQL'
SELECT pg_catalog.set_config(
  'bob.supabase_ci_bootstrap_network_mode',
  :'bootstrap_network_mode',
  TRUE
);
DO $bootstrap$
DECLARE
  bootstrap_role pg_catalog.pg_roles%ROWTYPE;
  bootstrap_network_mode TEXT :=
    current_setting('bob.supabase_ci_bootstrap_network_mode');
  server_address INET := pg_catalog.inet_server_addr();
  client_address INET := pg_catalog.inet_client_addr();
BEGIN
  IF bootstrap_network_mode NOT IN ('loopback', 'github-actions-service')
     OR server_address IS NULL
     OR client_address IS NULL
     OR (
       bootstrap_network_mode = 'loopback'
       AND NOT (
         server_address <<= pg_catalog.inet '127.0.0.0/8'
         OR server_address = pg_catalog.inet '::1'
       )
     )
     OR (
       bootstrap_network_mode = 'github-actions-service'
       AND NOT (
         server_address <<= pg_catalog.inet '127.0.0.0/8'
         OR server_address = pg_catalog.inet '::1'
         OR (
           (
             server_address <<= pg_catalog.inet '10.0.0.0/8'
             OR server_address <<= pg_catalog.inet '172.16.0.0/12'
             OR server_address <<= pg_catalog.inet '192.168.0.0/16'
             OR server_address <<= pg_catalog.inet 'fc00::/7'
           )
           AND (
             client_address <<= pg_catalog.inet '10.0.0.0/8'
             OR client_address <<= pg_catalog.inet '172.16.0.0/12'
             OR client_address <<= pg_catalog.inet '192.168.0.0/16'
             OR client_address <<= pg_catalog.inet 'fc00::/7'
           )
         )
       )
     )
     OR current_database() NOT IN (
       'bob_ephemeral_ci',
       'bob_ephemeral_global_capacity',
       'bob_ephemeral_key_rotation'
     )
     OR current_setting('server_version_num')::INTEGER < 160000
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
          AND namespace.nspname <> 'information_schema'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ) THEN
    RAISE EXCEPTION 'SUPABASE_CI_BOOTSTRAP_TARGET_IS_NOT_EPHEMERAL_LOOPBACK';
  END IF;

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

-- Le rejeu RLS possède des helpers SECURITY DEFINER qui lisent des tables FORCE RLS avec
-- row_security=off. Leur owner doit donc être BYPASSRLS, tout en restant NOLOGIN. Le déployeur
-- non-superuser crée d'abord ce rôle avec son adhésion SET implicite (jamais de GRANT visant
-- postgres) ; l'admin interne ne fait ensuite qu'attacher l'attribut réservé au superuser.
SET createrole_self_grant = 'set';
SET ROLE postgres;
CREATE ROLE bob_rls_schema_owner_cert
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
RESET ROLE;
ALTER ROLE bob_rls_schema_owner_cert BYPASSRLS;

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
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']::TEXT[] LOOP
    IF pg_catalog.to_regrole(api_role) IS NULL THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS',
        api_role
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('service_role') IS NULL THEN
    CREATE ROLE service_role
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION BYPASSRLS;
  END IF;
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
  bootstrap_admin pg_catalog.pg_roles%ROWTYPE;
  internal_admin pg_catalog.pg_roles%ROWTYPE;
  data_api_role pg_catalog.pg_roles%ROWTYPE;
  rls_owner pg_catalog.pg_roles%ROWTYPE;
  has_set_membership BOOLEAN;
  has_admin_membership BOOLEAN;
  has_inherit_membership BOOLEAN;
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
    INTO STRICT bootstrap_admin
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_ci_bootstrap_superuser';
  IF bootstrap_admin.rolcanlogin OR NOT bootstrap_admin.rolsuper THEN
    RAISE EXCEPTION 'SUPABASE_CI_BOOTSTRAP_ADMIN_PROFILE_MISMATCH';
  END IF;

  SELECT *
    INTO STRICT internal_admin
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_ci_supabase_admin';
  IF internal_admin.rolcanlogin OR NOT internal_admin.rolsuper THEN
    RAISE EXCEPTION 'SUPABASE_CI_INTERNAL_ADMIN_PROFILE_MISMATCH';
  END IF;

  SELECT *
    INTO STRICT rls_owner
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_rls_schema_owner_cert';
  IF rls_owner.rolcanlogin
     OR rls_owner.rolsuper
     OR rls_owner.rolcreatedb
     OR rls_owner.rolcreaterole
     OR rls_owner.rolinherit
     OR rls_owner.rolreplication
     OR NOT rls_owner.rolbypassrls THEN
    RAISE EXCEPTION 'SUPABASE_CI_RLS_OWNER_PROFILE_MISMATCH';
  END IF;

  SELECT COALESCE(pg_catalog.bool_or(membership.set_option), FALSE),
         COALESCE(pg_catalog.bool_or(membership.admin_option), FALSE),
         COALESCE(pg_catalog.bool_or(membership.inherit_option), FALSE)
    INTO STRICT has_set_membership, has_admin_membership, has_inherit_membership
    FROM pg_catalog.pg_auth_members AS membership
   WHERE membership.roleid = rls_owner.oid
     AND membership.member = current_user::pg_catalog.regrole;
  IF NOT pg_catalog.pg_has_role(current_user, rls_owner.oid, 'SET')
     OR pg_catalog.pg_has_role(current_user, rls_owner.oid, 'USAGE')
     OR NOT has_set_membership
     OR NOT has_admin_membership
     OR has_inherit_membership
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.roleid = rls_owner.oid
          AND membership.member <> current_user::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = rls_owner.oid
     ) THEN
    RAISE EXCEPTION 'SUPABASE_CI_RLS_OWNER_MEMBERSHIP_MISMATCH';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    SELECT *
      INTO STRICT data_api_role
      FROM pg_catalog.pg_roles
     WHERE rolname = api_role;
    IF data_api_role.rolcanlogin
       OR data_api_role.rolsuper
       OR data_api_role.rolcreatedb
       OR data_api_role.rolcreaterole
       OR data_api_role.rolreplication
       OR NOT data_api_role.rolinherit
       OR (api_role = 'service_role' AND NOT data_api_role.rolbypassrls)
       OR (api_role <> 'service_role' AND data_api_role.rolbypassrls)
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
