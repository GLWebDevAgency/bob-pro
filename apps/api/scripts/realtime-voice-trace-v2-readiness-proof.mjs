#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/u;
const MAX_BODY_BYTES = 131_072;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function fail(message) {
  throw new Error(`realtime-voice-trace-v2-readiness-proof:${message}`);
}

function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('API_BASE_URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    fail('API_BASE_URL must be a credential-free HTTPS origin');
  }
  return url.origin;
}

async function boundedJson(response) {
  if (!response?.ok) fail('readiness HTTP response is unavailable');
  const reader = response.body?.getReader();
  if (reader === undefined) fail('readiness body stream is unavailable');
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail('readiness body stream is invalid');
    byteLength += value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail('readiness body is oversized');
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks, byteLength).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    fail('readiness body is invalid');
  }
}

async function fetchReadiness(url, fetchImpl, dependencies) {
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) {
    fail('readiness request timeout is invalid');
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response?.ok && RETRYABLE_STATUS.has(response?.status) && attempt < MAX_ATTEMPTS) {
        await response?.body?.cancel().catch(() => undefined);
        await sleep(250 * attempt);
        continue;
      }
      return await boundedJson(response);
    } catch (error) {
      if (attempt < MAX_ATTEMPTS && (error?.name === 'AbortError' || error instanceof TypeError)) {
        await sleep(250 * attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  fail('readiness retries exhausted');
}

export function certifyRealtimeVoiceTraceV2ReadinessPayload(payload, expected) {
  const observedTrace = payload?.capabilities?.realtimeVoiceTraceV2;
  const traceMatches =
    expected.trace === 'inactive'
      ? observedTrace === undefined || observedTrace === 'off'
      : observedTrace === expected.trace;
  if (
    payload?.ready !== true ||
    payload.release?.environment !== expected.environment ||
    !SHA.test(payload.release?.sha ?? '') ||
    (expected.sha !== null && payload.release.sha !== expected.sha) ||
    payload.capabilities?.documentArchiveB2cHttpFence !== 'v1' ||
    payload.capabilities?.realtimeAdmissionCancellationFence !== 'v1' ||
    payload.capabilities?.agentMissionBootstrapReceipt !== 'v1' ||
    !traceMatches ||
    payload.network?.clientIpSource !== 'railway-x-real-ip'
  ) {
    fail('readiness capability contract does not match');
  }
  const canonical = {
    ready: true,
    release: {
      sha: payload.release.sha,
      environment: payload.release.environment,
    },
    dependencies: {
      bobLiveSpeechAudit: payload.dependencies?.bobLiveSpeechAudit ?? null,
    },
    capabilities: {
      documentArchiveB2cHttpFence: 'v1',
      realtimeAdmissionCancellationFence: 'v1',
      agentMissionBootstrapReceipt: 'v1',
      realtimeVoiceTraceV2: observedTrace ?? null,
    },
    network: { clientIpSource: 'railway-x-real-ip' },
  };
  return Object.freeze({
    digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    state: expected.trace === 'inactive' ? (observedTrace ?? 'absent') : expected.trace,
    environment: expected.environment,
  });
}

export async function runRealtimeVoiceTraceV2ReadinessProof(
  command,
  environment = process.env,
  dependencies = {},
) {
  const origin = parseOrigin(environment.API_BASE_URL);
  const expected =
    command === 'snapshot-production'
      ? { environment: 'production', trace: 'inactive', sha: null }
      : command === 'assert-staging-on'
        ? {
            environment: 'staging',
            trace: 'active',
            sha: environment.BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA,
          }
        : command === 'assert-staging-off'
          ? {
              environment: 'staging',
              trace: 'off',
              sha: environment.BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA,
            }
          : null;
  if (expected === null) fail('command is invalid');
  if (expected.sha !== null && !SHA.test(expected.sha ?? '')) fail('expected SHA is invalid');
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('fetch is unavailable');
  const payload = await fetchReadiness(`${origin}/health/ready`, fetchImpl, dependencies);
  return certifyRealtimeVoiceTraceV2ReadinessPayload(payload, expected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealtimeVoiceTraceV2ReadinessProof(process.argv[2]).then(
    (result) => process.stdout.write(`${result.digest}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'readiness proof failed'}\n`,
      );
      process.exitCode = 1;
    },
  );
}
