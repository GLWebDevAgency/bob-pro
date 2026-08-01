import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRealtimeVoiceTraceV2RailwayActive,
  assertRealtimeVoiceTraceV2RailwayOff,
  assertRealtimeVoiceTraceV2RailwayPreflight,
  decodeRealtimeVoiceTraceV2RailwayState,
  parseRealtimeVoiceTraceV2RailwayEnvironment,
  REALTIME_VOICE_TRACE_V2_ACTIVATION_RUN,
  REALTIME_VOICE_TRACE_V2_OWNER,
  REALTIME_VOICE_TRACE_V2_OWNER_VALUE,
  REALTIME_VOICE_TRACE_V2_RELEASE_SHA,
  runRealtimeVoiceTraceV2RailwayCommand,
} from './realtime-voice-trace-v2-staging-railway.mjs';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = 'trace-company';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const RELEASE_SHA = 'a'.repeat(40);
const RUN_ID = '987654321';
const TRACE_SECRET = Buffer.alloc(32, 17).toString('base64url');

function environment(overrides = {}) {
  return {
    RAILWAY_TOKEN: 'railway-project-token-for-staging',
    RAILWAY_PROJECT_ID: PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
    RAILWAY_API_SERVICE_ID: SERVICE_ID,
    BOB_M1B_STAGING_COMPANY_ID: COMPANY_ID,
    BOB_M1B_STAGING_USER_ID: USER_ID,
    BOB_REALTIME_VOICE_TRACE_V2_SUBJECTS: `${COMPANY_ID}:${USER_ID}`,
    BOB_REALTIME_VOICE_TRACE_V2_ENCRYPTION_KEYRING: JSON.stringify({ 1: TRACE_SECRET }),
    BOB_REALTIME_VOICE_TRACE_V2_ENCRYPTION_CURRENT_VERSION: '1',
    BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA: RELEASE_SHA,
    BOB_REALTIME_VOICE_TRACE_V2_RUN_ID: RUN_ID,
    ...overrides,
  };
}

function prerequisites(overrides = {}) {
  return {
    CABINET_RELEASE_ENV: 'staging',
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_PROVIDER: 'openai',
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: '1',
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({
      1: Buffer.alloc(32, 18).toString('base64url'),
    }),
    OPENAI_API_KEY: 'openai-staging-secret',
    BOB_LIVE_USAGE_HMAC_SECRET: 'usage-staging-secret',
    BOB_LIVE_CONTROL_ENCRYPTION_SECRET: 'control-staging-secret',
    BOB_LIVE_SUBJECT_HMAC_SECRET: 'subject-staging-secret',
    BOB_LIVE_PROOF_SECRET: 'proof-staging-secret',
    BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '100',
    BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS: '80',
    BOB_LIVE_CAPACITY_CONFIG_VERSION: '1',
    BOB_LIVE_LOCAL_AUDIT_BASE_URL: 'https://audit-staging.bob.test',
    BOB_LIVE_LOCAL_AUDIT_TOKEN: 'audit-staging-secret',
    DATABASE_URL: 'postgresql://runtime@staging.invalid/bob',
    DIRECT_URL: 'postgresql://deployer@staging.invalid/bob',
    APP_DATABASE_ROLE: 'bob_api_runtime',
    VOICE_TRACE_ENABLED: 'false',
    ...overrides,
  };
}

function activeBlock(overrides = {}) {
  return {
    VOICE_TRACE_REALTIME_V2_ENABLED: 'true',
    VOICE_TRACE_REALTIME_V2_SUBJECTS: `${COMPANY_ID}:${USER_ID}`,
    VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING: JSON.stringify({ 1: TRACE_SECRET }),
    VOICE_TRACE_REALTIME_V2_ENCRYPTION_CURRENT_VERSION: '1',
    [REALTIME_VOICE_TRACE_V2_OWNER]: REALTIME_VOICE_TRACE_V2_OWNER_VALUE,
    [REALTIME_VOICE_TRACE_V2_RELEASE_SHA]: RELEASE_SHA,
    [REALTIME_VOICE_TRACE_V2_ACTIVATION_RUN]: RUN_ID,
    ...overrides,
  };
}

function railwayState(variables = prerequisites(), options = {}) {
  return {
    variables,
    environment: {
      id: ENVIRONMENT_ID,
      name: options.environmentName ?? 'staging',
      variables: {
        edges: Object.keys(variables).map((name) => ({
          node: {
            name,
            serviceId: SERVICE_ID,
            isSealed: options.sealedName === name,
          },
        })),
        pageInfo: { hasNextPage: options.hasNextPage ?? false },
      },
    },
    environmentStagedChanges: {
      status: options.patch ? 'STAGED' : 'COMMITTED',
      patch: options.patch ?? {},
    },
  };
}

function decoded(variables = prerequisites(), options = {}) {
  const config = parseRealtimeVoiceTraceV2RailwayEnvironment(environment());
  return decodeRealtimeVoiceTraceV2RailwayState(railwayState(variables, options), config);
}

test('parse strictement la cible, l allowlist et le keyring durable', () => {
  const parsed = parseRealtimeVoiceTraceV2RailwayEnvironment(environment());
  assert.equal(parsed.releaseSha, RELEASE_SHA);
  assert.equal(parsed.subjects, `${COMPANY_ID}:${USER_ID}`);
  assert.throws(
    () =>
      parseRealtimeVoiceTraceV2RailwayEnvironment(
        environment({
          BOB_REALTIME_VOICE_TRACE_V2_SUBJECTS: `${COMPANY_ID}:${USER_ID},${COMPANY_ID}:${USER_ID}`,
        }),
      ),
    /unique canonical subjects/u,
  );
  assert.throws(
    () =>
      parseRealtimeVoiceTraceV2RailwayEnvironment(
        environment({
          BOB_REALTIME_VOICE_TRACE_V2_ENCRYPTION_CURRENT_VERSION: '2',
        }),
      ),
    /must exist in the keyring/u,
  );
  assert.throws(
    () =>
      parseRealtimeVoiceTraceV2RailwayEnvironment(
        environment({
          RAILWAY_ENVIRONMENT_ID: 'production',
        }),
      ),
    /must be a UUID/u,
  );
});

test('preflight exige GPT Realtime M2-A actif et un OFF canonique restaurable', () => {
  const config = parseRealtimeVoiceTraceV2RailwayEnvironment(environment());
  assert.doesNotThrow(() => assertRealtimeVoiceTraceV2RailwayPreflight(decoded(), config));
  assert.throws(
    () =>
      assertRealtimeVoiceTraceV2RailwayPreflight(
        decoded(
          prerequisites({
            BOB_AGENT_MISSION_HMAC_KEYRING: '',
          }),
        ),
        config,
      ),
    /prerequisites are incomplete|keyring is invalid/u,
  );
  assert.throws(
    () =>
      assertRealtimeVoiceTraceV2RailwayPreflight(
        decoded({
          ...prerequisites(),
          VOICE_TRACE_REALTIME_V2_ENABLED: 'false',
        }),
        config,
      ),
    /wholly absent while OFF/u,
  );
  assert.throws(
    () =>
      assertRealtimeVoiceTraceV2RailwayPreflight(
        decoded(prerequisites(), {
          patch: { services: { [SERVICE_ID]: { numReplicas: 2 } } },
        }),
        config,
      ),
    /pending changes/u,
  );
  assert.throws(
    () =>
      assertRealtimeVoiceTraceV2RailwayPreflight(
        decoded(prerequisites(), {
          sealedName: 'BOB_AGENT_MISSION_HMAC_KEYRING',
        }),
        config,
      ),
    /sealed variables/u,
  );
});

test('activation ajoute exactement le bloc possédé, sans auto-deploy, puis récupère un ACK perdu', async () => {
  const baseline = railwayState();
  const active = railwayState({ ...prerequisites(), ...activeBlock() });
  const calls = [];
  let reads = 0;
  const result = await runRealtimeVoiceTraceV2RailwayCommand('activate', environment(), {
    graphql: async (_config, query, variables) => {
      calls.push({ query, variables });
      if (query.includes('query RealtimeVoiceTraceV2State')) {
        reads += 1;
        return reads <= 2 ? baseline : active;
      }
      throw new TypeError('response lost after committed mutation');
    },
  });
  assert.deepEqual(result, {
    command: 'activate',
    state: 'active',
    changed: true,
    acknowledgement: 'recovered',
  });
  const mutation = calls.find(({ query }) =>
    query.includes('mutation RealtimeVoiceTraceV2Variables'),
  );
  assert.deepEqual(mutation.variables.input, {
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    variables: activeBlock(),
    replace: false,
    skipDeploys: true,
  });
});

test('activation refuse une concurrence et un owner d un autre run', async () => {
  const baseline = railwayState();
  const drifted = railwayState({ ...prerequisites(), UNRELATED: 'changed' });
  let reads = 0;
  await assert.rejects(
    runRealtimeVoiceTraceV2RailwayCommand('activate', environment(), {
      graphql: async (_config, query) => {
        if (!query.includes('query RealtimeVoiceTraceV2State')) {
          return { variableCollectionUpsert: true };
        }
        reads += 1;
        return reads === 1 ? baseline : drifted;
      },
    }),
    /changed concurrently/u,
  );

  const foreign = decoded({
    ...prerequisites(),
    ...activeBlock({ [REALTIME_VOICE_TRACE_V2_ACTIVATION_RUN]: '123456789' }),
  });
  const config = parseRealtimeVoiceTraceV2RailwayEnvironment(environment());
  assert.throws(
    () => assertRealtimeVoiceTraceV2RailwayActive(foreign, config),
    /exact Realtime Voice Trace V2 block/u,
  );
});

test('deactivation remplace la collection sans le bloc et conserve chaque variable étrangère', async () => {
  const beforeVariables = {
    ...prerequisites(),
    ...activeBlock(),
    UNRELATED: 'preserved',
  };
  const afterVariables = { ...prerequisites(), UNRELATED: 'preserved' };
  const before = railwayState(beforeVariables);
  const after = railwayState(afterVariables);
  const calls = [];
  let reads = 0;
  const result = await runRealtimeVoiceTraceV2RailwayCommand('deactivate', environment(), {
    graphql: async (_config, query, variables) => {
      calls.push({ query, variables });
      if (query.includes('query RealtimeVoiceTraceV2State')) {
        reads += 1;
        return reads <= 2 ? before : after;
      }
      return { variableCollectionUpsert: true };
    },
  });
  assert.equal(result.state, 'off');
  const mutation = calls.find(({ query }) =>
    query.includes('mutation RealtimeVoiceTraceV2Variables'),
  );
  assert.equal(mutation.variables.input.replace, true);
  assert.equal(mutation.variables.input.skipDeploys, true);
  assert.deepEqual(mutation.variables.input.variables, afterVariables);
  assert.doesNotThrow(() => assertRealtimeVoiceTraceV2RailwayOff(decoded(afterVariables)));
});

test('force-off nettoie un bloc partiel mais refuse de masquer une mutation concurrente', async () => {
  const partialVariables = {
    ...prerequisites(),
    VOICE_TRACE_REALTIME_V2_ENABLED: 'true',
    [REALTIME_VOICE_TRACE_V2_OWNER]: REALTIME_VOICE_TRACE_V2_OWNER_VALUE,
  };
  const partial = railwayState(partialVariables);
  const off = railwayState(prerequisites());
  let reads = 0;
  const result = await runRealtimeVoiceTraceV2RailwayCommand('force-off', environment(), {
    graphql: async (_config, query) => {
      if (query.includes('query RealtimeVoiceTraceV2State')) {
        reads += 1;
        return reads <= 2 ? partial : off;
      }
      return { variableCollectionUpsert: true };
    },
  });
  assert.equal(result.state, 'off');

  reads = 0;
  await assert.rejects(
    runRealtimeVoiceTraceV2RailwayCommand('force-off', environment(), {
      graphql: async (_config, query) => {
        if (!query.includes('query RealtimeVoiceTraceV2State')) {
          return { variableCollectionUpsert: true };
        }
        reads += 1;
        return reads === 1 ? partial : railwayState({ ...partialVariables, UNRELATED: 'raced' });
      },
    }),
    /changed concurrently/u,
  );
});
