#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const MAX_BODY_BYTES = 131_072;

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-readiness:${message}`);
}

export function parseM1BReadinessEnvironment(environment = process.env) {
  const rawOrigin = environment.API_BASE_URL;
  let origin;
  try {
    origin = new URL(rawOrigin);
  } catch {
    fail('API_BASE_URL must be a valid URL');
  }
  if (
    origin.protocol !== 'https:'
    || origin.username
    || origin.password
    || origin.pathname !== '/'
    || origin.search
    || origin.hash
  ) {
    fail('API_BASE_URL must be a credential-free HTTPS origin');
  }
  const releaseSha = environment.BOB_M1B_RELEASE_SHA;
  if (typeof releaseSha !== 'string' || !SHA.test(releaseSha)) {
    fail('BOB_M1B_RELEASE_SHA must be an exact lowercase 40-hex SHA');
  }
  return Object.freeze({
    apiOrigin: origin.origin,
    releaseSha,
  });
}

export function validateM1BReadinessPayload(payload, configuration) {
  if (
    typeof payload !== 'object'
    || payload === null
    || Array.isArray(payload)
    || payload.ready !== true
    || payload.release?.sha !== configuration.releaseSha
    || payload.release?.environment !== 'staging'
    || payload.capabilities?.realtimeAdmissionCancellationFence !== 'v1'
    || payload.capabilities?.agentMissionBootstrapReceipt !== 'v1'
    || payload.network?.clientIpSource !== 'railway-x-real-ip'
  ) {
    fail('the expected M1-B staging revision is not ready');
  }
  return Object.freeze({
    ready: true,
    releaseSha: configuration.releaseSha,
    releaseEnvironment: 'staging',
    realtimeAdmissionCancellationFence: 'v1',
    agentMissionBootstrapReceipt: 'v1',
    clientIpSource: 'railway-x-real-ip',
  });
}

async function readBoundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      fail('HTTP response exceeded the size limit');
    }
    return text;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail('HTTP response body is invalid');
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail('HTTP response exceeded the size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function request(fetchImpl, url, accept, timeoutMilliseconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: accept },
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function certifyM1BStagingReadiness(
  environment = process.env,
  dependencies = {},
) {
  const configuration = parseM1BReadinessEnvironment(environment);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => (
    new Promise((resolve) => setTimeout(resolve, milliseconds))
  ));
  const attempts = dependencies.attempts ?? 18;
  if (typeof fetchImpl !== 'function') fail('fetch is unavailable');

  let readiness;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(
        fetchImpl,
        `${configuration.apiOrigin}/health/ready`,
        'application/json',
        10_000,
      );
      if (response?.ok) {
        const raw = await readBoundedText(response);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          fail('readiness returned invalid JSON');
        }
        try {
          readiness = validateM1BReadinessPayload(payload, configuration);
          break;
        } catch (error) {
          if (attempt === attempts) throw error;
        }
      } else {
        await response?.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (
        attempt === attempts
        || !(error?.name === 'AbortError' || error instanceof TypeError)
      ) {
        throw error;
      }
    }
    if (attempt < attempts) await sleep(10_000);
  }
  if (!readiness) fail('readiness did not converge within the bounded window');

  const metricsResponse = await request(
    fetchImpl,
    `${configuration.apiOrigin}/metrics`,
    'text/plain',
    10_000,
  );
  await metricsResponse?.body?.cancel().catch(() => undefined);
  if (![401, 403].includes(metricsResponse?.status)) {
    fail(`unauthenticated metrics returned HTTP ${metricsResponse?.status ?? 'unknown'}`);
  }
  return readiness;
}

async function main() {
  const result = await certifyM1BStagingReadiness();
  process.stdout.write(
    `agent-mission-m1b-staging-readiness:ok:${result.releaseEnvironment}:${result.releaseSha}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error
        ? error.message
        : 'agent-mission-m1b-staging-readiness:unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
