\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.set_config('app.release_runtime_role', :'app_role', true);
SELECT pg_catalog.set_config('app.release_environment', :'release_env', true);
SELECT pg_catalog.set_config('app.release_deployer_role', session_user, true);

DO $realtime_voice_trace_authority_inventory$
DECLARE
  authority_name TEXT;
  protected_function REGPROCEDURE;
BEGIN
  IF current_setting('app.release_environment', TRUE) NOT IN ('development', 'staging', 'production')
     OR pg_catalog.to_regclass('public.realtime_voice_trace_events') IS NULL
     OR pg_catalog.to_regclass('public.realtime_voice_trace_access_audits') IS NULL THEN
    RAISE EXCEPTION 'Realtime Voice Trace protected inventory is incomplete';
  END IF;
  FOREACH authority_name IN ARRAY ARRAY[
    'bob_realtime_voice_trace_maintenance',
    'bob_realtime_voice_trace_key_readiness',
    'bob_realtime_voice_trace_reader'
  ]::TEXT[] LOOP
    IF pg_catalog.to_regrole(authority_name) IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, authority_name, 'SET') THEN
      RAISE EXCEPTION 'Realtime Voice Trace authority is unavailable: %', authority_name;
    END IF;
  END LOOP;
  FOREACH protected_function IN ARRAY ARRAY[
    'public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
    'public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
    'public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
    'public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE,
    'public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE,
    'public.read_realtime_voice_trace_session_v3(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE
  ] LOOP
    IF protected_function IS NULL THEN
      RAISE EXCEPTION 'Realtime Voice Trace function inventory is incomplete';
    END IF;
  END LOOP;
END;
$realtime_voice_trace_authority_inventory$;

-- Le CREATE schéma n'existe que pendant le transfert d'ownership des fonctions.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT USAGE, CREATE ON SCHEMA public TO %I; RESET ROLE;',
  owner.rolname,
  authority.role_name
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 CROSS JOIN (VALUES
   ('bob_realtime_voice_trace_maintenance'),
   ('bob_realtime_voice_trace_key_readiness'),
   ('bob_realtime_voice_trace_reader')
 ) AS authority(role_name)
 WHERE namespace.nspname = 'public'
\gexec

-- Nettoyage exhaustif avant re-grant : aucune ACL héritée d'un ancien rôle ne survit au rejeu.
-- PUBLIC est un pseudo-rôle SQL et doit rester non quoté ; les autres grantees sont échappés.
SELECT DISTINCT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %s CASCADE; RESET ROLE;',
  owner.rolname,
  relation.relname,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.format('%I', grantee.rolname)
  END
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE relation.oid IN (
   'public.realtime_voice_trace_events'::REGCLASS,
   'public.realtime_voice_trace_access_audits'::REGCLASS
 )
   AND privilege.grantee <> relation.relowner
   AND (privilege.grantee = 0 OR grantee.rolname IS NOT NULL)
\gexec

SELECT DISTINCT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM %s CASCADE; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  relation.relname,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.format('%I', grantee.rolname)
  END
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE relation.oid IN (
   'public.realtime_voice_trace_events'::REGCLASS,
   'public.realtime_voice_trace_access_audits'::REGCLASS
 )
   AND (privilege.grantee = 0 OR grantee.rolname IS NOT NULL)
\gexec

-- Révoquer table ET chaque ACL colonne : un REVOKE table seul ne ferme pas un ancien grant ciblé.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I; RESET ROLE;',
  owner.rolname,
  relation.relname,
  grantee.role_name
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 CROSS JOIN (VALUES
   ('bob_realtime_voice_trace_maintenance'),
   ('bob_realtime_voice_trace_key_readiness'),
   ('bob_realtime_voice_trace_reader')
 ) AS grantee(role_name)
 WHERE relation.oid IN (
   'public.realtime_voice_trace_events'::REGCLASS,
   'public.realtime_voice_trace_access_audits'::REGCLASS
 )
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM %I; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  relation.relname,
  grantee.role_name
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 CROSS JOIN (VALUES
   ('bob_realtime_voice_trace_maintenance'),
   ('bob_realtime_voice_trace_key_readiness'),
   ('bob_realtime_voice_trace_reader')
 ) AS grantee(role_name)
 WHERE relation.oid IN (
   'public.realtime_voice_trace_events'::REGCLASS,
   'public.realtime_voice_trace_access_audits'::REGCLASS
 )
 ORDER BY relation.relname, attribute.attnum, grantee.role_name
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I; RESET ROLE;',
  owner.rolname,
  relation.relname,
  current_setting('app.release_runtime_role', TRUE)
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid IN (
   'public.realtime_voice_trace_events'::REGCLASS,
   'public.realtime_voice_trace_access_audits'::REGCLASS
 )
   AND NULLIF(current_setting('app.release_runtime_role', TRUE), '') IS NOT NULL
   AND pg_catalog.to_regrole(current_setting('app.release_runtime_role', TRUE)) IS NOT NULL
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM %I; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  relation.relname,
  current_setting('app.release_runtime_role', TRUE)
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 WHERE relation.oid IN (
   'public.realtime_voice_trace_events'::REGCLASS,
   'public.realtime_voice_trace_access_audits'::REGCLASS
 )
   AND NULLIF(current_setting('app.release_runtime_role', TRUE), '') IS NOT NULL
   AND pg_catalog.to_regrole(current_setting('app.release_runtime_role', TRUE)) IS NOT NULL
 ORDER BY relation.relname, attribute.attnum
\gexec

-- Le runtime ne possède que l'append et les six colonnes nécessaires au lookup/idempotence.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT INSERT (id, "companyId", "userId", "traceAttemptId", "sessionHandle", "ownerEpoch", "eventOrdinal", "turnId", "eventKind", "eventDigest", "eventDigestKeyVersion", "occurredAt", "durationMs", "contextRevision", "contextDigest", provider, transport, "speechDelivery", "realtimeModel", "plannerDisposition", "plannerAuthority", "plannerModel", "plannerStepIndex", "plannerStepCount", "plannerIntent", "missionKind", "runKind", "controlKind", stage, outcome, "failureClass", "interruptionReason", "sessionCloseReason", "encryptionKeyVersion", "transcriptCiphertext", "canonicalReplyCiphertext"), SELECT (id, "companyId", "traceAttemptId", "eventOrdinal", "eventDigest", "eventDigestKeyVersion") ON TABLE public.realtime_voice_trace_events TO %I; RESET ROLE;',
  owner.rolname,
  current_setting('app.release_runtime_role', TRUE)
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.realtime_voice_trace_events'::REGCLASS
   AND NULLIF(current_setting('app.release_runtime_role', TRUE), '') IS NOT NULL
   AND pg_catalog.to_regrole(current_setting('app.release_runtime_role', TRUE)) IS NOT NULL
\gexec

-- Maintenance : uniquement les colonnes de sélection nécessaires aux DELETE bornés et à la lag.
-- UPDATE(id) est le droit PostgreSQL minimal exigé par SELECT ... FOR UPDATE SKIP LOCKED ; le
-- trigger append-only certifié refuse toute mutation effective de cette colonne.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT SELECT (id, "companyId", "userId", "retentionExpiresAt"), UPDATE (id), DELETE ON TABLE public.realtime_voice_trace_events TO bob_realtime_voice_trace_maintenance; GRANT SELECT (id, "companyId", "subjectUserId", "retentionExpiresAt"), UPDATE (id), DELETE ON TABLE public.realtime_voice_trace_access_audits TO bob_realtime_voice_trace_maintenance; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.realtime_voice_trace_events'::REGCLASS
\gexec

-- Readiness ne voit que les versions de clé retenues ; jamais un ciphertext ni un identifiant.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT SELECT ("eventDigestKeyVersion", "encryptionKeyVersion") ON TABLE public.realtime_voice_trace_events TO bob_realtime_voice_trace_key_readiness; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.realtime_voice_trace_events'::REGCLASS
\gexec

-- Reader : la sélection utile au diagnostic et l'INSERT d'audit sont enfermés dans une seule RPC.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT SELECT (id, "companyId", "userId", "traceAttemptId", "sessionHandle", "ownerEpoch", "eventOrdinal", "eventKind", "turnId", "occurredAt", "durationMs", "contextRevision", "contextDigest", "speechDelivery", "plannerDisposition", "plannerAuthority", "plannerIntent", "missionKind", "runKind", "controlKind", stage, outcome, "failureClass", "interruptionReason", "sessionCloseReason", "eventDigestKeyVersion", "encryptionKeyVersion", "transcriptCiphertext", "canonicalReplyCiphertext") ON TABLE public.realtime_voice_trace_events TO bob_realtime_voice_trace_reader; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.realtime_voice_trace_events'::REGCLASS
\gexec
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT INSERT (id, "requestId", "companyId", "subjectUserId", "sessionHandle", reason, ticket, "includedContent", "rowCount") ON TABLE public.realtime_voice_trace_access_audits TO bob_realtime_voice_trace_reader; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.realtime_voice_trace_access_audits'::REGCLASS
\gexec

-- Transfert owner-aware. L'ancien owner reçoit SET sur la nouvelle autorité dans cette transaction
-- uniquement, puis cette adhésion éphémère est révoquée. Aucun GRANT ne cible le déployeur postgres.
SELECT pg_catalog.format(
  'GRANT %I TO %I WITH INHERIT FALSE, SET TRUE',
  mapping.authority_name,
  owner.rolname
)
  FROM (VALUES
    ('public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
      'bob_realtime_voice_trace_maintenance'),
    ('public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
      'bob_realtime_voice_trace_maintenance'),
    ('public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
      'bob_realtime_voice_trace_maintenance'),
    ('public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE,
      'bob_realtime_voice_trace_key_readiness'),
    ('public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE,
      'bob_realtime_voice_trace_reader'),
    ('public.read_realtime_voice_trace_session_v3(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE,
      'bob_realtime_voice_trace_reader')
  ) AS mapping(function_oid, authority_name)
  JOIN pg_catalog.pg_proc AS function ON function.oid = mapping.function_oid
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE owner.rolname <> mapping.authority_name
   AND owner.rolname <> session_user
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; ALTER FUNCTION %s OWNER TO %I; RESET ROLE;',
  owner.rolname,
  function.oid::REGPROCEDURE,
  mapping.authority_name
)
  FROM (VALUES
    ('public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
      'bob_realtime_voice_trace_maintenance'),
    ('public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
      'bob_realtime_voice_trace_maintenance'),
    ('public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
      'bob_realtime_voice_trace_maintenance'),
    ('public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE,
      'bob_realtime_voice_trace_key_readiness'),
    ('public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE,
      'bob_realtime_voice_trace_reader'),
    ('public.read_realtime_voice_trace_session_v3(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE,
      'bob_realtime_voice_trace_reader')
  ) AS mapping(function_oid, authority_name)
  JOIN pg_catalog.pg_proc AS function ON function.oid = mapping.function_oid
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE owner.rolname <> mapping.authority_name
\gexec

SELECT pg_catalog.format('REVOKE %I FROM %I', authority.rolname, member.rolname)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS authority ON authority.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
 WHERE authority.rolname IN (
   'bob_realtime_voice_trace_maintenance',
   'bob_realtime_voice_trace_key_readiness',
   'bob_realtime_voice_trace_reader'
 )
   AND member.rolname NOT IN (session_user, 'postgres')
\gexec

SELECT DISTINCT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE; RESET ROLE;',
  owner.rolname,
  function.oid::REGPROCEDURE,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.format('%I', grantee.rolname)
  END
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE function.oid IN (
   'public.prepare_realtime_voice_trace_event_v2()'::REGPROCEDURE,
   'public.prepare_realtime_voice_trace_access_audit_v2()'::REGPROCEDURE,
   'public.deny_realtime_voice_trace_mutation_v2()'::REGPROCEDURE,
   'public.guard_realtime_voice_trace_delete_v2()'::REGPROCEDURE,
   'public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::REGPROCEDURE,
   'public.purge_realtime_voice_trace_v2(integer)'::REGPROCEDURE,
   'public.inspect_realtime_voice_trace_retention_v2()'::REGPROCEDURE,
   'public.assert_realtime_voice_trace_key_versions_v2(integer[])'::REGPROCEDURE,
   'public.read_realtime_voice_trace_session_v2(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE,
   'public.read_realtime_voice_trace_session_v3(uuid,text,uuid,uuid,text,text,boolean)'::REGPROCEDURE
 )
   AND privilege.grantee <> function.proowner
   AND (privilege.grantee = 0 OR grantee.rolname IS NOT NULL)
\gexec

SET LOCAL ROLE bob_realtime_voice_trace_maintenance;
REVOKE ALL ON FUNCTION public.erase_realtime_voice_trace_subject_v2(TEXT, UUID, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_realtime_voice_trace_v2(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inspect_realtime_voice_trace_retention_v2() FROM PUBLIC;
SELECT pg_catalog.format(
  'GRANT EXECUTE ON FUNCTION public.erase_realtime_voice_trace_subject_v2(TEXT, UUID, TEXT), public.purge_realtime_voice_trace_v2(INTEGER), public.inspect_realtime_voice_trace_retention_v2() TO %I',
  current_setting('app.release_runtime_role', TRUE)
)
 WHERE NULLIF(current_setting('app.release_runtime_role', TRUE), '') IS NOT NULL
   AND pg_catalog.to_regrole(current_setting('app.release_runtime_role', TRUE)) IS NOT NULL
\gexec
RESET ROLE;

SET LOCAL ROLE bob_realtime_voice_trace_key_readiness;
REVOKE ALL ON FUNCTION public.assert_realtime_voice_trace_key_versions_v2(INTEGER[])
  FROM PUBLIC;
SELECT pg_catalog.format(
  'GRANT EXECUTE ON FUNCTION public.assert_realtime_voice_trace_key_versions_v2(INTEGER[]) TO %I',
  current_setting('app.release_runtime_role', TRUE)
)
 WHERE NULLIF(current_setting('app.release_runtime_role', TRUE), '') IS NOT NULL
   AND pg_catalog.to_regrole(current_setting('app.release_runtime_role', TRUE)) IS NOT NULL
\gexec
RESET ROLE;

SET LOCAL ROLE bob_realtime_voice_trace_reader;
REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v2(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v3(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;
SELECT pg_catalog.format(
  'REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v2(UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) FROM %I',
  current_setting('app.release_runtime_role', TRUE)
)
 WHERE NULLIF(current_setting('app.release_runtime_role', TRUE), '') IS NOT NULL
   AND pg_catalog.to_regrole(current_setting('app.release_runtime_role', TRUE)) IS NOT NULL
\gexec
SELECT pg_catalog.format(
  'REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v3(UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) FROM %I',
  current_setting('app.release_runtime_role', TRUE)
)
 WHERE NULLIF(current_setting('app.release_runtime_role', TRUE), '') IS NOT NULL
   AND pg_catalog.to_regrole(current_setting('app.release_runtime_role', TRUE)) IS NOT NULL
\gexec
SELECT pg_catalog.format(
  'GRANT EXECUTE ON FUNCTION public.read_realtime_voice_trace_session_v2(UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) TO %I',
  current_setting('app.release_deployer_role', TRUE)
)
 WHERE current_setting('app.release_environment', TRUE) = 'staging'
\gexec
SELECT pg_catalog.format(
  'GRANT EXECUTE ON FUNCTION public.read_realtime_voice_trace_session_v3(UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) TO %I',
  current_setting('app.release_deployer_role', TRUE)
)
 WHERE current_setting('app.release_environment', TRUE) = 'staging'
\gexec
SELECT pg_catalog.format(
  'REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v2(UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) FROM %I',
  current_setting('app.release_deployer_role', TRUE)
)
 WHERE current_setting('app.release_environment', TRUE) <> 'staging'
   AND current_setting('app.release_deployer_role', TRUE) <> current_user
\gexec
SELECT pg_catalog.format(
  'REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v3(UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) FROM %I',
  current_setting('app.release_deployer_role', TRUE)
)
 WHERE current_setting('app.release_environment', TRUE) <> 'staging'
   AND current_setting('app.release_deployer_role', TRUE) <> current_user
\gexec
RESET ROLE;

-- CREATE est retiré après transfert. Les autorités ne gardent que USAGE et leurs ACL minimales.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE CREATE ON SCHEMA public FROM %I; GRANT USAGE ON SCHEMA public TO %I; RESET ROLE;',
  owner.rolname,
  authority.role_name,
  authority.role_name
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 CROSS JOIN (VALUES
   ('bob_realtime_voice_trace_maintenance'),
   ('bob_realtime_voice_trace_key_readiness'),
   ('bob_realtime_voice_trace_reader')
 ) AS authority(role_name)
 WHERE namespace.nspname = 'public'
\gexec

DO $realtime_voice_trace_runtime_membership_fence$
DECLARE
  runtime_role TEXT := NULLIF(current_setting('app.release_runtime_role', TRUE), '');
  authority_name TEXT;
BEGIN
  IF runtime_role IS NULL THEN RETURN; END IF;
  FOREACH authority_name IN ARRAY ARRAY[
    'bob_realtime_voice_trace_maintenance',
    'bob_realtime_voice_trace_key_readiness',
    'bob_realtime_voice_trace_reader'
  ]::TEXT[] LOOP
    IF pg_catalog.pg_has_role(runtime_role, authority_name, 'MEMBER')
       OR pg_catalog.pg_has_role(runtime_role, authority_name, 'SET') THEN
      RAISE EXCEPTION 'Realtime Voice Trace runtime can assume authority %', authority_name;
    END IF;
  END LOOP;
END;
$realtime_voice_trace_runtime_membership_fence$;

COMMIT;
