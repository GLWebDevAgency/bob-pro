import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const [
  release,
  migration,
  rls,
  metadataCert,
  moduleSource,
  scheduler,
  directoryAdapter,
  admissionAdapter,
  ci,
] = await Promise.all([
  readFile(new URL('scripts/release.sh', root), 'utf8'),
  readFile(new URL(
    'prisma/migrations/20260722030000_realtime_reaper_directory/migration.sql', root,
  ), 'utf8'),
  readFile(new URL('prisma/rls.sql', root), 'utf8'),
  readFile(new URL('prisma/realtime-reaper-release-cert.sql', root), 'utf8'),
  readFile(new URL('src/voice/realtime/realtime.module.ts', root), 'utf8'),
  readFile(new URL('src/voice/realtime/realtime-reaper.scheduler.ts', root), 'utf8'),
  readFile(new URL('src/voice/realtime/realtime-reaper-directory.prisma.ts', root), 'utf8'),
  readFile(new URL('src/voice/realtime/realtime-admission.prisma.ts', root), 'utf8'),
  readFile(new URL('../../.github/workflows/ci.yml', root), 'utf8'),
]);

test('le reaper runtime ne dépend plus de la liste globale des sociétés', () => {
  assert.doesNotMatch(moduleSource, /ScheduledTenantDirectory/u);
  assert.doesNotMatch(scheduler, /listCompanyIds|JOB_COMPANY_IDS|companies\.list/u);
  assert.match(moduleSource, /createRealtimeReaperDirectory/u);
  assert.match(scheduler, /listDueCompanyIds/u);
  assert.match(scheduler, /renewClaim/u);
  assert.match(scheduler, /acknowledgeClaim/u);
  assert.match(scheduler, /implements OnApplicationShutdown/u);
});

test('la découverte est keyset, bornée, lease/renew/ACK et couvre les deux sources dues', () => {
  assert.match(migration, /realtime_reaper_directory_cursor/u);
  assert.match(migration, /realtime_reaper_tenant_schedule/u);
  assert.match(migration, /sync_realtime_reaper_tenant_schedule_v1/u);
  assert.match(migration, /REFERENCING NEW TABLE AS new_rows/u);
  assert.match(migration, /LEAST\(schedule\."oldestAdmissionAt", EXCLUDED\."oldestAdmissionAt"\)/u);
  assert.match(migration, /LEAST\(schedule\."nextLeaseDueAt", EXCLUDED\."nextLeaseDueAt"\)/u);
  assert.match(migration, /realtime_reaper_tenant_schedule_due_check/u);
  assert.doesNotMatch(migration, /DISTINCT ON/u);
  assert.equal((migration.match(/LIMIT batch_limit \+ 1/gu) ?? []).length, 2);
  assert.match(migration, /"cycleUpperAdmissionCompanyId"/u);
  assert.match(migration, /"cycleUpperLeaseCompanyId"/u);
  assert.match(migration, /"cycleAdmissionCutoffAt"/u);
  assert.match(migration, /"cycleLeaseCutoffAt"/u);
  assert.match(migration, /"pendingPreferLease"/u);
  assert.match(migration, /"pendingAdmissionHasMore"/u);
  assert.match(migration, /"pendingLeaseHasMore"/u);
  assert.match(migration, /"pendingCompanyIds"/u);
  assert.match(migration, /"claimExpiresAt" = observed_at \+ INTERVAL '30 seconds'/u);
  assert.match(migration, /list_realtime_reaper_tenants_v1/u);
  assert.match(migration, /ack_realtime_reaper_tenants_v1/u);
  assert.match(migration, /renew_realtime_reaper_tenants_claim_v1/u);
  assert.equal((migration.match(/SET lock_timeout = '1s'/gu) ?? []).length, 4);
  assert.match(
    migration,
    /realtime_reaper_schedule_lease_due_idx[\s\S]*"companyId"[\s\S]*"nextLeaseDueAt"/u,
  );
  assert.match(
    migration,
    /realtime_reaper_schedule_admission_due_idx[\s\S]*"companyId"[\s\S]*"oldestAdmissionAt"/u,
  );
  assert.match(migration, /"claimExpiresAt" > observed_at/u);
  assert.match(migration, /"claimExpiresAt" > clock_timestamp\(\)/u);
});

test('les transactions directory et tenant reaper possèdent leurs bornes réelles', () => {
  assert.match(directoryAdapter, /withIsolatedGlobal/u);
  assert.match(directoryAdapter, /statement_timeout/u);
  assert.match(directoryAdapter, /lock_timeout/u);
  assert.match(directoryAdapter, /maxWaitMs: 1_000, timeoutMs: 4_000/u);
  assert.match(admissionAdapter, /withIsolatedTenant/u);
  assert.match(admissionAdapter, /REAPER_EVENT_CLEANUP_LIMIT = 1_000/u);
  assert.match(admissionAdapter, /FOR UPDATE OF event SKIP LOCKED/u);
  assert.match(admissionAdapter, /LIMIT \$\{REAPER_EVENT_CLEANUP_LIMIT\}/u);
  assert.match(admissionAdapter, /reconcileReaperSchedule/u);
  assert.match(admissionAdapter, /realtime_reaper_tenant_schedule/u);
  const reconcileStart = admissionAdapter.indexOf('private async reconcileReaperSchedule');
  const reconcileEnd = admissionAdapter.indexOf('private async lockAdmission', reconcileStart);
  const reconcileBody = admissionAdapter.slice(reconcileStart, reconcileEnd);
  assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart);
  assert.ok(reconcileBody.indexOf('FOR UPDATE') >= 0);
  assert.ok(reconcileBody.indexOf('WITH projection AS') > reconcileBody.indexOf('FOR UPDATE'));
});

test('la release provisionne le rôle minimal puis certifie en lecture seule', () => {
  for (const marker of [
    'ensure_realtime_reaper_directory_role',
    'provision_realtime_reaper_directory',
    'certify_realtime_reaper_release_metadata',
  ]) assert.match(release, new RegExp(marker, 'u'));
  assert.doesNotMatch(release, /RUN_POSTGRES_REALTIME_ADMISSION_CERT/u);
  const order = [
    'prisma migrate deploy',
    'grant_app_role',
    ' -f apps/api/prisma/rls.sql',
    'provision_realtime_reaper_directory',
    'certify_realtime_reaper_release_metadata',
  ].map((marker) => release.lastIndexOf(marker));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(metadataCert, /^BEGIN TRANSACTION READ ONLY;$/mu);
  assert.match(metadataCert, /^ROLLBACK;$/mu);
  assert.doesNotMatch(
    metadataCert,
    /__[A-Z_]+__/u,
    'release certificates must never ship with unresolved placeholders',
  );
  assert.doesNotMatch(
    metadataCert,
    /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\s/imu,
  );
  assert.match(rls, /realtime_reaper_tenant_schedule_authority/u);
  assert.match(rls, /realtime_reaper_tenant_schedule_tenant_update/u);
  assert.doesNotMatch(
    rls,
    /REVOKE ALL ON FUNCTION public\.(?:list|ack|renew|sync)_realtime_reaper/u,
  );
  assert.doesNotMatch(release, /GRANT SELECT \(id, "companyId", "admittedAt"\)/u);
  assert.match(release, /SET LOCAL ROLE bob_realtime_reaper_directory;[\s\S]*REVOKE ALL ON FUNCTION public\.list_realtime_reaper_tenants_v1/u);
  assert.match(release, /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*realtime_reaper_tenant_schedule/u);
  assert.match(metadataCert, /realtime_reaper_tenant_schedule/u);
  assert.match(ci, /sh apps\/api\/scripts\/release\.sh/u);
  assert.match(ci, /RUN_POSTGRES_REALTIME_ADMISSION_CERT: 'true'/u);
  assert.match(ci, /src\/voice\/realtime\/realtime-admission\.postgres\.test\.ts/u);
});
