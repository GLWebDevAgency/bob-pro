import assert from 'node:assert/strict';
import test from 'node:test';
import {
  certifyWhisperStagingPreflight,
  parseWhisperStagingEnvironment,
  runWhisperStagingPreflight,
  waitForWhisperStagingDeployment,
} from './agent-mission-m1b-staging-whisper.mjs';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const API_SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const WHISPER_SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT_ID = '55555555-5555-4555-8555-555555555555';
const RELEASE_SHA = 'a'.repeat(40);
const TOKEN = 'w'.repeat(48);

function environment(overrides = {}) {
  return {
    RAILWAY_TOKEN: 'railway-project-token-for-staging',
    RAILWAY_PROJECT_ID: PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
    RAILWAY_API_SERVICE_ID: API_SERVICE_ID,
    RAILWAY_WHISPER_AUDIT_SERVICE_ID: WHISPER_SERVICE_ID,
    BOB_M1B_RELEASE_SHA: RELEASE_SHA,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    projectToken: {
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
    },
    service: {
      id: WHISPER_SERVICE_ID,
      name: 'bob-live-whisper-audit',
      projectId: PROJECT_ID,
    },
    environment: {
      id: ENVIRONMENT_ID,
      name: 'staging',
      volumeInstances: {
        edges: [],
        pageInfo: {
          hasNextPage: false,
        },
      },
    },
    serviceInstance: {
      id: '66666666-6666-4666-8666-666666666666',
      serviceId: WHISPER_SERVICE_ID,
      environmentId: ENVIRONMENT_ID,
      railwayConfigFile: '/railway.whisper-audit.json',
      startCommand: null,
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile.whisper-audit',
      preDeployCommand: null,
      cronSchedule: null,
      sleepApplication: false,
      healthcheckPath: '/v1/health',
      healthcheckTimeout: 180,
      numReplicas: 1,
      drainingSeconds: 30,
      overlapSeconds: 30,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
    },
    serviceInstanceAutoDeployStatus: { enabled: false },
    domains: {
      serviceDomains: [],
      customDomains: [],
    },
    tcpProxies: [],
    auditorVariables: {
      BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN,
    },
    apiVariables: {
      BOB_LIVE_ENABLED: 'true',
      BOB_LIVE_PROVIDER: 'openai',
      BOB_LIVE_SPEECH_DELIVERY: 'audited-signed-url-v1',
      BOB_LIVE_AUDIT_PROVIDER: 'local-whisper',
      BOB_LIVE_LOCAL_AUDIT_BASE_URL: 'http://bob-live-whisper-audit.railway.internal:8080/v1',
      BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN,
      OPENAI_API_KEY: 'sk-staging-openai-not-logged',
    },
    ...overrides,
  };
}

test('parse une cible privée distincte et le SHA exact', () => {
  assert.equal(parseWhisperStagingEnvironment(environment()).serviceId, WHISPER_SERVICE_ID);
  assert.throws(
    () =>
      parseWhisperStagingEnvironment(
        environment({
          RAILWAY_WHISPER_AUDIT_SERVICE_ID: API_SERVICE_ID,
        }),
      ),
    /distinct Railway services/u,
  );
  assert.throws(
    () =>
      parseWhisperStagingEnvironment(
        environment({
          BOB_M1B_RELEASE_SHA: 'A'.repeat(40),
        }),
      ),
    /lowercase 40-hex/u,
  );
});

test('certifie identité, config-as-code, réseau privé et isolation des variables', () => {
  const config = parseWhisperStagingEnvironment(environment());
  assert.deepEqual(certifyWhisperStagingPreflight(payload(), config), {
    serviceId: WHISPER_SERVICE_ID,
    environmentId: ENVIRONMENT_ID,
    releaseSha: RELEASE_SHA,
    privateOnly: true,
    variablesIsolated: true,
    speechDelivery: 'audited-signed-url-v1',
  });
});

for (const [label, override, pattern] of [
  [
    'domaine public',
    {
      domains: {
        serviceDomains: [{ id: 'x', domain: 'public.up.railway.app' }],
        customDomains: [],
      },
    },
    /no public/u,
  ],
  ['proxy TCP', { tcpProxies: [{ id: 'x' }] }, /no public/u],
  [
    'mauvais Dockerfile',
    { serviceInstance: { ...payload().serviceInstance, dockerfilePath: 'Dockerfile' } },
    /configuration drifted/u,
  ],
  [
    'autodeploy actif',
    { serviceInstanceAutoDeployStatus: { enabled: true } },
    /configuration drifted/u,
  ],
  [
    'secret provider hérité',
    { auditorVariables: { BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN, OPENAI_API_KEY: 'forbidden' } },
    /exactly one/u,
  ],
  [
    'secret auditeur réutilisé par OpenAI',
    { apiVariables: { ...payload().apiVariables, OPENAI_API_KEY: TOKEN } },
    /dedicated and not reused/u,
  ],
  [
    'token discordant',
    { auditorVariables: { BOB_LIVE_LOCAL_AUDIT_TOKEN: 'z'.repeat(48) } },
    /incomplete or divergent/u,
  ],
  [
    'transport natif',
    {
      apiVariables: {
        ...payload().apiVariables,
        BOB_LIVE_SPEECH_DELIVERY: 'openai-native-webrtc-v1',
      },
    },
    /incomplete or divergent/u,
  ],
  [
    'URL loopback',
    {
      apiVariables: {
        ...payload().apiVariables,
        BOB_LIVE_LOCAL_AUDIT_BASE_URL: 'http://127.0.0.1:8080/v1',
      },
    },
    /incomplete or divergent/u,
  ],
  [
    'inventaire volumes absent',
    { environment: { ...payload().environment, volumeInstances: undefined } },
    /volume inventory is unavailable/u,
  ],
  [
    'inventaire volumes paginé',
    {
      environment: {
        ...payload().environment,
        volumeInstances: { edges: [], pageInfo: { hasNextPage: true } },
      },
    },
    /volume inventory is unavailable/u,
  ],
  [
    'volume persistant attaché',
    {
      environment: {
        ...payload().environment,
        volumeInstances: {
          edges: [
            {
              node: {
                serviceId: WHISPER_SERVICE_ID,
                environmentId: ENVIRONMENT_ID,
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    },
    /no persistent volume/u,
  ],
]) {
  test(`refuse ${label}`, () => {
    const config = parseWhisperStagingEnvironment(environment());
    assert.throws(() => certifyWhisperStagingPreflight(payload(override), config), pattern);
  });
}

test('commande preflight adresse les deux services sans exposer leurs secrets', async () => {
  const calls = [];
  const result = await runWhisperStagingPreflight(environment(), {
    graphql: async (_config, query, variables) => {
      calls.push({ query, variables });
      return payload();
    },
  });
  assert.equal(result.privateOnly, true);
  assert.deepEqual(calls[0].variables, {
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: WHISPER_SERVICE_ID,
    apiServiceId: API_SERVICE_ID,
  });
  assert.match(calls[0].query, /volumeInstances\(first: 500\)/u);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('attend exactement le deployment Whisper candidat jusqu’à SUCCESS', async () => {
  let reads = 0;
  const graphql = async () => ({
    deployment: {
      id: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: WHISPER_SERVICE_ID,
      status: ++reads === 1 ? 'BUILDING' : 'SUCCESS',
    },
  });
  await assert.doesNotReject(
    waitForWhisperStagingDeployment(DEPLOYMENT_ID, environment(), {
      graphql,
      sleep: async () => undefined,
      attempts: 2,
    }),
  );
  assert.equal(reads, 2);
  await assert.rejects(
    waitForWhisperStagingDeployment(DEPLOYMENT_ID, environment(), {
      graphql: async () => ({
        deployment: {
          id: DEPLOYMENT_ID,
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          serviceId: API_SERVICE_ID,
          status: 'SUCCESS',
        },
      }),
      attempts: 1,
    }),
    /identity is unavailable or mismatched/u,
  );
});
