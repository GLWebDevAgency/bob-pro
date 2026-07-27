import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  M1B_STAGING_KEY_BOOTSTRAP_STATE_SQL,
  M1B_STAGING_KEY_STATE_SQL,
  assertM1BStagingKeyState,
  certifyM1BStagingKeyState,
  decodeM1BStagingKeyBootstrapSnapshot,
  decodeM1BStagingKeyMigrationState,
  decodeM1BStagingKeyPrerequisiteRows,
  decodeM1BStagingKeyRows,
  parseM1BStagingKeyStateEnvironment,
} from './agent-mission-m1b-staging-key-state.mjs';

const FIRST = Buffer.alloc(32, 21).toString('base64url');
const SECOND = Buffer.alloc(32, 22).toString('base64url');
const DOMAIN = Buffer.from('bob.agent-mission.fingerprint-hmac-key.v1\0', 'utf8');

function fingerprint(secret) {
  return createHash('sha256').update(DOMAIN).update(Buffer.from(secret, 'base64url')).digest('hex');
}

function environment(overrides = {}) {
  return {
    DIRECT_URL: 'postgresql://postgres.staging:secret@db.example.test/postgres',
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_PROVIDER: 'openai',
    BOB_M1B_STAGING_HMAC_KEY_VERSION: '1',
    BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({ 1: FIRST }),
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    keyVersion: 1,
    keyFingerprint: fingerprint(FIRST),
    retained: false,
    minimumWriterVersion: 1,
    highestWriterVersion: 1,
    writerEnabled: false,
    ...overrides,
  };
}

function keyMigrationState(overrides = {}) {
  return {
    migrationApplied: false,
    missionExpandMigrationApplied: false,
    missionValidateMigrationApplied: false,
    missionTablePresent: false,
    eventTablePresent: false,
    floorTablePresent: false,
    bindingTablePresent: false,
    floorGuardFunctionPresent: false,
    bindingGuardFunctionPresent: false,
    bindingPresentGuardFunctionPresent: false,
    readinessFunctionPresent: false,
    ...overrides,
  };
}

function appliedMissionPrerequisiteState(overrides = {}) {
  return keyMigrationState({
    missionExpandMigrationApplied: true,
    missionValidateMigrationApplied: true,
    missionTablePresent: true,
    eventTablePresent: true,
    ...overrides,
  });
}

function appliedKeyMigrationState() {
  return appliedMissionPrerequisiteState({
    migrationApplied: true,
    floorTablePresent: true,
    bindingTablePresent: true,
    floorGuardFunctionPresent: true,
    bindingGuardFunctionPresent: true,
    bindingPresentGuardFunctionPresent: true,
    readinessFunctionPresent: true,
  });
}

test('résout le keyring staging stable et refuse un saut ou une troisième version', () => {
  const parsed = parseM1BStagingKeyStateEnvironment(environment());
  assert.equal(parsed.currentVersion, 1);
  assert.equal(parsed.bindings[0].fingerprint, fingerprint(FIRST));
  assert.throws(
    () =>
      parseM1BStagingKeyStateEnvironment(
        environment({
          BOB_M1B_STAGING_HMAC_KEY_VERSION: '3',
          BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({
            1: FIRST,
            2: SECOND,
            3: Buffer.alloc(32, 23).toString('base64url'),
          }),
        }),
      ),
    /only the current version and optional predecessor/u,
  );
});

test('bootstrap accepte uniquement un schéma absent avec keyring initial ou un floor OFF prouvé', () => {
  assert.deepEqual(decodeM1BStagingKeyMigrationState(keyMigrationState()), keyMigrationState());
  assert.throws(
    () =>
      decodeM1BStagingKeyMigrationState({
        ...keyMigrationState(),
        extra: true,
      }),
    /invalid key migration state/u,
  );
  let readinessReads = 0;
  const absent = certifyM1BStagingKeyState('bootstrap', environment(), {
    readMigrationState: () => keyMigrationState(),
    readRows: () => {
      readinessReads += 1;
      throw new Error('readiness must remain unread before migration');
    },
  });
  assert.deepEqual(absent, {
    mode: 'bootstrap',
    passed: true,
    keyVersion: 1,
    writerEnabled: null,
    pristine: true,
  });
  assert.equal(readinessReads, 0);

  const migrated = certifyM1BStagingKeyState('bootstrap', environment(), {
    readMigrationState: () => appliedKeyMigrationState(),
    readRows: () => {
      readinessReads += 1;
      return [row()];
    },
  });
  assert.deepEqual(migrated, {
    mode: 'bootstrap',
    passed: true,
    keyVersion: 1,
    writerEnabled: false,
    pristine: false,
  });
  assert.equal(readinessReads, 1);

  let prerequisiteReads = 0;
  const appliedM1A = certifyM1BStagingKeyState('bootstrap', environment(), {
    readMigrationState: () => appliedMissionPrerequisiteState(),
    readPrerequisiteRows: () => {
      prerequisiteReads += 1;
      return {
        missionRowsPresent: false,
        eventRowsPresent: false,
      };
    },
    readRows: () => {
      throw new Error('readiness must remain unread before its migration');
    },
  });
  assert.deepEqual(appliedM1A, {
    mode: 'bootstrap',
    passed: true,
    keyVersion: 1,
    writerEnabled: null,
    pristine: true,
  });
  assert.equal(prerequisiteReads, 1);

  for (const retained of ['missionRowsPresent', 'eventRowsPresent']) {
    assert.throws(
      () =>
        certifyM1BStagingKeyState('bootstrap', environment(), {
          readMigrationState: () => appliedMissionPrerequisiteState(),
          readPrerequisiteRows: () => ({
            missionRowsPresent: false,
            eventRowsPresent: false,
            [retained]: true,
          }),
        }),
      /retained mission data/u,
      `bootstrap must reject retained prerequisite data ${retained}`,
    );
  }

  assert.throws(
    () =>
      certifyM1BStagingKeyState(
        'bootstrap',
        environment({
          BOB_M1B_STAGING_HMAC_KEY_VERSION: '2',
          BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({
            1: FIRST,
            2: SECOND,
          }),
        }),
        { readMigrationState: () => keyMigrationState() },
      ),
    /unmigrated keyspace/u,
  );
  for (const artifact of [
    'floorTablePresent',
    'bindingTablePresent',
    'floorGuardFunctionPresent',
    'bindingGuardFunctionPresent',
    'bindingPresentGuardFunctionPresent',
    'readinessFunctionPresent',
  ]) {
    assert.throws(
      () =>
        certifyM1BStagingKeyState('bootstrap', environment(), {
          readMigrationState: () =>
            keyMigrationState({
              [artifact]: true,
            }),
        }),
      /partial readiness artifacts/u,
      `bootstrap must reject partial artifact ${artifact}`,
    );
  }
  for (const contradictory of [
    keyMigrationState({ missionExpandMigrationApplied: true }),
    keyMigrationState({ missionValidateMigrationApplied: true }),
    keyMigrationState({ missionTablePresent: true }),
    keyMigrationState({ eventTablePresent: true }),
    keyMigrationState({
      missionExpandMigrationApplied: true,
      missionValidateMigrationApplied: true,
    }),
    keyMigrationState({
      missionTablePresent: true,
      eventTablePresent: true,
    }),
  ]) {
    assert.throws(
      () =>
        certifyM1BStagingKeyState('bootstrap', environment(), {
          readMigrationState: () => contradictory,
        }),
      /prerequisite schema is partial or contradictory/u,
    );
  }
  assert.throws(
    () =>
      certifyM1BStagingKeyState('bootstrap', environment(), {
        readMigrationState: () =>
          appliedMissionPrerequisiteState({
            migrationApplied: true,
          }),
      }),
    /applied key migration schema is incomplete/u,
  );
  assert.match(
    M1B_STAGING_KEY_BOOTSTRAP_STATE_SQL,
    /20260726110000_agent_mission_fingerprint_key_readiness/u,
  );
  assert.match(M1B_STAGING_KEY_BOOTSTRAP_STATE_SQL, /20260726010000_agent_missions_expand/u);
  assert.match(M1B_STAGING_KEY_BOOTSTRAP_STATE_SQL, /20260726020000_agent_missions_validate/u);
  for (const objectName of [
    'agent_missions',
    'agent_mission_events',
    'agent_mission_fingerprint_key_version_floors',
    'agent_mission_fingerprint_key_bindings',
    'guard_agent_mission_fingerprint_key_floor_v1',
    'guard_agent_mission_fingerprint_key_binding_immutable_v1',
    'guard_agent_mission_fingerprint_key_binding_present_v1',
    'agent_mission_fingerprint_key_readiness',
  ]) {
    assert.match(M1B_STAGING_KEY_BOOTSTRAP_STATE_SQL, new RegExp(objectName, 'u'));
  }
  assert.deepEqual(
    decodeM1BStagingKeyPrerequisiteRows({
      missionRowsPresent: false,
      eventRowsPresent: false,
    }),
    {
      missionRowsPresent: false,
      eventRowsPresent: false,
    },
  );
  assert.throws(
    () =>
      decodeM1BStagingKeyPrerequisiteRows({
        missionRowsPresent: false,
        eventRowsPresent: false,
        extra: false,
      }),
    /invalid prerequisite row state/u,
  );
  assert.deepEqual(
    decodeM1BStagingKeyBootstrapSnapshot({
      migrationState: appliedMissionPrerequisiteState(),
      prerequisiteRows: {
        missionRowsPresent: false,
        eventRowsPresent: false,
      },
    }),
    {
      migrationState: appliedMissionPrerequisiteState(),
      prerequisiteRows: {
        missionRowsPresent: false,
        eventRowsPresent: false,
      },
    },
  );
  assert.throws(
    () =>
      decodeM1BStagingKeyBootstrapSnapshot({
        migrationState: keyMigrationState(),
        prerequisiteRows: {
          missionRowsPresent: false,
          eventRowsPresent: false,
        },
        extra: true,
      }),
    /invalid bootstrap snapshot/u,
  );
});

test('bootstrap réel ne consulte que la migration tant que le keyspace est absent', () => {
  const calls = [];
  const result = certifyM1BStagingKeyState('bootstrap', environment(), {
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: `${JSON.stringify({
          migrationState: keyMigrationState(),
          prerequisiteRows: {
            missionRowsPresent: false,
            eventRowsPresent: false,
          },
        })}\n`,
        stderr: '',
      };
    },
  });
  assert.equal(result.pristine, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'psql');
  assert.equal(calls[0].options.input, M1B_STAGING_KEY_BOOTSTRAP_STATE_SQL);
  assert.equal(calls[0].options.input.includes(FIRST), false);
});

test('bootstrap réel prouve topologie et tables vides dans un snapshot unique', () => {
  const calls = [];
  const result = certifyM1BStagingKeyState('bootstrap', environment(), {
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: `${JSON.stringify({
          migrationState: appliedMissionPrerequisiteState(),
          prerequisiteRows: {
            missionRowsPresent: false,
            eventRowsPresent: false,
          },
        })}\n`,
        stderr: '',
      };
    },
  });
  assert.equal(result.pristine, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls.every(({ command }) => command === 'psql'),
    true,
  );
  assert.equal(calls[0].options.input, M1B_STAGING_KEY_BOOTSTRAP_STATE_SQL);
  assert.match(calls[0].options.input, /ISOLATION LEVEL REPEATABLE READ/u);
  assert.match(calls[0].options.input, /SET LOCAL row_security = off/u);
  assert.equal(calls[0].options.input.includes(FIRST), false);
});

test('préflight autorise seulement un keyspace vierge version 1 ou un floor désarmé exact', () => {
  const config = parseM1BStagingKeyStateEnvironment(environment());
  const pristine = decodeM1BStagingKeyRows([
    row({
      keyFingerprint: null,
      minimumWriterVersion: null,
      highestWriterVersion: null,
      writerEnabled: null,
    }),
  ]);
  assert.deepEqual(assertM1BStagingKeyState('preflight', pristine, config), {
    mode: 'preflight',
    passed: true,
    keyVersion: 1,
    writerEnabled: null,
    pristine: true,
  });
  assert.deepEqual(assertM1BStagingKeyState('preflight', [row()], config), {
    mode: 'preflight',
    passed: true,
    keyVersion: 1,
    writerEnabled: false,
    pristine: false,
  });
  assert.throws(
    () =>
      assertM1BStagingKeyState(
        'preflight',
        [
          row({
            writerEnabled: true,
          }),
        ],
        config,
      ),
    /writer fence is not disabled/u,
  );
});

test('état actif/off exige le même binding et interdit tout floor de rotation', () => {
  const config = parseM1BStagingKeyStateEnvironment(environment());
  assert.deepEqual(assertM1BStagingKeyState('active', [row({ writerEnabled: true })], config), {
    mode: 'active',
    passed: true,
    keyVersion: 1,
    writerEnabled: true,
    pristine: false,
  });
  assert.deepEqual(assertM1BStagingKeyState('off', [row()], config), {
    mode: 'off',
    passed: true,
    keyVersion: 1,
    writerEnabled: false,
    pristine: false,
  });
  assert.throws(
    () =>
      assertM1BStagingKeyState(
        'active',
        [
          row({
            minimumWriterVersion: 1,
            highestWriterVersion: 2,
            writerEnabled: true,
          }),
        ],
        config,
      ),
    /refuses every key rotation/u,
  );
  assert.throws(
    () =>
      assertM1BStagingKeyState(
        'off',
        [
          row({
            keyFingerprint: fingerprint(SECOND),
          }),
        ],
        config,
      ),
    /does not match/u,
  );
});

test('une version N peut conserver uniquement son prédécesseur retenu et couvert', () => {
  const config = parseM1BStagingKeyStateEnvironment(
    environment({
      BOB_M1B_STAGING_HMAC_KEY_VERSION: '2',
      BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({ 1: FIRST, 2: SECOND }),
    }),
  );
  const rows = decodeM1BStagingKeyRows([
    row({
      retained: true,
      minimumWriterVersion: 2,
      highestWriterVersion: 2,
    }),
    row({
      keyVersion: 2,
      keyFingerprint: fingerprint(SECOND),
      minimumWriterVersion: 2,
      highestWriterVersion: 2,
    }),
  ]);
  assert.equal(assertM1BStagingKeyState('off', rows, config).keyVersion, 2);
  assert.throws(
    () =>
      assertM1BStagingKeyState(
        'off',
        [
          ...rows,
          row({
            keyVersion: 3,
            keyFingerprint: null,
            retained: true,
            minimumWriterVersion: 2,
            highestWriterVersion: 2,
          }),
        ],
        config,
      ),
    /does not cover every retained/u,
  );
});

test('certification utilise la fonction readiness sous rôle dédié sans exposer le secret', () => {
  const calls = [];
  const result = certifyM1BStagingKeyState('off', environment(), {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: `${JSON.stringify([row()])}\n`,
        stderr: '',
      };
    },
  });
  assert.equal(result.passed, true);
  assert.equal(calls[0].command, 'psql');
  assert.equal(calls[0].options.input, M1B_STAGING_KEY_STATE_SQL);
  assert.equal(calls[0].options.input.includes(FIRST), false);
  assert.equal(calls[0].args.includes('versions_csv=1'), true);
});
