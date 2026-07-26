#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DATABASE_URL:?DATABASE_URL runtime app-role is required}"
: "${DIRECT_URL:?DIRECT_URL privileged admin URL is required}"

provision_mistral_bootstrap_reaper() {
  command -v psql >/dev/null 2>&1 || {
    echo "psql is required to certify the bootstrap retention reaper" >&2
    exit 1
  }
  runtime_role="$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c 'SELECT current_user::text')"
  if [ -z "$runtime_role" ]; then
    echo "unable to resolve Mistral bootstrap reaper runtime role" >&2
    exit 1
  fi

  # Ferme d'abord tout ancien membership runtime. Le rôle DIRECT_URL courant reste le seul
  # membre autorisé, uniquement pour transférer et attester l'ownership des fonctions.
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v runtime_role="$runtime_role" <<'SQL'
-- Supabase intercepte fatalement tout GRANT/REVOKE d'adhesion visant postgres
-- (connexion tuee) : adhesion SET accordee IMPLICITEMENT a la creation
-- (createrole_self_grant, PG16+), sans aucun fallback GRANT explicite.
SET createrole_self_grant = 'set';

SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_mistral_bootstrap_reaper'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'bob_mistral_bootstrap_reaper'
) \gexec

DO $$
DECLARE
  deployer_oid OID;
  deployer_is_superuser BOOLEAN;
  owner_oid OID;
BEGIN
  SELECT role.oid, role.rolsuper
    INTO STRICT deployer_oid, deployer_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = current_user;
  SELECT role.oid
    INTO STRICT owner_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_mistral_bootstrap_reaper';

  IF NOT pg_catalog.pg_has_role(current_user, owner_oid, 'SET')
     OR (
       NOT deployer_is_superuser
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = owner_oid
            AND membership.member = deployer_oid
            AND membership.set_option
            AND NOT membership.inherit_option
       )
     ) THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper is not available through implicit SET membership; create it as this deployer with createrole_self_grant=set before retrying';
  END IF;
END;
$$;

-- CREATEROLE suffit pour verrouiller les attributs administrables. PostgreSQL reserve la
-- reassertion de NOSUPERUSER/NOBYPASSRLS/NOREPLICATION au superuser : on les atteste donc sans
-- les modifier, afin que DIRECT_URL puisse rester un vrai role non-superuser en production.
ALTER ROLE bob_mistral_bootstrap_reaper
  NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT;

DO $$
DECLARE
  reaper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT reaper
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_mistral_bootstrap_reaper';

  IF reaper.rolcanlogin
     OR reaper.rolsuper
     OR reaper.rolcreatedb
     OR reaper.rolcreaterole
     OR reaper.rolinherit
     OR reaper.rolreplication
     OR reaper.rolbypassrls THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper must remain NOLOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOREPLICATION/NOBYPASSRLS';
  END IF;
END;
$$;

SELECT format('REVOKE %I FROM %I CASCADE', parent_role.rolname, 'bob_mistral_bootstrap_reaper')
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent_role ON parent_role.oid = membership.roleid
 WHERE membership.member = 'bob_mistral_bootstrap_reaper'::regrole
   AND parent_role.rolname <> 'postgres'
\gexec

SELECT format('REVOKE %I FROM %I CASCADE', 'bob_mistral_bootstrap_reaper', member_role.rolname)
 FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
 WHERE membership.roleid = 'bob_mistral_bootstrap_reaper'::regrole
   AND member_role.rolname NOT IN (current_user, 'postgres')
\gexec

DO $$
DECLARE
  owner_oid OID;
BEGIN
  SELECT role.oid
    INTO STRICT owner_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_mistral_bootstrap_reaper';

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = owner_oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
     WHERE membership.roleid = owner_oid
       AND member_role.rolname <> current_user
  ) THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper has an unexpected member; membership remediation must be performed outside this certification without targeting postgres';
  END IF;
END;
$$;
SQL

  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v runtime_role="$runtime_role" <<'SQL'
SELECT pg_catalog.set_config('bob.mistral_reaper_app_role', :'runtime_role', true);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (
       'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure,
       'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
     )
       AND function.proowner NOT IN (
         (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user),
         'bob_mistral_bootstrap_reaper'::regrole
       )
  ) THEN
    RAISE EXCEPTION 'Mistral retention function has an unexpected owner';
  END IF;
END;
$$;

-- Le droit CREATE n'est accorde que le temps du transfert d'ownership impose par PostgreSQL.
-- La transaction complete revient en arriere si sa revocation ou l'attestation finale echoue.
GRANT CREATE ON SCHEMA public TO bob_mistral_bootstrap_reaper;

SELECT format(
  'ALTER FUNCTION %s OWNER TO bob_mistral_bootstrap_reaper',
  function.oid::regprocedure
)
  FROM pg_catalog.pg_proc AS function
 WHERE function.oid IN (
   'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure,
   'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
 )
   AND function.proowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec

SET LOCAL ROLE bob_mistral_bootstrap_reaper;
REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  FROM PUBLIC;
SELECT format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
  function.oid::regprocedure,
  grantee.rolname
)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE function.oid IN (
   'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure,
   'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
 )
   AND privilege.grantee <> function.proowner
   AND grantee.rolname <> :'runtime_role'
 GROUP BY function.oid, grantee.rolname
 ORDER BY bool_or(privilege.is_grantable) DESC, function.oid, grantee.rolname
\gexec
ALTER FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  SET row_security = on;
ALTER FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  SET row_security = on;
REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  FROM :"runtime_role" CASCADE;
REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  FROM :"runtime_role" CASCADE;
GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  TO :"runtime_role";
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM bob_mistral_bootstrap_reaper;
GRANT USAGE ON SCHEMA public TO bob_mistral_bootstrap_reaper;
REVOKE ALL ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_terminal_receipts,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_session_leases
  FROM bob_mistral_bootstrap_reaper;
SELECT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM bob_mistral_bootstrap_reaper CASCADE',
  attribute.attname,
  namespace.nspname,
  target.relname
)
  FROM pg_catalog.pg_class AS target
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
 WHERE namespace.nspname = 'public'
   AND target.relname IN (
     'realtime_mistral_conversation_bootstrap_tickets',
     'realtime_mistral_conversation_missions',
     'realtime_mistral_conversation_terminal_receipts',
     'realtime_mistral_conversation_resume_tickets',
     'realtime_mistral_conversation_outbox',
     'realtime_mistral_conversation_commands',
     'realtime_session_leases'
   )
   AND privilege.grantee = 'bob_mistral_bootstrap_reaper'::regrole
 GROUP BY namespace.nspname, target.relname, attribute.attname
\gexec
SELECT format(
  'REVOKE GRANT OPTION FOR %s ON TABLE %I.%I FROM %I CASCADE',
  privilege.privilege_type,
  namespace.nspname,
  target.relname,
  grantee.rolname
)
  FROM pg_catalog.pg_class AS target
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
 CROSS JOIN LATERAL pg_catalog.aclexplode(target.relacl) AS privilege
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE namespace.nspname = 'public'
   AND target.relname IN (
     'realtime_mistral_conversation_bootstrap_tickets',
     'realtime_mistral_conversation_missions',
     'realtime_mistral_conversation_terminal_receipts',
     'realtime_mistral_conversation_resume_tickets',
     'realtime_mistral_conversation_outbox',
     'realtime_mistral_conversation_commands',
     'realtime_session_leases'
   )
   AND privilege.is_grantable
   AND privilege.grantee <> target.relowner
 ORDER BY namespace.nspname, target.relname, grantee.rolname, privilege.privilege_type
\gexec
SELECT format(
  'REVOKE GRANT OPTION FOR %s (%I) ON TABLE %I.%I FROM %I CASCADE',
  privilege.privilege_type,
  attribute.attname,
  namespace.nspname,
  target.relname,
  grantee.rolname
)
  FROM pg_catalog.pg_class AS target
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE namespace.nspname = 'public'
   AND target.relname IN (
     'realtime_mistral_conversation_bootstrap_tickets',
     'realtime_mistral_conversation_missions',
     'realtime_mistral_conversation_terminal_receipts',
     'realtime_mistral_conversation_resume_tickets',
     'realtime_mistral_conversation_outbox',
     'realtime_mistral_conversation_commands',
     'realtime_session_leases'
   )
   AND privilege.is_grantable
   AND privilege.grantee <> target.relowner
 ORDER BY namespace.nspname, target.relname, attribute.attname, grantee.rolname,
          privilege.privilege_type
\gexec
REVOKE ALL PRIVILEGES ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_terminal_receipts,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_session_leases
  FROM PUBLIC CASCADE;
SELECT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM PUBLIC CASCADE',
  attribute.attname,
  namespace.nspname,
  target.relname
)
  FROM pg_catalog.pg_class AS target
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
 WHERE namespace.nspname = 'public'
   AND target.relname IN (
     'realtime_mistral_conversation_bootstrap_tickets',
     'realtime_mistral_conversation_missions',
     'realtime_mistral_conversation_terminal_receipts',
     'realtime_mistral_conversation_resume_tickets',
     'realtime_mistral_conversation_outbox',
     'realtime_mistral_conversation_commands',
     'realtime_session_leases'
   )
   AND privilege.grantee = 0
 GROUP BY namespace.nspname, target.relname, attribute.attname
\gexec
GRANT SELECT (id, "companyId", "admissionSessionId", "retentionExpiresAt")
  ON TABLE public.realtime_mistral_conversation_bootstrap_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_bootstrap_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT UPDATE (id) ON TABLE public.realtime_mistral_conversation_bootstrap_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT (
  id, "companyId", "sessionHandle", "initialBootstrapId", phase,
  "subjectHash", "subjectKeyVersion", protocol, "missionConnectionEpoch",
  "retainedFromServerSequence", "nextServerSequence", "terminalReason", "closedAt",
  "replayGraceExpiresAt", "retentionExpiresAt"
) ON TABLE public.realtime_mistral_conversation_missions
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_missions
  TO bob_mistral_bootstrap_reaper;
GRANT UPDATE (id) ON TABLE public.realtime_mistral_conversation_missions
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT (
  "companyId", "sessionHandle", "subjectHash", "subjectKeyVersion", protocol,
  "missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt"
) ON TABLE public.realtime_mistral_conversation_terminal_receipts
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT (
  id, "missionId", "companyId", "sessionHandle", "initialBootstrapId", "retentionExpiresAt"
) ON TABLE public.realtime_mistral_conversation_resume_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_resume_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT UPDATE (id) ON TABLE public.realtime_mistral_conversation_resume_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT (
  "missionId", "companyId", "sessionHandle", "serverSequence", "retentionExpiresAt"
)
  ON TABLE public.realtime_mistral_conversation_outbox
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_outbox
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT ("missionId", "companyId", "sessionHandle", "retentionExpiresAt")
  ON TABLE public.realtime_mistral_conversation_commands
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_commands
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT ("companyId", "sessionId") ON TABLE public.realtime_session_leases
  TO bob_mistral_bootstrap_reaper;

REVOKE bob_mistral_bootstrap_reaper FROM :"runtime_role" CASCADE;
REVOKE TRUNCATE ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_terminal_receipts,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_session_leases
  FROM :"runtime_role";
REVOKE DELETE ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_mistral_conversation_terminal_receipts
  FROM :"runtime_role";

DO $$
DECLARE
  database_oid OID;
  app_role_name TEXT := NULLIF(
    pg_catalog.current_setting('bob.mistral_reaper_app_role', true),
    ''
  );
  app_role_oid OID;
  legacy_oid OID :=
    'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure;
  ordered_oid OID :=
    'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure;
BEGIN
  SELECT oid INTO app_role_oid
    FROM pg_catalog.pg_roles
   WHERE rolname = app_role_name;
  IF app_role_oid IS NULL THEN
    RAISE EXCEPTION 'Mistral retention runtime role does not exist';
  END IF;

  SELECT oid INTO STRICT database_oid
    FROM pg_catalog.pg_database
   WHERE datname = current_database();

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_shdepend AS ownership
     WHERE ownership.refclassid = 'pg_authid'::regclass
       AND ownership.refobjid = 'bob_mistral_bootstrap_reaper'::regrole
       AND ownership.deptype = 'o'
       AND (ownership.dbid = 0 OR ownership.dbid = database_oid)
       AND NOT (
         ownership.dbid = database_oid
         AND ownership.classid = 'pg_proc'::regclass
         AND ownership.objid IN (legacy_oid, ordered_oid)
         AND ownership.objsubid = 0
       )
  ) THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper owns an object outside the two retention functions';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (legacy_oid, ordered_oid)
       AND (
         function.proowner <> 'bob_mistral_bootstrap_reaper'::regrole
         OR NOT function.prosecdef
         OR cardinality(COALESCE(function.proconfig, ARRAY[]::text[])) <> 2
         OR NOT COALESCE(function.proconfig, ARRAY[]::text[])
                @> ARRAY['search_path=pg_catalog', 'row_security=on']
       )
  ) THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper function ownership or SECURITY DEFINER config is invalid';
  END IF;

  IF pg_catalog.has_schema_privilege(
    'bob_mistral_bootstrap_reaper',
    'public',
    'CREATE'
  ) THEN
    RAISE EXCEPTION 'bob_mistral_bootstrap_reaper retains CREATE on schema public';
  END IF;

  IF pg_catalog.pg_has_role(
       app_role_oid,
       'bob_mistral_bootstrap_reaper'::regrole,
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       app_role_oid,
       'bob_mistral_bootstrap_reaper'::regrole,
       'SET'
     ) THEN
    RAISE EXCEPTION 'Mistral retention runtime role is a member of or can SET ROLE to the reaper';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid IN (legacy_oid, ordered_oid)
       AND (
         privilege.privilege_type <> 'EXECUTE'
         OR privilege.grantee = 0
         OR (
           privilege.grantee <> function.proowner
           AND privilege.grantee <> app_role_oid
         )
         OR (
           privilege.grantee = app_role_oid
           AND (privilege.grantor <> function.proowner OR privilege.is_grantable)
         )
       )
  ) THEN
    RAISE EXCEPTION 'Mistral retention function ACL contains an unexpected grant';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (legacy_oid, ordered_oid)
       AND (
         SELECT count(*)
           FROM pg_catalog.aclexplode(
             COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
           ) AS privilege
          WHERE privilege.grantee = app_role_oid
            AND privilege.grantor = function.proowner
            AND privilege.privilege_type = 'EXECUTE'
            AND NOT privilege.is_grantable
       ) <> 1
  ) THEN
    RAISE EXCEPTION 'Mistral retention runtime EXECUTE grant is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS target
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(target.relacl, pg_catalog.acldefault('r', target.relowner))
     ) AS privilege
     WHERE namespace.nspname = 'public'
       AND target.relname IN (
         'realtime_mistral_conversation_bootstrap_tickets',
         'realtime_mistral_conversation_missions',
         'realtime_mistral_conversation_terminal_receipts',
         'realtime_mistral_conversation_resume_tickets',
         'realtime_mistral_conversation_outbox',
         'realtime_mistral_conversation_commands',
         'realtime_session_leases'
       )
       AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS target
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
     WHERE namespace.nspname = 'public'
       AND target.relname IN (
         'realtime_mistral_conversation_bootstrap_tickets',
         'realtime_mistral_conversation_missions',
         'realtime_mistral_conversation_terminal_receipts',
         'realtime_mistral_conversation_resume_tickets',
         'realtime_mistral_conversation_outbox',
         'realtime_mistral_conversation_commands',
         'realtime_session_leases'
       )
       AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'Mistral retention scoped table or column ACL exposes PUBLIC';
  END IF;
END;
$$;
SQL
}

provision_mistral_bootstrap_reaper

case "${BOB_LIVE_MISTRAL_V2_PROVISION_ONLY:-false}" in
  true) exit 0 ;;
  false) ;;
  *)
    echo "BOB_LIVE_MISTRAL_V2_PROVISION_ONLY must be true or false" >&2
    exit 1
    ;;
esac

RUN_POSTGRES_MISTRAL_CONVERSATION_CERT=true \
  pnpm --filter @bob/api exec vitest run \
    --fileParallelism=false \
    src/voice/realtime/mistral-conversation-key-version.postgres.test.ts \
    src/voice/realtime/mistral-conversation-subject-key-version.postgres.test.ts

if [ "${RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT:-false}" = "true" ]; then
  # Ce certificat initialise le key-space identité sur la base éphémère encore sans bootstrap,
  # puis prouve la course old-writer/retire. Les suites suivantes réutilisent sa plage mixte.
  RUN_POSTGRES_MISTRAL_IDENTITY_KEY_ROTATION_CERT=true \
    pnpm --filter @bob/api exec vitest run \
      --fileParallelism=false \
      src/voice/realtime/mistral-conversation-identity-key-version-lifecycle.postgres.test.ts

  RUN_POSTGRES_MISTRAL_CONVERSATION_CERT=true \
  RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_CERT=true \
  RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_CERT=true \
  RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_CERT=true \
  RUN_POSTGRES_MISTRAL_CONVERSATION_LEASE_FENCE_CERT=true \
  RUN_POSTGRES_MISTRAL_CONVERSATION_REAPER_TERMINATION_CERT=true \
    pnpm --filter @bob/api exec vitest run \
      --fileParallelism=false \
      src/voice/realtime/mistral-conversation-authority.postgres.test.ts \
      src/voice/realtime/mistral-conversation-resume-ticket.postgres.test.ts \
      src/voice/realtime/mistral-conversation-bootstrap-ticket.postgres.test.ts \
      src/voice/realtime/mistral-conversation-bootstrap-reaper.postgres.test.ts \
      src/voice/realtime/mistral-conversation-bootstrap-reconciliation.postgres.test.ts \
      src/voice/realtime/mistral-conversation-admission-delete-fence.postgres.test.ts \
      src/voice/realtime/mistral-conversation-reaper-termination.postgres.test.ts
fi
