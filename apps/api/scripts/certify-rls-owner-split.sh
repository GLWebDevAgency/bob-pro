#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DIRECT_URL:?DIRECT_URL non-superuser deployer URL is required}"
: "${DATABASE_URL:?DATABASE_URL non-superuser runtime URL is required}"

if [ "${GITHUB_ACTIONS:-false}" != "true" ] \
  && [ "${BOB_RLS_OWNER_SPLIT_CERT_CONFIRMATION:-}" != "EPHEMERAL_LOCAL_ONLY" ]; then
  echo "RLS owner-split certification is restricted to CI or an explicitly confirmed ephemeral database" >&2
  exit 1
fi

# Le transfert ci-dessous est volontairement destructif. La confirmation d'exécution ne suffit
# donc jamais : les deux URI doivent viser le même endpoint loopback explicite, sans paramètre
# libpq, sous les identités et le nom de base jetables exacts.
node apps/api/scripts/assert-database-pair.mjs --ephemeral-supabase-ci owner-split

# Aucun PG* ambiant ne peut substituer un service, un socket, une base ou des options aux URI
# strictement validées. La preuve d'identité inter-rôles est exécutée seulement après ce nettoyage.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGOPTIONS
node apps/api/scripts/assert-database-pair.mjs

owner_split_network_mode=loopback
if [ "${GITHUB_ACTIONS:-false}" = "true" ]; then
  # Le runner joint le service PostgreSQL via localhost ; Docker DNAT présente néanmoins au
  # serveur des adresses privées. Les URI restent loopback et ce mode ne relâche que la preuve
  # serveur/client effectuée ci-dessous.
  owner_split_network_mode=github-actions-service
fi

psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v owner_split_network_mode="$owner_split_network_mode" <<'SQL'
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SELECT pg_catalog.set_config(
  'bob.rls_owner_split_network_mode',
  :'owner_split_network_mode',
  TRUE
);

DO $rls_owner_split_target$
DECLARE
  deployer pg_catalog.pg_roles%ROWTYPE;
  owner_split_network_mode TEXT :=
    current_setting('bob.rls_owner_split_network_mode');
  server_address INET := pg_catalog.inet_server_addr();
  client_address INET := pg_catalog.inet_client_addr();
BEGIN
  SELECT *
    INTO STRICT deployer
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF owner_split_network_mode NOT IN ('loopback', 'github-actions-service')
     OR server_address IS NULL
     OR client_address IS NULL
     OR (
       owner_split_network_mode = 'loopback'
       AND NOT (
         server_address <<= pg_catalog.inet '127.0.0.0/8'
         OR server_address = pg_catalog.inet '::1'
       )
     )
     OR (
       owner_split_network_mode = 'github-actions-service'
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
     OR current_database() <> 'bob_ephemeral_ci'
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

DO $rls_owner_split_initial_authority$
DECLARE
  protected_owner OID;
BEGIN
  SELECT relation.relowner
    INTO STRICT protected_owner
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.agent_missions'::pg_catalog.regclass;
  IF protected_owner <> current_user::pg_catalog.regrole THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_INITIAL_OWNER_IS_NOT_DEPLOYER';
  END IF;
END;
$rls_owner_split_initial_authority$;

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

DO $rls_owner_split_exact_authority$
DECLARE
  owner_oid OID := 'bob_rls_schema_owner_cert'::pg_catalog.regrole;
  catalogue_sync_owner_oid OID :=
    'bob_catalogue_search_token_sync'::pg_catalog.regrole;
  catalogue_sync pg_catalog.pg_proc%ROWTYPE;
  catalogue_sync_role pg_catalog.pg_roles%ROWTYPE;
  helper_count INTEGER;
BEGIN
  IF (
    SELECT relation.relowner <> owner_oid
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = 'public.agent_missions'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_PROTECTED_OWNER_DRIFT';
  END IF;

  SELECT pg_catalog.count(*)
    INTO STRICT helper_count
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid = ANY (
     ARRAY[
       pg_catalog.to_regprocedure(
         'public.app_is_active_cabinet_member(text)'
       ),
       pg_catalog.to_regprocedure(
         'public.app_has_cabinet_role(text,public."CabinetRole"[])'
       )
     ]::OID[]
   )
     AND function.proowner = owner_oid
     AND function.prosecdef;
  IF helper_count <> 2 THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_CABINET_HELPER_OWNER_DRIFT';
  END IF;

  SELECT *
    INTO STRICT catalogue_sync
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure;
  SELECT *
    INTO STRICT catalogue_sync_role
    FROM pg_catalog.pg_roles AS role
   WHERE role.oid = catalogue_sync_owner_oid;
  IF catalogue_sync.proowner <> catalogue_sync_owner_oid
     OR NOT catalogue_sync.prosecdef
     OR catalogue_sync.proconfig <> ARRAY[
       'search_path=pg_catalog',
       'row_security=on'
     ]::TEXT[]
     OR pg_catalog.md5(catalogue_sync.prosrc) <>
       '94327712057244bbe60cc428a22df471'
     OR catalogue_sync_role.rolcanlogin
     OR catalogue_sync_role.rolsuper
     OR catalogue_sync_role.rolcreatedb
     OR catalogue_sync_role.rolcreaterole
     OR catalogue_sync_role.rolinherit
     OR catalogue_sync_role.rolreplication
     OR catalogue_sync_role.rolbypassrls
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = catalogue_sync_owner_oid
     )
     OR (
       SELECT relation.relowner = catalogue_sync_owner_oid
         FROM pg_catalog.pg_class AS relation
        WHERE relation.oid =
          'public.catalogue_prestation_search_tokens'::pg_catalog.regclass
     ) THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_CATALOGUE_TOKEN_AUTHORITY_DRIFT';
  END IF;
END;
$rls_owner_split_exact_authority$;

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

# Les fixtures sont créées par le propriétaire Supabase-like, mais le trigger s'exécute déjà
# sous son autorité NOLOGIN/NOBYPASSRLS dédiée. Un mauvais owner ou une policy sans contexte
# tenant fait donc échouer le setup avant même la sonde runtime.
psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';
SET LOCAL ROLE bob_rls_schema_owner_cert;

INSERT INTO public.companies (
  "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
  "addrLine1", "addrZip", "addrCity"
) VALUES
  (
    'rls-owner-split-token-company-a',
    'RLS token company A',
    'EI',
    '911000001',
    '91100000100001',
    'certification',
    'reel_normal',
    '1 rue du Test',
    '75001',
    'Paris'
  ),
  (
    'rls-owner-split-token-company-b',
    'RLS token company B',
    'EI',
    '911000002',
    '91100000200002',
    'certification',
    'reel_normal',
    '2 rue du Test',
    '75002',
    'Paris'
  );

SET LOCAL app.current_company_id = 'rls-owner-split-token-company-a';
INSERT INTO public.catalogue_prestations (
  "id", "companyId", "label", "category", "unit", "unitPriceHt", "vatRate",
  "revision", "createdAt", "updatedAt"
) VALUES (
  'rls-owner-split-token-item-a',
  'rls-owner-split-token-company-a',
  'Inspection chaudière alpha',
  'labor',
  'heure',
  5500,
  20,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

SET LOCAL app.current_company_id = 'rls-owner-split-token-company-b';
INSERT INTO public.catalogue_prestations (
  "id", "companyId", "label", "category", "unit", "unitPriceHt", "vatRate",
  "revision", "createdAt", "updatedAt"
) VALUES (
  'rls-owner-split-token-item-b',
  'rls-owner-split-token-company-b',
  'Entretien vitrine beta',
  'labor',
  'heure',
  6500,
  20,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
COMMIT;
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

# Le runtime met réellement à jour chaque tenant ; le trigger remplace ses tokens dans la même
# transaction, ne voit jamais le voisin et ne peut toucher une ligne hors contexte.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';
SET LOCAL app.current_user_id = 'rls-owner-split-token-runtime-user';
SET LOCAL app.current_company_id = 'rls-owner-split-token-company-a';

UPDATE public.catalogue_prestations
   SET label = 'Maintenance chaudière alpha',
       revision = revision + 1,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "companyId" = 'rls-owner-split-token-company-a'
   AND id = 'rls-owner-split-token-item-a';

DO $catalogue_token_tenant_a$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM public.catalogue_prestation_search_tokens
     WHERE "companyId" = 'rls-owner-split-token-company-a'
       AND "catalogueItemId" = 'rls-owner-split-token-item-a'
       AND token IN ('maintenance', 'chaudiere', 'alpha')
  ) <> 3
  OR EXISTS (
    SELECT 1
      FROM public.catalogue_prestation_search_tokens
     WHERE "companyId" = 'rls-owner-split-token-company-b'
  ) THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_CATALOGUE_TOKEN_TENANT_A_DRIFT';
  END IF;
END;
$catalogue_token_tenant_a$;

SET LOCAL app.current_company_id = 'rls-owner-split-token-company-b';

DO $catalogue_token_cross_tenant$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.catalogue_prestations
     SET label = 'Tentative interdite',
         revision = revision + 1,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "companyId" = 'rls-owner-split-token-company-a'
     AND id = 'rls-owner-split-token-item-a';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0
     OR EXISTS (
       SELECT 1
         FROM public.catalogue_prestation_search_tokens
        WHERE "companyId" = 'rls-owner-split-token-company-a'
     ) THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_CATALOGUE_TOKEN_CROSS_TENANT_LEAK';
  END IF;
END;
$catalogue_token_cross_tenant$;

UPDATE public.catalogue_prestations
   SET label = 'Nettoyage vitrine beta',
       revision = revision + 1,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "companyId" = 'rls-owner-split-token-company-b'
   AND id = 'rls-owner-split-token-item-b';

DO $catalogue_token_tenant_b$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM public.catalogue_prestation_search_tokens
     WHERE "companyId" = 'rls-owner-split-token-company-b'
       AND "catalogueItemId" = 'rls-owner-split-token-item-b'
       AND token IN ('nettoyage', 'vitrine', 'beta')
  ) <> 3 THEN
    RAISE EXCEPTION 'RLS_OWNER_SPLIT_CERT_CATALOGUE_TOKEN_TENANT_B_DRIFT';
  END IF;
END;
$catalogue_token_tenant_b$;
ROLLBACK;
SQL

psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
DO $rls_owner_split_certificate$
DECLARE
  owner_oid OID := 'bob_rls_schema_owner_cert'::pg_catalog.regrole;
BEGIN
  IF (
    SELECT relation.relowner <> owner_oid
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

SET ROLE bob_rls_schema_owner_cert;
DELETE FROM public.catalogue_prestations
 WHERE "companyId" IN (
   'rls-owner-split-token-company-a',
   'rls-owner-split-token-company-b'
 );
DELETE FROM public.companies
 WHERE id IN (
   'rls-owner-split-token-company-a',
   'rls-owner-split-token-company-b'
 );
RESET ROLE;
SQL

echo "RLS owner-split replay certified with a non-superuser deployer"
