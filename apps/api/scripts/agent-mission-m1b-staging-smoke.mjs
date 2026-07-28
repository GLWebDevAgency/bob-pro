#!/usr/bin/env node
import { createRequire } from 'node:module';
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  certifyM1BActiveEvidence,
  certifyM1BCancellationRecoveryEvidence,
  certifyM1BCleanEvidence,
  certifyM1BFinalEvidence,
  certifyM1BNegativeFinalEvidence,
  certifyM1BStartRecoveryEvidence,
} from './agent-mission-m1b-staging-evidence.mjs';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const OPENAI_WEBRTC_DELIVERIES = new Set([
  'openai-native-webrtc-v1',
  'audited-signed-url-v1',
]);
const BOB_LIVE_AVAILABILITY_REASONS = new Set([
  'disabled',
  'not_entitled',
  'entitlement_unavailable',
]);
const SCREEN_NAME = '/devis/new';
const SCREEN_INSTANCE_ID = 'devis-new:m1b-staging';
const REQUEST_TIMEOUT_MS = 15_000;
const PEER_TIMEOUT_MS = 20_000;
const CONTEXT_STALE_ATTEMPTS = 10;
const FINAL_EVIDENCE_ATTEMPTS = 12;
const MAX_RESPONSE_BYTES = 128 * 1024;

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-smoke:${message}`);
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function required(environment, name, { minimum = 1, maximum = 8_192 } = {}) {
  const value = environment[name];
  if (
    typeof value !== 'string'
    || value.length < minimum
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function canonicalHttpsOrigin(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be a valid URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.origin !== value
  ) {
    fail(`${name} must be a credential-free HTTPS origin`);
  }
  return parsed.origin;
}

export function parseM1BStagingSmokeEnvironment(environment = process.env) {
  const userId = required(environment, 'BOB_M1B_STAGING_USER_ID', { maximum: 80 });
  const companyId = required(environment, 'BOB_M1B_STAGING_COMPANY_ID', { maximum: 64 });
  const email = required(environment, 'BOB_M1B_STAGING_ACCOUNT_EMAIL', { maximum: 320 });
  if (!UUID.test(userId)) fail('BOB_M1B_STAGING_USER_ID must be a UUID');
  if (!COMPANY_ID.test(companyId)) fail('BOB_M1B_STAGING_COMPANY_ID is invalid');
  if (!EMAIL.test(email)) fail('BOB_M1B_STAGING_ACCOUNT_EMAIL is invalid');
  return Object.freeze({
    apiBaseUrl: canonicalHttpsOrigin(required(environment, 'API_BASE_URL'), 'API_BASE_URL'),
    supabaseUrl: canonicalHttpsOrigin(
      required(environment, 'SUPABASE_URL'),
      'SUPABASE_URL',
    ),
    supabaseAnonKey: required(environment, 'BOB_M1B_STAGING_SUPABASE_ANON_KEY', {
      minimum: 16,
      maximum: 8_192,
    }),
    email,
    password: required(environment, 'BOB_M1B_STAGING_ACCOUNT_PASSWORD', {
      minimum: 8,
      maximum: 1_024,
    }),
    userId,
    companyId,
  });
}

function decodeBase64UrlJson(segment, name) {
  if (
    typeof segment !== 'string'
    || segment.length < 2
    || segment.length > 16_384
    || !JWT_SEGMENT.test(segment)
  ) {
    fail(`${name} is malformed`);
  }
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (record(parsed) === null) fail(`${name} is malformed`);
    return parsed;
  } catch {
    fail(`${name} is malformed`);
  }
}

export function validateM1BStagingAccessToken(token, config, now = Date.now()) {
  if (
    typeof token !== 'string'
    || token.length < 32
    || token.length > 16_384
    || /[\u0000-\u0020\u007f]/u.test(token)
  ) {
    fail('Supabase access token is malformed');
  }
  const segments = token.split('.');
  if (segments.length !== 3) fail('Supabase access token is malformed');
  const payload = decodeBase64UrlJson(segments[1], 'Supabase JWT payload');
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const metadata = record(payload.app_metadata);
  if (
    payload.sub !== config.userId
    || !audience.includes('authenticated')
    || metadata?.company_id !== config.companyId
    || !Number.isSafeInteger(payload.exp)
    || payload.exp * 1_000 <= now + 30_000
  ) {
    fail('Supabase JWT identity or expiry does not match the dedicated account');
  }
  return token;
}

async function readBoundedJson(response, operation) {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    fail(`${operation} returned an oversized response`);
  }
  try {
    const parsed = JSON.parse(body);
    if (record(parsed) === null) fail(`${operation} returned invalid JSON`);
    return parsed;
  } catch {
    fail(`${operation} returned invalid JSON`);
  }
}

async function fetchWithTimeout(url, init, dependencies, operation) {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') fail('fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImplementation(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    fail(`${operation} request failed`);
  } finally {
    clearTimeout(timer);
  }
}

export async function authenticateM1BStagingAccount(
  config,
  dependencies = {},
) {
  const response = await fetchWithTimeout(
    `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: config.email,
        password: config.password,
      }),
    },
    dependencies,
    'Supabase password grant',
  );
  if (!response.ok) fail('Supabase password grant was refused');
  const body = await readBoundedJson(response, 'Supabase password grant');
  const user = record(body.user);
  const metadata = record(user?.app_metadata);
  if (
    user?.id !== config.userId
    || metadata?.company_id !== config.companyId
  ) {
    fail('Supabase password grant returned another account');
  }
  return Object.freeze({
    accessToken: validateM1BStagingAccessToken(body.access_token, config),
  });
}

const OPERATION_ERROR_FIELDS = Object.freeze([
  'kind',
  'port',
  'cause',
  'service',
  'reason',
  'entity',
  'retryAt',
  'retryAfterSeconds',
]);
const OPERATION_ERROR_VALUE_MAX_LENGTH = 120;

/**
 * Doctrine « échec VISIBLE » : sérialise les seuls champs scalaires bornés de l'AppError
 * structurée (kind, port, cause, retryAt…) — jamais de payload libre ni d'identité.
 */
export function describeM1BOperationFailure(error) {
  const structured = record(error);
  if (structured === null) return 'error=unstructured';
  const parts = [];
  for (const field of OPERATION_ERROR_FIELDS) {
    const value = structured[field];
    if (typeof value === 'string' && value.length > 0) {
      const bounded = value.length > OPERATION_ERROR_VALUE_MAX_LENGTH
        ? `${value.slice(0, OPERATION_ERROR_VALUE_MAX_LENGTH)}…`
        : value;
      parts.push(`${field}=${JSON.stringify(bounded)}`);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${field}=${value}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : 'error=unstructured';
}

function expectSuccess(result, operation) {
  if (record(result) === null || result.ok !== true || !Object.hasOwn(result, 'value')) {
    // Publier la cause structurée sur stderr AVANT le fail au lieu de l'avaler : un smoke qui
    // échoue doit dire pourquoi (kind, port, cause, retryAt…) comme toute certification.
    process.stderr.write(
      `agent-mission-m1b-staging-smoke:${operation} failed ${
        describeM1BOperationFailure(record(result)?.error)
      }\n`,
    );
    fail(`${operation} failed`);
  }
  return result.value;
}

function expectUuid(value, operation) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${operation} returned an invalid UUID`);
  return value;
}

function expectPositiveInteger(value, operation, allowZero = false) {
  if (
    !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)
    || value > 2_147_483_647
  ) {
    fail(`${operation} returned an invalid revision`);
  }
  return value;
}

function expectConfig(config) {
  if (record(config) === null) fail('Bob Live staging configuration response is invalid');
  if (config.available !== true) {
    const reason = BOB_LIVE_AVAILABILITY_REASONS.has(config.availabilityReason)
      ? config.availabilityReason
      : 'unknown';
    fail(`Bob Live staging account is unavailable (reason=${reason})`);
  }
  if (config.transport !== 'webrtc') {
    fail('Bob Live staging configuration uses an unsupported transport');
  }
  if (!OPENAI_WEBRTC_DELIVERIES.has(config.speechDelivery)) {
    fail('Bob Live staging configuration uses an unsupported speech delivery');
  }
  if (
    typeof config.configVersion !== 'string'
    || config.configVersion.length < 1
    || typeof config.model !== 'string'
    || config.model.length < 1
    || (config.voice !== 'marin' && config.voice !== 'cedar')
    || !Number.isSafeInteger(config.maxSessionSeconds)
    || config.maxSessionSeconds < 1
  ) {
    fail('Bob Live staging configuration contract is invalid');
  }
  return config;
}

async function readAuthenticatedApiJson(
  config,
  accessToken,
  path,
  dependencies,
  operation,
) {
  const response = await fetchWithTimeout(
    `${config.apiBaseUrl}${path}`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    },
    dependencies,
    operation,
  );
  if (!response.ok) fail(`${operation} was refused`);
  return readBoundedJson(response, operation);
}

/**
 * Précondition réseau volontairement autonome : aucun package buildé ni installation pnpm.
 * Le workflow l'exécute avant toute étape coûteuse afin qu'un compte mal provisionné ne soit
 * découvert ni après un build, ni après un déploiement. Le résultat n'expose aucun identifiant.
 */
export async function preflightM1BStagingAccount(
  environment = process.env,
  dependencies = {},
) {
  const config = parseM1BStagingSmokeEnvironment(environment);
  const authentication = typeof dependencies.authenticate === 'function'
    ? await dependencies.authenticate(config)
    : await authenticateM1BStagingAccount(config, dependencies);
  if (record(authentication) === null || typeof authentication.accessToken !== 'string') {
    fail('staging authentication adapter returned no access token');
  }
  const accessToken = validateM1BStagingAccessToken(
    authentication.accessToken,
    config,
    dependencies.now?.() ?? Date.now(),
  );
  const company = await readAuthenticatedApiJson(
    config,
    accessToken,
    '/company/me',
    dependencies,
    'staging company preflight',
  );
  if (company.id !== config.companyId) {
    fail('the authenticated API company does not match the dedicated account');
  }
  const realtime = expectConfig(await readAuthenticatedApiJson(
    config,
    accessToken,
    '/voice/realtime/config',
    dependencies,
    'Bob Live staging preflight',
  ));
  return Object.freeze({
    mode: 'preflight',
    passed: true,
    account: 'eligible',
    transport: realtime.transport,
    speechDelivery: realtime.speechDelivery,
  });
}

function expectCall(call, config, sessionHandle) {
  if (
    record(call) === null
    || call.transport !== 'webrtc'
    || call.sessionHandle !== sessionHandle
    || call.configVersion !== config.configVersion
    || call.model !== config.model
    || call.voice !== config.voice
    || call.maxSessionSeconds !== config.maxSessionSeconds
    || call.speechDelivery !== config.speechDelivery
    || typeof call.answerSdp !== 'string'
    || call.answerSdp.length < 64
    || !Number.isFinite(Date.parse(call.hardExpiresAt))
    || Date.parse(call.hardExpiresAt) <= Date.now()
    || !Object.hasOwn(call, 'agentMissionSession')
  ) {
    fail('Bob Live bootstrap response does not match the requested WebRTC session');
  }
  return call;
}

function expectCleanDraft(value, isMeaningfulQuoteDraftPayload, expectedSessionId = null) {
  if (value === null) {
    if (expectedSessionId !== null) fail('the owned quote draft disappeared before cleanup');
    return null;
  }
  if (
    record(value) === null
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || record(value.payload) === null
    || record(value.payload.draft) === null
    || typeof value.payload.draft.sessionId !== 'string'
    || (
      expectedSessionId !== null
      && value.payload.draft.sessionId !== expectedSessionId
    )
    || isMeaningfulQuoteDraftPayload(value.payload) !== false
  ) {
    fail('the quote draft is preexisting, foreign, or contains meaningful user data');
  }
  return value;
}

function expectStart(start, responseLossRetry) {
  const mission = record(start?.mission);
  const draft = record(mission?.payload)?.draft;
  if (
    (
      start?.outcome !== 'created'
      && !(responseLossRetry && start?.outcome === 'replayed')
    )
    || start?.startOutcome !== 'no_slot'
    || mission === null
    || mission.status !== 'active'
    || mission.actionable !== true
    || mission.phase !== 'awaiting_quote_screen'
    || mission.revision !== 1
    || mission.currentBinding !== null
    || record(draft) === null
    || typeof draft.sessionId !== 'string'
    || draft.sessionId.length < 1
    || draft.slotRevision !== 1
    || draft.contentRevision !== 0
  ) {
    fail('the dedicated account was not clean when the quote mission started');
  }
  expectUuid(mission.id, 'startQuoteCreation');
  return start;
}

function isExactContextStale(error) {
  return (
    record(error) !== null
    && error.kind === 'conflict'
    && error.entity === 'agent_mission_screen_ack'
    && error.reason === 'context_stale'
  );
}

function isRetryableApiDependency(error) {
  return (
    record(error) !== null
    && error.kind === 'dependency'
    && error.port === 'api'
  );
}

async function startQuoteWithResponseLossRetry(
  missionSession,
  commandId,
  environment,
  dependencies,
) {
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await missionSession.startQuoteCreation({ commandId });
    if (record(result) !== null && result.ok === true) {
      return {
        value: result.value,
        responseLossRetry: attempt > 1,
      };
    }
    if (
      record(result) === null
      || !isRetryableApiDependency(result.error)
    ) {
      fail('startQuoteCreation failed outside the response-loss retry contract');
    }
    if (attempt < 2) await sleep(150);
  }
  const certifyRecovery =
    dependencies.certifyStartRecoveryEvidence ?? certifyM1BStartRecoveryEvidence;
  const recovered = certifyRecovery({ startCommandId: commandId }, environment);
  if (
    recovered?.stage !== 'start-recovered'
    || recovered.passed !== true
    || record(recovered.mission) === null
  ) {
    fail('start response-loss recovery adapter did not return its exact receipt');
  }
  return {
    value: {
      outcome: 'replayed',
      startOutcome: 'no_slot',
      mission: recovered.mission,
    },
    responseLossRetry: true,
  };
}

async function acknowledgeScreenWithBoundedRetry(
  missionSession,
  input,
  dependencies,
) {
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= CONTEXT_STALE_ATTEMPTS; attempt += 1) {
    const result = await missionSession.acknowledgeQuoteScreen(input);
    if (record(result) !== null && result.ok === true) return result.value;
    if (
      record(result) === null
      || !isExactContextStale(result.error)
      || attempt === CONTEXT_STALE_ATTEMPTS
    ) {
      fail('screen ACK failed outside the bounded context_stale retry contract');
    }
    await sleep(Math.min(100 * 2 ** (attempt - 1), 800));
  }
  fail('screen ACK retry exhausted');
}

function expectAcknowledgement(acknowledgement, expected) {
  const mission = record(acknowledgement?.mission);
  const binding = record(mission?.currentBinding);
  if (
    acknowledgement?.outcome !== 'acknowledged'
    || mission === null
    || mission.id !== expected.missionId
    || mission.status !== 'active'
    || mission.actionable !== true
    || mission.phase !== 'awaiting_customer'
    || mission.revision !== 2
    || binding === null
    || binding.realtimeSessionId !== expected.sessionHandle
    || binding.contextRevision !== expected.contextRevision
    || binding.contextDigest !== expected.contextDigest
    || binding.screenName !== SCREEN_NAME
    || binding.screenInstanceId !== SCREEN_INSTANCE_ID
  ) {
    fail('screen ACK did not bind the exact staging screen context');
  }
  return acknowledgement;
}

function expectCancellation(
  cancellation,
  missionId,
  expectedRevision,
  responseLossRetry = false,
) {
  const mission = record(cancellation?.mission);
  if (
    (
      cancellation?.outcome !== 'cancelled'
      && !(responseLossRetry && cancellation?.outcome === 'replayed')
    )
    || mission === null
    || mission.id !== missionId
    || mission.status !== 'cancelled'
    || mission.actionable !== false
    || mission.revision !== expectedRevision
    || typeof mission.terminalAt !== 'string'
    || !Number.isFinite(Date.parse(mission.terminalAt))
  ) {
    fail('quote mission cancellation was not exact');
  }
  return cancellation;
}

async function cancelQuoteWithResponseLossRecovery(
  missionSession,
  input,
  recoveryInput,
  environment,
  dependencies,
) {
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await missionSession.cancelQuoteCreation(input);
    if (record(result) !== null && result.ok === true) {
      return {
        value: result.value,
        responseLossRetry: attempt > 1,
      };
    }
    if (
      record(result) === null
      || !isRetryableApiDependency(result.error)
    ) {
      fail('cancelQuoteCreation failed outside the response-loss retry contract');
    }
    if (attempt < 2) await sleep(150);
  }
  const certifyRecovery =
    dependencies.certifyCancellationRecoveryEvidence
    ?? certifyM1BCancellationRecoveryEvidence;
  const recovered = certifyRecovery(recoveryInput, environment);
  if (
    recovered?.stage !== 'cancellation-recovered'
    || recovered.passed !== true
    || record(recovered.mission) === null
  ) {
    fail('cancellation response-loss recovery adapter did not return its exact receipt');
  }
  return {
    value: {
      outcome: 'replayed',
      mission: recovered.mission,
    },
    responseLossRetry: true,
  };
}

async function importRuntimeDependencies() {
  const [{ HttpBobClient }, { isMeaningfulQuoteDraftPayload }] = await Promise.all([
    import(new URL('../../../packages/api-client/dist/index.js', import.meta.url)),
    import(new URL('../../../packages/core/dist/index.js', import.meta.url)),
  ]);
  if (
    typeof HttpBobClient !== 'function'
    || typeof isMeaningfulQuoteDraftPayload !== 'function'
  ) {
    fail('built Bob runtime dependencies are unavailable');
  }
  return { HttpBobClient, isMeaningfulQuoteDraftPayload };
}

async function createRuntimeClient(config, accessToken, dependencies) {
  if (typeof dependencies.createClient === 'function') {
    return dependencies.createClient(config, accessToken);
  }
  const { HttpBobClient } = await importRuntimeDependencies();
  return new HttpBobClient({
    baseUrl: config.apiBaseUrl,
    companyId: config.companyId,
    getToken: async () => accessToken,
  });
}

async function meaningfulDraftPredicate(dependencies) {
  if (typeof dependencies.isMeaningfulQuoteDraftPayload === 'function') {
    return dependencies.isMeaningfulQuoteDraftPayload;
  }
  return (await importRuntimeDependencies()).isMeaningfulQuoteDraftPayload;
}

export async function createM1BChromiumPeer(speechDelivery) {
  if (!OPENAI_WEBRTC_DELIVERIES.has(speechDelivery)) {
    fail('cannot create a peer for a non-OpenAI WebRTC delivery');
  }
  const requireFromWeb = createRequire(
    new URL('../../../apps/web/package.json', import.meta.url),
  );
  const { chromium } = requireFromWeb('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let closed = false;
  try {
    const offerSdp = await page.evaluate(async ({ nativeDownlink, timeoutMs }) => {
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const destination = audio.createMediaStreamDestination();
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error('synthetic_audio_track_missing');
      const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
      const channel = peer.createDataChannel('oai-events', { ordered: true });
      peer.addTransceiver(track, {
        direction: nativeDownlink ? 'sendrecv' : 'sendonly',
        streams: [destination.stream],
      });
      globalThis.__bobM1BPeer = {
        audio,
        oscillator,
        destination,
        track,
        peer,
        channel,
      };
      const offer = await peer.createOffer({
        offerToReceiveAudio: nativeDownlink,
        offerToReceiveVideo: false,
      });
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('ice_gathering_timeout')),
            timeoutMs,
          );
          const listener = () => {
            if (peer.iceGatheringState !== 'complete') return;
            clearTimeout(timeout);
            peer.removeEventListener('icegatheringstatechange', listener);
            resolve();
          };
          peer.addEventListener('icegatheringstatechange', listener);
        });
      }
      const sdp = peer.localDescription?.sdp;
      if (typeof sdp !== 'string' || sdp.length < 64) {
        throw new Error('offer_sdp_missing');
      }
      return sdp;
    }, {
      nativeDownlink: speechDelivery === 'openai-native-webrtc-v1',
      timeoutMs: PEER_TIMEOUT_MS,
    });

    return Object.freeze({
      offerSdp,
      async applyAnswer(answerSdp) {
        await page.evaluate(async ({ answerSdp: answer, timeoutMs }) => {
          const resources = globalThis.__bobM1BPeer;
          if (!resources) throw new Error('peer_resources_missing');
          const { peer, channel } = resources;
          await peer.setRemoteDescription({ type: 'answer', sdp: answer });
          await new Promise((resolve, reject) => {
            if (peer.connectionState === 'connected' && channel.readyState === 'open') {
              resolve();
              return;
            }
            const timeout = setTimeout(() => {
              reject(new Error('peer_connection_timeout'));
            }, timeoutMs);
            const inspect = () => {
              if (
                peer.connectionState === 'failed'
                || peer.connectionState === 'closed'
              ) {
                clearTimeout(timeout);
                reject(new Error('peer_connection_failed'));
                return;
              }
              if (
                peer.connectionState === 'connected'
                && channel.readyState === 'open'
              ) {
                clearTimeout(timeout);
                peer.removeEventListener('connectionstatechange', inspect);
                channel.removeEventListener('open', inspect);
                resolve();
              }
            };
            peer.addEventListener('connectionstatechange', inspect);
            channel.addEventListener('open', inspect);
          });
        }, { answerSdp, timeoutMs: PEER_TIMEOUT_MS });
      },
      async close() {
        if (closed) return;
        closed = true;
        await page.evaluate(async () => {
          const resources = globalThis.__bobM1BPeer;
          delete globalThis.__bobM1BPeer;
          if (!resources) return;
          try { resources.channel.close(); } catch {}
          try { resources.peer.close(); } catch {}
          try { resources.oscillator.stop(); } catch {}
          try { resources.track.stop(); } catch {}
          for (const track of resources.destination.stream.getTracks()) {
            try { track.stop(); } catch {}
          }
          try { await resources.audio.close(); } catch {}
        }).catch(() => {});
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    });
  } catch (error) {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function createPeer(config, dependencies) {
  const peer = typeof dependencies.createPeer === 'function'
    ? await dependencies.createPeer(config.speechDelivery)
    : await createM1BChromiumPeer(config.speechDelivery);
  if (
    record(peer) === null
    || typeof peer.offerSdp !== 'string'
    || peer.offerSdp.length < 64
    || typeof peer.applyAnswer !== 'function'
    || typeof peer.close !== 'function'
  ) {
    fail('WebRTC peer harness is invalid');
  }
  return peer;
}

async function authenticateAndPrepare(environment, dependencies) {
  const config = parseM1BStagingSmokeEnvironment(environment);
  const authentication = typeof dependencies.authenticate === 'function'
    ? await dependencies.authenticate(config)
    : await authenticateM1BStagingAccount(config, dependencies);
  if (record(authentication) === null || typeof authentication.accessToken !== 'string') {
    fail('staging authentication adapter returned no access token');
  }
  const accessToken = validateM1BStagingAccessToken(
    authentication.accessToken,
    config,
    dependencies.now?.() ?? Date.now(),
  );
  const client = await createRuntimeClient(config, accessToken, dependencies);
  const company = expectSuccess(await client.getCompanyMe(), 'getCompanyMe');
  if (record(company) === null || company.id !== config.companyId) {
    fail('the authenticated API company does not match the dedicated account');
  }
  const certifyClean = dependencies.certifyCleanEvidence ?? certifyM1BCleanEvidence;
  const cleanEvidence = certifyClean(environment);
  if (cleanEvidence?.stage !== 'clean' || cleanEvidence.passed !== true) {
    fail('clean runtime evidence adapter did not return its exact receipt');
  }
  return {
    config,
    client,
    isMeaningfulQuoteDraftPayload: await meaningfulDraftPredicate(dependencies),
  };
}

async function hangupAndClose(client, peer, sessionHandle, missionSession) {
  let hangupAccepted = false;
  try {
    if (sessionHandle !== null) {
      const hangup = await client.hangupRealtimeVoiceCall(sessionHandle);
      hangupAccepted = record(hangup) !== null && hangup.ok === true;
    }
  } finally {
    await peer?.close().catch(() => {});
    missionSession?.dispose();
  }
  return hangupAccepted;
}

export async function runM1BNegativeStagingSmoke(
  environment = process.env,
  dependencies = {},
) {
  const prepared = await authenticateAndPrepare(environment, dependencies);
  const { client, isMeaningfulQuoteDraftPayload } = prepared;
  const draft = expectSuccess(await client.getQuoteDraft(), 'getQuoteDraft');
  expectCleanDraft(draft, isMeaningfulQuoteDraftPayload);
  if (draft !== null) fail('the dedicated account already contains a quote draft');
  const config = expectConfig(expectSuccess(
    await client.realtimeVoiceConfig(),
    'realtimeVoiceConfig',
  ));
  const peer = await createPeer(config, dependencies);
  const sessionHandle = expectUuid(
    (dependencies.randomUUID ?? nodeRandomUUID)(),
    'randomUUID',
  );
  let call = null;
  let hangupAccepted = false;
  try {
    call = expectCall(expectSuccess(await client.createRealtimeVoiceCall({
      transport: 'webrtc',
      sdp: peer.offerSdp,
      sessionHandle,
      configVersion: config.configVersion,
      speechDelivery: config.speechDelivery,
      agentMissionProtocolVersion: 1,
    }), 'createRealtimeVoiceCall'), config, sessionHandle);
    if (call.agentMissionSession !== null) {
      fail('M1-B negotiated while the staging circuit was expected OFF');
    }
    await peer.applyAnswer(call.answerSdp);
  } finally {
    hangupAccepted = await hangupAndClose(
      client,
      peer,
      call?.sessionHandle ?? sessionHandle,
      null,
    );
  }
  const finalEvidence = await pollNegativeFinalEvidence(
    { sessionId: sessionHandle },
    environment,
    dependencies,
  );
  if (finalEvidence?.stage !== 'negative-final' || finalEvidence.passed !== true) {
    fail('negative final evidence adapter did not return its exact receipt');
  }
  return Object.freeze({
    mode: 'negative',
    passed: true,
    speechDelivery: config.speechDelivery,
    agentMission: 'off',
    cleanup: 'complete',
    hangupAccepted,
  });
}

async function pollFinalEvidence(input, environment, dependencies) {
  const certify = dependencies.certifyFinalEvidence ?? certifyM1BFinalEvidence;
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError;
  for (let attempt = 1; attempt <= FINAL_EVIDENCE_ATTEMPTS; attempt += 1) {
    try {
      return certify(input, environment);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error)
        || !error.message.includes('final runtime cleanup proof did not pass exactly')
        || attempt === FINAL_EVIDENCE_ATTEMPTS
      ) {
        throw error;
      }
      await sleep(Math.min(250 * attempt, 1_000));
    }
  }
  throw lastError;
}

async function pollNegativeFinalEvidence(input, environment, dependencies) {
  const certify =
    dependencies.certifyNegativeFinalEvidence ?? certifyM1BNegativeFinalEvidence;
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError;
  for (let attempt = 1; attempt <= FINAL_EVIDENCE_ATTEMPTS; attempt += 1) {
    try {
      return certify(input, environment);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error)
        || !error.message.includes('negative runtime cleanup proof did not pass exactly')
        || attempt === FINAL_EVIDENCE_ATTEMPTS
      ) {
        throw error;
      }
      await sleep(Math.min(250 * attempt, 1_000));
    }
  }
  throw lastError;
}

export async function runM1BPositiveStagingSmoke(
  environment = process.env,
  dependencies = {},
) {
  const prepared = await authenticateAndPrepare(environment, dependencies);
  const { client, isMeaningfulQuoteDraftPayload } = prepared;
  const existingDraft = expectSuccess(await client.getQuoteDraft(), 'getQuoteDraft');
  if (existingDraft !== null) {
    expectCleanDraft(existingDraft, isMeaningfulQuoteDraftPayload);
    fail('the dedicated account already contains a quote draft');
  }
  const config = expectConfig(expectSuccess(
    await client.realtimeVoiceConfig(),
    'realtimeVoiceConfig',
  ));
  const peer = await createPeer(config, dependencies);
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const sessionHandle = expectUuid(randomUUID(), 'sessionHandle');
  const startCommandId = expectUuid(randomUUID(), 'startCommandId');
  const ackCommandId = expectUuid(randomUUID(), 'ackCommandId');
  const cancelCommandId = expectUuid(randomUUID(), 'cancelCommandId');
  let call = null;
  let missionSession = null;
  let ownedMission = null;
  let primaryError = null;
  let activeEvidence = null;
  try {
    call = expectCall(expectSuccess(await client.createRealtimeVoiceCall({
      transport: 'webrtc',
      sdp: peer.offerSdp,
      sessionHandle,
      configVersion: config.configVersion,
      speechDelivery: config.speechDelivery,
      agentMissionProtocolVersion: 1,
    }), 'createRealtimeVoiceCall'), config, sessionHandle);
    missionSession = call.agentMissionSession;
    if (record(missionSession) === null) {
      fail('M1-B did not negotiate for the dedicated staging account');
    }
    if (
      missionSession.protocolVersion !== 1
      || missionSession.realtimeSessionId !== sessionHandle
      || missionSession.disposed !== false
    ) {
      fail('M1-B capability handle does not match the realtime session');
    }
    await peer.applyAnswer(call.answerSdp);
    const current = expectSuccess(
      await missionSession.getCurrentQuoteCreation(),
      'getCurrentQuoteCreation',
    );
    if (record(current) === null || current.mission !== null) {
      fail('the dedicated account already contains an active quote mission');
    }
    const startResult = await startQuoteWithResponseLossRetry(
      missionSession,
      startCommandId,
      environment,
      dependencies,
    );
    const start = expectStart(startResult.value, startResult.responseLossRetry);
    ownedMission = start.mission;
    const draft = expectCleanDraft(
      expectSuccess(await client.getQuoteDraft(), 'getQuoteDraft after start'),
      isMeaningfulQuoteDraftPayload,
      start.mission.payload.draft.sessionId,
    );
    if (
      draft.revision !== start.mission.payload.draft.slotRevision
      || draft.payload.draft.contentRevision !==
        start.mission.payload.draft.contentRevision
    ) {
      fail('the created draft does not match the mission draft reference');
    }
    const context = expectSuccess(await client.updateRealtimeVoiceContext(
      sessionHandle,
      {
        version: 1,
        revision: 1,
        context: {
          screen: {
            name: SCREEN_NAME,
            instanceId: SCREEN_INSTANCE_ID,
          },
          entities: [],
          capabilities: ['screen.read'],
        },
      },
    ), 'updateRealtimeVoiceContext');
    expectPositiveInteger(context.revision, 'updateRealtimeVoiceContext');
    if (
      context.revision !== 1
      || typeof context.contextDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(context.contextDigest)
    ) {
      fail('the server did not acknowledge the exact context revision');
    }
    const acknowledgement = expectAcknowledgement(
      await acknowledgeScreenWithBoundedRetry(missionSession, {
        missionId: start.mission.id,
        commandId: ackCommandId,
        expectedMissionRevision: start.mission.revision,
        contextRevision: context.revision,
        contextDigest: context.contextDigest,
        draftSessionId: start.mission.payload.draft.sessionId,
        expectedDraftSlotRevision: start.mission.payload.draft.slotRevision,
        expectedDraftContentRevision: start.mission.payload.draft.contentRevision,
      }, dependencies),
      {
        missionId: start.mission.id,
        sessionHandle,
        contextRevision: context.revision,
        contextDigest: context.contextDigest,
      },
    );
    ownedMission = acknowledgement.mission;
    const certifyActive = dependencies.certifyActiveEvidence ?? certifyM1BActiveEvidence;
    activeEvidence = certifyActive({
      missionId: acknowledgement.mission.id,
      sessionId: sessionHandle,
      startCommandId,
      ackCommandId,
      missionRevision: acknowledgement.mission.revision,
      contextRevision: context.revision,
      contextDigest: context.contextDigest,
      screenInstanceId: SCREEN_INSTANCE_ID,
      draftSessionId: start.mission.payload.draft.sessionId,
      draftSlotRevision: start.mission.payload.draft.slotRevision,
      draftContentRevision: start.mission.payload.draft.contentRevision,
    }, environment);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  let cancellation = null;
  try {
    if (ownedMission !== null && missionSession !== null) {
      let revision = ownedMission.revision;
      if (ownedMission.status === 'active') {
        const current = expectSuccess(
          await missionSession.getCurrentQuoteCreation(),
          'getCurrentQuoteCreation during cleanup',
        );
        if (
          record(current) === null
          || record(current.mission) === null
          || current.mission.id !== ownedMission.id
          || current.mission.status !== 'active'
        ) {
          fail('the owned mission cannot be identified safely during cleanup');
        }
        revision = current.mission.revision;
        const cancellationResult = await cancelQuoteWithResponseLossRecovery(
          missionSession,
          {
            missionId: ownedMission.id,
            commandId: cancelCommandId,
            expectedMissionRevision: revision,
          },
          {
            missionId: ownedMission.id,
            startCommandId,
            cancelCommandId,
            expectedMissionRevision: revision,
            draftSessionId: ownedMission.payload.draft.sessionId,
            draftContentRevision: ownedMission.payload.draft.contentRevision,
          },
          environment,
          dependencies,
        );
        cancellation = expectCancellation(
          cancellationResult.value,
          ownedMission.id,
          revision + 1,
          cancellationResult.responseLossRetry,
        );
      }
      const draft = expectCleanDraft(
        expectSuccess(await client.getQuoteDraft(), 'getQuoteDraft during cleanup'),
        isMeaningfulQuoteDraftPayload,
        ownedMission.payload.draft.sessionId,
      );
      expectSuccess(
        await client.deleteQuoteDraft(draft.revision),
        'deleteQuoteDraft',
      );
    }
  } catch (error) {
    cleanupError = error;
  }

  const hangupAccepted = await hangupAndClose(
    client,
    peer,
    call?.sessionHandle ?? sessionHandle,
    missionSession,
  );

  if (primaryError !== null || cleanupError !== null) {
    const causes = [primaryError, cleanupError].filter((error) => error !== null);
    throw causes.length === 1
      ? causes[0]
      : new AggregateError(causes, 'agent-mission-m1b-staging-smoke:operation and cleanup failed');
  }
  if (activeEvidence?.stage !== 'active' || activeEvidence.passed !== true) {
    fail('active runtime evidence adapter did not return its exact receipt');
  }
  if (cancellation === null) fail('the owned mission was not cancelled');
  const finalEvidence = await pollFinalEvidence({
    missionId: cancellation.mission.id,
    sessionId: sessionHandle,
    startCommandId,
    ackCommandId,
    cancelCommandId,
    missionRevision: cancellation.mission.revision,
  }, environment, dependencies);
  if (finalEvidence?.stage !== 'final' || finalEvidence.passed !== true) {
    fail('final runtime evidence adapter did not return its exact receipt');
  }
  return Object.freeze({
    mode: 'positive',
    passed: true,
    speechDelivery: config.speechDelivery,
    missionStage: 'awaiting_customer',
    cleanup: 'complete',
    hangupAccepted,
  });
}

export async function runM1BStagingSmoke(
  command,
  environment = process.env,
  dependencies = {},
) {
  if (command === 'preflight') {
    return preflightM1BStagingAccount(environment, dependencies);
  }
  if (command === 'negative') {
    return runM1BNegativeStagingSmoke(environment, dependencies);
  }
  if (command === 'positive') {
    return runM1BPositiveStagingSmoke(environment, dependencies);
  }
  fail('expected command preflight, negative or positive');
}

async function main() {
  const result = await runM1BStagingSmoke(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'staging smoke failed'}\n`);
    process.exitCode = 1;
  });
}
