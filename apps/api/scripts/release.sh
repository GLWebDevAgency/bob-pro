#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DATABASE_URL:?DATABASE_URL runtime app-role is required}"
: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
: "${RUN_RLS_CERT:?RUN_RLS_CERT=true is required}"
: "${RLS_CERT_CLEANUP:?RLS_CERT_CLEANUP=true is required}"

if [ "$RUN_RLS_CERT" != "true" ] || [ "$RLS_CERT_CLEANUP" != "true" ]; then
  echo "RUN_RLS_CERT=true and RLS_CERT_CLEANUP=true are mandatory" >&2
  exit 1
fi

cleanup_rls_cert() {
  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert-cleanup.sql
}

grant_app_role() {
  if [ -z "${APP_DATABASE_ROLE:-}" ]; then
    echo "APP_DATABASE_ROLE unset; skipping explicit runtime grants"
    return 0
  fi

  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="$APP_DATABASE_ROLE" <<'SQL'
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
-- TRUNCATE n'est jamais une capacité runtime. La liste explicite répare aussi un ancien ACL,
-- y compris sur le lease dont le DELETE ciblé reste nécessaire à l'autorité de terminaison.
REVOKE TRUNCATE ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_terminal_receipts,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_session_leases
FROM :"app_role";
-- Ces registres sont append-only pour le role runtime. Les policies RLS seules ne
-- suffisent pas : un futur changement de policy ne doit pas reactiver leur mutation.
REVOKE UPDATE, DELETE ON TABLE
  public.document_analyses,
  public.expense_creation_requests,
  public.quote_creation_requests,
  public.bank_balance_snapshots
FROM :"app_role";
-- Une société se clôture, elle ne se supprime jamais depuis le runtime : son identité légale
-- reste nécessaire aux pièces conservées et un DELETE suivi d'un INSERT la ressusciterait.
REVOKE DELETE ON TABLE public.companies FROM :"app_role";
REVOKE DELETE, TRUNCATE ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_speech_artifacts,
  public.stripe_subscription_invoices
FROM :"app_role";
REVOKE UPDATE, DELETE ON TABLE
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_control_grants,
  public.realtime_control_consumptions,
  public.realtime_voice_usage_events
FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE ON TABLE public.realtime_voice_usage_daily FROM :"app_role";
-- Les registres globaux de versions sont monotones, append-only et isolés par keySpace. Le runtime
-- peut seulement les lire ; seul DIRECT_URL prépare ou retire une version au déploiement.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.realtime_mistral_conversation_key_version_floors,
  public.realtime_mistral_conversation_key_bindings,
  public.realtime_mistral_conversation_identity_key_version_floors,
  public.realtime_mistral_conversation_identity_key_bindings,
  public.realtime_mistral_conversation_terminal_receipts
FROM :"app_role";
REVOKE ALL ON FUNCTION public.retained_bob_live_subject_hmac_key_bindings()
  FROM :"app_role";
GRANT EXECUTE ON FUNCTION public.retained_bob_live_subject_hmac_key_bindings()
  TO :"app_role";
-- Le runtime invoque uniquement les deux capacités SECURITY DEFINER bornées. Il ne peut jamais
-- endosser le rôle propriétaire NOLOGIN ni atteindre ses ACL de table sous-jacentes.
REVOKE bob_mistral_bootstrap_reaper FROM :"app_role" CASCADE;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
SQL
}

ensure_mistral_bootstrap_reaper_role() {
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" <<'SQL'
SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_mistral_bootstrap_reaper'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'bob_mistral_bootstrap_reaper'
) \gexec

-- Un role DIRECT_URL CREATEROLE non-superuser peut verrouiller ces attributs, mais PostgreSQL
-- lui interdit de reaffirmer NOSUPERUSER/NOBYPASSRLS/NOREPLICATION, meme a false. On atteste donc
-- ces trois attributs ci-dessous au lieu de rendre le rejeu dependant d'un superuser.
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

-- Le rôle propriétaire n'hérite d'aucun autre rôle. Réciproquement, aucun rôle de connexion ne
-- peut l'endosser : seul le rôle DIRECT_URL courant reste membre le temps de transférer/attester
-- l'ownership des deux fonctions bornées.
SELECT format('REVOKE %I FROM %I CASCADE', parent_role.rolname, 'bob_mistral_bootstrap_reaper')
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent_role ON parent_role.oid = membership.roleid
 WHERE membership.member = 'bob_mistral_bootstrap_reaper'::regrole
\gexec

SELECT format('REVOKE %I FROM %I CASCADE', 'bob_mistral_bootstrap_reaper', member_role.rolname)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
 WHERE membership.roleid = 'bob_mistral_bootstrap_reaper'::regrole
   AND member_role.rolname <> current_user
\gexec

GRANT bob_mistral_bootstrap_reaper TO CURRENT_USER
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SQL
}

provision_mistral_bootstrap_reaper() {
  ensure_mistral_bootstrap_reaper_role
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" <<'SQL'
SELECT pg_catalog.set_config('bob.mistral_reaper_app_role', :'app_role', true);

-- Première installation : DIRECT_URL possède encore les fonctions créées par la migration.
-- Rejeu : elles appartiennent déjà au NOLOGIN. Tout autre owner est refusé avant mutation.
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

-- PostgreSQL exige que le nouvel owner ait CREATE sur le schema lors d'un transfert. Cette
-- capacite n'existe que dans cette transaction d'administration et est retiree avant COMMIT.
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

-- L'idempotence est explicite : au premier passage comme aux suivants, la configuration et les
-- ACL fonctionnelles sont appliquées en endossant leur owner exact, puis le rôle est relâché.
SET LOCAL ROLE bob_mistral_bootstrap_reaper;
REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  FROM PUBLIC;
-- Un ancien rôle, même transitivement hérité par le runtime, ne doit conserver aucun EXECUTE.
-- Le propriétaire normalise toutes les ACL avant de recréer l'unique grant runtime attendu.
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
   AND (:'app_role' = '' OR grantee.rolname <> :'app_role')
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
SELECT format(
  'REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER) FROM %I CASCADE',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER) FROM %I CASCADE',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER) TO %I',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER) TO %I',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
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
-- REVOKE table ne retire pas les ACL de colonnes PostgreSQL. Le rejeu retire donc tout ancien
-- droit de colonne du reaper avant de reconstruire exactement son contrat minimal ci-dessous.
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
-- Une délégation tierce vers PUBLIC ne peut pas être retirée par le seul owner. On casse donc
-- d'abord chaque grant option non propriétaire, en cascade, tout en conservant son droit de base.
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
-- Les droits effectifs du reaper ne doivent jamais provenir de PUBLIC. Les ACL de colonnes
-- PUBLIC sont elles aussi nettoyees explicitement et en cascade.
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

-- Le runtime ne reçoit que l'entrée fonctionnelle ; toute mutation SQL directe et toute
-- capacité SET ROLE restent fermées, y compris lors d'une release rejouée sur un ancien ACL.
SELECT format('REVOKE %I FROM %I', 'bob_mistral_bootstrap_reaper', :'app_role')
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'REVOKE TRUNCATE ON TABLE %s FROM %I',
  'public.realtime_mistral_conversation_bootstrap_tickets,
   public.realtime_mistral_conversation_missions,
   public.realtime_mistral_conversation_terminal_receipts,
   public.realtime_mistral_conversation_resume_tickets,
   public.realtime_mistral_conversation_outbox,
   public.realtime_mistral_conversation_commands,
   public.realtime_session_leases',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'REVOKE DELETE ON TABLE %s FROM %I',
  'public.realtime_mistral_conversation_bootstrap_tickets,
   public.realtime_mistral_conversation_missions,
   public.realtime_mistral_conversation_resume_tickets,
   public.realtime_mistral_conversation_outbox,
   public.realtime_mistral_conversation_commands,
   public.realtime_mistral_conversation_terminal_receipts',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
-- Le rôle peut posséder exactement ces deux fonctions et aucun autre objet de cette base. La
-- recherche de dépendances d'ownership attrape tables, schémas, types et objets futurs sans
-- entretenir une liste fragile par catalogue.
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
  IF app_role_name IS NOT NULL THEN
    SELECT oid INTO app_role_oid
      FROM pg_catalog.pg_roles
     WHERE rolname = app_role_name;
    IF app_role_oid IS NULL THEN
      RAISE EXCEPTION 'Mistral retention app role does not exist';
    END IF;
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

  IF app_role_oid IS NOT NULL
     AND (
       pg_catalog.pg_has_role(
         app_role_oid,
         'bob_mistral_bootstrap_reaper'::regrole,
         'MEMBER'
       )
       OR pg_catalog.pg_has_role(
         app_role_oid,
         'bob_mistral_bootstrap_reaper'::regrole,
         'SET'
       )
     ) THEN
    RAISE EXCEPTION 'Mistral retention app role is a member of or can SET ROLE to the reaper';
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
           AND privilege.grantee IS DISTINCT FROM app_role_oid
         )
         OR (
           privilege.grantee = app_role_oid
           AND (privilege.grantor <> function.proowner OR privilege.is_grantable)
         )
       )
  ) THEN
    RAISE EXCEPTION 'Mistral retention function ACL contains an unexpected grant';
  END IF;

  IF app_role_oid IS NOT NULL AND EXISTS (
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
    RAISE EXCEPTION 'Mistral retention app role EXECUTE grant is not exact';
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

certify_cabinet_worker_scope() {
  : "${CABINET_RELEASE_ENV:?CABINET_RELEASE_ENV is required}"
  : "${CABINET_INVITATION_WORKER_ENABLED:?CABINET_INVITATION_WORKER_ENABLED is required}"
  local_job_ids="${JOB_CABINET_IDS:-}"
  local_worker_id="${CABINET_INVITATION_WORKER_USER_ID:-}"
  distinct_job_count="$(printf '%s' "$local_job_ids" | tr ',' '\n' | awk '
    { gsub(/^[[:space:]]+|[[:space:]]+$/, "") }
    NF && !seen[$0]++ { count += 1 }
    END { print count + 0 }
  ')"
  if [ "$distinct_job_count" -gt 100 ]; then
    echo "JOB_CABINET_IDS is limited to 100 distinct pilot cabinets" >&2
    return 1
  fi
  if [ "$CABINET_INVITATION_WORKER_ENABLED" = "true" ]; then
    if [ -z "$local_job_ids" ] || [ -z "$local_worker_id" ]; then
      echo "enabled Cabinet worker requires JOB_CABINET_IDS and CABINET_INVITATION_WORKER_USER_ID" >&2
      return 1
    fi
  elif [ "$CABINET_INVITATION_WORKER_ENABLED" = "false" ]; then
    local_job_ids=""
    local_worker_id=""
  else
    echo "CABINET_INVITATION_WORKER_ENABLED must be true or false" >&2
    return 1
  fi

  invalid_global="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 -v release_env="$CABINET_RELEASE_ENV" <<'SQL'
SELECT count(*) FROM release_flags
 WHERE key = 'cabinet.slice0'
   AND environment = :'release_env'::"ReleaseEnvironment"
   AND enabled = true;
SQL
)"
  if [ "$invalid_global" != "0" ]; then
    echo "cabinet.slice0 global enablement is forbidden while outbox retention is pilot-scoped" >&2
    return 1
  fi

  invalid_targets="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -v release_env="$CABINET_RELEASE_ENV" -v job_ids="$local_job_ids" -v worker_id="$local_worker_id" <<'SQL'
SELECT count(*)
  FROM release_flag_subjects subject
  JOIN release_flags flag ON flag.id = subject."flagId"
 WHERE flag.key = 'cabinet.slice0'
   AND flag.environment = :'release_env'::"ReleaseEnvironment"
   AND subject.enabled = true
   AND (
     subject."subjectType" <> 'cabinet'
     OR NOT (subject."subjectId" = ANY(string_to_array(:'job_ids', ',')))
     OR NOT EXISTS (
       SELECT 1 FROM cabinets cabinet
       JOIN cabinet_members member ON member."cabinetId" = cabinet.id
        WHERE cabinet.id = subject."subjectId"
          AND cabinet.status = 'active'
          AND member."userId" = :'worker_id'
          AND member.role = 'admin'
          AND member.status = 'active'
     )
   );
SQL
)"
  if [ "$invalid_targets" != "0" ]; then
    echo "enabled cabinet pilots must be worker-covered cabinets with an active service admin" >&2
    return 1
  fi

  if [ "$CABINET_INVITATION_WORKER_ENABLED" = "true" ]; then
    invalid_jobs="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
      -v job_ids="$local_job_ids" -v worker_id="$local_worker_id" <<'SQL'
SELECT count(*)
  FROM unnest(string_to_array(:'job_ids', ',')) AS configured("cabinetId")
 WHERE btrim(configured."cabinetId") <> ''
   AND NOT EXISTS (
     SELECT 1 FROM cabinets cabinet
     JOIN cabinet_members member ON member."cabinetId" = cabinet.id
      WHERE cabinet.id = btrim(configured."cabinetId")
        AND cabinet.status = 'active'
        AND member."userId" = :'worker_id'
        AND member.role = 'admin'
        AND member.status = 'active'
   );
SQL
)"
    if [ "$invalid_jobs" != "0" ]; then
      echo "every JOB_CABINET_IDS entry requires an active ADMIN worker membership" >&2
      return 1
    fi
  fi
}

command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

node apps/api/scripts/assert-database-pair.mjs
node --test \
  apps/api/scripts/assert-database-pair.test.mjs \
  apps/api/scripts/assert-migration-lineage.test.mjs \
  apps/api/scripts/assert-applied-migration-checksums.test.mjs
# Avant la première mutation, toute migration déjà appliquée doit encore correspondre octet pour
# octet au dépôt. Les nouveaux fichiers locaux sont attendus jusqu'au migrate deploy.
node apps/api/scripts/assert-applied-migration-checksums.mjs --allow-pending-local
pnpm --filter '@bob/api...' run build

# Révoque tout ancien SET ROLE runtime avant même que la migration SECURITY DEFINER soit visible.
ensure_mistral_bootstrap_reaper_role
pnpm --filter @bob/api exec prisma migrate deploy
node apps/api/scripts/assert-applied-migration-checksums.mjs
provision_mistral_bootstrap_reaper
node apps/api/scripts/manage-mistral-conversation-key-version.mjs stage
grant_app_role
psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f apps/api/prisma/rls.sql

trap cleanup_rls_cert EXIT INT TERM
cleanup_rls_cert
node apps/api/scripts/bootstrap-cabinet-pilots.mjs
certify_cabinet_worker_scope
DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/certify-cabinet-concurrency.sh
DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/certify-release-flag-ops.sh
psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert-cabinet-seed.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert.sql
psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/cabinet-rls-cert-privileged.sql
RUN_POSTGRES_DEVICE_REBIND_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/devices.postgres.test.ts
RUN_POSTGRES_CATALOGUE_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/catalogue-chantiers.postgres.test.ts
RUN_POSTGRES_QUOTE_DRAFT_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/quote-draft-slots.postgres.test.ts
RUN_POSTGRES_EXPENSE_PAYMENT_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/expense-payment-evidence.postgres.test.ts
RUN_POSTGRES_BILLING_SETTINGS_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/company-billing-settings.postgres.test.ts
RUN_POSTGRES_COMPANY_MUTATION_LIFECYCLE_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/company-mutation-lifecycle.postgres.test.ts
RUN_POSTGRES_QUOTE_SIGNATURE_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/quote-signature-token-concurrency.postgres.test.ts
RUN_POSTGRES_PUBLIC_CAPABILITY_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/public-capability-lifecycle.postgres.test.ts
RUN_POSTGRES_INVOICE_ISSUE_LIFECYCLE_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/invoice-issue-lifecycle.postgres.test.ts
RUN_POSTGRES_STRIPE_INVOICES_CERT=true \
  pnpm --filter @bob/api exec vitest run src/persistence/prisma/stripe-subscription-invoices.postgres.test.ts
RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT=false \
RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT=false \
DATABASE_URL="$DATABASE_URL" DIRECT_URL="$DIRECT_URL" \
  sh apps/api/scripts/certify-mistral-conversation-authority.sh
cleanup_rls_cert
trap - EXIT INT TERM

echo "Bob Pro API release checks passed"
