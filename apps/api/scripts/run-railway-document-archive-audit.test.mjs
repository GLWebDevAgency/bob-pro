import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  ArchiveAuditBusinessRefusalError,
  ArchiveAuditCancellationError,
  ArchiveAuditTerminalEvidenceError,
  cleanupRailwayDocumentArchiveAuditDeployments,
  extractArchiveAuditEvidence,
  runRailwayDocumentArchiveAudit,
  runRailwayDocumentArchiveAuditCommand,
} from './run-railway-document-archive-audit.mjs';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const SERVICE_ID = '20000000-0000-4000-8000-000000000002';
const ENVIRONMENT_ID = '30000000-0000-4000-8000-000000000003';
const OTHER_ENVIRONMENT_ID = '30000000-0000-4000-8000-000000000004';
const DEPLOYMENT_ID = '40000000-0000-4000-8000-000000000005';
const OTHER_DEPLOYMENT_ID = '40000000-0000-4000-8000-000000000006';
const RELEASE_SHA = 'a'.repeat(40);
const DIGEST_A = '1'.repeat(64);
const DIGEST_B = '2'.repeat(64);
const DIGEST_C = '3'.repeat(64);
const EVIDENCE_PREFIX = 'BOB_DOCUMENT_ARCHIVE_AUDIT_EVIDENCE=';
const SCRIPT_PATH = fileURLToPath(
  new URL('./run-railway-document-archive-audit.mjs', import.meta.url),
);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function evidenceFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    deploymentId: DEPLOYMENT_ID,
    releaseSha: RELEASE_SHA,
    readyForActivation: true,
    protocolVersion: 1,
    mode: 'apply-attestations',
    inventoryDigest: DIGEST_A,
    reportSha256: DIGEST_B,
    validatorEvidenceDigest: DIGEST_C,
    issueCodes: [],
    counts: {
      appliedAttestations: 4,
      existingAttestations: 8,
      externallyValidatedProfessionalInvoices: 7,
      generatedLegalDocuments: 12,
      missingStoredObjects: 0,
      objectsRead: 19,
      p0Issues: 0,
      storageOrphans: 0,
    },
    validators: {
      representationDetector: 1,
      mustang: '2.24.0',
      fnfe: '1.4.0.02',
    },
    ...overrides,
  };
}

function refusalFixture(overrides = {}) {
  return evidenceFixture({
    readyForActivation: false,
    issueCodes: ['SQL_REFERENCE_WITHOUT_STORAGE_OBJECT'],
    counts: {
      ...evidenceFixture().counts,
      missingStoredObjects: 1,
      p0Issues: 1,
    },
    ...overrides,
  });
}

function serviceInstanceFixture(overrides = {}) {
  return {
    id: '50000000-0000-4000-8000-000000000006',
    serviceId: SERVICE_ID,
    environmentId: ENVIRONMENT_ID,
    railwayConfigFile: '/railway.archive-audit.json',
    startCommand: '/usr/local/bin/bob-archive-audit-entrypoint',
    builder: 'DOCKERFILE',
    dockerfilePath: 'Dockerfile.archive-audit',
    preDeployCommand: null,
    cronSchedule: null,
    sleepApplication: false,
    healthcheckPath: null,
    healthcheckTimeout: null,
    numReplicas: 1,
    drainingSeconds: 30,
    overlapSeconds: 0,
    restartPolicyType: 'NEVER',
    restartPolicyMaxRetries: 10,
    ...overrides,
  };
}

function deploymentSnapshotFixture({
  id = DEPLOYMENT_ID,
  status = 'BUILDING',
  commitHash = RELEASE_SHA,
  overrides = {},
} = {}) {
  return {
    id,
    projectId: PROJECT_ID,
    serviceId: SERVICE_ID,
    environmentId: ENVIRONMENT_ID,
    status,
    meta: commitHash === null ? {} : { commitHash },
    deploymentStopped: false,
    instances: [],
    ...overrides,
  };
}

function stoppedDeploymentSnapshotFixture({ id = DEPLOYMENT_ID, commitHash = RELEASE_SHA } = {}) {
  return deploymentSnapshotFixture({
    id,
    status: 'REMOVED',
    commitHash,
    overrides: { deploymentStopped: true, instances: [] },
  });
}

function drainingDeploymentSnapshotFixture({
  id = DEPLOYMENT_ID,
  commitHash = RELEASE_SHA,
  instanceStatus = 'RUNNING',
} = {}) {
  return deploymentSnapshotFixture({
    id,
    status: 'SUCCESS',
    commitHash,
    overrides: {
      deploymentStopped: true,
      instances: [{ id: '60000000-0000-4000-8000-000000000012', status: instanceStatus }],
    },
  });
}

function unacknowledgedRunningDeploymentSnapshotFixture({
  id = DEPLOYMENT_ID,
  commitHash = RELEASE_SHA,
} = {}) {
  return deploymentSnapshotFixture({
    id,
    status: 'SUCCESS',
    commitHash,
    overrides: {
      deploymentStopped: false,
      instances: [{ id: '60000000-0000-4000-8000-000000000012', status: 'RUNNING' }],
    },
  });
}

function marker(evidence = evidenceFixture()) {
  return `${EVIDENCE_PREFIX}${Buffer.from(JSON.stringify(evidence), 'utf8').toString('base64url')}`;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function dataResponse(data) {
  return jsonResponse({ data });
}

function operationName(query) {
  return [
    'ArchiveAuditDeploymentCancel',
    'ArchiveAuditDeploymentStop',
    'ArchiveAuditDeploymentsSnapshot',
    'ArchiveAuditServiceInstance',
    'ArchiveAuditDeployment',
    'ArchiveAuditLogs',
    'DeployArchiveAudit',
    'ProjectToken',
  ].find((name) => query.includes(name));
}

function scriptedFetch(steps) {
  const remaining = [...steps];
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://backboard.railway.com/graphql/v2');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.headers?.['Content-Type'], 'application/json');
    assert.equal(init?.headers?.['Project-Access-Token'], 'railway-project-token');
    const body = JSON.parse(init.body);
    const operation = operationName(body.query);
    const step = remaining.shift();
    assert.ok(step, `unexpected GraphQL operation ${operation}`);
    assert.equal(operation, step.operation);
    calls.push({ operation, variables: body.variables });
    step.assertVariables?.(body.variables);
    step.before?.(body.variables);
    if (step.throw) throw step.throw;
    return typeof step.response === 'function' ? step.response() : step.response;
  };
  fetchImpl.calls = calls;
  fetchImpl.assertDone = () => assert.equal(remaining.length, 0, 'all scripted calls must run');
  return fetchImpl;
}

function projectStep(overrides = {}) {
  return {
    operation: 'ProjectToken',
    response: dataResponse({
      projectToken: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID },
    }),
    ...overrides,
  };
}

function serviceInstanceStep(
  instance = serviceInstanceFixture(),
  autoDeployStatus = { enabled: false },
) {
  return {
    operation: 'ArchiveAuditServiceInstance',
    assertVariables: (variables) =>
      assert.deepEqual(variables, {
        projectId: PROJECT_ID,
        serviceId: SERVICE_ID,
        environmentId: ENVIRONMENT_ID,
      }),
    response: dataResponse({
      serviceInstance: instance,
      serviceInstanceAutoDeployStatus: autoDeployStatus,
    }),
  };
}

function deploymentSnapshotStep(
  deployments = [],
  { after = null, hasNextPage = false, endCursor = null, ...overrides } = {},
) {
  return {
    operation: 'ArchiveAuditDeploymentsSnapshot',
    assertVariables: (variables) =>
      assert.deepEqual(variables, {
        input: {
          projectId: PROJECT_ID,
          serviceId: SERVICE_ID,
          environmentId: ENVIRONMENT_ID,
          includeDeleted: true,
        },
        first: 100,
        after,
      }),
    response: dataResponse({
      deployments: {
        edges: deployments.map((deployment) => ({ node: deployment })),
        pageInfo: { hasNextPage, endCursor },
      },
    }),
    ...overrides,
  };
}

function deployStep(overrides = {}) {
  return {
    operation: 'DeployArchiveAudit',
    assertVariables: (variables) =>
      assert.deepEqual(variables, {
        serviceId: SERVICE_ID,
        environmentId: ENVIRONMENT_ID,
        commitSha: RELEASE_SHA,
      }),
    response: dataResponse({ serviceInstanceDeployV2: DEPLOYMENT_ID }),
    ...overrides,
  };
}

function deploymentStep(status, deploymentOverrides = {}) {
  const instances =
    status === 'SUCCESS'
      ? [{ id: '60000000-0000-4000-8000-000000000012', status: 'EXITED' }]
      : [];
  return {
    operation: 'ArchiveAuditDeployment',
    assertVariables: (variables) => assert.deepEqual(variables, { id: DEPLOYMENT_ID }),
    response: dataResponse({
      deployment: {
        id: DEPLOYMENT_ID,
        status,
        deploymentStopped: false,
        instances,
        ...deploymentOverrides,
      },
    }),
  };
}

function logsStep(logs = [{ message: marker() }]) {
  return {
    operation: 'ArchiveAuditLogs',
    assertVariables: (variables) =>
      assert.deepEqual(variables, {
        deploymentId: DEPLOYMENT_ID,
        limit: 2_000,
        filter: EVIDENCE_PREFIX,
      }),
    response: dataResponse({ deploymentLogs: logs }),
  };
}

function cleanupStep(kind, response = true, deploymentId = DEPLOYMENT_ID) {
  return {
    operation: kind === 'cancel' ? 'ArchiveAuditDeploymentCancel' : 'ArchiveAuditDeploymentStop',
    assertVariables: (variables) => assert.deepEqual(variables, { id: deploymentId }),
    response: dataResponse({
      [kind === 'cancel' ? 'deploymentCancel' : 'deploymentStop']: response,
    }),
  };
}

function beforeDeploymentSteps() {
  return [projectStep(), serviceInstanceStep(), deploymentSnapshotStep(), deployStep()];
}

function successSteps({
  status = 'SUCCESS',
  logs = [{ message: marker() }],
  successfulObservations = 2,
} = {}) {
  return [
    ...beforeDeploymentSteps(),
    ...Array.from({ length: successfulObservations }, () => [
      deploymentStep(status),
      logsStep(logs),
    ]).flat(),
  ];
}

function baseEnvironment(outputPath, overrides = {}) {
  return {
    RAILWAY_TOKEN: 'railway-project-token',
    RAILWAY_ARCHIVE_AUDIT_SERVICE_ID: SERVICE_ID,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
    RELEASE_SHA,
    DOCUMENT_ARCHIVE_AUDIT_CI_EVIDENCE: outputPath,
    DOCUMENT_ARCHIVE_AUDIT_TIMEOUT_SECONDS: '60',
    DOCUMENT_ARCHIVE_AUDIT_POLL_SECONDS: '10',
    ...overrides,
  };
}

function fakeRuntime() {
  let milliseconds = 0;
  const sleeps = [];
  const requestTimeouts = [];
  let output = '';
  return {
    advance: (duration) => {
      milliseconds += duration;
    },
    elapsed: () => milliseconds,
    now: () => milliseconds,
    requestTimeoutSignal: (duration) => {
      requestTimeouts.push(duration);
      return undefined;
    },
    sleep: async (duration) => {
      sleeps.push(duration);
      milliseconds += duration;
    },
    stdout: {
      write: (value) => {
        output += value;
        return true;
      },
    },
    requestTimeouts,
    sleeps,
    output: () => output,
  };
}

async function temporaryOutput(t, name = 'evidence.json') {
  const directory = await mkdtemp(join(tmpdir(), 'bob-railway-audit-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'nested', name);
}

test('préflight exact puis preuve prête corrélée, non-PII et immuable côté CI', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch(successSteps());
  const runtime = fakeRuntime();

  const evidence = await runRailwayDocumentArchiveAudit({
    environment: baseEnvironment(outputPath),
    fetchImpl,
    ...runtime,
  });

  assert.deepEqual(evidence, evidenceFixture());
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.operation),
    [
      'ProjectToken',
      'ArchiveAuditServiceInstance',
      'ArchiveAuditDeploymentsSnapshot',
      'DeployArchiveAudit',
      'ArchiveAuditDeployment',
      'ArchiveAuditLogs',
      'ArchiveAuditDeployment',
      'ArchiveAuditLogs',
    ],
  );
  fetchImpl.assertDone();
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), evidenceFixture());
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(runtime.output()), {
    deploymentId: DEPLOYMENT_ID,
    status: 'SUCCESS',
    evidencePath: resolve(outputPath),
  });
});

test('refuse toute dérive du service Railway avant la mutation', async (t) => {
  const driftCases = [
    ['config-file', { railwayConfigFile: '/railway.json' }, /railwayConfigFile/u],
    ['start-command', { startCommand: 'node server.js' }, /startCommand/u],
    // Schéma Railway moderne : RAILPACK + dockerfilePath exact = build Dockerfile légitime ;
    // la dérive de builder ne se prouve donc qu'avec un builder NON adossé à notre Dockerfile
    // (NIXPACKS) ou un RAILPACK dont le dockerfilePath diverge (cas « dockerfile » ci-dessous).
    ['builder', { builder: 'NIXPACKS' }, /builder/u],
    ['dockerfile', { dockerfilePath: 'Dockerfile' }, /dockerfilePath/u],
    ['pre-deploy', { preDeployCommand: ['pnpm', 'migrate'] }, /preDeployCommand/u],
    ['cron', { cronSchedule: '0 0 * * *' }, /cronSchedule/u],
    ['sleep', { sleepApplication: true }, /sleepApplication/u],
    ['healthcheck', { healthcheckPath: '/health' }, /healthcheckPath/u],
    ['healthcheck-timeout', { healthcheckTimeout: 30 }, /healthcheckTimeout/u],
    ['replicas', { numReplicas: 2 }, /numReplicas/u],
    ['draining', { drainingSeconds: 0 }, /drainingSeconds/u],
    ['overlap', { overlapSeconds: 1 }, /overlapSeconds/u],
    ['restart', { restartPolicyType: 'ON_FAILURE' }, /restartPolicyType/u],
    ['restart-retries', { restartPolicyMaxRetries: -1 }, /restartPolicyMaxRetries/u],
    ['wrong-service', { serviceId: '50000000-0000-4000-8000-000000000099' }, /another service/u],
    ['wrong-environment', { environmentId: OTHER_ENVIRONMENT_ID }, /another service/u],
  ];
  for (const [label, overrides, pattern] of driftCases) {
    await t.test(label, async (subtest) => {
      const outputPath = await temporaryOutput(subtest, `${label}.json`);
      const fetchImpl = scriptedFetch([
        projectStep(),
        serviceInstanceStep(serviceInstanceFixture(overrides)),
      ]);
      await assert.rejects(
        runRailwayDocumentArchiveAudit({
          environment: baseEnvironment(outputPath),
          fetchImpl,
          ...fakeRuntime(),
        }),
        pattern,
      );
      assert.equal(
        fetchImpl.calls.some(({ operation }) => operation === 'DeployArchiveAudit'),
        false,
      );
      fetchImpl.assertDone();
    });
  }

  await t.test('auto-deploy', async (subtest) => {
    const outputPath = await temporaryOutput(subtest, 'auto-deploy.json');
    const fetchImpl = scriptedFetch([
      projectStep(),
      serviceInstanceStep(serviceInstanceFixture(), { enabled: true }),
    ]);
    await assert.rejects(
      runRailwayDocumentArchiveAudit({
        environment: baseEnvironment(outputPath),
        fetchImpl,
        ...fakeRuntime(),
      }),
      /autoDeployEnabled=true/u,
    );
    assert.equal(
      fetchImpl.calls.some(({ operation }) => operation === 'DeployArchiveAudit'),
      false,
    );
    fetchImpl.assertDone();
  });
});

test('refuse un nouveau one-shot tant qu’un déploiement du service est encore actif', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([
      deploymentSnapshotFixture({
        status: 'SUCCESS',
        overrides: {
          instances: [
            {
              id: '60000000-0000-4000-8000-000000000009',
              status: 'RUNNING',
            },
          ],
        },
      }),
    ]),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /already has 1 active deployment/u,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'DeployArchiveAudit'),
    false,
  );
  fetchImpl.assertDone();
});

test('refuse un nouveau one-shot après ACK stop tant que l’instance Railway draine', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([drainingDeploymentSnapshotFixture()]),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /already has 1 active deployment/u,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'DeployArchiveAudit'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentCancel'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentStop'),
    false,
  );
  fetchImpl.assertDone();
});

test('considère une instance REMOVING comme non quiescente après ACK stop', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([drainingDeploymentSnapshotFixture({ instanceStatus: 'REMOVING' })]),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /already has 1 active deployment/u,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'DeployArchiveAudit'),
    false,
  );
  fetchImpl.assertDone();
});

test('traite SUCCESS sans instance visible comme actif tant que Railway ne confirme pas l’arrêt', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([deploymentSnapshotFixture({ status: 'SUCCESS' })]),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /already has 1 active deployment/u,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'DeployArchiveAudit'),
    false,
  );
  fetchImpl.assertDone();
});

test('refuse un statut de déploiement Railway inconnu avant la mutation', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([
      deploymentSnapshotFixture({
        status: 'FUTURE_STATUS',
        overrides: { deploymentStopped: true },
      }),
    ]),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /invalid or cross-scoped deployment snapshot/u,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'DeployArchiveAudit'),
    false,
  );
  fetchImpl.assertDone();
});

test('pagine intégralement l’instantané des déploiements avant toute mutation', async (t) => {
  const outputPath = await temporaryOutput(t);
  const inactiveDeployment = deploymentSnapshotFixture({
    id: OTHER_DEPLOYMENT_ID,
    status: 'SUCCESS',
    overrides: {
      deploymentStopped: true,
      instances: [
        {
          id: '60000000-0000-4000-8000-000000000011',
          status: 'EXITED',
        },
      ],
    },
  });
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([inactiveDeployment], {
      hasNextPage: true,
      endCursor: 'archive-cursor-1',
    }),
    deploymentSnapshotStep([], { after: 'archive-cursor-1' }),
    deployStep(),
    deploymentStep('SUCCESS'),
    logsStep(),
    deploymentStep('SUCCESS'),
    logsStep(),
  ]);

  await runRailwayDocumentArchiveAudit({
    environment: baseEnvironment(outputPath),
    fetchImpl,
    ...fakeRuntime(),
  });

  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentsSnapshot')
      .length,
    2,
  );
  fetchImpl.assertDone();
});

test('ne déclenche rien lorsque le project token vise un autre environnement', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    projectStep({
      response: dataResponse({
        projectToken: { projectId: PROJECT_ID, environmentId: OTHER_ENVIRONMENT_ID },
      }),
    }),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /not scoped to the requested environment/u,
  );
  fetchImpl.assertDone();
});

test('refuse les entrées ambiguës et une cadence inférieure à dix secondes avant réseau', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not be called');
  };
  const cases = [
    [{ RELEASE_SHA: RELEASE_SHA.toUpperCase() }, /full lowercase Git SHA/u],
    [{ RAILWAY_ARCHIVE_AUDIT_SERVICE_ID: 'not-a-uuid' }, /SERVICE_ID must be a UUID/u],
    [{ DOCUMENT_ARCHIVE_AUDIT_POLL_SECONDS: '9' }, /between 10 and 60/u],
    [{ DOCUMENT_ARCHIVE_AUDIT_POLL_SECONDS: '61' }, /between 10 and 60/u],
  ];
  for (const [overrides, pattern] of cases) {
    await assert.rejects(
      runRailwayDocumentArchiveAudit({
        environment: baseEnvironment('/tmp/unused', overrides),
        fetchImpl,
        ...fakeRuntime(),
      }),
      pattern,
    );
  }
  assert.equal(calls, 0);
});

test('échoue fermé sur erreurs GraphQL, HTTP et corps surdimensionné', async (t) => {
  const cases = [
    ['graphql', jsonResponse({ errors: [{ message: 'token denied' }] }), /token denied/u],
    ['http-401', jsonResponse({ error: 'denied' }, 401), /HTTP 401/u],
    ['null-data', jsonResponse({ data: null }), /invalid envelope/u],
    [
      'invalid-errors',
      jsonResponse({ data: {}, errors: { message: 'not-an-array' } }),
      /invalid envelope/u,
    ],
    [
      'oversized',
      {
        ok: true,
        status: 200,
        headers: { get: () => String(17 * 1024 * 1024) },
        body: { cancel: async () => undefined },
        text: async () => {
          throw new Error('oversized body must not be read');
        },
      },
      /oversized response/u,
    ],
  ];
  for (const [label, response, pattern] of cases) {
    await t.test(label, async (subtest) => {
      const outputPath = await temporaryOutput(subtest, `${label}.json`);
      const fetchImpl = scriptedFetch([projectStep({ response })]);
      await assert.rejects(
        runRailwayDocumentArchiveAudit({
          environment: baseEnvironment(outputPath),
          fetchImpl,
          ...fakeRuntime(),
        }),
        pattern,
      );
      fetchImpl.assertDone();
    });
  }
});

test('retente les lectures, borne Retry-After à 60 s et ne retente jamais le déploiement', async (t) => {
  const outputPath = await temporaryOutput(t);
  const retryingFetch = scriptedFetch([
    projectStep({ response: jsonResponse({}, 429, { 'Retry-After': '999' }) }),
    ...successSteps(),
  ]);
  const runtime = fakeRuntime();
  await runRailwayDocumentArchiveAudit({
    environment: baseEnvironment(outputPath),
    fetchImpl: retryingFetch,
    ...runtime,
  });
  assert.deepEqual(runtime.sleeps, [60_000, 10_000]);
  retryingFetch.assertDone();

  const datedOutputPath = await temporaryOutput(t, 'retry-after-date.json');
  const datedFetch = scriptedFetch([
    projectStep({
      response: jsonResponse({}, 429, { 'Retry-After': 'Wed, 21 Oct 2099 07:28:00 GMT' }),
    }),
    ...successSteps(),
  ]);
  const datedRuntime = fakeRuntime();
  await runRailwayDocumentArchiveAudit({
    environment: baseEnvironment(datedOutputPath),
    fetchImpl: datedFetch,
    ...datedRuntime,
  });
  assert.deepEqual(datedRuntime.sleeps, [60_000, 10_000]);
  datedFetch.assertDone();

  const failedOutputPath = await temporaryOutput(t, 'mutation-failed.json');
  const mutationFetch = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
    deploymentSnapshotStep(),
    deploymentSnapshotStep(),
    deploymentSnapshotStep(),
    deploymentSnapshotStep(),
    deploymentSnapshotStep(),
    deploymentSnapshotStep(),
    deploymentSnapshotStep(),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(failedOutputPath),
      fetchImpl: mutationFetch,
      ...fakeRuntime(),
    }),
    /cleanup was attempted for 0 correlated deployment/u,
  );
  assert.equal(
    mutationFetch.calls.filter(({ operation }) => operation === 'DeployArchiveAudit').length,
    1,
  );
  mutationFetch.assertDone();
});

test('réconcilie et annule le déploiement corrélé quand la réponse de mutation est perdue', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
    deploymentSnapshotStep([deploymentSnapshotFixture()]),
    cleanupStep('cancel'),
    deploymentSnapshotStep([stoppedDeploymentSnapshotFixture()]),
    deploymentSnapshotStep([stoppedDeploymentSnapshotFixture()]),
    deploymentSnapshotStep([stoppedDeploymentSnapshotFixture()]),
    deploymentSnapshotStep([stoppedDeploymentSnapshotFixture()]),
    deploymentSnapshotStep([stoppedDeploymentSnapshotFixture()]),
    deploymentSnapshotStep([stoppedDeploymentSnapshotFixture()]),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /cleanup was attempted for 1 correlated deployment/u,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'DeployArchiveAudit').length,
    1,
  );
  fetchImpl.assertDone();
});

test('un SIGTERM pendant une réponse de mutation perdue attend la réconciliation puis ressort 143', async (t) => {
  const outputPath = await temporaryOutput(t);
  const cancellation = new AbortController();
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({
      before: () => cancellation.abort(new ArchiveAuditCancellationError('SIGTERM')),
      throw: new TypeError('socket closed after request'),
    }),
    ...Array.from({ length: 7 }, () => deploymentSnapshotStep()),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      cancellationSignal: cancellation.signal,
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...runtime,
    }),
    (error) => {
      assert.ok(error instanceof ArchiveAuditCancellationError);
      assert.equal(error.signalName, 'SIGTERM');
      assert.equal(error.exitCode, 143);
      return true;
    },
  );
  assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'DeployArchiveAudit').length,
    1,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentsSnapshot')
      .length,
    8,
  );
  await assert.rejects(readFile(outputPath), (error) => error?.code === 'ENOENT');
  fetchImpl.assertDone();
});

test('un SIGTERM reste prioritaire après une réconciliation distante non convergée', async (t) => {
  const outputPath = await temporaryOutput(t);
  const cancellation = new AbortController();
  const activeDeployment = deploymentSnapshotFixture();
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({
      before: () => cancellation.abort(new ArchiveAuditCancellationError('SIGTERM')),
      throw: new TypeError('socket closed after request'),
    }),
    deploymentSnapshotStep([activeDeployment]),
    cleanupStep('cancel'),
    ...Array.from({ length: 7 }, () => deploymentSnapshotStep([activeDeployment])),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      cancellationSignal: cancellation.signal,
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...runtime,
    }),
    (error) => {
      assert.ok(error instanceof ArchiveAuditCancellationError);
      assert.equal(error.signalName, 'SIGTERM');
      assert.equal(error.exitCode, 143);
      return true;
    },
  );
  assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentCancel').length,
    1,
  );
  await assert.rejects(readFile(outputPath), (error) => error?.code === 'ENOENT');
  fetchImpl.assertDone();
});

test('le cleanup durable découvre tardivement puis arrête le déploiement de la release', async (t) => {
  const stoppedDeployment = stoppedDeploymentSnapshotFixture();
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deploymentSnapshotStep(),
    deploymentSnapshotStep([deploymentSnapshotFixture()]),
    cleanupStep('cancel'),
    deploymentSnapshotStep([stoppedDeployment]),
    deploymentSnapshotStep([stoppedDeployment]),
    deploymentSnapshotStep([stoppedDeployment]),
    deploymentSnapshotStep([stoppedDeployment]),
    deploymentSnapshotStep([stoppedDeployment]),
  ]);
  const runtime = fakeRuntime();

  const result = await cleanupRailwayDocumentArchiveAuditDeployments({
    environment: baseEnvironment(await temporaryOutput(t)),
    fetchImpl,
    ...runtime,
  });

  assert.deepEqual(result, { cleanedDeploymentCount: 1 });
  assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.deepEqual(JSON.parse(runtime.output()), { cleanedDeploymentCount: 1 });
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentCancel').length,
    1,
  );
  fetchImpl.assertDone();
});

test('le cleanup attend RUNNING puis EXITED après ACK stop sans rejouer de mutation', async (t) => {
  const drainingDeployment = drainingDeploymentSnapshotFixture();
  const exitedDeployment = drainingDeploymentSnapshotFixture({ instanceStatus: 'EXITED' });
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([drainingDeployment]),
    ...Array.from({ length: 7 }, () => deploymentSnapshotStep([exitedDeployment])),
  ]);
  const runtime = fakeRuntime();

  const result = await cleanupRailwayDocumentArchiveAuditDeployments({
    environment: baseEnvironment(await temporaryOutput(t)),
    fetchImpl,
    ...runtime,
  });

  assert.deepEqual(result, { cleanedDeploymentCount: 0 });
  assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentCancel'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentStop'),
    false,
  );
  fetchImpl.assertDone();
});

test('le cleanup échoue fermé si une instance arrêtée ne termine jamais son drainage', async (t) => {
  const drainingDeployment = drainingDeploymentSnapshotFixture();
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    ...Array.from({ length: 8 }, () => deploymentSnapshotStep([drainingDeployment])),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    cleanupRailwayDocumentArchiveAuditDeployments({
      environment: baseEnvironment(await temporaryOutput(t)),
      fetchImpl,
      ...runtime,
    }),
    /did not converge to an inactive stable state/u,
  );
  assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentCancel'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentStop'),
    false,
  );
  fetchImpl.assertDone();
});

test('le cleanup refuse un ACK stop qui régresse et ne remute jamais le déploiement', async (t) => {
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([drainingDeploymentSnapshotFixture()]),
    deploymentSnapshotStep([unacknowledgedRunningDeploymentSnapshotFixture()]),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    cleanupRailwayDocumentArchiveAuditDeployments({
      environment: baseEnvironment(await temporaryOutput(t)),
      fetchImpl,
      ...runtime,
    }),
    /deploymentStopped regress from true to false/u,
  );
  assert.deepEqual(runtime.sleeps, [10_000]);
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentCancel'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentStop'),
    false,
  );
  fetchImpl.assertDone();
});

test('le cleanup exige deux observations d’une cible corrélée apparue en fin de fenêtre', async (t) => {
  await t.test('avant-dernier puis dernier snapshot : admis', async (subtest) => {
    const stoppedDeployment = stoppedDeploymentSnapshotFixture();
    const fetchImpl = scriptedFetch([
      projectStep(),
      serviceInstanceStep(),
      ...Array.from({ length: 6 }, () => deploymentSnapshotStep()),
      deploymentSnapshotStep([stoppedDeployment]),
      deploymentSnapshotStep([stoppedDeployment]),
    ]);
    const runtime = fakeRuntime();

    await assert.doesNotReject(
      cleanupRailwayDocumentArchiveAuditDeployments({
        environment: baseEnvironment(await temporaryOutput(subtest)),
        fetchImpl,
        ...runtime,
      }),
    );
    assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    fetchImpl.assertDone();
  });

  await t.test('dernier snapshot seulement : refusé', async (subtest) => {
    const fetchImpl = scriptedFetch([
      projectStep(),
      serviceInstanceStep(),
      ...Array.from({ length: 7 }, () => deploymentSnapshotStep()),
      deploymentSnapshotStep([stoppedDeploymentSnapshotFixture()]),
    ]);
    const runtime = fakeRuntime();

    await assert.rejects(
      cleanupRailwayDocumentArchiveAuditDeployments({
        environment: baseEnvironment(await temporaryOutput(subtest)),
        fetchImpl,
        ...runtime,
      }),
      /did not converge to an inactive stable state/u,
    );
    assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    fetchImpl.assertDone();
  });
});

test('le cleanup durable observe une fenêtre complète même sans déploiement visible', async (t) => {
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    ...Array.from({ length: 8 }, () => deploymentSnapshotStep()),
  ]);
  const runtime = fakeRuntime();

  const result = await cleanupRailwayDocumentArchiveAuditDeployments({
    environment: baseEnvironment(await temporaryOutput(t)),
    fetchImpl,
    ...runtime,
  });

  assert.deepEqual(result, { cleanedDeploymentCount: 0 });
  assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  fetchImpl.assertDone();
});

test('le cleanup durable refuse de stopper un déploiement actif d’une autre release', async (t) => {
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([deploymentSnapshotFixture({ commitHash: 'b'.repeat(40) })]),
  ]);

  await assert.rejects(
    cleanupRailwayDocumentArchiveAuditDeployments({
      environment: baseEnvironment(await temporaryOutput(t)),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /active deployment\(s\) from another release/u,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentCancel').length,
    0,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentStop').length,
    0,
  );
  fetchImpl.assertDone();
});

test('le cleanup refuse aussi une autre release arrêtée mais encore RUNNING', async (t) => {
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([drainingDeploymentSnapshotFixture({ commitHash: 'b'.repeat(40) })]),
  ]);

  await assert.rejects(
    cleanupRailwayDocumentArchiveAuditDeployments({
      environment: baseEnvironment(await temporaryOutput(t)),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /active deployment\(s\) from another release/u,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentCancel'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentStop'),
    false,
  );
  fetchImpl.assertDone();
});

test('le cleanup durable ne mute jamais un SHA absent qui devient une autre release', async (t) => {
  const deploymentId = '40000000-0000-4000-8000-000000000077';
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([deploymentSnapshotFixture({ id: deploymentId, commitHash: null })]),
    deploymentSnapshotStep([
      deploymentSnapshotFixture({ id: deploymentId, commitHash: 'b'.repeat(40) }),
    ]),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    cleanupRailwayDocumentArchiveAuditDeployments({
      environment: baseEnvironment(await temporaryOutput(t)),
      fetchImpl,
      ...runtime,
    }),
    /active deployment\(s\) from another release/u,
  );
  assert.deepEqual(runtime.sleeps, [10_000]);
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentCancel').length,
    0,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentStop').length,
    0,
  );
  fetchImpl.assertDone();
});

test('la commande câble exactement le mode audit ou cleanup et refuse tout argument ambigu', async () => {
  const auditRun = async () => undefined;
  const cleanupRun = async () => undefined;
  const selectedRuns = [];
  const runCli = async ({ run }) => {
    selectedRuns.push(run);
    return 0;
  };

  assert.equal(
    await runRailwayDocumentArchiveAuditCommand({ argv: [], runCli, auditRun, cleanupRun }),
    0,
  );
  assert.equal(
    await runRailwayDocumentArchiveAuditCommand({
      argv: ['--cleanup-only'],
      runCli,
      auditRun,
      cleanupRun,
    }),
    0,
  );
  assert.deepEqual(selectedRuns, [auditRun, cleanupRun]);
  await assert.rejects(
    runRailwayDocumentArchiveAuditCommand({
      argv: ['--cleanup-only', '--unexpected'],
      runCli,
      auditRun,
      cleanupRun,
    }),
    /Unknown archive audit command argument/u,
  );
  await assert.rejects(
    runRailwayDocumentArchiveAuditCommand({
      argv: [42],
      runCli,
      auditRun,
      cleanupRun,
    }),
    /arguments must be strings/u,
  );
});

test('attend un déploiement retardé et nettoie une métadonnée commit encore absente', async (t) => {
  const outputPath = await temporaryOutput(t);
  const stoppedDeployment = stoppedDeploymentSnapshotFixture();
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
    deploymentSnapshotStep(),
    deploymentSnapshotStep(),
    deploymentSnapshotStep([deploymentSnapshotFixture({ commitHash: null })]),
    deploymentSnapshotStep([deploymentSnapshotFixture()]),
    cleanupStep('cancel'),
    deploymentSnapshotStep([stoppedDeployment]),
    deploymentSnapshotStep([stoppedDeployment]),
    deploymentSnapshotStep([stoppedDeployment]),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...runtime,
    }),
    /cleanup was attempted for 1 correlated deployment/u,
  );
  assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'DeployArchiveAudit').length,
    1,
  );
  fetchImpl.assertDone();
});

test('la réconciliation attend le drainage après ACK sans rejouer de mutation', async (t) => {
  const outputPath = await temporaryOutput(t);
  const exitedDeployment = drainingDeploymentSnapshotFixture({ instanceStatus: 'EXITED' });
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
    deploymentSnapshotStep([drainingDeploymentSnapshotFixture()]),
    ...Array.from({ length: 6 }, () => deploymentSnapshotStep([exitedDeployment])),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /cleanup was attempted for 0 correlated deployment/u,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentCancel'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentStop'),
    false,
  );
  fetchImpl.assertDone();
});

test('la réconciliation échoue si le drainage acquitté ne converge jamais', async (t) => {
  const outputPath = await temporaryOutput(t);
  const drainingDeployment = drainingDeploymentSnapshotFixture();
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
    ...Array.from({ length: 8 }, () => deploymentSnapshotStep([drainingDeployment])),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /remote reconciliation failed/u,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentCancel'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentStop'),
    false,
  );
  fetchImpl.assertDone();
});

test('la réconciliation refuse un ACK stop qui régresse sans remuter', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
    deploymentSnapshotStep([drainingDeploymentSnapshotFixture()]),
    deploymentSnapshotStep([unacknowledgedRunningDeploymentSnapshotFixture()]),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    (error) => {
      assert.match(error.message, /remote reconciliation failed/u);
      assert.ok(error.cause instanceof AggregateError);
      assert.ok(
        error.cause.errors.some((cause) =>
          /deploymentStopped regress from true to false/u.test(cause?.message ?? ''),
        ),
      );
      return true;
    },
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentCancel'),
    false,
  );
  assert.equal(
    fetchImpl.calls.some(({ operation }) => operation === 'ArchiveAuditDeploymentStop'),
    false,
  );
  fetchImpl.assertDone();
});

test('la réconciliation primaire ne mute jamais un nouveau SHA absent devenu étranger', async (t) => {
  const outputPath = await temporaryOutput(t);
  const deploymentId = '40000000-0000-4000-8000-000000000078';
  const foreignDeployment = deploymentSnapshotFixture({
    id: deploymentId,
    commitHash: 'b'.repeat(40),
  });
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
    deploymentSnapshotStep([deploymentSnapshotFixture({ id: deploymentId, commitHash: null })]),
    deploymentSnapshotStep([foreignDeployment]),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...runtime,
    }),
    /remote reconciliation failed/u,
  );
  assert.deepEqual(runtime.sleeps, [10_000]);
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentCancel').length,
    0,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentStop').length,
    0,
  );
  fetchImpl.assertDone();
});

test('refuse de déclarer la réconciliation réussie tant que le job distant reste actif', async (t) => {
  const outputPath = await temporaryOutput(t);
  const activeDeployment = deploymentSnapshotFixture();
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
    deploymentSnapshotStep([activeDeployment]),
    cleanupStep('cancel'),
    ...Array.from({ length: 7 }, () => deploymentSnapshotStep([activeDeployment])),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /remote reconciliation failed/u,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentCancel').length,
    1,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentStop').length,
    0,
  );
  fetchImpl.assertDone();
});

test('réconcilie tous les nouveaux déploiements du commit sans toucher aux déploiements antérieurs', async (t) => {
  const preExistingDeployment = deploymentSnapshotFixture({
    id: OTHER_DEPLOYMENT_ID,
    status: 'SUCCESS',
    overrides: {
      deploymentStopped: true,
      instances: [
        {
          id: '60000000-0000-4000-8000-000000000010',
          status: 'EXITED',
        },
      ],
    },
  });
  const secondCorrelatedDeploymentId = '40000000-0000-4000-8000-000000000007';
  const stoppedCorrelatedDeployments = [
    preExistingDeployment,
    stoppedDeploymentSnapshotFixture(),
    stoppedDeploymentSnapshotFixture({ id: secondCorrelatedDeploymentId }),
  ];
  const fetchImpl = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deploymentSnapshotStep([preExistingDeployment]),
    deployStep({ throw: new TypeError('socket closed after request') }),
    deploymentSnapshotStep([
      preExistingDeployment,
      deploymentSnapshotFixture(),
      deploymentSnapshotFixture({ id: secondCorrelatedDeploymentId }),
      stoppedDeploymentSnapshotFixture({
        id: '40000000-0000-4000-8000-000000000008',
        commitHash: 'b'.repeat(40),
      }),
    ]),
    cleanupStep('cancel'),
    cleanupStep('cancel', true, secondCorrelatedDeploymentId),
    deploymentSnapshotStep(stoppedCorrelatedDeployments),
    deploymentSnapshotStep(stoppedCorrelatedDeployments),
    deploymentSnapshotStep(stoppedCorrelatedDeployments),
    deploymentSnapshotStep(stoppedCorrelatedDeployments),
    deploymentSnapshotStep(stoppedCorrelatedDeployments),
    deploymentSnapshotStep(stoppedCorrelatedDeployments),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(await temporaryOutput(t)),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /cleanup was attempted for 2 correlated deployment/u,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'DeployArchiveAudit').length,
    1,
  );
  fetchImpl.assertDone();
});

test('SUCCESS relit en dix secondes un marqueur retardé malgré un polling nominal de soixante', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('SUCCESS'),
    logsStep([]),
    deploymentStep('SUCCESS'),
    logsStep(),
    deploymentStep('SUCCESS'),
    logsStep(),
  ]);
  const runtime = fakeRuntime();
  await runRailwayDocumentArchiveAudit({
    environment: baseEnvironment(outputPath, {
      DOCUMENT_ARCHIVE_AUDIT_POLL_SECONDS: '60',
    }),
    fetchImpl,
    ...runtime,
  });
  assert.deepEqual(runtime.sleeps, [10_000, 10_000]);
  fetchImpl.assertDone();
});

test('SUCCESS avec runtime RUNNING conserve la deadline globale au-delà de soixante secondes', async (t) => {
  const outputPath = await temporaryOutput(t);
  const running = {
    instances: [{ id: '60000000-0000-4000-8000-000000000012', status: 'RUNNING' }],
  };
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    ...Array.from({ length: 7 }, () => [
      deploymentStep('SUCCESS', running),
      logsStep([]),
    ]).flat(),
    deploymentStep('SUCCESS', running),
    logsStep(),
    deploymentStep('SUCCESS', running),
    logsStep(),
  ]);
  const runtime = fakeRuntime();

  await runRailwayDocumentArchiveAudit({
    environment: baseEnvironment(outputPath, {
      DOCUMENT_ARCHIVE_AUDIT_TIMEOUT_SECONDS: '95',
      DOCUMENT_ARCHIVE_AUDIT_POLL_SECONDS: '60',
    }),
    fetchImpl,
    ...runtime,
  });

  assert.equal(runtime.elapsed(), 80_000);
  assert.deepEqual(runtime.sleeps, Array.from({ length: 8 }, () => 10_000));
  assert.deepEqual(runtime.requestTimeouts.slice(-4), [25_000, 25_000, 15_000, 15_000]);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), evidenceFixture());
  assert.equal(
    fetchImpl.calls.some(({ operation }) =>
      ['ArchiveAuditDeploymentCancel', 'ArchiveAuditDeploymentStop'].includes(operation),
    ),
    false,
  );
  fetchImpl.assertDone();
});

test('SUCCESS sans instance reste indéterminé jusqu’à la deadline globale', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    ...Array.from({ length: 6 }, () => [
      deploymentStep('SUCCESS', { instances: [] }),
      logsStep([]),
    ]).flat(),
    cleanupStep('cancel'),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...runtime,
    }),
    (error) => {
      assert.equal(error instanceof ArchiveAuditTerminalEvidenceError, false);
      assert.match(error.message, /bounded timeout without valid evidence/u);
      return true;
    },
  );

  assert.equal(runtime.elapsed(), 60_000);
  assert.deepEqual(runtime.sleeps, Array.from({ length: 6 }, () => 10_000));
  fetchImpl.assertDone();
});

test('SUCCESS avec runtime RUNNING expirant pendant la lecture des logs reste un timeout global', async (t) => {
  const outputPath = await temporaryOutput(t);
  const runtime = fakeRuntime();
  const slowLogs = logsStep([]);
  slowLogs.before = () => runtime.advance(60_000);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('SUCCESS', {
      instances: [{ id: '60000000-0000-4000-8000-000000000012', status: 'RUNNING' }],
    }),
    slowLogs,
    cleanupStep('cancel'),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...runtime,
    }),
    (error) => {
      assert.equal(error instanceof ArchiveAuditTerminalEvidenceError, false);
      assert.match(error.message, /bounded timeout without valid evidence/u);
      return true;
    },
  );

  assert.equal(runtime.elapsed(), 60_000);
  fetchImpl.assertDone();
});

test('refuse toute enveloppe d’instance Railway absente ou invalide', async (t) => {
  const cases = [
    ['instances absentes', { instances: undefined }, /deployment envelope/u],
    ['deploymentStopped absent', { deploymentStopped: undefined }, /deployment envelope/u],
    [
      'identifiant instance invalide',
      { instances: [{ id: 'not-a-uuid', status: 'RUNNING' }] },
      /deployment instance envelope/u,
    ],
    [
      'statut instance inconnu',
      {
        instances: [
          { id: '60000000-0000-4000-8000-000000000012', status: 'UNRECOGNIZED' },
        ],
      },
      /deployment instance envelope/u,
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    await t.test(label, async (subtest) => {
      const outputPath = await temporaryOutput(subtest, `${label}.json`);
      const fetchImpl = scriptedFetch([
        ...beforeDeploymentSteps(),
        deploymentStep('SUCCESS', overrides),
        cleanupStep('stop'),
      ]);

      await assert.rejects(
        runRailwayDocumentArchiveAudit({
          environment: baseEnvironment(outputPath),
          fetchImpl,
          ...fakeRuntime(),
        }),
        expected,
      );
      fetchImpl.assertDone();
    });
  }
});

test('SUCCESS avec runtime terminal sans marqueur échoue après soixante secondes', async (t) => {
  const outputPath = await temporaryOutput(t);
  const runtime = fakeRuntime();
  let cleanupStartedAt = -1;
  const slowCleanup = cleanupStep('cancel');
  slowCleanup.before = () => {
    cleanupStartedAt = runtime.elapsed();
    runtime.advance(30_000);
  };
  slowCleanup.throw = Object.assign(new Error('cleanup request timed out'), {
    name: 'TimeoutError',
  });
  const successWithoutEvidence = Array.from({ length: 6 }, () => [
    deploymentStep('SUCCESS'),
    logsStep([]),
  ]).flat();
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    ...successWithoutEvidence,
    slowCleanup,
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath, {
        DOCUMENT_ARCHIVE_AUDIT_TIMEOUT_SECONDS: '120',
      }),
      fetchImpl,
      ...runtime,
    }),
    (error) => {
      assert.ok(error instanceof ArchiveAuditTerminalEvidenceError);
      assert.equal(error.code, 'ARCHIVE_AUDIT_TERMINAL_EVIDENCE_MISSING');
      assert.match(error.message, /runtime became terminal without valid evidence within 60 seconds/u);
      return true;
    },
  );

  assert.deepEqual(
    runtime.sleeps,
    Array.from({ length: 6 }, () => 10_000),
  );
  assert.equal(cleanupStartedAt, 60_000);
  assert.equal(runtime.elapsed(), 90_000);
  assert.equal(runtime.requestTimeouts.at(-1), 30_000);
  await assert.rejects(readFile(outputPath), (error) => error?.code === 'ENOENT');
  fetchImpl.assertDone();
});

test('la deadline absolue borne aussi les lectures GraphQL après SUCCESS', async (t) => {
  const outputPath = await temporaryOutput(t);
  const runtime = fakeRuntime();
  const firstSlowLogsStep = logsStep([]);
  firstSlowLogsStep.before = () => runtime.advance(25_000);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('SUCCESS'),
    firstSlowLogsStep,
    ...Array.from({ length: 3 }, () => [deploymentStep('SUCCESS'), logsStep([])]).flat(),
    cleanupStep('cancel'),
  ]);

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath, {
        DOCUMENT_ARCHIVE_AUDIT_TIMEOUT_SECONDS: '120',
      }),
      fetchImpl,
      ...runtime,
    }),
    (error) => error?.code === 'ARCHIVE_AUDIT_TERMINAL_EVIDENCE_MISSING',
  );

  assert.equal(runtime.elapsed(), 60_000);
  assert.deepEqual(runtime.sleeps, [10_000, 10_000, 10_000, 5_000]);
  assert.deepEqual(
    runtime.requestTimeouts.slice(-9, -1),
    [30_000, 30_000, 25_000, 25_000, 15_000, 15_000, 5_000, 5_000],
  );
  assert.equal(runtime.requestTimeouts.at(-1), 30_000);
  fetchImpl.assertDone();
});

test('accepte le même marqueur confirmé après la grâce sans marqueur', async (t) => {
  const outputPath = await temporaryOutput(t);
  const runtime = fakeRuntime();
  const firstMarker = logsStep();
  firstMarker.before = () => runtime.advance(5_000);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    ...Array.from({ length: 5 }, () => [deploymentStep('SUCCESS'), logsStep([])]).flat(),
    deploymentStep('SUCCESS'),
    firstMarker,
    deploymentStep('SUCCESS'),
    logsStep(),
  ]);

  await runRailwayDocumentArchiveAudit({
    environment: baseEnvironment(outputPath, {
      DOCUMENT_ARCHIVE_AUDIT_TIMEOUT_SECONDS: '120',
    }),
    fetchImpl,
    ...runtime,
  });

  assert.deepEqual(
    runtime.sleeps,
    Array.from({ length: 6 }, () => 10_000),
  );
  assert.equal(runtime.elapsed(), 65_000);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), evidenceFixture());
  fetchImpl.assertDone();
});

test('refuse un marqueur disparu ou modifié pendant la confirmation', async (t) => {
  const cases = [
    ['disparu', logsStep([])],
    [
      'modifié',
      logsStep([
        {
          message: marker(evidenceFixture({ reportSha256: DIGEST_C })),
        },
      ]),
    ],
  ];

  for (const [label, secondObservation] of cases) {
    await t.test(label, async (subtest) => {
      const outputPath = await temporaryOutput(subtest, `${label}.json`);
      const fetchImpl = scriptedFetch([
        ...successSteps({ successfulObservations: 1 }),
        deploymentStep('SUCCESS'),
        secondObservation,
        cleanupStep('cancel'),
      ]);

      await assert.rejects(
        runRailwayDocumentArchiveAudit({
          environment: baseEnvironment(outputPath),
          fetchImpl,
          ...fakeRuntime(),
        }),
        (error) => {
          assert.ok(error instanceof ArchiveAuditTerminalEvidenceError);
          assert.equal(error.code, 'ARCHIVE_AUDIT_TERMINAL_EVIDENCE_UNSTABLE');
          return true;
        },
      );
      await assert.rejects(readFile(outputPath), (error) => error?.code === 'ENOENT');
      fetchImpl.assertDone();
    });
  }
});

test('un crash post-marqueur prêt reste un crash et ne produit aucune preuve CI', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...successSteps({ successfulObservations: 1 }),
    deploymentStep('CRASHED'),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /ended as CRASHED after SUCCESS/u,
  );
  await assert.rejects(readFile(outputPath), (error) => error?.code === 'ENOENT');
  fetchImpl.assertDone();
});

test('préserve un refus métier apparu pendant le drain SUCCESS puis CRASHED', async (t) => {
  const outputPath = await temporaryOutput(t);
  const refusal = refusalFixture();
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('SUCCESS'),
    logsStep([]),
    deploymentStep('CRASHED'),
    logsStep([{ message: marker(refusal) }]),
  ]);
  const runtime = fakeRuntime();

  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...runtime,
    }),
    (error) => {
      assert.ok(error instanceof ArchiveAuditBusinessRefusalError);
      assert.deepEqual(error.issueCodes, refusal.issueCodes);
      return true;
    },
  );

  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), refusal);
  assert.deepEqual(JSON.parse(runtime.output()), {
    deploymentId: DEPLOYMENT_ID,
    status: 'CRASHED',
    outcome: 'REFUSED',
    issueCodes: refusal.issueCodes,
    evidencePath: resolve(outputPath),
  });
  fetchImpl.assertDone();
});

test('FAILED et CRASHED conservent un refus métier non-PII et le distinguent du crash', async (t) => {
  for (const status of ['FAILED', 'CRASHED']) {
    await t.test(status, async (subtest) => {
      const outputPath = await temporaryOutput(subtest, `${status}.json`);
      const refusal = refusalFixture();
      const fetchImpl = scriptedFetch([
        ...beforeDeploymentSteps(),
        deploymentStep(status),
        logsStep([{ message: marker(refusal) }]),
      ]);
      const runtime = fakeRuntime();
      await assert.rejects(
        runRailwayDocumentArchiveAudit({
          environment: baseEnvironment(outputPath),
          fetchImpl,
          ...runtime,
        }),
        (error) => {
          assert.ok(error instanceof ArchiveAuditBusinessRefusalError);
          assert.equal(error.code, 'ARCHIVE_AUDIT_BUSINESS_REFUSAL');
          assert.equal(error.deploymentId, DEPLOYMENT_ID);
          assert.deepEqual(error.issueCodes, refusal.issueCodes);
          return true;
        },
      );
      assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), refusal);
      assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(runtime.output()), {
        deploymentId: DEPLOYMENT_ID,
        status,
        outcome: 'REFUSED',
        issueCodes: refusal.issueCodes,
        evidencePath: resolve(outputPath),
      });
      fetchImpl.assertDone();
    });
  }
});

test('un refus observé pendant SUCCESS est persisté puis le processus vivant est annulé', async (t) => {
  const outputPath = await temporaryOutput(t);
  const refusal = refusalFixture();
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('SUCCESS'),
    logsStep([{ message: marker(refusal) }]),
    cleanupStep('cancel'),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    (error) => error instanceof ArchiveAuditBusinessRefusalError,
  );
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), refusal);
  fetchImpl.assertDone();
});

test('un crash sans enveloppe de refus est une panne technique, pas un refus métier', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('CRASHED'),
    logsStep([]),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    (error) => {
      assert.equal(error instanceof ArchiveAuditBusinessRefusalError, false);
      assert.match(error.message, /CRASHED without a valid refusal/u);
      return true;
    },
  );
  await assert.rejects(readFile(outputPath), (error) => error?.code === 'ENOENT');
  fetchImpl.assertDone();
});

test('annule un build au timeout avec une cadence bornée', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('BUILDING'),
    deploymentStep('BUILDING'),
    cleanupStep('cancel'),
  ]);
  const runtime = fakeRuntime();
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath, {
        DOCUMENT_ARCHIVE_AUDIT_TIMEOUT_SECONDS: '60',
        DOCUMENT_ARCHIVE_AUDIT_POLL_SECONDS: '30',
      }),
      fetchImpl,
      ...runtime,
    }),
    /bounded timeout without valid evidence/u,
  );
  assert.deepEqual(runtime.sleeps, [30_000, 30_000]);
  fetchImpl.assertDone();
});

test('le cleanup tente stop puis cancel une seule fois sans masquer l’erreur principale', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('ACTIVE'),
    {
      ...cleanupStep('stop'),
      response: jsonResponse({}, 503),
    },
    cleanupStep('cancel'),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /unsupported archive audit status: ACTIVE/u,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentStop').length,
    1,
  );
  assert.equal(
    fetchImpl.calls.filter(({ operation }) => operation === 'ArchiveAuditDeploymentCancel').length,
    1,
  );
  fetchImpl.assertDone();
});

test('un déploiement non corrélé déclenche un cleanup sans remplacer l’erreur', async (t) => {
  const outputPath = await temporaryOutput(t);
  const wrongIdStep = deploymentStep('BUILDING');
  wrongIdStep.response = dataResponse({
    deployment: { id: '40000000-0000-4000-8000-000000000099', status: 'BUILDING' },
  });
  const fetchImpl = scriptedFetch([...beforeDeploymentSteps(), wrongIdStep, cleanupStep('cancel')]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /another deployment/u,
  );
  fetchImpl.assertDone();
});

test('WAITING est refusé et annulé explicitement', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('WAITING'),
    cleanupStep('cancel'),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /WAITING without a valid refusal/u,
  );
  fetchImpl.assertDone();
});

test('ne remplace jamais une preuve CI préexistante', async (t) => {
  const outputPath = await temporaryOutput(t);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, 'existing-proof\n');
  let networkCalls = 0;
  const fetchImpl = async () => {
    networkCalls += 1;
    throw new Error('network must not be called when the evidence path already exists');
  };
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    (error) => error?.code === 'EEXIST',
  );
  assert.equal(await readFile(outputPath, 'utf8'), 'existing-proof\n');
  assert.equal(networkCalls, 0);
});

test('accepte les deux modes protocolaires et les deux verdicts cohérents', () => {
  assert.deepEqual(
    extractArchiveAuditEvidence([{ message: marker() }], DEPLOYMENT_ID, RELEASE_SHA),
    evidenceFixture(),
  );
  const protocolV2 = evidenceFixture({
    protocolVersion: 2,
    mode: 'protocol-v2-verified',
  });
  assert.deepEqual(
    extractArchiveAuditEvidence([{ message: marker(protocolV2) }], DEPLOYMENT_ID, RELEASE_SHA),
    protocolV2,
  );
  const refusal = refusalFixture();
  assert.deepEqual(
    extractArchiveAuditEvidence([{ message: marker(refusal) }], DEPLOYMENT_ID, RELEASE_SHA),
    refusal,
  );
  assert.equal(
    extractArchiveAuditEvidence([{ message: 'ordinary audit log' }], DEPLOYMENT_ID, RELEASE_SHA),
    null,
  );
});

test('rejette les marqueurs multiples, intégrés à du texte ou non canoniques', () => {
  const exact = marker();
  assert.throws(
    () =>
      extractArchiveAuditEvidence(
        [{ message: exact }, { message: exact }],
        DEPLOYMENT_ID,
        RELEASE_SHA,
      ),
    /exactly one/u,
  );
  assert.throws(
    () => extractArchiveAuditEvidence([{ message: `prefix ${exact}` }], DEPLOYMENT_ID, RELEASE_SHA),
    /exact standalone/u,
  );
  assert.throws(
    () =>
      extractArchiveAuditEvidence(
        [{ message: `${EVIDENCE_PREFIX}e30=` }],
        DEPLOYMENT_ID,
        RELEASE_SHA,
      ),
    /malformed/u,
  );
  assert.throws(
    () =>
      extractArchiveAuditEvidence(
        [{ message: `${EVIDENCE_PREFIX}${Buffer.from('not-json').toString('base64url')}` }],
        DEPLOYMENT_ID,
        RELEASE_SHA,
      ),
    /valid JSON/u,
  );
  assert.throws(
    () => extractArchiveAuditEvidence({}, DEPLOYMENT_ID, RELEASE_SHA),
    /invalid shape/u,
  );
});

test('rejette toute enveloppe incomplète, incohérente ou susceptible de transporter une PII', async (t) => {
  const cases = [
    [
      'deployment',
      evidenceFixture({ deploymentId: '40000000-0000-4000-8000-000000000006' }),
      /another deployment/u,
    ],
    ['release', evidenceFixture({ releaseSha: 'b'.repeat(40) }), /another deployment\/release/u],
    ['protocol-mode', evidenceFixture({ protocolVersion: 2 }), /incomplete/u],
    ['digest', evidenceFixture({ inventoryDigest: 'not-a-digest' }), /incomplete/u],
    [
      'ready-with-p0',
      evidenceFixture({ counts: { ...evidenceFixture().counts, p0Issues: 1 } }),
      /activation verdict/u,
    ],
    ['ready-with-issues', evidenceFixture({ issueCodes: ['ARCHIVE_P0'] }), /issue codes/u],
    [
      'refusal-without-p0',
      refusalFixture({ counts: evidenceFixture().counts }),
      /activation verdict/u,
    ],
    ['refusal-without-code', refusalFixture({ issueCodes: [] }), /issue codes/u],
    [
      'unsorted-codes',
      refusalFixture({ issueCodes: ['Z_ARCHIVE_P0', 'A_ARCHIVE_P0'] }),
      /issue codes/u,
    ],
    [
      'duplicate-codes',
      refusalFixture({ issueCodes: ['ARCHIVE_P0', 'ARCHIVE_P0'] }),
      /issue codes/u,
    ],
    ['pii-code', refusalFixture({ issueCodes: ['Client Dupont'] }), /issue codes/u],
    ['unknown-uppercase-code', refusalFixture({ issueCodes: ['CLIENT_DUPONT'] }), /issue codes/u],
    [
      'negative-count',
      evidenceFixture({ counts: { ...evidenceFixture().counts, generatedLegalDocuments: -1 } }),
      /activation verdict/u,
    ],
    [
      'missing-count',
      evidenceFixture({
        counts: Object.fromEntries(
          Object.entries(evidenceFixture().counts).filter(([name]) => name !== 'p0Issues'),
        ),
      }),
      /activation verdict/u,
    ],
    [
      'validator',
      evidenceFixture({
        validators: {
          representationDetector: 1,
          mustang: 'future-unreviewed',
          fnfe: '1.4.0.02',
        },
      }),
      /validator versions/u,
    ],
    ['extra-field', { ...evidenceFixture(), customerName: 'must-not-reach-CI' }, /non-PII schema/u],
  ];
  for (const [label, evidence, pattern] of cases) {
    await t.test(label, () => {
      assert.throws(
        () =>
          extractArchiveAuditEvidence([{ message: marker(evidence) }], DEPLOYMENT_ID, RELEASE_SHA),
        pattern,
      );
    });
  }
});

test('le catalogue non-PII couvre exactement tous les codes métier émis par le scanner', async () => {
  const runnerSource = await readFile(SCRIPT_PATH, 'utf8');
  const producerSource = (
    await Promise.all(
      [
        'apps/api/src/document-archive-audit.main.ts',
        'apps/api/src/documents/archive-preactivation-audit.ts',
      ].map((path) => readFile(join(REPOSITORY_ROOT, path), 'utf8')),
    )
  ).join('\n');
  const issueLiteral =
    /'(ARCHIVE_|B2C_|FACTURX_|GENERATED_|INVOICE_|PDF_|PROFESSIONAL_|SIGNED_|SQL_|STORAGE_)([A-Z0-9_]+)'/gu;
  const emittedCodes = [
    ...new Set([...producerSource.matchAll(issueLiteral)].map((match) => match[1] + match[2])),
  ].sort();
  const allowlistBlock = runnerSource.match(
    /const ALLOWED_ISSUE_CODES = new Set\(\[([\s\S]*?)\]\);/u,
  );
  assert.ok(allowlistBlock, 'the runner issue-code allowlist must remain explicit');
  const allowedCodes = [
    ...new Set([...allowlistBlock[1].matchAll(/'([A-Z0-9_]+)'/gu)].map((match) => match[1])),
  ].sort();
  assert.deepEqual(allowedCodes, emittedCodes);
});

test('le contrat image/config impose Node épinglé, rôle non-root et sandbox lazy fail-closed', async () => {
  const dockerfile = await readFile(join(REPOSITORY_ROOT, 'Dockerfile.archive-audit'), 'utf8');
  const auditMain = await readFile(
    join(REPOSITORY_ROOT, 'apps/api/src/document-archive-audit.main.ts'),
    'utf8',
  );
  assert.match(dockerfile, /FROM node:22\.18\.0-slim AS base/u);
  assert.match(dockerfile, /USER bob-archive-audit:bob-archive-audit/u);
  assert.match(dockerfile, /id -u[^\n]+10001/u);
  assert.match(dockerfile, /DOCUMENT_ARCHIVE_VALIDATOR_SANDBOX="\/usr\/bin\/bwrap"/u);
  assert.match(dockerfile, /exec sh apps\/api\/scripts\/run-document-archive-audit-job\.sh/u);
  const entrypoint = dockerfile.match(
    /bob-archive-audit-entrypoint <<'SCRIPT'\n([\s\S]*?)\nSCRIPT/u,
  )?.[1];
  assert.ok(entrypoint, 'the archive entrypoint must remain statically inspectable');
  assert.doesNotMatch(entrypoint, /(?:^|\n)\s*(?:env\s+)?\/usr\/bin\/bwrap\b/u);
  assert.doesNotMatch(entrypoint, /BOB_ARCHIVE_SANDBOX_SMOKE_SECRET/u);
  assert.match(auditMain, /buildValidatorSandboxSmokeInvocation/u);
  assert.match(auditMain, /--unshare-net/u);
  assert.match(auditMain, /--clearenv/u);
  assert.match(auditMain, /'--ro-bind',\s*'\/',\s*'\/'/u);
  assert.match(auditMain, /inner-workdir-writable/u);
  assert.match(auditMain, /BOB_ARCHIVE_SANDBOX_SMOKE_SECRET/u);
  const sandboxImplementation = auditMain.slice(
    auditMain.indexOf('export function buildValidatorSandboxArguments'),
    auditMain.indexOf('export function buildArchiveAuditSafeEnvelope'),
  );
  assert.doesNotMatch(sandboxImplementation, /\/usr\/bin\/env|\|\| true/u);
  assert.match(sandboxImplementation, /validatorSandboxPath !== VALIDATOR_SANDBOX_EXECUTABLE/u);
  const validateImplementation = sandboxImplementation.slice(
    sandboxImplementation.indexOf('async validate(input:'),
  );
  const readinessIndex = validateImplementation.indexOf('await this.ensureSandboxReady()');
  const jarIndex = validateImplementation.indexOf('await this.verifyMustangJar()');
  const workDirectoryIndex = validateImplementation.indexOf('await mkdtemp(');
  const firstExecutionIndex = validateImplementation.indexOf('this.executeSandboxed(');
  assert.ok(readinessIndex >= 0, 'the professional validator must call the readiness gate');
  assert.ok(readinessIndex < jarIndex, 'sandbox readiness must precede validator artifact access');
  assert.ok(
    readinessIndex < workDirectoryIndex,
    'sandbox readiness must precede invoice temp files',
  );
  assert.ok(readinessIndex < firstExecutionIndex, 'sandbox readiness must precede every validator');

  const railwayConfig = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, 'railway.archive-audit.json'), 'utf8'),
  );
  assert.deepEqual(railwayConfig.build, {
    builder: 'DOCKERFILE',
    dockerfilePath: 'Dockerfile.archive-audit',
  });
  assert.equal(railwayConfig.deploy.preDeployCommand, null);
  assert.equal(railwayConfig.deploy.startCommand, '/usr/local/bin/bob-archive-audit-entrypoint');
  assert.equal(railwayConfig.deploy.cronSchedule, null);
  assert.equal(railwayConfig.deploy.sleepApplication, false);
  assert.equal(railwayConfig.deploy.healthcheckPath, null);
  assert.equal(railwayConfig.deploy.healthcheckTimeout, null);
  assert.equal(railwayConfig.deploy.numReplicas, 1);
  assert.equal(railwayConfig.deploy.drainingSeconds, 30);
  assert.equal(railwayConfig.deploy.overlapSeconds, 0);
  assert.equal(railwayConfig.deploy.restartPolicyType, 'NEVER');
  assert.equal(railwayConfig.deploy.restartPolicyMaxRetries, null);
  assert.deepEqual(
    Object.values(railwayConfig.deploy.multiRegionConfig).map(({ numReplicas }) => numReplicas),
    [1],
  );

  const workflow = await readFile(
    join(REPOSITORY_ROOT, '.github/workflows/railway-api.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /release-api:\n\s+# [^\n]+\n(?:\s+# [^\n]+\n){2}\s+needs: validate-purpose\n\s+if: \$\{\{ always\(\) && needs\.validate-purpose\.result == 'success' && \(inputs\.purpose == 'release' \|\| inputs\.purpose == 'release-recovery'\) \}\}/u,
  );
  assert.match(workflow, /release-api:[\s\S]*?timeout-minutes: 360/u);
  assert.match(
    workflow,
    /Reserve the archive audit and cleanup time budget[\s\S]*elapsedSeconds > 10_800/u,
  );
  assert.match(
    workflow,
    /id: archive_audit\n\s+if: \$\{\{ success\(\) && !cancelled\(\) \}\}\n\s+timeout-minutes: 100[\s\S]*Reconcile the Railway archive audit deployment[\s\S]*if: \$\{\{ always\(\) && steps\.archive_audit\.outcome != 'skipped' \}\}\n\s+timeout-minutes: 4[\s\S]*--cleanup-only/u,
  );
  assert.match(
    workflow,
    /Preserve the non-PII archive audit envelope\n\s+if: \$\{\{ always\(\) && steps\.archive_audit\.outcome != 'skipped' \}\}\n\s+timeout-minutes: 10/u,
  );
  assert.ok(
    workflow.indexOf('--cleanup-only') < workflow.indexOf('activate-release-protocols-v2.sh'),
    'durable archive cleanup must run before any irreversible activation',
  );
  assert.match(
    workflow,
    /Activate archive\/settlement\/outbox v2 and finalize the certified release\n\s+if: \$\{\{ success\(\) && steps\.archive_audit\.outcome == 'success' \}\}\n\s+timeout-minutes: 60[\s\S]*?certify_exact_revision before-activation[\s\S]*?activate-release-protocols-v2\.sh[\s\S]*?certify_exact_revision before-postdeploy[\s\S]*?env BOB_RELEASE_PHASE=postdeploy/u,
  );
});

async function waitForChildOutput(child, expected) {
  await new Promise((resolveOutput, rejectOutput) => {
    let stdout = '';
    const timeout = setTimeout(() => {
      rejectOutput(new Error(`child did not emit ${expected}; stdout=${stdout}`));
    }, 5_000);
    const finish = (callback, value) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const onData = (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(expected)) finish(resolveOutput);
    };
    const onError = (error) => finish(rejectOutput, error);
    const onExit = (code, signal) => {
      finish(
        rejectOutput,
        new Error(`child exited before ${expected}: code=${code}, signal=${signal}`),
      );
    };
    child.stdout.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

test('SIGHUP/SIGINT/SIGTERM réels annulent une seule fois le déploiement distant sans preuve acceptée', async (t) => {
  for (const [signalName, expectedExitCode] of [
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    await t.test(signalName, async (subtest) => {
      const outputPath = await temporaryOutput(subtest, `${signalName}-evidence.json`);
      const cleanupPath = join(dirname(outputPath), `${signalName}-cleanup.txt`);
      await mkdir(dirname(outputPath), { recursive: true });
      const childSource = `
        import { writeFileSync } from 'node:fs';
        const [moduleUrl, cleanupPath, outputPath] = process.argv.slice(1);
        const {
          runRailwayDocumentArchiveAudit,
          runRailwayDocumentArchiveAuditCli,
        } = await import(moduleUrl);
        const projectId = '${PROJECT_ID}';
        const serviceId = '${SERVICE_ID}';
        const environmentId = '${ENVIRONMENT_ID}';
        const deploymentId = '${DEPLOYMENT_ID}';
        const response = (data) => new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
        const fetchImpl = async (_url, init) => {
          const query = JSON.parse(init.body).query;
          if (query.includes('ProjectToken')) {
            return response({ projectToken: { projectId, environmentId } });
          }
          if (query.includes('ArchiveAuditServiceInstance')) {
            return response({
              serviceInstance: {
                id: '50000000-0000-4000-8000-000000000006',
                serviceId,
                environmentId,
                railwayConfigFile: '/railway.archive-audit.json',
                startCommand: '/usr/local/bin/bob-archive-audit-entrypoint',
                builder: 'DOCKERFILE',
                dockerfilePath: 'Dockerfile.archive-audit',
                preDeployCommand: null,
                cronSchedule: null,
                sleepApplication: false,
                healthcheckPath: null,
                healthcheckTimeout: null,
                numReplicas: 1,
                drainingSeconds: 30,
                overlapSeconds: 0,
                restartPolicyType: 'NEVER',
                restartPolicyMaxRetries: 10,
              },
              serviceInstanceAutoDeployStatus: { enabled: false },
            });
          }
          if (query.includes('ArchiveAuditDeploymentsSnapshot')) {
            return response({ deployments: {
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            } });
          }
          if (query.includes('DeployArchiveAudit')) {
            process.stdout.write('DEPLOYED\\n');
            return response({ serviceInstanceDeployV2: deploymentId });
          }
          if (query.includes('ArchiveAuditDeploymentCancel')) {
            writeFileSync(cleanupPath, 'cancel\\n', { encoding: 'utf8', flag: 'a' });
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
            return response({ deploymentCancel: true });
          }
          if (query.includes('ArchiveAuditDeployment')) {
            return await new Promise((_resolve, reject) => {
              const rejectAborted = () => reject(
                init.signal?.reason ?? new DOMException('Aborted', 'AbortError')
              );
              if (init.signal?.aborted) rejectAborted();
              else init.signal?.addEventListener('abort', rejectAborted, { once: true });
            });
          }
          throw new Error('unexpected GraphQL operation');
        };
        const keepAlive = setInterval(() => undefined, 1_000);
        try {
          await runRailwayDocumentArchiveAuditCli({
            run: ({ cancellationSignal }) => runRailwayDocumentArchiveAudit({
              cancellationSignal,
              environment: {
                RAILWAY_TOKEN: 'railway-project-token',
                RAILWAY_ARCHIVE_AUDIT_SERVICE_ID: serviceId,
                RAILWAY_ENVIRONMENT_ID: environmentId,
                RELEASE_SHA: '${RELEASE_SHA}',
                DOCUMENT_ARCHIVE_AUDIT_CI_EVIDENCE: outputPath,
                DOCUMENT_ARCHIVE_AUDIT_TIMEOUT_SECONDS: '60',
                DOCUMENT_ARCHIVE_AUDIT_POLL_SECONDS: '10',
              },
              fetchImpl,
            }),
          });
        } finally {
          clearInterval(keepAlive);
        }
      `;
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          childSource,
          pathToFileURL(SCRIPT_PATH).href,
          cleanupPath,
          outputPath,
        ],
        { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let childStderr = '';
      child.stderr.on('data', (chunk) => {
        childStderr += chunk.toString('utf8');
      });
      subtest.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });

      await waitForChildOutput(child, 'DEPLOYED\n');
      const exit = once(child, 'exit');
      assert.equal(child.kill(signalName), true);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      if (child.exitCode === null && child.signalCode === null) child.kill(signalName);
      const [exitCode, exitSignal] = await exit;

      assert.equal(exitCode, expectedExitCode, `exitSignal=${exitSignal}; stderr=${childStderr}`);
      assert.equal(exitSignal, null);
      assert.equal(await readFile(cleanupPath, 'utf8'), 'cancel\n');
      await assert.rejects(readFile(outputPath), (error) => error?.code === 'ENOENT');
    });
  }
});

test('l’exécution directe échoue avant réseau sans configuration', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: REPOSITORY_ROOT,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RAILWAY_TOKEN is required/u);
  assert.equal(result.stdout, '');
});
