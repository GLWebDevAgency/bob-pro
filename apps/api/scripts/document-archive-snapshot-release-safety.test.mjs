import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const [
  expand,
  validate,
  activation,
  releaseActivation,
  release,
  ci,
  railwayWorkflow,
  repository,
  worker,
  audit,
  rlsCleanup,
  facturXSample,
  snapshotCertificate,
] = await Promise.all([
  readFile(
    new URL(
      'prisma/migrations/20260804010000_document_archive_snapshot_intent_expand/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260804010100_document_archive_snapshot_intent_validate/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(new URL('scripts/activate-document-archive-snapshot-v2.sh', root), 'utf8'),
  readFile(new URL('scripts/activate-release-protocols-v2.sh', root), 'utf8'),
  readFile(new URL('scripts/release.sh', root), 'utf8'),
  readFile(new URL('../../.github/workflows/ci.yml', root), 'utf8'),
  readFile(new URL('../../.github/workflows/railway-api.yml', root), 'utf8'),
  readFile(new URL('src/persistence/prisma/repositories.ts', root), 'utf8'),
  readFile(new URL('src/backend.service.ts', root), 'utf8'),
  readFile(new URL('src/document-archive-audit.main.ts', root), 'utf8'),
  readFile(new URL('prisma/rls-cert-cleanup.sql', root), 'utf8'),
  readFile(new URL('scripts/generate-facturx-sample.mjs', root), 'utf8'),
  readFile(
    new URL('src/persistence/prisma/document-archive-snapshot.postgres.test.ts', root),
    'utf8',
  ),
]);

test('expand/validate respectent le protocole de migration additif', () => {
  for (const migration of [expand, validate]) {
    assert.match(migration, /SET LOCAL lock_timeout = '5s'/u);
    assert.match(migration, /SET LOCAL statement_timeout = '60s'/u);
  }
  assert.match(expand, /ADD CONSTRAINT[\s\S]*NOT VALID/u);
  assert.doesNotMatch(expand, /VALIDATE CONSTRAINT/u);
  assert.match(validate, /VALIDATE CONSTRAINT/u);
  assert.doesNotMatch(validate, /ADD CONSTRAINT|CREATE TABLE|CREATE FUNCTION/u);
  assert.match(expand, /pg_has_role\(session_user, schema_owner_oid, 'SET'\)/u);
  assert.match(expand, /SET LOCAL ROLE %I/u);
  assert.match(expand, /RESET ROLE/u);
  assert.match(expand, /GRANT CREATE ON SCHEMA public TO %I/u);
  assert.match(expand, /REVOKE CREATE ON SCHEMA public FROM %I/u);
  assert.match(expand, /DOCUMENT_ARCHIVE_SNAPSHOT_SCHEMA_ACL_RESTORE_FAILED/u);
  assert.match(validate, /pg_has_role\(session_user, schema_owner_oid, 'SET'\)/u);
  assert.match(validate, /SET LOCAL ROLE %I/u);
  assert.match(validate, /RESET ROLE/u);
});

test('les inventaires SQL sont régénérés depuis les unions TypeScript', () => {
  const generator = fileURLToPath(
    new URL('scripts/generate-document-archive-snapshot-migration-values.mjs', root),
  );
  const result = spawnSync(process.execPath, [generator, '--check'], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migration values verified/u);
});

test('l’échantillon Factur-X fournit la même date déterministe au PDF et à sa pièce jointe', () => {
  assert.match(facturXSample, /const DOCUMENT_CREATED_AT = '2026-06-29T10:00:00\.000Z'/u);
  assert.match(facturXSample, /documentCreatedAt: DOCUMENT_CREATED_AT/u);
  assert.match(
    facturXSample,
    /renderInvoice\(pdfData, \{[\s\S]*xml,[\s\S]*createdAt: DOCUMENT_CREATED_AT,[\s\S]*\}\)/u,
  );
});

test('la migration ferme immédiatement tables et fonctions à la Data API Supabase', () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(expand, new RegExp(`'${role}'`, 'u'));
  }
  for (const functionName of [
    'enforce_document_archive_snapshot_protocol_monotonicity',
    'prevent_document_archive_snapshot_mutation',
    'prevent_document_archive_artifact_intent_mutation',
    'guard_document_archive_job_snapshot_required_v1',
    'document_archive_job_enqueue_v3',
    'document_archive_artifact_intents_prepare_v1',
    'document_archive_artifact_intents_list_v1',
    'document_archive_job_complete_v3',
    'prevent_generated_legal_storage_object_mutation',
  ]) {
    const occurrences = expand.match(new RegExp(functionName, 'gu'))?.length ?? 0;
    assert.ok(occurrences >= 2, `${functionName} doit être créé et explicitement révoqué`);
  }
  assert.match(
    expand,
    /REVOKE ALL ON TABLE[\s\S]*document_archive_snapshot_protocol_state[\s\S]*FROM PUBLIC/u,
  );
  assert.match(
    expand,
    /ALTER TABLE public\.document_archive_render_snapshots FORCE ROW LEVEL SECURITY/u,
  );
  assert.match(
    expand,
    /ALTER TABLE public\.document_archive_artifact_intents FORCE ROW LEVEL SECURITY/u,
  );
});

test('le writer V3 vérifie le seal avant l’écriture et le LIST ne l’ouvre pas', () => {
  assert.match(repository, /openDocumentArchiveRenderSnapshot\(input\.renderSnapshot\)/u);
  assert.match(repository, /verifyRenderSnapshot: false/u);
  const listDueStart = repository.indexOf('async listDue(companyId: string');
  const claimStart = repository.indexOf('async claimForArchive(', listDueStart);
  assert.ok(listDueStart >= 0 && claimStart > listDueStart);
  assert.doesNotMatch(
    repository.slice(listDueStart, claimStart),
    /openDocumentArchiveRenderSnapshot/u,
  );
  assert.match(expand, /expected_artifact_count := CASE input_reason/u);
  assert.match(expand, /documentCreatedAt[\s\S]*metadataCreatedAt/u);
  assert.match(expand, /count\(DISTINCT value->>'kind'\)/u);
  assert.match(
    expand,
    /document\.filename IS DISTINCT FROM intent\.filename/u,
    'DONE doit recouper le nom scellé avec le Document matérialisé',
  );
});

test('le worker garde des transactions SQL courtes autour des seules phases persistées', () => {
  const start = worker.indexOf('async runDocumentArchiveJobs(');
  const end = worker.indexOf('async runNotificationJobs(', start);
  assert.ok(start >= 0 && end > start);
  const implementation = worker.slice(start, end);
  assert.match(implementation, /for \(const candidate of jobs\)/u);
  assert.match(implementation, /try \{[\s\S]*claimForArchive/u);
  assert.match(implementation, /archiveDocumentRenderSnapshot\(job, leaseToken\)/u);
  assert.match(implementation, /markFailed\(/u);
  assert.match(implementation, /Archivage isolé en échec inattendu/u);
  assert.doesNotMatch(
    implementation,
    /runWithTenant\([^)]*,\s*async\s*\(\)\s*=>[\s\S]*documentStorage\.(?:put|get)/u,
  );
});

test('le cutover est lié aux migrations, drainé, monotone et retire N-1 atomiquement', () => {
  for (const marker of [
    'LOCK TABLE public._prisma_migrations IN SHARE MODE',
    'archive snapshot deployer cannot freeze the Prisma migration ledger',
    'DO $migration_gate$',
    'LOCK TABLE public.document_archive_jobs IN SHARE ROW EXCLUSIVE MODE',
    'an active N-1 document archive lease still exists',
    'an incomplete N-1 document archive job has no sealed snapshot',
    'DOCUMENT_ARCHIVE_SNAPSHOT_V2_ACTIVATION_RELEASE_SHA',
    'base document archive protocol V2 must be terminal before snapshot cutover',
    'document_archive_job_enqueue_v2(text,text,text,text)',
    'document_archive_job_complete_v2(text,text,text,jsonb,text)',
    'runtime N-1 archive capabilities remain executable after cutover',
    'SET CONSTRAINTS ALL IMMEDIATE',
  ]) {
    assert.match(activation, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(activation, /openssl dgst -sha256/u);
  assert.match(activation, /runtime_role\.rolsuper OR runtime_role\.rolbypassrls/u);
  assert.match(activation, /NOT function\.prosecdef/u);
  assert.match(activation, /function\.prosecdef/u);
  assert.match(activation, /SET LOCAL ROLE %I/u);
  assert.match(activation, /RESET ROLE/u);
  assert.doesNotMatch(activation, /GRANT (?:SELECT|UPDATE) ON TABLE public\._prisma_migrations/u);
  const migrationLock = activation.indexOf('LOCK TABLE public._prisma_migrations IN SHARE MODE');
  const ownerRole = activation.indexOf("'SET LOCAL ROLE %I'");
  assert.ok(migrationLock >= 0 && ownerRole > migrationLock);
});

test('release et CI maintiennent V2 pendant expand puis activent V3 avant postdeploy', () => {
  const grantV3 = release.indexOf(
    'GRANT EXECUTE ON FUNCTION public.document_archive_job_enqueue_v3',
  );
  const archiveOwner = release.indexOf('DO $archive_acl_owner$');
  const firstArchiveAcl = release.indexOf(
    'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE\n  public.document_archive_protocol_state',
  );
  assert.ok(archiveOwner >= 0 && firstArchiveAcl > archiveOwner);
  assert.match(
    release,
    /certify_document_archive_protocol\(\)[\s\S]*SET LOCAL ROLE %I[\s\S]*document_archive_protocol_state/u,
  );
  assert.match(
    release,
    /certify_document_archive_snapshot_protocol\(\)[\s\S]*SET LOCAL ROLE %I[\s\S]*document_archive_snapshot_protocol_state/u,
  );
  const conditionalV2 = release.indexOf('document_archive_snapshot_expand', grantV3);
  const grantV2 = release.indexOf('document_archive_job_enqueue_v2', conditionalV2);
  assert.ok(grantV3 >= 0 && conditionalV2 > grantV3 && grantV2 > conditionalV2);
  assert.match(
    release,
    /archive_snapshot_state\."activeVersion" <> 2[\s\S]*archive snapshot protocol V2 terminal proof is incomplete/u,
  );
  assert.match(
    release,
    /certify_document_archive_protocol\(\)[\s\S]*?snapshot_version[\s\S]*?1\)[\s\S]*?document-archive-integrity\.postgres\.test\.ts[\s\S]*?2\)[\s\S]*?V3 snapshot certificate owns runtime proof/u,
    'Une release rejouée après cutover ne doit jamais réaccorder ni recertifier le writer V2 retiré.',
  );
  assert.match(
    release,
    /archive_activated_now[\s\S]*?document_archive_protocol_state[\s\S]*?document_archive_snapshot_protocol_state[\s\S]*?snapshot_state\."activeVersion" = 1[\s\S]*?document-archive-integrity\.postgres\.test\.ts/u,
    'Le postdeploy ne rejoue le certificat V2 que tant que le cutover snapshot terminal ne l’a pas retiré.',
  );
  const archiveV2 = ci.indexOf('activate-document-archive-v2.sh');
  const snapshotV2 = ci.indexOf('activate-document-archive-snapshot-v2.sh');
  const postdeploy = ci.indexOf('BOB_RELEASE_PHASE=postdeploy', snapshotV2);
  assert.ok(archiveV2 >= 0 && snapshotV2 > archiveV2 && postdeploy > snapshotV2);
  const railwayArchiveV2 = releaseActivation.indexOf('activate-document-archive-v2.sh');
  const railwaySnapshotV2 = releaseActivation.indexOf('activate-document-archive-snapshot-v2.sh');
  const railwaySettlementV2 = releaseActivation.indexOf('activate-invoice-settlement-v2.sh');
  assert.ok(
    railwayArchiveV2 >= 0 &&
      railwaySnapshotV2 > railwayArchiveV2 &&
      railwaySettlementV2 > railwaySnapshotV2,
  );
  assert.match(
    railwayWorkflow,
    /activate-release-protocols-v2\.sh[\s\S]*BOB_RELEASE_PHASE=postdeploy/u,
  );
});

test('le cleanup RLS est auto-réparable et respecte les FK du protocole archive V3', () => {
  const artifactCleanup = rlsCleanup.indexOf('DELETE FROM document_archive_job_artifacts');
  const intentCleanup = rlsCleanup.indexOf('DELETE FROM document_archive_artifact_intents');
  const snapshotCleanup = rlsCleanup.indexOf('DELETE FROM document_archive_render_snapshots');
  const documentCleanup = rlsCleanup.indexOf('DELETE FROM document_versions');
  const jobCleanup = rlsCleanup.indexOf('DELETE FROM document_archive_jobs');
  assert.ok(
    artifactCleanup >= 0 &&
      intentCleanup > artifactCleanup &&
      snapshotCleanup > intentCleanup &&
      jobCleanup > snapshotCleanup &&
      documentCleanup > jobCleanup,
    'Les enfants RESTRICT et leur job doivent être retirés avant les documents.',
  );
  assert.match(
    rlsCleanup,
    /BEGIN;[\s\S]*?DISABLE TRIGGER document_archive_render_snapshot_immutable[\s\S]*?DISABLE TRIGGER document_archive_artifact_intent_immutable[\s\S]*?DELETE FROM document_archive_render_snapshots[\s\S]*?ENABLE TRIGGER document_archive_render_snapshot_immutable[\s\S]*?ENABLE TRIGGER document_archive_artifact_intent_immutable[\s\S]*?COMMIT;/u,
    'La fenêtre de cleanup append-only doit être atomique et refermer ses deux triggers.',
  );
  assert.match(rlsCleanup, /direct_role\.rolsuper OR direct_role\.rolbypassrls/u);
  assert.match(rlsCleanup, /pg_has_role\(session_user, owner_oid, 'SET'\)/u);

  const predeployStart = release.indexOf("pnpm --filter '@bob/api...' run build");
  const predeploy = release.slice(predeployStart);
  const staleCleanup = predeploy.indexOf('cleanup_rls_cert');
  const bootstrap = predeploy.indexOf('node apps/api/scripts/bootstrap-cabinet-pilots.mjs');
  const workerScope = predeploy.indexOf('certify_cabinet_worker_scope', bootstrap);
  const mutableCertifications = predeploy.indexOf(
    'run_nonproduction_mutating_certifications',
    workerScope,
  );
  assert.ok(
    staleCleanup >= 0 &&
      bootstrap > staleCleanup &&
      workerScope > bootstrap &&
      mutableCertifications > workerScope,
    'Les restes bornés d’une release interrompue doivent partir avant le scope cabinet.',
  );
});

test('le certificat snapshot récupère uniquement le manifeste staging sans désactiver les FK', () => {
  const ownerHelperStart = snapshotCertificate.indexOf(
    'async function assumeCommonPublicTableOwner(',
  );
  const ownerUrlStart = snapshotCertificate.indexOf(
    'function datasourceUrlWithOwnerRole(',
    ownerHelperStart,
  );
  const triggerHelperStart = snapshotCertificate.indexOf(
    'async function withCleanupTriggerDisabled',
    ownerUrlStart,
  );
  const recoveryStart = snapshotCertificate.indexOf('async function recoverStaleSnapshotVersions(');
  const recoveryEnd = snapshotCertificate.indexOf('function passesLuhn(', recoveryStart);
  const suiteStart = snapshotCertificate.indexOf('describe.skipIf(', recoveryEnd);
  const cleanupStart = snapshotCertificate.indexOf('afterAll(async () => {', suiteStart);
  const cleanupEnd = snapshotCertificate.indexOf(
    'it.skipIf(!RUN_STALE_RECOVERY_PROBES)',
    cleanupStart,
  );
  assert.ok(
    ownerHelperStart >= 0 &&
      ownerUrlStart > ownerHelperStart &&
      triggerHelperStart > ownerUrlStart &&
      recoveryStart > triggerHelperStart &&
      recoveryEnd > recoveryStart &&
      cleanupStart > suiteStart &&
      cleanupEnd > cleanupStart,
  );
  const ownerHelper = snapshotCertificate.slice(ownerHelperStart, ownerUrlStart);
  const ownerUrl = snapshotCertificate.slice(ownerUrlStart, triggerHelperStart);
  const triggerHelper = snapshotCertificate.slice(triggerHelperStart, recoveryStart);
  const recovery = snapshotCertificate.slice(recoveryStart, recoveryEnd);
  const cleanup = snapshotCertificate.slice(cleanupStart, cleanupEnd);

  for (const incidentVersionId of [
    'archive-snapshot-document-0fa529b9-900d-483c-b76e-5462666eec91-v1',
    'archive-snapshot-document-da6a9db2-0f3e-4563-9cd1-e1cd189f0250-v1',
  ]) {
    assert.equal(
      snapshotCertificate.match(new RegExp(incidentVersionId, 'gu'))?.length,
      1,
      `${incidentVersionId} doit apparaître exactement une fois dans le manifeste fermé`,
    );
  }
  assert.match(
    snapshotCertificate,
    /CERT_ALLOWED_RELEASE_ENVIRONMENTS = new Set\(\['development', 'staging'\]\)/u,
  );
  assert.match(
    snapshotCertificate,
    /RUN_STALE_RECOVERY_PROBES = process\.env\.CABINET_RELEASE_ENV === 'development'/u,
  );
  assert.equal(
    snapshotCertificate.match(/it\.skipIf\(!RUN_STALE_RECOVERY_PROBES\)/gu)?.length,
    3,
    'les probes qui fabriquent un orphelin doivent rester hors staging',
  );
  assert.match(
    recovery,
    /pg_advisory_xact_lock\(hashtextextended\('bob-document-archive-byte-audit', 0\)\)/u,
  );
  assert.match(
    snapshotCertificate,
    /CERT_RECOVERY_STORAGE_LOCK_STATEMENT =\s*'LOCK TABLE storage\.objects IN SHARE ROW EXCLUSIVE MODE'/u,
  );
  const publicLockNamesStart = snapshotCertificate.indexOf(
    'const CERT_RECOVERY_PUBLIC_TABLE_NAMES = [',
  );
  const publicLockNamesEnd = snapshotCertificate.indexOf('] as const;', publicLockNamesStart);
  assert.ok(publicLockNamesStart >= 0 && publicLockNamesEnd > publicLockNamesStart);
  const publicLockNames = snapshotCertificate.slice(publicLockNamesStart, publicLockNamesEnd);
  let previousLockName = -1;
  for (const relation of [
    'companies',
    'customers',
    'quotes',
    'invoices',
    'documents',
    'document_versions',
    'chantier_photos',
    'document_analyses',
    'document_invoice_pdf_attestations',
    'document_archive_jobs',
    'document_archive_render_snapshots',
    'document_archive_job_artifacts',
    'document_archive_artifact_intents',
  ]) {
    const lockName = publicLockNames.indexOf(`'${relation}'`);
    assert.ok(
      lockName > previousLockName,
      `le verrou public ${relation} doit respecter l'ordre canonique`,
    );
    previousLockName = lockName;
  }
  const initialStorageAuthority = recovery.indexOf('await assumeSessionUser(tx)');
  const storageLock = recovery.indexOf('CERT_RECOVERY_STORAGE_LOCK_STATEMENT');
  const initialOwnerAssumption = recovery.indexOf(
    'assumeCommonPublicTableOwner(tx, CERT_RECOVERY_PUBLIC_TABLE_NAMES)',
    storageLock,
  );
  const publicLockLoop = recovery.indexOf(
    'for (const tableName of CERT_RECOVERY_PUBLIC_TABLE_NAMES)',
    initialOwnerAssumption,
  );
  assert.ok(initialStorageAuthority >= 0 && storageLock > initialStorageAuthority);
  assert.ok(initialOwnerAssumption > storageLock);
  assert.ok(publicLockLoop > initialOwnerAssumption);
  assert.match(recovery, /`LOCK TABLE public\.\$\{tableName\} IN SHARE ROW EXCLUSIVE MODE`/u);
  assert.match(recovery, /TransactionIsolationLevel\.ReadCommitted/u);
  assert.doesNotMatch(recovery, /TransactionIsolationLevel\.Serializable/u);
  assert.match(recovery, /const candidates = await readValidatedCandidates\(\)/u);
  assert.match(recovery, /const confirmedCandidates = await readValidatedCandidates\(\)/u);
  assert.match(recovery, /candidates\.length !== expectedManifest\.length/u);
  assert.match(recovery, /candidate\.storageKey === manifestEntry\.storageKey/u);
  assert.match(recovery, /assumeCommonPublicTableOwner/u);
  assert.match(recovery, /withCleanupTriggerDisabled/u);
  assert.match(recovery, /storedDocumentVersion\.deleteMany/u);
  assert.doesNotMatch(recovery, /session_replication_role/u);
  const storageRead = recovery.indexOf('FROM storage.objects AS object');
  const storageAuthority = recovery.lastIndexOf('await assumeSessionUser(tx)', storageRead);
  const publicAuthorityRestored = recovery.indexOf(
    'await assumeCommonPublicTableOwner(tx, CERT_RECOVERY_PUBLIC_TABLE_NAMES)',
    storageRead,
  );
  const publicDependencyRead = recovery.indexOf('for (const candidate of candidates)', storageRead);
  assert.ok(storageAuthority >= 0 && storageRead > storageAuthority);
  assert.ok(
    publicAuthorityRestored > storageRead && publicDependencyRead > publicAuthorityRestored,
  );

  assert.match(ownerHelper, /pg_has_role\(session_user, relation\.relowner, 'SET'\)/u);
  assert.match(ownerHelper, /pg_catalog\.format\('SET LOCAL ROLE %I'/u);
  assert.match(ownerHelper, /assumedRole\?\.currentUser !== ownerName/u);
  assert.match(ownerHelper, /SET LOCAL ROLE NONE/u);
  assert.match(ownerHelper, /role\.currentUser !== role\.sessionUser/u);
  assert.match(ownerUrl, /`-c role=\$\{ownerName\}`/u);
  assert.match(triggerHelper, /trigger\.tgenabled::TEXT AS enabled/u);
  for (const restoreAction of [
    "O: 'ENABLE TRIGGER'",
    "D: 'DISABLE TRIGGER'",
    "R: 'ENABLE REPLICA TRIGGER'",
    "A: 'ENABLE ALWAYS TRIGGER'",
  ]) {
    assert.match(
      triggerHelper,
      new RegExp(restoreAction.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
  }

  assert.doesNotMatch(cleanup, /session_replication_role/u);
  assert.match(cleanup, /assumeCommonPublicTableOwner/u);
  assert.match(cleanup, /CERT_ARTIFACT_INTENT_IMMUTABILITY_TRIGGER/u);
  assert.match(cleanup, /CERT_RENDER_SNAPSHOT_IMMUTABILITY_TRIGGER/u);
  assert.match(cleanup, /CERT_VERSION_REPRESENTATION_TRIGGER/u);
  const versionDelete = cleanup.indexOf('storedDocumentVersion.deleteMany');
  const documentDelete = cleanup.indexOf('storedDocument.deleteMany', versionDelete);
  assert.ok(versionDelete >= 0);
  assert.ok(documentDelete > versionDelete, 'la version doit partir avant son parent document');

  const ownerSplit = ci.indexOf('sh apps/api/scripts/certify-rls-owner-split.sh');
  const postOwnerSplitRecert = ci.indexOf(
    'Re-certify archive snapshot cleanup after the schema-owner split',
    ownerSplit,
  );
  const postOwnerSplitScope = ci.slice(postOwnerSplitRecert);
  assert.ok(ownerSplit >= 0 && postOwnerSplitRecert > ownerSplit);
  assert.match(postOwnerSplitScope, /RUN_POSTGRES_DOCUMENT_ARCHIVE_SNAPSHOT_CERT: 'true'/u);
  assert.match(
    postOwnerSplitScope,
    /src\/persistence\/prisma\/document-archive-snapshot\.postgres\.test\.ts/u,
  );
});

test('l’audit considère les intentions dues et ne confond pas création et mutation', () => {
  assert.match(audit, /FROM public\.document_archive_artifact_intents AS intent/u);
  assert.match(audit, /archive_intent:/u);
  assert.match(
    audit,
    /object\.updated_at > object\.created_at[\s\S]*object\.updated_at > greatest\(document\."createdAt", version\."createdAt"\)/u,
  );
});
