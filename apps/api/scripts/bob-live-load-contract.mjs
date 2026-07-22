import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';

export const BOB_LIVE_LOAD_CONTRACT_VERSION = 'bob-live-c3-v1';
export const BOB_LIVE_LOAD_CONFIRMATION = 'RUN-BOB-LIVE-C3-ON-ISOLATED-TARGET';

const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export const BOB_LIVE_TRAFFIC_MIX = Object.freeze({
  read: 55,
  live: 15,
  idempotentWrite: 15,
  confirmedFinancialMutation: 5,
  document: 5,
  job: 5,
});

export const BOB_LIVE_JARVIS_MISSIONS = Object.freeze([
  'quote-one-shot',
  'quote-progressive',
  'invoice-from-quote',
  'customer-create',
  'catalogue-disambiguation',
  'home-briefing',
  'notification-action',
  'interruption-resume',
]);

export const BOB_LIVE_FAILURE_SCENARIOS = Object.freeze([
  'capacity-n-plus-one',
  'crash-after-reservation',
  'lease-ttl-recovery',
  'provider-outage',
  'mass-reconnect',
  'database-pool-saturation',
]);

const BOB_LIVE_MISSION_REQUIREMENTS = Object.freeze({
  'quote-one-shot': Object.freeze({
    reads: Object.freeze(['ListCustomers', 'SearchCatalogue']),
    write: 'CreateQuote',
    tool: 'creer_devis',
  }),
  'quote-progressive': Object.freeze({
    reads: Object.freeze(['ReadQuoteDraft', 'SearchCatalogue']),
    write: 'CreateQuote',
    tool: 'creer_devis',
  }),
  'invoice-from-quote': Object.freeze({
    reads: Object.freeze(['ListInvoiceableQuotes']),
    write: 'GenerateInvoiceFromQuote',
    tool: 'generer_facture_depuis_devis',
  }),
  'customer-create': Object.freeze({
    reads: Object.freeze(['FindCustomerDuplicates']),
    write: 'CreateCustomerIdempotent',
    tool: 'creer_client',
  }),
  'catalogue-disambiguation': Object.freeze({
    reads: Object.freeze(['SearchCatalogue']),
    write: 'ApplyCatalogueDecision',
    tool: 'search_catalogue',
  }),
  'home-briefing': Object.freeze({
    reads: Object.freeze(['DeriveTodayView']),
    write: null,
    tool: null,
  }),
  'notification-action': Object.freeze({
    reads: Object.freeze(['ListNotifications', 'ReadInvoice', 'ReadCustomer']),
    write: 'QueueInvoiceReminder',
    tool: 'relancer_facture',
  }),
  'interruption-resume': Object.freeze({
    reads: Object.freeze(['ReadRealtimeMission']),
    write: null,
    tool: null,
  }),
});

/**
 * These profiles are publication contracts, not convenient defaults. Reducing a value creates a
 * smoke run and can never yield a capacity certificate.
 */
export const BOB_LIVE_LOAD_PROFILES = Object.freeze({
  'cohort-100': Object.freeze({
    population: 100,
    api: Object.freeze({ sustainedVirtualUsers: 25, burstVirtualUsers: 75, requestIntervalSeconds: 5 }),
    liveStages: Object.freeze([10, 25, 50]),
    liveStageRampSeconds: 120,
    liveStageHoldSeconds: 300,
    liveSoakSeconds: 60 * 60,
    mixedSoakSeconds: 2 * 60 * 60,
    faultInjectionSeconds: 30 * 60,
    cleanupSeconds: 15 * 60,
  }),
  'cohort-1000': Object.freeze({
    population: 1_000,
    api: Object.freeze({ sustainedVirtualUsers: 100, burstVirtualUsers: 250, requestIntervalSeconds: 5 }),
    liveStages: Object.freeze([50, 100, 250]),
    liveStageRampSeconds: 120,
    liveStageHoldSeconds: 300,
    liveSoakSeconds: 60 * 60,
    mixedSoakSeconds: 4 * 60 * 60,
    faultInjectionSeconds: 30 * 60,
    cleanupSeconds: 15 * 60,
  }),
});

export const BOB_LIVE_LOAD_SLO = Object.freeze({
  firstAudio: Object.freeze({ p50Ms: 900, p95Ms: 1_800 }),
  bargeIn: Object.freeze({ p50Ms: 250, p95Ms: 500 }),
  http: Object.freeze({ p95Ms: 500, p99Ms: 1_000 }),
  criticalWrite: Object.freeze({ p95Ms: 750, p99Ms: 2_000 }),
  maxErrorRate: 0.001,
  minLiveSetupRate: 0.995,
  maxCpuPercent: 70,
  maxMemoryPercent: 75,
  maxMemoryGrowthPercentPointsPerHour: 2,
  maxDatabasePoolPercent: 80,
  minimumMeasuredMarginPercent: 30,
});

function fail(message) {
  throw new Error(`bob-live-load:${message}`);
}

function own(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function exactKeys(record, expected, label) {
  const actual = Object.keys(record);
  const unknown = actual.find((key) => !expected.includes(key));
  const missing = expected.find((key) => !own(record, key));
  if (unknown !== undefined) fail(`${label} contains unknown field ${unknown}`);
  if (missing !== undefined) fail(`${label} is missing field ${missing}`);
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} is required`);
  if (value !== value.trim()) fail(`${name} must not contain surrounding whitespace`);
  return value;
}

function integer(environment, name, minimum, maximum) {
  const raw = required(environment, name);
  if (!/^\d+$/u.test(raw)) fail(`${name} must be a base-10 integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function absolutePath(environment, name) {
  const value = required(environment, name);
  if (!isAbsolute(value)) fail(`${name} must be an absolute path`);
  return resolve(value);
}

function pathIsInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(pathFromRoot);
}

function boundedUrl(raw, targetEnvironment, label) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be an absolute URL`);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    fail(`${label} must not contain credentials or a fragment`);
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (targetEnvironment === 'ephemeral') {
    if (!loopback || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      fail(`${label} must use loopback for an ephemeral target`);
    }
  } else if (parsed.protocol !== 'https:' || loopback) {
    fail(`${label} must use non-loopback HTTPS for staging`);
  }
  return parsed;
}

function origin(raw, targetEnvironment) {
  const parsed = boundedUrl(raw, targetEnvironment, 'BOB_LIVE_LOAD_API_ORIGIN');
  if (
    parsed.pathname !== '/'
    || parsed.search !== ''
  ) {
    fail('BOB_LIVE_LOAD_API_ORIGIN must be an origin without credentials, path, query or hash');
  }
  return parsed.origin;
}

/**
 * Parse the immutable run envelope. The runner performs only a harmless readiness GET until the
 * returned environment/SHA have been verified against this envelope.
 */
export function parseBobLiveLoadEnvironment(environment = process.env) {
  if (required(environment, 'BOB_LIVE_LOAD_CONFIRM') !== BOB_LIVE_LOAD_CONFIRMATION) {
    fail(`BOB_LIVE_LOAD_CONFIRM must equal ${BOB_LIVE_LOAD_CONFIRMATION}`);
  }
  const profileId = required(environment, 'BOB_LIVE_LOAD_PROFILE');
  const profile = BOB_LIVE_LOAD_PROFILES[profileId];
  if (!profile) fail('BOB_LIVE_LOAD_PROFILE must be cohort-100 or cohort-1000');
  const pass = required(environment, 'BOB_LIVE_LOAD_PASS');
  if (pass !== 'deterministic' && pass !== 'gpt-realtime') {
    fail('BOB_LIVE_LOAD_PASS must be deterministic or gpt-realtime');
  }
  const runKind = required(environment, 'BOB_LIVE_LOAD_RUN_KIND');
  if (runKind !== 'smoke' && runKind !== 'certification') {
    fail('BOB_LIVE_LOAD_RUN_KIND must be smoke or certification');
  }
  const targetEnvironment = required(environment, 'BOB_LIVE_LOAD_TARGET_ENVIRONMENT');
  if (targetEnvironment !== 'ephemeral' && targetEnvironment !== 'staging') {
    fail('BOB_LIVE_LOAD_TARGET_ENVIRONMENT must be ephemeral or staging');
  }
  if (pass === 'gpt-realtime' && targetEnvironment !== 'staging') {
    fail('the real GPT Realtime pass is permitted only on staging');
  }
  if (pass === 'deterministic' && targetEnvironment !== 'ephemeral') {
    fail('the deterministic provider pass is permitted only on an ephemeral target');
  }
  const expectedClientIpSource = required(environment, 'BOB_LIVE_LOAD_EXPECTED_CLIENT_IP_SOURCE');
  if (expectedClientIpSource !== 'socket' && expectedClientIpSource !== 'railway-x-real-ip') {
    fail('BOB_LIVE_LOAD_EXPECTED_CLIENT_IP_SOURCE must be socket or railway-x-real-ip');
  }
  if ((targetEnvironment === 'staging' || runKind === 'certification') && expectedClientIpSource !== 'railway-x-real-ip') {
    fail('staging and certification runs require the railway-x-real-ip contract');
  }
  const expectedReleaseEnvironment = required(environment, 'BOB_LIVE_LOAD_EXPECTED_RELEASE_ENVIRONMENT');
  if (expectedReleaseEnvironment !== 'staging') {
    fail('capacity runs require an artifact explicitly built as staging');
  }
  const apiOrigin = origin(required(environment, 'BOB_LIVE_LOAD_API_ORIGIN'), targetEnvironment);
  if (targetEnvironment === 'staging') {
    const allowedOrigin = origin(required(environment, 'BOB_LIVE_LOAD_ALLOWED_STAGING_ORIGIN'), 'staging');
    if (apiOrigin !== allowedOrigin) fail('staging API origin is not the explicitly allowed target');
  }
  const expectedReleaseSha = required(environment, 'BOB_LIVE_LOAD_EXPECTED_SHA').toLowerCase();
  if (!SHA.test(expectedReleaseSha)) fail('BOB_LIVE_LOAD_EXPECTED_SHA must be a full lowercase Git SHA');
  const attempt = integer(environment, 'BOB_LIVE_LOAD_ATTEMPT', 1, 3);
  const sourceShards = integer(environment, 'BOB_LIVE_LOAD_SOURCE_SHARDS', 1, profile.population);
  // One request every five seconds per burst VU, with 10% headroom below the 100 req/min/IP
  // application throttle. On Railway these must be genuine source IPs; the ephemeral lab may
  // emulate them through the canonical X-Real-IP contract.
  const minimumSourceShards = Math.ceil((profile.api.burstVirtualUsers * 12) / 90);
  if (runKind === 'certification' && sourceShards < minimumSourceShards) {
    fail(`certification requires at least ${minimumSourceShards} independent source shards`);
  }
  const durationScaleRaw = required(environment, 'BOB_LIVE_LOAD_DURATION_SCALE');
  const durationScale = Number(durationScaleRaw);
  if (!Number.isFinite(durationScale) || durationScale <= 0 || durationScale > 1) {
    fail('BOB_LIVE_LOAD_DURATION_SCALE must be greater than 0 and at most 1');
  }
  if (runKind === 'certification' && durationScale !== 1) {
    fail('a certification run cannot shorten profile durations');
  }
  if (runKind === 'smoke' && durationScale > 0.1) {
    fail('a smoke run must use a duration scale at most 0.1');
  }
  const secretRoot = absolutePath(environment, 'BOB_LIVE_LOAD_SECRET_ROOT');
  const artifactRoot = absolutePath(environment, 'BOB_LIVE_LOAD_ARTIFACT_ROOT');
  if (secretRoot === artifactRoot || pathIsInside(secretRoot, artifactRoot) || pathIsInside(artifactRoot, secretRoot)) {
    fail('secret and artifact roots must be disjoint');
  }
  const manifestPath = absolutePath(environment, 'BOB_LIVE_LOAD_MANIFEST_PATH');
  const resultPath = absolutePath(environment, 'BOB_LIVE_LOAD_RESULT_PATH');
  if (!pathIsInside(secretRoot, manifestPath)) fail('principal manifest must be inside the secret root');
  if (!pathIsInside(artifactRoot, resultPath)) fail('result must be inside the artifact root');
  const parsedJwksUrl = boundedUrl(
    required(environment, 'BOB_LIVE_LOAD_JWKS_URL'),
    targetEnvironment,
    'BOB_LIVE_LOAD_JWKS_URL',
  );
  if (parsedJwksUrl.search !== '') fail('BOB_LIVE_LOAD_JWKS_URL must not contain a query');
  const jwksUrl = parsedJwksUrl.toString();
  const configuration = Object.freeze({
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    profileId,
    profile,
    pass,
    runKind,
    targetEnvironment,
    expectedReleaseEnvironment,
    expectedClientIpSource,
    apiOrigin,
    expectedReleaseSha,
    attempt,
    sourceShards,
    minimumSourceShards,
    durationScale,
    secretRoot,
    artifactRoot,
    manifestPath,
    resultPath,
    jwksUrl,
    jwtAudience: required(environment, 'BOB_LIVE_LOAD_JWT_AUDIENCE'),
    jwtIssuer: required(environment, 'BOB_LIVE_LOAD_JWT_ISSUER'),
    expectedProviderId: required(environment, 'BOB_LIVE_LOAD_EXPECTED_PROVIDER_ID'),
    expectedModel: required(environment, 'BOB_LIVE_LOAD_EXPECTED_MODEL'),
    expectedDeploymentId: required(environment, 'BOB_LIVE_LOAD_EXPECTED_DEPLOYMENT_ID'),
    expectedGlobalCapacity: integer(environment, 'BOB_LIVE_LOAD_EXPECTED_GLOBAL_CAPACITY', 1, 1_000),
    expectedProviderCapacity: integer(environment, 'BOB_LIVE_LOAD_EXPECTED_PROVIDER_CAPACITY', 1, 10_000),
    expectedCapacityConfigVersion: integer(environment, 'BOB_LIVE_LOAD_EXPECTED_CAPACITY_CONFIG_VERSION', 1, 2_147_483_647),
    expectedApiReplicas: integer(environment, 'BOB_LIVE_LOAD_EXPECTED_API_REPLICAS', 1, 1_000),
    expectedDatabasePoolMax: integer(environment, 'BOB_LIVE_LOAD_EXPECTED_DATABASE_POOL_MAX', 1, 100_000),
  });
  VALIDATED_CONFIGURATIONS.add(configuration);
  return configuration;
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function boundedString(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    fail(`${label} must be a non-empty bounded string`);
  }
  return value;
}

export function bobLivePlannedRunSeconds(profile, durationScale = 1) {
  return Math.ceil((
    profile.liveStages.length * (profile.liveStageRampSeconds + profile.liveStageHoldSeconds)
    + profile.liveSoakSeconds
    + profile.mixedSoakSeconds
    + profile.faultInjectionSeconds
    + profile.cleanupSeconds
  ) * durationScale);
}

const VALIDATED_CONFIGURATIONS = new WeakSet();
const VALIDATED_MANIFESTS = new WeakSet();
const VALIDATED_READINESS = new WeakSet();
const VALIDATED_RUN_CONTEXTS = new WeakSet();
const CONSUMED_RUN_CONTEXTS = new WeakSet();

class BobLiveLoadPrincipal {
  #accessToken;

  constructor({ slot, userId, companyId, accessToken, sourceShard }) {
    this.slot = slot;
    this.userId = userId;
    this.companyId = companyId;
    this.sourceShard = sourceShard;
    this.#accessToken = accessToken;
    Object.freeze(this);
  }

  authorizationHeader() {
    return `Bearer ${this.#accessToken}`;
  }

  toJSON() {
    return { slot: this.slot, sourceShard: this.sourceShard, credential: '[REDACTED]' };
  }
}

async function readSecretFile(configuration) {
  let handle;
  try {
    handle = await open(configuration.manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const [metadata, secretRootMetadata, canonicalSecretRoot, canonicalManifestPath] = await Promise.all([
      handle.stat(),
      stat(configuration.secretRoot),
      realpath(configuration.secretRoot),
      realpath(configuration.manifestPath),
    ]);
    if (!secretRootMetadata.isDirectory()) fail('secret root must be a directory');
    if (typeof process.getuid === 'function' && secretRootMetadata.uid !== process.getuid()) {
      fail('secret root must belong to the current user');
    }
    if (process.platform !== 'win32' && (secretRootMetadata.mode & 0o777) !== 0o700) {
      fail('secret root permissions must be 0700');
    }
    if (!metadata.isFile()) fail('principal manifest must be a regular file');
    if (metadata.size < 2 || metadata.size > 32 * 1024 * 1024) fail('principal manifest size is invalid');
    if (!pathIsInside(canonicalSecretRoot, canonicalManifestPath)) {
      fail('principal manifest resolves outside the secret root');
    }
    if (canonicalSecretRoot !== configuration.secretRoot || canonicalManifestPath !== configuration.manifestPath) {
      fail('principal manifest path must not traverse symbolic links');
    }
    const comparisonHandle = await open(canonicalManifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const comparison = await comparisonHandle.stat();
      if (comparison.dev !== metadata.dev || comparison.ino !== metadata.ino) {
        fail('principal manifest changed during secure open');
      }
    } finally {
      await comparisonHandle.close();
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      fail('principal manifest must belong to the current user');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
      fail('principal manifest permissions must be 0600');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('bob-live-load:')) throw error;
    fail('principal manifest cannot be opened securely');
  } finally {
    await handle?.close();
  }
}

async function loadJwks(configuration) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  let response;
  try {
    response = await fetch(configuration.jwksUrl, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
  } catch {
    fail('JWKS request failed');
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) fail(`JWKS returned HTTP ${response?.status ?? 'unknown'}`);
  const text = await response.text();
  if (text.length > 64 * 1024) fail('JWKS response is too large');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('JWKS response is not JSON');
  }
  const jwks = exactRecord(value, ['keys'], 'JWKS');
  if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 10) fail('JWKS keys are invalid');
  return createLocalJWKSet(jwks);
}

/** Read and validate short-lived principals without ever returning them in diagnostics. */
export async function loadBobLivePrincipalManifest(configuration) {
  let decoded;
  try {
    decoded = JSON.parse(await readSecretFile(configuration));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('bob-live-load:')) throw error;
    fail('principal manifest cannot be read as JSON');
  }
  const manifest = record(decoded, 'principal manifest');
  exactKeys(
    manifest,
    [
      'contractVersion',
      'targetEnvironment',
      'expectedReleaseEnvironment',
      'expectedReleaseSha',
      'generatedAt',
      'expiresAt',
      'principals',
    ],
    'principal manifest',
  );
  if (manifest.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION) fail('principal manifest contract version mismatch');
  if (manifest.targetEnvironment !== configuration.targetEnvironment) fail('principal manifest environment mismatch');
  if (manifest.expectedReleaseEnvironment !== configuration.expectedReleaseEnvironment) {
    fail('principal manifest release environment mismatch');
  }
  if (manifest.expectedReleaseSha !== configuration.expectedReleaseSha) fail('principal manifest release SHA mismatch');
  const generatedAt = Date.parse(boundedString(manifest.generatedAt, 'principal manifest generatedAt', 40));
  const expiresAt = Date.parse(boundedString(manifest.expiresAt, 'principal manifest expiresAt', 40));
  const now = Date.now();
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) || generatedAt > now + 60_000 || generatedAt < now - 15 * 60_000) {
    fail('principal manifest timestamps are invalid');
  }
  const requiredValidityMs = (bobLivePlannedRunSeconds(configuration.profile, configuration.durationScale) * 1_000)
    + 15 * 60_000;
  if (expiresAt <= now + requiredValidityMs || expiresAt > now + 24 * 60 * 60_000) {
    fail('principal manifest must cover the complete run plus 15 minutes and expire within 24 hours');
  }
  if (!Array.isArray(manifest.principals) || manifest.principals.length !== configuration.profile.population) {
    fail(`principal manifest must contain exactly ${configuration.profile.population} principals`);
  }
  const users = new Set();
  const companies = new Set();
  const tokens = new Set();
  const slots = new Set();
  const shards = new Set();
  const jwks = await loadJwks(configuration);
  const principals = [];
  for (let index = 0; index < manifest.principals.length; index += 1) {
    const entry = manifest.principals[index];
    const principal = record(entry, `principal ${index}`);
    exactKeys(principal, ['slot', 'userId', 'companyId', 'accessToken', 'sourceShard'], `principal ${index}`);
    if (!Number.isSafeInteger(principal.slot) || principal.slot !== index) fail(`principal ${index} slot mismatch`);
    const userId = boundedString(principal.userId, `principal ${index} userId`, 36).toLowerCase();
    const companyId = boundedString(principal.companyId, `principal ${index} companyId`, 64);
    const accessToken = boundedString(principal.accessToken, `principal ${index} accessToken`, 8_192);
    if (!UUID.test(userId)) fail(`principal ${index} userId must be a lowercase UUID`);
    if (!COMPANY_ID.test(companyId)) fail(`principal ${index} companyId is invalid`);
    if (!ACCESS_TOKEN.test(accessToken)) fail(`principal ${index} accessToken is not a compact JWT`);
    if (!Number.isSafeInteger(principal.sourceShard) || principal.sourceShard < 0 || principal.sourceShard >= configuration.sourceShards) {
      fail(`principal ${index} sourceShard is outside the configured range`);
    }
    if (users.has(userId) || companies.has(companyId) || tokens.has(accessToken) || slots.has(principal.slot)) {
      fail(`principal ${index} duplicates an identity, tenant, token or slot`);
    }
    users.add(userId);
    companies.add(companyId);
    tokens.add(accessToken);
    slots.add(principal.slot);
    shards.add(principal.sourceShard);
    let payload;
    try {
      ({ payload } = await jwtVerify(accessToken, jwks, {
        audience: configuration.jwtAudience,
        issuer: configuration.jwtIssuer,
        algorithms: ['ES256'],
      }));
    } catch {
      fail(`principal ${index} access token signature or claims are invalid`);
    }
    if (payload.sub !== userId) fail(`principal ${index} token subject mismatch`);
    const tokenCompanyId = payload.app_metadata?.company_id;
    if (tokenCompanyId !== companyId) fail(`principal ${index} token tenant mismatch`);
    if (typeof payload.exp !== 'number' || payload.exp * 1_000 < expiresAt) {
      fail(`principal ${index} token expires before the manifest`);
    }
    principals.push(new BobLiveLoadPrincipal({
      slot: principal.slot,
      userId,
      companyId,
      accessToken,
      sourceShard: principal.sourceShard,
    }));
  }
  if (configuration.runKind === 'certification' && shards.size !== configuration.sourceShards) {
    fail('every configured source shard must own at least one principal');
  }
  const validated = Object.freeze({
    generatedAt: new Date(generatedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    principals: Object.freeze(principals),
  });
  VALIDATED_MANIFESTS.add(validated);
  return validated;
}

/** The only manifest information allowed in logs and result artifacts. */
export function publicManifestSummary(configuration, manifest) {
  return Object.freeze({
    principalCount: manifest.principals.length,
    sourceShardCount: new Set(manifest.principals.map((principal) => principal.sourceShard)).size,
    expiresAt: manifest.expiresAt,
    profileId: configuration.profileId,
  });
}

export function assertBobLiveLoadReadiness(configuration, payload) {
  const value = record(payload, 'readiness payload');
  const release = record(value.release, 'readiness release');
  const network = record(value.network, 'readiness network');
  if (value.ready !== true) fail('target readiness is false');
  if (release.sha !== configuration.expectedReleaseSha) fail('target release SHA mismatch');
  if (release.environment !== configuration.expectedReleaseEnvironment) fail('target release environment mismatch');
  if (network.clientIpSource !== configuration.expectedClientIpSource) {
    fail(`target client IP contract must be ${configuration.expectedClientIpSource}`);
  }
  const validated = Object.freeze({
    releaseSha: release.sha,
    environment: release.environment,
    clientIpSource: network.clientIpSource,
  });
  VALIDATED_READINESS.add(validated);
  return validated;
}

function createRunContext(configuration, manifest, readiness, preparedAt) {
  if (!VALIDATED_MANIFESTS.has(manifest) || !VALIDATED_READINESS.has(readiness)) {
    fail('run context requires validated readiness and principals');
  }
  const runId = randomUUID();
  const preflightDigest = createHash('sha256').update(JSON.stringify({
    contractVersion: configuration.contractVersion,
    profileId: configuration.profileId,
    pass: configuration.pass,
    runKind: configuration.runKind,
    attempt: configuration.attempt,
    expectedReleaseSha: configuration.expectedReleaseSha,
    expectedReleaseEnvironment: configuration.expectedReleaseEnvironment,
    expectedClientIpSource: configuration.expectedClientIpSource,
    apiOrigin: configuration.apiOrigin,
    sourceShards: configuration.sourceShards,
    durationScale: configuration.durationScale,
    jwksUrl: configuration.jwksUrl,
    jwtAudience: configuration.jwtAudience,
    jwtIssuer: configuration.jwtIssuer,
    expectedDeploymentId: configuration.expectedDeploymentId,
    expectedProviderId: configuration.expectedProviderId,
    expectedModel: configuration.expectedModel,
    expectedGlobalCapacity: configuration.expectedGlobalCapacity,
    expectedProviderCapacity: configuration.expectedProviderCapacity,
    expectedCapacityConfigVersion: configuration.expectedCapacityConfigVersion,
    expectedApiReplicas: configuration.expectedApiReplicas,
    expectedDatabasePoolMax: configuration.expectedDatabasePoolMax,
    manifest: publicManifestSummary(configuration, manifest),
    readiness,
    preparedAt,
    runId,
  })).digest('hex');
  const context = Object.freeze({
    configuration,
    runId,
    preparedAt,
    preflightDigest,
    readiness,
    manifestSummary: publicManifestSummary(configuration, manifest),
    principals: manifest.principals,
  });
  VALIDATED_RUN_CONTEXTS.add(context);
  return context;
}

/**
 * Mandatory preflight. It performs the only request allowed before exact release verification,
 * then securely loads and verifies every short-lived principal.
 */
export async function prepareBobLiveLoadRun(configuration, fetchImpl = globalThis.fetch) {
  if (!VALIDATED_CONFIGURATIONS.has(configuration)) fail('load run requires parsed configuration');
  if (typeof fetchImpl !== 'function') fail('fetch implementation is unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  let response;
  try {
    response = await fetchImpl(`${configuration.apiOrigin}/health/ready`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
  } catch {
    fail('target readiness request failed');
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) fail(`target readiness returned HTTP ${response?.status ?? 'unknown'}`);
  const text = await response.text();
  if (text.length > 64 * 1024) fail('target readiness response is too large');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail('target readiness response is not JSON');
  }
  const readiness = assertBobLiveLoadReadiness(configuration, payload);
  const manifest = await loadBobLivePrincipalManifest(configuration);
  return createRunContext(configuration, manifest, readiness, new Date().toISOString());
}

function finiteSamples(samples, label) {
  if (!Array.isArray(samples) || samples.length === 0) fail(`${label} must contain samples`);
  return samples.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label}[${index}] is invalid`);
    return value;
  }).sort((left, right) => left - right);
}

export function percentile(samples, quantile, label = 'samples') {
  if (typeof quantile !== 'number' || quantile < 0 || quantile > 1) fail('quantile must be between 0 and 1');
  const sorted = finiteSamples(samples, label);
  const rank = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, rank)];
}

function ratio(numerator, denominator, label) {
  if (!Number.isSafeInteger(numerator) || numerator < 0 || !Number.isSafeInteger(denominator) || denominator < 1 || numerator > denominator) {
    fail(`${label} counters are invalid`);
  }
  return numerator / denominator;
}

function boundedMetric(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) fail(`${label} is invalid`);
  return value;
}

function exactRecord(value, keys, label) {
  const parsed = record(value, label);
  exactKeys(parsed, keys, label);
  return parsed;
}

function safeCount(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} is invalid`);
  return value;
}

function parseInstant(value, label) {
  const raw = boundedString(value, label, 40);
  const epochMs = Date.parse(raw);
  if (!Number.isFinite(epochMs)) fail(`${label} is invalid`);
  return { raw: new Date(epochMs).toISOString(), epochMs };
}

function sameNumberArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) fail(`${label} length mismatch`);
  value.forEach((entry, index) => {
    if (entry !== expected[index]) fail(`${label}[${index}] mismatch`);
  });
}

function memoryGrowthPerHour(samples, intervalSeconds) {
  if (samples.length < 2) return Number.POSITIVE_INFINITY;
  const meanX = (samples.length - 1) / 2;
  const meanY = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const deltaX = index - meanX;
    numerator += deltaX * (samples[index] - meanY);
    denominator += deltaX * deltaX;
  }
  if (denominator === 0) return Number.POSITIVE_INFINITY;
  return (numerator / denominator) * (3_600 / intervalSeconds);
}

function validateTrafficMix(configuration, trafficCounts, requestCount) {
  const counts = exactRecord(trafficCounts, Object.keys(BOB_LIVE_TRAFFIC_MIX), 'traffic counts');
  let total = 0;
  for (const key of Object.keys(BOB_LIVE_TRAFFIC_MIX)) total += safeCount(counts[key], `traffic counts ${key}`);
  if (total !== requestCount) fail('traffic counts must sum exactly to requestCount');
  const tolerance = configuration.runKind === 'certification' ? 0.02 : 0.05;
  return Object.fromEntries(Object.entries(BOB_LIVE_TRAFFIC_MIX).map(([key, expectedPercent]) => {
    const actual = counts[key] / requestCount;
    return [key, Math.abs(actual - (expectedPercent / 100)) <= tolerance];
  }));
}

function validateSourceAttestations(context, attestations, runStartMs, runEndMs) {
  const { configuration } = context;
  if (!Array.isArray(attestations) || attestations.length !== configuration.sourceShards) {
    fail('source shard attestations must cover every configured shard exactly once');
  }
  const shards = new Set();
  const fingerprints = new Set();
  for (let index = 0; index < attestations.length; index += 1) {
    const attestation = exactRecord(
      attestations[index],
      ['shard', 'networkFingerprint', 'runNonce', 'observedAt'],
      `source attestation ${index}`,
    );
    const shard = safeCount(attestation.shard, `source attestation ${index} shard`, configuration.sourceShards - 1);
    const fingerprint = boundedString(attestation.networkFingerprint, `source attestation ${index} fingerprint`, 64);
    if (!SHA256.test(fingerprint)) fail(`source attestation ${index} fingerprint is invalid`);
    if (attestation.runNonce !== context.preflightDigest) fail(`source attestation ${index} run nonce mismatch`);
    const observedAt = parseInstant(attestation.observedAt, `source attestation ${index} observedAt`).epochMs;
    if (observedAt < runStartMs || observedAt > runEndMs) {
      fail(`source attestation ${index} lies outside the run window`);
    }
    if (shards.has(shard) || fingerprints.has(fingerprint)) fail('source shard attestations must be unique');
    shards.add(shard);
    fingerprints.add(fingerprint);
  }
  return shards.size === configuration.sourceShards && fingerprints.size === configuration.sourceShards;
}

function validateTopology(context, topologyInput, runStartMs, runEndMs) {
  const { configuration } = context;
  const topology = exactRecord(topologyInput, [
    'deploymentId',
    'providerId',
    'model',
    'apiReplicas',
    'databasePoolMax',
    'globalCapacity',
    'providerCapacity',
    'capacityConfigVersion',
    'sourceShardAttestations',
  ], 'topology');
  if (topology.deploymentId !== configuration.expectedDeploymentId) fail('topology deployment mismatch');
  if (topology.providerId !== configuration.expectedProviderId) fail('topology provider mismatch');
  if (topology.model !== configuration.expectedModel) fail('topology model mismatch');
  if (topology.apiReplicas !== configuration.expectedApiReplicas) fail('topology API replica mismatch');
  if (topology.databasePoolMax !== configuration.expectedDatabasePoolMax) fail('topology database pool mismatch');
  if (topology.globalCapacity !== configuration.expectedGlobalCapacity) fail('topology global capacity mismatch');
  if (topology.providerCapacity !== configuration.expectedProviderCapacity) fail('topology provider capacity mismatch');
  if (topology.capacityConfigVersion !== configuration.expectedCapacityConfigVersion) {
    fail('topology capacity config version mismatch');
  }
  const sourceShards = validateSourceAttestations(
    context,
    topology.sourceShardAttestations,
    runStartMs,
    runEndMs,
  );
  const peak = configuration.profile.liveStages.at(-1);
  const requiredCapacity = Math.ceil(peak * (1 + BOB_LIVE_LOAD_SLO.minimumMeasuredMarginPercent / 100));
  return {
    sourceShards,
    declaredMargin: topology.globalCapacity >= requiredCapacity && topology.providerCapacity >= requiredCapacity,
    digest: createHash('sha256').update(JSON.stringify({
      providerId: topology.providerId,
      model: topology.model,
      apiReplicas: topology.apiReplicas,
      databasePoolMax: topology.databasePoolMax,
      globalCapacity: topology.globalCapacity,
      providerCapacity: topology.providerCapacity,
      capacityConfigVersion: topology.capacityConfigVersion,
    })).digest('hex'),
  };
}

function validateWorkload(configuration, workloadInput, requestCount) {
  const workload = exactRecord(workloadInput, [
    'populationSeeded',
    'sustainedVirtualUsers',
    'burstVirtualUsers',
    'requestIntervalSeconds',
    'liveStages',
    'liveStageRampSeconds',
    'liveStageHoldSeconds',
    'liveSoakSeconds',
    'mixedSoakSeconds',
    'faultInjectionSeconds',
    'cleanupSeconds',
    'peakConcurrentLiveSessions',
    'livePeakSeconds',
    'maxStableLiveSessions',
    'trafficCounts',
  ], 'workload');
  const profile = configuration.profile;
  if (workload.populationSeeded !== profile.population) fail('workload population mismatch');
  if (workload.sustainedVirtualUsers !== profile.api.sustainedVirtualUsers) fail('workload sustained VU mismatch');
  if (workload.burstVirtualUsers !== profile.api.burstVirtualUsers) fail('workload burst VU mismatch');
  if (workload.requestIntervalSeconds !== profile.api.requestIntervalSeconds) fail('workload request cadence mismatch');
  sameNumberArray(workload.liveStages, profile.liveStages, 'workload live stages');
  const requiredRampSeconds = Math.ceil(profile.liveStageRampSeconds * configuration.durationScale);
  const requiredHoldSeconds = Math.ceil(profile.liveStageHoldSeconds * configuration.durationScale);
  const requiredLiveSeconds = Math.ceil(profile.liveSoakSeconds * configuration.durationScale);
  const requiredMixedSeconds = Math.ceil(profile.mixedSoakSeconds * configuration.durationScale);
  const requiredFaultSeconds = Math.ceil(profile.faultInjectionSeconds * configuration.durationScale);
  const requiredCleanupSeconds = Math.ceil(profile.cleanupSeconds * configuration.durationScale);
  if (workload.liveStageRampSeconds < requiredRampSeconds) fail('workload Live ramps are too short');
  if (workload.liveStageHoldSeconds < requiredHoldSeconds) fail('workload Live holds are too short');
  if (workload.liveSoakSeconds < requiredLiveSeconds) fail('workload live soak is too short');
  if (workload.mixedSoakSeconds < requiredMixedSeconds) fail('workload mixed soak is too short');
  if (workload.faultInjectionSeconds < requiredFaultSeconds) fail('workload fault phase is too short');
  if (workload.cleanupSeconds < requiredCleanupSeconds) fail('workload cleanup phase is too short');
  const peak = profile.liveStages.at(-1);
  if (workload.peakConcurrentLiveSessions < peak) fail('workload never reached the Live peak');
  if (workload.livePeakSeconds < requiredLiveSeconds) fail('workload did not hold the Live peak');
  const minimumStable = Math.ceil(peak * (1 + BOB_LIVE_LOAD_SLO.minimumMeasuredMarginPercent / 100));
  if (workload.maxStableLiveSessions < minimumStable) fail('workload did not measure the required headroom');
  if (workload.peakConcurrentLiveSessions < workload.maxStableLiveSessions) {
    fail('workload stable concurrency cannot exceed its observed peak');
  }
  const minimumRequests = Math.ceil(
    profile.api.sustainedVirtualUsers * requiredMixedSeconds / profile.api.requestIntervalSeconds,
  );
  if (requestCount < minimumRequests) fail(`workload requires at least ${minimumRequests} requests`);
  const mixChecks = validateTrafficMix(configuration, workload.trafficCounts, requestCount);
  return {
    requiredLiveSeconds,
    requiredMixedSeconds,
    requiredLoadCoverageSeconds:
      profile.liveStages.length * (requiredRampSeconds + requiredHoldSeconds)
      + requiredLiveSeconds
      + requiredMixedSeconds
      + requiredFaultSeconds,
    requiredTotalSeconds: bobLivePlannedRunSeconds(profile, configuration.durationScale),
    measuredMarginPercent: ((workload.maxStableLiveSessions - peak) / peak) * 100,
    mixChecks,
  };
}

function validateOutcomes(outcomesInput) {
  const outcomes = exactRecord(outcomesInput, [
    'requestCount',
    'successCount',
    'expectedRejections',
    'unexpectedHttp4xxCount',
    'unexpectedRateLimitCount',
    'timeoutCount',
    'http5xxCount',
    'protocolErrorCount',
    'cancelledCount',
    'silentErrorCount',
    'missingResultCount',
    'liveSetupAttemptCount',
    'liveSetupSuccessCount',
  ], 'outcomes');
  for (const key of Object.keys(outcomes)) {
    if (key !== 'expectedRejections') safeCount(outcomes[key], `outcomes ${key}`);
  }
  if (outcomes.requestCount < 1) fail('outcomes requestCount must be positive');
  if (!Array.isArray(outcomes.expectedRejections)) fail('outcomes expectedRejections must be an array');
  const expectedOperationIds = new Set();
  outcomes.expectedRejections.forEach((entry, index) => {
    const rejection = exactRecord(
      entry,
      ['operationId', 'reason', 'faultScenario', 'evidenceDigest'],
      `expected rejection ${index}`,
    );
    const operationId = boundedString(rejection.operationId, `expected rejection ${index} operationId`, 128);
    if (expectedOperationIds.has(operationId)) fail('expected rejection operation is duplicated');
    expectedOperationIds.add(operationId);
    if (!['global_capacity', 'provider_unavailable', 'database_saturated', 'reconnect_backoff'].includes(rejection.reason)) {
      fail(`expected rejection ${index} reason is invalid`);
    }
    if (!BOB_LIVE_FAILURE_SCENARIOS.includes(rejection.faultScenario)) {
      fail(`expected rejection ${index} fault scenario is invalid`);
    }
    if (!SHA256.test(rejection.evidenceDigest)) fail(`expected rejection ${index} evidence digest is invalid`);
  });
  const expectedRejectionCount = outcomes.expectedRejections.length;
  const accounted = outcomes.successCount
    + expectedRejectionCount
    + outcomes.unexpectedHttp4xxCount
    + outcomes.unexpectedRateLimitCount
    + outcomes.timeoutCount
    + outcomes.http5xxCount
    + outcomes.protocolErrorCount
    + outcomes.cancelledCount
    + outcomes.silentErrorCount
    + outcomes.missingResultCount;
  if (accounted !== outcomes.requestCount) fail('outcome categories must sum exactly to requestCount');
  if (outcomes.liveSetupAttemptCount < 1 || outcomes.liveSetupSuccessCount > outcomes.liveSetupAttemptCount) {
    fail('live setup outcome counters are invalid');
  }
  const unexpectedErrors = outcomes.timeoutCount
    + outcomes.unexpectedHttp4xxCount
    + outcomes.unexpectedRateLimitCount
    + outcomes.http5xxCount
    + outcomes.protocolErrorCount
    + outcomes.cancelledCount
    + outcomes.silentErrorCount
    + outcomes.missingResultCount;
  return {
    ...outcomes,
    expectedRejectionCount,
    errorRate: ratio(unexpectedErrors, outcomes.requestCount, 'request'),
    liveSetupRate: ratio(outcomes.liveSetupSuccessCount, outcomes.liveSetupAttemptCount, 'live setup'),
  };
}

function validateAcousticSample(sampleInput, label, expectedTerminal, runStartMs, runEndMs, seenProofs) {
  const sample = exactRecord(sampleInput, [
    'sessionProofId',
    'turnId',
    'startedAt',
    'terminalAt',
    'terminalEvent',
  ], label);
  const proofId = boundedString(sample.sessionProofId, `${label} sessionProofId`, 128);
  boundedString(sample.turnId, `${label} turnId`, 128);
  const startedAt = parseInstant(sample.startedAt, `${label} startedAt`).epochMs;
  const terminalAt = parseInstant(sample.terminalAt, `${label} terminalAt`).epochMs;
  if (startedAt < runStartMs || terminalAt > runEndMs || terminalAt < startedAt) {
    fail(`${label} lies outside the run window`);
  }
  if (sample.terminalEvent !== expectedTerminal) fail(`${label} terminal event mismatch`);
  if (seenProofs.has(proofId)) fail(`${label} duplicates a session proof`);
  seenProofs.add(proofId);
  return terminalAt - startedAt;
}

export function validateBobLiveAcousticEvidence(configuration, stagesInput, runStartMs, runEndMs) {
  if (configuration.pass === 'deterministic') {
    if (!Array.isArray(stagesInput) || stagesInput.length !== 0) fail('deterministic pass cannot claim acoustic evidence');
    return null;
  }
  if (!Array.isArray(stagesInput) || stagesInput.length !== configuration.profile.liveStages.length) {
    fail('acoustic evidence must cover every Live stage');
  }
  const allFirstAudio = [];
  const allBargeIn = [];
  const stageMetrics = [];
  const seenFirstAudio = new Set();
  const seenBargeIn = new Set();
  stagesInput.forEach((stageInput, stageIndex) => {
    const stage = exactRecord(stageInput, ['concurrency', 'firstAudio', 'bargeIn'], `acoustic stage ${stageIndex}`);
    const expectedConcurrency = configuration.profile.liveStages[stageIndex];
    if (stage.concurrency !== expectedConcurrency) fail(`acoustic stage ${stageIndex} concurrency mismatch`);
    const minimumSamples = configuration.runKind === 'certification'
      ? Math.max(30, expectedConcurrency)
      : Math.max(1, Math.min(5, expectedConcurrency));
    if (!Array.isArray(stage.firstAudio) || stage.firstAudio.length < minimumSamples) {
      fail(`acoustic stage ${stageIndex} lacks first-audio samples`);
    }
    if (!Array.isArray(stage.bargeIn) || stage.bargeIn.length < minimumSamples) {
      fail(`acoustic stage ${stageIndex} lacks barge-in samples`);
    }
    const stageFirstAudio = [];
    const stageBargeIn = [];
    stage.firstAudio.forEach((sample, index) => stageFirstAudio.push(validateAcousticSample(
      sample,
      `acoustic stage ${stageIndex} firstAudio ${index}`,
      'first-audio-frame',
      runStartMs,
      runEndMs,
      seenFirstAudio,
    )));
    stage.bargeIn.forEach((sample, index) => stageBargeIn.push(validateAcousticSample(
      sample,
      `acoustic stage ${stageIndex} bargeIn ${index}`,
      'audio-output-cleared',
      runStartMs,
      runEndMs,
      seenBargeIn,
    )));
    allFirstAudio.push(...stageFirstAudio);
    allBargeIn.push(...stageBargeIn);
    stageMetrics.push(Object.freeze({
      concurrency: expectedConcurrency,
      firstAudioP50Ms: percentile(stageFirstAudio, 0.5, `stage ${expectedConcurrency} first audio`),
      firstAudioP95Ms: percentile(stageFirstAudio, 0.95, `stage ${expectedConcurrency} first audio`),
      bargeInP50Ms: percentile(stageBargeIn, 0.5, `stage ${expectedConcurrency} barge in`),
      bargeInP95Ms: percentile(stageBargeIn, 0.95, `stage ${expectedConcurrency} barge in`),
      firstAudioSampleCount: stageFirstAudio.length,
      bargeInSampleCount: stageBargeIn.length,
    }));
  });
  return {
    stages: Object.freeze(stageMetrics),
    firstAudioP50Ms: percentile(allFirstAudio, 0.5, 'first audio'),
    firstAudioP95Ms: percentile(allFirstAudio, 0.95, 'first audio'),
    bargeInP50Ms: percentile(allBargeIn, 0.5, 'barge in'),
    bargeInP95Ms: percentile(allBargeIn, 0.95, 'barge in'),
    firstAudioSampleCount: allFirstAudio.length,
    bargeInSampleCount: allBargeIn.length,
  };
}

function validateResources(resourcesInput, requiredCoverageSeconds, runStartMs, runEndMs) {
  const resources = exactRecord(resourcesInput, [
    'sampleIntervalSeconds',
    'apiCpuPercent',
    'apiMemoryPercent',
    'databaseCpuPercent',
    'databaseMemoryPercent',
    'databasePoolPercent',
  ], 'resources');
  const interval = safeCount(resources.sampleIntervalSeconds, 'resource sample interval', 60);
  if (interval < 1) fail('resource sample interval must be positive');
  const minimumSamples = Math.max(2, Math.ceil(requiredCoverageSeconds / interval) + 1);
  const names = [
    'apiCpuPercent',
    'apiMemoryPercent',
    'databaseCpuPercent',
    'databaseMemoryPercent',
    'databasePoolPercent',
  ];
  const series = {};
  for (const name of names) {
    if (!Array.isArray(resources[name]) || resources[name].length < minimumSamples) {
      fail(`resources ${name} lacks temporal coverage`);
    }
    const temporal = [];
    let firstObservedAt = null;
    let previousObservedAt = null;
    resources[name].forEach((entry, index) => {
      const sample = exactRecord(entry, ['observedAt', 'value'], `resources ${name} ${index}`);
      const observedAt = parseInstant(sample.observedAt, `resources ${name} ${index} observedAt`).epochMs;
      const value = boundedMetric(sample.value, `resources ${name} ${index} value`);
      if (observedAt < runStartMs || observedAt > runEndMs) fail(`resources ${name} ${index} lies outside the run`);
      if (previousObservedAt !== null && (
        observedAt <= previousObservedAt
        || observedAt - previousObservedAt > interval * 1_100
      )) fail(`resources ${name} contains a temporal gap`);
      firstObservedAt ??= observedAt;
      previousObservedAt = observedAt;
      temporal.push(value);
    });
    if (
      firstObservedAt > runStartMs + interval * 1_000
      || previousObservedAt - firstObservedAt < requiredCoverageSeconds * 1_000
    ) fail(`resources ${name} does not cover the required window`);
    series[name] = { max: Math.max(...temporal), temporal };
  }
  const apiMemoryGrowth = memoryGrowthPerHour(series.apiMemoryPercent.temporal, interval);
  const databaseMemoryGrowth = memoryGrowthPerHour(series.databaseMemoryPercent.temporal, interval);
  return {
    maxApiCpuPercent: series.apiCpuPercent.max,
    maxApiMemoryPercent: series.apiMemoryPercent.max,
    maxDatabaseCpuPercent: series.databaseCpuPercent.max,
    maxDatabaseMemoryPercent: series.databaseMemoryPercent.max,
    maxDatabasePoolPercent: series.databasePoolPercent.max,
    apiMemoryGrowthPercentPointsPerHour: apiMemoryGrowth,
    databaseMemoryGrowthPercentPointsPerHour: databaseMemoryGrowth,
    passed:
      series.apiCpuPercent.max <= BOB_LIVE_LOAD_SLO.maxCpuPercent
      && series.databaseCpuPercent.max <= BOB_LIVE_LOAD_SLO.maxCpuPercent
      && series.apiMemoryPercent.max <= BOB_LIVE_LOAD_SLO.maxMemoryPercent
      && series.databaseMemoryPercent.max <= BOB_LIVE_LOAD_SLO.maxMemoryPercent
      && series.databasePoolPercent.max <= BOB_LIVE_LOAD_SLO.maxDatabasePoolPercent
      && apiMemoryGrowth <= BOB_LIVE_LOAD_SLO.maxMemoryGrowthPercentPointsPerHour
      && databaseMemoryGrowth <= BOB_LIVE_LOAD_SLO.maxMemoryGrowthPercentPointsPerHour,
  };
}

function validateMissionEnvelope(
  context,
  envelopeInput,
  caseId,
  stage,
  runStartMs,
  runEndMs,
  seenMissionIds,
) {
  const label = `mission ${caseId}`;
  const transport = context.configuration.pass;
  const requirements = BOB_LIVE_MISSION_REQUIREMENTS[caseId];
  const envelope = exactRecord(envelopeInput, [
    'caseId',
    'missionId',
    'runId',
    'preflightDigest',
    'companyIdHash',
    'sessionId',
    'transport',
    'stage',
    'startedAt',
    'completedAt',
    'turns',
    'reads',
    'decisions',
    'proposals',
    'writes',
    'rereads',
  ], label);
  if (envelope.caseId !== caseId) fail(`${label} case mismatch`);
  if (envelope.runId !== context.runId || envelope.preflightDigest !== context.preflightDigest) {
    fail(`${label} run binding mismatch`);
  }
  if (envelope.stage !== stage) fail(`${label} stage mismatch`);
  const missionStartedAt = parseInstant(envelope.startedAt, `${label} startedAt`).epochMs;
  const missionCompletedAt = parseInstant(envelope.completedAt, `${label} completedAt`).epochMs;
  if (missionStartedAt < runStartMs || missionCompletedAt > runEndMs || missionCompletedAt < missionStartedAt) {
    fail(`${label} lies outside the run window`);
  }
  const missionId = boundedString(envelope.missionId, `${label} missionId`, 128);
  if (seenMissionIds.has(missionId)) fail(`${label} missionId is duplicated`);
  seenMissionIds.add(missionId);
  const companyIdHash = boundedString(envelope.companyIdHash, `${label} companyIdHash`, 64);
  if (!SHA256.test(companyIdHash)) {
    fail(`${label} companyIdHash is invalid`);
  }
  const authorizedCompanyHashes = new Set(context.principals.map((principal) => (
    createHash('sha256').update(`${context.preflightDigest}:${principal.companyId}`).digest('hex')
  )));
  if (!authorizedCompanyHashes.has(companyIdHash)) fail(`${label} tenant is not in the principal manifest`);
  boundedString(envelope.sessionId, `${label} sessionId`, 128);
  if (envelope.transport !== transport) fail(`${label} transport mismatch`);
  if (!Array.isArray(envelope.turns) || envelope.turns.length === 0) fail(`${label} requires turns`);
  let previousContextRevision = -1;
  let previousDraftRevision = -1;
  const turnIds = new Set();
  envelope.turns.forEach((entry, index) => {
    const turn = exactRecord(
      entry,
      ['turnId', 'contextRevision', 'contextDigest', 'draftRevision', 'terminalState', 'audioFenceDigest'],
      `${label} turn ${index}`,
    );
    const turnId = boundedString(turn.turnId, `${label} turn ${index} turnId`, 128);
    if (turnIds.has(turnId)) fail(`${label} turnId is duplicated`);
    turnIds.add(turnId);
    const contextRevision = safeCount(turn.contextRevision, `${label} turn ${index} contextRevision`);
    if (contextRevision < previousContextRevision) fail(`${label} context revisions are not monotone`);
    previousContextRevision = contextRevision;
    if (!SHA256.test(boundedString(turn.contextDigest, `${label} turn ${index} contextDigest`, 64))) {
      fail(`${label} context digest is invalid`);
    }
    if (turn.terminalState !== 'completed' && turn.terminalState !== 'cancelled') {
      fail(`${label} turn terminal state is invalid`);
    }
    if (!SHA256.test(turn.audioFenceDigest)) fail(`${label} turn audio fence digest is invalid`);
    if (turn.draftRevision !== null) {
      const draftRevision = safeCount(turn.draftRevision, `${label} turn ${index} draftRevision`);
      if (draftRevision < previousDraftRevision) fail(`${label} draft revisions are not monotone`);
      previousDraftRevision = draftRevision;
    }
  });
  if (!Array.isArray(envelope.reads) || envelope.reads.length === 0) fail(`${label} requires authoritative reads`);
  const readUseCases = new Set();
  envelope.reads.forEach((entry, index) => {
    const read = exactRecord(entry, ['useCase', 'entityType', 'entityIdHash', 'snapshotHash'], `${label} read ${index}`);
    boundedString(read.useCase, `${label} read ${index} useCase`, 128);
    readUseCases.add(read.useCase);
    boundedString(read.entityType, `${label} read ${index} entityType`, 64);
    if (!SHA256.test(read.entityIdHash) || !SHA256.test(read.snapshotHash)) fail(`${label} read digest is invalid`);
  });
  if (requirements.reads.some((useCase) => !readUseCases.has(useCase))) {
    fail(`${label} does not prove every required authoritative read`);
  }
  const decisions = Array.isArray(envelope.decisions) ? envelope.decisions : fail(`${label} decisions must be an array`);
  const decisionSources = new Set();
  decisions.forEach((entry, index) => {
    const decision = exactRecord(
      entry,
      ['decisionId', 'candidateSetHash', 'choiceIdHash', 'source', 'baseRevision'],
      `${label} decision ${index}`,
    );
    boundedString(decision.decisionId, `${label} decision ${index} decisionId`, 128);
    if (!SHA256.test(decision.candidateSetHash) || !SHA256.test(decision.choiceIdHash)) {
      fail(`${label} decision digest is invalid`);
    }
    if (decision.source !== 'voice' && decision.source !== 'tap') fail(`${label} decision source is invalid`);
    safeCount(decision.baseRevision, `${label} decision ${index} baseRevision`);
    decisionSources.add(decision.source);
  });
  const proposals = Array.isArray(envelope.proposals) ? envelope.proposals : fail(`${label} proposals must be an array`);
  proposals.forEach((entry, index) => {
    const proposal = exactRecord(
      entry,
      ['proposalId', 'tool', 'argsHash', 'controlGrantId', 'audioAcknowledgementId'],
      `${label} proposal ${index}`,
    );
    boundedString(proposal.proposalId, `${label} proposal ${index} proposalId`, 128);
    boundedString(proposal.tool, `${label} proposal ${index} tool`, 128);
    if (requirements.tool !== null && proposal.tool !== requirements.tool) {
      fail(`${label} proposal tool mismatch`);
    }
    if (!SHA256.test(proposal.argsHash)) fail(`${label} proposal args digest is invalid`);
    boundedString(proposal.controlGrantId, `${label} proposal ${index} controlGrantId`, 128);
    boundedString(proposal.audioAcknowledgementId, `${label} proposal ${index} audioAcknowledgementId`, 128);
  });
  const writes = Array.isArray(envelope.writes) ? envelope.writes : fail(`${label} writes must be an array`);
  const rereads = Array.isArray(envelope.rereads) ? envelope.rereads : fail(`${label} rereads must be an array`);
  const rereadKeys = new Set();
  rereads.forEach((entry, index) => {
    const reread = exactRecord(entry, ['entityType', 'entityIdHash', 'snapshotHash'], `${label} reread ${index}`);
    boundedString(reread.entityType, `${label} reread ${index} entityType`, 64);
    if (!SHA256.test(reread.entityIdHash) || !SHA256.test(reread.snapshotHash)) fail(`${label} reread digest is invalid`);
    rereadKeys.add(`${reread.entityType}:${reread.entityIdHash}:${reread.snapshotHash}`);
  });
  const journalRuns = new Set();
  const writeUseCases = new Set();
  writes.forEach((entry, index) => {
    const write = exactRecord(
      entry,
      ['useCase', 'entityType', 'entityIdHash', 'idempotencyKeyHash', 'beforeHash', 'afterHash', 'journalRunId'],
      `${label} write ${index}`,
    );
    boundedString(write.useCase, `${label} write ${index} useCase`, 128);
    writeUseCases.add(write.useCase);
    boundedString(write.entityType, `${label} write ${index} entityType`, 64);
    if (!SHA256.test(write.entityIdHash) || !SHA256.test(write.afterHash)) fail(`${label} write digest is invalid`);
    if (write.beforeHash !== null && !SHA256.test(write.beforeHash)) fail(`${label} beforeHash is invalid`);
    if (write.idempotencyKeyHash !== null && !SHA256.test(write.idempotencyKeyHash)) {
      fail(`${label} idempotencyKeyHash is invalid`);
    }
    if (write.idempotencyKeyHash === null) fail(`${label} mutating write lacks idempotency proof`);
    const journalRunId = boundedString(write.journalRunId, `${label} write ${index} journalRunId`, 128);
    if (journalRuns.has(journalRunId)) fail(`${label} journal run is duplicated`);
    journalRuns.add(journalRunId);
    if (!rereadKeys.has(`${write.entityType}:${write.entityIdHash}:${write.afterHash}`)) {
      fail(`${label} write is not proven by an exact reread`);
    }
  });
  const readOnly = caseId === 'home-briefing';
  if (readOnly && (writes.length !== 0 || proposals.length !== 0)) fail(`${label} must remain read-only`);
  if (!readOnly && caseId !== 'interruption-resume' && writes.length === 0) fail(`${label} requires a proven write`);
  if (requirements.write !== null && !writeUseCases.has(requirements.write)) fail(`${label} write use case mismatch`);
  if (caseId === 'interruption-resume') {
    if (envelope.turns.length < 2) fail(`${label} requires at least two fenced turns`);
    if (envelope.turns[0].terminalState !== 'cancelled' || envelope.turns.at(-1).terminalState !== 'completed') {
      fail(`${label} must prove a cancelled turn followed by a completed turn`);
    }
    if (new Set(envelope.turns.map((turn) => turn.audioFenceDigest)).size !== envelope.turns.length) {
      fail(`${label} audio fences must be unique per turn`);
    }
  }
  return decisionSources;
}

function validateMissionProofs(context, proofsInput, runStartMs, runEndMs) {
  const { configuration } = context;
  const proofs = exactRecord(proofsInput, BOB_LIVE_JARVIS_MISSIONS, 'mission proofs');
  const transport = configuration.pass;
  const stages = configurationStageNames(configuration.profile.liveStages);
  const minimum = configuration.runKind === 'certification'
    ? Math.max(stages.length, 10, configuration.profile.population / 10)
    : stages.length;
  const seenMissionIds = new Set();
  const coverage = {};
  for (const caseId of BOB_LIVE_JARVIS_MISSIONS) {
    const envelopes = proofs[caseId];
    if (!Array.isArray(envelopes) || envelopes.length < minimum) fail(`mission ${caseId} lacks proof coverage`);
    const sources = new Set();
    const coveredStages = new Set();
    envelopes.forEach((envelope) => {
      for (const source of validateMissionEnvelope(
        context,
        envelope,
        caseId,
        envelope.stage,
        runStartMs,
        runEndMs,
        seenMissionIds,
      )) sources.add(source);
      coveredStages.add(envelope.stage);
    });
    const parityRequired = caseId !== 'home-briefing' && caseId !== 'interruption-resume';
    coverage[caseId] = envelopes.length >= minimum
      && stages.every((stage) => coveredStages.has(stage))
      && (!parityRequired || (sources.has('voice') && sources.has('tap')));
  }
  return coverage;
}

function validateFailureProofs(failuresInput, runStartMs, runEndMs) {
  const failures = exactRecord(failuresInput, BOB_LIVE_FAILURE_SCENARIOS, 'failure proofs');
  const checks = {};
  for (const scenario of BOB_LIVE_FAILURE_SCENARIOS) {
    const proof = exactRecord(
      failures[scenario],
      ['scenario', 'injectedAt', 'recoveredAt', 'boundedImpactCount', 'unboundedImpactCount', 'evidenceDigest'],
      `failure ${scenario}`,
    );
    if (proof.scenario !== scenario) fail(`failure ${scenario} name mismatch`);
    const injectedAt = parseInstant(proof.injectedAt, `failure ${scenario} injectedAt`).epochMs;
    const recoveredAt = parseInstant(proof.recoveredAt, `failure ${scenario} recoveredAt`).epochMs;
    if (injectedAt < runStartMs || recoveredAt > runEndMs || recoveredAt < injectedAt) {
      fail(`failure ${scenario} timestamps are outside the run`);
    }
    safeCount(proof.boundedImpactCount, `failure ${scenario} boundedImpactCount`);
    const unbounded = safeCount(proof.unboundedImpactCount, `failure ${scenario} unboundedImpactCount`);
    if (!SHA256.test(proof.evidenceDigest)) fail(`failure ${scenario} evidence digest is invalid`);
    checks[scenario] = unbounded === 0;
  }
  return checks;
}

function validateHttpLatencyEvidence(
  latency,
  outcomes,
  workload,
  runStartMs,
  runEndMs,
) {
  if (!Array.isArray(latency.httpOperations)) fail('HTTP operations must be an array');
  if (latency.httpOperations.length !== outcomes.requestCount) {
    fail('HTTP operation count must match every attempted outcome');
  }
  const operationIds = new Set();
  const statusCounts = {
    success: 0,
    'expected-rejection': 0,
    'unexpected-4xx': 0,
    'unexpected-429': 0,
    timeout: 0,
    'http-5xx': 0,
    'protocol-error': 0,
    cancelled: 0,
    'silent-error': 0,
    'missing-result': 0,
  };
  const trafficCounts = Object.fromEntries(Object.keys(BOB_LIVE_TRAFFIC_MIX).map((key) => [key, 0]));
  const httpMs = [];
  for (let index = 0; index < latency.httpOperations.length; index += 1) {
    const operation = exactRecord(latency.httpOperations[index], [
      'operationId',
      'trafficClass',
      'stage',
      'startedAt',
      'completedAt',
      'statusKind',
    ], `HTTP operation ${index}`);
    const operationId = boundedString(operation.operationId, `HTTP operation ${index} operationId`, 128);
    if (operationIds.has(operationId)) fail('HTTP operationId is duplicated');
    operationIds.add(operationId);
    if (!Object.hasOwn(trafficCounts, operation.trafficClass)) fail(`HTTP operation ${index} traffic class is invalid`);
    const allowedStages = ['mixed', 'fault', ...configurationStageNames(workload.liveStages)];
    if (!allowedStages.includes(operation.stage)) fail(`HTTP operation ${index} stage is invalid`);
    if (!Object.hasOwn(statusCounts, operation.statusKind)) fail(`HTTP operation ${index} status kind is invalid`);
    const startedAt = parseInstant(operation.startedAt, `HTTP operation ${index} startedAt`).epochMs;
    const completedAt = parseInstant(operation.completedAt, `HTTP operation ${index} completedAt`).epochMs;
    if (startedAt < runStartMs || completedAt > runEndMs || completedAt < startedAt) {
      fail(`HTTP operation ${index} lies outside the run window`);
    }
    httpMs.push(completedAt - startedAt);
    trafficCounts[operation.trafficClass] += 1;
    statusCounts[operation.statusKind] += 1;
  }
  const expectedStatusCounts = {
    success: outcomes.successCount,
    'expected-rejection': outcomes.expectedRejectionCount,
    'unexpected-4xx': outcomes.unexpectedHttp4xxCount,
    'unexpected-429': outcomes.unexpectedRateLimitCount,
    timeout: outcomes.timeoutCount,
    'http-5xx': outcomes.http5xxCount,
    'protocol-error': outcomes.protocolErrorCount,
    cancelled: outcomes.cancelledCount,
    'silent-error': outcomes.silentErrorCount,
    'missing-result': outcomes.missingResultCount,
  };
  for (const [status, expected] of Object.entries(expectedStatusCounts)) {
    if (statusCounts[status] !== expected) fail(`HTTP status accounting mismatch for ${status}`);
  }
  for (const [trafficClass, expected] of Object.entries(workload.trafficCounts)) {
    if (trafficCounts[trafficClass] !== expected) fail(`HTTP traffic accounting mismatch for ${trafficClass}`);
  }
  const expectedRejectionIds = new Set(outcomes.expectedRejections.map((entry) => entry.operationId));
  const observedRejectionIds = new Set(latency.httpOperations
    .filter((entry) => entry.statusKind === 'expected-rejection')
    .map((entry) => entry.operationId));
  if (
    expectedRejectionIds.size !== observedRejectionIds.size
    || [...expectedRejectionIds].some((operationId) => !observedRejectionIds.has(operationId))
  ) fail('expected rejection receipts do not match HTTP operations');

  if (!Array.isArray(latency.criticalWrites)) fail('critical writes must be an array');
  if (latency.criticalWrites.length !== workload.trafficCounts.confirmedFinancialMutation) {
    fail('critical-write evidence must match financial mutations one-to-one');
  }
  const criticalOperationIds = new Set();
  const criticalWriteMs = latency.criticalWrites.map((entry, index) => {
    const write = exactRecord(
      entry,
      ['operationId', 'startedAt', 'completedAt'],
      `critical write ${index}`,
    );
    const operationId = boundedString(write.operationId, `critical write ${index} operationId`, 128);
    if (criticalOperationIds.has(operationId) || !operationIds.has(operationId)) {
      fail('critical write must reference one unique measured HTTP operation');
    }
    const httpOperation = latency.httpOperations.find((operation) => operation.operationId === operationId);
    if (httpOperation?.trafficClass !== 'confirmedFinancialMutation') {
      fail('critical write must reference a confirmed financial mutation');
    }
    criticalOperationIds.add(operationId);
    const startedAt = parseInstant(write.startedAt, `critical write ${index} startedAt`).epochMs;
    const completedAt = parseInstant(write.completedAt, `critical write ${index} completedAt`).epochMs;
    if (startedAt < runStartMs || completedAt > runEndMs || completedAt < startedAt) {
      fail(`critical write ${index} lies outside the run window`);
    }
    return completedAt - startedAt;
  });
  return { httpMs, criticalWriteMs };
}

function configurationStageNames(stages) {
  return stages.map((stage) => `live-${stage}`);
}

/** Evaluate one fully-bound run. A run verdict can never authorize public capacity claims alone. */
export function evaluateBobLiveLoadEvidence(context, evidenceInput) {
  if (!VALIDATED_RUN_CONTEXTS.has(context)) fail('load evidence requires the mandatory preflight context');
  if (CONSUMED_RUN_CONTEXTS.has(context)) fail('load evidence context has already been consumed');
  CONSUMED_RUN_CONTEXTS.add(context);
  const { configuration } = context;
  const evidence = exactRecord(evidenceInput, [
    'contractVersion',
    'runId',
    'preflightDigest',
    'profileId',
    'pass',
    'runKind',
    'attempt',
    'releaseSha',
    'startedAt',
    'completedAt',
    'rawEvidenceSha256',
    'topology',
    'workload',
    'outcomes',
    'latency',
    'resources',
    'safety',
    'missionProofs',
    'failureProofs',
  ], 'load evidence');
  if (evidence.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION) fail('load evidence contract mismatch');
  if (evidence.runId !== context.runId || evidence.preflightDigest !== context.preflightDigest) fail('load evidence preflight mismatch');
  if (evidence.profileId !== configuration.profileId || evidence.pass !== configuration.pass) fail('load evidence profile or pass mismatch');
  if (evidence.runKind !== configuration.runKind || evidence.attempt !== configuration.attempt) fail('load evidence run identity mismatch');
  if (evidence.releaseSha !== configuration.expectedReleaseSha) fail('load evidence release mismatch');
  if (!SHA256.test(evidence.rawEvidenceSha256)) fail('raw evidence digest is invalid');
  const started = parseInstant(evidence.startedAt, 'load evidence startedAt');
  const completed = parseInstant(evidence.completedAt, 'load evidence completedAt');
  const preparedAt = Date.parse(context.preparedAt);
  const now = Date.now();
  if (
    started.epochMs < preparedAt - 5_000
    || started.epochMs > preparedAt + 5 * 60_000
    || completed.epochMs < started.epochMs
    || completed.epochMs > now + 30_000
    || completed.epochMs > Date.parse(context.manifestSummary.expiresAt)
  ) fail('load evidence run window is invalid');
  const outcomes = validateOutcomes(evidence.outcomes);
  const workload = validateWorkload(configuration, evidence.workload, outcomes.requestCount);
  if (completed.epochMs - started.epochMs < workload.requiredTotalSeconds * 1_000) {
    fail('load evidence wall-clock duration is too short');
  }
  const topology = validateTopology(context, evidence.topology, started.epochMs, completed.epochMs);
  const latency = exactRecord(evidence.latency, ['httpOperations', 'criticalWrites', 'acousticStages'], 'latency');
  const measuredLatency = validateHttpLatencyEvidence(
    latency,
    outcomes,
    evidence.workload,
    started.epochMs,
    completed.epochMs,
  );
  const httpSamples = finiteSamples(measuredLatency.httpMs, 'httpMs');
  const criticalWriteSamples = finiteSamples(measuredLatency.criticalWriteMs, 'criticalWriteMs');
  const httpP95 = percentile(httpSamples, 0.95, 'httpMs');
  const httpP99 = percentile(httpSamples, 0.99, 'httpMs');
  const criticalWriteP95 = percentile(criticalWriteSamples, 0.95, 'criticalWriteMs');
  const criticalWriteP99 = percentile(criticalWriteSamples, 0.99, 'criticalWriteMs');
  const acoustics = validateBobLiveAcousticEvidence(
    configuration,
    latency.acousticStages,
    started.epochMs,
    completed.epochMs,
  );
  const resources = validateResources(
    evidence.resources,
    workload.requiredLoadCoverageSeconds,
    started.epochMs,
    completed.epochMs,
  );
  const safety = exactRecord(evidence.safety, [
    'tenantLeakCount',
    'ghostMutationCount',
    'doubleMutationCount',
    'lostControlCount',
    'cancelledAudioResumeCount',
  ], 'safety');
  Object.entries(safety).forEach(([name, value]) => safeCount(value, `safety ${name}`));
  const missionChecks = validateMissionProofs(
    context,
    evidence.missionProofs,
    started.epochMs,
    completed.epochMs,
  );
  const failureChecks = validateFailureProofs(evidence.failureProofs, started.epochMs, completed.epochMs);
  const checks = Object.freeze({
    profile: Object.values(workload.mixChecks).every(Boolean),
    topology: topology.sourceShards && topology.declaredMargin,
    httpLatency: httpP95 <= BOB_LIVE_LOAD_SLO.http.p95Ms && httpP99 <= BOB_LIVE_LOAD_SLO.http.p99Ms,
    criticalWriteLatency:
      criticalWriteP95 <= BOB_LIVE_LOAD_SLO.criticalWrite.p95Ms
      && criticalWriteP99 <= BOB_LIVE_LOAD_SLO.criticalWrite.p99Ms,
    errors: outcomes.errorRate <= BOB_LIVE_LOAD_SLO.maxErrorRate,
    liveSetup: outcomes.liveSetupRate >= BOB_LIVE_LOAD_SLO.minLiveSetupRate,
    resources: resources.passed,
    margin: workload.measuredMarginPercent >= BOB_LIVE_LOAD_SLO.minimumMeasuredMarginPercent,
    safety: Object.values(safety).every((value) => value === 0),
    missions: Object.values(missionChecks).every(Boolean),
    failures: Object.values(failureChecks).every(Boolean),
    acoustics: acoustics === null || acoustics.stages.every((stage) => (
      stage.firstAudioP50Ms <= BOB_LIVE_LOAD_SLO.firstAudio.p50Ms
      && stage.firstAudioP95Ms <= BOB_LIVE_LOAD_SLO.firstAudio.p95Ms
      && stage.bargeInP50Ms <= BOB_LIVE_LOAD_SLO.bargeIn.p50Ms
      && stage.bargeInP95Ms <= BOB_LIVE_LOAD_SLO.bargeIn.p95Ms
    )),
  });
  const runPassed = Object.values(checks).every(Boolean);
  return Object.freeze({
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    runId: context.runId,
    preflightDigest: context.preflightDigest,
    rawEvidenceSha256: evidence.rawEvidenceSha256,
    profileId: configuration.profileId,
    pass: configuration.pass,
    runKind: configuration.runKind,
    attempt: configuration.attempt,
    releaseSha: configuration.expectedReleaseSha,
    topologyDigest: topology.digest,
    startedAt: started.raw,
    completedAt: completed.raw,
    metrics: Object.freeze({
      requestCount: outcomes.requestCount,
      httpP95Ms: httpP95,
      httpP99Ms: httpP99,
      criticalWriteP95Ms: criticalWriteP95,
      criticalWriteP99Ms: criticalWriteP99,
      errorRate: outcomes.errorRate,
      liveSetupRate: outcomes.liveSetupRate,
      measuredMarginPercent: workload.measuredMarginPercent,
      resources,
      acoustics,
    }),
    checks,
    runPassed,
  });
}

function validateRunSeries(runs, expectedPass, profileId, releaseSha) {
  if (!Array.isArray(runs) || runs.length !== 3) fail(`${expectedPass} publication requires exactly three runs`);
  const attempts = new Set();
  const runIds = new Set();
  const evidenceDigests = new Set();
  const topologyDigests = new Set();
  for (const run of runs) {
    const verdict = record(run, `${expectedPass} run verdict`);
    if (
      verdict.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION
      || verdict.profileId !== profileId
      || verdict.releaseSha !== releaseSha
      || verdict.pass !== expectedPass
      || verdict.runKind !== 'certification'
      || verdict.runPassed !== true
    ) fail(`${expectedPass} run verdict is ineligible`);
    safeCount(verdict.attempt, `${expectedPass} attempt`, 3);
    if (verdict.attempt < 1) fail(`${expectedPass} attempt is invalid`);
    if (!UUID.test(verdict.runId) || !SHA256.test(verdict.rawEvidenceSha256) || !SHA256.test(verdict.topologyDigest)) {
      fail(`${expectedPass} run identity is invalid`);
    }
    if (attempts.has(verdict.attempt) || runIds.has(verdict.runId) || evidenceDigests.has(verdict.rawEvidenceSha256)) {
      fail(`${expectedPass} runs must be independent`);
    }
    attempts.add(verdict.attempt);
    runIds.add(verdict.runId);
    evidenceDigests.add(verdict.rawEvidenceSha256);
    topologyDigests.add(verdict.topologyDigest);
  }
  if (attempts.size !== 3 || !attempts.has(1) || !attempts.has(2) || !attempts.has(3)) {
    fail(`${expectedPass} runs must cover attempts 1, 2 and 3`);
  }
  if (topologyDigests.size !== 1) fail(`${expectedPass} topology changed between attempts`);
  return { runIds, evidenceDigests, topologyDigest: [...topologyDigests][0] };
}

/**
 * Derive an untrusted aggregate projection. It is intentionally non-publishable; the publication
 * module must verify signed source envelopes and brand the projection before any final signature.
 */
export function deriveBobLivePublicationCandidateProjection(input) {
  const evidence = exactRecord(input, [
    'contractVersion',
    'profileId',
    'releaseSha',
    'prerequisites',
    'previousCohortCertificate',
    'deterministicRuns',
    'gptRealtimeRuns',
    'monitoring',
  ], 'publication evidence');
  if (evidence.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION) fail('publication contract mismatch');
  if (!BOB_LIVE_LOAD_PROFILES[evidence.profileId]) fail('publication profile is invalid');
  if (!SHA.test(evidence.releaseSha)) fail('publication release SHA is invalid');
  if (evidence.profileId === 'cohort-100') {
    if (evidence.previousCohortCertificate !== null) fail('cohort-100 cannot claim a previous cohort');
  } else {
    const previous = exactRecord(evidence.previousCohortCertificate, [
      'contractVersion',
      'profileId',
      'releaseSha',
      'publicationEligible',
      'certificateDigest',
    ], 'previous cohort certificate');
    if (
      previous.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION
      || previous.profileId !== 'cohort-100'
      || previous.releaseSha !== evidence.releaseSha
      || previous.publicationEligible !== true
      || !SHA256.test(previous.certificateDigest)
    ) fail('cohort-1000 requires the completed cohort-100 certificate on the same release');
  }
  const prerequisites = exactRecord(
    evidence.prerequisites,
    ['c1Certified', 'c2Certified', 'providerChanged', 'c4Certified'],
    'publication prerequisites',
  );
  const deterministic = validateRunSeries(
    evidence.deterministicRuns,
    'deterministic',
    evidence.profileId,
    evidence.releaseSha,
  );
  const gpt = validateRunSeries(
    evidence.gptRealtimeRuns,
    'gpt-realtime',
    evidence.profileId,
    evidence.releaseSha,
  );
  const allRunIds = new Set([...deterministic.runIds, ...gpt.runIds]);
  const allEvidenceDigests = new Set([...deterministic.evidenceDigests, ...gpt.evidenceDigests]);
  if (allRunIds.size !== 6 || allEvidenceDigests.size !== 6) fail('all six runs must be independent');
  if (deterministic.topologyDigest !== gpt.topologyDigest) fail('deterministic and GPT topology must match');
  const monitoring = exactRecord(evidence.monitoring, [
    'startedAt',
    'completedAt',
    'sampleIntervalSeconds',
    'sampleCount',
    'sloViolationCount',
    'securityIncidentCount',
    'unresolvedAlertCount',
    'evidenceDigest',
  ], 'publication monitoring');
  const monitoringStarted = parseInstant(monitoring.startedAt, 'monitoring startedAt');
  const monitoringCompleted = parseInstant(monitoring.completedAt, 'monitoring completedAt');
  const sevenDaysMs = 7 * 24 * 60 * 60_000;
  const interval = safeCount(monitoring.sampleIntervalSeconds, 'monitoring sample interval', 300);
  if (interval < 1 || monitoringCompleted.epochMs - monitoringStarted.epochMs < sevenDaysMs) {
    fail('publication monitoring must cover at least seven days');
  }
  const expectedSamples = Math.floor((monitoringCompleted.epochMs - monitoringStarted.epochMs) / (interval * 1_000));
  const sampleCount = safeCount(monitoring.sampleCount, 'monitoring sampleCount');
  if (sampleCount < Math.floor(expectedSamples * 0.95)) fail('publication monitoring coverage is incomplete');
  const sloViolations = safeCount(monitoring.sloViolationCount, 'monitoring sloViolationCount');
  const securityIncidents = safeCount(monitoring.securityIncidentCount, 'monitoring securityIncidentCount');
  const unresolvedAlerts = safeCount(monitoring.unresolvedAlertCount, 'monitoring unresolvedAlertCount');
  if (!SHA256.test(monitoring.evidenceDigest)) fail('monitoring evidence digest is invalid');
  const checks = Object.freeze({
    c1: prerequisites.c1Certified === true,
    c2: prerequisites.c2Certified === true,
    c4: prerequisites.providerChanged !== true || prerequisites.c4Certified === true,
    runs: true,
    monitoring: sloViolations === 0 && securityIncidents === 0 && unresolvedAlerts === 0,
  });
  const candidateEligible = Object.values(checks).every(Boolean);
  const candidateDigest = createHash('sha256').update(JSON.stringify({
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    profileId: evidence.profileId,
    releaseSha: evidence.releaseSha,
    runIds: [...allRunIds].sort(),
    evidenceDigests: [...allEvidenceDigests].sort(),
    monitoringEvidenceDigest: monitoring.evidenceDigest,
    previousCohortCertificate: evidence.previousCohortCertificate,
    checks,
  })).digest('hex');
  return Object.freeze({
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    profileId: evidence.profileId,
    releaseSha: evidence.releaseSha,
    checks,
    candidateEligible,
    candidateDigest,
    monitoringCompletedAt: monitoringCompleted.raw,
    previousCohortCertificateDigest:
      evidence.profileId === 'cohort-1000' ? evidence.previousCohortCertificate.certificateDigest : null,
  });
}
