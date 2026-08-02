#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseAgentMissionFingerprintKeyOperation } from './manage-agent-mission-fingerprint-key-versions.mjs';
import {
  M1B_RAILWAY_CERTIFICATION_OWNER,
  M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN,
  M2A3_RAILWAY_PREVIEW_OWNER,
  M2A3_RAILWAY_PREVIEW_OWNER_VALUE,
  M2A3_RAILWAY_PREVIEW_RELEASE_SHA,
} from './agent-mission-m1b-staging-railway.mjs';

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const VERSION = /^[1-9][0-9]{0,9}$/u;
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const TRACE_SUBJECT =
  /^([A-Za-z0-9-]{1,64}):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const MAX_RESPONSE_BYTES = 1_048_576;

export const REALTIME_VOICE_TRACE_V2_RUNTIME_VARIABLES = Object.freeze([
  'VOICE_TRACE_REALTIME_V2_ENABLED',
  'VOICE_TRACE_REALTIME_V2_SUBJECTS',
  'VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING',
  'VOICE_TRACE_REALTIME_V2_ENCRYPTION_CURRENT_VERSION',
]);
export const REALTIME_VOICE_TRACE_V2_OWNER = 'BOB_REALTIME_VOICE_TRACE_V2_STAGING_OWNER';
export const REALTIME_VOICE_TRACE_V2_RELEASE_SHA =
  'BOB_REALTIME_VOICE_TRACE_V2_STAGING_RELEASE_SHA';
export const REALTIME_VOICE_TRACE_V2_ACTIVATION_RUN =
  'BOB_REALTIME_VOICE_TRACE_V2_STAGING_ACTIVATION_RUN';
export const REALTIME_VOICE_TRACE_V2_OWNER_VALUE = 'bob-realtime-voice-trace-v2-staging-v1';
export const REALTIME_VOICE_TRACE_V2_OWNED_VARIABLES = Object.freeze([
  ...REALTIME_VOICE_TRACE_V2_RUNTIME_VARIABLES,
  REALTIME_VOICE_TRACE_V2_OWNER,
  REALTIME_VOICE_TRACE_V2_RELEASE_SHA,
  REALTIME_VOICE_TRACE_V2_ACTIVATION_RUN,
]);

const STATE_QUERY = `
query RealtimeVoiceTraceV2State(
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
      pageInfo { hasNextPage }
    }
  }
  environmentStagedChanges(environmentId: $environmentId) {
    status
    patch
  }
}
`;

const VARIABLE_COLLECTION_UPSERT = `
mutation RealtimeVoiceTraceV2Variables($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
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
  throw new Error(`realtime-voice-trace-v2-staging-railway:${message}`);
}

function required(environment, name, { minimum = 1, maximum = 16_384 } = {}) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim() ||
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

function exactStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactVariables(left, right) {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every(
      (name, index) => name === rightNames[index] && exactStringEqual(left[name], right[name]),
    )
  );
}

function recursivelyEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!plainObject(value)) return false;
  return Object.values(value).every(recursivelyEmpty);
}

function parseSubjects(raw) {
  const values = raw.split(',').map((value) => value.trim());
  if (
    values.length < 1 ||
    values.length > 64 ||
    values.some((value) => !TRACE_SUBJECT.test(value)) ||
    new Set(values).size !== values.length
  ) {
    fail('VOICE_TRACE_REALTIME_V2_SUBJECTS must contain unique canonical subjects');
  }
  return values.join(',');
}

function parseKeyring(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING must be canonical JSON');
  }
  if (!plainObject(parsed)) {
    fail('VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING must be a JSON object');
  }
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 8) {
    fail('VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING must contain 1 to 8 versions');
  }
  const secrets = new Set();
  const canonical = {};
  for (const [rawVersion, secret] of entries.sort(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    const version = Number(rawVersion);
    if (
      !VERSION.test(rawVersion) ||
      !Number.isSafeInteger(version) ||
      version > 2_147_483_647 ||
      typeof secret !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(secret) ||
      secrets.has(secret)
    ) {
      fail('VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING contains an invalid entry');
    }
    const decoded = Buffer.from(secret, 'base64url');
    if (decoded.byteLength !== 32 || decoded.toString('base64url') !== secret) {
      fail('VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING keys must be canonical 32-byte base64url');
    }
    canonical[rawVersion] = secret;
    secrets.add(secret);
  }
  return Object.freeze({
    value: JSON.stringify(canonical),
    versions: Object.freeze(Object.keys(canonical)),
  });
}

export function parseRealtimeVoiceTraceV2RailwayEnvironment(environment = process.env) {
  const keyring = parseKeyring(
    required(environment, 'BOB_REALTIME_VOICE_TRACE_V2_ENCRYPTION_KEYRING'),
  );
  const currentVersion = required(
    environment,
    'BOB_REALTIME_VOICE_TRACE_V2_ENCRYPTION_CURRENT_VERSION',
    { maximum: 10 },
  );
  if (!VERSION.test(currentVersion) || !keyring.versions.includes(currentVersion)) {
    fail('BOB_REALTIME_VOICE_TRACE_V2_ENCRYPTION_CURRENT_VERSION must exist in the keyring');
  }
  const releaseSha = required(environment, 'BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA', {
    maximum: 40,
  });
  const runId = required(environment, 'BOB_REALTIME_VOICE_TRACE_V2_RUN_ID', { maximum: 20 });
  const canaryCompanyId = required(environment, 'BOB_M1B_STAGING_COMPANY_ID', { maximum: 64 });
  const canaryUserId = required(environment, 'BOB_M1B_STAGING_USER_ID', {
    maximum: 80,
  }).toLowerCase();
  const canarySubject = `${canaryCompanyId}:${canaryUserId}`;
  if (!TRACE_SUBJECT.test(canarySubject)) {
    fail('the dedicated Voice Trace V2 canary identity is invalid');
  }
  if (!SHA.test(releaseSha)) fail('BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA must be an exact SHA');
  if (!RUN_ID.test(runId)) fail('BOB_REALTIME_VOICE_TRACE_V2_RUN_ID must be a GitHub run id');
  return Object.freeze({
    token: required(environment, 'RAILWAY_TOKEN', { minimum: 16, maximum: 4_096 }),
    projectId: uuid(environment, 'RAILWAY_PROJECT_ID'),
    environmentId: uuid(environment, 'RAILWAY_ENVIRONMENT_ID'),
    serviceId: uuid(environment, 'RAILWAY_API_SERVICE_ID'),
    subjects: parseSubjects(required(environment, 'BOB_REALTIME_VOICE_TRACE_V2_SUBJECTS')),
    keyring: keyring.value,
    currentVersion,
    canarySubject,
    releaseSha,
    runId,
  });
}

function decodeVariables(value) {
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

export function decodeRealtimeVoiceTraceV2RailwayState(payload, config) {
  if (!plainObject(payload)) fail('Railway returned an invalid state envelope');
  const variables = decodeVariables(payload.variables);
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
  const metadata = [];
  const names = new Set();
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
    if (!VARIABLE_NAME.test(node.name) || names.has(node.name)) {
      fail('Railway returned duplicate or invalid service variable metadata');
    }
    names.add(node.name);
    metadata.push(Object.freeze({ name: node.name, isSealed: node.isSealed }));
  }
  const valueNames = Object.keys(variables).sort();
  const metadataNames = [...names].sort();
  if (
    valueNames.length !== metadataNames.length ||
    valueNames.some((name, index) => name !== metadataNames[index])
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
    serviceMetadata: Object.freeze(metadata),
    hasPendingEnvironmentPatch: staged.status === 'STAGED' && !recursivelyEmpty(staged.patch),
  });
}

function assertRestorable(state) {
  if (state.serviceMetadata.some(({ isSealed }) => isSealed)) {
    fail('the Railway API service contains sealed variables and cannot be restored atomically');
  }
  if (state.hasPendingEnvironmentPatch) {
    fail('Railway staging contains unrelated pending changes');
  }
}

function assertPrerequisites(state, config) {
  const variables = state.variables;
  if (
    variables.CABINET_RELEASE_ENV !== 'staging' ||
    variables.BOB_LIVE_ENABLED !== 'true' ||
    variables.BOB_LIVE_PROVIDER !== 'openai' ||
    variables.BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED !== 'true' ||
    variables.BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED !== 'true' ||
    (variables.VOICE_TRACE_ENABLED !== undefined && variables.VOICE_TRACE_ENABLED !== 'false')
  ) {
    fail('staging GPT Realtime and AgentMission prerequisites are incomplete');
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
  if (
    requiredNames.some((name) => typeof variables[name] !== 'string' || variables[name].length < 1)
  ) {
    fail('staging GPT Realtime and AgentMission prerequisites are incomplete');
  }
  if (
    !(variables.BOB_LIVE_SUBJECT_HMAC_KEYRING || variables.BOB_LIVE_SUBJECT_HMAC_SECRET) ||
    !(variables.BOB_LIVE_PROOF_KEYRING || variables.BOB_LIVE_PROOF_SECRET)
  ) {
    fail('staging GPT Realtime and AgentMission prerequisites are incomplete');
  }
  try {
    parseAgentMissionFingerprintKeyOperation('stage', variables);
  } catch {
    fail('staging GPT Realtime AgentMission keyring is invalid or not dedicated');
  }
  if (
    variables[M2A3_RAILWAY_PREVIEW_OWNER] !== M2A3_RAILWAY_PREVIEW_OWNER_VALUE ||
    !exactStringEqual(variables[M2A3_RAILWAY_PREVIEW_RELEASE_SHA], config.releaseSha) ||
    !RUN_ID.test(variables[M2A3_RAILWAY_PREVIEW_ACTIVATION_RUN] ?? '') ||
    Object.hasOwn(variables, M1B_RAILWAY_CERTIFICATION_OWNER)
  ) {
    fail('staging persistent M2-A preview ownership is not canonical for the exact Trace SHA');
  }
  if (!config.subjects.split(',').includes(config.canarySubject)) {
    fail('the Voice Trace V2 allowlist omits the dedicated technical canary account');
  }
  if (
    Object.hasOwn(variables, 'OPENAI_MODEL') ||
    (variables.OPENAI_REALTIME_MODEL !== undefined &&
      variables.OPENAI_REALTIME_MODEL !== 'gpt-realtime-2.1') ||
    (variables.OPENAI_REALTIME_BASE_URL !== undefined &&
      variables.OPENAI_REALTIME_BASE_URL !== 'https://api.openai.com/v1')
  ) {
    fail('staging GPT Realtime provider identity drifted');
  }
}

function activeBlock(config) {
  return Object.freeze({
    VOICE_TRACE_REALTIME_V2_ENABLED: 'true',
    VOICE_TRACE_REALTIME_V2_SUBJECTS: config.subjects,
    VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING: config.keyring,
    VOICE_TRACE_REALTIME_V2_ENCRYPTION_CURRENT_VERSION: config.currentVersion,
    [REALTIME_VOICE_TRACE_V2_OWNER]: REALTIME_VOICE_TRACE_V2_OWNER_VALUE,
    [REALTIME_VOICE_TRACE_V2_RELEASE_SHA]: config.releaseSha,
    [REALTIME_VOICE_TRACE_V2_ACTIVATION_RUN]: config.runId,
  });
}

export function assertRealtimeVoiceTraceV2RailwayOff(state, config) {
  assertRestorable(state);
  for (const name of REALTIME_VOICE_TRACE_V2_OWNED_VARIABLES) {
    if (Object.hasOwn(state.variables, name)) {
      fail('the Realtime Voice Trace V2 variable block must be wholly absent while OFF');
    }
  }
  assertPrerequisites(state, config);
}

export function assertRealtimeVoiceTraceV2RailwayActive(
  state,
  config,
  { allowAnyRun = false } = {},
) {
  assertRestorable(state);
  assertPrerequisites(state, config);
  const expected = activeBlock(config);
  for (const [name, value] of Object.entries(expected)) {
    if (!exactStringEqual(state.variables[name], value)) {
      if (
        allowAnyRun &&
        name === REALTIME_VOICE_TRACE_V2_ACTIVATION_RUN &&
        RUN_ID.test(state.variables[name] ?? '')
      ) {
        continue;
      }
      fail('Railway did not apply the exact Realtime Voice Trace V2 block');
    }
  }
}

export function assertRealtimeVoiceTraceV2RailwayPreflight(state, config) {
  assertRealtimeVoiceTraceV2RailwayOff(state, config);
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
  const attempts = dependencies.graphqlAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) {
    fail('Railway GraphQL attempt bound is invalid');
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
      if (!response?.ok) {
        await response?.body?.cancel().catch(() => undefined);
        if ([408, 425, 429, 500, 502, 503, 504].includes(response?.status) && attempt < attempts) {
          await sleep(500 * attempt);
          continue;
        }
        fail(`Railway GraphQL returned HTTP ${response?.status ?? 'unknown'}`);
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
      if (attempt < attempts && (error?.name === 'AbortError' || error instanceof TypeError)) {
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
    STATE_QUERY,
    {
      projectId: config.projectId,
      environmentId: config.environmentId,
      serviceId: config.serviceId,
    },
    dependencies,
  );
  return decodeRealtimeVoiceTraceV2RailwayState(data, config);
}

async function replaceVariables(config, variables, replace, dependencies) {
  const graphql = dependencies.graphql ?? railwayGraphql;
  const data = await graphql(
    config,
    VARIABLE_COLLECTION_UPSERT,
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

function withoutOwnedVariables(variables) {
  return Object.fromEntries(
    Object.entries(variables).filter(
      ([name]) => !REALTIME_VOICE_TRACE_V2_OWNED_VARIABLES.includes(name),
    ),
  );
}

export async function runRealtimeVoiceTraceV2RailwayCommand(
  command,
  environment = process.env,
  dependencies = {},
) {
  const config = parseRealtimeVoiceTraceV2RailwayEnvironment(environment);
  if (command === 'preflight') {
    const state = await readState(config, dependencies);
    assertRealtimeVoiceTraceV2RailwayPreflight(state, config);
    return { command, state: 'off' };
  }
  if (command === 'assert-off') {
    const state = await readState(config, dependencies);
    assertRealtimeVoiceTraceV2RailwayOff(state, config);
    return { command, state: 'off' };
  }
  if (command === 'assert-active') {
    const state = await readState(config, dependencies);
    assertRealtimeVoiceTraceV2RailwayActive(state, config);
    return { command, state: 'active' };
  }
  if (command === 'activate') {
    const before = await readState(config, dependencies);
    try {
      assertRealtimeVoiceTraceV2RailwayActive(before, config);
      return { command, state: 'active', changed: false };
    } catch {
      assertRealtimeVoiceTraceV2RailwayPreflight(before, config);
    }
    const confirmed = await readState(config, dependencies);
    assertRealtimeVoiceTraceV2RailwayPreflight(confirmed, config);
    if (!exactVariables(before.variables, confirmed.variables)) {
      fail('Railway variables changed concurrently before activation');
    }
    const block = activeBlock(config);
    let mutationError = null;
    try {
      await replaceVariables(config, block, false, dependencies);
    } catch (error) {
      mutationError = error;
    }
    const after = await readState(config, dependencies);
    try {
      assertRealtimeVoiceTraceV2RailwayActive(after, config);
      if (!exactVariables(after.variables, { ...before.variables, ...block })) {
        fail('activation changed variables outside the owned Voice Trace block');
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
  if (command === 'deactivate' || command === 'force-off') {
    const before = await readState(config, dependencies);
    assertRestorable(before);
    const present = REALTIME_VOICE_TRACE_V2_OWNED_VARIABLES.filter((name) =>
      Object.hasOwn(before.variables, name),
    );
    if (present.length === 0) {
      assertRealtimeVoiceTraceV2RailwayOff(before, config);
      return { command, state: 'off', changed: false };
    }
    if (command === 'deactivate') {
      assertRealtimeVoiceTraceV2RailwayActive(before, config, { allowAnyRun: true });
    }
    const restored = withoutOwnedVariables(before.variables);
    const confirmed = await readState(config, dependencies);
    assertRestorable(confirmed);
    if (command === 'deactivate') {
      assertRealtimeVoiceTraceV2RailwayActive(confirmed, config, { allowAnyRun: true });
    }
    if (!exactVariables(before.variables, confirmed.variables)) {
      fail('Railway variables changed concurrently before deactivation');
    }
    let mutationError = null;
    try {
      await replaceVariables(config, restored, true, dependencies);
    } catch (error) {
      mutationError = error;
    }
    const after = await readState(config, dependencies);
    try {
      assertRealtimeVoiceTraceV2RailwayOff(after, config);
      if (!exactVariables(after.variables, restored)) {
        fail('deactivation changed variables outside the owned Voice Trace block');
      }
    } catch (verificationError) {
      if (mutationError !== null) throw mutationError;
      throw verificationError;
    }
    return {
      command,
      state: 'off',
      changed: true,
      acknowledgement: mutationError === null ? 'received' : 'recovered',
    };
  }
  fail('command must be preflight, activate, assert-active, deactivate, force-off or assert-off');
}

async function main() {
  const result = await runRealtimeVoiceTraceV2RailwayCommand(process.argv[2]);
  process.stdout.write(
    `realtime-voice-trace-v2-staging-railway:ok:${result.command}:${result.state}` +
      `${result.changed === true ? ':changed' : result.changed === false ? ':unchanged' : ''}` +
      `${result.acknowledgement ? `:${result.acknowledgement}` : ''}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
