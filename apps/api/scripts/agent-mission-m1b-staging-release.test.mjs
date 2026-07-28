import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseM1BStagingReleaseEnvironment,
  runM1BStagingRelease,
} from './agent-mission-m1b-staging-release.mjs';

function environment(overrides = {}) {
  return {
    CABINET_RELEASE_ENV: 'staging',
    DIRECT_URL: 'postgresql://postgres.project:secret@db.example.test/postgres',
    DATABASE_URL: 'postgresql://bob_app.project:secret@pooler.example.test/postgres',
    APP_DATABASE_ROLE: 'bob_app',
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_PROVIDER: 'openai',
    OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1',
    BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '100',
    BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS: '200',
    BOB_LIVE_CAPACITY_CONFIG_VERSION: '4',
    ...overrides,
  };
}

function dependencies(events, snapshots = ['stable', 'stable']) {
  return {
    certifyDatabase() {
      events.push('database');
    },
    async assertStrictMigrationState() {
      events.push('migrations');
      return { appliedCount: 87, pendingCount: 0 };
    },
    foreignAuthoritySnapshot() {
      events.push('foreign-snapshot');
      return snapshots.shift();
    },
    async closeAndDrainCapacity() {
      events.push('capacity:closed-drained');
    },
    certifyCapacityAuthority() {
      events.push('capacity:acl');
    },
    runKeyManager(mode) {
      events.push(`keys:${mode}`);
    },
    certifyAgentMissionAcl() {
      events.push('agent-mission:acl');
    },
    configureCapacity() {
      events.push('capacity:configured');
      return 'active';
    },
  };
}

test('le gate est strictement staging et borne le drain', () => {
  assert.equal(
    parseM1BStagingReleaseEnvironment('predeploy', environment()).drainTimeoutSeconds,
    930,
  );
  assert.equal(
    parseM1BStagingReleaseEnvironment(
      'postdeploy',
      environment({ BOB_LIVE_DRAIN_TIMEOUT_SECONDS: '60' }),
    ).drainTimeoutSeconds,
    60,
  );
  assert.throws(
    () => parseM1BStagingReleaseEnvironment(
      'predeploy',
      environment({ CABINET_RELEASE_ENV: 'production' }),
    ),
    /staging-only/u,
  );
  assert.throws(
    () => parseM1BStagingReleaseEnvironment(
      'postdeploy',
      environment({ BOB_LIVE_DRAIN_TIMEOUT_SECONDS: '29' }),
    ),
    /outside its allowed range/u,
  );
});

test('predeploy ferme, stage et certifie sans jamais rouvrir', async () => {
  const events = [];
  const result = await runM1BStagingRelease(
    'predeploy',
    environment(),
    dependencies(events),
  );

  assert.deepEqual(events, [
    'database',
    'migrations',
    'foreign-snapshot',
    'capacity:closed-drained',
    'capacity:acl',
    'keys:stage',
    'agent-mission:acl',
    'foreign-snapshot',
  ]);
  assert.deepEqual(result, {
    phase: 'predeploy',
    passed: true,
    capacity: 'closed',
    appliedMigrations: 87,
    pendingMigrations: 0,
  });
});

test('postdeploy retire puis ne rouvre qu’après toutes les preuves', async () => {
  const events = [];
  const result = await runM1BStagingRelease(
    'postdeploy',
    environment(),
    dependencies(events),
  );

  assert.deepEqual(events, [
    'database',
    'migrations',
    'foreign-snapshot',
    'capacity:closed-drained',
    'capacity:acl',
    'keys:stage',
    'agent-mission:acl',
    'keys:retire',
    'foreign-snapshot',
    'capacity:configured',
  ]);
  assert.equal(result.capacity, 'active');
});

test('un drift étranger ou une fermeture incomplète échoue fermé avant configure', async () => {
  const driftEvents = [];
  await assert.rejects(
    runM1BStagingRelease(
      'postdeploy',
      environment(),
      dependencies(driftEvents, ['before', 'after']),
    ),
    /foreign protocol authority changed/u,
  );
  assert.equal(driftEvents.includes('capacity:configured'), false);

  const closeEvents = [];
  const closeFailure = dependencies(closeEvents);
  closeFailure.closeAndDrainCapacity = async () => {
    closeEvents.push('capacity:close-failed');
    throw new Error('drain failed');
  };
  await assert.rejects(
    runM1BStagingRelease('predeploy', environment(), closeFailure),
    /drain failed/u,
  );
  assert.equal(closeEvents.some((event) => event.startsWith('keys:')), false);
  assert.equal(closeEvents.includes('capacity:configured'), false);
});

test('borne chaque connexion PostgreSQL et le key manager natif', async () => {
  const calls = [];
  const stableSnapshot = JSON.stringify({ stable: true });
  await runM1BStagingRelease(
    'predeploy',
    environment(),
    {
      certifyDatabase() {},
      async assertStrictMigrationState() {
        return { appliedCount: 87, pendingCount: 0 };
      },
      spawnSync(command, args, options) {
        calls.push({ command, args, options });
        if (command === process.execPath) {
          return { status: 0, stdout: '', stderr: '' };
        }
        const input = String(options.input ?? '');
        if (input.includes('FROM public.realtime_global_capacity')) {
          return { status: 0, stdout: 'closed|0\n', stderr: '' };
        }
        if (input.includes('jsonb_build_object')) {
          return { status: 0, stdout: `${stableSnapshot}\n`, stderr: '' };
        }
        if (input.includes("flag.key = 'bob.agent_missions.quote.v1'")) {
          return { status: 0, stdout: '1|true\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  );

  const psqlCalls = calls.filter(({ command }) => command === 'psql');
  const managerCalls = calls.filter(({ command }) => command === process.execPath);
  assert.ok(psqlCalls.length >= 6);
  assert.equal(managerCalls.length, 1);
  for (const { options } of psqlCalls) {
    assert.equal(options.timeout, 45_000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.env.PGCONNECT_TIMEOUT, '10');
  }
  for (const { args } of psqlCalls) {
    const assignments = args.filter(
      (value, index) =>
        index > 0
        && args[index - 1] === '-v'
        && value !== 'ON_ERROR_STOP=1',
    );
    assert.equal(
      assignments.length,
      new Set(assignments).size,
      'une variable psql ne doit être injectée qu’une fois',
    );
  }
  assert.equal(managerCalls[0].options.timeout, 75_000);
  assert.equal(managerCalls[0].options.killSignal, 'SIGKILL');
  assert.equal(managerCalls[0].options.env.PGCONNECT_TIMEOUT, '10');
});

test('un échec PostgreSQL expose la sous-preuve bornée sans journaliser stderr', async () => {
  await assert.rejects(
    runM1BStagingRelease(
      'predeploy',
      environment(),
      {
        certifyDatabase() {},
        async assertStrictMigrationState() {
          return { appliedCount: 87, pendingCount: 0 };
        },
        spawnSync() {
          return {
            status: 1,
            stdout: '',
            stderr: 'secret-value-that-must-not-be-logged',
          };
        },
      },
    ),
    (error) => {
      assert.match(
        error.message,
        /PostgreSQL gate foreign-authority-snapshot failed \(nonzero-exit\)/u,
      );
      assert.doesNotMatch(error.message, /secret-value-that-must-not-be-logged/u);
      return true;
    },
  );
});
