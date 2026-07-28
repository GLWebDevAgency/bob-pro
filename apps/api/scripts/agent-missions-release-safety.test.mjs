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
  releaseProtocolActivation,
  notificationOutboxActivation,
  realtimeCapacityRelease,
  localCertificate,
  fingerprintManager,
  runtimeGrants,
  releaseCertificate,
  realtimeReleaseCertificate,
  authorityRole,
  authorityProvision,
  fingerprintReadinessAuthorityRole,
  fingerprintReadinessAuthorityProvision,
  realtimeRlsReplay,
  rlsOwnerSplitCertificate,
  reaperReleaseCertificate,
  rls,
  rlsCertificate,
  cabinetRlsCertificate,
  packageJson,
  ci,
  railway,
  infrastructure,
  invoiceSettlementRunbook,
  documentArchiveRunbook,
] = await Promise.all([
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'activate-release-protocols-v2.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'activate-notification-outbox-v2.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'realtime-capacity-release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-agent-missions-local.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'manage-agent-mission-fingerprint-key-versions.mjs'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-missions-runtime-grants.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-missions-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-realtime-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-release-flag-authority-role.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-mission-release-flag-authority-provision.sql'), 'utf8'),
  readFile(
    path.join(apiDir, 'prisma/agent-mission-fingerprint-readiness-authority-role.sql'),
    'utf8',
  ),
  readFile(
    path.join(apiDir, 'prisma/agent-mission-fingerprint-readiness-authority-provision.sql'),
    'utf8',
  ),
  readFile(path.join(apiDir, 'prisma/agent-mission-realtime-rls-replay.sql'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-rls-owner-split.sh'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/realtime-reaper-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/rls.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/rls-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/cabinet-rls-cert.sql'), 'utf8'),
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
  const fingerprintProvision = release.indexOf(
    'provision_agent_mission_fingerprint_readiness_authority',
    rlsReplay,
  );
  const fingerprintStage = release.indexOf(
    'manage-agent-mission-fingerprint-key-versions.mjs stage',
    fingerprintProvision,
  );
  const exactCertificate = release.indexOf('certify_agent_mission_release_acl', fingerprintStage);
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
    fingerprintProvision > rlsReplay &&
      fingerprintStage > fingerprintProvision &&
      exactCertificate > fingerprintStage,
    'Le binding/floor doit être stageé après RLS+provision et avant certification.',
  );
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
    /close_and_drain_realtime_before_cancellation_fence_expand\(\)[\s\S]*?20260727160000_realtime_admission_cancellation_fence_expand[\s\S]*?BOB_LIVE_ENABLED=false[\s\S]*?SET LOCAL ROLE bob_realtime_capacity[\s\S]*?closed\|0/u,
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
    /assert_agent_mission_m1b_ready_for_postdeploy\(\)[\s\S]*?20260727140000_agent_mission_realtime_lease_expand[\s\S]*?20260727150000_agent_mission_realtime_lease_validate[\s\S]*?20260727160000_realtime_admission_cancellation_fence_expand[\s\S]*?20260727170000_realtime_admission_cancellation_fence_validate[\s\S]*?20260727180000_agent_mission_event_command_namespace_expand[\s\S]*?20260727190000_agent_mission_event_command_namespace_validate[\s\S]*?20260727200000_agent_mission_event_command_namespace_cutover[\s\S]*?20260727210000_agent_mission_fingerprint_key_readiness[\s\S]*?20260727220000_agent_mission_bootstrap_receipt_expand[\s\S]*?20260727230000_agent_mission_bootstrap_receipt_validate[\s\S]*?\$\{agent_mission_m1b_migrations:-missing\}" != 10/u,
  );
  const postdeployGuard = release.indexOf('if [ "$BOB_RELEASE_PHASE" = postdeploy ]');
  const postdeployExit = release.indexOf('\n  exit 0\nfi', postdeployGuard);
  const build = release.indexOf("pnpm --filter '@bob/api...' run build", postdeployExit);
  const phaseBranch = release.indexOf('if [ "$BOB_RELEASE_PHASE" = predeploy ]', build);
  const phaseMigrate = release.indexOf('prisma migrate deploy', phaseBranch);
  assert.ok(
    postdeployGuard >= 0 &&
      postdeployExit > postdeployGuard &&
      build > postdeployGuard &&
      phaseBranch > build &&
      phaseMigrate > phaseBranch,
  );
  const postdeployBody = release.slice(postdeployGuard, postdeployExit);
  assert.match(
    postdeployBody,
    /assert_agent_mission_m1b_ready_for_postdeploy[\s\S]*?release-phase-receipt\.mjs verify[\s\S]*?assert_postactivation_protocols/u,
  );
  assert.match(
    release,
    /assert_postactivation_protocols\(\)[\s\S]*?bob\.postactivation_release_sha[\s\S]*?evidence\."releaseSha"[\s\S]*?protocol-v2-verified/u,
    'Le finaliseur doit exiger la preuve archive du SHA exact, y compris après une activation antérieure.',
  );
  assert.doesNotMatch(
    postdeployBody,
    /(?:prisma migrate deploy|rls\.sql|provision_)/u,
    'Le corps final ne doit ni migrer, ni rejouer rls.sql, ni reprovisionner une autorité.',
  );
  const postdeployRetire = release.lastIndexOf(
    'manage-agent-mission-fingerprint-key-versions.mjs retire',
  );
  const mistralRetire = release.lastIndexOf('manage-mistral-conversation-key-version.mjs retire');
  const postdeployReopen = release.indexOf(
    'realtime-capacity-release.sh activate-existing',
    postdeployRetire,
  );
  assert.ok(
    mistralRetire > postdeployGuard &&
      postdeployRetire > mistralRetire &&
      postdeployRetire < postdeployExit &&
      postdeployReopen > postdeployRetire &&
      postdeployReopen < postdeployExit,
    'Le retrait N-1 doit suivre la certification du nouveau SHA et précéder la réouverture.',
  );
  assert.equal(
    (postdeployBody.match(/release-phase-receipt\.mjs verify/gu) ?? []).length,
    2,
    'Le reçu doit être vérifié avant les preuves puis immédiatement avant la réouverture.',
  );
  assert.equal(
    (postdeployBody.match(/assert_postactivation_protocols/gu) ?? []).length,
    2,
    'Les protocoles doivent être prouvés avant et après les certificats staging mutables.',
  );
  assert.match(
    postdeployBody,
    /run_nonproduction_postactivation_certifications[\s\S]*?certify_cabinet_worker_scope[\s\S]*?assert_postactivation_protocols[\s\S]*?release-phase-receipt\.mjs verify[\s\S]*?manage-mistral-conversation-key-version\.mjs retire/u,
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
  const allowPendingChecksum = release.indexOf(
    'node apps/api/scripts/assert-applied-migration-checksums.mjs --allow-pending-local',
  );
  const checksumPhase = release.lastIndexOf(
    'if [ "$BOB_RELEASE_PHASE" = predeploy ]',
    allowPendingChecksum,
  );
  const legacyPreflight = release.indexOf(
    'check-document-archive-legacy-audience.sh',
    allowPendingChecksum,
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

test('le pipeline garde la capacité fermée jusqu’aux activations puis finalise une seule fois', () => {
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
  const bootstrapReceiptCapability = railway.indexOf(
    "payload?.capabilities?.agentMissionBootstrapReceipt !== 'v1'",
    deployedCapability,
  );
  const archiveAudit = railway.indexOf(
    'Preflight and run the isolated Railway archive byte-audit',
    bootstrapReceiptCapability,
  );
  const activation = railway.indexOf(
    'Activate archive/settlement/outbox v2 and finalize the certified release',
    archiveAudit,
  );
  const preactivationRevisionProbe = railway.indexOf(
    'certify_exact_revision before-activation',
    activation,
  );
  const postactivationRevisionProbe = railway.indexOf(
    'certify_exact_revision before-postdeploy',
    preactivationRevisionProbe,
  );
  const finalPostdeploy = railway.indexOf('env BOB_RELEASE_PHASE=postdeploy', activation);
  assert.ok(
    predecessor >= 0 &&
      predecessorCapability > predecessor &&
      predeploy > predecessorCapability &&
      deploy > predeploy &&
      topology > deploy &&
      readiness > topology &&
      exactSha > readiness &&
      deployedCapability > exactSha &&
      bootstrapReceiptCapability > deployedCapability &&
      archiveAudit > bootstrapReceiptCapability &&
      activation > archiveAudit &&
      preactivationRevisionProbe > activation &&
      postactivationRevisionProbe > preactivationRevisionProbe &&
      finalPostdeploy > postactivationRevisionProbe,
    'Le pipeline doit fermer, déployer, prouver le SHA, auditer, activer puis finaliser.',
  );
  assert.equal(
    (railway.match(/env BOB_RELEASE_PHASE=postdeploy/gu) ?? []).length,
    1,
    'Le workflow Railway ne doit exécuter qu’un seul postdeploy.',
  );
  assert.doesNotMatch(
    railway.slice(readiness, activation),
    /BOB_RELEASE_PHASE=postdeploy|realtime-capacity-release\.sh configure/u,
    'Aucune réouverture ne doit précéder l’audit et les activations.',
  );
  assert.match(
    railway.slice(predeploy, deploy),
    /BOB_RELEASE_SHA="\$GITHUB_SHA"[\s\S]*?BOB_RELEASE_RUN_ID="\$GITHUB_RUN_ID"[\s\S]*?BOB_RELEASE_RUN_ATTEMPT="\$GITHUB_RUN_ATTEMPT"/u,
  );
  assert.match(
    railway.slice(finalPostdeploy, railway.indexOf('\n      - name:', finalPostdeploy)),
    /BOB_RELEASE_EXPECTED_ENV="\$TARGET_ENVIRONMENT_NAME"[\s\S]*?BOB_RELEASE_SHA="\$GITHUB_SHA"[\s\S]*?BOB_RELEASE_RUN_ID="\$GITHUB_RUN_ID"[\s\S]*?BOB_RELEASE_RUN_ATTEMPT="\$GITHUB_RUN_ATTEMPT"/u,
  );
  assert.match(
    railway.slice(predeploy, deploy),
    /BOB_RELEASE_EXPECTED_ENV="\$RELEASE_ENVIRONMENT"/u,
  );
  assert.match(
    railway.slice(activation, finalPostdeploy),
    /certify_exact_revision\(\)[\s\S]*?timeout 20s railway status[\s\S]*?payload\?\.release\?\.sha !== process\.env\.EXPECTED_RELEASE_SHA[\s\S]*?payload\?\.release\?\.environment !== process\.env\.EXPECTED_RELEASE_ENVIRONMENT[\s\S]*?certify_exact_revision before-activation[\s\S]*?activate-release-protocols-v2\.sh[\s\S]*?certify_exact_revision before-postdeploy/u,
  );
  assert.match(
    releaseProtocolActivation,
    /assert-database-pair\.mjs[\s\S]*?release-phase-receipt\.mjs verify[\s\S]*?activate-document-archive-v2\.sh[\s\S]*?activate-invoice-settlement-v2\.sh[\s\S]*?activate-notification-outbox-v2\.sh/u,
    'Les trois activations doivent partager le snapshot Railway déjà relié au reçu.',
  );
  assert.equal(
    (railway.match(/payload\?\.network\?\.clientIpSource !== 'railway-x-real-ip'/gu) ?? []).length,
    2,
    'La source IP doit être attestée à la readiness initiale et dans chaque re-probe critique.',
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
    /BOB_RELEASE_PHASE=predeploy[\s\S]*?closed\|0[\s\S]*?SHA complet[\s\S]*?audit archive[\s\S]*?activations[\s\S]*?BOB_RELEASE_PHASE=postdeploy/u,
  );
  assert.equal(
    (railway.match(/--connect-timeout 3 --max-time 10/gu) ?? []).length,
    4,
    'Chaque probe HTTP de release doit être bornée.',
  );
  assert.equal(
    (railway.match(/timeout 20s railway status/gu) ?? []).length,
    3,
    'Les trois lectures de topologie Railway doivent avoir une deadline.',
  );
  assert.equal(
    (ci.match(/BOB_RELEASE_EXPECTED_ENV: development/gu) ?? []).length,
    3,
    'Chaque job PostgreSQL qui appelle release.sh doit figer son environnement attendu.',
  );
  assert.match(
    release,
    /BOB_RELEASE_EXPECTED_ENV:\?BOB_RELEASE_EXPECTED_ENV is required[\s\S]*?CABINET_RELEASE_ENV does not match the immutable release target/u,
  );
});

test('le gate Outbox V2 lie index et policy exacts à public.notification_jobs', () => {
  for (const source of [release, notificationOutboxActivation]) {
    assert.match(source, /catalog_index\.indrelid = 'public\.notification_jobs'::regclass/u);
    assert.match(source, /index_namespace\.nspname = 'public'/u);
    assert.match(
      source,
      /catalog_index\.indisvalid[\s\S]*?catalog_index\.indisready[\s\S]*?catalog_index\.indislive/u,
    );
    assert.match(
      source,
      /notification_jobs_due_deliverable_idx[\s\S]*?indoption::TEXT = '0 0 0'[\s\S]*?pg_get_indexdef\(catalog_index\.indexrelid, 3, false\) = '"createdAt"'[\s\S]*?pending''::"NotificationJobStatus"[\s\S]*?failed''::"NotificationJobStatus"[\s\S]*?payload IS NOT NULL/u,
    );
    assert.match(
      source,
      /notification_jobs_recent_idx[\s\S]*?indoption::TEXT = '0 3'[\s\S]*?catalog_index\.indpred IS NULL/u,
    );
    assert.match(
      source,
      /policy\.polroles = ARRAY\[0::OID\][\s\S]*?policy\.polqual[\s\S]*?policy\.polwithcheck/u,
    );
  }
  assert.match(
    release,
    /expected_outbox_payload_constraint[\s\S]*?expected_outbox_lease_constraint[\s\S]*?NotificationJobStatus[\s\S]*?conname = 'notification_jobs_payload_shape'[\s\S]*?contype = 'c'[\s\S]*?pg_get_constraintdef[\s\S]*?expected_outbox_payload_constraint[\s\S]*?conname = 'notification_jobs_lease_shape'[\s\S]*?contype = 'c'[\s\S]*?pg_get_constraintdef[\s\S]*?expected_outbox_lease_constraint/u,
  );
  assert.match(
    notificationOutboxActivation,
    /notification_jobs_payload_shape[\s\S]*?notification_jobs_lease_shape[\s\S]*?NotificationJobStatus[\s\S]*?contype[\s\S]*?pg_get_constraintdef/u,
  );
  assert.match(
    notificationOutboxActivation,
    /constraints_match_expected false[\s\S]*?constraint definition drift blocks activation[\s\S]*?indexes_are_verified[\s\S]*?notification-outbox-v2-activate\.sql/u,
    'Les contraintes et index homonymes doivent être refusés avant le cutover destructif.',
  );
  assert.doesNotMatch(
    notificationOutboxActivation,
    /WHERE index_class\.relname IN/u,
    'Un homonyme dans un autre schéma ne doit jamais satisfaire le certificat.',
  );
});

test('la production ne peut jamais atteindre les fixtures de certification', () => {
  const mutatingStart = release.indexOf('run_nonproduction_mutating_certifications()');
  const mutatingEnd = release.indexOf('\n}\n\ncommand -v pnpm', mutatingStart);
  const mutatingBody = release.slice(mutatingStart, mutatingEnd);
  assert.match(mutatingBody, /rls-cert-cabinet-seed\.sql/u);
  assert.match(mutatingBody, /certify-release-flag-ops\.sh/u);
  assert.match(mutatingBody, /pnpm --filter @bob\/api exec vitest run/u);
  assert.match(mutatingBody, /certify-mistral-conversation-authority\.sh/u);
  assert.doesNotMatch(
    mutatingBody,
    /(?:^|\n)[^\n]*&(?:\s|$)/u,
    'Les suites qui partagent la base doivent rester strictement séquentielles.',
  );

  const bootstrapPilots = release.indexOf('node apps/api/scripts/bootstrap-cabinet-pilots.mjs');
  const guardedCall = release.indexOf(
    'if [ "$CABINET_RELEASE_ENV" != production ]; then',
    bootstrapPilots,
  );
  const receiptWrite = release.indexOf('release-phase-receipt.mjs write', guardedCall);
  assert.match(
    release.slice(guardedCall, receiptWrite),
    /if \[ "\$CABINET_RELEASE_ENV" != production \]; then[\s\S]*?run_nonproduction_mutating_certifications[\s\S]*?fi/u,
  );
  assert.equal(
    (release.slice(mutatingEnd).match(/run_nonproduction_mutating_certifications/gu) ?? []).length,
    1,
    'Le corps mutable ne doit avoir qu’un seul point d’appel gardé.',
  );
  const closeBeforeReceipt = release.lastIndexOf(
    'realtime-capacity-release.sh configure',
    receiptWrite,
  );
  assert.ok(
    closeBeforeReceipt > guardedCall && receiptWrite > closeBeforeReceipt,
    'Le reçu doit être écrit après cleanup et fermeture finale.',
  );

  const postdeployGuard = release.indexOf('if [ "$BOB_RELEASE_PHASE" = postdeploy ]');
  const postdeployExit = release.indexOf('\n  exit 0\nfi', postdeployGuard);
  const postdeployBody = release.slice(postdeployGuard, postdeployExit);
  assert.match(
    postdeployBody,
    /if \[ "\$CABINET_RELEASE_ENV" != production \]; then[\s\S]*?run_nonproduction_postactivation_certifications[\s\S]*?fi/u,
  );
  const postactivationStart = release.indexOf('run_nonproduction_postactivation_certifications()');
  const postactivationEnd = release.indexOf('\n}\n\ncommand -v pnpm', postactivationStart);
  const postactivationBody = release.slice(postactivationStart, postactivationEnd);
  assert.match(postactivationBody, /rls-cert-cabinet-seed\.sql[\s\S]*?rls-cert\.sql/u);
  assert.match(
    postactivationBody,
    /release_sha="\$\{BOB_RELEASE_SHA-\$\{GITHUB_SHA-\}\}"[\s\S]*?-v release_sha="\$release_sha"/u,
  );
  assert.doesNotMatch(postactivationBody, /-v release_sha="\$BOB_RELEASE_SHA"/u);
  assert.equal(
    (postactivationBody.match(/pnpm --filter @bob\/api exec vitest run/gu) ?? []).length,
    2,
    'Le premier cutover ne doit rejouer que les deux certificats V2 ciblés.',
  );
  assert.match(
    postactivationBody,
    /document-archive-integrity\.postgres\.test\.ts[\s\S]*?invoice-settlement-semantics\.postgres\.test\.ts/u,
  );
});

test('les ACL exactes utilisent SET ROLE propriétaire et une allowlist minimale', () => {
  assert.match(
    realtimeRlsReplay,
    /SET LOCAL lock_timeout = '5s';[\s\S]*?SET LOCAL statement_timeout = '60s';/u,
  );
  assert.match(rls, /SET LOCAL lock_timeout = '5s';[\s\S]*?SET LOCAL statement_timeout = '60s';/u);
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
  assert.match(
    runtimeGrants,
    /REVOKE ALL PRIVILEGES ON TABLE public\.%I FROM %I[\s\S]*?'release_flag_audit_events'[\s\S]*?'agent_mission_fingerprint_key_version_floors'[\s\S]*?'agent_mission_fingerprint_key_bindings'/u,
  );
  assert.match(
    cabinetRlsCertificate,
    /assert_rejected\([\s\S]*?'SELECT count\(\*\) FROM release_flag_audit_events'[\s\S]*?'ops flag audit has no runtime table privilege'/u,
    'La preuve Cabinet doit attendre un refus SQL, pas confondre absence de rows RLS et absence de privilège.',
  );
  assert.doesNotMatch(
    cabinetRlsCertificate,
    /assert_eq\(\(SELECT count\(\*\) FROM release_flag_audit_events\)/u,
  );
  assert.match(
    cabinetRlsCertificate,
    /assert_rejected\([\s\S]*?'UPDATE release_flags[\s\S]*?'runtime has no release flag mutation privilege'/u,
    'La preuve Cabinet doit exiger un refus ACL sur la mutation du flag global.',
  );
  assert.doesNotMatch(
    cabinetRlsCertificate,
    /WITH changed_flag AS \([\s\S]*?UPDATE release_flags[\s\S]*?assert_eq/u,
    'Un UPDATE filtré par RLS ne prouve pas l’absence de privilège de mutation.',
  );
  assert.match(
    runtimeGrants,
    /GRANT EXECUTE ON FUNCTION %s TO %I[\s\S]*?revalidate_agent_mission_release_flag_v1[\s\S]*?agent_mission_fingerprint_key_readiness/u,
  );
  assert.match(
    runtimeGrants,
    /agent_mission_fingerprint_key_version_floors[\s\S]*?agent_mission_fingerprint_key_bindings/u,
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
  assert.match(
    releaseCertificate,
    /agent_mission_fingerprint_key_readiness\(integer\[\]\)[\s\S]*?RUNTIME_FUNCTION_EXECUTE_MISSING/u,
  );
  assert.match(releaseCertificate, /READINESS_FUNCTION_HARDENING_DRIFT/u);
  assert.match(
    releaseCertificate,
    /pg_has_role\([\s\S]*?readiness_authority_oid[\s\S]*?'MEMBER'[\s\S]*?pg_has_role\([\s\S]*?'SET'[\s\S]*?RUNTIME_READINESS_AUTHORITY_MEMBERSHIP_FORBIDDEN/u,
  );
  assert.match(
    releaseCertificate,
    /SELECT DISTINCT protected_owner\.owner_oid[\s\S]*?pg_has_role\(runtime_role\.oid, owner_role_oid, 'MEMBER'\)[\s\S]*?pg_has_role\(runtime_role\.oid, owner_role_oid, 'SET'\)[\s\S]*?RUNTIME_OWNER_MEMBERSHIP_FORBIDDEN/u,
  );
  assert.match(
    releaseCertificate,
    /pg_has_role\(exposed_role_oid, owner_role_oid, 'MEMBER'\)[\s\S]*?pg_has_role\(exposed_role_oid, owner_role_oid, 'SET'\)[\s\S]*?DATA_API_OWNER_MEMBERSHIP_FORBIDDEN/u,
  );
  assert.match(
    releaseCertificate,
    /FOR reachable_role_oid IN[\s\S]*?pg_has_role\(runtime_role\.oid, role\.oid, 'MEMBER'\)[\s\S]*?pg_has_role\(runtime_role\.oid, role\.oid, 'SET'\)[\s\S]*?RUNTIME_ROLE_MEMBERSHIP_FORBIDDEN/u,
  );
  assert.match(
    releaseCertificate,
    /FOR reachable_role_oid IN[\s\S]*?pg_has_role\(exposed_role_oid, role\.oid, 'MEMBER'\)[\s\S]*?pg_has_role\(exposed_role_oid, role\.oid, 'SET'\)[\s\S]*?DATA_API_ROLE_MEMBERSHIP_FORBIDDEN/u,
  );
  assert.match(
    releaseCertificate,
    /FROM public\.agent_mission_fingerprint_key_readiness\([\s\S]*?AGENT_MISSION_READINESS_RUNTIME_EXECUTION_INVALID/u,
  );
});

test('la readiness fingerprint utilise un owner NOLOGIN, une colonne et une policy dédiés', () => {
  const ensure = release.indexOf('ensure_agent_mission_fingerprint_readiness_authority_role');
  const migrate = release.indexOf('prisma migrate deploy', ensure);
  const rlsReplay = release.indexOf('-f apps/api/prisma/rls.sql', migrate);
  const provision = release.indexOf(
    'provision_agent_mission_fingerprint_readiness_authority',
    rlsReplay,
  );
  const stage = release.indexOf(
    'manage-agent-mission-fingerprint-key-versions.mjs stage',
    provision,
  );
  const certificate = release.indexOf('certify_agent_mission_release_acl', stage);
  assert.ok(
    ensure >= 0 &&
      ensure < migrate &&
      provision > rlsReplay &&
      stage > provision &&
      certificate > stage,
  );
  assert.match(fingerprintReadinessAuthorityRole, /SET createrole_self_grant = 'set'/u);
  assert.match(
    fingerprintReadinessAuthorityRole,
    /CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS[\s\S]*?bob_agent_mission_fingerprint_readiness/u,
  );
  assert.doesNotMatch(
    fingerprintReadinessAuthorityRole,
    /GRANT\s+bob_agent_mission_fingerprint_readiness\s+TO\s+postgres/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /GRANT SELECT \("fingerprintKeyVersion"\)[\s\S]*?agent_mission_events_fingerprint_readiness_select[\s\S]*?TO bob_agent_mission_fingerprint_readiness USING \(true\)/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /GRANT SELECT ON TABLE public\.agent_mission_fingerprint_key_version_floors[\s\S]*?agent_mission_fingerprint_key_floor_readiness_select/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /GRANT SELECT ON TABLE public\.agent_mission_fingerprint_key_bindings[\s\S]*?agent_mission_fingerprint_key_binding_readiness_select/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /REVOKE SELECT \(%I\), INSERT \(%I\), UPDATE \(%I\), REFERENCES \(%I\)[\s\S]*?agent_mission_fingerprint_key_version_floors[\s\S]*?agent_mission_fingerprint_key_bindings/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /has_any_column_privilege\([\s\S]*?agent_mission_fingerprint_key_version_floors[\s\S]*?'INSERT,UPDATE,REFERENCES'[\s\S]*?has_any_column_privilege\([\s\S]*?agent_mission_fingerprint_key_bindings/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /ALTER FUNCTION %s OWNER TO bob_agent_mission_fingerprint_readiness/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /SET LOCAL ROLE %I; DROP TRIGGER IF EXISTS agent_mission_events_00_fingerprint_key_binding_guard_v1[\s\S]*?CREATE TRIGGER agent_mission_events_00_fingerprint_key_binding_guard_v1 BEFORE INSERT/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /GRANT EXECUTE ON FUNCTION %s TO %I[\s\S]*?REVOKE EXECUTE ON FUNCTION %s FROM %I/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /aclexplode\([\s\S]*?guard_agent_mission_fingerprint_key_binding_present_v1\(\)[\s\S]*?privilege\.grantee <> function\.proowner/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /writer_guard\.proacl[\s\S]*?privilege\.grantee <> authority\.oid/u,
  );
  assert.match(fingerprintReadinessAuthorityProvision, /SET row_security = on/u);
  assert.match(fingerprintReadinessAuthorityProvision, /SET search_path = pg_catalog/u);
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /REVOKE CREATE ON SCHEMA public FROM bob_agent_mission_fingerprint_readiness/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /policy\.polroles = ARRAY\[authority\.oid\]::OID\[\][\s\S]*?pg_get_expr\(policy\.polqual/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /agent_mission_fingerprint_key_floor_direct_select[\s\S]*?policy\.polroles = ARRAY\[[\s\S]*?relation\.relowner[\s\S]*?polwithcheck IS NULL[\s\S]*?agent_mission_fingerprint_key_floor_direct_insert[\s\S]*?policy\.polqual IS NULL[\s\S]*?agent_mission_fingerprint_key_floor_direct_update[\s\S]*?policy\.polwithcheck/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /agent_mission_fingerprint_key_binding_direct_select[\s\S]*?relation\.relowner[\s\S]*?polwithcheck IS NULL[\s\S]*?agent_mission_fingerprint_key_binding_direct_insert[\s\S]*?policy\.polqual IS NULL/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /agent_mission_events_owner_select[\s\S]*?pg_get_expr\(policy\.polqual[\s\S]*?app\.current_company_id[\s\S]*?app\.current_user_id[\s\S]*?agent_mission_events_owner_insert[\s\S]*?pg_get_expr\(policy\.polwithcheck[\s\S]*?app\.current_agent_mission_id/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /pg_has_role\(app_role_oid, authority\.oid, 'MEMBER'\)[\s\S]*?pg_has_role\(app_role_oid, authority\.oid, 'SET'\)/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /ALTER FUNCTION public\.guard_agent_mission_fingerprint_key_binding_present_v1\(\)[\s\S]*?VOLATILE[\s\S]*?helper\.provolatile <> 'v'[\s\S]*?writer_guard\.provolatile <> 'v'[\s\S]*?AgentMission fingerprint readiness function authority drift/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /agent_mission_events_00_fingerprint_key_binding_guard_v1[\s\S]*?trigger\.tgtype = 7[\s\S]*?trigger\.tgfoid = writer_guard\.oid/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /SET LOCAL ROLE %I; CREATE INDEX IF NOT EXISTS agent_mission_events_fingerprint_key_version_idx ON public\.agent_mission_events \("fingerprintKeyVersion"\); RESET ROLE;[\s\S]*?agent_mission_events_fingerprint_key_version_idx[\s\S]*?index\.indisvalid[\s\S]*?index\.indnkeyatts = 1[\s\S]*?index\.indkey\[0\] = attribute\.attnum/u,
  );
  assert.match(
    fingerprintReadinessAuthorityProvision,
    /attribute\.attname = 'writerEnabled'[\s\S]*?attribute\.atttypid = 'pg_catalog\.bool'[\s\S]*?attribute\.attnotnull[\s\S]*?pg_get_expr\([\s\S]*?= 'true'/u,
  );
  assert.match(
    releaseCertificate,
    /guard_agent_mission_fingerprint_key_binding_present_v1\(\)[\s\S]*?function\.provolatile = 'v'[\s\S]*?AGENT_MISSION_FINGERPRINT_WRITER_GUARD_HARDENING_DRIFT/u,
  );
  assert.match(
    rls,
    /SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; SET LOCAL ROLE %I;[\s\S]*?current_setting\('bob\.release\.rls_owner_role'\)[\s\S]*?guard_agent_mission_fingerprint_key_binding_present_v1\(\)[\s\S]*?agent_mission_fingerprint_key_readiness\(integer\[\]\)/u,
  );
  assert.match(
    rls,
    /SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; SET LOCAL ROLE %I;[\s\S]*?current_setting\('bob\.release\.rls_owner_role'\)[\s\S]*?exposed_role\.rolname IN \('anon', 'authenticated', 'service_role'\)/u,
  );
  assert.doesNotMatch(
    rls,
    /^REVOKE ALL ON FUNCTION (?:guard_agent_mission_fingerprint_key_binding_present_v1\(\)|agent_mission_fingerprint_key_readiness\(INTEGER\[\]\)) FROM PUBLIC;$/mu,
  );
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
    /agentMissionBootstrapAcknowledgedAt[\s\S]*?bootstrap receipt constraint definition drift/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /guard_realtime_agent_mission_bootstrap_receipt_v1\(\)[\s\S]*?receipt_insert_trigger\.tgtype <> 7[\s\S]*?receipt_update_trigger\.tgtype <> 19[\s\S]*?expected_trigger_attributes IS DISTINCT FROM actual_trigger_attributes/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /md5\(receipt_guard\.prosrc\)[\s\S]*?receipt_guard\.oid[\s\S]*?<> 2[\s\S]*?bootstrap receipt trigger inventory drift/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /has_function_privilege\(current_user, capability_guard\.oid, 'EXECUTE'\)/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /has_function_privilege\([\s\S]*?current_user,[\s\S]*?receipt_guard\.oid,[\s\S]*?'EXECUTE'/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /function\.oid IN \([\s\S]*?capability_guard\.oid,[\s\S]*?receipt_guard\.oid,[\s\S]*?cancellation_guard\.oid,[\s\S]*?cancellation_schedule_sync\.oid[\s\S]*?trigger function exact ACL drift/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /lease_relation\.relacl[\s\S]*?privilege\.grantee <> runtime_role\.oid[\s\S]*?realtime lease exact relation ACL drift/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /retention_reaper_role\.oid[\s\S]*?attribute\.attname NOT IN \('companyId', 'sessionId'\)[\s\S]*?realtime lease exact column ACL drift/u,
  );
  assert.match(
    runtimeGrants,
    /guard_realtime_agent_mission_capability_immutable_v1[\s\S]*?guard_realtime_agent_mission_bootstrap_receipt_v1[\s\S]*?\) <> 14[\s\S]*?REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I/u,
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
    /server_version_num'\)::INTEGER >= 170000[\s\S]*?has_table_privilege\([\s\S]*?cancellation_relation\.oid,[\s\S]*?'MAINTAIN'[\s\S]*?Realtime cancellation fence runtime MAINTAIN ACL drift/u,
    'Le contrôle MAINTAIN doit rester actif sur PostgreSQL 17 sans casser les releases PostgreSQL 16/Supabase.',
  );
  assert.equal(
    realtimeReleaseCertificate.match(/'MAINTAIN'/gu)?.length,
    1,
    'Tout appel MAINTAIN supplémentaire pourrait contourner la garde de version PostgreSQL.',
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
  assert.match(localCertificate, /manage-agent-mission-fingerprint-key-versions\.mjs" stage/u);
  assert.match(
    localCertificate,
    /GRANT UPDATE \("minimumWriterVersion"\)[\s\S]*?GRANT INSERT \("keyFingerprint"\)[\s\S]*?agent-mission-fingerprint-readiness-authority-provision\.sql/u,
  );
  assert.match(
    localCertificate,
    /AGENT_MISSION_FINGERPRINT_BINDING_UPDATE_ACCEPTED[\s\S]*?AGENT_MISSION_FINGERPRINT_FLOOR_ROLLBACK_ACCEPTED[\s\S]*?AGENT_MISSION_FINGERPRINT_WRITER_OUTSIDE_FLOOR_ACCEPTED/u,
  );
  assert.match(
    localCertificate,
    /GRANT bob_schema_owner TO bob_app WITH INHERIT FALSE, SET TRUE;[\s\S]*?agent-missions-release-cert\.sql[\s\S]*?REVOKE bob_schema_owner FROM bob_app;/u,
  );
  assert.match(
    localCertificate,
    /CREATE ROLE bob_agent_mission_cert_rogue[\s\S]*?GRANT bob_agent_mission_cert_rogue TO bob_app WITH INHERIT FALSE, SET TRUE[\s\S]*?GRANT bob_agent_mission_cert_rogue TO authenticated WITH INHERIT FALSE, SET TRUE/u,
  );
  assert.match(
    localCertificate,
    /bob_agent_mission_writer_guard_rogue[\s\S]*?GRANT EXECUTE[\s\S]*?guard_agent_mission_fingerprint_key_binding_present_v1[\s\S]*?writer_guard_rogue_execute/u,
  );
  assert.match(
    localCertificate,
    /snapshot-freshness[\s\S]*?wait_for_agent_mission_manager_exclusive_lock[\s\S]*?release_agent_mission_writer_barrier snapshot-freshness[\s\S]*?stage-v2[\s\S]*?release_agent_mission_writer_barrier stage-v2[\s\S]*?retire-v2[\s\S]*?release_agent_mission_writer_barrier retire-v2/u,
  );
  assert.match(
    localCertificate,
    /agent_mission_cert_binding_insert_tripwire_v1[\s\S]*?retained-key-unbound[\s\S]*?unbound_guard_binding_count[\s\S]*?"keyVersion"[\s\S]*?3dabdc61748c357c67c0c81f568f6e2fa942decaf2b15c6009ab93140d3887c4/u,
  );
  assert.match(
    localCertificate,
    /release_agent_mission_writer_barrier snapshot-freshness[\s\S]*?retained-key-unbound[\s\S]*?AGENT_MISSION_CONCURRENT_STAGE_BOUND_V3_RETROACTIVELY[\s\S]*?a0cfd501bcbf5ece1d0ec6cc0402fa11d37e34a25ccccaafbdb5183ca41c0f3f/u,
  );
  const managerFunction = fingerprintManager.indexOf(
    'export async function manageAgentMissionFingerprintKeyVersions',
  );
  const managerExclusiveLock = fingerprintManager.indexOf('pg_advisory_xact_lock', managerFunction);
  const retainedPreflight = fingerprintManager.indexOf(
    'await assertNoRetainedUnboundFingerprintVersionsUnderAuthority',
    managerExclusiveLock,
  );
  const firstBindingInsert = fingerprintManager.indexOf(
    'INSERT INTO public.agent_mission_fingerprint_key_bindings',
    retainedPreflight,
  );
  assert.ok(
    managerFunction >= 0 &&
      managerExclusiveLock > managerFunction &&
      retainedPreflight > managerExclusiveLock &&
      firstBindingInsert > retainedPreflight,
    'Le manager doit refuser tout event retenu sans binding sous verrou avant son premier INSERT.',
  );
  const prismaGenerate = localCertificate.indexOf('pnpm --filter @bob/api generate');
  const firstFingerprintManager = localCertificate.indexOf(
    'node "$ROOT_DIR/apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs" stage',
  );
  assert.ok(
    prismaGenerate >= 0 && firstFingerprintManager > prismaGenerate,
    'Le client Prisma doit être généré avant le premier manager fingerprint sur checkout propre.',
  );
  const workspaceDependencyBuild = localCertificate.indexOf(
    'pnpm --filter "@bob/api^..." run build',
  );
  const postgresVitest = localCertificate.indexOf('pnpm --filter @bob/api exec vitest run');
  assert.ok(
    workspaceDependencyBuild >= 0 && postgresVitest > workspaceDependencyBuild,
    'Toutes les dépendances workspace de l’API doivent être construites avant Vitest.',
  );
  assert.match(
    localCertificate,
    /CONCURRENCY_MANAGER_LOG[\s\S]*?cat "\$CONCURRENCY_MANAGER_LOG" >&2[\s\S]*?fingerprint manager ended before waiting/u,
  );
  assert.match(
    localCertificate,
    /certify_agent_mission_fingerprint_floor 2 2 false[\s\S]*?realtime-capacity-release\.sh" configure[\s\S]*?certify_agent_mission_fingerprint_floor 2 2 true[\s\S]*?certify_agent_mission_fingerprint_floor 2 2 false/u,
  );
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
    assert.match(runbook, /workflow GitHub \*\*Railway API\*\*/u);
    assert.match(runbook, /BOB_RELEASE_SHA/u);
    assert.match(runbook, /BOB_RELEASE_RUN_ID/u);
    assert.match(runbook, /BOB_RELEASE_RUN_ATTEMPT/u);
    assert.match(runbook, /BOB_RELEASE_EXPECTED_ENV/u);
    assert.match(runbook, /activate-release-protocols-v2\.sh/u);
    assert.doesNotMatch(runbook, /_ACTIVATION_RELEASE_SHA="\$RELEASE_SHA"/u);
  }
  for (const requiredContext of [
    'BOB_RELEASE_SHA=',
    'BOB_RELEASE_RUN_ID=',
    'BOB_RELEASE_RUN_ATTEMPT=',
  ]) {
    assert.equal(
      (infrastructure.match(new RegExp(requiredContext, 'gu')) ?? []).length,
      2,
      `${requiredContext} doit être fourni aux phases manuelles predeploy et postdeploy.`,
    );
  }
});

test('la CI sépare la preuve AgentMission PostgreSQL 17 du owner-split Supabase-like 16', () => {
  const agentMissionJobStart = ci.indexOf('  agent-missions-postgres-certification:\n');
  const agentMissionJobEnd = ci.indexOf('  rls-certification:\n', agentMissionJobStart);
  const rlsJobStart = agentMissionJobEnd;
  const rlsJobEnd = ci.indexOf('  realtime-global-capacity-certification:\n', rlsJobStart);
  assert.ok(agentMissionJobStart >= 0 && agentMissionJobEnd > agentMissionJobStart);
  assert.ok(rlsJobStart >= 0 && rlsJobEnd > rlsJobStart);
  const agentMissionJob = ci.slice(agentMissionJobStart, agentMissionJobEnd);
  const rlsJob = ci.slice(rlsJobStart, rlsJobEnd);

  assert.match(agentMissionJob, /image: postgres:17/u);
  assert.match(agentMissionJob, /AGENT_MISSION_CERT_SUPER_URL:/u);
  assert.match(agentMissionJob, /AGENT_MISSION_CERT_DEPLOYER_BOOTSTRAP_URL:/u);
  assert.match(
    agentMissionJob,
    /RUN_AGENT_MISSION_M1B_MIGRATION_RECONCILIATION_CERT: 'true'[\s\S]*?agent-mission-m1b-staging-migration-reconcile\.postgres\.test\.mjs[\s\S]*?certify-agent-missions-local\.sh/u,
  );
  assert.match(agentMissionJob, /run: sh apps\/api\/scripts\/certify-agent-missions-local\.sh/u);
  assert.match(localCertificate, /CREATE ROLE bob_deployer[\s\S]*?NOSUPERUSER/u);
  assert.match(localCertificate, /SET createrole_self_grant = 'set'/u);
  assert.match(rlsJob, /image: postgres:16/u);
  assert.match(rlsJob, /Certify the full RLS replay after an exact schema-owner split/u);
  assert.match(rlsJob, /sh apps\/api\/scripts\/certify-rls-owner-split\.sh/u);
  const capacityTeardown = rlsJob.indexOf(
    '- name: Close shared Bob Live capacity after PostgreSQL certificates',
  );
  const destructiveOwnerSplit = rlsJob.indexOf(
    '- name: Certify the full RLS replay after an exact schema-owner split',
  );
  assert.ok(
    capacityTeardown >= 0 && destructiveOwnerSplit > capacityTeardown,
    'Le owner-split retire les droits du déployeur et doit rester après tous les certificats SQL.',
  );
  assert.ok(
    rlsJob.trimEnd().endsWith('run: sh apps/api/scripts/certify-rls-owner-split.sh'),
    'Le owner-split destructif doit rester le dernier step du job PostgreSQL partagé.',
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /assert-database-pair\.mjs --ephemeral-supabase-ci owner-split[\s\S]*?unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGOPTIONS[\s\S]*?assert-database-pair\.mjs/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /inet_server_addr\(\)[\s\S]*?inet_client_addr\(\)[\s\S]*?owner_split_network_mode = 'loopback'[\s\S]*?owner_split_network_mode = 'github-actions-service'[\s\S]*?current_database\(\) <> 'bob_ephemeral_ci'[\s\S]*?NOT deployer\.rolcreaterole/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /COALESCE\(pg_catalog\.bool_or\(membership\.set_option\), FALSE\)[\s\S]*?COALESCE\(pg_catalog\.bool_or\(membership\.admin_option\), FALSE\)[\s\S]*?COALESCE\(pg_catalog\.bool_or\(membership\.inherit_option\), FALSE\)/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /membership\.roleid = owner_oid[\s\S]*?membership\.member = deployer_oid[\s\S]*?NOT has_set_membership[\s\S]*?NOT has_admin_membership[\s\S]*?has_inherit_membership/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /owner_role\.rolcanlogin[\s\S]*?owner_role\.rolsuper[\s\S]*?owner_role\.rolcreatedb[\s\S]*?owner_role\.rolcreaterole[\s\S]*?owner_role\.rolinherit[\s\S]*?owner_role\.rolreplication[\s\S]*?NOT owner_role\.rolbypassrls/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /pg_has_role\(deployer_oid, owner_oid, 'USAGE'\)[\s\S]*?RLS_OWNER_SPLIT_CERT_EFFECTIVE_INHERITANCE_DRIFT/u,
  );
  assert.doesNotMatch(
    rlsOwnerSplitCertificate,
    /membership\.(?:admin_option|set_option)\s*\)?\s+AND\s+\(?\s*membership\.(?:admin_option|set_option)/u,
    'Les grants ADMIN implicite et SET peuvent avoir des grantors distincts sur PostgreSQL 16+.',
  );
  assert.deepEqual(
    rlsOwnerSplitCertificate.match(/^(?:GRANT|REVOKE)[^\n]+;$/gmu),
    [
      'GRANT CREATE ON SCHEMA public TO bob_rls_schema_owner_cert;',
      'REVOKE CREATE ON SCHEMA public FROM bob_rls_schema_owner_cert;',
      'GRANT USAGE ON SCHEMA public TO bob_rls_schema_owner_cert;',
    ],
    'Le certificat ne doit contenir aucun GRANT/REVOKE d’adhésion explicite.',
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /GRANT CREATE ON SCHEMA public TO bob_rls_schema_owner_cert;[\s\S]*?ALTER TABLE %s OWNER TO bob_rls_schema_owner_cert[\s\S]*?ALTER %s %I\.%I\(%s\) OWNER TO bob_rls_schema_owner_cert[\s\S]*?\\i apps\/api\/prisma\/rls\.sql[\s\S]*?RESET ROLE;[\s\S]*?REVOKE CREATE ON SCHEMA public FROM bob_rls_schema_owner_cert;[\s\S]*?GRANT USAGE ON SCHEMA public TO bob_rls_schema_owner_cert;/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /has_schema_privilege\([\s\S]*?'bob_rls_schema_owner_cert'[\s\S]*?'public'[\s\S]*?'CREATE'[\s\S]*?OR NOT pg_catalog\.has_schema_privilege\([\s\S]*?'USAGE'[\s\S]*?RLS_OWNER_SPLIT_CERT_SCHEMA_ACL_DRIFT/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /protected_owner <> current_user::pg_catalog\.regrole[\s\S]*?RLS_OWNER_SPLIT_CERT_INITIAL_OWNER_IS_NOT_DEPLOYER/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /relation\.relowner <> owner_oid[\s\S]*?app_is_active_cabinet_member\(text\)[\s\S]*?app_has_cabinet_role\(text,public\."CabinetRole"\[\]\)[\s\S]*?function\.proowner = owner_oid[\s\S]*?function\.prosecdef[\s\S]*?helper_count <> 2[\s\S]*?RLS_OWNER_SPLIT_CERT_CABINET_HELPER_OWNER_DRIFT/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /node apps\/api\/scripts\/assert-database-pair\.mjs --ephemeral-supabase-ci owner-split[\s\S]*?node apps\/api\/scripts\/assert-database-pair\.mjs[\s\S]*?psql "\$DATABASE_URL"[\s\S]*?RLS_OWNER_SPLIT_CERT_RUNTIME_ROLE_IS_PRIVILEGED[\s\S]*?INSERT INTO public\.cabinets[\s\S]*?INSERT INTO public\.cabinet_members[\s\S]*?app_is_active_cabinet_member[\s\S]*?app_has_cabinet_role[\s\S]*?ROLLBACK;/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /psql "\$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1[\s\S]*?owner_split_network_mode="\$owner_split_network_mode" <<'SQL'[\s\S]*?\\i apps\/api\/prisma\/rls\.sql[\s\S]*?RLS_OWNER_SPLIT_CERT_SCHEMA_ACL_DRIFT[\s\S]*?^SQL$/mu,
  );
  assert.match(
    rls,
    /cardinality\(owner_oids\) <> 1[\s\S]*?pg_has_role\([\s\S]*?session_user[\s\S]*?'SET'[\s\S]*?bob\.release\.rls_owner_role[\s\S]*?SET LOCAL ROLE %I/u,
  );
  assert.doesNotMatch(
    rls,
    /RESET ROLE/u,
    'Le replay doit revenir au schema owner exact après chaque owner de fonction.',
  );

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
    '20260727140000_agent_mission_realtime_lease_expand',
  );
  const capabilityIntermediateWriter = localCertificate.indexOf(
    'AGENT_MISSION_WRITER_N1_EXPAND_NULL_SHAPE_DRIFT',
    capabilityExpand,
  );
  const capabilityValidate = localCertificate.indexOf(
    '20260727150000_agent_mission_realtime_lease_validate',
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
    '20260727160000_realtime_admission_cancellation_fence_expand',
    capabilityFinalWriter,
  );
  const cancellationIntermediateWriter = localCertificate.indexOf(
    'REALTIME_CANCELLATION_WRITER_N1_ACCEPTED_AFTER_EXPAND',
    cancellationExpand,
  );
  const cancellationValidate = localCertificate.indexOf(
    '20260727170000_realtime_admission_cancellation_fence_validate',
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
  const eventNamespaceExpand = localCertificate.indexOf(
    '20260727180000_agent_mission_event_command_namespace_expand',
    cancellationFinalWriter,
  );
  const eventNamespaceExpandN1 = localCertificate.indexOf(
    'writer-n1-event-expand',
    eventNamespaceExpand,
  );
  const eventNamespaceValidate = localCertificate.indexOf(
    '20260727190000_agent_mission_event_command_namespace_validate',
    eventNamespaceExpandN1,
  );
  const eventNamespaceValidateN1 = localCertificate.indexOf(
    'writer-n1-event-validate',
    eventNamespaceValidate,
  );
  const eventNamespaceCutover = localCertificate.indexOf(
    '20260727200000_agent_mission_event_command_namespace_cutover',
    eventNamespaceValidateN1,
  );
  const eventNamespaceCutoverN1 = localCertificate.indexOf(
    'writer-n1-event-cutover',
    eventNamespaceCutover,
  );
  const eventNamespaceCutoverN = localCertificate.indexOf(
    'writer-n-event-cutover',
    eventNamespaceCutoverN1,
  );
  const fingerprintKeyReadiness = localCertificate.indexOf(
    '20260727210000_agent_mission_fingerprint_key_readiness',
    eventNamespaceCutoverN,
  );
  const fingerprintKeyReadinessN1 = localCertificate.indexOf(
    'writer-n1-fingerprint-readiness',
    fingerprintKeyReadiness,
  );
  const bootstrapReceiptExpand = localCertificate.indexOf(
    '20260727220000_agent_mission_bootstrap_receipt_expand',
    fingerprintKeyReadinessN1,
  );
  const bootstrapReceiptExpandN1 = localCertificate.indexOf(
    'AGENT_MISSION_BOOTSTRAP_WRITER_N1_EXPAND_RECEIPT_DRIFT',
    bootstrapReceiptExpand,
  );
  const bootstrapReceiptValidate = localCertificate.indexOf(
    '20260727230000_agent_mission_bootstrap_receipt_validate',
    bootstrapReceiptExpandN1,
  );
  const bootstrapReceiptValidateN1 = localCertificate.indexOf(
    'AGENT_MISSION_BOOTSTRAP_WRITER_N1_VALIDATE_RECEIPT_DRIFT',
    bootstrapReceiptValidate,
  );
  assert.ok(
    eventNamespaceExpand > cancellationFinalWriter &&
      eventNamespaceExpandN1 > eventNamespaceExpand &&
      eventNamespaceValidate > eventNamespaceExpandN1 &&
      eventNamespaceValidateN1 > eventNamespaceValidate &&
      eventNamespaceCutover > eventNamespaceValidateN1 &&
      eventNamespaceCutoverN1 > eventNamespaceCutover &&
      eventNamespaceCutoverN > eventNamespaceCutoverN1 &&
      fingerprintKeyReadiness > eventNamespaceCutoverN &&
      fingerprintKeyReadinessN1 > fingerprintKeyReadiness &&
      bootstrapReceiptExpand > fingerprintKeyReadinessN1 &&
      bootstrapReceiptExpandN1 > bootstrapReceiptExpand &&
      bootstrapReceiptValidate > bootstrapReceiptExpandN1 &&
      bootstrapReceiptValidateN1 > bootstrapReceiptValidate,
    'Chaque état, readiness et migration receipt doivent éprouver le writer N-1 exact.',
  );
  assert.match(
    localCertificate,
    /writer-n1-event-expand[\s\S]*?20000000-0000-8000-8000-000000000005/u,
  );
  assert.match(
    localCertificate,
    /writer-n-event-cutover[\s\S]*?50000000-0000-4000-8000-000000000005/u,
  );
  assert.match(
    localCertificate,
    /writer-n1-fingerprint-readiness[\s\S]*?60000000-0000-8000-8000-000000000005/u,
  );
  assert.match(
    localCertificate,
    /AGENT_MISSION_BOOTSTRAP_RECEIPT_INSERT_ACCEPTED_AFTER_EXPAND[\s\S]*?AGENT_MISSION_BOOTSTRAP_RECEIPT_DB_CLOCK_NOT_PROVEN[\s\S]*?AGENT_MISSION_BOOTSTRAP_RECEIPT_ERASE_ACCEPTED_AFTER_EXPAND/u,
  );
  assert.match(localCertificate, /AGENT_MISSION_EVENT_WRITER_NOT_PROVEN/u);
  assert.match(
    localCertificate,
    /GRANT SELECT, INSERT, UPDATE ON TABLE public\.agent_missions TO bob_app/u,
  );
  assert.match(
    localCertificate,
    /GRANT SELECT, INSERT ON TABLE public\.agent_mission_events TO bob_app/u,
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
