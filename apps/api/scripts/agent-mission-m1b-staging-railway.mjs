#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseAgentMissionFingerprintKeyOperation } from './manage-agent-mission-fingerprint-key-versions.mjs';

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const VERSION = /^[1-9][0-9]{0,9}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const PROFILE_CERTIFICATION = 'certification';
const PROFILE_M2A3_PREVIEW = 'm2a3-preview';
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
export const M1B_RAILWAY_CERTIFICATION_OWNER = 'BOB_M1B_STAGING_CERTIFICATION_OWNER';
export const M1B_RAILWAY_VARIABLES = Object.freeze([
  ...M1B_RAILWAY_RUNTIME_VARIABLES,
  M1B_RAILWAY_CERTIFICATION_OWNER,
]);
export const M2A3_RAILWAY_PREVIEW_OWNER = 'BOB_M2A3_STAGING_PREVIEW_OWNER';
export const M2A3_RAILWAY_PREVIEW_RELEASE_SHA = 'BOB_M2A3_STAGING_PREVIEW_RELEASE_SHA';
export const M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN = 'BOB_M2A3_STAGING_PREVIEW_ACTIVATION_RUN';
export const M2A3_RAILWAY_PREVIEW_OWNER_VALUE = 'bob-m2a3-staging-preview-v1';
export const M2A3_RAILWAY_VARIABLES = Object.freeze([
  'BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED',
  'BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED',
  'BOB_AGENT_MISSION_HMAC_KEY_VERSION',
  'BOB_AGENT_MISSION_HMAC_KEYRING',
  M2A3_RAILWAY_PREVIEW_OWNER,
  M2A3_RAILWAY_PREVIEW_RELEASE_SHA,
  M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN,
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
    deploymentStopped
    canRedeploy
    instances {
      id
      status
    }
  }
}
`;

const RAILWAY_DEPLOYMENT_REDEPLOY = `
mutation DeploymentRedeploy($id: String!) {
  deploymentRedeploy(id: $id) {
    id
  }
}
`;

const RAILWAY_SERVING_DEPLOYMENT_QUERY = `
query AgentMissionServingDeployment($projectId: String!, $environmentId: String!) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    name
    serviceInstances {
      edges {
        node {
          serviceId
          activeDeployments {
            id
            status
            deploymentStopped
            instances {
              id
              status
            }
          }
          latestDeployment {
            id
            status
            deploymentStopped
            canRedeploy
            instances {
              id
              status
            }
          }
        }
      }
    }
  }
}
`;

function plainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-railway:${message}`);
}

function required(environment, name, { minimum = 1, maximum = 16_384 } = {}) {
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
  const profile = environment.BOB_AGENT_MISSION_STAGING_PROFILE ?? PROFILE_CERTIFICATION;
  if (profile !== PROFILE_CERTIFICATION && profile !== PROFILE_M2A3_PREVIEW) {
    fail('BOB_AGENT_MISSION_STAGING_PROFILE must be certification or m2a3-preview');
  }
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
      maximum: 20,
    }),
    profile,
    releaseSha:
      profile === PROFILE_M2A3_PREVIEW
        ? required(environment, 'BOB_M2A3_STAGING_PREVIEW_RELEASE_SHA', { maximum: 40 })
        : null,
  };
  if (
    !VERSION.test(config.keyVersion) ||
    !Number.isSafeInteger(Number(config.keyVersion)) ||
    Number(config.keyVersion) > 2_147_483_647
  ) {
    fail('BOB_M1B_STAGING_HMAC_KEY_VERSION must be a PostgreSQL positive integer');
  }
  if (!RUN_ID.test(config.runId)) {
    fail('BOB_M1B_STAGING_RUN_ID must be the stable github.run_id');
  }
  if (config.releaseSha !== null && !SHA.test(config.releaseSha)) {
    fail('BOB_M2A3_STAGING_PREVIEW_RELEASE_SHA must be an exact SHA');
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
    environment?.id !== config.environmentId ||
    environment?.name !== 'staging' ||
    !Array.isArray(edges) ||
    typeof pageInfo?.hasNextPage !== 'boolean'
  ) {
    fail('Railway staging environment metadata is unavailable or ambiguous');
  }
  if (pageInfo.hasNextPage) fail('Railway variable metadata exceeded the bounded page');

  const serviceMetadata = [];
  const metadataNames = new Set();
  for (const edge of edges) {
    const node = plainObject(edge?.node) ? edge.node : null;
    if (
      node === null ||
      typeof node.name !== 'string' ||
      (node.serviceId !== null && typeof node.serviceId !== 'string') ||
      typeof node.isSealed !== 'boolean'
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
    variableNames.length !== serviceVariableNames.length ||
    variableNames.some((name, index) => name !== serviceVariableNames[index])
  ) {
    fail('Railway service variable values and ownership metadata diverged');
  }

  const staged = plainObject(payload.environmentStagedChanges)
    ? payload.environmentStagedChanges
    : null;
  if (staged === null || !['APPLYING', 'COMMITTED', 'STAGED'].includes(staged.status)) {
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

function assertM2A3PreviewOff(state) {
  const variables = state.variables;
  if (variables.BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED !== 'false') {
    fail('the staging M2-A runtime master must be explicitly false before preview activation');
  }
  for (const name of M2A3_RAILWAY_VARIABLES) {
    if (name === 'BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED') continue;
    if (Object.hasOwn(variables, name)) {
      fail('the persistent M2-A preview variable block must be absent while OFF');
    }
  }
  if (Object.hasOwn(variables, M1B_RAILWAY_CERTIFICATION_OWNER)) {
    fail('the bounded M1-B certification owner must be absent before preview activation');
  }
}

function assertProfileOff(state, config) {
  if (config.profile === PROFILE_M2A3_PREVIEW) {
    assertM2A3PreviewOff(state);
    return;
  }
  assertNoM1BVariables(state);
  if (
    state.variables.BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED !== undefined &&
    state.variables.BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED !== 'false'
  ) {
    fail('M1-B certification cannot overlap an active M2-A preview');
  }
  for (const name of [
    M2A3_RAILWAY_PREVIEW_OWNER,
    M2A3_RAILWAY_PREVIEW_RELEASE_SHA,
    M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN,
  ]) {
    if (Object.hasOwn(state.variables, name)) {
      fail('M1-B certification cannot overlap a persistent M2-A preview owner');
    }
  }
}

function assertBobLiveOpenAiPrerequisites(state, config) {
  const variables = state.variables;
  const speechDelivery = variables.BOB_LIVE_SPEECH_DELIVERY;
  if (
    variables.BOB_LIVE_ENABLED !== 'true' ||
    variables.BOB_LIVE_PROVIDER !== 'openai' ||
    speechDelivery !== 'audited-signed-url-v1' ||
    variables.BOB_LIVE_AUDIT_PROVIDER !== 'local-whisper' ||
    variables.BOB_LIVE_LOCAL_AUDIT_BASE_URL !==
      'http://bob-live-whisper-audit.railway.internal:8080/v1'
  ) {
    fail('staging Bob Live must use the certified OpenAI audited delivery before M1-B activation');
  }
  if (
    Object.hasOwn(variables, 'OPENAI_MODEL') ||
    (Object.hasOwn(variables, 'OPENAI_REALTIME_MODEL') &&
      variables.OPENAI_REALTIME_MODEL !== 'gpt-realtime-2.1') ||
    (Object.hasOwn(variables, 'OPENAI_REALTIME_BASE_URL') &&
      variables.OPENAI_REALTIME_BASE_URL !== 'https://api.openai.com/v1')
  ) {
    fail(
      'staging Bob Live must use gpt-realtime-2.1 on the official OpenAI endpoint without a legacy OPENAI_MODEL override',
    );
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
    !(variables.BOB_LIVE_SUBJECT_HMAC_KEYRING || variables.BOB_LIVE_SUBJECT_HMAC_SECRET) ||
    !(variables.BOB_LIVE_PROOF_KEYRING || variables.BOB_LIVE_PROOF_SECRET)
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
  assertProfileOff(state, config);
  assertBobLiveOpenAiPrerequisites(state, config);
}

export function assertRailwayM1BActive(
  state,
  config,
  {
    allowAnyPreviewRelease = false,
    requireCurrentRun = false,
    requireCertifiedBobLive = true,
  } = {},
) {
  assertRestorable(state);
  if (state.hasPendingEnvironmentPatch) {
    fail('Railway staging contains pending changes during M1-B activation');
  }
  if (requireCertifiedBobLive) assertBobLiveOpenAiPrerequisites(state, config);
  const variables = state.variables;
  if (config.profile === PROFILE_M2A3_PREVIEW) {
    if (
      variables.BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED !== 'true' ||
      variables.BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED !== 'true' ||
      variables.BOB_AGENT_MISSION_HMAC_KEY_VERSION !== config.keyVersion ||
      !exactSecretEqual(variables.BOB_AGENT_MISSION_HMAC_KEYRING, config.keyring) ||
      variables[M2A3_RAILWAY_PREVIEW_OWNER] !== M2A3_RAILWAY_PREVIEW_OWNER_VALUE ||
      (!allowAnyPreviewRelease &&
        variables[M2A3_RAILWAY_PREVIEW_RELEASE_SHA] !== config.releaseSha) ||
      (allowAnyPreviewRelease && !SHA.test(variables[M2A3_RAILWAY_PREVIEW_RELEASE_SHA] ?? '')) ||
      !RUN_ID.test(variables[M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN] ?? '') ||
      (requireCurrentRun && variables[M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN] !== config.runId) ||
      Object.hasOwn(variables, M1B_RAILWAY_CERTIFICATION_OWNER)
    ) {
      fail('Railway did not apply the exact persistent M2-A preview variable block');
    }
    return;
  }
  if (
    variables.BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED !== 'true' ||
    variables.BOB_AGENT_MISSION_HMAC_KEY_VERSION !== config.keyVersion ||
    !exactSecretEqual(variables.BOB_AGENT_MISSION_HMAC_KEYRING, config.keyring) ||
    variables[M1B_RAILWAY_CERTIFICATION_OWNER] !== config.runId
  ) {
    fail('Railway did not apply the exact run-owned AgentMission variable block');
  }
}

export function assertRailwayM1BOff(state, config = { profile: PROFILE_CERTIFICATION }) {
  assertRestorable(state);
  if (state.hasPendingEnvironmentPatch) {
    fail('Railway staging contains pending changes while M1-B must be OFF');
  }
  assertProfileOff(state, config);
}

function activationVariables(config) {
  if (config.profile === PROFILE_M2A3_PREVIEW) {
    return {
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'true',
      BOB_AGENT_MISSION_HMAC_KEY_VERSION: config.keyVersion,
      BOB_AGENT_MISSION_HMAC_KEYRING: config.keyring,
      [M2A3_RAILWAY_PREVIEW_OWNER]: M2A3_RAILWAY_PREVIEW_OWNER_VALUE,
      [M2A3_RAILWAY_PREVIEW_RELEASE_SHA]: config.releaseSha,
      [M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN]: config.runId,
    };
  }
  return {
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: config.keyVersion,
    BOB_AGENT_MISSION_HMAC_KEYRING: config.keyring,
    [M1B_RAILWAY_CERTIFICATION_OWNER]: config.runId,
  };
}

function restoredVariables(state, config) {
  const names =
    config.profile === PROFILE_M2A3_PREVIEW ? M2A3_RAILWAY_VARIABLES : M1B_RAILWAY_VARIABLES;
  const restored = Object.fromEntries(
    Object.entries(state.variables).filter(([name]) => !names.includes(name)),
  );
  if (config.profile === PROFILE_M2A3_PREVIEW) {
    restored.BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED = 'false';
  }
  return restored;
}

function exactVariables(left, right) {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every(
      (name, index) => name === rightNames[index] && exactSecretEqual(left[name], right[name]),
    )
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
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (typeof fetchImpl !== 'function') fail('fetch is unavailable');

  const maximumAttempts = dependencies.graphqlAttempts ?? 3;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3) {
    fail('Railway GraphQL attempt bound is invalid');
  }
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
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
        if (
          [408, 425, 429, 500, 502, 503, 504].includes(response.status) &&
          attempt < maximumAttempts
        ) {
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
        !plainObject(payload) ||
        !plainObject(payload.data) ||
        (Object.hasOwn(payload, 'errors') && payload.errors !== undefined)
      ) {
        fail('Railway GraphQL rejected the operation');
      }
      return payload.data;
    } catch (error) {
      if (
        attempt < maximumAttempts &&
        (error?.name === 'AbortError' || error instanceof TypeError)
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

export async function runRailwayM1BCommand(command, environment = process.env, dependencies = {}) {
  const config = parseRailwayM1BEnvironment(environment);
  if (command === 'preflight') {
    const state = await readState(config, dependencies);
    assertRailwayM1BPreflight(state, config);
    return { command, state: 'off' };
  }
  if (command === 'activate') {
    const before = await readState(config, dependencies);
    if (config.profile === PROFILE_M2A3_PREVIEW) {
      try {
        assertRailwayM1BActive(before, config, {
          allowAnyPreviewRelease: false,
          requireCurrentRun: true,
        });
        return { command, state: 'active', changed: false };
      } catch {
        assertRailwayM1BPreflight(before, config);
      }
    } else {
      assertRailwayM1BPreflight(before, config);
    }
    const confirmed = await readState(config, dependencies);
    assertRailwayM1BPreflight(confirmed, config);
    if (!exactVariables(before.variables, confirmed.variables)) {
      fail('Railway variables changed concurrently before M1-B activation');
    }
    const block = activationVariables(config);
    let mutationError = null;
    try {
      await replaceVariables(config, block, false, dependencies);
    } catch (error) {
      mutationError = error;
    }
    const after = await readState(config, dependencies);
    try {
      assertRailwayM1BActive(after, config, {
        requireCurrentRun: config.profile === PROFILE_M2A3_PREVIEW,
      });
      if (!exactVariables(after.variables, { ...before.variables, ...block })) {
        fail('Railway activation changed variables outside the owned AgentMission block');
      }
    } catch (verificationError) {
      if (mutationError !== null) throw mutationError;
      throw verificationError;
    }
    return {
      command,
      state: 'active',
      changed: true,
      acknowledgement: mutationError === null ? 'received' : 'recovered',
    };
  }
  if (command === 'deactivate') {
    const before = await readState(config, dependencies);
    assertRestorable(before);
    if (before.hasPendingEnvironmentPatch) {
      fail('Railway staging contains unrelated pending changes before M1-B cleanup');
    }
    const profileNames = (
      config.profile === PROFILE_M2A3_PREVIEW
        ? M2A3_RAILWAY_VARIABLES.filter((name) => name !== 'BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED')
        : M1B_RAILWAY_VARIABLES
    ).filter((name) => Object.hasOwn(before.variables, name));
    if (profileNames.length === 0) {
      assertRailwayM1BOff(before, config);
      return { command, state: 'off', changed: false };
    }
    // Cleanup authority comes from the exact marker persisted atomically with
    // the M1-B variables. A complete-looking block owned by another run is
    // never removed.
    assertRailwayM1BActive(before, config, {
      allowAnyPreviewRelease: config.profile === PROFILE_M2A3_PREVIEW,
      requireCertifiedBobLive: config.profile !== PROFILE_M2A3_PREVIEW,
    });
    const restored = restoredVariables(before, config);
    const confirmed = await readState(config, dependencies);
    assertRailwayM1BActive(confirmed, config, {
      allowAnyPreviewRelease: config.profile === PROFILE_M2A3_PREVIEW,
      requireCertifiedBobLive: config.profile !== PROFILE_M2A3_PREVIEW,
    });
    if (!exactVariables(before.variables, confirmed.variables)) {
      fail('Railway variables changed concurrently before M1-B cleanup');
    }
    let mutationError = null;
    try {
      await replaceVariables(config, restored, true, dependencies);
    } catch (error) {
      // variableCollectionUpsert is an idempotent exact replacement here. A
      // committed mutation can lose every HTTP response, so the durable
      // Railway collection—not transport delivery—is the acknowledgement.
      mutationError = error;
    }
    const after = await readState(config, dependencies);
    assertRailwayM1BOff(after, config);
    if (!exactVariables(after.variables, restored)) {
      fail('Railway cleanup changed variables outside the M1-B block');
    }
    return {
      command,
      state: 'off',
      changed: true,
      acknowledgement: mutationError === null ? 'received' : 'recovered',
    };
  }
  if (command === 'inspect-owned-preview') {
    if (config.profile !== PROFILE_M2A3_PREVIEW) {
      fail('inspect-owned-preview is reserved to the persistent M2-A preview');
    }
    const state = await readState(config, dependencies);
    assertRailwayM1BActive(state, config, {
      allowAnyPreviewRelease: true,
      requireCertifiedBobLive: false,
    });
    return {
      command,
      state: 'active',
      releaseSha: state.variables[M2A3_RAILWAY_PREVIEW_RELEASE_SHA],
      activationRunId: state.variables[M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN],
    };
  }
  if (command === 'assert-active') {
    const state = await readState(config, dependencies);
    assertRailwayM1BActive(state, config, {
      requireCurrentRun: config.profile === PROFILE_M2A3_PREVIEW,
    });
    return {
      command,
      state: 'active',
      activationRunId:
        config.profile === PROFILE_M2A3_PREVIEW
          ? state.variables[M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN]
          : null,
    };
  }
  if (command === 'assert-off') {
    const state = await readState(config, dependencies);
    assertRailwayM1BOff(state, config);
    return { command, state: 'off' };
  }
  fail(
    'command must be preflight, activate, deactivate, inspect-owned-preview, assert-active or assert-off',
  );
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

export function parseRailwayServingDeploymentId(value, config) {
  let project;
  try {
    project = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail('railway status returned invalid JSON');
  }
  const environments = project?.environments?.edges;
  if (!Array.isArray(environments)) fail('railway status omitted environments');
  const matchingEnvironments = environments
    .map((edge) => edge?.node)
    .filter((environment) => environment?.id === config.environmentId);
  if (matchingEnvironments.length !== 1 || matchingEnvironments[0]?.name !== 'staging') {
    fail('railway status did not select exactly one staging environment');
  }
  const instances = matchingEnvironments[0]?.serviceInstances?.edges;
  if (!Array.isArray(instances)) fail('railway status omitted service instances');
  const matchingServices = instances
    .map((edge) => edge?.node)
    .filter((instance) => instance?.serviceId === config.serviceId);
  if (matchingServices.length !== 1) {
    fail('railway status did not select exactly one API service instance');
  }
  const service = matchingServices[0];
  const active = service.activeDeployments;
  const latest = service.latestDeployment;
  if (
    !Array.isArray(active) ||
    active.length !== 1 ||
    !plainObject(active[0]) ||
    !plainObject(latest) ||
    !UUID.test(active[0].id ?? '') ||
    active[0].id !== latest.id ||
    active[0].status !== 'SUCCESS' ||
    active[0].deploymentStopped !== false ||
    latest.canRedeploy !== true ||
    latest.status !== 'SUCCESS' ||
    latest.deploymentStopped !== false ||
    !Array.isArray(active[0].instances) ||
    active[0].instances.length !== 1 ||
    active[0].instances[0]?.status !== 'RUNNING'
  ) {
    fail('railway status did not prove one exact redeployable serving deployment');
  }
  return active[0].id;
}

function parseRailwayServingDeploymentQuery(value, config) {
  const environment = value?.environment;
  return parseRailwayServingDeploymentId(
    {
      environments: {
        edges: [{ node: environment }],
      },
    },
    config,
  );
}

export async function redeployExactRailwayM1BDeployment(
  sourceDeploymentId,
  environment = process.env,
  dependencies = {},
) {
  if (!UUID.test(sourceDeploymentId ?? '')) fail('source deploymentId must be a UUID');
  const config = parseRailwayM1BEnvironment(environment);
  const graphql = dependencies.graphql ?? railwayGraphql;
  const sourceData = await graphql(
    config,
    RAILWAY_DEPLOYMENT_QUERY,
    { id: sourceDeploymentId },
    dependencies,
  );
  const source = plainObject(sourceData.deployment) ? sourceData.deployment : null;
  if (
    source?.id !== sourceDeploymentId ||
    source.projectId !== config.projectId ||
    source.environmentId !== config.environmentId ||
    source.serviceId !== config.serviceId ||
    source.status !== 'SUCCESS' ||
    source.deploymentStopped !== false ||
    !Array.isArray(source.instances) ||
    source.instances.length !== 1 ||
    source.instances[0]?.status !== 'RUNNING'
  ) {
    fail('source deployment is not the exact serving staging deployment');
  }
  const currentData = await graphql(
    config,
    RAILWAY_SERVING_DEPLOYMENT_QUERY,
    { projectId: config.projectId, environmentId: config.environmentId },
    dependencies,
  );
  if (parseRailwayServingDeploymentQuery(currentData, config) !== sourceDeploymentId) {
    fail('the serving deployment changed before exact-source redeployment');
  }
  const redeployData = await graphql(
    config,
    RAILWAY_DEPLOYMENT_REDEPLOY,
    { id: sourceDeploymentId },
    dependencies.graphql === undefined ? { ...dependencies, graphqlAttempts: 1 } : dependencies,
  );
  const deploymentId = redeployData?.deploymentRedeploy?.id;
  if (!UUID.test(deploymentId ?? '') || deploymentId === sourceDeploymentId) {
    fail('Railway did not create a distinct exact-source redeployment');
  }
  return { sourceDeploymentId, deploymentId };
}

export async function redeployCapturedRailwayM1BBaseline(
  sourceDeploymentId,
  environment = process.env,
  dependencies = {},
) {
  if (!UUID.test(sourceDeploymentId ?? '')) fail('source deploymentId must be a UUID');
  const config = parseRailwayM1BEnvironment(environment);
  const graphql = dependencies.graphql ?? railwayGraphql;
  const sourceData = await graphql(
    config,
    RAILWAY_DEPLOYMENT_QUERY,
    { id: sourceDeploymentId },
    dependencies,
  );
  const source = plainObject(sourceData.deployment) ? sourceData.deployment : null;
  if (
    source?.id !== sourceDeploymentId ||
    source.projectId !== config.projectId ||
    source.environmentId !== config.environmentId ||
    source.serviceId !== config.serviceId ||
    source.status !== 'SUCCESS' ||
    source.canRedeploy !== true
  ) {
    fail('captured baseline is not an exact redeployable successful staging deployment');
  }
  const redeployData = await graphql(
    config,
    RAILWAY_DEPLOYMENT_REDEPLOY,
    { id: sourceDeploymentId },
    dependencies.graphql === undefined ? { ...dependencies, graphqlAttempts: 1 } : dependencies,
  );
  const deploymentId = redeployData?.deploymentRedeploy?.id;
  if (!UUID.test(deploymentId ?? '') || deploymentId === sourceDeploymentId) {
    fail('Railway did not create a distinct captured-baseline redeployment');
  }
  return { sourceDeploymentId, deploymentId };
}

export async function waitForRailwayM1BDeployment(
  deploymentId,
  environment = process.env,
  dependencies = {},
) {
  if (!UUID.test(deploymentId ?? '')) fail('deploymentId must be a UUID');
  const config = parseRailwayM1BEnvironment(environment);
  const graphql = dependencies.graphql ?? railwayGraphql;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
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
      deployment?.id !== deploymentId ||
      deployment.projectId !== config.projectId ||
      deployment.environmentId !== config.environmentId ||
      deployment.serviceId !== config.serviceId ||
      typeof deployment.status !== 'string'
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
  if (command === 'serving-deployment-id') {
    const config = parseRailwayM1BEnvironment();
    process.stdout.write(`${parseRailwayServingDeploymentId(await readStdin(), config)}\n`);
    return;
  }
  if (command === 'redeploy-exact') {
    const result = await redeployExactRailwayM1BDeployment(argument);
    process.stdout.write(`${result.deploymentId}\n`);
    return;
  }
  if (command === 'redeploy-captured-baseline') {
    const result = await redeployCapturedRailwayM1BBaseline(argument);
    process.stdout.write(`${result.deploymentId}\n`);
    return;
  }
  if (command === 'wait-deployment') {
    const result = await waitForRailwayM1BDeployment(argument);
    process.stdout.write(`agent-mission-m1b-staging-railway:ok:${result.status}\n`);
    return;
  }
  const result = await runRailwayM1BCommand(command);
  process.stdout.write(
    `agent-mission-m1b-staging-railway:ok:${result.command}:${result.state}` +
      `${result.releaseSha ? `:sha-${result.releaseSha}` : ''}` +
      `${result.activationRunId ? `:run-${result.activationRunId}` : ''}` +
      `${result.changed === true ? ':changed' : result.changed === false ? ':unchanged' : ''}` +
      `${result.acknowledgement ? `:${result.acknowledgement}` : ''}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : 'agent-mission-m1b-staging-railway:unknown error'
      }\n`,
    );
    process.exitCode = 1;
  });
}
