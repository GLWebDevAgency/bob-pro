import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M1B_STAGING_FLAG_BOOTSTRAP_STATE_SQL,
  assertM1BStagingFlagActive,
  assertM1BStagingFlagBootstrapPreflight,
  assertM1BStagingFlagOff,
  assertM1BStagingFlagPreflight,
  decodeM1BStagingFlagBootstrapState,
  decodeM1BStagingFlagState,
  parseM1BStagingFlagEnvironment,
  runM1BStagingFlagCommand,
} from './agent-mission-m1b-staging-flag.mjs';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '123456789:1';
const ACTOR = `system:github:agent-mission-m1b-staging:${RUN_ID}`;

function environment(overrides = {}) {
  return {
    DIRECT_URL: 'postgresql://postgres.staging:secret@db.example.test/postgres',
    BOB_M1B_STAGING_USER_ID: USER_ID,
    BOB_M1B_STAGING_RUN_ID: RUN_ID,
    BOB_M1B_STAGING_FOUNDER_AUTH_DATE: '2026-07-27',
    BOB_M1B_STAGING_FOUNDER_AUTH_CHANNEL: 'conversation-fondateur',
    BOB_M1B_STAGING_FOUNDER_AUTH_REF: 'message-2026-07-27-m1b',
    BOB_M1B_STAGING_CLAUDE_COUNTERSIGN_REF: 'claude-review-ref',
    BOB_M1B_STAGING_GPT_COUNTERSIGN_REF: 'gpt-review-ref',
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
    targetExists: false,
    targetEnabled: false,
    targetActor: null,
    ...overrides,
  };
}

test('exige une identité interne et des traces de gouvernance explicites', () => {
  const parsed = parseM1BStagingFlagEnvironment(environment());
  assert.equal(parsed.userId, USER_ID);
  assert.match(parsed.reason, /2026-07-27/u);
  assert.match(parsed.reason, /Claude=claude-review-ref/u);
  assert.match(parsed.reason, /GPT=gpt-review-ref/u);
  assert.equal(parsed.actor, ACTOR);

  assert.throws(
    () =>
      parseM1BStagingFlagEnvironment(
        environment({
          BOB_M1B_STAGING_USER_ID: 'user-staging',
        }),
      ),
    /must be a UUID/u,
  );
  assert.throws(
    () =>
      parseM1BStagingFlagEnvironment(
        environment({
          BOB_M1B_STAGING_FOUNDER_AUTH_DATE: '2026-02-30',
        }),
      ),
    /calendar date/u,
  );
  assert.throws(
    () =>
      parseM1BStagingFlagEnvironment(
        environment({
          BOB_M1B_STAGING_CLAUDE_COUNTERSIGN_REF: '',
        }),
      ),
    /CLAUDE_COUNTERSIGN_REF/u,
  );
  assert.throws(
    () =>
      parseM1BStagingFlagEnvironment(
        environment({
          BOB_M1B_STAGING_RUN_ID: 'local-run',
        }),
      ),
    /github\.run_id/u,
  );
});

test('parse un état DB unique et refuse les états contradictoires', () => {
  assert.deepEqual(decodeM1BStagingFlagState(JSON.stringify(state())), state());
  assert.throws(
    () =>
      decodeM1BStagingFlagState(
        JSON.stringify(
          state({
            targetEnabled: true,
            targetExists: false,
          }),
        ),
      ),
    /contradictory/u,
  );
  assert.throws(
    () =>
      decodeM1BStagingFlagState(
        JSON.stringify(
          state({
            targetActor: ACTOR,
          }),
        ),
      ),
    /contradictory/u,
  );
  assert.throws(() => decodeM1BStagingFlagState('null'), /invalid flag state/u);
});

test('bootstrap distingue strictement staging N-1 et migration canonique terminée', () => {
  const unmigrated = decodeM1BStagingFlagBootstrapState({
    migrationApplied: false,
    flagCount: 0,
  });
  assert.deepEqual(assertM1BStagingFlagBootstrapPreflight(unmigrated), {
    state: 'absent',
    version: 0,
  });
  assert.deepEqual(
    assertM1BStagingFlagBootstrapPreflight({ migrationApplied: true, flagCount: 1 }, state()),
    { state: 'off', version: 7 },
  );
  assert.throws(
    () =>
      assertM1BStagingFlagBootstrapPreflight({
        migrationApplied: false,
        flagCount: 1,
      }),
    /exists before its migration/u,
  );
  assert.throws(
    () =>
      assertM1BStagingFlagBootstrapPreflight({
        migrationApplied: true,
        flagCount: 0,
      }),
    /absent after its migration/u,
  );
  assert.match(
    M1B_STAGING_FLAG_BOOTSTRAP_STATE_SQL,
    /20260726030000_release_flag_cabinet_subject_revocation_fence/u,
  );
});

test('commande bootstrap ne lit le flag qu’après sa migration et reste sans mutation', () => {
  let reads = 0;
  const absent = runM1BStagingFlagCommand('bootstrap-preflight', environment(), {
    readBootstrapState: () => ({
      migrationApplied: false,
      flagCount: 0,
    }),
    readState: () => {
      reads += 1;
      throw new Error('flag state must remain unread before migration');
    },
    runOperation: () => {
      throw new Error('bootstrap must never mutate');
    },
  });
  assert.deepEqual(absent, {
    command: 'bootstrap-preflight',
    state: 'absent',
    version: 0,
    changed: false,
  });
  assert.equal(reads, 0);

  const migrated = runM1BStagingFlagCommand('bootstrap-preflight', environment(), {
    readBootstrapState: () => ({
      migrationApplied: true,
      flagCount: 1,
    }),
    readState: () => {
      reads += 1;
      return state();
    },
  });
  assert.deepEqual(migrated, {
    command: 'bootstrap-preflight',
    state: 'off',
    version: 7,
    changed: false,
  });
  assert.equal(reads, 1);
});

test('bootstrap réel interroge seulement la migration sans exposer identité ni secret', () => {
  const calls = [];
  const result = runM1BStagingFlagCommand('bootstrap-preflight', environment(), {
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: `${JSON.stringify({
          migrationApplied: false,
          flagCount: 0,
        })}\n`,
        stderr: '',
      };
    },
  });
  assert.equal(result.state, 'absent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'psql');
  assert.equal(calls[0].options.input, M1B_STAGING_FLAG_BOOTSTRAP_STATE_SQL);
  assert.equal(calls[0].options.input.includes(USER_ID), false);
  assert.equal(calls[0].options.input.includes('secret'), false);
});

test('cleanup durable reste sûr avant migration et ne dépend d’aucun output GitHub', () => {
  let stateReads = 0;
  const result = runM1BStagingFlagCommand('cleanup', environment(), {
    readBootstrapState: () => ({
      migrationApplied: false,
      flagCount: 0,
    }),
    readState: () => {
      stateReads += 1;
      throw new Error('flag state must remain unread before migration');
    },
    runOperation: () => {
      throw new Error('cleanup must not mutate an unmigrated staging');
    },
  });
  assert.deepEqual(result, {
    command: 'cleanup',
    state: 'absent',
    version: 0,
    changed: false,
  });
  assert.equal(stateReads, 0);
});

test('cleanup durable relit l’acteur en base et retire son override après perte d’output', () => {
  const before = state({
    version: 11,
    subjectCount: 1,
    enabledSubjectCount: 1,
    targetExists: true,
    targetEnabled: true,
    targetActor: ACTOR,
  });
  const after = state({ version: 12 });
  const mutations = [];
  let reads = 0;
  const result = runM1BStagingFlagCommand('cleanup', environment(), {
    readBootstrapState: () => ({
      migrationApplied: true,
      flagCount: 1,
    }),
    readState: () => (++reads === 1 ? before : after),
    runOperation: (input) => mutations.push(input),
  });
  assert.deepEqual(result, {
    command: 'cleanup',
    state: 'off',
    version: 12,
    changed: true,
  });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].operation, 'remove-subject');
  assert.equal(mutations[0].expectedVersion, 11);
  assert.equal(mutations[0].actor, ACTOR);
});

test('cleanup durable est idempotent mais refuse un override appartenant à un autre run', () => {
  let reads = 0;
  const dependencies = {
    readBootstrapState: () => ({
      migrationApplied: true,
      flagCount: 1,
    }),
    readState: () => {
      reads += 1;
      return state();
    },
    runOperation: () => {
      throw new Error('cleanup must not mutate an absent override');
    },
  };
  assert.deepEqual(runM1BStagingFlagCommand('cleanup', environment(), dependencies), {
    command: 'cleanup',
    state: 'off',
    version: 7,
    changed: false,
  });
  assert.equal(reads, 2);

  assert.throws(
    () =>
      runM1BStagingFlagCommand('cleanup', environment(), {
        readBootstrapState: dependencies.readBootstrapState,
        readState: () =>
          state({
            subjectCount: 1,
            enabledSubjectCount: 1,
            targetExists: true,
            targetEnabled: true,
            targetActor: 'system:github:agent-mission-m1b-staging:987654321:2',
          }),
        runOperation: () => {
          throw new Error('foreign override must not be mutated');
        },
      }),
    /owned by another run/u,
  );
});

test('préflight exige global OFF, kill switch clair, cible absente et aucun autre pilote', () => {
  assert.doesNotThrow(() => assertM1BStagingFlagPreflight(state()));
  assert.throws(() => assertM1BStagingFlagPreflight(state({ enabled: true })), /global.*OFF/u);
  assert.throws(() => assertM1BStagingFlagPreflight(state({ killSwitch: true })), /kill switch/u);
  assert.throws(
    () =>
      assertM1BStagingFlagPreflight(
        state({
          subjectCount: 1,
          enabledSubjectCount: 1,
        }),
      ),
    /another.*override/u,
  );
  assert.throws(
    () =>
      assertM1BStagingFlagPreflight(
        state({
          subjectCount: 1,
          targetExists: true,
        }),
      ),
    /must be absent/u,
  );
});

test('activation utilise le CAS parent et relit exactement le seul override user', () => {
  const before = state();
  const after = state({
    version: 8,
    subjectCount: 1,
    enabledSubjectCount: 1,
    targetExists: true,
    targetEnabled: true,
    targetActor: ACTOR,
  });
  const mutations = [];
  let reads = 0;
  const result = runM1BStagingFlagCommand('enable', environment(), {
    readState: () => (++reads === 1 ? before : after),
    runOperation: (input, dependencies) => mutations.push({ input, dependencies }),
  });
  assert.deepEqual(result, {
    command: 'enable',
    state: 'active',
    version: 8,
    changed: true,
  });
  assert.equal(mutations.length, 1);
  assert.deepEqual(
    {
      operation: mutations[0].input.operation,
      key: mutations[0].input.key,
      environment: mutations[0].input.environment,
      enabled: mutations[0].input.enabled,
      subjectType: mutations[0].input.subjectType,
      subjectId: mutations[0].input.subjectId,
      expectedVersion: mutations[0].input.expectedVersion,
    },
    {
      operation: 'set-subject',
      key: 'bob.agent_missions.quote.v1',
      environment: 'staging',
      enabled: 'true',
      subjectType: 'user',
      subjectId: USER_ID,
      expectedVersion: 7,
    },
  );
  assert.equal(mutations[0].dependencies.directUrl, environment().DIRECT_URL);
  assert.doesNotThrow(() => assertM1BStagingFlagActive(before, after, ACTOR));
});

test('cleanup supprime uniquement la cible avec CAS puis exige zéro override actif', () => {
  const before = state({
    version: 11,
    subjectCount: 1,
    enabledSubjectCount: 1,
    targetExists: true,
    targetEnabled: true,
    targetActor: ACTOR,
  });
  const after = state({ version: 12 });
  const mutations = [];
  let reads = 0;
  const result = runM1BStagingFlagCommand('disable', environment(), {
    readState: () => (++reads === 1 ? before : after),
    runOperation: (input) => mutations.push(input),
  });
  assert.deepEqual(result, {
    command: 'disable',
    state: 'off',
    version: 12,
    changed: true,
  });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].operation, 'remove-subject');
  assert.equal(mutations[0].expectedVersion, 11);
  assert.match(mutations[0].reason, /rollback/u);
  assert.doesNotThrow(() => assertM1BStagingFlagOff(after));
});

test('cleanup est idempotent mais refuse de masquer un autre override actif', () => {
  let reads = 0;
  const result = runM1BStagingFlagCommand('disable', environment(), {
    readState: () => {
      reads += 1;
      return state();
    },
    runOperation: () => {
      throw new Error('mutation should not run');
    },
  });
  assert.deepEqual(result, {
    command: 'disable',
    state: 'off',
    version: 7,
    changed: false,
  });
  assert.equal(reads, 2);

  assert.throws(
    () =>
      runM1BStagingFlagCommand('disable', environment(), {
        readState: () =>
          state({
            subjectCount: 1,
            enabledSubjectCount: 1,
          }),
      }),
    /override remains/u,
  );

  assert.throws(
    () =>
      runM1BStagingFlagCommand('disable', environment(), {
        readState: () =>
          state({
            subjectCount: 1,
            enabledSubjectCount: 1,
            targetExists: true,
            targetEnabled: true,
            targetActor: 'system:github:agent-mission-m1b-staging:987654321:2',
          }),
      }),
    /owned by another run/u,
  );
});
