import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  manageAgentMissionFingerprintKeyVersions,
  parseAgentMissionFingerprintKeyOperation,
} from './manage-agent-mission-fingerprint-key-versions.mjs';

const FIRST = Buffer.alloc(32, 41).toString('base64url');
const SECOND = Buffer.alloc(32, 42).toString('base64url');
const THIRD = Buffer.alloc(32, 43).toString('base64url');
const DOMAIN = Buffer.from('bob.agent-mission.fingerprint-hmac-key.v1\0', 'utf8');
const KEY_SPACE = 'bob-agent-mission-fingerprint-hmac-v1';
const directUrl = 'postgresql://deployer:secret@localhost:5432/bob';

function environment(overrides = {}) {
  return {
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '2',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: FIRST, 2: SECOND }),
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_PROVIDER: 'openai',
    DIRECT_URL: directUrl,
    ...overrides,
  };
}

function expected(secret) {
  return createHash('sha256')
    .update(DOMAIN)
    .update(Buffer.from(secret, 'base64url'))
    .digest('hex');
}

function sqlText(strings) {
  return Array.isArray(strings) ? strings.join('?') : String(strings);
}

function harness({
  bindings = new Map(),
  floor = null,
  retainedVersions = new Set(),
  capacity = { mode: 'closed', usedSessions: 0 },
  readinessOverride,
  failAfterFloorMutation = false,
} = {}) {
  const durable = new Map(bindings);
  let writerFloor = floor === null
    ? null
    : { ...floor, writerEnabled: floor.writerEnabled ?? true };
  const operations = [];
  const prisma = {
    async $transaction(work, options) {
      operations.push({ kind: 'transactionOptions', options });
      const workingBindings = new Map(durable);
      const workingState = {
        floor: writerFloor === null ? null : { ...writerFloor },
      };
      const mutateFloor = (nextFloor) => {
        workingState.floor = nextFloor;
        if (failAfterFloorMutation) throw new Error('injected floor mutation failure');
      };
      const transaction = {
        async $executeRaw(strings, ...values) {
          const sql = sqlText(strings);
          operations.push({ kind: 'execute', sql, values });
          if (sql.includes('agent_mission_fingerprint_key_bindings')) {
            const [version, keyFingerprint] = values;
            if (!workingBindings.has(version)) {
              if (
                [...workingBindings.entries()].some(
                  ([otherVersion, otherFingerprint]) =>
                    otherVersion !== version && otherFingerprint === keyFingerprint,
                )
              ) throw new Error('duplicate key fingerprint');
              workingBindings.set(version, keyFingerprint);
            }
          } else if (
            sql.includes('INSERT INTO public.agent_mission_fingerprint_key_version_floors')
          ) {
            const [
              keySpace,
              minimumWriterVersion,
              highestWriterVersion,
            ] = values;
            assert.equal(keySpace, KEY_SPACE);
            if (workingState.floor !== null) {
              throw new Error('duplicate writer floor');
            }
            mutateFloor({
              minimumWriterVersion,
              highestWriterVersion,
              writerEnabled: true,
            });
          } else if (
            sql.includes('UPDATE public.agent_mission_fingerprint_key_version_floors')
            && sql.includes('SET "writerEnabled" = FALSE')
          ) {
            const [keySpace, minimumWriterVersion, highestWriterVersion] = values;
            assert.equal(keySpace, KEY_SPACE);
            if (
              workingState.floor?.minimumWriterVersion === minimumWriterVersion
              && workingState.floor.highestWriterVersion === highestWriterVersion
              && workingState.floor.writerEnabled
            ) {
              mutateFloor({ ...workingState.floor, writerEnabled: false });
            }
          } else if (
            sql.includes('UPDATE public.agent_mission_fingerprint_key_version_floors')
            && sql.includes('SET "writerEnabled" = TRUE')
          ) {
            const [keySpace, minimumWriterVersion, highestWriterVersion] = values;
            assert.equal(keySpace, KEY_SPACE);
            if (
              workingState.floor?.minimumWriterVersion === minimumWriterVersion
              && workingState.floor.highestWriterVersion === highestWriterVersion
              && !workingState.floor.writerEnabled
            ) {
              mutateFloor({ ...workingState.floor, writerEnabled: true });
            }
          } else if (
            sql.includes('UPDATE public.agent_mission_fingerprint_key_version_floors')
            && sql.includes('SET "highestWriterVersion"')
          ) {
            const [
              highestWriterVersion,
              keySpace,
              minimumWriterVersion,
              previousHighestWriterVersion,
            ] = values;
            assert.equal(keySpace, KEY_SPACE);
            if (
              workingState.floor?.minimumWriterVersion === minimumWriterVersion
              && workingState.floor.highestWriterVersion === previousHighestWriterVersion
            ) {
              mutateFloor({
                ...workingState.floor,
                minimumWriterVersion,
                highestWriterVersion,
              });
            }
          } else if (
            sql.includes('UPDATE public.agent_mission_fingerprint_key_version_floors')
            && sql.includes('SET "minimumWriterVersion"')
          ) {
            const [
              minimumWriterVersion,
              keySpace,
              previousMinimumWriterVersion,
              highestWriterVersion,
            ] = values;
            assert.equal(keySpace, KEY_SPACE);
            if (
              workingState.floor?.minimumWriterVersion === previousMinimumWriterVersion
              && workingState.floor.highestWriterVersion === highestWriterVersion
            ) {
              mutateFloor({
                ...workingState.floor,
                minimumWriterVersion,
                highestWriterVersion,
              });
            }
          }
          return 1;
        },
        async $queryRaw(strings, ...values) {
          const sql = sqlText(strings);
          operations.push({ kind: 'query', sql, values });
          if (sql.includes('FROM public.agent_mission_fingerprint_key_bindings')) {
            const [version] = values;
            const keyFingerprint = workingBindings.get(version);
            return keyFingerprint === undefined ? [] : [{ keyFingerprint }];
          }
          if (sql.includes('FROM public.agent_mission_fingerprint_key_version_floors')) {
            return workingState.floor === null ? [] : [{ ...workingState.floor }];
          }
          throw new Error(`unexpected tagged query: ${sql}`);
        },
        async $executeRawUnsafe(sql, ...values) {
          operations.push({ kind: 'executeUnsafe', sql, values });
          return 0;
        },
        async $queryRawUnsafe(sql, ...values) {
          operations.push({ kind: 'queryUnsafe', sql, values });
          if (sql.includes('agent_mission_fingerprint_key_readiness')) {
            if (readinessOverride !== undefined) {
              return typeof readinessOverride === 'function'
                ? readinessOverride({
                    durable: workingBindings,
                    writerFloor: workingState.floor,
                    values,
                  })
                : readinessOverride;
            }
            const configuredVersions = values[0];
            return [...new Set([...configuredVersions, ...retainedVersions])]
              .sort((left, right) => left - right)
              .map((keyVersion) => ({
                keyVersion,
                keyFingerprint: workingBindings.get(keyVersion) ?? null,
                retained: retainedVersions.has(keyVersion),
                minimumWriterVersion: workingState.floor?.minimumWriterVersion ?? null,
                highestWriterVersion: workingState.floor?.highestWriterVersion ?? null,
                writerEnabled: workingState.floor?.writerEnabled ?? null,
              }));
          }
          if (sql.includes('FROM public.realtime_global_capacity')) {
            return capacity === null ? [] : [{ ...capacity }];
          }
          throw new Error(`unexpected unsafe query: ${sql}`);
        },
      };
      const result = await work(transaction);
      durable.clear();
      for (const [version, keyFingerprint] of workingBindings) {
        durable.set(version, keyFingerprint);
      }
      writerFloor = workingState.floor === null ? null : { ...workingState.floor };
      return result;
    },
  };
  return {
    prisma,
    durable,
    operations,
    get floor() {
      return writerFloor === null ? null : {
        minimumWriterVersion: writerFloor.minimumWriterVersion,
        highestWriterVersion: writerFloor.highestWriterVersion,
      };
    },
    get writerEnabled() {
      return writerFloor?.writerEnabled ?? null;
    },
  };
}

test('master OFF reste dormant uniquement avec le bloc keyring absent', () => {
  assert.deepEqual(parseAgentMissionFingerprintKeyOperation('stage', {
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'false',
    DIRECT_URL: directUrl,
  }), { enabled: false, mode: 'stage' });
  assert.throws(
    () => parseAgentMissionFingerprintKeyOperation('retire', {
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'false',
      BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
      DIRECT_URL: directUrl,
    }),
    /keyring block to be absent/u,
  );
  assert.throws(
    () => parseAgentMissionFingerprintKeyOperation('stage', {
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'false',
    }),
    /DIRECT_URL is required/u,
  );
});

test('master OFF vérifie le floor durable et exige le drain seulement après activation', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', {
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'false',
    DIRECT_URL: directUrl,
  });
  const dormant = harness({
    floor: null,
    capacity: { mode: 'active', usedSessions: 8 },
  });
  await expectDisabled(config, dormant);
  assert.equal(
    dormant.operations.some(({ sql }) => sql?.includes('realtime_global_capacity')),
    false,
  );

  for (const capacity of [
    { mode: 'active', usedSessions: 0 },
    { mode: 'closed', usedSessions: 1 },
    null,
  ]) {
    const active = harness({
      floor: { minimumWriterVersion: 1, highestWriterVersion: 1 },
      capacity,
    });
    await assert.rejects(
      manageAgentMissionFingerprintKeyVersions(config, active.prisma),
      /capacity closed with zero sessions/u,
    );
  }

  const drained = harness({
    floor: { minimumWriterVersion: 1, highestWriterVersion: 1 },
    capacity: { mode: 'closed', usedSessions: 0 },
  });
  await expectDisabled(config, drained);
  assert.equal(drained.writerEnabled, false);

  const alreadyDisabled = harness({
    floor: {
      minimumWriterVersion: 1,
      highestWriterVersion: 1,
      writerEnabled: false,
    },
    capacity: { mode: 'active', usedSessions: 12 },
  });
  await expectDisabled(config, alreadyDisabled);
  assert.equal(
    alreadyDisabled.operations.some(
      ({ sql }) => sql?.includes('realtime_global_capacity'),
    ),
    false,
  );
});

async function expectDisabled(config, state) {
  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await manageAgentMissionFingerprintKeyVersions(config, state.prisma),
      { status: 'disabled' },
    );
  });
}

test('le parseur refuse une opération inconnue', () => {
  assert.throws(
    () => parseAgentMissionFingerprintKeyOperation('rotate', environment()),
    /operation must be stage or retire/u,
  );
});

test('le CLI ne journalise ni matériau HMAC ni mot de passe PostgreSQL', () => {
  const password = 'postgres-password-never-log';
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./manage-agent-mission-fingerprint-key-versions.mjs', import.meta.url)),
      'stage',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
        BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
        BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: FIRST }),
        BOB_LIVE_ENABLED: 'true',
        BOB_LIVE_PROVIDER: 'openai',
        DIRECT_URL:
          `postgresql://deployer:${password}@127.0.0.1:1/bob?connect_timeout=1`,
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /agent-mission-fingerprint-key:error/u);
  assert.doesNotMatch(output, new RegExp(`${FIRST}|${password}`, 'u'));
});

test('le manager refuse AgentMission hors du chemin Bob Live OpenAI', () => {
  for (const candidate of [
    environment({ BOB_LIVE_ENABLED: 'false' }),
    environment({ BOB_LIVE_PROVIDER: 'mistral' }),
    environment({
      BOB_LIVE_ENABLED: undefined,
      OPENAI_REALTIME_ENABLED: undefined,
    }),
  ]) {
    assert.throws(
      () => parseAgentMissionFingerprintKeyOperation('stage', candidate),
      /requires Bob Live with the OpenAI provider/u,
    );
  }
  assert.equal(
    parseAgentMissionFingerprintKeyOperation('stage', environment({
      BOB_LIVE_ENABLED: undefined,
      OPENAI_REALTIME_ENABLED: 'true',
    })).enabled,
    true,
  );
});

test('le stage parse le keyring exact sans exposer les secrets', () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment());
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'stage');
  assert.equal(config.currentVersion, 2);
  assert.deepEqual(config.bindings, [
    { version: 1, fingerprint: expected(FIRST) },
    { version: 2, fingerprint: expected(SECOND) },
  ]);
  assert.doesNotMatch(JSON.stringify(config), new RegExp(`${FIRST}|${SECOND}`, 'u'));
  assert.doesNotMatch(JSON.stringify(config), /deployer|secret|DIRECT_URL/u);
});

test('le parseur refuse les blocs partiels, versions invalides et matériaux réutilisés', () => {
  for (const candidate of [
    environment({ BOB_AGENT_MISSION_HMAC_KEYRING: undefined }),
    environment({ BOB_AGENT_MISSION_HMAC_KEY_VERSION: '0' }),
    environment({ BOB_AGENT_MISSION_HMAC_KEY_VERSION: '3' }),
    environment({
      BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: FIRST, 2: FIRST }),
    }),
    environment({
      BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 2: 'invalid' }),
    }),
    environment({
      BOB_LIVE_PROOF_KEYRING: JSON.stringify({ 1: FIRST }),
    }),
    environment({
      OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET: SECOND,
    }),
    environment({ DIRECT_URL: undefined }),
  ]) {
    assert.throws(
      () => parseAgentMissionFingerprintKeyOperation('stage', candidate),
    );
  }
});

test('un premier stage lie le matériau, couvre les événements retenus et arme le floor', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment());
  const state = harness({ retainedVersions: new Set([1]) });

  const result = await manageAgentMissionFingerprintKeyVersions(
    config,
    state.prisma,
  );

  assert.deepEqual(result, {
    status: 'staged',
    currentVersion: 2,
    bindingCount: 2,
    writerFloor: { minimumWriterVersion: 1, highestWriterVersion: 2 },
  });
  assert.ok(
    state.operations.some(({ sql }) => /pg_advisory_xact_lock/u.test(sql ?? '')),
  );
  assert.deepEqual(state.operations[0].options, {
    isolationLevel: 'ReadCommitted',
    maxWait: 10_000,
    timeout: 50_000,
  });
  assert.equal(state.durable.get(1), expected(FIRST));
  assert.equal(state.durable.get(2), expected(SECOND));
  assert.deepEqual(state.floor, {
    minimumWriterVersion: 1,
    highestWriterVersion: 2,
  });
});

test('un premier stage sans clé N-1 exige une capacité fermée et drainée', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment({
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 2: SECOND }),
  }));
  const state = harness({
    capacity: { mode: 'active', usedSessions: 0 },
  });

  await assert.rejects(
    manageAgentMissionFingerprintKeyVersions(config, state.prisma),
    /capacity closed with zero sessions/u,
  );
  assert.equal(state.floor, null);
  assert.equal(state.durable.has(2), false);
});

test('un stage adjacent étend N vers N/N+1 sans rollback', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment());
  const state = harness({
    bindings: new Map([
      [1, expected(FIRST)],
      [2, expected(SECOND)],
    ]),
    floor: { minimumWriterVersion: 1, highestWriterVersion: 1 },
  });

  const result = await manageAgentMissionFingerprintKeyVersions(
    config,
    state.prisma,
  );

  assert.deepEqual(result.writerFloor, {
    minimumWriterVersion: 1,
    highestWriterVersion: 2,
  });
  assert.deepEqual(state.floor, {
    minimumWriterVersion: 1,
    highestWriterVersion: 2,
  });
});

test('stage réactive atomiquement un floor déjà désactivé', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment({
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
  }));
  const state = harness({
    bindings: new Map([
      [1, expected(FIRST)],
      [2, expected(SECOND)],
    ]),
    floor: {
      minimumWriterVersion: 1,
      highestWriterVersion: 2,
      writerEnabled: false,
    },
    capacity: { mode: 'active', usedSessions: 5 },
  });

  const result = await manageAgentMissionFingerprintKeyVersions(
    config,
    state.prisma,
  );
  assert.equal(result.status, 'staged');
  assert.equal(state.writerEnabled, true);
  assert.equal(
    state.operations.some(({ sql }) => sql?.includes('realtime_global_capacity')),
    false,
  );
});

test('le writer N reste idempotent pendant la fenêtre N/N+1 sans réduire le floor', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment({
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
  }));
  const state = harness({
    bindings: new Map([
      [1, expected(FIRST)],
      [2, expected(SECOND)],
    ]),
    floor: { minimumWriterVersion: 1, highestWriterVersion: 2 },
  });

  const result = await manageAgentMissionFingerprintKeyVersions(
    config,
    state.prisma,
  );

  assert.deepEqual(result.writerFloor, {
    minimumWriterVersion: 1,
    highestWriterVersion: 2,
  });
  assert.deepEqual(state.floor, {
    minimumWriterVersion: 1,
    highestWriterVersion: 2,
  });
});

test('un même numéro déjà lié à un autre matériau échoue sans réécriture', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment());
  const state = harness({
    bindings: new Map([[1, 'f'.repeat(64)]]),
  });

  await assert.rejects(
    manageAgentMissionFingerprintKeyVersions(config, state.prisma),
    /version 1 material mismatch/u,
  );
  assert.equal(state.durable.get(1), 'f'.repeat(64));
});

test('un matériau déjà lié à une autre version échoue et la transaction ne fuit rien', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment({
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '2',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 2: FIRST }),
  }));
  const state = harness({
    bindings: new Map([[1, expected(FIRST)]]),
    floor: { minimumWriterVersion: 1, highestWriterVersion: 1 },
  });

  await assert.rejects(
    manageAgentMissionFingerprintKeyVersions(config, state.prisma),
    /duplicate key fingerprint/u,
  );
  assert.deepEqual([...state.durable], [[1, expected(FIRST)]]);
  assert.deepEqual(state.floor, {
    minimumWriterVersion: 1,
    highestWriterVersion: 1,
  });
});

test('un échec après mutation du floor rollbacke bindings et floor', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment());
  const state = harness({
    bindings: new Map([[1, expected(FIRST)]]),
    floor: { minimumWriterVersion: 1, highestWriterVersion: 1 },
    failAfterFloorMutation: true,
  });

  await assert.rejects(
    manageAgentMissionFingerprintKeyVersions(config, state.prisma),
    /injected floor mutation failure/u,
  );
  assert.deepEqual([...state.durable], [[1, expected(FIRST)]]);
  assert.deepEqual(state.floor, {
    minimumWriterVersion: 1,
    highestWriterVersion: 1,
  });
});

test('le stage refuse rollback et saut de version', async () => {
  const rollback = parseAgentMissionFingerprintKeyOperation('stage', environment({
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
  }));
  await assert.rejects(
    manageAgentMissionFingerprintKeyVersions(rollback, harness({
      bindings: new Map([
        [1, expected(FIRST)],
        [2, expected(SECOND)],
      ]),
      floor: { minimumWriterVersion: 2, highestWriterVersion: 2 },
    }).prisma),
    /rollback, gap or third concurrent writer/u,
  );

  const gap = parseAgentMissionFingerprintKeyOperation('stage', environment({
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '3',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: FIRST, 3: THIRD }),
  }));
  await assert.rejects(
    manageAgentMissionFingerprintKeyVersions(gap, harness({
      bindings: new Map([[1, expected(FIRST)]]),
      floor: { minimumWriterVersion: 1, highestWriterVersion: 1 },
    }).prisma),
    /rollback, gap or third concurrent writer/u,
  );
});

test('retire exige capacité fermée et drainée puis avance N/N+1 vers N+1', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('retire', environment());
  const state = harness({
    bindings: new Map([
      [1, expected(FIRST)],
      [2, expected(SECOND)],
    ]),
    floor: { minimumWriterVersion: 1, highestWriterVersion: 2 },
    retainedVersions: new Set([1]),
  });

  const result = await manageAgentMissionFingerprintKeyVersions(
    config,
    state.prisma,
  );

  assert.deepEqual(result, {
    status: 'retired',
    currentVersion: 2,
    bindingCount: 2,
    writerFloor: { minimumWriterVersion: 2, highestWriterVersion: 2 },
  });
  assert.deepEqual(state.floor, {
    minimumWriterVersion: 2,
    highestWriterVersion: 2,
  });
});

test('retire est idempotent après commit sans redemander un drain', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('retire', environment());
  const state = harness({
    bindings: new Map([
      [1, expected(FIRST)],
      [2, expected(SECOND)],
    ]),
    floor: { minimumWriterVersion: 2, highestWriterVersion: 2 },
    capacity: { mode: 'active', usedSessions: 9 },
  });

  const result = await manageAgentMissionFingerprintKeyVersions(
    config,
    state.prisma,
  );

  assert.equal(result.status, 'retired');
  assert.deepEqual(result.writerFloor, {
    minimumWriterVersion: 2,
    highestWriterVersion: 2,
  });
  assert.equal(
    state.operations.some(({ sql }) => sql?.includes('realtime_global_capacity')),
    false,
  );
});

test('retire exige encore les deux clés avant le commit mais accepte le retry sans N', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('retire', environment({
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 2: SECOND }),
  }));
  const pending = harness({
    bindings: new Map([
      [1, expected(FIRST)],
      [2, expected(SECOND)],
    ]),
    floor: { minimumWriterVersion: 1, highestWriterVersion: 2 },
  });

  await assert.rejects(
    manageAgentMissionFingerprintKeyVersions(config, pending.prisma),
    /cover both admitted writer versions/u,
  );
  assert.deepEqual(pending.floor, {
    minimumWriterVersion: 1,
    highestWriterVersion: 2,
  });

  const committed = harness({
    bindings: new Map([
      [1, expected(FIRST)],
      [2, expected(SECOND)],
    ]),
    floor: { minimumWriterVersion: 2, highestWriterVersion: 2 },
    capacity: { mode: 'active', usedSessions: 4 },
  });
  const result = await manageAgentMissionFingerprintKeyVersions(
    config,
    committed.prisma,
  );
  assert.deepEqual(result.writerFloor, {
    minimumWriterVersion: 2,
    highestWriterVersion: 2,
  });
});

test('retire refuse une capacité ouverte ou occupée sans transition du floor', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('retire', environment());
  for (const capacity of [
    { mode: 'open', usedSessions: 0 },
    { mode: 'closed', usedSessions: 1 },
    null,
  ]) {
    const state = harness({
      bindings: new Map([
        [1, expected(FIRST)],
        [2, expected(SECOND)],
      ]),
      floor: { minimumWriterVersion: 1, highestWriterVersion: 2 },
      capacity,
    });
    await assert.rejects(
      manageAgentMissionFingerprintKeyVersions(config, state.prisma),
      /capacity closed with zero sessions/u,
    );
    assert.deepEqual(state.floor, {
      minimumWriterVersion: 1,
      highestWriterVersion: 2,
    });
  }
});

test('la readiness refuse un mélange de floors absent et présent', async () => {
  const config = parseAgentMissionFingerprintKeyOperation('stage', environment());
  const state = harness({
    readinessOverride: ({ durable }) => [
      {
        keyVersion: 1,
        keyFingerprint: durable.get(1),
        retained: false,
        minimumWriterVersion: null,
        highestWriterVersion: null,
        writerEnabled: null,
      },
      {
        keyVersion: 2,
        keyFingerprint: durable.get(2),
        retained: false,
        minimumWriterVersion: 1,
        highestWriterVersion: 2,
        writerEnabled: true,
      },
    ],
  });

  await assert.rejects(
    manageAgentMissionFingerprintKeyVersions(config, state.prisma),
    /inconsistent writer floors/u,
  );
});
