import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, '..');
const repositoryRoot = path.resolve(apiDir, '..', '..');
const [
  release,
  localCertificate,
  runtimeGrants,
  releaseCertificate,
  realtimeReleaseCertificate,
  authorityRole,
  authorityProvision,
  packageJson,
  ci,
] = await Promise.all([
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-agent-missions-local.sh'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-missions-runtime-grants.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-missions-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-realtime-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-release-flag-authority-role.sql'), 'utf8'),
  readFile(
    path.join(apiDir, 'prisma/agent-mission-release-flag-authority-provision.sql'),
    'utf8',
  ),
  readFile(path.join(apiDir, 'package.json'), 'utf8'),
  readFile(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
]);

test('le chemin de release resserre les ACL après le grant des objets du déployeur puis les certifie', () => {
  const grantFunctionStart = release.indexOf('grant_app_role()');
  const singleTransaction = release.indexOf(
    'psql "$DIRECT_URL" -X --single-transaction',
    grantFunctionStart,
  );
  const genericGrant = release.indexOf(
    "'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I'",
  );
  const exactGrant = release.indexOf('\\i apps/api/prisma/agent-missions-runtime-grants.sql');
  const grantTransactionEnd = release.indexOf('\nSQL\n}', exactGrant);
  const rlsReplay = release.indexOf('-f apps/api/prisma/rls.sql');
  const exactCertificate = release.indexOf('certify_agent_mission_release_acl', rlsReplay);
  assert.ok(genericGrant >= 0, 'Le grant runtime des tables du déployeur attendu a disparu.');
  assert.ok(exactGrant > genericGrant, 'Les ACL exactes doivent être appliquées après le grant générique.');
  assert.ok(
    grantFunctionStart >= 0
      && singleTransaction > grantFunctionStart
      && singleTransaction < genericGrant
      && grantTransactionEnd > exactGrant,
    'Grant générique et ACL exactes doivent partager une transaction.',
  );
  assert.ok(rlsReplay > exactGrant, 'Le replay RLS doit suivre les ACL runtime exactes.');
  assert.ok(
    exactCertificate > rlsReplay,
    'Le certificat runtime doit lire le résultat final après le replay RLS.',
  );
  assert.match(release, /connected_role="\$\([\s\S]*?APP_DATABASE_ROLE/u);
});

test('les ACL exactes utilisent SET ROLE propriétaire et une allowlist minimale', () => {
  assert.doesNotMatch(runtimeGrants, /\b(?:BEGIN|COMMIT);/u);
  assert.match(runtimeGrants, /pg_has_role\(current_user, owner_oid, 'SET'\)/u);
  assert.match(
    runtimeGrants,
    /SET ROLE %I; REVOKE ALL PRIVILEGES ON TABLE[\s\S]*?GRANT %s ON TABLE/u,
  );
  assert.match(runtimeGrants, /REVOKE SELECT \(%I\), INSERT \(%I\), UPDATE \(%I\), REFERENCES \(%I\)/u);
  assert.match(
    runtimeGrants,
    /'agent_missions'::TEXT,[\s\S]*?'SELECT, INSERT, UPDATE'::TEXT,[\s\S]*?'DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(
    runtimeGrants,
    /'agent_mission_events'::TEXT,[\s\S]*?'SELECT, INSERT'::TEXT,[\s\S]*?'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(runtimeGrants, /REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I/u);
  assert.match(
    runtimeGrants,
    /'release_flags'::TEXT,[\s\S]*?'SELECT'::TEXT,[\s\S]*?'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(
    runtimeGrants,
    /'release_flag_subjects'::TEXT,[\s\S]*?'SELECT'::TEXT,[\s\S]*?'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(
    runtimeGrants,
    /REVOKE ALL PRIVILEGES ON TABLE public\.release_flag_audit_events/u,
  );
  assert.match(
    runtimeGrants,
    /GRANT EXECUTE ON FUNCTION %s TO %I[\s\S]*?revalidate_agent_mission_release_flag_v1/u,
  );
});

test('le certificat s’exécute comme runtime non-superuser et ferme Data API + triggers', () => {
  assert.match(releaseCertificate, /current_user = :'app_role'/u);
  assert.match(releaseCertificate, /rolsuper OR runtime_role\.rolbypassrls/u);
  assert.match(releaseCertificate, /relrowsecurity[\s\S]*?relforcerowsecurity/u);
  assert.match(releaseCertificate, /has_any_column_privilege/u);
  for (const privilege of [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER',
  ]) {
    assert.match(releaseCertificate, new RegExp(`'${privilege}'`, 'u'));
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(releaseCertificate, new RegExp(`'${role}'`, 'u'));
  }
  for (const functionName of [
    'guard_agent_mission_mutation_v1',
    'guard_quote_draft_agent_mission_v1',
    'reject_agent_mission_event_mutation_v1',
    'guard_agent_mission_event_append_v1',
    'require_agent_mission_event_v1',
  ]) {
    assert.match(releaseCertificate, new RegExp(`${functionName}\\\\?\\(\\)`, 'u'));
  }
});

test('la capability realtime est provisionnée sous un owner NOLOGIN avant sa certification', () => {
  const ensureBeforeMigrate = release.indexOf(
    'ensure_agent_mission_release_flag_authority_role',
    release.indexOf('pnpm --filter'),
  );
  const migrate = release.indexOf('prisma migrate deploy');
  const rlsReplay = release.indexOf('-f apps/api/prisma/rls.sql');
  const provision = release.indexOf(
    'provision_agent_mission_release_flag_authority',
    rlsReplay,
  );
  const certificate = release.indexOf(
    'certify_agent_mission_realtime_release_acl',
    provision,
  );
  assert.ok(ensureBeforeMigrate >= 0 && ensureBeforeMigrate < migrate);
  assert.ok(rlsReplay > migrate && provision > rlsReplay && certificate > provision);
  assert.match(release, /agent-mission-release-flag-authority-role\.sql/u);
  assert.match(release, /agent-mission-release-flag-authority-provision\.sql/u);
  assert.match(authorityRole, /SET createrole_self_grant = 'set'/u);
  assert.match(
    authorityRole,
    /CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS[\s\S]*?bob_agent_mission_release_flag_authority/u,
  );
  assert.doesNotMatch(
    authorityRole,
    /GRANT\s+bob_agent_mission_release_flag_authority\s+TO\s+(?:postgres|"?\$\{?APP_DATABASE_ROLE)/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /runtime_role\.rolsuper OR runtime_role\.rolbypassrls/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /capability_attribute\.atttypid[\s\S]*?capability_attribute\.atttypmod[\s\S]*?capability_attribute\.atthasdef[\s\S]*?capability_attribute\.attidentity[\s\S]*?capability_attribute\.attgenerated/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /pg_get_constraintdef\(capability_constraint\.oid, TRUE\)[\s\S]*?AgentMission realtime lease constraint definition drift/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /guard_realtime_agent_mission_capability_immutable_v1\(\)[\s\S]*?capability_trigger\.tgtype <> 19[\s\S]*?expected_trigger_attributes IS DISTINCT FROM actual_trigger_attributes/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /has_function_privilege\(current_user, capability_guard\.oid, 'EXECUTE'\)/u,
  );
  assert.match(realtimeReleaseCertificate, /pg_temp, public, pg_catalog/u);
  assert.match(
    realtimeReleaseCertificate,
    /revalidate_agent_mission_release_flag_v1\(text,text,integer\)/u,
  );
  assert.match(
    authorityProvision,
    /REVOKE SELECT \(%I\), INSERT \(%I\), UPDATE \(%I\), REFERENCES \(%I\)[\s\S]*?bob_agent_mission_release_flag_authority/u,
  );
  assert.match(
    authorityProvision,
    /REVOKE CREATE ON SCHEMA public FROM bob_agent_mission_release_flag_authority[\s\S]*?GRANT USAGE ON SCHEMA public/u,
  );
  assert.match(
    authorityProvision,
    /has_schema_privilege\(authority\.rolname, 'public', 'CREATE'\)/u,
  );
  assert.match(
    authorityProvision,
    /has_any_column_privilege\([\s\S]*?release_flag_subjects/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /release_relation IN ARRAY ARRAY\[[\s\S]*?has_any_column_privilege/u,
  );
  assert.match(release, /CABINET_RELEASE_ENV is required/u);
  assert.match(
    release,
    /release_flag_snapshot="\$\([\s\S]*?bob\.agent_missions\.quote\.v1[\s\S]*?release_flag_kill_switch="\$\{release_flag_snapshot#\*\|\}"[\s\S]*?-v release_env="\$CABINET_RELEASE_ENV"[\s\S]*?-v release_flag_version="\$release_flag_version"[\s\S]*?-v release_flag_kill_switch="\$release_flag_kill_switch"/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /expected_release_environment[\s\S]*?expected_release_flag_version[\s\S]*?expected_release_flag_kill_switch[\s\S]*?wrong_lower_release_flag_version[\s\S]*?wrong_upper_release_flag_version/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /FOREACH required_privilege IN ARRAY ARRAY\[[\s\S]*?'SELECT', 'INSERT', 'UPDATE', 'DELETE'[\s\S]*?has_table_privilege\([\s\S]*?required_privilege/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /exact_release_flag_revalidation IS DISTINCT FROM[\s\S]*?NOT expected_release_flag_kill_switch/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /bob\.agent_missions\.invoice\.v1[\s\S]*?AgentMission release flag wrong key was accepted/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /bob_mistral_bootstrap_reaper[\s\S]*?lease_column IN \('companyId', 'sessionId'\)/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /bob_realtime_reaper_directory[\s\S]*?has_any_column_privilege/u,
  );
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(realtimeReleaseCertificate, new RegExp(`'${role}'`, 'u'));
  }
});

test('local et CI statique exercent les mêmes ACL que release', () => {
  assert.match(localCertificate, /agent-missions-runtime-grants\.sql/u);
  assert.match(localCertificate, /agent-missions-release-cert\.sql/u);
  assert.match(localCertificate, /agent-mission-release-flag-authority-role\.sql/u);
  assert.match(localCertificate, /agent-mission-release-flag-authority-provision\.sql/u);
  assert.match(localCertificate, /agent-mission-realtime-rls-replay\.sql/u);
  assert.match(localCertificate, /CREATE ROLE bob_mistral_bootstrap_reaper/u);
  assert.match(localCertificate, /CREATE ROLE bob_realtime_reaper_directory/u);
  assert.doesNotMatch(
    localCertificate,
    /ALTER FUNCTION public\.revalidate_agent_mission_release_flag_v1[\s\S]*?OWNER TO bob_agent_mission_release_flag_authority/u,
  );
  const parsedPackage = JSON.parse(packageJson);
  assert.match(
    parsedPackage.scripts['test:release-flags'],
    /agent-missions-release-safety\.test\.mjs/u,
  );
  assert.match(parsedPackage.scripts.test, /agent-missions-release-safety\.test\.mjs/u);
});

test('la CI exécute la preuve PostgreSQL 17 avec un déployeur non-superuser', () => {
  assert.match(ci, /agent-missions-postgres-certification:/u);
  assert.match(ci, /image: postgres:17/u);
  assert.match(ci, /AGENT_MISSION_CERT_SUPER_URL:/u);
  assert.match(ci, /AGENT_MISSION_CERT_DEPLOYER_BOOTSTRAP_URL:/u);
  assert.match(ci, /run: sh apps\/api\/scripts\/certify-agent-missions-local\.sh/u);
  assert.match(localCertificate, /CREATE ROLE bob_deployer[\s\S]*?NOSUPERUSER/u);
  assert.match(localCertificate, /SET createrole_self_grant = 'set'/u);

  const expand = localCertificate.indexOf('20260726010000_agent_missions_expand');
  const intermediateWriter = localCertificate.indexOf('SET "revision" = 2', expand);
  const validate = localCertificate.indexOf(
    '20260726020000_agent_missions_validate',
    intermediateWriter,
  );
  const finalWriter = localCertificate.indexOf('SET "revision" = 3', validate);
  assert.ok(
    expand >= 0
      && intermediateWriter > expand
      && validate > intermediateWriter
      && finalWriter > validate,
    'Le writer N-1 doit être tenté après expand puis après validate.',
  );

  const capabilityExpand = localCertificate.indexOf(
    '20260726040000_agent_mission_realtime_lease_expand',
  );
  const capabilityIntermediateWriter = localCertificate.indexOf(
    'AGENT_MISSION_WRITER_N1_EXPAND_NULL_SHAPE_DRIFT',
    capabilityExpand,
  );
  const capabilityValidate = localCertificate.indexOf(
    '20260726050000_agent_mission_realtime_lease_validate',
    capabilityIntermediateWriter,
  );
  const capabilityFinalWriter = localCertificate.indexOf(
    'AGENT_MISSION_WRITER_N1_VALIDATE_NULL_SHAPE_DRIFT',
    capabilityValidate,
  );
  assert.ok(
    capabilityExpand >= 0
      && capabilityIntermediateWriter > capabilityExpand
      && capabilityValidate > capabilityIntermediateWriter
      && capabilityFinalWriter > capabilityValidate,
    'Le writer admission N-1 doit être tenté après capability expand puis après validate.',
  );
  assert.match(localCertificate, /AGENT_MISSION_PARTIAL_BINDING_ACCEPTED_AFTER_EXPAND/u);
  assert.match(localCertificate, /AGENT_MISSION_PARTIAL_BINDING_ACCEPTED_AFTER_VALIDATE/u);
  assert.match(localCertificate, /AGENT_MISSION_NULL_LEASE_PROMOTED_AFTER_EXPAND/u);
  assert.match(localCertificate, /AGENT_MISSION_V1_BINDING_REWRITTEN_AFTER_EXPAND/u);
  assert.match(localCertificate, /AGENT_MISSION_NULL_LEASE_PROMOTED_AFTER_VALIDATE/u);
  assert.match(localCertificate, /AGENT_MISSION_V1_BINDING_REWRITTEN_AFTER_VALIDATE/u);
  assert.match(localCertificate, /AGENT_MISSION_CABINET_DELETE_FLAG_VERSION_DRIFT/u);
  for (const migration of [
    '20260713220000_realtime_admission_leases',
    '20260713223000_realtime_screen_context',
    '20260713230000_realtime_durable_speech',
    '20260714010000_realtime_speech_fencing_hardening',
    '20260714020000_realtime_provider_identity',
    '20260714030000_realtime_mistral_ingress_tickets',
    '20260722030000_realtime_reaper_directory',
    '20260722040000_realtime_global_capacity',
  ]) {
    assert.match(localCertificate, new RegExp(migration, 'u'));
  }
  assert.doesNotMatch(localCertificate, /CREATE TABLE public\.realtime_session_leases/u);
  assert.ok(
    (localCertificate.match(/WITH authoritative_clock AS MATERIALIZED/gmu) ?? []).length >= 3,
    'Les writers N-1/N+1 doivent partager une unique horloge autoritaire par INSERT.',
  );
  assert.match(
    localCertificate,
    /AGENT_MISSION_CERT_NON_INITIAL_VERSION[\s\S]*?SET version = version \+ 1,[\s\S]*?"killSwitch" = TRUE[\s\S]*?agent_mission_release_flag_snapshot/u,
  );
});
