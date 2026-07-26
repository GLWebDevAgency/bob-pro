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
  realtimeCapacityRelease,
  localCertificate,
  runtimeGrants,
  releaseCertificate,
  realtimeReleaseCertificate,
  authorityRole,
  authorityProvision,
  realtimeRlsReplay,
  reaperReleaseCertificate,
  rlsCertificate,
  packageJson,
  ci,
  railway,
  infrastructure,
  invoiceSettlementRunbook,
  documentArchiveRunbook,
] = await Promise.all([
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'realtime-capacity-release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-agent-missions-local.sh'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-missions-runtime-grants.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-missions-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-realtime-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-release-flag-authority-role.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-release-flag-authority-provision.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-realtime-rls-replay.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/realtime-reaper-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/rls-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'package.json'), 'utf8'),
  readFile(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
  readFile(path.join(repositoryRoot, '.github/workflows/railway-api.yml'), 'utf8'),
  readFile(path.join(repositoryRoot, 'docs/architecture/infrastructure-environnements.md'), 'utf8'),
  readFile(path.join(repositoryRoot, 'docs/runbooks/invoice-settlement-v2-rollout.md'), 'utf8'),
  readFile(path.join(repositoryRoot, 'docs/runbooks/document-archive-v2-rollout.md'), 'utf8'),
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
  assert.ok(
    exactGrant > genericGrant,
    'Les ACL exactes doivent être appliquées après le grant générique.',
  );
  assert.ok(
    grantFunctionStart >= 0 &&
      singleTransaction > grantFunctionStart &&
      singleTransaction < genericGrant &&
      grantTransactionEnd > exactGrant,
    'Grant générique et ACL exactes doivent partager une transaction.',
  );
  assert.ok(rlsReplay > exactGrant, 'Le replay RLS doit suivre les ACL runtime exactes.');
  assert.ok(
    exactCertificate > rlsReplay,
    'Le certificat runtime doit lire le résultat final après le replay RLS.',
  );
  assert.match(release, /connected_role="\$\([\s\S]*?APP_DATABASE_ROLE/u);
});

test('l’expand du fence ferme et draine réellement les pods N-1 avant migrate', () => {
  const ensure = release.indexOf(
    'DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/realtime-capacity-release.sh ensure',
  );
  const closeAndDrain = release.indexOf(
    'close_and_drain_realtime_before_cancellation_fence_expand',
    ensure,
  );
  const migrate = release.indexOf('prisma migrate deploy', closeAndDrain);
  assert.ok(
    ensure >= 0 && closeAndDrain > ensure && migrate > closeAndDrain,
    'La fermeture/drain N-1 doit précéder prisma migrate deploy.',
  );
  assert.match(
    release,
    /close_and_drain_realtime_before_cancellation_fence_expand\(\)[\s\S]*?20260726060000_realtime_admission_cancellation_fence_expand[\s\S]*?BOB_LIVE_ENABLED=false[\s\S]*?SET LOCAL ROLE bob_realtime_capacity[\s\S]*?closed\|0/u,
  );
  const cancellationDrain = release.slice(
    release.indexOf('close_and_drain_realtime_before_cancellation_fence_expand()'),
    release.indexOf('command -v pnpm'),
  );
  assert.doesNotMatch(
    cancellationDrain,
    /count\(\*\)[\s\S]*?realtime_session_leases/u,
    'Le drain global ne doit jamais compter une table tenantée sous FORCE RLS.',
  );
  assert.match(release, /Realtime cancellation fence expand requires a complete N-1 drain/u);
  assert.match(
    release,
    /BOB_RELEASE_PHASE:\?BOB_RELEASE_PHASE=predeploy or postdeploy is required/u,
  );
  assert.doesNotMatch(release, /BOB_RELEASE_PHASE="\$\{BOB_RELEASE_PHASE:-/u);
  assert.match(
    release,
    /REALTIME_CANCELLATION_FENCE_PREDECESSOR_CAPABLE is only valid during predeploy/u,
  );
  assert.match(
    release,
    /assert_realtime_cancellation_fence_ready_for_postdeploy\(\)[\s\S]*?20260726060000_realtime_admission_cancellation_fence_expand[\s\S]*?20260726070000_realtime_admission_cancellation_fence_validate[\s\S]*?\$\{cancellation_migrations:-missing\}" != 2/u,
  );
  const postdeployGuard = release.indexOf('if [ "$BOB_RELEASE_PHASE" = postdeploy ]');
  const build = release.indexOf("pnpm --filter '@bob/api...' run build", postdeployGuard);
  const phaseBranch = release.indexOf('if [ "$BOB_RELEASE_PHASE" = predeploy ]', build);
  const phaseMigrate = release.indexOf('prisma migrate deploy', phaseBranch);
  assert.ok(
    postdeployGuard >= 0 &&
      build > postdeployGuard &&
      phaseBranch > build &&
      phaseMigrate > phaseBranch,
  );
  assert.match(
    release.slice(postdeployGuard, build),
    /assert_realtime_cancellation_fence_ready_for_postdeploy[\s\S]*?realtime-capacity-release\.sh close-existing/u,
  );
  assert.match(realtimeCapacityRelease, /close_existing\(\)[\s\S]*?mode = 'closed'/u);
  assert.match(
    realtimeCapacityRelease,
    /close-existing\) close_existing[\s\S]*?configure\) configure/u,
  );
  assert.match(
    release.slice(phaseBranch, phaseMigrate),
    /close_and_drain_realtime_before_cancellation_fence_expand/u,
  );
  const checksumPhase = release.indexOf(
    'if [ "$BOB_RELEASE_PHASE" = predeploy ]',
    release.indexOf('assert-applied-migration-checksums.test.mjs'),
  );
  const legacyPreflight = release.indexOf(
    'check-document-archive-legacy-audience.sh',
    checksumPhase,
  );
  assert.match(
    release.slice(checksumPhase, legacyPreflight),
    /--allow-pending-local[\s\S]*?else[\s\S]*?assert-applied-migration-checksums\.mjs[\s\S]*?fi/u,
  );
  const migrateCommand = release.indexOf('prisma migrate deploy');
  const migratePhase = release.lastIndexOf(
    'if [ "$BOB_RELEASE_PHASE" = predeploy ]',
    migrateCommand,
  );
  const strictPostflight = release.indexOf(
    'node apps/api/scripts/assert-applied-migration-checksums.mjs',
    migrateCommand,
  );
  assert.match(
    release.slice(migratePhase, strictPostflight),
    /if \[ "\$BOB_RELEASE_PHASE" = predeploy \]; then[\s\S]*?prisma migrate deploy[\s\S]*?fi/u,
  );
});

test('le pipeline garde la capacité fermée jusqu’au SHA exact puis rouvre par postdeploy', () => {
  const predecessor = railway.indexOf(
    'Certify predecessor B2C HTTP fence before archive expansion',
  );
  const predecessorCapability = railway.indexOf('realtimeAdmissionCancellationFence', predecessor);
  const predeploy = railway.indexOf('env BOB_RELEASE_PHASE=predeploy', predecessorCapability);
  const deploy = railway.indexOf('railway up --service', predeploy);
  const topology = railway.indexOf('Re-certify the deployed replica topology', deploy);
  const readiness = railway.indexOf('Smoke API readiness', topology);
  const exactSha = railway.indexOf(
    'payload?.release?.sha !== process.env.EXPECTED_RELEASE_SHA',
    readiness,
  );
  const deployedCapability = railway.indexOf(
    "payload?.capabilities?.realtimeAdmissionCancellationFence !== 'v1'",
    exactSha,
  );
  const immediatePostdeployStep = railway.indexOf(
    'Postdeploy certify and reopen Bob Live',
    deployedCapability,
  );
  const immediatePostdeploy = railway.indexOf(
    'env BOB_RELEASE_PHASE=postdeploy',
    immediatePostdeployStep,
  );
  const archiveAudit = railway.indexOf(
    'Preflight and run the isolated Railway archive byte-audit',
    immediatePostdeploy,
  );
  const activation = railway.indexOf(
    'Retire the previous Mistral key, activate archive/settlement/outbox v2',
    archiveAudit,
  );
  const postActivationRecertification = railway.indexOf(
    'env BOB_RELEASE_PHASE=postdeploy',
    activation,
  );
  assert.ok(
    predecessor >= 0 &&
      predecessorCapability > predecessor &&
      predeploy > predecessorCapability &&
      deploy > predeploy &&
      topology > deploy &&
      readiness > topology &&
      exactSha > readiness &&
      deployedCapability > exactSha &&
      immediatePostdeployStep > deployedCapability &&
      immediatePostdeploy > immediatePostdeployStep &&
      archiveAudit > immediatePostdeploy &&
      activation > archiveAudit &&
      postActivationRecertification > activation,
    'Le pipeline doit fermer, déployer, prouver topologie/SHA/capability, rouvrir par postdeploy puis recertifier après activation.',
  );
  assert.doesNotMatch(
    railway.slice(readiness, archiveAudit),
    /realtime-capacity-release\.sh configure/u,
    'Aucun raccourci ne doit rouvrir Bob Live sans la certification postdeploy complète.',
  );
  assert.match(
    railway,
    /REALTIME_CANCELLATION_FENCE_PREDECESSOR_CAPABLE: \$\{\{ steps\.predecessor_capabilities\.outputs\.realtime_cancellation_fence \}\}/u,
  );
  assert.match(
    ci,
    /BOB_RELEASE_PHASE=predeploy sh apps\/api\/scripts\/release\.sh[\s\S]*?BOB_RELEASE_PHASE=postdeploy sh apps\/api\/scripts\/release\.sh/u,
  );
  assert.match(
    infrastructure,
    /BOB_RELEASE_PHASE=predeploy[\s\S]*?closed\|0[\s\S]*?SHA complet[\s\S]*?realtimeAdmissionCancellationFence:v1[\s\S]*?BOB_RELEASE_PHASE=postdeploy/u,
  );
  assert.equal(
    (railway.match(/--connect-timeout 3 --max-time 10/gu) ?? []).length,
    3,
    'Chaque probe HTTP de release doit être bornée.',
  );
  assert.equal(
    (railway.match(/timeout 20s railway status/gu) ?? []).length,
    2,
    'Les deux lectures de topologie Railway doivent avoir une deadline.',
  );
});

test('les ACL exactes utilisent SET ROLE propriétaire et une allowlist minimale', () => {
  assert.doesNotMatch(runtimeGrants, /\b(?:BEGIN|COMMIT);/u);
  assert.match(runtimeGrants, /pg_has_role\(current_user, owner_oid, 'SET'\)/u);
  assert.match(
    runtimeGrants,
    /SET ROLE %I; REVOKE ALL PRIVILEGES ON TABLE[\s\S]*?GRANT %s ON TABLE/u,
  );
  assert.match(
    runtimeGrants,
    /REVOKE SELECT \(%I\), INSERT \(%I\), UPDATE \(%I\), REFERENCES \(%I\)/u,
  );
  assert.match(
    runtimeGrants,
    /'agent_missions'::TEXT,[\s\S]*?'SELECT, INSERT, UPDATE'::TEXT,[\s\S]*?'DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(
    runtimeGrants,
    /'agent_mission_events'::TEXT,[\s\S]*?'SELECT, INSERT'::TEXT,[\s\S]*?'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(
    runtimeGrants,
    /'realtime_admission_cancellation_fences'::TEXT,[\s\S]*?'SELECT, INSERT, DELETE'::TEXT,[\s\S]*?'UPDATE, TRUNCATE, REFERENCES, TRIGGER'/u,
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
  assert.match(runtimeGrants, /REVOKE ALL PRIVILEGES ON TABLE public\.release_flag_audit_events/u);
  assert.match(
    runtimeGrants,
    /GRANT EXECUTE ON FUNCTION %s TO %I[\s\S]*?revalidate_agent_mission_release_flag_v1/u,
  );
  assert.match(
    runtimeGrants,
    /guard_realtime_admission_cancellation_fence_v1[\s\S]*?sync_realtime_admission_cancellation_schedule_v1/u,
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
  const provision = release.indexOf('provision_agent_mission_release_flag_authority', rlsReplay);
  const certificate = release.indexOf('certify_agent_mission_realtime_release_acl', provision);
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
  assert.match(realtimeReleaseCertificate, /runtime_role\.rolsuper OR runtime_role\.rolbypassrls/u);
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
  assert.match(authorityProvision, /has_any_column_privilege\([\s\S]*?release_flag_subjects/u);
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

test('le fence d’annulation est certifié comme autorité tenantée et invisible aux rôles globaux', () => {
  assert.match(
    release,
    /REVOKE UPDATE, REFERENCES, TRIGGER[\s\S]*?realtime_admission_cancellation_fences[\s\S]*?FROM :"app_role"/u,
  );
  assert.match(
    release,
    /REVOKE ALL[\s\S]*?guard_realtime_admission_cancellation_fence_v1\(\)[\s\S]*?FROM :"app_role"/u,
  );
  assert.match(
    release,
    /REVOKE ALL[\s\S]*?sync_realtime_admission_cancellation_schedule_v1\(\)[\s\S]*?FROM :"app_role"/u,
  );
  assert.match(realtimeRlsReplay, /realtime_admission_cancellation_fences[\s\S]*?FROM PUBLIC/u);
  assert.match(
    realtimeRlsReplay,
    /guard_realtime_admission_cancellation_fence_v1\(\)[\s\S]*?sync_realtime_admission_cancellation_schedule_v1\(\)[\s\S]*?exposed_role\.rolname IN \('anon', 'authenticated', 'service_role'\)/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /cancellation_relation[\s\S]*?relrowsecurity[\s\S]*?relforcerowsecurity/u,
  );
  for (const column of ['companyId', 'sessionId', 'subjectHash', 'cancelledAt', 'expiresAt']) {
    assert.match(realtimeReleaseCertificate, new RegExp(`'${column}'`, 'u'));
  }
  assert.match(
    realtimeReleaseCertificate,
    /realtime_admission_cancellation_fences_shape_check[\s\S]*?convalidated/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /realtime_admission_cancellation_fences_company_fkey[\s\S]*?confupdtype <> 'c'[\s\S]*?confdeltype <> 'c'/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /realtime_session_lease_00_admission_cancellation_fence_guard[\s\S]*?tgtype <> 7/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /realtime_admission_cancellation_reaper_schedule_insert[\s\S]*?tgtype <> 4[\s\S]*?tgnewtable <> 'new_rows'/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /ARRAY\['SELECT', 'INSERT', 'DELETE'\][\s\S]*?Realtime cancellation fence runtime ACL missing/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /bob_mistral_bootstrap_reaper[\s\S]*?cancellation_relation\.oid/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /bob_realtime_reaper_directory[\s\S]*?cancellation_relation\.oid/u,
  );
  assert.match(
    reaperReleaseCertificate,
    /'realtime_admission_cancellation_fences'[\s\S]*?Realtime reaper directory leaked source access/u,
  );
  const cancellationRuntimeProof = rlsCertificate.indexOf(
    'Bob Live cancellation : cette autorité doit rester certifiée',
  );
  const activeCapacityGate = rlsCertificate.indexOf(
    '\\if :bob_live_capacity_active',
    cancellationRuntimeProof,
  );
  assert.ok(
    cancellationRuntimeProof >= 0 && activeCapacityGate > cancellationRuntimeProof,
    'La preuve runtime du fence doit s’exécuter avant le gate de capacité Bob Live.',
  );
  assert.match(
    rlsCertificate.slice(cancellationRuntimeProof, activeCapacityGate),
    /realtime_admission_cancellation_fences[\s\S]*?realtime_reaper_tenant_schedule[\s\S]*?realtime_session_leases[\s\S]*?SQLSTATE '55000'[\s\S]*?cross-tenant cancellation fence insert/u,
  );
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
  assert.equal(parsedPackage.scripts.release, undefined);
  assert.equal(
    parsedPackage.scripts['release:predeploy'],
    'BOB_RELEASE_PHASE=predeploy sh scripts/release.sh',
  );
  assert.equal(
    parsedPackage.scripts['release:postdeploy'],
    'BOB_RELEASE_PHASE=postdeploy sh scripts/release.sh',
  );
  assert.match(
    parsedPackage.scripts['test:release-flags'],
    /agent-missions-release-safety\.test\.mjs/u,
  );
  assert.match(parsedPackage.scripts.test, /agent-missions-release-safety\.test\.mjs/u);
  for (const runbook of [invoiceSettlementRunbook, documentArchiveRunbook]) {
    assert.doesNotMatch(
      runbook,
      /(?:Exécuter|Rejouer) `release\.sh`/u,
      'Les runbooks actifs doivent rendre la phase de release explicite.',
    );
    assert.match(runbook, /BOB_RELEASE_PHASE=predeploy sh apps\/api\/scripts\/release\.sh/u);
    assert.match(runbook, /BOB_RELEASE_PHASE=postdeploy sh apps\/api\/scripts\/release\.sh/u);
  }
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
    expand >= 0 &&
      intermediateWriter > expand &&
      validate > intermediateWriter &&
      finalWriter > validate,
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
    capabilityExpand >= 0 &&
      capabilityIntermediateWriter > capabilityExpand &&
      capabilityValidate > capabilityIntermediateWriter &&
      capabilityFinalWriter > capabilityValidate,
    'Le writer admission N-1 doit être tenté après capability expand puis après validate.',
  );
  const cancellationExpand = localCertificate.indexOf(
    '20260726060000_realtime_admission_cancellation_fence_expand',
    capabilityFinalWriter,
  );
  const cancellationIntermediateWriter = localCertificate.indexOf(
    'REALTIME_CANCELLATION_WRITER_N1_ACCEPTED_AFTER_EXPAND',
    cancellationExpand,
  );
  const cancellationValidate = localCertificate.indexOf(
    '20260726070000_realtime_admission_cancellation_fence_validate',
    cancellationIntermediateWriter,
  );
  const cancellationFinalWriter = localCertificate.indexOf(
    'REALTIME_CANCELLATION_WRITER_N1_ACCEPTED_AFTER_VALIDATE',
    cancellationValidate,
  );
  assert.ok(
    cancellationExpand > capabilityFinalWriter &&
      cancellationIntermediateWriter > cancellationExpand &&
      cancellationValidate > cancellationIntermediateWriter &&
      cancellationFinalWriter > cancellationValidate,
    'Le writer N-1 doit être tenté après cancellation expand puis après validate.',
  );
  assert.match(localCertificate, /REALTIME_CANCELLATION_LEASE_SURVIVED_AFTER_EXPAND/u);
  assert.match(localCertificate, /REALTIME_CANCELLATION_LEASE_SURVIVED_AFTER_VALIDATE/u);
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
