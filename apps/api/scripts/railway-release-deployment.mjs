#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ENVIRONMENT_NAME = /^(?:production|staging)$/u;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RETRY_AFTER_MILLISECONDS = 60_000;
const DEFAULT_POLL_ATTEMPTS = 330;
const DEFAULT_POLL_MILLISECONDS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MILLISECONDS = 3_300_000;
const MAX_REGISTRATION_WAIT_MILLISECONDS = 60_000;
const DEPLOYMENT_REGISTRATION_PAGE_SIZE = 100;
const MAX_DEPLOYMENT_REGISTRATION_PAGES = 20;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TERMINAL_DEPLOYMENT_FAILURES = new Set([
  'CRASHED',
  'FAILED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
]);
const TRANSIENT_DEPLOYMENT_STATES = new Set([
  'BUILDING',
  'DEPLOYING',
  'INITIALIZING',
  'QUEUED',
  'WAITING',
]);
const SAFE_NON_SERVING_LATEST_DEPLOYMENT_STATUSES = new Set([
  'CRASHED',
  'FAILED',
  'REMOVED',
  'SKIPPED',
]);

const RAILWAY_DEPLOYMENT_QUERY = `
query BobReleaseDeployment($id: String!) {
  deployment(id: $id) {
    id
    projectId
    environmentId
    serviceId
    status
    deploymentStopped
    instances {
      id
      status
    }
  }
}
`;

const RAILWAY_DEPLOYMENT_REGISTRATION_QUERY = `
query BobReleaseDeploymentRegistration(
  $input: DeploymentListInput!
  $first: Int!
  $after: String
) {
  deployments(input: $input, first: $first, after: $after) {
    edges {
      node {
        id
        projectId
        environmentId
        serviceId
        status
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

class RetryableGraphqlError extends Error {
  constructor(message, retryAfterMilliseconds = null) {
    super(message);
    this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
}

class GraphqlTransportUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'GraphqlTransportUnavailableError';
  }
}

class DeploymentWaitDeadlineExceededError extends Error {
  constructor() {
    super('railway-release-deployment:deployment wait exceeded its absolute deadline');
    this.name = 'DeploymentWaitDeadlineExceededError';
  }
}

function fail(message) {
  throw new Error(`railway-release-deployment:${message}`);
}

function plainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function required(environment, name, { minimum = 1, maximum = 4_096 } = {}) {
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
  const value = required(environment, name, { maximum: 80 });
  if (!UUID.test(value)) fail(`${name} must be a UUID`);
  return value;
}

function remainingDeadlineMilliseconds(now, deadline) {
  const observedAt = now();
  if (!Number.isFinite(observedAt)) fail('monotonic clock returned an invalid value');
  const remaining = deadline - observedAt;
  if (remaining <= 0) throw new DeploymentWaitDeadlineExceededError();
  return Math.max(1, Math.ceil(remaining));
}

function retryAfterMilliseconds(response, nowEpochMilliseconds) {
  const raw = response.headers?.get?.('retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  let milliseconds;
  if (Number.isFinite(seconds) && seconds >= 0) {
    milliseconds = seconds * 1_000;
  } else {
    const retryAt = Date.parse(raw);
    if (!Number.isFinite(retryAt)) return null;
    milliseconds = retryAt - nowEpochMilliseconds();
  }
  return Math.min(MAX_RETRY_AFTER_MILLISECONDS, Math.max(1_000, Math.ceil(milliseconds)));
}

export function parseRailwayReleaseDeploymentEnvironment(environment = process.env) {
  const environmentName = required(environment, 'TARGET_ENVIRONMENT_NAME', { maximum: 32 });
  if (!ENVIRONMENT_NAME.test(environmentName)) {
    fail('TARGET_ENVIRONMENT_NAME must be staging or production');
  }
  return Object.freeze({
    token: required(environment, 'RAILWAY_TOKEN', { minimum: 16 }),
    projectId: uuid(environment, 'RAILWAY_PROJECT_ID'),
    environmentId: uuid(environment, 'RAILWAY_ENVIRONMENT_ID'),
    serviceId: uuid(environment, 'RAILWAY_API_SERVICE_ID'),
    environmentName,
  });
}

export function parseRailwayReleaseRecoveryRoute(environment = process.env) {
  const purpose = required(environment, 'RELEASE_PURPOSE', { maximum: 80 });
  if (purpose !== 'release-recovery') {
    return Object.freeze({ purpose, recovery: false });
  }
  const environmentName = required(environment, 'RELEASE_ENVIRONMENT', { maximum: 32 });
  const eventName = required(environment, 'GITHUB_EVENT_NAME', { maximum: 80 });
  const controlWorkflowRef = required(environment, 'CALLER_WORKFLOW_REF', { maximum: 1_024 });
  const expectedWorkflowRef = required(environment, 'EXPECTED_DIRECT_RECOVERY_REF', {
    maximum: 1_024,
  });
  const controlRef = required(environment, 'RELEASE_REF', { maximum: 512 });
  if (eventName !== 'workflow_dispatch') {
    fail('release-recovery requires workflow_dispatch');
  }
  if (controlWorkflowRef !== expectedWorkflowRef) {
    fail('release-recovery refuses reusable workflow callers');
  }
  if (controlRef !== 'refs/heads/main') {
    fail('release-recovery requires main');
  }
  if (environmentName !== 'staging') {
    fail('release-recovery is staging-only until the production promotion gate is certified');
  }
  return Object.freeze({
    purpose,
    recovery: true,
    environmentName,
    workflowRef: controlWorkflowRef,
    ref: controlRef,
  });
}

export function parseRailwayUpDeploymentId(value) {
  let payload;
  try {
    payload = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail('railway up returned invalid JSON');
  }
  if (!plainObject(payload) || !UUID.test(payload.deploymentId ?? '')) {
    fail('railway up did not return a canonical deploymentId');
  }
  return payload.deploymentId;
}

export function parseRailwayTargetIdentity(value, config, options = {}) {
  let project;
  try {
    project = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail('railway status returned invalid JSON');
  }
  if (!plainObject(project) || project.id !== config.projectId) {
    fail('railway status did not select the expected project');
  }
  const environments = project.environments?.edges;
  if (!Array.isArray(environments)) fail('railway status omitted environments');
  const matchingEnvironments = environments
    .map((edge) => edge?.node)
    .filter(
      (environment) =>
        environment?.id === config.environmentId && environment?.name === config.environmentName,
    );
  if (matchingEnvironments.length !== 1) {
    fail('railway status did not select exactly one expected environment');
  }
  const instances = matchingEnvironments[0]?.serviceInstances?.edges;
  if (!Array.isArray(instances)) fail('railway status omitted service instances');
  const matchingServices = instances
    .map((edge) => edge?.node)
    .filter(
      (instance) =>
        instance?.serviceId === config.serviceId && instance?.serviceName === config.serviceName,
    );
  if (matchingServices.length !== 1) {
    fail('railway status did not select exactly one expected service identity');
  }
  parseRailwayServingServiceDeploymentId(matchingServices[0], options);
  return Object.freeze({
    projectId: config.projectId,
    environmentId: config.environmentId,
    serviceId: config.serviceId,
  });
}

function parseRailwayServingServiceDeploymentId(
  service,
  { allowStableTerminalLatest = false } = {},
) {
  if (typeof allowStableTerminalLatest !== 'boolean') {
    fail('allowStableTerminalLatest must be boolean');
  }
  const active = service.activeDeployments;
  const latest = service.latestDeployment;
  if (
    !Array.isArray(active) ||
    active.length !== 1 ||
    !plainObject(active[0]) ||
    !plainObject(latest) ||
    !UUID.test(active[0].id ?? '') ||
    !UUID.test(latest.id ?? '') ||
    typeof latest.status !== 'string' ||
    typeof latest.deploymentStopped !== 'boolean' ||
    !Array.isArray(latest.instances) ||
    active[0].status !== 'SUCCESS' ||
    active[0].deploymentStopped !== false ||
    !Array.isArray(active[0].instances) ||
    active[0].instances.length !== 1 ||
    active[0].instances[0]?.status !== 'RUNNING'
  ) {
    fail('railway status did not prove one exact serving deployment');
  }
  if (latest.id === active[0].id) {
    if (
      latest.status !== 'SUCCESS' ||
      latest.deploymentStopped !== false ||
      latest.instances.length !== 1 ||
      latest.instances[0]?.status !== 'RUNNING'
    ) {
      fail('railway latest deployment disagrees with the serving deployment');
    }
  } else {
    if (!allowStableTerminalLatest) {
      fail('railway latest deployment is not the exact serving deployment');
    }
    if (
      !SAFE_NON_SERVING_LATEST_DEPLOYMENT_STATUSES.has(latest.status) ||
      latest.instances.some(
        (instance) =>
          !plainObject(instance) ||
          !UUID.test(instance.id ?? '') ||
          typeof instance.status !== 'string' ||
          instance.status === 'RUNNING',
      )
    ) {
      fail('railway latest deployment is not a stable terminal failure');
    }
  }
  return active[0].id;
}

export function parseRailwayServingDeploymentId(value, config, options = {}) {
  let project;
  try {
    project = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail('railway status returned invalid JSON');
  }
  if (config.projectId !== undefined && project?.id !== config.projectId) {
    fail('railway status did not select the expected project');
  }
  const environments = project?.environments?.edges;
  if (!Array.isArray(environments)) fail('railway status omitted environments');
  const matchingEnvironments = environments
    .map((edge) => edge?.node)
    .filter((environment) => environment?.id === config.environmentId);
  if (
    matchingEnvironments.length !== 1 ||
    matchingEnvironments[0]?.name !== config.environmentName
  ) {
    fail('railway status did not select exactly one expected environment');
  }
  const instances = matchingEnvironments[0]?.serviceInstances?.edges;
  if (!Array.isArray(instances)) fail('railway status omitted service instances');
  const matchingServices = instances
    .map((edge) => edge?.node)
    .filter((instance) => instance?.serviceId === config.serviceId);
  if (matchingServices.length !== 1) {
    fail('railway status did not select exactly one API service instance');
  }
  return parseRailwayServingServiceDeploymentId(matchingServices[0], options);
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
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail('Railway GraphQL returned an invalid body');
    byteLength += value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail('Railway GraphQL response exceeded the size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

export async function railwayDeploymentGraphql(config, query, variables, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? (() => performance.now());
  const nowEpochMilliseconds = dependencies.nowEpochMilliseconds ?? Date.now;
  const deadline = dependencies.deadline ?? null;
  if (typeof fetchImpl !== 'function') fail('fetch is unavailable');

  const maximumAttempts = dependencies.graphqlAttempts ?? 3;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3) {
    fail('Railway GraphQL attempt bound is invalid');
  }
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const controller = new AbortController();
    const requestTimeoutMilliseconds =
      deadline === null ? 30_000 : Math.min(30_000, remainingDeadlineMilliseconds(now, deadline));
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMilliseconds);
    try {
      const response = await fetchImpl(RAILWAY_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Project-Access-Token': config.token,
        },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response || typeof response.status !== 'number') {
        fail('Railway GraphQL returned an invalid HTTP response');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
          throw new RetryableGraphqlError(
            `Railway GraphQL returned HTTP ${response.status}`,
            retryAfterMilliseconds(response, nowEpochMilliseconds),
          );
        }
        fail(`Railway GraphQL returned HTTP ${response.status}`);
      }
      const raw = await readBoundedBody(response);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        fail('Railway GraphQL returned invalid JSON');
      }
      if (
        !plainObject(payload) ||
        !plainObject(payload.data) ||
        (Object.hasOwn(payload, 'errors') && payload.errors !== undefined)
      ) {
        fail('Railway GraphQL rejected the operation');
      }
      if (deadline !== null) remainingDeadlineMilliseconds(now, deadline);
      return payload.data;
    } catch (error) {
      if (error instanceof DeploymentWaitDeadlineExceededError) throw error;
      if (deadline !== null) remainingDeadlineMilliseconds(now, deadline);
      const retryable =
        error instanceof RetryableGraphqlError ||
        error?.name === 'AbortError' ||
        error?.name === 'TimeoutError' ||
        error instanceof TypeError;
      if (!retryable || attempt === maximumAttempts) {
        if (retryable) {
          throw new GraphqlTransportUnavailableError(
            error instanceof RetryableGraphqlError
              ? error.message
              : 'Railway GraphQL request failed before a usable response',
            { cause: error },
          );
        }
        throw error;
      }
      const exponentialBackoffMilliseconds = Math.min(1_000 * 2 ** (attempt - 1), 5_000);
      const requestedBackoffMilliseconds = Math.max(
        exponentialBackoffMilliseconds,
        error.retryAfterMilliseconds ?? 0,
      );
      const boundedBackoffMilliseconds =
        deadline === null
          ? requestedBackoffMilliseconds
          : Math.min(requestedBackoffMilliseconds, remainingDeadlineMilliseconds(now, deadline));
      await sleep(boundedBackoffMilliseconds);
      if (deadline !== null) remainingDeadlineMilliseconds(now, deadline);
    } finally {
      clearTimeout(timeout);
    }
  }
  fail('Railway GraphQL exhausted its bounded retries');
}

export async function discoverRailwayDeploymentRegistration(
  deploymentId,
  config,
  dependencies = {},
) {
  if (!UUID.test(deploymentId ?? '')) fail('deploymentId must be a UUID');
  const graphql = dependencies.graphql ?? railwayDeploymentGraphql;
  const seenDeploymentIds = new Set();
  const seenCursors = new Set();
  let after = null;

  for (let page = 0; page < MAX_DEPLOYMENT_REGISTRATION_PAGES; page += 1) {
    const data = await graphql(
      config,
      RAILWAY_DEPLOYMENT_REGISTRATION_QUERY,
      {
        input: {
          projectId: config.projectId,
          environmentId: config.environmentId,
          serviceId: config.serviceId,
          includeDeleted: true,
        },
        first: DEPLOYMENT_REGISTRATION_PAGE_SIZE,
        after,
      },
      dependencies,
    );
    const connection = data?.deployments;
    const edges = connection?.edges;
    const pageInfo = connection?.pageInfo;
    if (
      !plainObject(connection) ||
      !Array.isArray(edges) ||
      edges.length > DEPLOYMENT_REGISTRATION_PAGE_SIZE ||
      !plainObject(pageInfo) ||
      typeof pageInfo.hasNextPage !== 'boolean'
    ) {
      fail('Railway deployment registration page is invalid');
    }

    let found = false;
    for (const edge of edges) {
      const candidate = edge?.node;
      if (
        !plainObject(edge) ||
        !plainObject(candidate) ||
        !UUID.test(candidate.id ?? '') ||
        candidate.projectId !== config.projectId ||
        candidate.environmentId !== config.environmentId ||
        candidate.serviceId !== config.serviceId ||
        typeof candidate.status !== 'string' ||
        candidate.status.length < 1 ||
        candidate.status.length > 64
      ) {
        fail('Railway deployment registration identity is invalid or cross-scoped');
      }
      if (seenDeploymentIds.has(candidate.id)) {
        fail('Railway deployment registration pagination returned a duplicate deployment');
      }
      seenDeploymentIds.add(candidate.id);
      if (candidate.id === deploymentId) found = true;
    }
    if (found) return true;
    if (!pageInfo.hasNextPage) return false;
    if (
      typeof pageInfo.endCursor !== 'string' ||
      pageInfo.endCursor.length < 1 ||
      pageInfo.endCursor.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(pageInfo.endCursor) ||
      seenCursors.has(pageInfo.endCursor)
    ) {
      fail('Railway deployment registration cursor is invalid or repeated');
    }
    seenCursors.add(pageInfo.endCursor);
    after = pageInfo.endCursor;
  }
  fail('Railway deployment registration exceeded its bounded pagination limit');
}

export async function waitForRailwayDeployment(deploymentId, config, dependencies = {}) {
  if (!UUID.test(deploymentId ?? '')) fail('deploymentId must be a UUID');
  const graphql = dependencies.graphql ?? railwayDeploymentGraphql;
  const discoverDeployment =
    dependencies.discoverDeployment ?? discoverRailwayDeploymentRegistration;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = dependencies.attempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollMilliseconds = dependencies.pollMilliseconds ?? DEFAULT_POLL_MILLISECONDS;
  const waitTimeoutMilliseconds =
    dependencies.waitTimeoutMilliseconds ?? DEFAULT_WAIT_TIMEOUT_MILLISECONDS;
  const now = dependencies.now ?? (() => performance.now());
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > DEFAULT_POLL_ATTEMPTS) {
    fail('deployment poll attempt bound is invalid');
  }
  if (
    !Number.isSafeInteger(pollMilliseconds) ||
    pollMilliseconds < 1 ||
    pollMilliseconds > DEFAULT_POLL_MILLISECONDS
  ) {
    fail('deployment poll interval is invalid');
  }
  if (
    !Number.isSafeInteger(waitTimeoutMilliseconds) ||
    waitTimeoutMilliseconds < 1 ||
    waitTimeoutMilliseconds > DEFAULT_WAIT_TIMEOUT_MILLISECONDS
  ) {
    fail('deployment wait timeout is invalid');
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt)) fail('monotonic clock returned an invalid value');
  const deadline = startedAt + waitTimeoutMilliseconds;
  const registrationDeadline =
    startedAt + Math.min(waitTimeoutMilliseconds, MAX_REGISTRATION_WAIT_MILLISECONDS);
  let deploymentObserved = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!deploymentObserved) {
      const registrationRemaining = registrationDeadline - now();
      if (!Number.isFinite(registrationRemaining)) {
        fail('monotonic clock returned an invalid value');
      }
      if (registrationRemaining <= 0) {
        fail('Railway deployment was not registered within the bounded discovery window');
      }
    }
    if (!deploymentObserved) {
      try {
        const discovered = await discoverDeployment(deploymentId, config, {
          ...dependencies,
          graphql,
          deadline: registrationDeadline,
          now,
        });
        if (typeof discovered !== 'boolean') {
          fail('Railway deployment discovery returned an invalid result');
        }
        deploymentObserved = discovered;
      } catch (error) {
        if (error instanceof DeploymentWaitDeadlineExceededError) {
          fail('Railway deployment was not registered within the bounded discovery window');
        }
        if (!(error instanceof GraphqlTransportUnavailableError) || attempt === attempts) {
          throw error;
        }
      }
      if (!deploymentObserved) {
        if (attempt === attempts) {
          fail('Railway deployment was not registered within the bounded discovery window');
        }
        const registrationRemaining = registrationDeadline - now();
        if (!Number.isFinite(registrationRemaining)) {
          fail('monotonic clock returned an invalid value');
        }
        if (registrationRemaining <= 0) {
          fail('Railway deployment was not registered within the bounded discovery window');
        }
        await sleep(
          Math.min(
            pollMilliseconds,
            registrationRemaining,
            remainingDeadlineMilliseconds(now, deadline),
          ),
        );
        continue;
      }
    }

    let data;
    try {
      data = await graphql(
        config,
        RAILWAY_DEPLOYMENT_QUERY,
        { id: deploymentId },
        {
          ...dependencies,
          deadline,
          now,
        },
      );
    } catch (error) {
      if (!(error instanceof GraphqlTransportUnavailableError) || attempt === attempts) {
        throw error;
      }
      await sleep(Math.min(pollMilliseconds, remainingDeadlineMilliseconds(now, deadline)));
      continue;
    }
    const deployment = plainObject(data?.deployment) ? data.deployment : null;
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
    if (TERMINAL_DEPLOYMENT_FAILURES.has(deployment.status)) {
      fail(`Railway deployment reached terminal status ${deployment.status}`);
    }
    if (!TRANSIENT_DEPLOYMENT_STATES.has(deployment.status)) {
      fail('Railway deployment returned an unknown status');
    }
    if (attempt < attempts) {
      await sleep(Math.min(pollMilliseconds, remainingDeadlineMilliseconds(now, deadline)));
      remainingDeadlineMilliseconds(now, deadline);
    }
  }
  fail('Railway deployment did not reach SUCCESS within the bounded window');
}

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'deployment-id') {
    process.stdout.write(`${parseRailwayUpDeploymentId(await readStdin())}\n`);
    return;
  }
  if (command === 'validate-recovery-route') {
    const route = parseRailwayReleaseRecoveryRoute();
    process.stdout.write(
      `railway-release-deployment:ok:route:${route.recovery ? 'recovery' : 'normal'}\n`,
    );
    return;
  }
  const config = parseRailwayReleaseDeploymentEnvironment();
  if (command === 'target-identity' || command === 'target-identity-recovery') {
    const identity = parseRailwayTargetIdentity(
      await readStdin(),
      {
        ...config,
        serviceName: required(process.env, 'RAILWAY_SERVICE', { maximum: 128 }),
      },
      { allowStableTerminalLatest: command === 'target-identity-recovery' },
    );
    process.stdout.write(
      `railway-release-deployment:ok:target:${identity.projectId}:${identity.environmentId}:${identity.serviceId}\n`,
    );
    return;
  }
  if (command === 'wait-deployment') {
    const result = await waitForRailwayDeployment(argument, config);
    process.stdout.write(`railway-release-deployment:ok:${result.status}:${result.deploymentId}\n`);
    return;
  }
  if (command === 'serving-deployment-id') {
    process.stdout.write(`${parseRailwayServingDeploymentId(await readStdin(), config)}\n`);
    return;
  }
  fail(
    'command must be deployment-id, validate-recovery-route, target-identity, target-identity-recovery, wait-deployment or serving-deployment-id',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'railway-release-deployment:unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
