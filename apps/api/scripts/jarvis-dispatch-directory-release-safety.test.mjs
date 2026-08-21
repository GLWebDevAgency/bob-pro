import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const migrationUrls = [
  new URL(
    'prisma/migrations/20260820100000_jarvis_dispatch_directory/migration.sql',
    root,
  ),
  new URL(
    'prisma/migrations/20260820140000_jarvis_dispatch_directory_leased/migration.sql',
    root,
  ),
  new URL(
    'prisma/migrations/20260820150000_jarvis_dispatch_directory_signalable/migration.sql',
    root,
  ),
];
const [
  release,
  localCertificate,
  migration,
  rls,
  releaseCertificate,
  worker,
  directoryPort,
  adapter,
  packageJson,
  ...historicalMigrations
] = await Promise.all([
  readFile(new URL('scripts/release.sh', root), 'utf8'),
  readFile(new URL('scripts/certify-agent-missions-local.sh', root), 'utf8'),
  readFile(new URL(
    'prisma/migrations/20260821010000_jarvis_dispatch_directory_cursor/migration.sql',
    root,
  ), 'utf8'),
  readFile(new URL('prisma/rls.sql', root), 'utf8'),
  readFile(new URL('prisma/jarvis-dispatch-directory-release-cert.sql', root), 'utf8'),
  readFile(new URL('src/jobs/jarvis-work-item-dispatch.service.ts', root), 'utf8'),
  readFile(new URL('src/jobs/jarvis-dispatch-directory.ts', root), 'utf8'),
  readFile(new URL(
    'src/persistence/prisma/jarvis-dispatch-directory.persistence.ts',
    root,
  ), 'utf8'),
  readFile(new URL('package.json', root), 'utf8'),
  ...migrationUrls.map((url) => readFile(url, 'utf8')),
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('les trois migrations N-1 restent byte-for-byte immuables', () => {
  assert.deepEqual(historicalMigrations.map(sha256), [
    '38388931de90bdfeda82001ca6a3c11823f6a2d997591004ad90eca366435249',
    '19259247ca864720d03408c9cf524b5c9cbf1470690650b09a4cf885a804eb6b',
    '87b374900a4cbff61d1a49448b5cdfe18097ebf62565be90beb72eeba1c9d269',
  ]);
});

test('l expand U1-l est additif, borné et ne redéfinit jamais v1', () => {
  assert.match(migration, /^BEGIN;$/mu);
  assert.match(migration, /^SET LOCAL lock_timeout = '5s';$/mu);
  assert.match(migration, /^SET LOCAL statement_timeout = '60s';$/mu);
  assert.match(migration, /CREATE TABLE public\.jarvis_dispatch_directory_cursors/u);
  assert.match(migration, /CREATE INDEX jarvis_work_items_dispatch_directory_keyset_idx/u);
  assert.doesNotMatch(migration, /CREATE(?: OR REPLACE)? FUNCTION public\.list_jarvis_dispatch_coordinates_v1/u);
  assert.doesNotMatch(migration, /DROP FUNCTION[\s\S]*list_jarvis_dispatch_coordinates_v1/u);
  assert.doesNotMatch(migration, /ALTER TABLE public\.jarvis_work_items/u);
  for (const marker of [
    'claim_jarvis_dispatch_coordinates_v2',
    'renew_jarvis_dispatch_coordinates_claim_v2',
    'start_jarvis_dispatch_coordinate_v2',
    'ack_jarvis_dispatch_coordinates_v2',
  ]) assert.match(migration, new RegExp(marker, 'u'));
  assert.match(migration, /"updatedAt" <= cursor_cutoff/u);
  assert.match(migration, /"resultDigest" IS NULL/u);
  assert.match(migration, /COLLATE "C"/u);
  assert.match(migration, /LIMIT batch_limit \+ 1/u);
  assert.match(migration, /pendingNextPosition/u);
  assert.match(migration, /claimHardExpiresAt/u);
  assert.match(migration, /operation_now := pg_catalog\.clock_timestamp\(\)/u);
  assert.match(migration, /REVOKE ALL PRIVILEGES[\s\S]*anon[\s\S]*authenticated[\s\S]*service_role/u);
});

test('le binaire N utilise seulement claim renew start ACK avec contrôle mémoire borné', () => {
  assert.doesNotMatch(worker, /listDispatchCoordinates/u);
  for (const marker of [
    'claimDispatchCoordinates',
    'renewDispatchCoordinatesClaim',
    'startDispatchCoordinate',
    'acknowledgeDispatchCoordinates',
  ]) assert.match(worker, new RegExp(marker, 'u'));
  assert.match(directoryPort, /JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE = 50/u);
  assert.match(worker, /JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE/u);
  assert.match(worker, /inFlightCoordinates/u);
  assert.match(worker, /canonicalDigest/u);
  assert.match(worker, /implements OnApplicationShutdown/u);
  assert.match(worker, /timer\.unref\(\)/u);
  assert.match(worker, /performance\.now\(\) >= hardDeadline/u);
  assert.match(worker, /const heartbeatLost = await heartbeat\.stop\(\)/u);
  assert.match(adapter, /withIsolatedGlobal/u);
  assert.match(adapter, /set_config\([\s\S]*'statement_timeout'/u);
  assert.match(adapter, /set_config\([\s\S]*'lock_timeout'/u);
  assert.match(adapter, /timeouts\?\.statementTimeout !== DIRECTORY_STATEMENT_TIMEOUT/u);
  assert.match(adapter, /timeouts\.lockTimeout !== DIRECTORY_LOCK_TIMEOUT/u);
  assert.doesNotMatch(adapter, /list_jarvis_dispatch_coordinates_v1/u);
});

test('la release exclut la table technique du grant générique puis normalise toute ACL', () => {
  assert.match(
    release,
    /relation\.relname NOT IN \([\s\S]*'jarvis_dispatch_directory_cursors'[\s\S]*\)/u,
  );
  assert.match(
    release,
    /aclexplode\(relation\.relacl\)[\s\S]*jarvis_dispatch_directory_cursors/u,
  );
  assert.match(
    release,
    /aclexplode\(attribute\.attacl\)[\s\S]*jarvis_dispatch_directory_cursors/u,
  );
  assert.match(
    release,
    /GRANT SELECT, INSERT, UPDATE ON TABLE public\.jarvis_dispatch_directory_cursors[\s\S]*TO bob_jarvis_dispatch_directory/u,
  );
  assert.match(
    release,
    /GRANT SELECT \("companyId", "ownerUserId", "runId", "status", "nextAttemptAt", "leaseExpiresAt", "authorizedAt", "authorizationDigest", "resultDigest", "signalAppliedAt", "updatedAt"\)/u,
  );
  assert.match(release, /ARRAY\['anon', 'authenticated', 'service_role'\]/u);
});

test('le certificat metadata est strictement read-only et appelé aux deux phases', () => {
  assert.match(releaseCertificate, /^BEGIN TRANSACTION READ ONLY;$/mu);
  assert.match(releaseCertificate, /^ROLLBACK;$/mu);
  assert.doesNotMatch(releaseCertificate, /__[A-Z_]+__/u);
  assert.doesNotMatch(
    releaseCertificate,
    /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\s/imu,
  );
  for (const marker of [
    'jarvis_dispatch_directory_cursors',
    'jarvis_work_items_dispatch_directory_keyset_idx',
    'jarvis_work_items_dispatch_directory_select',
    'claim_jarvis_dispatch_coordinates_v2',
    'renew_jarvis_dispatch_coordinates_claim_v2',
    'start_jarvis_dispatch_coordinate_v2',
    'ack_jarvis_dispatch_coordinates_v2',
    'expected_source_columns',
    'pg_catalog.pg_constraint',
    'pg_catalog.pg_trigger',
    'NOT trigger_catalog.tgisinternal',
    'NOT function.proisstrict',
    "function.provolatile = 'v'",
    "function.proparallel = 'u'",
    'NOT function.proleakproof',
    "function.prokind = 'f'",
    'expected_function_names',
    'function overload inventory drift',
    'privilege.is_grantable',
  ]) assert.match(releaseCertificate, new RegExp(marker, 'u'));
  assert.match(releaseCertificate, /pg_catalog\.cardinality\(function\.proconfig\) = 4/u);
  const provision = release.lastIndexOf('provision_jarvis_dispatch_directory');
  const predeployCertificate = release.indexOf(
    'certify_jarvis_dispatch_directory_release_metadata',
    provision,
  );
  const postdeployStart = release.indexOf('if [ "$BOB_RELEASE_PHASE" = postdeploy ]');
  const postdeployCertificate = release.indexOf(
    'certify_jarvis_dispatch_directory_release_metadata',
    postdeployStart,
  );
  assert.ok(provision >= 0 && predeployCertificate > provision);
  assert.ok(postdeployStart >= 0 && postdeployCertificate > postdeployStart);
});

test('le replay RLS garde les policies et les révocations Data API exactes', () => {
  assert.match(rls, /jarvis_work_items_dispatch_directory_select/u);
  assert.match(rls, /jarvis_dispatch_directory_cursors_select/u);
  assert.match(rls, /jarvis_dispatch_directory_cursors_insert/u);
  assert.match(rls, /jarvis_dispatch_directory_cursors_update/u);
  assert.match(rls, /"resultDigest" IS NULL/u);
  assert.match(rls, /"leaseExpiresAt" < statement_timestamp\(\)/u);
  assert.match(rls, /anon', 'authenticated', 'service_role/u);
});

test('le rituel local exerce l expand, N-1, le provisionnement et la suite PG U1-l', () => {
  const oldMigration = localCertificate.indexOf(
    '20260820150000_jarvis_dispatch_directory_signalable/migration.sql',
  );
  const newMigration = localCertificate.indexOf(
    '20260821010000_jarvis_dispatch_directory_cursor/migration.sql',
  );
  assert.ok(oldMigration >= 0 && newMigration > oldMigration);
  assert.match(localCertificate, /JARVIS_U1L_DIRECTORY_NOT_FAIL_CLOSED_BEFORE_PROVISIONING/u);
  assert.match(localCertificate, /list_jarvis_dispatch_coordinates_v1/u);
  assert.match(localCertificate, /d1000000-0000-8000-8000-000000000014/u);
  assert.match(localCertificate, /claim_jarvis_dispatch_coordinates_v2/u);
  assert.match(localCertificate, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.jarvis_dispatch_directory_cursors/u);
  assert.match(localCertificate, /"signalAppliedAt", "updatedAt"/u);
  assert.match(localCertificate, /jarvis-dispatch-directory-release-cert\.sql/u);
  assert.match(localCertificate, /jarvis-dispatch-directory\.postgres\.test\.ts/u);
});

test('la garde U1-l est enregistrée dans les deux agrégats API', () => {
  const parsed = JSON.parse(packageJson);
  for (const scriptName of ['test', 'test:release-flags']) {
    assert.match(
      parsed.scripts[scriptName],
      /scripts\/jarvis-dispatch-directory-release-safety\.test\.mjs/u,
    );
  }
});
