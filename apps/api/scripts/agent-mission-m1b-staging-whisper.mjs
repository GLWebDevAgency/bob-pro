#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[0-9a-f]{40}$/u;
const TOKEN = /^[\x21-\x7e]{32,256}$/u;
const MAX_RESPONSE_BYTES = 1_048_576;
const EXPECTED_SERVICE_NAME = 'bob-live-whisper-audit';
const EXPECTED_RAILWAY_CONFIG = '/railway.whisper-audit.json';
const EXPECTED_DOCKERFILE = 'Dockerfile.whisper-audit';
const EXPECTED_PRIVATE_URL = 'http://bob-live-whisper-audit.railway.internal:8080/v1';
const TERMINAL_FAILURES = new Set([
  'CRASHED',
  'FAILED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
]);
const TRANSIENT_STATES = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING']);

const PREFLIGHT_QUERY = `
query BobLiveWhisperAuditPreflight(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $apiServiceId: String!
) {
  projectToken {
    projectId
    environmentId
  }
  service(id: $serviceId) {
    id
    name
    projectId
  }
  environment(id: $environmentId, projectId: $projectId) {
    id
    name
    volumeInstances(first: 500) {
      edges {
        node {
          serviceId
          environmentId
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    id
    serviceId
    environmentId
    railwayConfigFile
    startCommand
    builder
    dockerfilePath
    preDeployCommand
    cronSchedule
    sleepApplication
    healthcheckPath
    healthcheckTimeout
    numReplicas
    drainingSeconds
    overlapSeconds
    restartPolicyType
    restartPolicyMaxRetries
  }
  serviceInstanceAutoDeployStatus(
    projectId: $projectId
    serviceId: $serviceId
    environmentId: $environmentId
  ) {
    enabled
  }
  domains(
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
  ) {
    serviceDomains {
      id
      domain
    }
    customDomains {
      id
      domain
    }
  }
  tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
    id
    domain
    proxyPort
    applicationPort
  }
  auditorVariables: variables(
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
    unrendered: true
  )
  auditorRenderedVariables: variables(
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
  )
  apiVariables: variables(
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $apiServiceId
  )
}
`;

const DEPLOYMENT_QUERY = `
query BobLiveWhisperAuditDeployment($id: String!) {
  deployment(id: $id) {
    id
    projectId
    environmentId
    serviceId
    status
  }
}
`;

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-whisper:${message}`);
}

function object(value) {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? value
    : null;
}

function required(environment, name, minimum = 1, maximum = 16_384) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function uuid(environment, name) {
  const value = required(environment, name, 1, 80);
  if (!UUID.test(value)) fail(`${name} must be a UUID`);
  return value;
}

function exactSecretEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function variables(value, label) {
  const source = object(value);
  if (source === null) fail(`Railway returned invalid ${label} variables`);
  const decoded = {};
  for (const [name, variableValue] of Object.entries(source)) {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) ||
      typeof variableValue !== 'string' ||
      Buffer.byteLength(variableValue, 'utf8') > 65_536
    ) {
      fail(`Railway returned unreadable ${label} variables`);
    }
    decoded[name] = variableValue;
  }
  return decoded;
}

export function parseWhisperStagingEnvironment(environment = process.env) {
  const config = {
    token: required(environment, 'RAILWAY_TOKEN', 16, 4_096),
    projectId: uuid(environment, 'RAILWAY_PROJECT_ID'),
    environmentId: uuid(environment, 'RAILWAY_ENVIRONMENT_ID'),
    serviceId: uuid(environment, 'RAILWAY_WHISPER_AUDIT_SERVICE_ID'),
    apiServiceId: uuid(environment, 'RAILWAY_API_SERVICE_ID'),
    releaseSha: required(environment, 'BOB_M1B_RELEASE_SHA', 40, 40),
  };
  if (config.serviceId === config.apiServiceId) {
    fail('Whisper and API must be distinct Railway services');
  }
  if (!SHA.test(config.releaseSha)) {
    fail('BOB_M1B_RELEASE_SHA must be exact lowercase 40-hex');
  }
  return Object.freeze(config);
}

function assertExactServiceInstance(instanceValue, autoDeployValue, config) {
  const instance = object(instanceValue);
  const autoDeploy = object(autoDeployValue);
  if (instance?.serviceId !== config.serviceId || instance.environmentId !== config.environmentId) {
    fail('Railway returned another Whisper service instance');
  }
  const violations = [];
  if (instance.railwayConfigFile !== EXPECTED_RAILWAY_CONFIG) {
    violations.push(`railwayConfigFile=${String(instance.railwayConfigFile)}`);
  }
  if (
    instance.builder !== 'DOCKERFILE' &&
    !(instance.builder === 'RAILPACK' && instance.dockerfilePath === EXPECTED_DOCKERFILE)
  ) {
    violations.push(`builder=${String(instance.builder)}`);
  }
  if (instance.dockerfilePath !== EXPECTED_DOCKERFILE) {
    violations.push(`dockerfilePath=${String(instance.dockerfilePath)}`);
  }
  for (const [name, actual, expected] of [
    ['startCommand', instance.startCommand, null],
    ['preDeployCommand', instance.preDeployCommand, null],
    ['cronSchedule', instance.cronSchedule, null],
    ['sleepApplication', instance.sleepApplication, false],
    ['healthcheckPath', instance.healthcheckPath, '/v1/health'],
    ['healthcheckTimeout', instance.healthcheckTimeout, 180],
    ['numReplicas', instance.numReplicas, 1],
    ['drainingSeconds', instance.drainingSeconds, 30],
    ['overlapSeconds', instance.overlapSeconds, 30],
    ['restartPolicyType', instance.restartPolicyType, 'ON_FAILURE'],
    ['restartPolicyMaxRetries', instance.restartPolicyMaxRetries, 5],
  ]) {
    if (actual !== expected) violations.push(`${name}=${String(actual)}`);
  }
  if (autoDeploy?.enabled !== false) {
    violations.push(`autoDeployEnabled=${String(autoDeploy?.enabled)}`);
  }
  if (violations.length > 0) {
    fail(`Whisper service configuration drifted: ${violations.join(', ')}`);
  }
}

function assertNoPersistentVolume(connectionValue, config) {
  const connection = object(connectionValue);
  const pageInfo = object(connection?.pageInfo);
  if (!Array.isArray(connection?.edges) || pageInfo?.hasNextPage !== false) {
    fail('Railway volume inventory is unavailable or incomplete');
  }
  for (const edgeValue of connection.edges) {
    const edge = object(edgeValue);
    const node = object(edge?.node);
    if (
      node === null ||
      (node.serviceId !== null && typeof node.serviceId !== 'string') ||
      node.environmentId !== config.environmentId
    ) {
      fail('Railway returned an invalid volume instance');
    }
    if (node.serviceId === config.serviceId) {
      fail('Whisper must have no persistent volume');
    }
  }
}

export function certifyWhisperStagingPreflight(payload, config) {
  const data = object(payload);
  const projectToken = object(data?.projectToken);
  const service = object(data?.service);
  const environment = object(data?.environment);
  if (
    projectToken?.projectId !== config.projectId ||
    projectToken.environmentId !== config.environmentId ||
    service?.id !== config.serviceId ||
    service.name !== EXPECTED_SERVICE_NAME ||
    service.projectId !== config.projectId ||
    environment?.id !== config.environmentId ||
    environment.name !== 'staging'
  ) {
    fail('Railway token, service or environment identity mismatched');
  }
  assertExactServiceInstance(data.serviceInstance, data.serviceInstanceAutoDeployStatus, config);
  assertNoPersistentVolume(environment.volumeInstances, config);
  const domains = object(data.domains);
  if (
    !Array.isArray(domains?.serviceDomains) ||
    !Array.isArray(domains.customDomains) ||
    domains.serviceDomains.length !== 0 ||
    domains.customDomains.length !== 0 ||
    !Array.isArray(data.tcpProxies) ||
    data.tcpProxies.length !== 0
  ) {
    fail('Whisper must have no public HTTP domain or TCP proxy');
  }

  const auditorInventory = variables(data.auditorVariables, 'Whisper unrendered');
  const auditorRendered = variables(data.auditorRenderedVariables, 'Whisper rendered');
  const api = variables(data.apiVariables, 'API');
  const auditorNames = Object.keys(auditorInventory);
  if (
    auditorNames.length !== 1 ||
    auditorNames[0] !== 'BOB_LIVE_LOCAL_AUDIT_TOKEN'
  ) {
    fail('Whisper must receive exactly one dedicated audit token');
  }
  const auditToken = auditorRendered.BOB_LIVE_LOCAL_AUDIT_TOKEN;
  if (
    !TOKEN.test(auditToken ?? '') ||
    api.BOB_LIVE_ENABLED !== 'true' ||
    api.BOB_LIVE_PROVIDER !== 'openai' ||
    api.BOB_LIVE_SPEECH_DELIVERY !== 'audited-signed-url-v1' ||
    api.BOB_LIVE_AUDIT_PROVIDER !== 'local-whisper' ||
    api.BOB_LIVE_LOCAL_AUDIT_BASE_URL !== EXPECTED_PRIVATE_URL ||
    typeof api.OPENAI_API_KEY !== 'string' ||
    api.OPENAI_API_KEY.length < 1 ||
    !exactSecretEqual(auditToken, api.BOB_LIVE_LOCAL_AUDIT_TOKEN)
  ) {
    fail('API and Whisper audit configuration is incomplete or divergent');
  }
  const reusedByApi = Object.entries(api).some(
    ([name, value]) => name !== 'BOB_LIVE_LOCAL_AUDIT_TOKEN' && exactSecretEqual(auditToken, value),
  );
  if (reusedByApi) {
    fail('Whisper audit token must be dedicated and not reused by the API');
  }
  return Object.freeze({
    serviceId: config.serviceId,
    environmentId: config.environmentId,
    releaseSha: config.releaseSha,
    privateOnly: true,
    variablesIsolated: true,
    speechDelivery: 'audited-signed-url-v1',
  });
}

async function readBoundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      fail('Railway GraphQL response exceeded the size limit');
    }
    return text;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail('Railway returned an invalid body');
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail('Railway GraphQL response exceeded the size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function railwayGraphql(config, query, queryVariables, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (typeof fetchImpl !== 'function') fail('fetch is unavailable');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetchImpl(RAILWAY_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Project-Access-Token': config.token,
        },
        body: JSON.stringify({ query, variables: queryVariables }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response || typeof response.status !== 'number') {
        fail('Railway GraphQL returned an invalid HTTP response');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
          await sleep(500 * attempt);
          continue;
        }
        fail(`Railway GraphQL returned HTTP ${response.status}`);
      }
      const raw = await readBoundedBody(response);
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        fail('Railway GraphQL returned invalid JSON');
      }
      if (
        object(envelope) === null ||
        object(envelope.data) === null ||
        (Object.hasOwn(envelope, 'errors') && envelope.errors !== undefined)
      ) {
        fail('Railway GraphQL rejected the operation');
      }
      return envelope.data;
    } catch (error) {
      if (attempt < 3 && (error?.name === 'AbortError' || error instanceof TypeError)) {
        await sleep(500 * attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  fail('Railway GraphQL exhausted its bounded retries');
}

export async function runWhisperStagingPreflight(environment = process.env, dependencies = {}) {
  const config = parseWhisperStagingEnvironment(environment);
  const graphql = dependencies.graphql ?? railwayGraphql;
  const data = await graphql(
    config,
    PREFLIGHT_QUERY,
    {
      projectId: config.projectId,
      environmentId: config.environmentId,
      serviceId: config.serviceId,
      apiServiceId: config.apiServiceId,
    },
    dependencies,
  );
  return certifyWhisperStagingPreflight(data, config);
}

export async function waitForWhisperStagingDeployment(
  deploymentId,
  environment = process.env,
  dependencies = {},
) {
  if (!UUID.test(deploymentId ?? '')) fail('deploymentId must be a UUID');
  const config = parseWhisperStagingEnvironment(environment);
  const graphql = dependencies.graphql ?? railwayGraphql;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = dependencies.attempts ?? 90;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const data = await graphql(config, DEPLOYMENT_QUERY, { id: deploymentId }, dependencies);
    const deployment = object(data.deployment);
    if (
      deployment?.id !== deploymentId ||
      deployment.projectId !== config.projectId ||
      deployment.environmentId !== config.environmentId ||
      deployment.serviceId !== config.serviceId ||
      typeof deployment.status !== 'string'
    ) {
      fail('Railway deployment identity is unavailable or mismatched');
    }
    if (deployment.status === 'SUCCESS') {
      return Object.freeze({ deploymentId, status: 'SUCCESS' });
    }
    if (TERMINAL_FAILURES.has(deployment.status)) {
      fail(`Railway deployment reached terminal status ${deployment.status}`);
    }
    if (!TRANSIENT_STATES.has(deployment.status)) {
      fail('Railway deployment returned an unknown status');
    }
    if (attempt < attempts) await sleep(10_000);
  }
  fail('Railway deployment did not reach SUCCESS within the bounded window');
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'preflight') {
    const result = await runWhisperStagingPreflight();
    process.stdout.write(`agent-mission-m1b-staging-whisper:ok:preflight:${result.releaseSha}\n`);
    return;
  }
  if (command === 'wait-deployment') {
    const result = await waitForWhisperStagingDeployment(argument);
    process.stdout.write(
      `agent-mission-m1b-staging-whisper:ok:${result.status}:${result.deploymentId}\n`,
    );
    return;
  }
  fail('command must be preflight or wait-deployment');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : 'agent-mission-m1b-staging-whisper:unknown error'
      }\n`,
    );
    process.exitCode = 1;
  });
}
