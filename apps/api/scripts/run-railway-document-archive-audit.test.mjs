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
  extractArchiveAuditEvidence,
  runRailwayDocumentArchiveAudit,
} from './run-railway-document-archive-audit.mjs';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const SERVICE_ID = '20000000-0000-4000-8000-000000000002';
const ENVIRONMENT_ID = '30000000-0000-4000-8000-000000000003';
const OTHER_ENVIRONMENT_ID = '30000000-0000-4000-8000-000000000004';
const DEPLOYMENT_ID = '40000000-0000-4000-8000-000000000005';
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
    healthcheckPath: null,
    numReplicas: 1,
    restartPolicyType: 'NEVER',
    ...overrides,
  };
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

function serviceInstanceStep(instance = serviceInstanceFixture()) {
  return {
    operation: 'ArchiveAuditServiceInstance',
    assertVariables: (variables) =>
      assert.deepEqual(variables, { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID }),
    response: dataResponse({ serviceInstance: instance }),
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
  return {
    operation: 'ArchiveAuditDeployment',
    assertVariables: (variables) => assert.deepEqual(variables, { id: DEPLOYMENT_ID }),
    response: dataResponse({
      deployment: { id: DEPLOYMENT_ID, status, ...deploymentOverrides },
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

function cleanupStep(kind, response = true) {
  return {
    operation: kind === 'cancel' ? 'ArchiveAuditDeploymentCancel' : 'ArchiveAuditDeploymentStop',
    assertVariables: (variables) => assert.deepEqual(variables, { id: DEPLOYMENT_ID }),
    response: dataResponse({
      [kind === 'cancel' ? 'deploymentCancel' : 'deploymentStop']: response,
    }),
  };
}

function beforeDeploymentSteps() {
  return [projectStep(), serviceInstanceStep(), deployStep()];
}

function successSteps({ status = 'COMPLETED', logs = [{ message: marker() }] } = {}) {
  return [...beforeDeploymentSteps(), deploymentStep(status), logsStep(logs)];
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
  let output = '';
  return {
    now: () => milliseconds,
    requestTimeoutSignal: () => undefined,
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
      'DeployArchiveAudit',
      'ArchiveAuditDeployment',
      'ArchiveAuditLogs',
    ],
  );
  fetchImpl.assertDone();
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), evidenceFixture());
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(runtime.output()), {
    deploymentId: DEPLOYMENT_ID,
    status: 'COMPLETED',
    evidencePath: resolve(outputPath),
  });
});

test('refuse toute dérive du service Railway avant la mutation', async (t) => {
  const driftCases = [
    ['config-file', { railwayConfigFile: '/railway.json' }, /railwayConfigFile/u],
    ['start-command', { startCommand: 'node server.js' }, /startCommand/u],
    ['builder', { builder: 'RAILPACK' }, /builder/u],
    ['healthcheck', { healthcheckPath: '/health' }, /healthcheckPath/u],
    ['replicas', { numReplicas: 2 }, /numReplicas/u],
    ['restart', { restartPolicyType: 'ON_FAILURE' }, /restartPolicyType/u],
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
  assert.deepEqual(runtime.sleeps, [60_000]);
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
  assert.deepEqual(datedRuntime.sleeps, [60_000]);
  datedFetch.assertDone();

  const failedOutputPath = await temporaryOutput(t, 'mutation-failed.json');
  const mutationFetch = scriptedFetch([
    projectStep(),
    serviceInstanceStep(),
    deployStep({ throw: new TypeError('socket closed after request') }),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(failedOutputPath),
      fetchImpl: mutationFetch,
      ...fakeRuntime(),
    }),
    /failed before a usable response/u,
  );
  assert.equal(
    mutationFetch.calls.filter(({ operation }) => operation === 'DeployArchiveAudit').length,
    1,
  );
  mutationFetch.assertDone();
});

test('SUCCESS exige deux observations espacées de dix secondes', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...successSteps({ status: 'SUCCESS' }),
    deploymentStep('SUCCESS'),
    logsStep(),
  ]);
  const runtime = fakeRuntime();
  await runRailwayDocumentArchiveAudit({
    environment: baseEnvironment(outputPath),
    fetchImpl,
    ...runtime,
  });
  assert.deepEqual(runtime.sleeps, [10_000]);
  fetchImpl.assertDone();
});

test('un crash post-marqueur prêt reste un crash et ne produit aucune preuve CI', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = scriptedFetch([
    ...successSteps({ status: 'SUCCESS' }),
    deploymentStep('CRASHED'),
    logsStep(),
  ]);
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    /CRASHED without a valid refusal/u,
  );
  await assert.rejects(readFile(outputPath), (error) => error?.code === 'ENOENT');
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

test('un refus observé pendant SUCCESS est persisté puis le processus vivant est stoppé', async (t) => {
  const outputPath = await temporaryOutput(t);
  const refusal = refusalFixture();
  const fetchImpl = scriptedFetch([
    ...beforeDeploymentSteps(),
    deploymentStep('SUCCESS'),
    logsStep([{ message: marker(refusal) }]),
    cleanupStep('stop'),
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
  const fetchImpl = scriptedFetch(successSteps());
  await assert.rejects(
    runRailwayDocumentArchiveAudit({
      environment: baseEnvironment(outputPath),
      fetchImpl,
      ...fakeRuntime(),
    }),
    (error) => error?.code === 'EEXIST',
  );
  assert.equal(await readFile(outputPath, 'utf8'), 'existing-proof\n');
  fetchImpl.assertDone();
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

test('le contrat image/config impose Node épinglé, rôle non-root et smoke bubblewrap réel', async () => {
  const dockerfile = await readFile(join(REPOSITORY_ROOT, 'Dockerfile.archive-audit'), 'utf8');
  assert.match(dockerfile, /FROM node:22\.18\.0-slim AS base/u);
  assert.match(dockerfile, /USER bob-archive-audit:bob-archive-audit/u);
  assert.match(dockerfile, /id -u[^\n]+10001/u);
  assert.match(dockerfile, /\/usr\/bin\/bwrap/u);
  assert.match(dockerfile, /--unshare-net/u);
  assert.match(dockerfile, /--clearenv/u);
  assert.match(dockerfile, /--ro-bind \/ \/ /u);
  assert.match(dockerfile, /inner-workdir-writable/u);
  assert.match(dockerfile, /BOB_ARCHIVE_SANDBOX_SMOKE_SECRET/u);

  const railwayConfig = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, 'railway.archive-audit.json'), 'utf8'),
  );
  assert.deepEqual(railwayConfig.build, {
    builder: 'DOCKERFILE',
    dockerfilePath: 'Dockerfile.archive-audit',
  });
  assert.equal(railwayConfig.deploy.startCommand, '/usr/local/bin/bob-archive-audit-entrypoint');
  assert.equal(railwayConfig.deploy.healthcheckPath, null);
  assert.equal(railwayConfig.deploy.healthcheckTimeout, null);
  assert.equal(railwayConfig.deploy.numReplicas, 1);
  assert.equal(railwayConfig.deploy.restartPolicyType, 'NEVER');
  assert.equal(railwayConfig.deploy.restartPolicyMaxRetries, null);
  assert.deepEqual(
    Object.values(railwayConfig.deploy.multiRegionConfig).map(({ numReplicas }) => numReplicas),
    [1],
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
            return response({ serviceInstance: {
              id: '50000000-0000-4000-8000-000000000006',
              serviceId,
              environmentId,
              railwayConfigFile: '/railway.archive-audit.json',
              startCommand: '/usr/local/bin/bob-archive-audit-entrypoint',
              builder: 'DOCKERFILE',
              healthcheckPath: null,
              numReplicas: 1,
              restartPolicyType: 'NEVER',
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

      assert.equal(
        exitCode,
        expectedExitCode,
        `exitSignal=${exitSignal}; stderr=${childStderr}`,
      );
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
