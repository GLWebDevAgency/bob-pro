#!/usr/bin/env sh
set -eu

: "${DIRECT_URL:?DIRECT_URL non-superuser deployer URL is required}"
: "${DATABASE_URL:?DATABASE_URL non-superuser runtime URL is required}"

if [ "${GITHUB_ACTIONS:-false}" != "true" ] \
  && [ "${BOB_RLS_OWNER_SPLIT_CERT_CONFIRMATION:-}" != "EPHEMERAL_LOCAL_ONLY" ]; then
  echo "RLS owner-split certification is restricted to CI or an explicitly confirmed ephemeral database" >&2
  exit 1
fi

node apps/api/scripts/assert-database-pair.mjs

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

DO $rls_owner_split_membership$
DECLARE
  deployer_oid OID := current_user::pg_catalog.regrole;
  owner_oid OID := 'bob_rls_schema_owner_cert'::pg_catalog.regrole;
  owner_role pg_catalog.pg_roles%ROWTYPE;
  has_set_membership BOOLEAN;
  has_admin_membership BOOLEAN;
  has_inherit_membership BOOLEAN;
BEGIN
  SELECT *
    INTO STRICT owner_role
    FROM pg_catalog.pg_roles
   WHERE oid = owner_oid;
  IF owner_role.rolcanlogin
     OR owner_role.rolsuper
     OR owner_role.rolcreatedb
     OR owner_role.rolcreaterole
     OR owner_role.rolinherit
     OR owner_role.rolreplication
     OR NOT owner_role.rolbypassrls THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_OWNER_ROLE_PROFILE_DRIFT';
  END IF;

  -- L'owner est préprovisionné NOLOGIN+BYPASSRLS par l'admin interne éphémère : les helpers
  -- SECURITY DEFINER avec row_security=off doivent rester fonctionnels sous FORCE RLS. Son
  -- adhésion au déployeur, elle, vient uniquement de createrole_self_grant lors de la création.
  -- PostgreSQL 16+ peut matérialiser deux grants directs : ADMIN implicite depuis le bootstrap
  -- superuser, puis SET depuis le créateur via createrole_self_grant. Les options doivent donc
  -- être agrégées par couple role/member, jamais exigées sur une même ligne de grantor.
  SELECT COALESCE(pg_catalog.bool_or(membership.set_option), FALSE),
         COALESCE(pg_catalog.bool_or(membership.admin_option), FALSE),
         COALESCE(pg_catalog.bool_or(membership.inherit_option), FALSE)
    INTO STRICT has_set_membership, has_admin_membership, has_inherit_membership
    FROM pg_catalog.pg_auth_members AS membership
   WHERE membership.roleid = owner_oid
     AND membership.member = deployer_oid;

  IF NOT pg_catalog.pg_has_role(deployer_oid, owner_oid, 'SET')
     OR NOT has_set_membership
     OR NOT has_admin_membership
     OR has_inherit_membership THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_IMPLICIT_SET_MEMBERSHIP_MISSING';
  END IF;
  IF pg_catalog.pg_has_role(deployer_oid, owner_oid, 'USAGE') THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_EFFECTIVE_INHERITANCE_DRIFT';
  END IF;
END;
$rls_owner_split_membership$;

-- La base est jetable et le postdeploy est déjà achevé. Seuls les objets encore possédés par le
-- déployeur sont déplacés ; les autorités NOLOGIN spécialisées conservent leurs objets.
-- PostgreSQL exige que le nouvel owner ait CREATE sur le schéma au moment du transfert. Ce droit
-- n'existe que dans cette transaction et est retiré avant COMMIT ; le rôle conserve seulement
-- USAGE afin que le vrai rls.sql puisse être rejoué sous SET LOCAL ROLE.
GRANT CREATE ON SCHEMA public TO bob_rls_schema_owner_cert;

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

-- Le rejeu reste dans la même transaction que le droit CREATE temporaire : même un
-- CREATE OR REPLACE FUNCTION exige CREATE sur le schéma PostgreSQL. rls.sql bascule vers
-- l'owner exact ; RESET ROLE rend ensuite la main au déployeur qui a accordé le privilège.
\i apps/api/prisma/rls.sql
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM bob_rls_schema_owner_cert;
GRANT USAGE ON SCHEMA public TO bob_rls_schema_owner_cert;

DO $rls_owner_split_schema_acl$
BEGIN
  IF pg_catalog.has_schema_privilege(
       'bob_rls_schema_owner_cert',
       'public',
       'CREATE'
     )
     OR NOT pg_catalog.has_schema_privilege(
       'bob_rls_schema_owner_cert',
       'public',
       'USAGE'
     ) THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_SCHEMA_ACL_DRIFT';
  END IF;
END;
$rls_owner_split_schema_acl$;
SQL

# La preuve ne se contente pas de créer les helpers Cabinet : elle les invoque réellement via le
# rôle runtime NOBYPASSRLS après le transfert. Toute régression de l'owner SECURITY DEFINER, de
# FORCE RLS ou des policies de bootstrap échoue ; les données de sonde sont toujours rollbackées.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';
SET LOCAL app.current_user_id = 'rls-owner-split-runtime-user';
SET LOCAL app.current_cabinet_id = 'rls-owner-split-runtime-cabinet';

DO $runtime_role$
DECLARE
  runtime pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT *
    INTO STRICT runtime
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF current_user = 'postgres'
     OR runtime.rolsuper
     OR runtime.rolbypassrls THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_RUNTIME_ROLE_IS_PRIVILEGED';
  END IF;
END;
$runtime_role$;

INSERT INTO public.cabinets (
  id,
  name,
  "timeZone",
  status,
  "createdByUserId",
  "bootstrapCompletedAt",
  version,
  "createdAt",
  "updatedAt"
) VALUES (
  'rls-owner-split-runtime-cabinet',
  'RLS owner split runtime probe',
  'Europe/Paris',
  'active',
  'rls-owner-split-runtime-user',
  NULL,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
INSERT INTO public.cabinet_members (
  id,
  "cabinetId",
  "userId",
  "sourceInvitationId",
  role,
  status,
  "joinedAt",
  version,
  "createdAt",
  "updatedAt"
) VALUES (
  'rls-owner-split-runtime-member',
  'rls-owner-split-runtime-cabinet',
  'rls-owner-split-runtime-user',
  NULL,
  'admin',
  'active',
  CURRENT_TIMESTAMP,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
UPDATE public.cabinets
   SET "bootstrapCompletedAt" = CURRENT_TIMESTAMP,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-owner-split-runtime-cabinet'
   AND version = 1;

SELECT 1 / CASE
  WHEN public.app_is_active_cabinet_member('rls-owner-split-runtime-cabinet')
   AND public.app_has_cabinet_role(
     'rls-owner-split-runtime-cabinet',
     ARRAY['admin']::public."CabinetRole"[]
   )
  THEN 1
  ELSE 0
END AS authority_ok;
ROLLBACK;
SQL

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
