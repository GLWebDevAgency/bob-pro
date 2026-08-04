import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverRailwayDeploymentRegistration,
  parseRailwayReleaseDeploymentEnvironment,
  parseRailwayReleaseRecoveryRoute,
  parseRailwayServingDeploymentId,
  parseRailwayTargetIdentity,
  parseRailwayUpDeploymentId,
  railwayDeploymentGraphql,
  waitForRailwayDeployment,
} from './railway-release-deployment.mjs';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const DEPLOYMENT_ID = '44444444-4444-4444-8444-444444444444';
const INSTANCE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_DEPLOYMENT_ID = '66666666-6666-4666-8666-666666666666';

function environment(overrides = {}) {
  return {
    RAILWAY_TOKEN: 'railway-project-access-token',
    RAILWAY_PROJECT_ID: PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
    RAILWAY_API_SERVICE_ID: SERVICE_ID,
    TARGET_ENVIRONMENT_NAME: 'staging',
    ...overrides,
  };
}

function recoveryRouteEnvironment(overrides = {}) {
  return {
    RELEASE_PURPOSE: 'release-recovery',
    RELEASE_ENVIRONMENT: 'staging',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    CALLER_WORKFLOW_REF: 'owner/repo/.github/workflows/railway-api.yml@refs/heads/main',
    EXPECTED_DIRECT_RECOVERY_REF: 'owner/repo/.github/workflows/railway-api.yml@refs/heads/main',
    RELEASE_REF: 'refs/heads/main',
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    token: 'railway-project-access-token',
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    environmentName: 'staging',
    ...overrides,
  };
}

function deployment(status, overrides = {}) {
  return {
    id: DEPLOYMENT_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    status,
    deploymentStopped: false,
    instances: [],
    ...overrides,
  };
}

function registrationCandidate(id, overrides = {}) {
  return {
    id,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    status: 'QUEUED',
    ...overrides,
  };
}

function registrationPage(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return {
    deployments: {
      edges: nodes.map((node) => ({ node })),
      pageInfo: { hasNextPage, endCursor },
    },
  };
}

function railwayStatus(activeOverrides = {}, latestOverrides = {}) {
  const active = {
    id: DEPLOYMENT_ID,
    status: 'SUCCESS',
    deploymentStopped: false,
    instances: [{ id: INSTANCE_ID, status: 'RUNNING' }],
    ...activeOverrides,
  };
  return {
    id: PROJECT_ID,
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
                    serviceName: 'bob-pro-api',
                    activeDeployments: [active],
                    latestDeployment: { ...active, ...latestOverrides },
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

test('valide un bloc Railway complet et fermé à staging/production', () => {
  assert.deepEqual(parseRailwayReleaseDeploymentEnvironment(environment()), config());
  assert.equal(
    parseRailwayReleaseDeploymentEnvironment(environment({ TARGET_ENVIRONMENT_NAME: 'production' }))
      .environmentName,
    'production',
  );
  for (const [name, value] of [
    ['RAILWAY_TOKEN', 'short'],
    ['RAILWAY_PROJECT_ID', 'not-a-uuid'],
    ['RAILWAY_ENVIRONMENT_ID', 'not-a-uuid'],
    ['RAILWAY_API_SERVICE_ID', 'not-a-uuid'],
    ['TARGET_ENVIRONMENT_NAME', 'preview'],
  ]) {
    assert.throws(
      () => parseRailwayReleaseDeploymentEnvironment(environment({ [name]: value })),
      new RegExp(name, 'u'),
    );
  }
});

test('réserve release-recovery au dispatch direct staging de railway-api sur main', () => {
  assert.deepEqual(parseRailwayReleaseRecoveryRoute(recoveryRouteEnvironment()), {
    purpose: 'release-recovery',
    recovery: true,
    environmentName: 'staging',
    workflowRef: 'owner/repo/.github/workflows/railway-api.yml@refs/heads/main',
    ref: 'refs/heads/main',
  });
  assert.deepEqual(parseRailwayReleaseRecoveryRoute({ RELEASE_PURPOSE: 'release' }), {
    purpose: 'release',
    recovery: false,
  });
  for (const [name, value, expected] of [
    ['GITHUB_EVENT_NAME', 'workflow_call', /workflow_dispatch/u],
    [
      'CALLER_WORKFLOW_REF',
      'owner/repo/.github/workflows/cabinet-release.yml@refs/heads/main',
      /reusable workflow callers/u,
    ],
    ['RELEASE_REF', 'refs/heads/release-candidate', /requires main/u],
    ['RELEASE_ENVIRONMENT', 'production', /staging-only/u],
  ]) {
    assert.throws(
      () => parseRailwayReleaseRecoveryRoute(recoveryRouteEnvironment({ [name]: value })),
      expected,
    );
  }
});

test('parse uniquement le deploymentId UUID de railway up', () => {
  assert.equal(
    parseRailwayUpDeploymentId(
      JSON.stringify({
        deploymentId: DEPLOYMENT_ID,
        logsUrl: 'https://railway.example/deployment',
      }),
    ),
    DEPLOYMENT_ID,
  );
  assert.throws(() => parseRailwayUpDeploymentId('{}'), /deploymentId/u);
  assert.throws(() => parseRailwayUpDeploymentId('not-json'), /invalid JSON/u);
});

test('prouve le mapping project/environnement/service avant toute mutation', () => {
  const targetConfig = { ...config(), serviceName: 'bob-pro-api' };
  assert.deepEqual(parseRailwayTargetIdentity(railwayStatus(), targetConfig), {
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
  });
  assert.throws(
    () => parseRailwayTargetIdentity(railwayStatus(), { ...targetConfig, projectId: INSTANCE_ID }),
    /expected project/u,
  );
  assert.throws(
    () =>
      parseRailwayTargetIdentity(railwayStatus(), {
        ...targetConfig,
        environmentName: 'production',
      }),
    /expected environment/u,
  );
  assert.throws(
    () =>
      parseRailwayTargetIdentity(railwayStatus(), {
        ...targetConfig,
        serviceId: INSTANCE_ID,
      }),
    /service identity/u,
  );
  assert.throws(
    () =>
      parseRailwayTargetIdentity(railwayStatus(), {
        ...targetConfig,
        serviceName: 'bob-archive-audit',
      }),
    /service identity/u,
  );
  assert.throws(
    () =>
      parseRailwayTargetIdentity(
        railwayStatus(
          {},
          {
            id: OTHER_DEPLOYMENT_ID,
            status: 'FAILED',
            deploymentStopped: true,
            instances: [],
          },
        ),
        targetConfig,
      ),
    /latest deployment is not the exact serving deployment/u,
  );
  assert.deepEqual(
    parseRailwayTargetIdentity(
      railwayStatus(
        {},
        {
          id: OTHER_DEPLOYMENT_ID,
          status: 'FAILED',
          deploymentStopped: true,
          instances: [],
        },
      ),
      targetConfig,
      { allowStableTerminalLatest: true },
    ),
    {
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
    },
  );
});

test('la release exige latest == active et réserve le repli terminal au recovery explicite', () => {
  assert.equal(parseRailwayServingDeploymentId(railwayStatus(), config()), DEPLOYMENT_ID);
  const failedLatest = railwayStatus(
    {},
    {
      id: OTHER_DEPLOYMENT_ID,
      status: 'FAILED',
      deploymentStopped: true,
      instances: [],
    },
  );
  assert.throws(
    () => parseRailwayServingDeploymentId(failedLatest, config()),
    /latest deployment is not the exact serving deployment/u,
  );
  assert.equal(
    parseRailwayServingDeploymentId(failedLatest, config(), {
      allowStableTerminalLatest: true,
    }),
    DEPLOYMENT_ID,
  );
  assert.throws(
    () =>
      parseRailwayServingDeploymentId(failedLatest, config(), {
        allowStableTerminalLatest: 'yes',
      }),
    /must be boolean/u,
  );
  assert.throws(
    () =>
      parseRailwayServingDeploymentId(
        railwayStatus({}, { id: OTHER_DEPLOYMENT_ID, status: 'BUILDING' }),
        config(),
        { allowStableTerminalLatest: true },
      ),
    /stable terminal failure/u,
  );
  assert.throws(
    () =>
      parseRailwayServingDeploymentId(
        railwayStatus({ instances: [{ id: INSTANCE_ID, status: 'EXITED' }] }),
        config(),
      ),
    /one exact serving deployment/u,
  );
  assert.throws(
    () =>
      parseRailwayServingDeploymentId(railwayStatus(), config({ environmentName: 'production' })),
    /expected environment/u,
  );
});

test('découvre l’UUID exact par pagination bornée et identité scellée', async () => {
  const calls = [];
  const found = await discoverRailwayDeploymentRegistration(DEPLOYMENT_ID, config(), {
    graphql: async (_config, query, variables) => {
      calls.push({ query, variables });
      if (calls.length === 1) {
        return registrationPage([registrationCandidate(OTHER_DEPLOYMENT_ID)], {
          hasNextPage: true,
          endCursor: 'cursor-1',
        });
      }
      return registrationPage([registrationCandidate(DEPLOYMENT_ID)]);
    },
  });
  assert.equal(found, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].query, /BobReleaseDeploymentRegistration/u);
  assert.deepEqual(calls[0].variables, {
    input: {
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      includeDeleted: true,
    },
    first: 100,
    after: null,
  });
  assert.equal(calls[1].variables.after, 'cursor-1');

  assert.equal(
    await discoverRailwayDeploymentRegistration(DEPLOYMENT_ID, config(), {
      graphql: async () => registrationPage([registrationCandidate(OTHER_DEPLOYMENT_ID)]),
    }),
    false,
  );
  await assert.rejects(
    discoverRailwayDeploymentRegistration(DEPLOYMENT_ID, config(), {
      graphql: async () =>
        registrationPage([
          registrationCandidate(OTHER_DEPLOYMENT_ID, { environmentId: INSTANCE_ID }),
        ]),
    }),
    /invalid or cross-scoped/u,
  );
  await assert.rejects(
    discoverRailwayDeploymentRegistration(DEPLOYMENT_ID, config(), {
      graphql: async () =>
        registrationPage([registrationCandidate(OTHER_DEPLOYMENT_ID)], {
          hasNextPage: true,
          endCursor: 'same-cursor',
        }),
    }),
    /duplicate deployment|cursor is invalid or repeated/u,
  );
});

test('attend tous les états transitoires puis accepte SUCCESS pour la même identité', async () => {
  const statuses = ['QUEUED', 'WAITING', 'BUILDING', 'DEPLOYING', 'INITIALIZING', 'SUCCESS'];
  const sleeps = [];
  const result = await waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
    attempts: statuses.length,
    pollMilliseconds: 1,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    discoverDeployment: async () => true,
    graphql: async () => ({ deployment: deployment(statuses.shift()) }),
  });
  assert.deepEqual(result, { deploymentId: DEPLOYMENT_ID, status: 'SUCCESS' });
  assert.deepEqual(sleeps, [1, 1, 1, 1, 1]);
});

test('tolère uniquement la fenêtre bornée d’enregistrement du nouvel UUID', async () => {
  const registrations = [false, true];
  const statuses = ['QUEUED', 'SUCCESS'];
  const result = await waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
    attempts: 3,
    pollMilliseconds: 1,
    sleep: async () => undefined,
    discoverDeployment: async () => registrations.shift() ?? true,
    graphql: async () => ({ deployment: deployment(statuses.shift()) }),
  });
  assert.deepEqual(result, { deploymentId: DEPLOYMENT_ID, status: 'SUCCESS' });

  let clock = 1_000;
  await assert.rejects(
    waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
      attempts: 10,
      pollMilliseconds: 10_000,
      waitTimeoutMilliseconds: 120_000,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      discoverDeployment: async () => false,
    }),
    /bounded discovery window/u,
  );
  assert.equal(clock, 61_000);
});

test('la deadline de découverte borne aussi Retry-After avant l’enregistrement', async () => {
  let clock = 1_000;
  let requests = 0;
  await assert.rejects(
    waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
      attempts: 10,
      waitTimeoutMilliseconds: 120_000,
      now: () => clock,
      nowEpochMilliseconds: () => 1_800_000_000_000,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      fetchImpl: async () => {
        requests += 1;
        return new Response('', { status: 429, headers: { 'retry-after': '60' } });
      },
    }),
    /bounded discovery window/u,
  );
  assert.equal(requests, 1);
  assert.equal(clock, 61_000);
});

test('échoue fermé sur identité, état terminal, état inconnu et timeout', async () => {
  await assert.rejects(
    waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
      attempts: 1,
      discoverDeployment: async () => true,
      graphql: async () => ({ deployment: deployment('SUCCESS', { serviceId: INSTANCE_ID }) }),
    }),
    /identity/u,
  );
  await assert.rejects(
    waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
      attempts: 1,
      discoverDeployment: async () => true,
      graphql: async () => ({ deployment: deployment('FAILED') }),
    }),
    /terminal status FAILED/u,
  );
  await assert.rejects(
    waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
      attempts: 1,
      discoverDeployment: async () => true,
      graphql: async () => ({ deployment: deployment('PAUSED') }),
    }),
    /unknown status/u,
  );
  await assert.rejects(
    waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
      attempts: 2,
      pollMilliseconds: 1,
      sleep: async () => undefined,
      discoverDeployment: async () => true,
      graphql: async () => ({ deployment: deployment('BUILDING') }),
    }),
    /bounded window/u,
  );
  await assert.rejects(
    waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
      attempts: 1,
      discoverDeployment: async () => true,
      graphql: async () => ({ deployment: null }),
    }),
    /identity/u,
  );
});

test('GraphQL rejoue seulement les erreurs de transport transitoires', async () => {
  let attempts = 0;
  const sleeps = [];
  const result = await railwayDeploymentGraphql(
    config(),
    'query Test { ok }',
    {},
    {
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      fetchImpl: async (_url, options) => {
        attempts += 1;
        assert.equal(options.headers['Project-Access-Token'], config().token);
        if (attempts === 1) {
          return new Response('', { status: 429, headers: { 'retry-after': '7' } });
        }
        return Response.json({ data: { ok: true } });
      },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [7_000]);

  attempts = 0;
  await assert.rejects(
    railwayDeploymentGraphql(
      config(),
      'query Test { ok }',
      {},
      {
        sleep: async () => undefined,
        fetchImpl: async () => {
          attempts += 1;
          return new Response('', { status: 401 });
        },
      },
    ),
    /HTTP 401/u,
  );
  assert.equal(attempts, 1);
});

test('une fenêtre GraphQL transitoire n’acquitte ni ne recrée le déploiement', async () => {
  let requests = 0;
  const sleeps = [];
  const result = await waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
    attempts: 2,
    graphqlAttempts: 3,
    pollMilliseconds: 1,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    discoverDeployment: async () => true,
    fetchImpl: async () => {
      requests += 1;
      if (requests <= 3) return new Response('', { status: 503 });
      return Response.json({ data: { deployment: deployment('SUCCESS') } });
    },
  });
  assert.deepEqual(result, { deploymentId: DEPLOYMENT_ID, status: 'SUCCESS' });
  assert.equal(requests, 4);
  assert.deepEqual(sleeps, [1_000, 2_000, 1]);
});

test('le budget absolu borne Retry-After et tout le polling', async () => {
  let clock = 1_000;
  await assert.rejects(
    waitForRailwayDeployment(DEPLOYMENT_ID, config(), {
      attempts: 2,
      waitTimeoutMilliseconds: 5_000,
      now: () => clock,
      nowEpochMilliseconds: () => 1_800_000_000_000,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      discoverDeployment: async () => true,
      fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
    }),
    /absolute deadline/u,
  );
  assert.equal(clock, 6_000);
});

test('GraphQL refuse une enveloppe invalide ou surdimensionnée', async () => {
  await assert.rejects(
    railwayDeploymentGraphql(
      config(),
      'query Test { ok }',
      {},
      {
        fetchImpl: async () => Response.json({ errors: [{ message: 'denied' }] }),
      },
    ),
    /rejected/u,
  );
  await assert.rejects(
    railwayDeploymentGraphql(
      config(),
      'query Test { ok }',
      {},
      {
        fetchImpl: async () => new Response('x'.repeat(1_048_577)),
      },
    ),
    /size limit/u,
  );
});
