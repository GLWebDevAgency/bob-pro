import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const [
  release,
  releaseHelper,
  migration,
  metadataCert,
  rls,
  rlsCert,
  admissionAdapter,
  capacityAdapter,
  envSource,
  ci,
] = await Promise.all([
  readFile(new URL('scripts/release.sh', root), 'utf8'),
  readFile(new URL('scripts/realtime-capacity-release.sh', root), 'utf8'),
  readFile(
    new URL('prisma/migrations/20260722040000_realtime_global_capacity/migration.sql', root),
    'utf8',
  ),
  readFile(new URL('prisma/realtime-global-capacity-release-cert.sql', root), 'utf8'),
  readFile(new URL('prisma/rls.sql', root), 'utf8'),
  readFile(new URL('prisma/rls-cert.sql', root), 'utf8'),
  readFile(new URL('src/voice/realtime/realtime-admission.prisma.ts', root), 'utf8'),
  readFile(new URL('src/voice/realtime/realtime-capacity.prisma.ts', root), 'utf8'),
  readFile(new URL('src/config/env.ts', root), 'utf8'),
  readFile(new URL('../../.github/workflows/ci.yml', root), 'utf8'),
]);

function workflowJob(name, nextName) {
  const startMarker = `  ${name}:\n`;
  const endMarker = `  ${nextName}:\n`;
  const start = ci.indexOf(startMarker);
  const end = ci.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `workflow job ${name} must exist`);
  assert.ok(end > start, `workflow job ${name} must end before ${nextName}`);
  return ci.slice(start, end);
}

test('le plafond physique est transactionnel, N-1 compatible et la suppression société est fenced', () => {
  assert.match(
    migration,
    /LOCK TABLE public\.realtime_session_leases IN SHARE ROW EXCLUSIVE MODE/u,
  );
  assert.match(
    migration,
    /INSERT INTO public\.realtime_global_capacity[\s\S]*count\(\*\)::INTEGER/u,
  );
  assert.equal((migration.match(/REFERENCING (?:NEW|OLD) TABLE AS/gu) ?? []).length, 2);
  assert.match(migration, /ENABLE ALWAYS TRIGGER "00_realtime_global_capacity_insert"/u);
  assert.match(migration, /ENABLE ALWAYS TRIGGER "00_realtime_global_capacity_delete"/u);
  assert.match(migration, /BEFORE TRUNCATE/u);
  assert.match(
    migration,
    /mode = 'active'[\s\S]*"usedSessions" \+ changed_rows <= "globalMaxSessions"/u,
  );
  assert.match(migration, /ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID/u);
  assert.match(migration, /SET mode = 'closed'/u);
});

test('l’admission prend les verrous dans l’ordre et appelle le preflight avec les types SQL exacts', () => {
  const tenantLock = admissionAdapter.indexOf('await this.lockAdmission');
  const quota = admissionAdapter.indexOf('const quotaDenial');
  const preflight = admissionAdapter.indexOf('preflight_realtime_global_capacity_v1');
  const leaseInsert = admissionAdapter.indexOf('INSERT INTO realtime_session_leases', preflight);
  assert.ok(tenantLock >= 0 && quota > tenantLock && preflight > quota && leaseInsert > preflight);
  assert.match(admissionAdapter, /globalMaxSessions\}::integer/u);
  assert.match(admissionAdapter, /providerMaxSessions\}::integer/u);
  assert.match(admissionAdapter, /configVersion\}::integer/u);
  assert.match(admissionAdapter, /withIsolatedTenant[\s\S]*ADMISSION_TRANSACTION_OPTIONS/u);
  assert.match(admissionAdapter, /denial: 'global_capacity'/u);
  assert.match(capacityAdapter, /withIsolatedGlobal/u);
  assert.match(capacityAdapter, /statement_timeout/u);
  assert.match(capacityAdapter, /lock_timeout/u);
});

test('la configuration live est tout-ou-rien et possède une version monotone', () => {
  for (const variable of [
    'BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS',
    'BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS',
    'BOB_LIVE_CAPACITY_CONFIG_VERSION',
  ]) {
    assert.match(envSource, new RegExp(variable, 'u'));
  }
  assert.match(
    envSource,
    /globalCapacity\.globalMaxSessions > globalCapacity\.providerMaxSessions/u,
  );
  assert.match(
    envSource,
    /globalCapacity\.globalMaxSessions > env\.BOB_LIVE_GATEWAY_MAX_CONNECTIONS/u,
  );
  assert.match(releaseHelper, /selected_version <= state_row\."configVersion"/u);
  assert.match(releaseHelper, /actual_count <> 0/u);
  assert.match(releaseHelper, /Realtime capacity projection mismatch/u);
});

test('la fermeture et l’activation sérialisent singleton puis projection sans cycle de verrous', () => {
  const configure = releaseHelper.slice(releaseHelper.indexOf('configure()'));
  assert.doesNotMatch(
    configure,
    /LOCK TABLE public\.realtime_session_leases/u,
    'Le rollout ne doit jamais verrouiller leases avant le singleton utilisé par le trigger.',
  );
  assert.equal(
    (
      configure.match(
        /SET LOCAL ROLE bob_realtime_capacity;[\s\S]*?SELECT id FROM public\.realtime_global_capacity WHERE id = 1 FOR UPDATE;[\s\S]*?RESET ROLE;[\s\S]*?SELECT set_config\([\s\S]*?count\(\*\)::TEXT FROM public\.realtime_session_leases/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.equal((configure.match(/SET LOCAL statement_timeout = '5s';/gu) ?? []).length, 2);
  assert.equal((configure.match(/SET LOCAL lock_timeout = '2s';/gu) ?? []).length, 2);
});

test('la release ferme d’abord, certifie en lecture seule, puis active en dernier', () => {
  assert.match(release, /APP_DATABASE_ROLE:\?APP_DATABASE_ROLE runtime role name is required/u);
  for (const marker of [
    'realtime-capacity-release.sh ensure',
    'realtime-capacity-release.sh provision',
    'certify_realtime_global_capacity_release_metadata',
  ])
    assert.match(release, new RegExp(marker, 'u'));

  const provision = release.lastIndexOf('realtime-capacity-release.sh provision');
  const forcedClosed = release.indexOf(
    'BOB_LIVE_ENABLED=false OPENAI_REALTIME_ENABLED=false',
    provision,
  );
  const metadata = release.lastIndexOf('certify_realtime_global_capacity_release_metadata');
  const rlsProbe = release.lastIndexOf('-f apps/api/prisma/rls-cert.sql');
  const finalConfigure = release.lastIndexOf('realtime-capacity-release.sh configure');
  const success = release.lastIndexOf('Bob Pro API release checks passed');
  assert.ok(provision >= 0 && forcedClosed > provision && metadata > forcedClosed);
  assert.ok(rlsProbe > metadata && finalConfigure > rlsProbe && success > finalConfigure);
  assert.doesNotMatch(release.slice(finalConfigure), /pnpm |psql |node /u);

  assert.match(metadataCert, /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;$/mu);
  assert.match(metadataCert, /^ROLLBACK;$/mu);
  assert.doesNotMatch(metadataCert, /__[A-Z_]+__/u);
  assert.doesNotMatch(metadataCert, /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\s/imu);
  assert.match(metadataCert, /"usedSessions" <> lease_count/u);
  assert.match(metadataCert, /confdeltype = 'r'/u);
  assert.match(metadataCert, /trigger\.tgenabled = 'A'/u);
});

test('l’autorité globale reste hors du replay RLS générique et les probes mutantes respectent closed', () => {
  assert.doesNotMatch(rls, /realtime_global_capacity/u);
  assert.match(rlsCert, /FROM inspect_realtime_global_capacity_v1\(\)/u);
  assert.match(rlsCert, /\\if :bob_live_capacity_active/u);
  assert.match(rlsCert, /\\else[\s\S]*mode = 'closed'[\s\S]*\\endif/u);
  assert.match(rlsCert, /status = 'unavailable'/u);
  assert.match(rlsCert, /EXCEPTION WHEN SQLSTATE '55000'/u);
});

test('la CI comporte une autorité active éphémère puis la certification N/N+1', () => {
  const sharedAuthorityJob = workflowJob(
    'rls-certification',
    'realtime-global-capacity-certification',
  );
  const isolatedCapacityJob = workflowJob(
    'realtime-global-capacity-certification',
    'mistral-key-rotation-certification',
  );

  assert.doesNotMatch(
    sharedAuthorityJob,
    /RUN_POSTGRES_REALTIME_CAPACITY_CERT/u,
    'la course N/N+1 ne doit jamais dépendre des sessions laissées par les autres certificats',
  );
  assert.match(isolatedCapacityJob, /POSTGRES_DB: bob_ephemeral_global_capacity/u);
  assert.match(
    isolatedCapacityJob,
    /DATABASE_URL: postgresql:\/\/bob_app:bob_app@localhost:5432\/bob_ephemeral_global_capacity/u,
  );
  assert.match(
    isolatedCapacityJob,
    /DIRECT_URL: postgresql:\/\/postgres:postgres@localhost:5432\/bob_ephemeral_global_capacity/u,
  );
  assert.match(isolatedCapacityJob, /BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS/u);
  assert.match(isolatedCapacityJob, /BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS/u);
  assert.match(isolatedCapacityJob, /BOB_LIVE_CAPACITY_CONFIG_VERSION/u);
  assert.match(isolatedCapacityJob, /RUN_POSTGRES_REALTIME_CAPACITY_CERT/u);
  assert.match(isolatedCapacityJob, /realtime-capacity\.postgres\.test\.ts/u);

  const storage = isolatedCapacityJob.indexOf('CREATE TABLE IF NOT EXISTS storage.objects');
  const release = isolatedCapacityJob.indexOf('sh apps/api/scripts/release.sh');
  const certificate = isolatedCapacityJob.indexOf('RUN_POSTGRES_REALTIME_CAPACITY_CERT');
  const teardown = isolatedCapacityJob.indexOf('Close isolated Bob Live capacity');
  assert.ok(storage >= 0 && release > storage && certificate > release && teardown > certificate);
});
