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
  catalogueSearchTokenAuthorityRole,
  catalogueSearchTokenAuthorityProvision,
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
  readFile(path.join(apiDir, 'prisma/catalogue-search-token-authority-role.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/catalogue-search-token-authority-provision.sql'), 'utf8'),
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
  const targetGate = railway.indexOf('Gate process-local throttling to one Railway replica');
  const predecessor = railway.indexOf(
    'Certify predecessor B2C HTTP fence before archive expansion',
  );
  const predecessorCapability = railway.indexOf('realtimeAdmissionCancellationFence', predecessor);
  const expandSchema = railway.indexOf(
    'Expand schema, spool notification delivery, and certify RLS',
    predecessorCapability,
  );
  const predeployTargetProbe = railway.indexOf('timeout 20s railway status', expandSchema);
  const predeploy = railway.indexOf('env BOB_RELEASE_PHASE=predeploy', predeployTargetProbe);
  const deploy = railway.indexOf('railway up --project', predeploy);
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
    targetGate >= 0 &&
      predecessor > targetGate &&
      predecessorCapability > predecessor &&
      expandSchema > predecessorCapability &&
      predeployTargetProbe > expandSchema &&
      predeploy > predeployTargetProbe &&
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
    railway.slice(targetGate, predecessor),
    /railway status --project "\$RAILWAY_PROJECT_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID" --json[\s\S]*?identity_command=target-identity[\s\S]*?target-identity-recovery[\s\S]*?certify-railway-single-replica\.mjs[\s\S]*?"\$TARGET_ENVIRONMENT_NAME" "\$RAILWAY_API_SERVICE_ID"/u,
    'Projet, environnement, ID et nom du service doivent être rapprochés avant prédeploy.',
  );
  assert.match(
    railway.slice(expandSchema, deploy),
    /timeout 20s railway status --project "\$RAILWAY_PROJECT_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID" --json[\s\S]*?"\$identity_command"[\s\S]*?certify-railway-single-replica\.mjs[\s\S]*?railway run --project "\$RAILWAY_PROJECT_ID" --service "\$RAILWAY_API_SERVICE_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID" --no-local --[\s\S]*?check-release-env\.sh[\s\S]*?railway run --project "\$RAILWAY_PROJECT_ID" --service "\$RAILWAY_API_SERVICE_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID" --no-local --[\s\S]*?BOB_RELEASE_PHASE=predeploy/u,
    'La cible doit être re-prouvée par IDs immédiatement avant les migrations irréversibles.',
  );
  assert.match(railway, /- release-recovery/u);
  assert.match(railway, /release\|release-recovery/u);
  assert.match(railway, /EXPECTED_DIRECT_RECOVERY_REF:.*railway-api\.yml@refs\/heads\/main/u);
  assert.match(railway, /"\$GITHUB_EVENT_NAME" = workflow_dispatch/u);
  assert.match(railway, /"\$CONTROL_WORKFLOW_REF" = "\$EXPECTED_DIRECT_RECOVERY_REF"/u);
  assert.match(railway, /"\$CONTROL_REF" = refs\/heads\/main/u);
  assert.match(railway, /railway-release-deployment\.mjs validate-recovery-route/u);
  assert.match(
    railway,
    /release-recovery is staging-only until the production promotion gate is certified/u,
    'Le repli sur un latest terminal doit rester un chemin recovery explicitement sélectionné.',
  );
  assert.equal(
    (railway.match(/railway up/gu) ?? []).length,
    1,
    'La release ne doit créer qu’un seul déploiement Railway.',
  );
  assert.match(
    railway.slice(deploy, topology),
    /railway up --project "\$RAILWAY_PROJECT_ID" --service "\$RAILWAY_API_SERVICE_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID" --detach --json[\s\S]*?railway-release-deployment\.mjs deployment-id[\s\S]*?deployment_id=\$deployment_id[\s\S]*?railway-release-deployment\.mjs[\s\S]*?wait-deployment "\$deployment_id"/u,
    'Le transport doit être détaché puis attendu par son UUID autoritaire.',
  );
  assert.match(
    railway.slice(topology, readiness),
    /EXPECTED_DEPLOYMENT_ID: \$\{\{ steps\.deploy_api\.outputs\.deployment_id \}\}[\s\S]*?serving-deployment-id[\s\S]*?test "\$serving_deployment_id" = "\$EXPECTED_DEPLOYMENT_ID"/u,
    'La topologie doit rapprocher le déploiement servant de celui créé par la release.',
  );
  assert.match(
    railway.slice(activation, finalPostdeploy),
    /certify_exact_revision\(\)[\s\S]*?timeout 20s railway status[\s\S]*?payload\?\.release\?\.sha !== process\.env\.EXPECTED_RELEASE_SHA[\s\S]*?payload\?\.release\?\.environment !== process\.env\.EXPECTED_RELEASE_ENVIRONMENT[\s\S]*?certify_exact_revision before-activation[\s\S]*?activate-release-protocols-v2\.sh[\s\S]*?certify_exact_revision before-postdeploy/u,
  );
  assert.match(
    railway.slice(activation, finalPostdeploy),
    /EXPECTED_DEPLOYMENT_ID: \$\{\{ steps\.deploy_api\.outputs\.deployment_id \}\}[\s\S]*?certify_exact_revision\(\)[\s\S]*?target-identity[\s\S]*?serving-deployment-id[\s\S]*?test "\$serving_deployment_id" = "\$EXPECTED_DEPLOYMENT_ID"[\s\S]*?certify_exact_revision before-activation[\s\S]*?certify_exact_revision before-postdeploy/u,
    'Chaque re-probe irréversible doit rester lié au déploiement exact créé par la release.',
  );
  assert.equal(
    (
      railway
        .slice(activation, finalPostdeploy)
        .match(
          /railway run --project "\$RAILWAY_PROJECT_ID" --service "\$RAILWAY_API_SERVICE_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID" --no-local --/gu,
        ) ?? []
    ).length,
    2,
    'Activation et postdeploy doivent ignorer tout override local comme le prédeploy.',
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
    4,
    'Les quatre lectures de topologie Railway doivent avoir une deadline.',
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
  assert.equal(
    (
      release.match(
        /DOCUMENT_ARCHIVE_CERT_WORKER_COUNT=4 \\\n\s+RUN_POSTGRES_DOCUMENT_ARCHIVE_CERT=true/gu,
      ) ?? []
    ).length,
    2,
    'Les certificats archive predeploy et postdeploy doivent réserver la capacité du pool staging.',
  );
  assert.equal(
    (release.match(/DOCUMENT_ARCHIVE_CERT_WORKER_COUNT=/gu) ?? []).length,
    2,
    'Le budget archive staging doit rester explicite et sans troisième override ambigu.',
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
    /'agent_mission_quote_line_work'::TEXT,[\s\S]*?'SELECT, INSERT, UPDATE, DELETE'::TEXT,[\s\S]*?'TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(
    runtimeGrants,
    /'catalogue_prestations'::TEXT,[\s\S]*?'SELECT, INSERT, UPDATE, DELETE'::TEXT,[\s\S]*?'TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(
    runtimeGrants,
    /'catalogue_prestation_search_tokens'::TEXT,[\s\S]*?'SELECT'::TEXT,[\s\S]*?'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
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
    'guard_agent_mission_mutation_v2',
    'guard_quote_draft_agent_mission_v1',
    'guard_agent_mission_quote_line_work_v3',
    'reject_agent_mission_event_mutation_v1',
    'guard_agent_mission_event_append_v3',
    'require_agent_mission_event_v1',
    'guard_catalogue_prestation_revision_v1',
    'sync_catalogue_prestation_search_tokens_v1',
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

test('M2-A ferme exactement work items, capability, trigger et policies RLS', () => {
  const m2aReaderPreExpand = localCertificate.indexOf(
    'certify_m2a_quote_draft_reader_n1 pre-expand',
  );
  const m2aExpand = localCertificate.indexOf(
    '20260729150000_agent_mission_quote_line_work_expand',
    m2aReaderPreExpand,
  );
  const m2aWriterExpand = localCertificate.indexOf(
    'certify_m2a_catalogue_writer_n1 \\\n  expand',
    m2aExpand,
  );
  const m2aReaderExpand = localCertificate.indexOf(
    'certify_m2a_quote_draft_reader_n1 expand',
    m2aWriterExpand,
  );
  const m2aBlockedExpand = localCertificate.indexOf(
    'certify_m2a_catalogue_new_shape_blocked \\\n  expand',
    m2aReaderExpand,
  );
  const m2aValidate = localCertificate.indexOf(
    '20260729150100_agent_mission_quote_line_work_validate',
    m2aBlockedExpand,
  );
  const m2aWriterValidate = localCertificate.indexOf(
    'certify_m2a_catalogue_writer_n1 \\\n  validate',
    m2aValidate,
  );
  const m2aReaderValidate = localCertificate.indexOf(
    'certify_m2a_quote_draft_reader_n1 validate',
    m2aWriterValidate,
  );
  const m2aBlockedValidate = localCertificate.indexOf(
    'certify_m2a_catalogue_new_shape_blocked \\\n  validate',
    m2aReaderValidate,
  );
  const m2aCutover = localCertificate.indexOf(
    '20260729150200_agent_mission_quote_line_work_cutover',
    m2aBlockedValidate,
  );
  const m2aWriterCutover = localCertificate.indexOf(
    'certify_m2a_catalogue_writer_n1 \\\n  cutover',
    m2aCutover,
  );
  const m2aReaderCutover = localCertificate.indexOf(
    'certify_m2a_quote_draft_reader_n1 cutover',
    m2aWriterCutover,
  );
  const m2aNewCutover = localCertificate.indexOf("'catalogue-m2a-new-cutover'", m2aReaderCutover);
  const m2aWorkMission = localCertificate.indexOf('writer-m2a-work', m2aNewCutover);
  assert.ok(
    m2aReaderPreExpand >= 0 &&
      m2aExpand > m2aReaderPreExpand &&
      m2aWriterExpand > m2aExpand &&
      m2aReaderExpand > m2aWriterExpand &&
      m2aBlockedExpand > m2aWriterExpand &&
      m2aValidate > m2aBlockedExpand &&
      m2aWriterValidate > m2aValidate &&
      m2aReaderValidate > m2aWriterValidate &&
      m2aBlockedValidate > m2aWriterValidate &&
      m2aCutover > m2aBlockedValidate &&
      m2aWriterCutover > m2aCutover &&
      m2aReaderCutover > m2aWriterCutover &&
      m2aNewCutover > m2aWriterCutover &&
      m2aWorkMission > m2aNewCutover,
    'M2-A doit prouver writer+reader N-1 à chaque étape, bloquer N puis tester le work item.',
  );
  assert.match(
    localCertificate,
    /"\$DIRECT_URL" -X -v ON_ERROR_STOP=1 \\\n  -f "\$ROOT_DIR\/apps\/api\/prisma\/migrations\/20260729150000/u,
    'L’expand M2-A doit assumer lui-même son owner sous le déployeur non-superuser.',
  );
  assert.match(
    localCertificate,
    /AGENT_MISSION_M2A_READER_N1_DRIFT[\s\S]*?CATALOGUE_M2A_SEARCH_KEY_PARITY_DRIFT[\s\S]*?catalogue_prestations_company_search_prefix_idx[\s\S]*?AGENT_MISSION_M2A_MISSING_CAPABILITY_ACCEPTED[\s\S]*?AGENT_MISSION_M2A_ACTIVE_PARENT_FENCE_NOT_PROVEN[\s\S]*?AGENT_MISSION_M2A_PARTIAL_PROPOSAL_ACCEPTED[\s\S]*?AGENT_MISSION_M2A_STALE_CAS_ACCEPTED[\s\S]*?AGENT_MISSION_M2A_CROSS_OWNER_WRITE_ACCEPTED[\s\S]*?AGENT_MISSION_M2A_CROSS_TENANT_WRITE_ACCEPTED[\s\S]*?AGENT_MISSION_M2A_TERMINAL_PARENT_ACCEPTED[\s\S]*?AGENT_MISSION_M2A_CROSS_KIND_PARENT_ACCEPTED[\s\S]*?AGENT_MISSION_M2A_CASCADE_DELETE_FAILED/u,
  );
  assert.match(
    localCertificate,
    /set_config\('app\.current_agent_mission_id', '', true\);[\s\S]*?DELETE FROM public\.agent_missions[\s\S]*?AGENT_MISSION_M2A_CASCADE_DELETE_FAILED/u,
    'La cascade de rétention doit être prouvée sans capability mission résiduelle.',
  );
  assert.match(
    rls,
    /'agent_mission_quote_line_work'[\s\S]*?DROP POLICY IF EXISTS agent_mission_quote_line_work_owner_select[\s\S]*?CREATE POLICY agent_mission_quote_line_work_owner_select[\s\S]*?CREATE POLICY agent_mission_quote_line_work_owner_insert[\s\S]*?CREATE POLICY agent_mission_quote_line_work_owner_update[\s\S]*?CREATE POLICY agent_mission_quote_line_work_owner_delete/u,
  );
  assert.match(
    rls,
    /REVOKE ALL ON TABLE agent_mission_quote_line_work FROM PUBLIC;[\s\S]*?REVOKE ALL ON FUNCTION guard_agent_mission_quote_line_work_v3\(\) FROM PUBLIC;/u,
  );
  assert.match(
    rls,
    /REVOKE ALL PRIVILEGES ON TABLE agent_mission_quote_line_work FROM %I[\s\S]*?REVOKE ALL PRIVILEGES ON FUNCTION guard_agent_mission_quote_line_work_v3\(\) FROM %I/u,
  );
  assert.match(
    runtimeGrants,
    /'agent_mission_quote_line_work'[\s\S]*?'catalogue_prestation_search_tokens'[\s\S]*?\) <> 11 THEN[\s\S]*?AGENT_MISSION_RUNTIME_TABLE_INVENTORY_DRIFT/u,
  );
  assert.match(
    runtimeGrants,
    /'guard_agent_mission_quote_line_work_v3'[\s\S]*?'guard_catalogue_prestation_revision_v1'[\s\S]*?'sync_catalogue_prestation_search_tokens_v1'[\s\S]*?\) <> 17 THEN[\s\S]*?AGENT_MISSION_RUNTIME_FUNCTION_INVENTORY_DRIFT/u,
  );
  assert.match(
    runtimeGrants,
    /REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I[\s\S]*?'guard_agent_mission_quote_line_work_v3'/u,
  );
  const executeGrant = runtimeGrants.slice(
    runtimeGrants.indexOf('GRANT EXECUTE ON FUNCTION %s TO %I'),
  );
  assert.doesNotMatch(
    executeGrant,
    /guard_agent_mission_quote_line_work_v3/u,
    'La fonction de trigger M2-A ne doit jamais devenir une API exécutable.',
  );
  assert.match(
    releaseCertificate,
    /quote_line_work_trigger_count <> 1[\s\S]*?agent_mission_quote_line_work_guard_v3[\s\S]*?trigger\.tgenabled = 'O'[\s\S]*?trigger\.tgtype = 31[\s\S]*?trigger\.tgqual IS NULL[\s\S]*?trigger\.tgnargs = 0[\s\S]*?trigger\.tgattr = ''::pg_catalog\.int2vector[\s\S]*?guard_agent_mission_quote_line_work_v3/u,
  );
  assert.match(
    releaseCertificate,
    /procedure\.oid = quote_line_work_guard_oid[\s\S]*?NOT procedure\.prosecdef[\s\S]*?NOT procedure\.proleakproof[\s\S]*?procedure\.provolatile = 'v'[\s\S]*?procedure\.proparallel = 'u'[\s\S]*?procedure\.pronargs = 0[\s\S]*?procedure\.prorettype = 'pg_catalog\.trigger'::pg_catalog\.regtype[\s\S]*?search_path=pg_catalog, public[\s\S]*?AGENT_MISSION_QUOTE_LINE_WORK_GUARD_FUNCTION_DRIFT/u,
  );
  assert.match(
    releaseCertificate,
    /quote_line_work_policy_count <> 4[\s\S]*?owner_select[\s\S]*?'r'::"char"[\s\S]*?owner_insert[\s\S]*?'a'::"char"[\s\S]*?owner_update[\s\S]*?'w'::"char"[\s\S]*?owner_delete[\s\S]*?'d'::"char"/u,
  );
  assert.match(
    releaseCertificate,
    /policy\.polroles IS DISTINCT FROM ARRAY\[0::OID\][\s\S]*?POLICY_DEFINITION_DRIFT/u,
  );
  assert.match(
    releaseCertificate,
    /catalogue_search_token_sync_oid[\s\S]*?trigger\.tgtype = 21[\s\S]*?procedure\.prosecdef[\s\S]*?row_security=on[\s\S]*?CATALOGUE_SEARCH_TOKEN_FUNCTION_DRIFT/u,
  );
  assert.match(
    releaseCertificate,
    /catalogue_search_tokens_item_company_fkey[\s\S]*?constraint\.conkey[\s\S]*?constraint\.confkey[\s\S]*?catalogue_search_tokens_pkey[\s\S]*?catalogue_search_tokens_token_check[\s\S]*?catalogue_search_tokens_company_item_idx/u,
  );
  assert.match(
    releaseCertificate,
    /catalogue_search_token_policy_count <> 1[\s\S]*?tenant_isolation[\s\S]*?CATALOGUE_SEARCH_TOKEN_POLICY_DRIFT/u,
  );
  assert.match(
    releaseCertificate,
    /app\.current_company_id[\s\S]*?app\.current_user_id[\s\S]*?app\.current_agent_mission_id/u,
  );
  assert.match(
    releaseCertificate,
    /'public\.agent_mission_quote_line_work'::pg_catalog\.regclass[\s\S]*?RUNTIME_OWNER_MEMBERSHIP_FORBIDDEN/u,
  );
  assert.match(
    releaseCertificate,
    /'public\.guard_agent_mission_quote_line_work_v3\(\)'::pg_catalog\.regprocedure[\s\S]*?DATA_API_OWNER_MEMBERSHIP_FORBIDDEN/u,
  );
  assert.match(
    releaseCertificate,
    /FOREACH table_name IN ARRAY ARRAY\[[\s\S]*?'agent_mission_quote_line_work'[\s\S]*?DATA_API_TABLE_PRIVILEGE_FORBIDDEN/u,
  );
  assert.match(
    releaseCertificate,
    /FOREACH function_name IN ARRAY ARRAY\[[\s\S]*?'guard_agent_mission_quote_line_work_v3\(\)'[\s\S]*?DATA_API_FUNCTION_EXECUTE_FORBIDDEN/u,
  );
});

test('M2-A-2 exécute le writer M2-A-1 et le reader N-1 après chaque migration', () => {
  const expand = localCertificate.indexOf('20260730110000_agent_mission_line_confirmation_expand');
  const writerAfterExpand = localCertificate.indexOf(
    'certify_m2a1_quote_line_writer_n1 \\\n  expand',
    expand,
  );
  const readerAfterExpand = localCertificate.indexOf(
    'certify_m2a_quote_draft_reader_n1 m2a2expand',
    writerAfterExpand,
  );
  const validate = localCertificate.indexOf(
    '20260730110100_agent_mission_line_confirmation_validate',
    readerAfterExpand,
  );
  const writerAfterValidate = localCertificate.indexOf(
    'certify_m2a1_quote_line_writer_n1 \\\n  validate',
    validate,
  );
  const readerAfterValidate = localCertificate.indexOf(
    'certify_m2a_quote_draft_reader_n1 m2a2validate',
    writerAfterValidate,
  );
  const cutover = localCertificate.indexOf(
    '20260730110200_agent_mission_line_confirmation_cutover',
    readerAfterValidate,
  );
  const writerAfterCutover = localCertificate.indexOf(
    'certify_m2a1_quote_line_writer_n1 \\\n  cutover',
    cutover,
  );
  const readerAfterCutover = localCertificate.indexOf(
    'certify_m2a_quote_draft_reader_n1 m2a2cutover',
    writerAfterCutover,
  );

  assert.ok(
    expand >= 0 &&
      writerAfterExpand > expand &&
      readerAfterExpand > writerAfterExpand &&
      validate > readerAfterExpand &&
      writerAfterValidate > validate &&
      readerAfterValidate > writerAfterValidate &&
      cutover > readerAfterValidate &&
      writerAfterCutover > cutover &&
      readerAfterCutover > writerAfterCutover,
    'Chaque étape M2-A-2 doit être immédiatement suivie des preuves writer et reader N-1.',
  );
  assert.match(
    localCertificate,
    /Forme M2-A-1 exacte[\s\S]*?AGENT_MISSION_M2A2_WRITER_N1_DEFAULT_DRIFT/u,
  );
  assert.match(
    localCertificate,
    /ALTER DEFAULT PRIVILEGES IN SCHEMA public[\s\S]*?GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role[\s\S]*?AGENT_MISSION_M2A2_DATA_API_FUNCTION_ACL_SURVIVED[\s\S]*?REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role/u,
    'L’expand doit retirer les ACL Data API même si les default privileges Supabase les accordent.',
  );
});

test('M2-A-3 rejoue les quatre formes line_cancelled sous writer N-1 à chaque étape', () => {
  const preFlag = localCertificate.indexOf('certify_m2a3_flag_off pre-expand');
  const preSealed = localCertificate.indexOf('pre-expand sealed accepted a300', preFlag);
  const preNull = localCertificate.indexOf('pre-expand null_pair rejected a301', preSealed);
  const preMixedId = localCertificate.indexOf('pre-expand mixed_id_null rejected a302', preNull);
  const preMixedHash = localCertificate.indexOf(
    'pre-expand mixed_null_hash rejected a303',
    preMixedId,
  );
  const expand = localCertificate.indexOf(
    '20260731120000_agent_mission_line_cancel_choice_expand',
    preMixedHash,
  );
  const expandFlag = localCertificate.indexOf('certify_m2a3_flag_off expand', expand);
  const expandProofsEnd = localCertificate.indexOf(
    'expand mixed_null_hash rejected a313',
    expandFlag,
  );
  const validate = localCertificate.indexOf(
    '20260731120100_agent_mission_line_cancel_choice_validate',
    expandProofsEnd,
  );
  const validateFlag = localCertificate.indexOf('certify_m2a3_flag_off validate', validate);
  const validateProofsEnd = localCertificate.indexOf(
    'validate mixed_null_hash rejected a323',
    validateFlag,
  );
  const cutover = localCertificate.indexOf(
    '20260731120200_agent_mission_line_cancel_choice_cutover',
    validateProofsEnd,
  );
  const cutoverFlag = localCertificate.indexOf('certify_m2a3_flag_off cutover', cutover);
  const cutoverSealed = localCertificate.indexOf('cutover sealed accepted a330', cutoverFlag);
  const cutoverNull = localCertificate.indexOf('cutover null_pair accepted a331', cutoverSealed);
  const cutoverMixedId = localCertificate.indexOf(
    'cutover mixed_id_null rejected a332',
    cutoverNull,
  );
  const cutoverMixedHash = localCertificate.indexOf(
    'cutover mixed_null_hash rejected a333',
    cutoverMixedId,
  );

  assert.ok(
    preFlag >= 0 &&
      preSealed > preFlag &&
      preNull > preSealed &&
      preMixedId > preNull &&
      preMixedHash > preMixedId &&
      expand > preMixedHash &&
      expandFlag > expand &&
      expandProofsEnd > expandFlag &&
      validate > expandProofsEnd &&
      validateFlag > validate &&
      validateProofsEnd > validateFlag &&
      cutover > validateProofsEnd &&
      cutoverFlag > cutover &&
      cutoverSealed > cutoverFlag &&
      cutoverNull > cutoverSealed &&
      cutoverMixedId > cutoverNull &&
      cutoverMixedHash > cutoverMixedId,
    'Le writer N-1 M2-A-3 doit tenter chaque paire avant et après chaque migration.',
  );

  const helperStart = localCertificate.indexOf('certify_m2a2_line_cancel_event_writer_n1()');
  const helperEnd = localCertificate.indexOf('\ncertify_m2a3_flag_off()', helperStart);
  const helper = localCertificate.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helper, /"\$PSQL_BIN" "\$DATABASE_URL"/u);
  assert.doesNotMatch(
    helper,
    /\bSET\s+(?:LOCAL\s+)?ROLE\b/u,
    'Le writer doit rester bob_app sous FORCE RLS.',
  );
  assert.match(
    helper,
    /app\.current_company_id[\s\S]*?app\.current_user_id[\s\S]*?app\.current_agent_mission_id/u,
  );
  assert.match(helper, /EXCEPTION WHEN check_violation/u);
  assert.match(helper, /GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME/u);
  assert.match(
    helper,
    /WHEN 'sealed'[\s\S]*?'choiceId'[\s\S]*?::UUID[\s\S]*?'choiceSetHash', repeat\('c', 64\)/u,
  );
  assert.match(
    helper,
    /WHEN 'null_pair'[\s\S]*?'choiceId', 'null'::JSONB[\s\S]*?'choiceSetHash', 'null'::JSONB/u,
  );
  assert.match(
    helper,
    /WHEN 'mixed_id_null'[\s\S]*?'choiceId'[\s\S]*?::UUID[\s\S]*?'choiceSetHash', 'null'::JSONB/u,
  );
  assert.match(
    helper,
    /WHEN 'mixed_null_hash'[\s\S]*?'choiceId', 'null'::JSONB[\s\S]*?'choiceSetHash', repeat\('c', 64\)/u,
  );
  assert.match(
    helper,
    /AGENT_MISSION_M2A3_CANCEL_EXPECTED_ACCEPTED[\s\S]*?AGENT_MISSION_M2A3_CANCEL_SHAPE_ACCEPTED[\s\S]*?AGENT_MISSION_M2A3_CANCEL_REJECTION_MUTATED/u,
  );

  for (const migration of [
    '20260731120000_agent_mission_line_cancel_choice_expand',
    '20260731120100_agent_mission_line_cancel_choice_validate',
    '20260731120200_agent_mission_line_cancel_choice_cutover',
  ]) {
    assert.match(
      localCertificate,
      new RegExp(`"\\$PSQL_BIN" "\\$DIRECT_URL"[\\s\\S]{0,180}${migration}`, 'u'),
    );
  }
  assert.equal(
    localCertificate.match(/certify_m2a3_flag_off (?:pre-expand|expand|validate|cutover)/gu)
      ?.length,
    4,
  );
  const flagHelper = localCertificate.slice(
    helperEnd,
    localCertificate.indexOf('\ncertify_m2a_quote_draft_reader_n1 pre-expand', helperEnd),
  );
  assert.match(
    flagHelper,
    /"updatedByUserId" = 'system:migration'[\s\S]*?release_flag_subjects[\s\S]*?subject\.enabled/u,
  );
  assert.match(
    flagHelper,
    /release_flags NO FORCE ROW LEVEL SECURITY[\s\S]*?ROLLBACK[\s\S]*?release_flags'::pg_catalog\.regclass[\s\S]*?agent_mission_events'::pg_catalog\.regclass[\s\S]*?relforcerowsecurity/u,
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
    /agentMissionProtocolVersion" = ANY \(ARRAY\[1, 2\]\)[\s\S]*?AgentMission realtime lease constraint definition drift/u,
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
    /guard_realtime_agent_mission_bootstrap_receipt_v2\(\)[\s\S]*?receipt_insert_trigger\.tgtype <> 7[\s\S]*?receipt_update_trigger\.tgtype <> 19[\s\S]*?expected_trigger_attributes IS DISTINCT FROM actual_trigger_attributes/u,
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
    /guard_realtime_agent_mission_capability_immutable_v1[\s\S]*?guard_realtime_agent_mission_bootstrap_receipt_v2[\s\S]*?guard_catalogue_prestation_revision_v1[\s\S]*?sync_catalogue_prestation_search_tokens_v1[\s\S]*?\) <> 17[\s\S]*?REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I/u,
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
    /BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED=true or false is required[\s\S]*?true\|false[\s\S]*?BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED=true is restricted to staging preview/u,
  );
  assert.match(
    release,
    /release_flag_snapshot="\$\([\s\S]*?bob\.agent_missions\.quote\.v1[\s\S]*?release_flag_enabled="\$\{2:-\}"[\s\S]*?release_flag_subject_count="\$\{4:-\}"[\s\S]*?legacy V1 must remain globally dormant with zero subjects[\s\S]*?-v release_env="\$CABINET_RELEASE_ENV"[\s\S]*?-v release_flag_version="\$release_flag_version"[\s\S]*?-v release_flag_kill_switch="\$release_flag_kill_switch"/u,
  );
  assert.match(
    release,
    /m2a_release_flag_snapshot="\$\([\s\S]*?pg_catalog\.count\(\*\)[\s\S]*?release_flag_subjects[\s\S]*?flag\."updatedByUserId"[\s\S]*?flag\.key = 'bob\.agent_missions\.quote\.m2a'[\s\S]*?m2a_release_flag_enabled[\s\S]*?m2a_subject_count[\s\S]*?m2a_release_flag_actor[\s\S]*?must match its runtime master, keep kill switch OFF and have zero subjects[\s\S]*?global ON must be owned by the staging preview workflow[\s\S]*?-v m2a_release_flag_version="\$m2a_release_flag_version"/u,
  );
  assert.match(
    release,
    /certify_m2a_preview_release_binding\(\)[\s\S]*?BOB_M2A3_STAGING_PREVIEW_OWNER[\s\S]*?BOB_M2A3_STAGING_PREVIEW_RELEASE_SHA[\s\S]*?BOB_M2A3_STAGING_PREVIEW_ACTIVATION_RUN[\s\S]*?BOB_RELEASE_SHA[\s\S]*?bob-m2a3-staging-preview-v1[\s\S]*?exact normally released SHA[\s\S]*?OFF M2-A runtime must not retain a staging preview owner block[\s\S]*?certify_m2a_preview_release_binding/u,
  );
  assert.match(
    realtimeReleaseCertificate,
    /expected_release_environment[\s\S]*?expected_release_flag_version[\s\S]*?expected_release_flag_kill_switch[\s\S]*?expected_m2a_release_flag_version[\s\S]*?wrong_lower_release_flag_version[\s\S]*?wrong_upper_release_flag_version/u,
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
    /bob\.agent_missions\.quote\.m2a[\s\S]*?expected_m2a_release_flag_version[\s\S]*?AgentMission M2-A flag exact version revalidation drift/u,
  );
  assert.equal(
    (ci.match(/BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED=false/gu) ?? []).length,
    (ci.match(/sh apps\/api\/scripts\/release\.sh/gu) ?? []).length,
    'chaque release PostgreSQL éphémère doit armer explicitement le master M2-A OFF',
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

test('le trigger de tokens catalogue garde une autorité NOBYPASSRLS exacte après provisioning', () => {
  const migrate = release.indexOf('prisma migrate deploy');
  const ensureBeforeMigrate = release.lastIndexOf(
    '\nensure_catalogue_search_token_authority_role\n',
    migrate,
  );
  const rlsReplay = release.indexOf('-f apps/api/prisma/rls.sql');
  const provision = release.indexOf('\nprovision_catalogue_search_token_authority\n', rlsReplay);
  const certificate = release.indexOf('certify_agent_mission_release_acl', provision);
  assert.ok(ensureBeforeMigrate >= 0 && ensureBeforeMigrate < migrate);
  assert.ok(rlsReplay > migrate && provision > rlsReplay && certificate > provision);

  assert.match(catalogueSearchTokenAuthorityRole, /SET createrole_self_grant = 'set'/u);
  assert.match(
    catalogueSearchTokenAuthorityRole,
    /CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS[\s\S]*?bob_catalogue_search_token_sync/u,
  );
  assert.doesNotMatch(
    catalogueSearchTokenAuthorityRole,
    /GRANT\s+bob_catalogue_search_token_sync\s+TO\s+(?:postgres|bob_app)/u,
  );
  assert.match(
    catalogueSearchTokenAuthorityProvision,
    /GRANT SELECT \("companyId", "catalogueItemId"\), INSERT \("companyId", "catalogueItemId", token\), DELETE[\s\S]*?ALTER FUNCTION %s OWNER TO bob_catalogue_search_token_sync/u,
  );
  assert.match(
    catalogueSearchTokenAuthorityProvision,
    /GRANT bob_catalogue_search_token_sync TO %I WITH INHERIT FALSE, SET TRUE[\s\S]*?ALTER FUNCTION %s OWNER TO bob_catalogue_search_token_sync[\s\S]*?REVOKE bob_catalogue_search_token_sync FROM %I/u,
  );
  assert.match(
    catalogueSearchTokenAuthorityProvision,
    /SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog[\s\S]*?SET row_security = on[\s\S]*?md5\(helper\.prosrc\)[\s\S]*?94327712057244bbe60cc428a22df471/u,
  );
  assert.match(
    catalogueSearchTokenAuthorityProvision,
    /REVOKE CREATE ON SCHEMA public FROM bob_catalogue_search_token_sync[\s\S]*?has_table_privilege\([\s\S]*?'DELETE'[\s\S]*?has_column_privilege\([\s\S]*?'token'[\s\S]*?'INSERT'/u,
  );
  assert.match(
    releaseCertificate,
    /bob_catalogue_search_token_sync[\s\S]*?procedure\.proowner = catalogue_search_token_authority_oid[\s\S]*?94327712057244bbe60cc428a22df471[\s\S]*?AGENT_MISSION_CATALOGUE_SEARCH_TOKEN_AUTHORITY_ACL_DRIFT/u,
  );
  assert.doesNotMatch(
    rls,
    /^REVOKE ALL ON FUNCTION sync_catalogue_prestation_search_tokens_v1\(\) FROM PUBLIC;$/mu,
  );
  assert.doesNotMatch(
    rls,
    /EXECUTE pg_catalog\.format\(\s*'REVOKE ALL PRIVILEGES ON FUNCTION sync_catalogue_prestation_search_tokens_v1\(\) FROM %I'/u,
  );
  assert.match(
    rls,
    /SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; SET LOCAL ROLE %I;[\s\S]*?'public\.sync_catalogue_prestation_search_tokens_v1\(\)'::pg_catalog\.regprocedure/u,
  );
  assert.match(
    rls,
    /SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; SET LOCAL ROLE %I;[\s\S]*?'public\.sync_catalogue_prestation_search_tokens_v1\(\)'::pg_catalog\.regprocedure/u,
  );
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
  for (const migration of [
    '20260730100000_agent_mission_catalogue_choice_expand',
    '20260730100100_agent_mission_catalogue_choice_validate',
    '20260730100200_agent_mission_catalogue_choice_cutover',
    '20260730110000_agent_mission_line_confirmation_expand',
    '20260730110100_agent_mission_line_confirmation_validate',
    '20260730110200_agent_mission_line_confirmation_cutover',
    '20260731120000_agent_mission_line_cancel_choice_expand',
    '20260731120100_agent_mission_line_cancel_choice_validate',
    '20260731120200_agent_mission_line_cancel_choice_cutover',
  ]) {
    assert.match(localCertificate, new RegExp(migration, 'u'));
  }
  assert.match(
    localCertificate,
    /AGENT_MISSION_M2A1_PREEXISTING_LINE_WORK_UNSUPPORTED[\s\S]*?AGENT_MISSION_M2A1_PREFLIGHT_ROLLBACK_DRIFT[\s\S]*?AGENT_MISSION_M2A1_PREFLIGHT_CLEANUP_FAILED/u,
  );
  assert.match(
    localCertificate,
    /PREPARE m2a1_catalogue_search[\s\S]*?plan_cache_mode = force_generic_plan[\s\S]*?catalogue_search_tokens_pkey[\s\S]*?m2a1_catalogue_result_count/u,
  );
  for (const catalogueCertificateMarker of [
    'AGENT_MISSION_M2A1_CATALOGUE_TOKEN_SYNC_DRIFT',
    'AGENT_MISSION_M2A1_CATALOGUE_BACKFILL_DRIFT',
    'AGENT_MISSION_M2A1_CATALOGUE_PLAN_CLEANUP_FAILED',
  ]) {
    assert.match(localCertificate, new RegExp(catalogueCertificateMarker, 'u'));
  }
  assert.match(localCertificate, /agent-missions-runtime-grants\.sql/u);
  assert.match(localCertificate, /agent-missions-release-cert\.sql/u);
  assert.match(localCertificate, /agent-mission-release-flag-authority-role\.sql/u);
  assert.match(localCertificate, /agent-mission-release-flag-authority-provision\.sql/u);
  assert.match(localCertificate, /catalogue-search-token-authority-role\.sql/u);
  assert.match(localCertificate, /catalogue-search-token-authority-provision\.sql/u);
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
    /bob_catalogue_search_token_sync[\s\S]*?catalogue_sync\.proowner <> catalogue_sync_owner_oid[\s\S]*?catalogue_sync_role\.rolbypassrls[\s\S]*?RLS_OWNER_SPLIT_CERT_CATALOGUE_TOKEN_AUTHORITY_DRIFT/u,
  );
  assert.match(
    rlsOwnerSplitCertificate,
    /rls-owner-split-token-company-a[\s\S]*?Inspection chaudière alpha[\s\S]*?rls-owner-split-token-company-b[\s\S]*?Entretien vitrine beta[\s\S]*?Maintenance chaudière alpha[\s\S]*?RLS_OWNER_SPLIT_CERT_CATALOGUE_TOKEN_TENANT_A_DRIFT[\s\S]*?RLS_OWNER_SPLIT_CERT_CATALOGUE_TOKEN_CROSS_TENANT_LEAK[\s\S]*?Nettoyage vitrine beta[\s\S]*?RLS_OWNER_SPLIT_CERT_CATALOGUE_TOKEN_TENANT_B_DRIFT/u,
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
