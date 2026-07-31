import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertRailwayM1BActive,
  assertRailwayM1BOff,
  assertRailwayM1BPreflight,
  decodeRailwayM1BState,
  M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN,
  M2A3_RAILWAY_PREVIEW_OWNER,
  M2A3_RAILWAY_PREVIEW_OWNER_VALUE,
  M2A3_RAILWAY_PREVIEW_RELEASE_SHA,
  parseRailwayM1BEnvironment,
  parseRailwayServingDeploymentId,
  parseRailwayUpDeploymentId,
  redeployCapturedRailwayM1BBaseline,
  redeployExactRailwayM1BDeployment,
  runRailwayM1BCommand,
  waitForRailwayM1BDeployment,
} from './agent-mission-m1b-staging-railway.mjs';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const DEPLOYMENT_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '123456789';
const MISSION_SECRET = Buffer.alloc(32, 7).toString('base64url');
const SUBJECT_SECRET = Buffer.alloc(32, 8).toString('base64url');
const PROOF_SECRET = Buffer.alloc(32, 9).toString('base64url');
const RELEASE_SHA = 'a'.repeat(40);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));

test('exécute le control plane Railway avant toute installation de dépendances', async (t) => {
  const isolatedDirectory = await mkdtemp(join(tmpdir(), 'bob-m1b-railway-bootstrap-'));
  t.after(() => rm(isolatedDirectory, { recursive: true, force: true }));

  for (const filename of [
    'agent-mission-m1b-staging-railway.mjs',
    'manage-agent-mission-fingerprint-key-versions.mjs',
  ]) {
    await copyFile(join(SCRIPT_DIRECTORY, filename), join(isolatedDirectory, filename));
  }

  const railwayOperatorPath = await realpath(
    join(isolatedDirectory, 'agent-mission-m1b-staging-railway.mjs'),
  );
  const result = spawnSync(
    process.execPath,
    [railwayOperatorPath, 'serving-deployment-id'],
    {
      cwd: isolatedDirectory,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        ...previewEnvironment(),
      },
      input: JSON.stringify(railwayStatus()),
      timeout: 5_000,
    },
  );

  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${DEPLOYMENT_ID}\n`);
});

function environment(overrides = {}) {
  return {
    RAILWAY_TOKEN: 'railway-project-token-for-staging',
    RAILWAY_PROJECT_ID: PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
    RAILWAY_API_SERVICE_ID: SERVICE_ID,
    BOB_M1B_STAGING_HMAC_KEY_VERSION: '1',
    BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
    BOB_M1B_STAGING_RUN_ID: RUN_ID,
    ...overrides,
  };
}

function previewEnvironment(overrides = {}) {
  return environment({
    BOB_AGENT_MISSION_STAGING_PROFILE: 'm2a3-preview',
    BOB_M2A3_STAGING_PREVIEW_RELEASE_SHA: RELEASE_SHA,
    ...overrides,
  });
}

function bobLiveVariables(overrides = {}) {
  return {
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_PROVIDER: 'openai',
    BOB_LIVE_SPEECH_DELIVERY: 'audited-signed-url-v1',
    OPENAI_API_KEY: 'sk-openai-staging-not-logged',
    BOB_LIVE_SUBJECT_HMAC_SECRET: SUBJECT_SECRET,
    BOB_LIVE_PROOF_SECRET: PROOF_SECRET,
    BOB_LIVE_USAGE_HMAC_SECRET: 'u'.repeat(32),
    BOB_LIVE_CONTROL_ENCRYPTION_SECRET: 'c'.repeat(32),
    BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '1',
    BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS: '1',
    BOB_LIVE_CAPACITY_CONFIG_VERSION: '1',
    BOB_LIVE_AUDIT_PROVIDER: 'local-whisper',
    BOB_LIVE_LOCAL_AUDIT_BASE_URL: 'http://bob-live-whisper-audit.railway.internal:8080/v1',
    BOB_LIVE_LOCAL_AUDIT_TOKEN: 'a'.repeat(32),
    DATABASE_URL: 'postgresql://bob_app:secret@db.internal/bob',
    DIRECT_URL: 'postgresql://postgres:secret@db.internal/bob',
    APP_DATABASE_ROLE: 'bob_app',
    ...overrides,
  };
}

function railwayState(variables = bobLiveVariables(), options = {}) {
  const metadata = Object.keys(variables).map((name) => ({
    node: {
      name,
      serviceId: SERVICE_ID,
      isSealed: options.sealedName === name,
    },
  }));
  return {
    variables,
    environment: {
      id: ENVIRONMENT_ID,
      name: 'staging',
      variables: {
        edges: metadata,
        pageInfo: { hasNextPage: options.hasNextPage ?? false },
      },
    },
    environmentStagedChanges: {
      status: options.patch ? 'STAGED' : 'COMMITTED',
      patch: options.patch ?? {},
    },
  };
}

function previewOffVariables(overrides = {}) {
  return bobLiveVariables({
    BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'false',
    ...overrides,
  });
}

function previewActiveVariables(overrides = {}) {
  return previewOffVariables({
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
    [M2A3_RAILWAY_PREVIEW_OWNER]: M2A3_RAILWAY_PREVIEW_OWNER_VALUE,
    [M2A3_RAILWAY_PREVIEW_RELEASE_SHA]: RELEASE_SHA,
    [M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN]: RUN_ID,
    ...overrides,
  });
}

test('parse la cible staging et refuse toute identité Railway ambiguë', () => {
  assert.equal(parseRailwayM1BEnvironment(environment()).serviceId, SERVICE_ID);
  assert.equal(parseRailwayM1BEnvironment(environment({ GITHUB_RUN_ATTEMPT: '2' })).runId, RUN_ID);
  assert.throws(
    () => parseRailwayM1BEnvironment(environment({ RAILWAY_API_SERVICE_ID: 'bob-pro-api' })),
    /must be a UUID/u,
  );
  assert.throws(
    () =>
      parseRailwayM1BEnvironment(
        environment({
          BOB_M1B_STAGING_HMAC_KEY_VERSION: '01',
        }),
      ),
    /positive integer/u,
  );
  assert.throws(
    () =>
      parseRailwayM1BEnvironment(
        environment({
          BOB_M1B_STAGING_RUN_ID: '123456789:2',
        }),
      ),
    /github\.run_id/u,
  );
  assert.equal(parseRailwayM1BEnvironment(previewEnvironment()).profile, 'm2a3-preview');
  assert.throws(
    () =>
      parseRailwayM1BEnvironment(
        previewEnvironment({
          BOB_M2A3_STAGING_PREVIEW_RELEASE_SHA: 'main',
        }),
      ),
    /exact SHA/u,
  );
});

test('préflight exige Bob Live OpenAI audité, bloc M1-B absent et collection restaurable', () => {
  const config = parseRailwayM1BEnvironment(environment());
  const decoded = decodeRailwayM1BState(railwayState(), config);
  assert.doesNotThrow(() => assertRailwayM1BPreflight(decoded, config));

  const sealed = decodeRailwayM1BState(
    railwayState(bobLiveVariables(), { sealedName: 'OPENAI_API_KEY' }),
    config,
  );
  assert.throws(() => assertRailwayM1BPreflight(sealed, config), /sealed variables/u);

  const pending = decodeRailwayM1BState(
    railwayState(bobLiveVariables(), { patch: { services: { [SERVICE_ID]: { numReplicas: 2 } } } }),
    config,
  );
  assert.throws(() => assertRailwayM1BPreflight(pending, config), /staged changes/u);

  const mistral = decodeRailwayM1BState(
    railwayState(bobLiveVariables({ BOB_LIVE_PROVIDER: 'mistral' })),
    config,
  );
  assert.throws(() => assertRailwayM1BPreflight(mistral, config), /OpenAI audited delivery/u);

  const native = decodeRailwayM1BState(
    railwayState(
      bobLiveVariables({
        BOB_LIVE_SPEECH_DELIVERY: 'openai-native-webrtc-v1',
        BOB_LIVE_PROOF_KEY_VERSION: '1',
        BOB_LIVE_PROOF_KEYRING: JSON.stringify({ 1: PROOF_SECRET }),
      }),
    ),
    config,
  );
  assert.throws(
    () => assertRailwayM1BPreflight(native, config),
    /certified OpenAI audited delivery/u,
  );

  const driftedRealtimeModel = decodeRailwayM1BState(
    railwayState(bobLiveVariables({ OPENAI_REALTIME_MODEL: 'gpt-realtime-preview' })),
    config,
  );
  assert.throws(
    () => assertRailwayM1BPreflight(driftedRealtimeModel, config),
    /gpt-realtime-2\.1 on the official OpenAI endpoint/u,
  );
  const legacyModelOverride = decodeRailwayM1BState(
    railwayState(bobLiveVariables({ OPENAI_MODEL: 'gpt-realtime-2.1' })),
    config,
  );
  assert.throws(
    () => assertRailwayM1BPreflight(legacyModelOverride, config),
    /legacy OPENAI_MODEL override/u,
  );
  const explicitCertifiedModel = decodeRailwayM1BState(
    railwayState(bobLiveVariables({ OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1' })),
    config,
  );
  assert.doesNotThrow(() => assertRailwayM1BPreflight(explicitCertifiedModel, config));

  const inheritedOrDrifted = railwayState();
  inheritedOrDrifted.variables.SHARED_ONLY = 'must-not-be-materialized';
  assert.throws(
    () => decodeRailwayM1BState(inheritedOrDrifted, config),
    /values and ownership metadata diverged/u,
  );
});

test('refuse une clé Mission réutilisant un matériau Bob Live', () => {
  const reusedEnvironment = environment({
    BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({ 1: SUBJECT_SECRET }),
  });
  const config = parseRailwayM1BEnvironment(reusedEnvironment);
  const decoded = decodeRailwayM1BState(railwayState(), config);
  assert.throws(() => assertRailwayM1BPreflight(decoded, config), /must be dedicated/u);
});

test('activation ajoute seulement le bloc M1-B et le relit exactement', async () => {
  const baseline = railwayState();
  const activeVariables = {
    ...bobLiveVariables(),
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
    BOB_M1B_STAGING_CERTIFICATION_OWNER: RUN_ID,
  };
  const active = railwayState(activeVariables);
  const calls = [];
  const graphql = async (_config, query, variables) => {
    calls.push({ query, variables });
    if (query.includes('query AgentMissionM1BState')) {
      return calls.filter((call) => call.query.includes('query AgentMissionM1BState')).length <= 2
        ? baseline
        : active;
    }
    return { variableCollectionUpsert: true };
  };
  await assert.doesNotReject(runRailwayM1BCommand('activate', environment(), { graphql }));
  const mutation = calls.find((call) => call.query.includes('mutation AgentMissionM1BVariables'));
  assert.deepEqual(mutation.variables.input, {
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    variables: {
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
      BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
      BOB_M1B_STAGING_CERTIFICATION_OWNER: RUN_ID,
    },
    replace: false,
    skipDeploys: true,
  });
});

test('preview M2-A remplace seulement la baseline false et persiste un owner exact-SHA', async () => {
  const baseline = railwayState(previewOffVariables());
  const active = railwayState(previewActiveVariables());
  const calls = [];
  let reads = 0;
  const result = await runRailwayM1BCommand('activate', previewEnvironment(), {
    graphql: async (_config, query, variables) => {
      calls.push({ query, variables });
      if (query.includes('query AgentMissionM1BState')) {
        reads += 1;
        return reads <= 2 ? baseline : active;
      }
      return { variableCollectionUpsert: true };
    },
  });
  assert.deepEqual(result, {
    command: 'activate',
    state: 'active',
    changed: true,
    acknowledgement: 'received',
  });
  const mutation = calls.find((call) => call.query.includes('mutation AgentMissionM1BVariables'));
  assert.deepEqual(mutation.variables.input.variables, {
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
    [M2A3_RAILWAY_PREVIEW_OWNER]: M2A3_RAILWAY_PREVIEW_OWNER_VALUE,
    [M2A3_RAILWAY_PREVIEW_RELEASE_SHA]: RELEASE_SHA,
    [M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN]: RUN_ID,
  });
  assert.equal(mutation.variables.input.replace, false);
  assert.equal(mutation.variables.input.skipDeploys, true);
});

test('preview M2-A récupère l’ACK Railway perdu et refuse un autre run propriétaire', async () => {
  const baseline = railwayState(previewOffVariables());
  const active = railwayState(previewActiveVariables());
  let reads = 0;
  const recovered = await runRailwayM1BCommand('activate', previewEnvironment(), {
    graphql: async (_config, query) => {
      if (query.includes('query AgentMissionM1BState')) {
        reads += 1;
        return reads <= 2 ? baseline : active;
      }
      throw new TypeError('response lost after commit');
    },
  });
  assert.equal(recovered.acknowledgement, 'recovered');

  await assert.rejects(
    runRailwayM1BCommand(
      'activate',
      previewEnvironment({
        BOB_M1B_STAGING_RUN_ID: '987654321',
      }),
      {
        graphql: async (_config, query) => {
          assert.match(query, /query AgentMissionM1BState/u);
          return active;
        },
      },
    ),
    /runtime master must be explicitly false before preview activation/u,
  );
});

test('cleanup preview restaure M2-A=false sans toucher les variables étrangères', async () => {
  const active = railwayState(
    previewActiveVariables({
      UNRELATED_RUNTIME_VALUE: 'preserved',
      OPENAI_REALTIME_MODEL: 'uncertified-drift',
      OPENAI_REALTIME_BASE_URL: 'https://proxy.invalid/v1',
    }),
  );
  const expectedOff = previewOffVariables({
    UNRELATED_RUNTIME_VALUE: 'preserved',
    OPENAI_REALTIME_MODEL: 'uncertified-drift',
    OPENAI_REALTIME_BASE_URL: 'https://proxy.invalid/v1',
  });
  const off = railwayState(expectedOff);
  const calls = [];
  let reads = 0;
  const result = await runRailwayM1BCommand(
    'deactivate',
    previewEnvironment({
      BOB_M1B_STAGING_RUN_ID: '987654321',
    }),
    {
      graphql: async (_config, query, variables) => {
        calls.push({ query, variables });
        if (query.includes('query AgentMissionM1BState')) {
          reads += 1;
          return reads <= 2 ? active : off;
        }
        return { variableCollectionUpsert: true };
      },
    },
  );
  assert.equal(result.state, 'off');
  const mutation = calls.find((call) => call.query.includes('mutation AgentMissionM1BVariables'));
  assert.deepEqual(mutation.variables.input.variables, expectedOff);
  assert.equal(mutation.variables.input.replace, true);
});

test('preview refuse bloc partiel, owner étranger et baseline M2-A absente', async () => {
  const config = parseRailwayM1BEnvironment(previewEnvironment());
  assert.throws(
    () =>
      assertRailwayM1BPreflight(
        decodeRailwayM1BState(railwayState(bobLiveVariables()), config),
        config,
      ),
    /explicitly false/u,
  );

  const foreign = railwayState(
    previewActiveVariables({
      [M2A3_RAILWAY_PREVIEW_OWNER]: 'foreign-owner',
    }),
  );
  await assert.rejects(
    runRailwayM1BCommand('deactivate', previewEnvironment(), {
      graphql: async (_config, query) => {
        assert.match(query, /query AgentMissionM1BState/u);
        return foreign;
      },
    }),
    /exact persistent M2-A preview/u,
  );

  const partial = decodeRailwayM1BState(
    railwayState(
      previewOffVariables({
        BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      }),
    ),
    config,
  );
  assert.throws(() => assertRailwayM1BPreflight(partial, config), /must be absent/u);
});

test('cleanup au rerun reconstruit la collection sans le bloc possédé par le run stable', async () => {
  const activeVariables = {
    ...bobLiveVariables(),
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
    BOB_M1B_STAGING_CERTIFICATION_OWNER: RUN_ID,
  };
  const active = railwayState(activeVariables);
  const off = railwayState();
  const calls = [];
  const graphql = async (_config, query, variables) => {
    calls.push({ query, variables });
    if (query.includes('query AgentMissionM1BState')) {
      return calls.filter((call) => call.query.includes('query AgentMissionM1BState')).length <= 2
        ? active
        : off;
    }
    return { variableCollectionUpsert: true };
  };
  await assert.doesNotReject(
    runRailwayM1BCommand('deactivate', environment({ GITHUB_RUN_ATTEMPT: '2' }), { graphql }),
  );
  const mutation = calls.find((call) => call.query.includes('mutation AgentMissionM1BVariables'));
  assert.equal(mutation.variables.input.replace, true);
  assert.equal(mutation.variables.input.skipDeploys, true);
  assert.deepEqual(mutation.variables.input.variables, bobLiveVariables());
});

test('cleanup récupère un ACK perdu uniquement après preuve durable de la collection OFF exacte', async () => {
  const active = railwayState({
    ...bobLiveVariables(),
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
    BOB_M1B_STAGING_CERTIFICATION_OWNER: RUN_ID,
  });
  const off = railwayState();
  let reads = 0;
  const recovered = await runRailwayM1BCommand('deactivate', environment(), {
    graphql: async (_config, query) => {
      if (query.includes('query AgentMissionM1BState')) {
        reads += 1;
        return reads <= 2 ? active : off;
      }
      throw new TypeError('response lost after commit');
    },
  });
  assert.deepEqual(recovered, {
    command: 'deactivate',
    state: 'off',
    changed: true,
    acknowledgement: 'recovered',
  });

  reads = 0;
  await assert.rejects(
    runRailwayM1BCommand('deactivate', environment(), {
      graphql: async (_config, query) => {
        if (query.includes('query AgentMissionM1BState')) {
          reads += 1;
          return active;
        }
        throw new TypeError('response lost without commit');
      },
    }),
    /must be absent/u,
  );
});

test('cleanup refuse de supprimer un bloc non possédé ou une dérive concurrente', async () => {
  const foreign = railwayState({
    ...bobLiveVariables(),
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
    BOB_M1B_STAGING_CERTIFICATION_OWNER: '987654321',
  });
  await assert.rejects(
    runRailwayM1BCommand('deactivate', environment(), {
      graphql: async (_config, query) => {
        if (!query.includes('query AgentMissionM1BState')) {
          throw new Error('mutation must not run');
        }
        return foreign;
      },
    }),
    /run-owned/u,
  );

  const active = railwayState({
    ...bobLiveVariables(),
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
    BOB_M1B_STAGING_CERTIFICATION_OWNER: RUN_ID,
  });
  const changed = railwayState({
    ...active.variables,
    UNRELATED_RUNTIME_VALUE: 'changed-concurrently',
  });
  let reads = 0;
  await assert.rejects(
    runRailwayM1BCommand('deactivate', environment(), {
      graphql: async (_config, query) => {
        if (!query.includes('query AgentMissionM1BState')) {
          throw new Error('mutation must not run');
        }
        reads += 1;
        return reads === 1 ? active : changed;
      },
    }),
    /changed concurrently/u,
  );
});

test('assertions active/off refusent une configuration partielle', () => {
  const config = parseRailwayM1BEnvironment(environment());
  const active = decodeRailwayM1BState(
    railwayState({
      ...bobLiveVariables(),
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
      BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({ 1: MISSION_SECRET }),
      BOB_M1B_STAGING_CERTIFICATION_OWNER: RUN_ID,
    }),
    config,
  );
  assert.doesNotThrow(() => assertRailwayM1BActive(active, config));
  assert.throws(() => assertRailwayM1BOff(active), /must be absent/u);

  const partial = decodeRailwayM1BState(
    railwayState({
      ...bobLiveVariables(),
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    }),
    config,
  );
  assert.throws(() => assertRailwayM1BActive(partial, config), /exact run-owned AgentMission/u);
});

test('assert-active preview recertifie le modèle OpenAI exact après le déploiement', () => {
  const config = parseRailwayM1BEnvironment(previewEnvironment());
  assert.doesNotThrow(() =>
    assertRailwayM1BActive(
      decodeRailwayM1BState(
        railwayState(previewActiveVariables({ OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1' })),
        config,
      ),
      config,
    ),
  );
  for (const variables of [
    previewActiveVariables({ OPENAI_REALTIME_MODEL: 'uncertified-drift' }),
    previewActiveVariables({ OPENAI_MODEL: 'legacy-override' }),
    previewActiveVariables({ OPENAI_REALTIME_BASE_URL: 'https://proxy.invalid/v1' }),
    previewActiveVariables({ BOB_LIVE_PROVIDER: 'mistral' }),
  ]) {
    assert.throws(
      () => assertRailwayM1BActive(decodeRailwayM1BState(railwayState(variables), config), config),
      /certified OpenAI|gpt-realtime-2\.1|official OpenAI endpoint/u,
    );
  }
});

test('assert-active preview lie la preuve au run qui a posé le bloc', async () => {
  const active = railwayState(previewActiveVariables());
  assert.deepEqual(
    await runRailwayM1BCommand('assert-active', previewEnvironment(), {
      graphql: async () => active,
    }),
    { command: 'assert-active', state: 'active', activationRunId: RUN_ID },
  );
  await assert.rejects(
    runRailwayM1BCommand(
      'assert-active',
      previewEnvironment({ BOB_M1B_STAGING_RUN_ID: '987654321' }),
      { graphql: async () => active },
    ),
    /exact persistent M2-A preview/u,
  );
});

test('inspect-owned-preview expose le SHA servi sans laisser un drift bloquer le cleanup', async () => {
  const active = railwayState(
    previewActiveVariables({
      OPENAI_REALTIME_MODEL: 'uncertified-drift',
      OPENAI_REALTIME_BASE_URL: 'https://proxy.invalid/v1',
    }),
  );
  assert.deepEqual(
    await runRailwayM1BCommand('inspect-owned-preview', previewEnvironment(), {
      graphql: async () => active,
    }),
    {
      command: 'inspect-owned-preview',
      state: 'active',
      releaseSha: RELEASE_SHA,
      activationRunId: RUN_ID,
    },
  );
  await assert.rejects(
    runRailwayM1BCommand('inspect-owned-preview', environment(), {
      graphql: async () => active,
    }),
    /reserved to the persistent M2-A preview/u,
  );
});

test('parse uniquement le deploymentId exact de railway up', () => {
  assert.equal(
    parseRailwayUpDeploymentId(
      JSON.stringify({
        deploymentId: DEPLOYMENT_ID,
        logsUrl: 'https://railway.com/project/deployment',
      }),
    ),
    DEPLOYMENT_ID,
  );
  assert.throws(() => parseRailwayUpDeploymentId('{}'), /deploymentId/u);
  assert.throws(() => parseRailwayUpDeploymentId('not-json'), /invalid JSON/u);
});

function railwayStatus(deploymentOverrides = {}) {
  const deployment = {
    id: DEPLOYMENT_ID,
    status: 'SUCCESS',
    deploymentStopped: false,
    instances: [{ id: '55555555-5555-4555-8555-555555555555', status: 'RUNNING' }],
    ...deploymentOverrides,
  };
  return {
    environments: {
      edges: [
        {
          node: {
            id: ENVIRONMENT_ID,
            name: 'staging',
            serviceInstances: {
              edges: [
                {
                  node: {
                    serviceId: SERVICE_ID,
                    activeDeployments: [deployment],
                    latestDeployment: { ...deployment, canRedeploy: true },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  };
}

test('identifie un unique déploiement réellement servant depuis railway status', () => {
  const config = parseRailwayM1BEnvironment(previewEnvironment());
  assert.equal(parseRailwayServingDeploymentId(railwayStatus(), config), DEPLOYMENT_ID);
  for (const mutation of [
    { status: 'FAILED' },
    { deploymentStopped: true },
    { instances: [{ id: '55555555-5555-4555-8555-555555555555', status: 'EXITED' }] },
  ]) {
    assert.throws(
      () => parseRailwayServingDeploymentId(railwayStatus(mutation), config),
      /one exact redeployable serving deployment/u,
    );
  }
});

test('redéploie uniquement l’ID servant exact et exige un nouvel ID Railway', async () => {
  const nextDeploymentId = '66666666-6666-4666-8666-666666666666';
  const calls = [];
  const graphql = async (_config, query, variables) => {
    calls.push({ query, variables });
    if (query.includes('query AgentMissionM1BDeployment')) {
      return {
        deployment: {
          id: DEPLOYMENT_ID,
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          serviceId: SERVICE_ID,
          status: 'SUCCESS',
          deploymentStopped: false,
          instances: [{ id: '55555555-5555-4555-8555-555555555555', status: 'RUNNING' }],
        },
      };
    }
    if (query.includes('query AgentMissionServingDeployment')) {
      return { environment: railwayStatus().environments.edges[0].node };
    }
    return { deploymentRedeploy: { id: nextDeploymentId } };
  };
  assert.deepEqual(
    await redeployExactRailwayM1BDeployment(DEPLOYMENT_ID, previewEnvironment(), { graphql }),
    { sourceDeploymentId: DEPLOYMENT_ID, deploymentId: nextDeploymentId },
  );
  assert.deepEqual(
    calls.map((call) => call.variables),
    [
      { id: DEPLOYMENT_ID },
      { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID },
      { id: DEPLOYMENT_ID },
    ],
  );

  await assert.rejects(
    redeployExactRailwayM1BDeployment(DEPLOYMENT_ID, previewEnvironment(), {
      graphql: async (_config, query) => {
        if (query.includes('query AgentMissionM1BDeployment')) {
          return graphql(_config, query, { id: DEPLOYMENT_ID });
        }
        if (query.includes('query AgentMissionServingDeployment')) {
          return { environment: railwayStatus().environments.edges[0].node };
        }
        return { deploymentRedeploy: { id: DEPLOYMENT_ID } };
      },
    }),
    /distinct exact-source redeployment/u,
  );
});

test('refuse une course de déploiement et ne rejoue jamais une mutation ambiguë', async () => {
  const source = {
    deployment: {
      id: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      status: 'SUCCESS',
      deploymentStopped: false,
      instances: [{ id: '55555555-5555-4555-8555-555555555555', status: 'RUNNING' }],
    },
  };
  const changedId = '77777777-7777-4777-8777-777777777777';
  let mutationCalls = 0;
  await assert.rejects(
    redeployExactRailwayM1BDeployment(DEPLOYMENT_ID, previewEnvironment(), {
      graphql: async (_config, query) => {
        if (query.includes('query AgentMissionM1BDeployment')) return source;
        if (query.includes('query AgentMissionServingDeployment')) {
          return {
            environment: railwayStatus({ id: changedId }).environments.edges[0].node,
          };
        }
        mutationCalls += 1;
        return { deploymentRedeploy: { id: changedId } };
      },
    }),
    /changed before exact-source/u,
  );
  assert.equal(mutationCalls, 0);

  await assert.rejects(
    redeployExactRailwayM1BDeployment(DEPLOYMENT_ID, previewEnvironment(), {
      graphql: async (_config, query) => {
        if (query.includes('query AgentMissionM1BDeployment')) return source;
        if (query.includes('query AgentMissionServingDeployment')) {
          return { environment: railwayStatus().environments.edges[0].node };
        }
        mutationCalls += 1;
        throw new TypeError('redeploy response lost');
      },
    }),
    /redeploy response lost/u,
  );
  assert.equal(mutationCalls, 1);
});

test('rollback redéploie le baseline capturé même si un nouveau latest a échoué', async () => {
  const nextDeploymentId = '66666666-6666-4666-8666-666666666666';
  let mutationCalls = 0;
  const source = {
    deployment: {
      id: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      status: 'SUCCESS',
      deploymentStopped: true,
      canRedeploy: true,
      instances: [{ id: '55555555-5555-4555-8555-555555555555', status: 'EXITED' }],
    },
  };
  const result = await redeployCapturedRailwayM1BBaseline(DEPLOYMENT_ID, previewEnvironment(), {
    graphql: async (_config, query, variables) => {
      assert.deepEqual(variables, { id: DEPLOYMENT_ID });
      if (query.includes('query AgentMissionM1BDeployment')) return source;
      mutationCalls += 1;
      return { deploymentRedeploy: { id: nextDeploymentId } };
    },
  });
  assert.deepEqual(result, {
    sourceDeploymentId: DEPLOYMENT_ID,
    deploymentId: nextDeploymentId,
  });
  assert.equal(mutationCalls, 1);

  await assert.rejects(
    redeployCapturedRailwayM1BBaseline(DEPLOYMENT_ID, previewEnvironment(), {
      graphql: async (_config, query) => {
        if (query.includes('query AgentMissionM1BDeployment')) {
          return { deployment: { ...source.deployment, canRedeploy: false } };
        }
        throw new Error('mutation must not run');
      },
    }),
    /captured baseline is not an exact redeployable/u,
  );

  mutationCalls = 0;
  await assert.rejects(
    redeployCapturedRailwayM1BBaseline(DEPLOYMENT_ID, previewEnvironment(), {
      graphql: async (_config, query) => {
        if (query.includes('query AgentMissionM1BDeployment')) return source;
        mutationCalls += 1;
        throw new TypeError('redeploy response lost');
      },
    }),
    /redeploy response lost/u,
  );
  assert.equal(mutationCalls, 1);
});

test('attend le deployment ID exact et échoue fermé sur identité ou état terminal', async () => {
  let polls = 0;
  const graphql = async () => ({
    deployment: {
      id: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      status: ++polls === 1 ? 'DEPLOYING' : 'SUCCESS',
    },
  });
  await assert.doesNotReject(
    waitForRailwayM1BDeployment(DEPLOYMENT_ID, environment(), {
      graphql,
      sleep: async () => undefined,
      attempts: 2,
    }),
  );

  await assert.rejects(
    waitForRailwayM1BDeployment(DEPLOYMENT_ID, environment(), {
      graphql: async () => ({
        deployment: {
          id: DEPLOYMENT_ID,
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          serviceId: '55555555-5555-4555-8555-555555555555',
          status: 'SUCCESS',
        },
      }),
      attempts: 1,
    }),
    /identity/u,
  );
  await assert.rejects(
    waitForRailwayM1BDeployment(DEPLOYMENT_ID, environment(), {
      graphql: async () => ({
        deployment: {
          id: DEPLOYMENT_ID,
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          serviceId: SERVICE_ID,
          status: 'FAILED',
        },
      }),
      attempts: 1,
    }),
    /terminal status FAILED/u,
  );
});
