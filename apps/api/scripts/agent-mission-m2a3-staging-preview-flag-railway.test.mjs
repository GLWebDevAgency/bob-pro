import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildM2A3StagingPreviewFlagRailwayInvocation,
  runM2A3StagingPreviewFlagRailway,
} from './agent-mission-m2a3-staging-preview-flag-railway.mjs';

const UUIDS = {
  RAILWAY_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
  RAILWAY_ENVIRONMENT_ID: '22222222-2222-4222-8222-222222222222',
  RAILWAY_API_SERVICE_ID: '33333333-3333-4333-8333-333333333333',
};

function environment(overrides = {}) {
  return {
    ...UUIDS,
    SUPABASE_URL: 'https://project.supabase.co',
    BOB_M1B_STAGING_SUPABASE_PROJECT_REF: 'project',
    BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER: '123456789',
    BOB_M1B_STAGING_DATABASE_OID: '5',
    BOB_M1B_STAGING_DATABASE_NAME: 'postgres',
    BOB_M2A3_STAGING_RUN_ID: '123456789',
    BOB_M2A3_STAGING_RUN_ATTEMPT: '2',
    BOB_M2A3_STAGING_INITIATOR: 'limameghassene',
    BOB_M2A3_STAGING_REPOSITORY: 'GLWebDevAgency/bob-pro',
    BOB_M2A3_STAGING_RELEASE_SHA: 'a'.repeat(40),
    BOB_M2A3_STAGING_USER_ID: '44444444-4444-4444-8444-444444444444',
    BOB_M2A3_STAGING_FOUNDER_AUTH_DATE: '2026-07-31',
    BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL: 'conversation-codex',
    BOB_M2A3_STAGING_FOUNDER_AUTH_REF: 'decision:M2A3-20260731#founder',
    BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF: 'decision:M2A3-20260731#claude',
    BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF: 'decision:M2A3-20260731#gpt',
    ...overrides,
  };
}

test('épingle staging et réinjecte le contexte GitHub après les variables Railway', () => {
  const invocation = buildM2A3StagingPreviewFlagRailwayInvocation(
    'activate',
    environment({ BOB_M2A3_STAGING_OUTPUT: 'json' }),
  );
  assert.equal(invocation.executable, 'railway');
  assert.deepEqual(invocation.args.slice(0, 10), [
    'run',
    '--project',
    UUIDS.RAILWAY_PROJECT_ID,
    '--service',
    UUIDS.RAILWAY_API_SERVICE_ID,
    '--environment',
    UUIDS.RAILWAY_ENVIRONMENT_ID,
    '--no-local',
    '--',
    'env',
  ]);
  assert.ok(invocation.args.includes(`BOB_M2A3_STAGING_RELEASE_SHA=${'a'.repeat(40)}`));
  assert.ok(invocation.args.includes('BOB_M2A3_STAGING_OUTPUT=json'));
  assert.deepEqual(invocation.args.slice(-3), [
    process.execPath,
    'apps/api/scripts/agent-mission-m2a3-staging-preview-flag.mjs',
    'activate',
  ]);
  const serialized = invocation.args.join(' ');
  assert.doesNotMatch(serialized, /DIRECT_URL|DATABASE_URL|RAILWAY_TOKEN|KEYRING|PASSWORD/u);
});

test('refuse toute commande, identité ou sortie ambiguë avant Railway', () => {
  assert.throws(
    () => buildM2A3StagingPreviewFlagRailwayInvocation('unknown', environment()),
    /command is unsupported/u,
  );
  assert.throws(
    () =>
      buildM2A3StagingPreviewFlagRailwayInvocation(
        'assert-off',
        environment({ RAILWAY_ENVIRONMENT_ID: 'staging' }),
      ),
    /RAILWAY_ENVIRONMENT_ID must be a UUID/u,
  );
  assert.throws(
    () =>
      buildM2A3StagingPreviewFlagRailwayInvocation(
        'assert-off',
        environment({ BOB_M2A3_STAGING_OUTPUT: 'verbose' }),
      ),
    /OUTPUT must be empty or json/u,
  );
});

test('les commandes OFF et urgence restent exécutables sans autorisation ON', () => {
  const withoutActivationAuthorization = environment({
    BOB_M2A3_STAGING_USER_ID: '',
    BOB_M2A3_STAGING_FOUNDER_AUTH_DATE: '',
    BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL: '',
    BOB_M2A3_STAGING_FOUNDER_AUTH_REF: '',
    BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF: '',
    BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF: '',
  });
  for (const command of ['deactivate', 'assert-off', 'emergency-kill', 'assert-effective-safe']) {
    const invocation = buildM2A3StagingPreviewFlagRailwayInvocation(
      command,
      withoutActivationAuthorization,
    );
    for (const name of [
      'BOB_M2A3_STAGING_USER_ID',
      'BOB_M2A3_STAGING_FOUNDER_AUTH_DATE',
      'BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL',
      'BOB_M2A3_STAGING_FOUNDER_AUTH_REF',
      'BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF',
      'BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF',
    ]) {
      assert.ok(invocation.args.includes(`${name}=`));
    }
  }
  assert.throws(
    () => buildM2A3StagingPreviewFlagRailwayInvocation('activate', withoutActivationAuthorization),
    /FOUNDER_AUTH_DATE is missing or invalid/u,
  );
  assert.throws(
    () =>
      buildM2A3StagingPreviewFlagRailwayInvocation('assert-canary', withoutActivationAuthorization),
    /STAGING_USER_ID is missing or invalid/u,
  );
});

test('borne chaque processus Railway selon son pire cas psql sans relayer de secret', () => {
  for (const [command, expectedTimeout] of [
    ['assert-off', 150_000],
    ['activate', 300_000],
    ['emergency-kill', 660_000],
  ]) {
    let observed;
    assert.throws(
      () =>
        runM2A3StagingPreviewFlagRailway(command, environment(), {
          spawnSync(executable, args, options) {
            observed = { executable, args, options };
            return { status: 1, stderr: 'postgresql://postgres:secret@example.test/postgres' };
          },
        }),
      /failed \(exit-1\)/u,
    );
    assert.equal(observed.options.timeout, expectedTimeout);
    assert.equal(observed.options.killSignal, 'SIGKILL');
    assert.equal(observed.options.stdio, 'inherit');
  }
});
