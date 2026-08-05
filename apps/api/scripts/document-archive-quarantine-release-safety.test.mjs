import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, '..');
const rootDir = path.resolve(apiDir, '../..');

const [
  workflow,
  migration,
  release,
  ci,
  bootstrap,
  packageJson,
  planRunner,
  oidc,
  runtime,
  quarantineDomain,
  applyRunner,
  finalizeRunner,
  postgresCert,
  operatorRunbook,
] = await Promise.all([
  readFile(path.join(rootDir, '.github/workflows/document-archive-quarantine-staging.yml'), 'utf8'),
  readFile(
    path.join(
      apiDir,
      'prisma/migrations/20260805010000_document_archive_quarantine_fence/migration.sql',
    ),
    'utf8',
  ),
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8'),
  readFile(path.join(scriptDir, 'bootstrap-supabase-ci-postgres.sh'), 'utf8'),
  readFile(path.join(apiDir, 'package.json'), 'utf8'),
  readFile(path.join(apiDir, 'src/document-archive-quarantine.main.ts'), 'utf8'),
  readFile(path.join(apiDir, 'src/document-archive-quarantine-oidc.ts'), 'utf8'),
  readFile(path.join(apiDir, 'src/document-archive-quarantine.runtime.ts'), 'utf8'),
  readFile(path.join(apiDir, 'src/documents/archive-quarantine.ts'), 'utf8'),
  readFile(path.join(apiDir, 'src/document-archive-quarantine-apply.main.ts'), 'utf8'),
  readFile(path.join(apiDir, 'src/document-archive-quarantine-finalize.main.ts'), 'utf8'),
  readFile(
    path.join(apiDir, 'src/persistence/prisma/document-archive-quarantine.postgres.test.ts'),
    'utf8',
  ),
  readFile(path.join(rootDir, 'docs/runbooks/fly-document-archive-quarantine-staging.md'), 'utf8'),
]);

test('l’opérateur staging reste manuel, mono-instance, OIDC et distant', () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment:\s*staging/u);
  assert.match(workflow, /group:\s*railway-api-staging/u);
  assert.match(workflow, /cancel-in-progress:\s*false/u);
  assert.match(workflow, /permissions:[\s\S]*id-token:\s*write/u);
  assert.equal(
    (workflow.match(/audience=bob-document-archive-quarantine-staging/gu) ?? []).length,
    4,
  );
  assert.match(workflow, /--deployment-instance\s+"\$DEPLOYMENT_INSTANCE_ID"/u);
  assert.match(workflow, /--identity-file\s+"\$SSH_IDENTITY"/u);
  assert.match(workflow, /DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY/u);
  assert.match(workflow, /ssh_key_fingerprint:/u);
  assert.doesNotMatch(workflow, /\$\{\{ runner\.temp \}\}/u);
  assert.match(
    workflow,
    /root="\$RUNNER_TEMP\/bob-document-archive-quarantine-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u,
  );
  assert.match(workflow, /echo "QUARANTINE_TEMP_ROOT=\$root" >> "\$GITHUB_ENV"/u);
  assert.match(workflow, /ssh_authorization_started_at_epoch:/u);
  assert.match(workflow, /ssh_authorization_expires_at_epoch:/u);
  assert.match(workflow, /actual_fingerprint.*EXPECTED_SSH_KEY_FINGERPRINT/u);
  assert.match(workflow, /now - SSH_AUTHORIZATION_STARTED_AT_EPOCH\)\)" -le 1800/u);
  assert.match(workflow, /SSH_AUTHORIZATION_EXPIRES_AT_EPOCH - now\)\)" -ge 9300/u);
  assert.match(
    workflow,
    /SSH_AUTHORIZATION_EXPIRES_AT_EPOCH - SSH_AUTHORIZATION_STARTED_AT_EPOCH\)\)" -le 14400/u,
  );
  assert.match(workflow, /Trust once and prove the Railway SSH relay on the exact instance/u);
  assert.match(workflow, /Host ssh\.railway\.com/u);
  assert.match(workflow, /BatchMode yes/u);
  assert.match(workflow, /IdentitiesOnly yes/u);
  assert.match(workflow, /StrictHostKeyChecking accept-new/u);
  assert.match(workflow, /ConnectTimeout 10/u);
  assert.match(workflow, /ConnectionAttempts 2/u);
  assert.match(workflow, /timeout 20s ssh/u);
  assert.match(workflow, /ssh -G -F "\$HOME\/\.ssh\/config"/u);
  assert.match(workflow, /"\$DEPLOYMENT_INSTANCE_ID@ssh\.railway\.com"/u);
  assert.doesNotMatch(workflow, /StrictHostKeyChecking(?:=|\s+)(?:no|off)/u);
  const sshConfigIndex = workflow.indexOf('Host ssh.railway.com');
  const firstRailwaySshIndex = workflow.indexOf('railway ssh \\');
  assert.ok(sshConfigIndex >= 0 && firstRailwaySshIndex > sshConfigIndex);
  assert.equal((workflow.match(/railway ssh \\/gu) ?? []).length, 4);
  assert.equal((workflow.match(/BOB_RELEASE_EXPECTED_ENV=staging/gu) ?? []).length, 4);
  assert.doesNotMatch(
    workflow,
    /env(?:\s+-u\s+[A-Z0-9_]+)*\s+DOCUMENT_ARCHIVE_QUARANTINE_MODE=(?:plan|apply|finalize)/u,
  );
  assert.match(workflow, /Resume a durable final audit before requesting a new one/u);
  assert.match(workflow, /env -u DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_DEPLOYMENT_ID/u);
  assert.match(workflow, /ARCHIVE_QUARANTINE_FINAL_AUDIT_NOT_RECORDED/u);
  assert.match(workflow, /steps\.resume\.outputs\.resumed != 'true'/u);
  assert.match(
    workflow,
    /Destroy runner-local SSH and OIDC material[\s\S]*if: \$\{\{ always\(\) \}\}/u,
  );
  assert.match(workflow, /rm -rf -- "\$QUARANTINE_TEMP_ROOT"/u);
  assert.match(workflow, /storageOrphans !== 5/u);
  assert.match(workflow, /storageOrphans !== 0/u);
  assert.match(workflow, /phase !== 'deleted_verified'/u);
  assert.match(workflow, /phase !== 'completed'/u);
  assert.match(workflow, /Upload bounded non-PII evidence[\s\S]*include-hidden-files:\s*true/u);
  assert.doesNotMatch(workflow, /railway run/u);
  assert.doesNotMatch(workflow, /oidcToken:\s*\$\{\{/u);
});

test('plan et apply partagent l’autorité OIDC fondateur exacte et reprennent leur journal', () => {
  assert.match(planRunner, /parseArchiveQuarantinePlanInput\(await readStdin\(\)\)/u);
  assert.match(planRunner, /verifyArchiveQuarantineOidc/u);
  assert.match(planRunner, /loadRecoverablePlan/u);
  for (const claim of [
    'repository_id',
    'repository_owner_id',
    'workflow_sha',
    'event_name',
    'actor_id',
  ])
    assert.match(oidc, new RegExp(`claims\\.${claim}`, 'u'));
  assert.match(oidc, /FOUNDER_ACTOR_ID = '84627817'/u);
  assert.match(oidc, /SUBJECT = 'repo:GLWebDevAgency\/bob-pro:environment:staging'/u);
  assert.match(runtime, /ARCHIVE_QUARANTINE_APPLY_OIDC_PROOF_REPLAYED/u);
  assert.match(runtime, /assertArchiveQuarantineCompletionBoundary/u);
  assert.match(runtime, /LOCK TABLE storage\.buckets IN SHARE ROW EXCLUSIVE MODE/u);
  assert.match(
    runtime,
    /LOCK TABLE public\.document_archive_job_artifacts IN SHARE ROW EXCLUSIVE MODE/u,
  );
  assert.match(runtime, /LOCK TABLE public\.document_archive_jobs IN SHARE ROW EXCLUSIVE MODE/u);
  assert.match(runtime, /ARCHIVE_QUARANTINE_COMPLETION_STATE_CHANGED/u);
  assert.match(migration, /tokenSha256' IS DISTINCT FROM/u);
  for (const entrypoint of [planRunner, applyRunner, finalizeRunner]) {
    assert.match(entrypoint, /assertArchiveQuarantineRuntimeScope/u);
    assert.match(entrypoint, /FLY_ARCHIVE_QUARANTINE_TARGET/u);
  }
  assert.match(quarantineDomain, /ARCHIVE_QUARANTINE_RUNTIME_SCOPE_DIVERGENT/u);
});

test('le runbook borne les deux fenêtres JIT et restaure la gouvernance staging', () => {
  assert.match(operatorRunbook, /set -euo pipefail/u);
  assert.match(operatorRunbook, /FOUNDER_ID=84627817/u);
  assert.match(operatorRunbook, /branch-policies-before\.json/u);
  assert.match(operatorRunbook, /reviewers: \[\{type: "User", id: \$founder\}\]/u);
  assert.match(operatorRunbook, /JIT_DIR="\$\(mktemp -d\)"/u);
  assert.match(operatorRunbook, /trap abort_with_jit_cleanup EXIT/u);
  assert.match(operatorRunbook, /github-secrets-before\.json/u);
  assert.match(
    operatorRunbook,
    /github-secrets-before-set\.json[\s\S]*DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY/u,
  );
  assert.match(operatorRunbook, /open_jit plan/u);
  assert.match(operatorRunbook, /open_jit apply/u);
  assert.match(operatorRunbook, /eval "\$\(ssh-agent -s\)"/u);
  assert.match(operatorRunbook, /ssh-add "\$KEY"/u);
  assert.match(operatorRunbook, /ssh keys add --key "\$SSH_FINGERPRINT"/u);
  assert.doesNotMatch(operatorRunbook, /ssh keys add --key "\$KEY\.pub"/u);
  assert.match(operatorRunbook, /extract_registered_railway_keys/u);
  assert.match(operatorRunbook, /railway-registered-after-add\.txt/u);
  assert.match(operatorRunbook, /Fingerprint: \$SSH_FINGERPRINT/u);
  const registrationProof = operatorRunbook.indexOf('add_output_sha256=');
  const registrationReceipt = operatorRunbook.indexOf('"registeredAt"');
  assert.ok(registrationProof >= 0 && registrationReceipt > registrationProof);
  assert.match(operatorRunbook, /"addOutputSha256":"%s"/u);
  assert.match(operatorRunbook, /"listOutputSha256":"%s"/u);
  const revoke = operatorRunbook.indexOf('ssh keys remove "$SSH_FINGERPRINT"');
  const stopIsolatedAgent = operatorRunbook.indexOf('ssh-agent -k', revoke);
  const proveRemoteAbsence = operatorRunbook.indexOf('ssh keys list', stopIsolatedAgent);
  const deleteSecret = operatorRunbook.indexOf(
    'secret delete DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY',
  );
  assert.ok(
    revoke >= 0 &&
      stopIsolatedAgent > revoke &&
      proveRemoteAbsence > stopIsolatedAgent &&
      deleteSecret > proveRemoteAbsence,
  );
  assert.match(operatorRunbook, /pending_deployments/u);
  assert.match(operatorRunbook, /length == 1 and \.\[0\]\.environment\.id == \$environment/u);
  assert.match(operatorRunbook, /workflow run document-archive-quarantine-staging\.yml -R/u);
  assert.match(operatorRunbook, /--input "\$EVIDENCE_DIR\/environment-restore-payload\.json"/u);
  assert.match(operatorRunbook, /counts\.storageOrphans == 5/u);
  assert.match(operatorRunbook, /counts\.missingStoredObjects == 0/u);
  assert.match(operatorRunbook, /counts\.p0Issues == 6/u);
  assert.match(operatorRunbook, /counts\.storageOrphans == 0/u);
  assert.match(operatorRunbook, /finalAuditDeploymentId == \$audit\[0\]\.deploymentId/u);
  assert.match(operatorRunbook, /PRIOR_FINAL_AUDIT:\?La reprise exige le final-audit\.json/u);
  assert.match(operatorRunbook, /prior-apply\/\.quarantine-evidence\/final-audit\.json/u);
  assert.match(operatorRunbook, /workflow run railway-api\.yml -R/u);
  assert.match(operatorRunbook, /document-archive-staging-\$RELEASE_SHA/u);
  assert.match(
    operatorRunbook,
    /RELEASE_AUDIT="\$EVIDENCE_DIR\/final-release\/audit-\$RELEASE_SHA\.json"/u,
  );
  assert.doesNotMatch(operatorRunbook, /final-release\/\.release-evidence\/document-archive/u);
  assert.ok(
    (operatorRunbook.match(/commits\/main" --jq \.sha\)" = "\$RELEASE_SHA"/gu) ?? []).length >= 4,
  );
  assert.doesNotMatch(operatorRunbook, /environment=production|ENVIRONMENT=production/u);
});

test('la migration est bornée, append-only, privée et porte les huit fences exactes', () => {
  assert.match(migration, /SET LOCAL lock_timeout = '5s'/u);
  assert.match(migration, /SET LOCAL statement_timeout = '60s'/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/gu);
  assert.match(migration, /'plan_authorized'/u);
  assert.match(migration, /'deleted_verified'/u);
  assert.match(migration, /'final_audit_verified'/u);
  assert.match(migration, /document_archive_quarantine_single_open_operation/u);
  assert.match(migration, /document_archive_quarantine_apply_authority_matches_plan/u);
  assert.match(migration, /FROM PUBLIC/u);
  for (const name of [
    'generated_legal_storage_object_immutable',
    'document_archive_quarantine_bucket_fence',
    'document_archive_quarantine_documents_reference_fence',
    'document_archive_quarantine_versions_reference_fence',
    'document_archive_quarantine_photos_reference_fence',
    'document_archive_quarantine_intents_reference_fence',
    'document_archive_quarantine_job_artifacts_reference_fence',
    'document_archive_quarantine_worker_lease_fence',
  ])
    assert.match(migration, new RegExp(name, 'u'));
});

test('release et CI prouvent le catalogue exact sous owner vendor non SETtable', () => {
  assert.match(release, /exact_count <> 8 OR named_count <> 8/u);
  assert.match(release, /trigger\.tgfoid = expected\.function_oid/u);
  assert.match(release, /trigger\.tgtype::integer = expected\.trigger_type/u);
  assert.match(
    release,
    /pg_catalog\.aclexplode\([\s\S]*privilege\.grantee = 0[\s\S]*privilege\.privilege_type = 'EXECUTE'/u,
  );
  assert.doesNotMatch(release, /has_function_privilege\('PUBLIC'/u);
  for (const source of [migration, release, runtime, postgresCert]) {
    assert.match(source, /expected\.update_column/u);
    assert.match(source, /trigger\.tgattr::text/u);
    assert.match(source, /trigger\.tgqual IS NULL/u);
    assert.match(source, /trigger\.tgnargs = 0/u);
    assert.match(source, /trigger\.tgconstraint = 0/u);
    assert.match(source, /NOT trigger\.tgdeferrable/u);
    assert.match(source, /NOT trigger\.tginitdeferred/u);
    assert.match(source, /trigger\.tgoldtable IS NULL/u);
    assert.match(source, /trigger\.tgnewtable IS NULL/u);
  }
  assert.match(postgresCert, /FOR EACH ROW WHEN \(false\)/u);
  assert.match(ci, /supabase_storage_admin/u);
  assert.match(bootstrap, /bob_ci_set_quarantine_bucket_fence/u);
  assert.match(bootstrap, /REVOKE ALL ON FUNCTION storage\.bob_ci_set_quarantine_bucket_fence/u);
  assert.match(ci, /pg_has_role\(current_user, vendor_oid, 'SET'\)/u);
  assert.match(ci, /RUN_POSTGRES_DOCUMENT_ARCHIVE_QUARANTINE_CERT/u);
  assert.match(ci, /DOCUMENT_ARCHIVE_QUARANTINE_CERT_DATABASE_KIND: ephemeral/u);
  assert.match(packageJson, /archive:quarantine:plan/u);
  assert.match(packageJson, /archive:quarantine:apply/u);
  assert.match(packageJson, /archive:quarantine:finalize/u);
});

test('la CI certifie la quarantaine sur une base fraîche après le train V2 owner-split', () => {
  const sharedStart = ci.indexOf('  rls-certification:\n');
  const isolatedStart = ci.indexOf('  document-archive-quarantine-certification:\n');
  const isolatedEnd = ci.indexOf('  realtime-global-capacity-certification:\n', isolatedStart);
  assert.ok(sharedStart >= 0 && isolatedStart > sharedStart && isolatedEnd > isolatedStart);

  const sharedJob = ci.slice(sharedStart, isolatedStart);
  const isolatedJob = ci.slice(isolatedStart, isolatedEnd);
  assert.doesNotMatch(sharedJob, /RUN_POSTGRES_DOCUMENT_ARCHIVE_QUARANTINE_CERT/u);
  assert.match(isolatedJob, /POSTGRES_DB: bob_ephemeral_ci/u);
  assert.match(isolatedJob, /DOCUMENT_ARCHIVE_TEST_SEED_ACTIVATION_EVIDENCE: 'true'/u);
  assert.match(isolatedJob, /SUPABASE_STORAGE_BUCKET: documents/u);

  const predeploy = isolatedJob.indexOf('BOB_RELEASE_PHASE=predeploy');
  const archiveActivation = isolatedJob.indexOf('activate-document-archive-v2.sh', predeploy);
  const snapshotActivation = isolatedJob.indexOf(
    'activate-document-archive-snapshot-v2.sh',
    archiveActivation,
  );
  const settlementActivation = isolatedJob.indexOf(
    'activate-invoice-settlement-v2.sh',
    snapshotActivation,
  );
  const outboxActivation = isolatedJob.indexOf(
    'activate-notification-outbox-v2.sh',
    settlementActivation,
  );
  const postdeploy = isolatedJob.indexOf('BOB_RELEASE_PHASE=postdeploy', outboxActivation);
  const capacityClose = isolatedJob.indexOf(
    'Close Bob Live capacity before the schema-owner split',
    postdeploy,
  );
  const ownerSplit = isolatedJob.indexOf('certify-rls-owner-split.sh', capacityClose);
  const cleanupStep = isolatedJob.indexOf(
    'Re-certify archive snapshot cleanup after the schema-owner split',
    ownerSplit,
  );
  const quarantineStep = isolatedJob.indexOf(
    'Certify exact-key archive quarantine in isolation',
    cleanupStep,
  );
  assert.ok(
    predeploy >= 0 &&
      archiveActivation > predeploy &&
      snapshotActivation > archiveActivation &&
      settlementActivation > snapshotActivation &&
      outboxActivation > settlementActivation &&
      postdeploy > outboxActivation &&
      capacityClose > postdeploy &&
      ownerSplit > capacityClose &&
      cleanupStep > ownerSplit &&
      quarantineStep > cleanupStep,
  );
  const cleanupContract = isolatedJob.slice(cleanupStep, quarantineStep);
  assert.match(cleanupContract, /CABINET_RELEASE_ENV: 'staging'/u);
  assert.match(cleanupContract, /RUN_POSTGRES_DOCUMENT_ARCHIVE_SNAPSHOT_CERT: 'true'/u);
  assert.match(
    isolatedJob.slice(quarantineStep),
    /DOCUMENT_ARCHIVE_QUARANTINE_CERT_DATABASE_KIND: ephemeral/u,
  );
});

test('le runtime sépare strictement les autorités public et Storage', () => {
  const sqlTemplates = [...runtime.matchAll(/`([^`]*)`/gs)].map((match) => match[1] ?? '');
  for (const sql of sqlTemplates) {
    assert.equal(
      sql.includes('public.') && sql.includes('storage.'),
      false,
      'Une même requête SQL ne peut pas joindre public et Storage sous des owners distincts.',
    );
  }
  assert.match(runtime, /ARCHIVE_QUARANTINE_PUBLIC_OWNER_INVENTORY_INVALID/u);
  assert.match(runtime, /ARCHIVE_QUARANTINE_STORAGE_AUTHORITY_NOT_RESTORED/u);
  assert.match(runtime, /prepareArchiveReferenceProjection/u);
  assert.match(runtime, /populateArchiveReferenceProjection/u);
  assert.match(runtime, /authorities\[0\]!\.superuser/u);
  assert.match(runtime, /canSetStorageOwner/u);
  assert.match(runtime, /ARCHIVE_QUARANTINE_AUTHORITY_SEPARATION_INVALID/u);
  assert.match(runtime, /publicAuthority\.owner === publicAuthority\.sessionUser/u);
  assert.match(postgresCert, /connectArchiveQuarantineRuntime/u);
  assert.match(postgresCert, /DOCUMENT_ARCHIVE_QUARANTINE_CERT_REQUIRES_EPHEMERAL_DATABASE/u);
  for (const repositoryMethod of [
    'loadPinnedAudit',
    'sealPlan',
    'loadRecoverablePlan',
    'recordAuthorized',
    'recordDestinationVerified',
    'recordCopiedVerified',
    'assertEntryDeleteSafe',
    'assertSourceDeleted',
    'assertFinalSnapshotClean',
    'recordDeletedVerified',
    'loadFinalAudit',
    'recordFinalAuditVerified',
    'loadRecordedFinalAudit',
  ]) {
    assert.match(postgresCert, new RegExp(`repository\\.${repositoryMethod}\\(`, 'u'));
  }
  assert.match(postgresCert, /loadArchiveQuarantineFinalAuditForResume/u);
  assert.match(postgresCert, /finalizeArchiveQuarantine\(\{[\s\S]*guard: repository/u);
  assert.match(quarantineDomain, /input\.guard\.recordCompleted/u);
  assert.match(postgresCert, /ARCHIVE_QUARANTINE_CERT_LOST_FINAL_RECEIPT_PUT_ACK/u);
  assert.match(postgresCert, /completedBeforeRecovery/u);
  assert.match(postgresCert, /SELECT 1 FROM storage\.objects LIMIT 1/u);
});
