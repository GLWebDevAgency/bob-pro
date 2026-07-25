#!/usr/bin/env sh
set -eu

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"

phase="${1:-}"

ensure_role() {
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
-- Adhesion SET implicite a la creation (Supabase tue tout GRANT d'adhesion vers postgres).
SET createrole_self_grant = 'set';

SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_realtime_capacity'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'bob_realtime_capacity'
) \gexec

ALTER ROLE bob_realtime_capacity
  NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

DO $$
DECLARE authority pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT authority
    FROM pg_catalog.pg_roles WHERE rolname = 'bob_realtime_capacity';
  IF authority.rolcanlogin OR authority.rolsuper OR authority.rolcreatedb
     OR authority.rolcreaterole OR authority.rolinherit OR authority.rolreplication
     OR authority.rolbypassrls THEN
    RAISE EXCEPTION 'Realtime capacity role privilege drift';
  END IF;
END;
$$;

SELECT format('REVOKE %I FROM %I CASCADE', parent.rolname, 'bob_realtime_capacity')
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
 WHERE membership.member = 'bob_realtime_capacity'::regrole
\gexec
SELECT format('REVOKE %I FROM %I CASCADE', 'bob_realtime_capacity', member.rolname)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
 WHERE membership.roleid = 'bob_realtime_capacity'::regrole
   AND member.rolname <> current_user
\gexec

SELECT format(
  'GRANT %I TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
  'bob_realtime_capacity'
)
WHERE NOT pg_catalog.pg_has_role(current_user, 'bob_realtime_capacity', 'SET')
\gexec
SQL
}

provision() {
  : "${APP_DATABASE_ROLE:?APP_DATABASE_ROLE runtime role is required}"
  ensure_role
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="$APP_DATABASE_ROLE" <<'SQL'
DO $$
DECLARE object_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT object_owner
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.realtime_global_capacity'::regclass;
  IF object_owner NOT IN (current_user, 'bob_realtime_capacity') THEN
    RAISE EXCEPTION 'Realtime capacity table has an unexpected owner';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (
       'public.sync_realtime_global_capacity_v1()'::regprocedure,
       'public.deny_realtime_session_lease_truncate_v1()'::regprocedure,
       'public.preflight_realtime_global_capacity_v1(text,text,integer,integer,integer)'::regprocedure,
       'public.inspect_realtime_global_capacity_v1()'::regprocedure
     )
       AND pg_catalog.pg_get_userbyid(function.proowner)
           NOT IN (current_user, 'bob_realtime_capacity')
  ) THEN
    RAISE EXCEPTION 'Realtime capacity function has an unexpected owner';
  END IF;
END;
$$;

GRANT USAGE, CREATE ON SCHEMA public TO bob_realtime_capacity;
SELECT format('ALTER FUNCTION %s OWNER TO bob_realtime_capacity', function.oid::regprocedure)
  FROM pg_catalog.pg_proc AS function
 WHERE function.oid IN (
   'public.sync_realtime_global_capacity_v1()'::regprocedure,
   'public.deny_realtime_session_lease_truncate_v1()'::regprocedure,
   'public.preflight_realtime_global_capacity_v1(text,text,integer,integer,integer)'::regprocedure,
   'public.inspect_realtime_global_capacity_v1()'::regprocedure
 )
   AND function.proowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec
SELECT format('ALTER TABLE public.realtime_global_capacity OWNER TO bob_realtime_capacity')
 WHERE pg_catalog.pg_get_userbyid((
   SELECT relation.relowner FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.realtime_global_capacity'::regclass
 )) = current_user
\gexec

SET LOCAL ROLE bob_realtime_capacity;
REVOKE ALL ON TABLE public.realtime_global_capacity FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_realtime_global_capacity_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_realtime_session_lease_truncate_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preflight_realtime_global_capacity_v1(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inspect_realtime_global_capacity_v1() FROM PUBLIC;
ALTER FUNCTION public.sync_realtime_global_capacity_v1() SECURITY DEFINER;
ALTER FUNCTION public.deny_realtime_session_lease_truncate_v1() SECURITY DEFINER;
ALTER FUNCTION public.preflight_realtime_global_capacity_v1(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION public.inspect_realtime_global_capacity_v1() SECURITY DEFINER;
ALTER FUNCTION public.sync_realtime_global_capacity_v1() SET search_path = pg_catalog;
ALTER FUNCTION public.deny_realtime_session_lease_truncate_v1() SET search_path = pg_catalog;
ALTER FUNCTION public.preflight_realtime_global_capacity_v1(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.inspect_realtime_global_capacity_v1() SET search_path = pg_catalog;
ALTER FUNCTION public.sync_realtime_global_capacity_v1() SET row_security = on;
ALTER FUNCTION public.deny_realtime_session_lease_truncate_v1() SET row_security = on;
ALTER FUNCTION public.preflight_realtime_global_capacity_v1(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  SET row_security = on;
ALTER FUNCTION public.inspect_realtime_global_capacity_v1() SET row_security = on;
RESET ROLE;

-- grant_app_role() est volontairement large pour les tables métier. Cette autorité globale est
-- l'exception explicite : aucun SELECT/DML/TRIGGER/REFERENCES runtime, même après un rejeu.
-- Sous SET ROLE proprietaire : apres le transfert d'ownership, un deployeur NON superuser
-- (Supabase) ne peut plus ni revoquer ni granter sur ces objets en son nom propre.
SET LOCAL ROLE bob_realtime_capacity;
REVOKE ALL ON TABLE public.realtime_global_capacity FROM :"app_role";
SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
  function.oid::regprocedure,
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END
)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE function.oid IN (
   'public.sync_realtime_global_capacity_v1()'::regprocedure,
   'public.deny_realtime_session_lease_truncate_v1()'::regprocedure,
   'public.preflight_realtime_global_capacity_v1(text,text,integer,integer,integer)'::regprocedure,
   'public.inspect_realtime_global_capacity_v1()'::regprocedure
 )
   AND privilege.grantee <> function.proowner
\gexec
GRANT EXECUTE ON FUNCTION public.preflight_realtime_global_capacity_v1(
  TEXT, TEXT, INTEGER, INTEGER, INTEGER
) TO :"app_role";
GRANT EXECUTE ON FUNCTION public.inspect_realtime_global_capacity_v1() TO :"app_role";
RESET ROLE;
-- La revocation d'adhesion exige l'ADMIN OPTION sur le role : c'est le deployeur createur
-- qui la detient, jamais le role sur lui-meme.
REVOKE bob_realtime_capacity FROM :"app_role" CASCADE;
REVOKE CREATE ON SCHEMA public FROM bob_realtime_capacity;
GRANT USAGE ON SCHEMA public TO bob_realtime_capacity;
SQL
}

configure() {
  ensure_role
  if [ "${BOB_LIVE_ENABLED+x}" = x ]; then
    live_enabled="$BOB_LIVE_ENABLED"
  else
    live_enabled="${OPENAI_REALTIME_ENABLED:-false}"
  fi

  if [ "$live_enabled" != "true" ]; then
    psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';
-- Même ordre que l'admission et les triggers : singleton d'abord. Verrouiller la table des
-- leases avant cette ligne créerait un cycle table -> singleton / singleton -> INSERT sous charge.
SET LOCAL ROLE bob_realtime_capacity;
SELECT id FROM public.realtime_global_capacity WHERE id = 1 FOR UPDATE;
RESET ROLE;
SELECT set_config(
  'bob.realtime_capacity_actual_count',
  (SELECT count(*)::TEXT FROM public.realtime_session_leases),
  TRUE
);
SET LOCAL ROLE bob_realtime_capacity;
DO $$
DECLARE actual_count INTEGER := current_setting('bob.realtime_capacity_actual_count')::INTEGER;
DECLARE projected_count INTEGER;
BEGIN
  SELECT "usedSessions" INTO STRICT projected_count
    FROM public.realtime_global_capacity WHERE id = 1 FOR UPDATE;
  IF projected_count <> actual_count THEN
    RAISE EXCEPTION 'Realtime capacity projection mismatch';
  END IF;
  UPDATE public.realtime_global_capacity
     SET mode = 'closed', revision = revision + 1, "updatedAt" = clock_timestamp()
   WHERE id = 1 AND mode = 'active';
END;
$$;
SQL
    return 0
  fi

  : "${BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS:?Bob Live global capacity is required}"
  : "${BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS:?Bob Live provider capacity is required}"
  : "${BOB_LIVE_CAPACITY_CONFIG_VERSION:?Bob Live capacity config version is required}"
  capacity_provider="${BOB_LIVE_PROVIDER:-openai}"
  case "$capacity_provider" in
    openai) capacity_model="${OPENAI_REALTIME_MODEL:-gpt-realtime-2.1}" ;;
    mistral) capacity_model="${MISTRAL_REALTIME_STT_MODEL:-voxtral-mini-transcribe-realtime-2602}" ;;
    *) echo "BOB_LIVE_PROVIDER must be openai or mistral" >&2; exit 1 ;;
  esac

  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v provider="$capacity_provider" \
    -v model="$capacity_model" \
    -v global_max="$BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS" \
    -v provider_max="$BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS" \
    -v config_version="$BOB_LIVE_CAPACITY_CONFIG_VERSION" <<'SQL'
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';
-- Le singleton est l'unique point de sérialisation. Une écriture N-1 déjà commencée attendra
-- dans son trigger puis sera soit projetée avant ce verrou, soit refusée après la fermeture.
-- Aucun verrou de table n'est nécessaire pour rendre count(*) cohérent avec la projection.
SET LOCAL ROLE bob_realtime_capacity;
SELECT id FROM public.realtime_global_capacity WHERE id = 1 FOR UPDATE;
RESET ROLE;
SELECT set_config('bob.realtime.capacity_provider', :'provider', TRUE);
SELECT set_config('bob.realtime.capacity_model', :'model', TRUE);
SELECT set_config('bob.realtime.capacity_global_max', :'global_max', TRUE);
SELECT set_config('bob.realtime.capacity_provider_max', :'provider_max', TRUE);
SELECT set_config('bob.realtime.capacity_config_version', :'config_version', TRUE);
SELECT set_config(
  'bob.realtime.capacity_actual_count',
  (SELECT count(*)::TEXT FROM public.realtime_session_leases),
  TRUE
);
SET LOCAL ROLE bob_realtime_capacity;
DO $$
DECLARE selected_provider TEXT := current_setting('bob.realtime.capacity_provider');
DECLARE selected_model TEXT := current_setting('bob.realtime.capacity_model');
DECLARE selected_global_max INTEGER := current_setting('bob.realtime.capacity_global_max')::INTEGER;
DECLARE selected_provider_max INTEGER := current_setting('bob.realtime.capacity_provider_max')::INTEGER;
DECLARE selected_version INTEGER := current_setting('bob.realtime.capacity_config_version')::INTEGER;
DECLARE actual_count INTEGER := current_setting('bob.realtime.capacity_actual_count')::INTEGER;
DECLARE state_row public.realtime_global_capacity%ROWTYPE;
DECLARE same_configuration BOOLEAN;
BEGIN
  IF selected_provider NOT IN ('openai', 'mistral')
     OR length(selected_model) NOT BETWEEN 1 AND 100
     OR selected_global_max NOT BETWEEN 1 AND 1000
     OR selected_provider_max NOT BETWEEN selected_global_max AND 10000
     OR selected_version NOT BETWEEN 1 AND 2147483647 THEN
    RAISE EXCEPTION 'Realtime capacity activation input rejected';
  END IF;

  SELECT * INTO STRICT state_row
    FROM public.realtime_global_capacity WHERE id = 1 FOR UPDATE;
  IF state_row."usedSessions" <> actual_count THEN
    RAISE EXCEPTION 'Realtime capacity projection mismatch';
  END IF;
  IF actual_count > selected_global_max THEN
    RAISE EXCEPTION 'Realtime capacity cannot activate below current usage';
  END IF;

  same_configuration :=
    state_row."providerId" IS NOT DISTINCT FROM selected_provider
    AND state_row."providerModel" IS NOT DISTINCT FROM selected_model
    AND state_row."globalMaxSessions" IS NOT DISTINCT FROM selected_global_max
    AND state_row."providerMaxSessions" IS NOT DISTINCT FROM selected_provider_max
    AND state_row."configVersion" IS NOT DISTINCT FROM selected_version;

  IF state_row.mode = 'active' AND NOT same_configuration THEN
    RAISE EXCEPTION 'Realtime capacity must be closed before reconfiguration';
  END IF;
  IF state_row.mode = 'active' AND same_configuration THEN
    RETURN;
  END IF;
  IF state_row.mode <> 'closed' THEN
    RAISE EXCEPTION 'Realtime capacity must be closed before activation';
  END IF;
  IF state_row."configVersion" IS NULL AND actual_count <> 0 THEN
    RAISE EXCEPTION 'Initial realtime capacity activation requires a complete drain';
  END IF;
  IF state_row."configVersion" IS NOT NULL AND NOT same_configuration THEN
    IF actual_count <> 0 OR selected_version <= state_row."configVersion" THEN
      RAISE EXCEPTION 'Realtime capacity reconfiguration requires drain and newer version';
    END IF;
  END IF;

  UPDATE public.realtime_global_capacity
     SET mode = 'active',
         "providerId" = selected_provider,
         "providerModel" = selected_model,
         "globalMaxSessions" = selected_global_max,
         "providerMaxSessions" = selected_provider_max,
         "configVersion" = selected_version,
         "retryAfterSeconds" = 10,
         "activatedAt" = clock_timestamp(),
         revision = revision + 1,
         "updatedAt" = clock_timestamp()
   WHERE id = 1;
END;
$$;
SQL
}

case "$phase" in
  ensure) ensure_role ;;
  provision) provision ;;
  configure) configure ;;
  *) echo "usage: $0 <ensure|provision|configure>" >&2; exit 2 ;;
esac
