#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseAgentMissionFingerprintKeyOperation } from './manage-agent-mission-fingerprint-key-versions.mjs';

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const VERSION = /^[1-9][0-9]{0,9}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/u;
const MAX_RESPONSE_BYTES = 1_048_576;
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

export const M1B_RAILWAY_RUNTIME_VARIABLES = Object.freeze([
  'BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED',
  'BOB_AGENT_MISSION_HMAC_KEY_VERSION',
  'BOB_AGENT_MISSION_HMAC_KEYRING',
]);
export const M1B_RAILWAY_CERTIFICATION_OWNER =
  'BOB_M1B_STAGING_CERTIFICATION_OWNER';
export const M1B_RAILWAY_VARIABLES = Object.freeze([
  ...M1B_RAILWAY_RUNTIME_VARIABLES,
  M1B_RAILWAY_CERTIFICATION_OWNER,
]);

const RAILWAY_STATE_QUERY = `
query AgentMissionM1BState(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
) {
  variables(
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
    unrendered: true
  )
  environment(id: $environmentId, projectId: $projectId) {
    id
    name
    variables(first: 500) {
      edges {
        node {
          name
          serviceId
          isSealed
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
  environmentStagedChanges(environmentId: $environmentId) {
    status
    patch
  }
}
`;

const RAILWAY_VARIABLE_COLLECTION_UPSERT = `
mutation AgentMissionM1BVariables($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}
`;

const RAILWAY_DEPLOYMENT_QUERY = `
query AgentMissionM1BDeployment($id: String!) {
  deployment(id: $id) {
    id
    projectId
    environmentId
    serviceId
    status
  }
}
`;

function plainObject(value) {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-railway:${message}`);
}

function required(environment, name, { minimum = 1, maximum = 16_384 } = {}) {
  const value = environment[name];
  if (
    typeof value !== 'string'
    || value.length < minimum
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
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

function exactSecretEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function recursivelyEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!plainObject(value)) return false;
  return Object.values(value).every(recursivelyEmpty);
}

export function parseRailwayM1BEnvironment(environment = process.env) {
  const config = {
    token: required(environment, 'RAILWAY_TOKEN', { minimum: 16, maximum: 4_096 }),
    projectId: uuid(environment, 'RAILWAY_PROJECT_ID'),
    environmentId: uuid(environment, 'RAILWAY_ENVIRONMENT_ID'),
    serviceId: uuid(environment, 'RAILWAY_API_SERVICE_ID'),
    keyVersion: required(environment, 'BOB_M1B_STAGING_HMAC_KEY_VERSION', {
      maximum: 10,
    }),
    keyring: required(environment, 'BOB_M1B_STAGING_HMAC_KEYRING', {
      minimum: 2,
      maximum: 16_384,
    }),
    runId: required(environment, 'BOB_M1B_STAGING_RUN_ID', {
      maximum: 31,
    }),
  };
  if (
    !VERSION.test(config.keyVersion)
    || !Number.isSafeInteger(Number(config.keyVersion))
    || Number(config.keyVersion) > 2_147_483_647
  ) {
    fail('BOB_M1B_STAGING_HMAC_KEY_VERSION must be a PostgreSQL positive integer');
  }
  if (!RUN_ID.test(config.runId)) {
    fail('BOB_M1B_STAGING_RUN_ID must be github.run_id:github.run_attempt');
  }
  return Object.freeze(config);
}

function decodeRailwayVariables(value) {
  if (!plainObject(value)) fail('Railway returned an invalid variable collection');
  const variables = {};
  for (const [name, variableValue] of Object.entries(value)) {
    if (!VARIABLE_NAME.test(name) || typeof variableValue !== 'string') {
      fail('Railway returned an unreadable variable collection');
    }
    if (Buffer.byteLength(variableValue, 'utf8') > 65_536) {
      fail('Railway returned an oversized variable value');
    }
    variables[name] = variableValue;
  }
  return variables;
}

export function decodeRailwayM1BState(payload, config) {
  if (!plainObject(payload)) fail('Railway returned an invalid state envelope');
  const variables = decodeRailwayVariables(payload.variables);
  const environment = plainObject(payload.environment) ? payload.environment : null;
  const connection = plainObject(environment?.variables) ? environment.variables : null;
  const edges = connection?.edges;
  const pageInfo = plainObject(connection?.pageInfo) ? connection.pageInfo : null;
  if (
    environment?.id !== config.environmentId
    || environment?.name !== 'staging'
    || !Array.isArray(edges)
    || typeof pageInfo?.hasNextPage !== 'boolean'
  ) {
    fail('Railway staging environment metadata is unavailable or ambiguous');
  }
  if (pageInfo.hasNextPage) fail('Railway variable metadata exceeded the bounded page');

  const serviceMetadata = [];
  const metadataNames = new Set();
  for (const edge of edges) {
    const node = plainObject(edge?.node) ? edge.node : null;
    if (
      node === null
      || typeof node.name !== 'string'
      || (node.serviceId !== null && typeof node.serviceId !== 'string')
      || typeof node.isSealed !== 'boolean'
    ) {
      fail('Railway returned invalid variable metadata');
    }
    if (node.serviceId !== config.serviceId) continue;
    if (!VARIABLE_NAME.test(node.name) || metadataNames.has(node.name)) {
      fail('Railway returned duplicate or invalid service variable metadata');
    }
    metadataNames.add(node.name);
    serviceMetadata.push({
      name: node.name,
      isSealed: node.isSealed,
    });
  }
  const variableNames = Object.keys(variables).sort();
  const serviceVariableNames = [...metadataNames].sort();
  if (
    variableNames.length !== serviceVariableNames.length
    || variableNames.some((name, index) => name !== serviceVariableNames[index])
  ) {
    fail('Railway service variable values and ownership metadata diverged');
  }

  const staged = plainObject(payload.environmentStagedChanges)
    ? payload.environmentStagedChanges
    : null;
  if (
    staged === null
    || !['APPLYING', 'COMMITTED', 'STAGED'].includes(staged.status)
  ) {
    fail('Railway staged-change state is unavailable');
  }

  return Object.freeze({
    variables: Object.freeze(variables),
    serviceMetadata: Object.freeze(serviceMetadata),
    hasPendingEnvironmentPatch: staged.status === 'STAGED' && !recursivelyEmpty(staged.patch),
  });
}

function assertRestorable(state) {
  if (state.serviceMetadata.some(({ isSealed }) => isSealed)) {
    fail('the Railway API service contains sealed variables and cannot be restored atomically');
  }
}

function assertNoM1BVariables(state) {
  if (M1B_RAILWAY_VARIABLES.some((name) => Object.hasOwn(state.variables, name))) {
    fail('the AgentMission variable block must be absent before activation');
  }
}

function assertBobLiveOpenAiPrerequisites(state, config) {
  const variables = state.variables;
  const speechDelivery = variables.BOB_LIVE_SPEECH_DELIVERY;
  if (
    variables.BOB_LIVE_ENABLED !== 'true'
    || variables.BOB_LIVE_PROVIDER !== 'openai'
    || speechDelivery !== 'audited-signed-url-v1'
    || variables.BOB_LIVE_AUDIT_PROVIDER !== 'local-whisper'
    || variables.BOB_LIVE_LOCAL_AUDIT_BASE_URL
      !== 'http://bob-live-whisper-audit.railway.internal:8080/v1'
  ) {
    fail('staging Bob Live must use the certified OpenAI audited delivery before M1-B activation');
  }

  const requiredNames = [
    'OPENAI_API_KEY',
    'BOB_LIVE_USAGE_HMAC_SECRET',
    'BOB_LIVE_CONTROL_ENCRYPTION_SECRET',
    'BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS',
    'BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS',
    'BOB_LIVE_CAPACITY_CONFIG_VERSION',
    'BOB_LIVE_LOCAL_AUDIT_BASE_URL',
    'BOB_LIVE_LOCAL_AUDIT_TOKEN',
    'DATABASE_URL',
    'DIRECT_URL',
    'APP_DATABASE_ROLE',
  ];
  for (const name of requiredNames) {
    if (typeof variables[name] !== 'string' || variables[name].length < 1) {
      fail(`staging Bob Live prerequisite ${name} is missing`);
    }
  }
  if (
    !(variables.BOB_LIVE_SUBJECT_HMAC_KEYRING || variables.BOB_LIVE_SUBJECT_HMAC_SECRET)
    || !(variables.BOB_LIVE_PROOF_KEYRING || variables.BOB_LIVE_PROOF_SECRET)
  ) {
    fail('staging Bob Live subject/proof key material is incomplete');
  }
  parseAgentMissionFingerprintKeyOperation('stage', {
    ...variables,
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: config.keyVersion,
    BOB_AGENT_MISSION_HMAC_KEYRING: config.keyring,
  });
}

export function assertRailwayM1BPreflight(state, config) {
  assertRestorable(state);
  if (state.hasPendingEnvironmentPatch) {
    fail('Railway staging already contains unrelated staged changes');
  }
  assertNoM1BVariables(state);
  assertBobLiveOpenAiPrerequisites(state, config);
}

export function assertRailwayM1BActive(state, config) {
  assertRestorable(state);
  if (state.hasPendingEnvironmentPatch) {
    fail('Railway staging contains pending changes during M1-B activation');
  }
  const variables = state.variables;
  if (
    variables.BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED !== 'true'
    || variables.BOB_AGENT_MISSION_HMAC_KEY_VERSION !== config.keyVersion
    || !exactSecretEqual(variables.BOB_AGENT_MISSION_HMAC_KEYRING, config.keyring)
    || variables[M1B_RAILWAY_CERTIFICATION_OWNER] !== config.runId
  ) {
    fail('Railway did not apply the exact run-owned AgentMission variable block');
  }
}

export function assertRailwayM1BOff(state) {
  assertRestorable(state);
  if (state.hasPendingEnvironmentPatch) {
    fail('Railway staging contains pending changes while M1-B must be OFF');
  }
  assertNoM1BVariables(state);
}

function exactVariables(left, right) {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return (
    leftNames.length === rightNames.length
    && leftNames.every((name, index) => (
      name === rightNames[index]
      && exactSecretEqual(left[name], right[name])
    ))
  );
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

async function railwayGraphql(config, query, variables, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => (
    new Promise((resolve) => setTimeout(resolve, milliseconds))
  ));
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
        body: JSON.stringify({ query, variables }),
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
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        fail('Railway GraphQL returned invalid JSON');
      }
      if (
        !plainObject(payload)
        || !plainObject(payload.data)
        || (Object.hasOwn(payload, 'errors') && payload.errors !== undefined)
      ) {
        fail('Railway GraphQL rejected the operation');
      }
      return payload.data;
    } catch (error) {
      if (
        attempt < 3
        && (error?.name === 'AbortError' || error instanceof TypeError)
      ) {
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

async function readState(config, dependencies) {
  const graphql = dependencies.graphql ?? railwayGraphql;
  const data = await graphql(
    config,
    RAILWAY_STATE_QUERY,
    {
      projectId: config.projectId,
      environmentId: config.environmentId,
      serviceId: config.serviceId,
    },
    dependencies,
  );
  return decodeRailwayM1BState(data, config);
}

async function replaceVariables(config, variables, replace, dependencies) {
  const graphql = dependencies.graphql ?? railwayGraphql;
  const data = await graphql(
    config,
    RAILWAY_VARIABLE_COLLECTION_UPSERT,
    {
      input: {
        projectId: config.projectId,
        environmentId: config.environmentId,
        serviceId: config.serviceId,
        variables,
        replace,
        skipDeploys: true,
      },
    },
    dependencies,
  );
  if (data.variableCollectionUpsert !== true) {
    fail('Railway did not acknowledge the variable mutation');
  }
}

export async function runRailwayM1BCommand(
  command,
  environment = process.env,
  dependencies = {},
) {
  const config = parseRailwayM1BEnvironment(environment);
  if (command === 'preflight') {
    const state = await readState(config, dependencies);
    assertRailwayM1BPreflight(state, config);
    return { command, state: 'off' };
  }
  if (command === 'activate') {
    const before = await readState(config, dependencies);
    assertRailwayM1BPreflight(before, config);
    const confirmed = await readState(config, dependencies);
    assertRailwayM1BPreflight(confirmed, config);
    if (!exactVariables(before.variables, confirmed.variables)) {
      fail('Railway variables changed concurrently before M1-B activation');
    }
    await replaceVariables(
      config,
      {
        BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
        BOB_AGENT_MISSION_HMAC_KEY_VERSION: config.keyVersion,
        BOB_AGENT_MISSION_HMAC_KEYRING: config.keyring,
        [M1B_RAILWAY_CERTIFICATION_OWNER]: config.runId,
      },
      false,
      dependencies,
    );
    const after = await readState(config, dependencies);
    assertRailwayM1BActive(after, config);
    return { command, state: 'active', changed: true };
  }
  if (command === 'deactivate') {
    const before = await readState(config, dependencies);
    assertRestorable(before);
    if (before.hasPendingEnvironmentPatch) {
      fail('Railway staging contains unrelated pending changes before M1-B cleanup');
    }
    const m1bNames = M1B_RAILWAY_VARIABLES.filter((name) =>
      Object.hasOwn(before.variables, name));
    if (m1bNames.length === 0) {
      assertRailwayM1BOff(before);
      return { command, state: 'off', changed: false };
    }
    // Cleanup authority comes from the exact marker persisted atomically with
    // the M1-B variables. A complete-looking block owned by another run is
    // never removed.
    assertRailwayM1BActive(before, config);
    const restoredVariables = Object.fromEntries(
      Object.entries(before.variables).filter(([name]) => !M1B_RAILWAY_VARIABLES.includes(name)),
    );
    const confirmed = await readState(config, dependencies);
    assertRailwayM1BActive(confirmed, config);
    if (!exactVariables(before.variables, confirmed.variables)) {
      fail('Railway variables changed concurrently before M1-B cleanup');
    }
    let mutationError = null;
    try {
      await replaceVariables(config, restoredVariables, true, dependencies);
    } catch (error) {
      // variableCollectionUpsert is an idempotent exact replacement here. A
      // committed mutation can lose every HTTP response, so the durable
      // Railway collection—not transport delivery—is the acknowledgement.
      mutationError = error;
    }
    const after = await readState(config, dependencies);
    assertRailwayM1BOff(after);
    if (!exactVariables(after.variables, restoredVariables)) {
      fail('Railway cleanup changed variables outside the M1-B block');
    }
    return {
      command,
      state: 'off',
      changed: true,
      acknowledgement: mutationError === null ? 'received' : 'recovered',
    };
  }
  if (command === 'assert-active') {
    const state = await readState(config, dependencies);
    assertRailwayM1BActive(state, config);
    return { command, state: 'active' };
  }
  if (command === 'assert-off') {
    const state = await readState(config, dependencies);
    assertRailwayM1BOff(state);
    return { command, state: 'off' };
  }
  fail('command must be preflight, activate, deactivate, assert-active or assert-off');
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

export async function waitForRailwayM1BDeployment(
  deploymentId,
  environment = process.env,
  dependencies = {},
) {
  if (!UUID.test(deploymentId ?? '')) fail('deploymentId must be a UUID');
  const config = parseRailwayM1BEnvironment(environment);
  const graphql = dependencies.graphql ?? railwayGraphql;
  const sleep = dependencies.sleep ?? ((milliseconds) => (
    new Promise((resolve) => setTimeout(resolve, milliseconds))
  ));
  const attempts = dependencies.attempts ?? 90;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const data = await graphql(
      config,
      RAILWAY_DEPLOYMENT_QUERY,
      { id: deploymentId },
      dependencies,
    );
    const deployment = plainObject(data.deployment) ? data.deployment : null;
    if (
      deployment?.id !== deploymentId
      || deployment.projectId !== config.projectId
      || deployment.environmentId !== config.environmentId
      || deployment.serviceId !== config.serviceId
      || typeof deployment.status !== 'string'
    ) {
      fail('Railway deployment identity is unavailable or mismatched');
    }
    if (deployment.status === 'SUCCESS') return { deploymentId, status: 'SUCCESS' };
    if (TERMINAL_DEPLOYMENT_FAILURES.has(deployment.status)) {
      fail(`Railway deployment reached terminal status ${deployment.status}`);
    }
    if (!TRANSIENT_DEPLOYMENT_STATES.has(deployment.status)) {
      fail('Railway deployment returned an unknown status');
    }
    if (attempt < attempts) await sleep(10_000);
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
  if (command === 'wait-deployment') {
    const result = await waitForRailwayM1BDeployment(argument);
    process.stdout.write(`agent-mission-m1b-staging-railway:ok:${result.status}\n`);
    return;
  }
  const result = await runRailwayM1BCommand(command);
  process.stdout.write(
    `agent-mission-m1b-staging-railway:ok:${result.command}:${result.state}`
      + `${result.changed === true ? ':changed' : result.changed === false ? ':unchanged' : ''}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error
        ? error.message
        : 'agent-mission-m1b-staging-railway:unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
