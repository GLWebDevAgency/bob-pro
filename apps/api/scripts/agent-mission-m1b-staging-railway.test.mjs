import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRailwayM1BActive,
  assertRailwayM1BOff,
  assertRailwayM1BPreflight,
  decodeRailwayM1BState,
  parseRailwayM1BEnvironment,
  parseRailwayUpDeploymentId,
  runRailwayM1BCommand,
  waitForRailwayM1BDeployment,
} from './agent-mission-m1b-staging-railway.mjs';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const DEPLOYMENT_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '123456789:1';
const MISSION_SECRET = Buffer.alloc(32, 7).toString('base64url');
const SUBJECT_SECRET = Buffer.alloc(32, 8).toString('base64url');
const PROOF_SECRET = Buffer.alloc(32, 9).toString('base64url');

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
    BOB_LIVE_LOCAL_AUDIT_BASE_URL: 'http://127.0.0.1:8080/v1',
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

test('parse la cible staging et refuse toute identité Railway ambiguë', () => {
  assert.equal(parseRailwayM1BEnvironment(environment()).serviceId, SERVICE_ID);
  assert.throws(
    () => parseRailwayM1BEnvironment(environment({ RAILWAY_API_SERVICE_ID: 'bob-pro-api' })),
    /must be a UUID/u,
  );
  assert.throws(
    () => parseRailwayM1BEnvironment(environment({
      BOB_M1B_STAGING_HMAC_KEY_VERSION: '01',
    })),
    /positive integer/u,
  );
  assert.throws(
    () => parseRailwayM1BEnvironment(environment({
      BOB_M1B_STAGING_RUN_ID: 'not-a-run',
    })),
    /github\.run_id/u,
  );
});

test('préflight exige Bob Live OpenAI WebRTC, bloc M1-B absent et collection restaurable', () => {
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
  assert.throws(() => assertRailwayM1BPreflight(mistral, config), /OpenAI WebRTC/u);

  const native = decodeRailwayM1BState(
    railwayState(bobLiveVariables({
      BOB_LIVE_SPEECH_DELIVERY: 'openai-native-webrtc-v1',
      BOB_LIVE_PROOF_KEY_VERSION: '1',
      BOB_LIVE_PROOF_KEYRING: JSON.stringify({ 1: PROOF_SECRET }),
    })),
    config,
  );
  assert.doesNotThrow(() => assertRailwayM1BPreflight(native, config));

  const incompleteNative = decodeRailwayM1BState(
    railwayState(bobLiveVariables({
      BOB_LIVE_SPEECH_DELIVERY: 'openai-native-webrtc-v1',
    })),
    config,
  );
  assert.throws(
    () => assertRailwayM1BPreflight(incompleteNative, config),
    /complete proof keyring/u,
  );

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
  assert.throws(
    () => assertRailwayM1BPreflight(decoded, config),
    /must be dedicated/u,
  );
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
  await assert.doesNotReject(
    runRailwayM1BCommand('activate', environment(), { graphql }),
  );
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

test('cleanup reconstruit atomiquement la collection courante sans le bloc run-owned M1-B', async () => {
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
    runRailwayM1BCommand('deactivate', environment(), { graphql }),
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
    BOB_M1B_STAGING_CERTIFICATION_OWNER: '987654321:2',
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

test('parse uniquement le deploymentId exact de railway up', () => {
  assert.equal(
    parseRailwayUpDeploymentId(JSON.stringify({
      deploymentId: DEPLOYMENT_ID,
      logsUrl: 'https://railway.com/project/deployment',
    })),
    DEPLOYMENT_ID,
  );
  assert.throws(() => parseRailwayUpDeploymentId('{}'), /deploymentId/u);
  assert.throws(() => parseRailwayUpDeploymentId('not-json'), /invalid JSON/u);
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
