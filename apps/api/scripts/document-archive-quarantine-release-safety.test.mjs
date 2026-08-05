import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, '..');
const rootDir = path.resolve(apiDir, '../..');

const [
  workflow, migration, release, ci, bootstrap, packageJson, planRunner, oidc, runtime,
  postgresCert,
] = await Promise.all([
  readFile(path.join(rootDir, '.github/workflows/document-archive-quarantine-staging.yml'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/migrations/20260805010000_document_archive_quarantine_fence/migration.sql'), 'utf8'),
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8'),
  readFile(path.join(scriptDir, 'bootstrap-supabase-ci-postgres.sh'), 'utf8'),
  readFile(path.join(apiDir, 'package.json'), 'utf8'),
  readFile(path.join(apiDir, 'src/document-archive-quarantine.main.ts'), 'utf8'),
  readFile(path.join(apiDir, 'src/document-archive-quarantine-oidc.ts'), 'utf8'),
  readFile(path.join(apiDir, 'src/document-archive-quarantine.runtime.ts'), 'utf8'),
  readFile(path.join(
    apiDir,
    'src/persistence/prisma/document-archive-quarantine.postgres.test.ts',
  ), 'utf8'),
]);

test('l’opérateur staging reste manuel, mono-instance, OIDC et distant', () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment:\s*staging/u);
  assert.match(workflow, /group:\s*railway-api-staging/u);
  assert.match(workflow, /cancel-in-progress:\s*false/u);
  assert.match(workflow, /permissions:[\s\S]*id-token:\s*write/u);
  assert.equal((workflow.match(/audience=bob-document-archive-quarantine-staging/gu) ?? []).length, 3);
  assert.match(workflow, /--deployment-instance\s+"\$DEPLOYMENT_INSTANCE_ID"/u);
  assert.match(workflow, /--identity-file\s+"\$SSH_IDENTITY"/u);
  assert.match(workflow, /DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY/u);
  assert.match(workflow, /storageOrphans !== 5/u);
  assert.match(workflow, /storageOrphans !== 0/u);
  assert.match(workflow, /phase !== 'deleted_verified'/u);
  assert.match(workflow, /phase !== 'completed'/u);
  assert.doesNotMatch(workflow, /railway run/u);
  assert.doesNotMatch(workflow, /oidcToken:\s*\$\{\{/u);
});

test('plan et apply partagent l’autorité OIDC fondateur exacte et reprennent leur journal', () => {
  assert.match(planRunner, /parseArchiveQuarantinePlanInput\(await readStdin\(\)\)/u);
  assert.match(planRunner, /verifyArchiveQuarantineOidc/u);
  assert.match(planRunner, /loadRecoverablePlan/u);
  for (const claim of [
    'repository_id', 'repository_owner_id', 'workflow_sha', 'event_name', 'actor_id',
  ]) assert.match(oidc, new RegExp(`claims\\.${claim}`, 'u'));
  assert.match(oidc, /FOUNDER_ACTOR_ID = '84627817'/u);
  assert.match(oidc, /SUBJECT = 'repo:GLWebDevAgency\/bob-pro:environment:staging'/u);
  assert.match(runtime, /ARCHIVE_QUARANTINE_APPLY_OIDC_PROOF_REPLAYED/u);
  assert.match(runtime, /assertArchiveQuarantineCompletionBoundary/u);
  assert.match(runtime, /LOCK TABLE storage\.buckets IN SHARE ROW EXCLUSIVE MODE/u);
  assert.match(runtime, /LOCK TABLE public\.document_archive_job_artifacts IN SHARE ROW EXCLUSIVE MODE/u);
  assert.match(runtime, /LOCK TABLE public\.document_archive_jobs IN SHARE ROW EXCLUSIVE MODE/u);
  assert.match(runtime, /ARCHIVE_QUARANTINE_COMPLETION_STATE_CHANGED/u);
  assert.match(migration, /tokenSha256' IS DISTINCT FROM/u);
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
  ]) assert.match(migration, new RegExp(name, 'u'));
});

test('release et CI prouvent le catalogue exact sous owner vendor non SETtable', () => {
  assert.match(release, /exact_count <> 8 OR named_count <> 8/u);
  assert.match(release, /trigger\.tgfoid = expected\.function_oid/u);
  assert.match(release, /trigger\.tgtype::integer = expected\.trigger_type/u);
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
  assert.match(packageJson, /archive:quarantine:plan/u);
  assert.match(packageJson, /archive:quarantine:apply/u);
  assert.match(packageJson, /archive:quarantine:finalize/u);
});
