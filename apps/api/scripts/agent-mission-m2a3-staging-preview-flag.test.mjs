import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertM2A3StagingPreviewFlagActive,
  assertM2A3StagingPreviewCanary,
  assertM2A3StagingPreviewEffectiveSafe,
  assertM2A3StagingPreviewFlagOff,
  decodeM2A3StagingPreviewFlagState,
  parseM2A3StagingPreviewFlagEnvironment,
  runM2A3StagingPreviewFlagCommand as runM2A3StagingPreviewFlagCommandRaw,
} from './agent-mission-m2a3-staging-preview-flag.mjs';

const SHA = 'a'.repeat(40);
const ACTOR = 'system:github:agent-mission-m2a3-staging-preview';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function environment(overrides = {}) {
  return {
    DIRECT_URL: 'postgresql://postgres.project:secret@db.example.test:5432/postgres',
    BOB_M2A3_STAGING_RUN_ID: '123456789',
    BOB_M2A3_STAGING_RUN_ATTEMPT: '2',
    BOB_M2A3_STAGING_INITIATOR: 'limameghassene',
    BOB_M2A3_STAGING_REPOSITORY: 'GLWebDevAgency/bob-pro',
    BOB_M2A3_STAGING_USER_ID: USER_ID,
    BOB_M2A3_STAGING_RELEASE_SHA: SHA,
    BOB_M2A3_STAGING_FOUNDER_AUTH_DATE: '2026-07-31',
    BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL: 'conversation-fondateur',
    BOB_M2A3_STAGING_FOUNDER_AUTH_REF: 'message-global-m2a-staging-on',
    BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF: 'refs-agents-claude-ack',
    BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF: 'refs-agents-gpt-spec',
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    version: 7,
    enabled: false,
    killSwitch: false,
    subjectCount: 0,
    enabledSubjectCount: 0,
    updatedBy: 'system:migration',
    targetExists: false,
    targetEnabled: false,
    targetActor: null,
    legacyV1: {
      version: 4,
      enabled: false,
      killSwitch: false,
      subjectCount: 0,
      enabledSubjectCount: 0,
      updatedBy: 'system:migration',
    },
    ...overrides,
  };
}

function runM2A3StagingPreviewFlagCommand(command, currentEnvironment, dependencies = {}) {
  return runM2A3StagingPreviewFlagCommandRaw(command, currentEnvironment, {
    parseDatabaseEnvironment: (value) => ({ directUrl: value.DIRECT_URL }),
    certifyDatabase: () => undefined,
    ...dependencies,
  });
}

test('parse une autorisation doublement tracée et refuse toute cible ambiguë', () => {
  const parsed = parseM2A3StagingPreviewFlagEnvironment(environment());
  assert.equal(parsed.actor, ACTOR);
  assert.equal(parsed.releaseSha, SHA);
  assert.match(parsed.reason, /M2-A-3 staging preview/u);
  assert.match(parsed.reason, /autorisé=2026-07-31/u);
  assert.match(parsed.reason, /initiateur=limameghassene/u);
  assert.match(parsed.reason, /attempt=2/u);
  assert.match(parsed.reason, /Claude=refs-agents-claude-ack/u);
  assert.equal(parsed.reason.includes('secret'), false);
  const safety = parseM2A3StagingPreviewFlagEnvironment(
    environment({
      BOB_M2A3_STAGING_FOUNDER_AUTH_DATE: '',
      BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL: '',
      BOB_M2A3_STAGING_FOUNDER_AUTH_REF: '',
      BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF: '',
      BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF: '',
    }),
    'deactivate',
  );
  assert.match(safety.reason, /initiateur=limameghassene/u);
  assert.doesNotMatch(safety.reason, /autorisé=/u);

  assert.throws(
    () =>
      parseM2A3StagingPreviewFlagEnvironment(
        environment({
          DIRECT_URL: 'postgresql://bob_app:secret@db.example.test:5432/postgres',
        }),
      ),
    /privileged migration role/u,
  );
  assert.throws(
    () =>
      parseM2A3StagingPreviewFlagEnvironment(
        environment({
          BOB_M2A3_STAGING_RELEASE_SHA: 'main',
        }),
      ),
    /exact SHA/u,
  );
  assert.throws(
    () =>
      parseM2A3StagingPreviewFlagEnvironment(
        environment({
          BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF: '',
        }),
      ),
    /CLAUDE_COUNTERSIGN_REF/u,
  );
});

test('décode un état borné et refuse ses contradictions', () => {
  assert.deepEqual(decodeM2A3StagingPreviewFlagState(JSON.stringify(state())), state());
  assert.throws(
    () => decodeM2A3StagingPreviewFlagState(state({ enabledSubjectCount: 2, subjectCount: 1 })),
    /contradictory/u,
  );
  assert.throws(
    () => decodeM2A3StagingPreviewFlagState(state({ version: 0 })),
    /invalid flag state/u,
  );
});

test('les assertions imposent global pur, kill switch clair et propriété opérateur', () => {
  assert.doesNotThrow(() => assertM2A3StagingPreviewFlagOff(state()));
  assert.doesNotThrow(() =>
    assertM2A3StagingPreviewFlagActive(
      state({
        enabled: true,
        updatedBy: ACTOR,
      }),
    ),
  );
  assert.doesNotThrow(() =>
    assertM2A3StagingPreviewCanary(
      state({
        updatedBy: ACTOR,
        subjectCount: 1,
        enabledSubjectCount: 1,
        targetExists: true,
        targetEnabled: true,
        targetActor: ACTOR,
      }),
    ),
  );
  assert.throws(
    () => assertM2A3StagingPreviewFlagActive(state({ enabled: true, updatedBy: 'foreign' })),
    /owned by another operator/u,
  );
  assert.throws(
    () => assertM2A3StagingPreviewFlagOff(state({ subjectCount: 1 })),
    /residual subject override/u,
  );
  assert.throws(() => assertM2A3StagingPreviewFlagOff(state({ killSwitch: true })), /kill switch/u);
  assert.throws(
    () =>
      assertM2A3StagingPreviewFlagOff(state({ legacyV1: { ...state().legacyV1, enabled: true } })),
    /legacy V1 staging protocol/u,
  );
  assert.throws(
    () =>
      assertM2A3StagingPreviewFlagOff(
        state({ legacyV1: { ...state().legacyV1, subjectCount: 1 } }),
      ),
    /legacy V1 staging protocol/u,
  );
});

test('borne la lecture PostgreSQL dans une transaction et sur le snapshot certifié', () => {
  const calls = [];
  const result = runM2A3StagingPreviewFlagCommandRaw('assert-off', environment(), {
    parseDatabaseEnvironment: (value) => ({ directUrl: value.DIRECT_URL }),
    certifyDatabase: () => undefined,
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: `${JSON.stringify(state())}\n`, stderr: '' };
    },
  });
  assert.equal(result.state, 'off');
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.input, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;/u);
  assert.match(calls[0].options.input, /SET LOCAL lock_timeout = '3s';/u);
  assert.match(calls[0].options.input, /SET LOCAL statement_timeout = '15s';/u);
  assert.match(calls[0].options.input, /ROLLBACK;/u);
  assert.match(calls[0].options.input, /bob\.agent_missions\.quote\.v1/u);
  assert.equal(calls[0].options.timeout, 45_000);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
  assert.equal(calls[0].options.env.PGCONNECT_TIMEOUT, '10');
});

test('certifie Supabase staging dans la commande avant toute lecture ou mutation', () => {
  let databaseReads = 0;
  let mutations = 0;
  assert.throws(
    () =>
      runM2A3StagingPreviewFlagCommandRaw('activate', environment(), {
        parseDatabaseEnvironment: (value) => ({ directUrl: value.DIRECT_URL }),
        certifyDatabase: () => {
          throw new Error('foreign database identity');
        },
        readState: () => {
          databaseReads += 1;
          return state();
        },
        runOperation: () => {
          mutations += 1;
        },
      }),
    /foreign database identity/u,
  );
  assert.equal(databaseReads, 0);
  assert.equal(mutations, 0);
});

test('active globalement par CAS audité et vérifie le résultat durable exact', () => {
  const calls = [];
  const states = [state(), state({ version: 8, enabled: true, updatedBy: ACTOR })];
  const result = runM2A3StagingPreviewFlagCommand('activate', environment(), {
    readState: () => states.shift(),
    runOperation(input, dependencies) {
      calls.push({ input, dependencies });
    },
  });
  assert.deepEqual(result, {
    command: 'activate',
    state: 'active',
    version: 8,
    changed: true,
    acknowledgement: 'received',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    operation: 'set-global',
    key: 'bob.agent_missions.quote.m2a',
    environment: 'staging',
    enabled: 'true',
    actor: ACTOR,
    reason: `${parseM2A3StagingPreviewFlagEnvironment(environment()).reason}; action=activate`,
    expectedVersion: 7,
  });
  assert.equal(calls[0].dependencies.directUrl, environment().DIRECT_URL);
});

test('refuse avant mutation toute activation avec override résiduel', () => {
  let mutationCount = 0;
  assert.throws(
    () =>
      runM2A3StagingPreviewFlagCommand('activate', environment(), {
        readState: () =>
          state({
            subjectCount: 1,
            enabledSubjectCount: 1,
            targetExists: true,
            targetEnabled: true,
            targetActor: ACTOR,
          }),
        runOperation() {
          mutationCount += 1;
        },
      }),
    /residual subject override/u,
  );
  assert.equal(mutationCount, 0);
});

test('borne le canary au seul compte staging puis retire son override avant le global ON', () => {
  const canary = state({
    version: 8,
    updatedBy: ACTOR,
    subjectCount: 1,
    enabledSubjectCount: 1,
    targetExists: true,
    targetEnabled: true,
    targetActor: ACTOR,
  });
  const enableCalls = [];
  const enableStates = [state(), canary];
  const enabled = runM2A3StagingPreviewFlagCommand('enable-canary', environment(), {
    readState: () => enableStates.shift(),
    runOperation(input) {
      enableCalls.push(input);
    },
  });
  assert.equal(enabled.state, 'canary');
  assert.equal(enableCalls[0].operation, 'set-subject');
  assert.equal(enableCalls[0].subjectId, USER_ID);
  assert.equal(enableCalls[0].expectedVersion, 7);

  const disableCalls = [];
  const disableStates = [canary, state({ version: 9, updatedBy: ACTOR })];
  const disabled = runM2A3StagingPreviewFlagCommand('disable-canary', environment(), {
    readState: () => disableStates.shift(),
    runOperation(input) {
      disableCalls.push(input);
    },
  });
  assert.equal(disabled.state, 'off');
  assert.equal(disableCalls[0].operation, 'remove-subject');
  assert.equal(disableCalls[0].expectedVersion, 8);
});

test('canary idempotent refuse tout second sujet et récupère un ACK perdu', () => {
  const canary = state({
    version: 8,
    updatedBy: ACTOR,
    subjectCount: 1,
    enabledSubjectCount: 1,
    targetExists: true,
    targetEnabled: true,
    targetActor: ACTOR,
  });
  assert.deepEqual(
    runM2A3StagingPreviewFlagCommand('enable-canary', environment(), {
      readState: () => canary,
    }),
    { command: 'enable-canary', state: 'canary', version: 8, changed: false },
  );

  assert.throws(
    () =>
      runM2A3StagingPreviewFlagCommand('enable-canary', environment(), {
        readState: () => state({ subjectCount: 1, enabledSubjectCount: 1 }),
      }),
    /residual subject override/u,
  );

  const states = [state(), canary];
  const recovered = runM2A3StagingPreviewFlagCommand('enable-canary', environment(), {
    readState: () => states.shift(),
    runOperation() {
      throw new Error('response lost after commit');
    },
  });
  assert.equal(recovered.acknowledgement, 'recovered');
});

test('récupère un ACK perdu seulement lorsque la mutation durable exacte est prouvée', () => {
  const states = [state(), state({ version: 8, enabled: true, updatedBy: ACTOR })];
  const result = runM2A3StagingPreviewFlagCommand('activate', environment(), {
    readState: () => states.shift(),
    runOperation() {
      throw new Error('network acknowledgement lost');
    },
  });
  assert.equal(result.acknowledgement, 'recovered');

  const drifted = [state(), state({ version: 9, enabled: true, updatedBy: ACTOR })];
  assert.throws(
    () =>
      runM2A3StagingPreviewFlagCommand('activate', environment(), {
        readState: () => drifted.shift(),
        runOperation() {},
      }),
    /transition was not applied exactly/u,
  );
});

test('un retry actif est idempotent, mais ne reprend jamais un flag étranger', () => {
  const active = state({ enabled: true, updatedBy: ACTOR });
  assert.deepEqual(
    runM2A3StagingPreviewFlagCommand('activate', environment(), {
      readState: () => active,
      runOperation() {
        throw new Error('must not mutate');
      },
    }),
    { command: 'activate', state: 'active', version: 7, changed: false },
  );
  assert.throws(
    () =>
      runM2A3StagingPreviewFlagCommand('activate', environment(), {
        readState: () => state({ enabled: true, updatedBy: 'system:foreign' }),
      }),
    /owned by another operator/u,
  );
});

test('désactive DB-first par CAS et reste idempotent une fois OFF', () => {
  const calls = [];
  const states = [
    state({ enabled: true, updatedBy: ACTOR }),
    state({ version: 8, updatedBy: ACTOR }),
  ];
  const result = runM2A3StagingPreviewFlagCommand('deactivate', environment(), {
    readState: () => states.shift(),
    runOperation(input) {
      calls.push(input);
    },
  });
  assert.equal(result.state, 'off');
  assert.equal(result.changed, true);
  assert.equal(calls[0].enabled, 'false');
  assert.equal(calls[0].expectedVersion, 7);

  assert.deepEqual(
    runM2A3StagingPreviewFlagCommand('deactivate', environment(), {
      readState: () => state(),
    }),
    { command: 'deactivate', state: 'off', version: 7, changed: false },
  );
});

test('la coupure d’urgence bloque V2 et V1 même avec global et sujets étrangers', () => {
  const legacyActive = {
    ...state().legacyV1,
    enabled: true,
    subjectCount: 2,
    enabledSubjectCount: 1,
    updatedBy: 'system:foreign',
  };
  const before = state({
    enabled: true,
    updatedBy: 'system:foreign',
    subjectCount: 2,
    enabledSubjectCount: 1,
    legacyV1: legacyActive,
  });
  const after = state({
    ...before,
    version: 8,
    killSwitch: true,
    updatedBy: ACTOR,
    legacyV1: {
      ...legacyActive,
      version: 5,
      killSwitch: true,
      updatedBy: ACTOR,
    },
  });
  const calls = [];
  const states = [before, after];
  const result = runM2A3StagingPreviewFlagCommand(
    'emergency-kill',
    environment({
      BOB_M2A3_STAGING_FOUNDER_AUTH_DATE: '',
      BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL: '',
      BOB_M2A3_STAGING_FOUNDER_AUTH_REF: '',
      BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF: '',
      BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF: '',
    }),
    {
      readState: () => states.shift(),
      runOperation(input) {
        calls.push(input);
      },
    },
  );
  assert.deepEqual(result, {
    command: 'emergency-kill',
    state: 'safe',
    version: 8,
    legacyV1Version: 5,
    changed: true,
    acknowledgement: 'received',
  });
  assert.deepEqual(
    calls.map((call) => [call.key, call.operation, call.enabled, call.expectedVersion]),
    [
      ['bob.agent_missions.quote.m2a', 'set-kill-switch', 'true', 7],
      ['bob.agent_missions.quote.v1', 'set-kill-switch', 'true', 4],
    ],
  );
  assert.doesNotThrow(() => assertM2A3StagingPreviewEffectiveSafe(after));
});

test('la coupure d’urgence récupère les ACK perdus mais ne déclare jamais OFF', () => {
  const before = state({ enabled: true, updatedBy: ACTOR });
  const after = state({
    ...before,
    version: 8,
    killSwitch: true,
    legacyV1: {
      ...before.legacyV1,
      version: 5,
      killSwitch: true,
      updatedBy: ACTOR,
    },
  });
  const states = [before, after];
  const result = runM2A3StagingPreviewFlagCommand('emergency-kill', environment(), {
    readState: () => states.shift(),
    runOperation() {
      throw new Error('ack lost');
    },
  });
  assert.equal(result.state, 'safe');
  assert.equal(result.acknowledgement, 'recovered');
  assert.notEqual(result.state, 'off');

  assert.deepEqual(
    runM2A3StagingPreviewFlagCommand('assert-effective-safe', environment(), {
      readState: () => after,
    }),
    {
      command: 'assert-effective-safe',
      state: 'safe',
      version: 8,
      legacyV1Version: 5,
      changed: false,
      observed: {
        m2a: {
          version: 8,
          enabled: true,
          killSwitch: true,
          subjectCount: 0,
          enabledSubjectCount: 0,
        },
        legacyV1: {
          version: 5,
          enabled: false,
          killSwitch: true,
          subjectCount: 0,
          enabledSubjectCount: 0,
        },
      },
    },
  );
});

test('la coupure d’urgence converge si V1 échoue avant commit au premier passage', () => {
  const before = state({ enabled: true, updatedBy: 'system:foreign' });
  const m2aOnly = state({
    ...before,
    version: 8,
    killSwitch: true,
    updatedBy: ACTOR,
  });
  const safe = state({
    ...m2aOnly,
    legacyV1: {
      ...before.legacyV1,
      version: 5,
      killSwitch: true,
      updatedBy: ACTOR,
    },
  });
  const states = [before, m2aOnly, safe];
  const calls = [];
  const result = runM2A3StagingPreviewFlagCommand('emergency-kill', environment(), {
    readState: () => states.shift(),
    runOperation(input) {
      calls.push(input);
      if (calls.length === 2) throw new Error('V1 failed before commit');
    },
  });
  assert.deepEqual(
    calls.map((call) => [call.key, call.expectedVersion]),
    [
      ['bob.agent_missions.quote.m2a', 7],
      ['bob.agent_missions.quote.v1', 4],
      ['bob.agent_missions.quote.v1', 4],
    ],
  );
  assert.equal(result.state, 'safe');
  assert.equal(result.acknowledgement, 'recovered');
  assert.equal(result.legacyV1Version, 5);
});

test('la coupure d’urgence récupère une lecture perdue après les deux commits', () => {
  const before = state({ enabled: true, updatedBy: 'system:foreign' });
  const safe = state({
    ...before,
    version: 8,
    killSwitch: true,
    updatedBy: ACTOR,
    legacyV1: {
      ...before.legacyV1,
      version: 5,
      killSwitch: true,
      updatedBy: ACTOR,
    },
  });
  let reads = 0;
  const calls = [];
  const result = runM2A3StagingPreviewFlagCommand('emergency-kill', environment(), {
    readState() {
      reads += 1;
      if (reads === 1) return before;
      if (reads === 2) throw new Error('read response lost after commit');
      return safe;
    },
    runOperation(input) {
      calls.push(input);
      if (calls.length > 2) throw new Error('stale CAS after the first committed attempt');
    },
  });
  assert.equal(result.state, 'safe');
  assert.equal(result.acknowledgement, 'recovered');
  assert.equal(reads, 3);
  assert.deepEqual(
    calls.map((call) => [call.key, call.expectedVersion]),
    [
      ['bob.agent_missions.quote.m2a', 7],
      ['bob.agent_missions.quote.v1', 4],
      ['bob.agent_missions.quote.m2a', 7],
      ['bob.agent_missions.quote.v1', 4],
    ],
  );
});

test('la coupure d’urgence ne déclare jamais safe sans les deux kill switches', () => {
  const unchanged = state({ enabled: true, updatedBy: 'system:foreign' });
  assert.throws(
    () =>
      runM2A3StagingPreviewFlagCommand('emergency-kill', environment(), {
        readState: () => unchanged,
        runOperation() {
          throw new Error('mutation unavailable');
        },
      }),
    /did not converge after 3 attempts/u,
  );
});
