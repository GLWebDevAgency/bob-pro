import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };

const JSON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
});
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TOKEN_PATTERN = /^[\x21-\x7e]{32,256}$/u;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const RIFF = Buffer.from('RIFF', 'ascii');
const WAVE = Buffer.from('WAVE', 'ascii');
const FORMAT = Buffer.from('fmt ', 'ascii');
const DATA = Buffer.from('data', 'ascii');
const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const PCM_SUBFORMAT_GUID_TAIL = Buffer.from([
  0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa,
  0x00, 0x38, 0x9b, 0x71,
]);

function failConfiguration(message) {
  throw new Error(`whisper_audit_invalid_config:${message}`);
}

function parseCanonicalInteger(value, name, minimum, maximum) {
  if (typeof value !== 'string' || !INTEGER_PATTERN.test(value)) {
    failConfiguration(name);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    failConfiguration(name);
  }
  return parsed;
}

export function parseAuditGatewayConfig(environment = process.env) {
  const token = environment.BOB_LIVE_LOCAL_AUDIT_TOKEN;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    failConfiguration('BOB_LIVE_LOCAL_AUDIT_TOKEN');
  }
  const port = parseCanonicalInteger(environment.PORT ?? '8080', 'PORT', 1, 65_535);
  const internalPort = parseCanonicalInteger(
    environment.WHISPER_AUDIT_INTERNAL_PORT ?? '18080',
    'WHISPER_AUDIT_INTERNAL_PORT',
    1,
    65_535,
  );
  if (port === internalPort) failConfiguration('ports_must_differ');
  const threads = parseCanonicalInteger(
    environment.WHISPER_AUDIT_THREADS ?? '4',
    'WHISPER_AUDIT_THREADS',
    1,
    32,
  );
  const modelPath = environment.WHISPER_AUDIT_MODEL_PATH
    ?? `/opt/bob-whisper/${manifest.model.artifact}`;
  const binaryPath = environment.WHISPER_AUDIT_BINARY_PATH
    ?? '/usr/local/bin/whisper-server';
  if (modelPath !== `/opt/bob-whisper/${manifest.model.artifact}`) {
    failConfiguration('WHISPER_AUDIT_MODEL_PATH');
  }
  if (binaryPath !== '/usr/local/bin/whisper-server') {
    failConfiguration('WHISPER_AUDIT_BINARY_PATH');
  }
  return Object.freeze({
    token,
    port,
    internalPort,
    threads,
    modelPath,
    binaryPath,
  });
}

export function constantTimeBearerMatches(authorization, expectedToken) {
  const expected = Buffer.from(`Bearer ${expectedToken}`, 'utf8');
  const actual = typeof authorization === 'string'
    ? Buffer.from(authorization, 'utf8')
    : Buffer.alloc(0);
  const length = Math.max(actual.length, expected.length, 1);
  const paddedActual = Buffer.alloc(length);
  const paddedExpected = Buffer.alloc(length);
  actual.copy(paddedActual);
  expected.copy(paddedExpected);
  const equal = timingSafeEqual(paddedActual, paddedExpected) && actual.length === expected.length;
  paddedActual.fill(0);
  paddedExpected.fill(0);
  actual.fill(0);
  expected.fill(0);
  return equal;
}

function sendJson(response, statusCode, payload) {
  if (response.headersSent || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    'content-length': String(body.byteLength),
  });
  response.end(body);
}

function sendRefusal(response, statusCode, code) {
  sendJson(response, statusCode, { error: code });
}

async function readBoundedRequest(request, maximumBytes, signal) {
  const announced = request.headers['content-length'];
  if (typeof announced !== 'string' || !INTEGER_PATTERN.test(announced)) {
    throw Object.assign(new Error('length_required'), { statusCode: 411 });
  }
  const length = Number(announced);
  if (!Number.isSafeInteger(length) || length <= 0 || length > maximumBytes) {
    throw Object.assign(new Error('payload_too_large'), { statusCode: 413 });
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > maximumBytes || received > length) {
      throw Object.assign(new Error('payload_too_large'), { statusCode: 413 });
    }
    chunks.push(bytes);
  }
  signal.throwIfAborted();
  if (received !== length) {
    throw Object.assign(new Error('invalid_length'), { statusCode: 400 });
  }
  return Buffer.concat(chunks, received);
}

function canonicalMultipartContentType(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  if (!value.toLowerCase().startsWith('multipart/form-data;')) return null;
  return value;
}

function canonicalWaveFormat(view, contentStart, chunkSize) {
  const declaredFormat = view.readUInt16LE(contentStart);
  if (declaredFormat !== WAVE_FORMAT_EXTENSIBLE) return declaredFormat;
  if (
    chunkSize < 40
    || view.readUInt16LE(contentStart + 16) < 22
    || !view.subarray(contentStart + 28, contentStart + 40).equals(PCM_SUBFORMAT_GUID_TAIL)
  ) return null;
  const subFormat = view.readUInt32LE(contentStart + 24);
  return subFormat === WAVE_FORMAT_PCM || subFormat === WAVE_FORMAT_IEEE_FLOAT
    ? subFormat
    : null;
}

function validWaveBitDepth(format, bitsPerSample) {
  if (format === WAVE_FORMAT_IEEE_FLOAT) return bitsPerSample === 32;
  return format === WAVE_FORMAT_PCM
    && (bitsPerSample === 8
      || bitsPerSample === 16
      || bitsPerSample === 24
      || bitsPerSample === 32);
}

export function inspectWave(bytes) {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.byteLength < 44
    || bytes.byteLength > manifest.limits.maxAudioBytes
  ) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    !view.subarray(0, 4).equals(RIFF)
    || !view.subarray(8, 12).equals(WAVE)
    || view.readUInt32LE(4) !== view.byteLength - 8
  ) return false;

  let offset = 12;
  let chunks = 0;
  let byteRate = null;
  let blockAlign = null;
  let dataBytes = null;
  while (offset + 8 <= view.byteLength && chunks < manifest.limits.maxWaveChunks) {
    chunks += 1;
    const id = view.subarray(offset, offset + 4);
    const size = view.readUInt32LE(offset + 4);
    const contentStart = offset + 8;
    const contentEnd = contentStart + size;
    const paddedEnd = contentEnd + (size % 2);
    if (
      contentEnd > view.byteLength
      || paddedEnd > view.byteLength
      || (size % 2 === 1 && view[contentEnd] !== 0)
    ) return false;

    if (id.equals(FORMAT)) {
      if (byteRate !== null || size < 16) return false;
      const format = canonicalWaveFormat(view, contentStart, size);
      const channels = view.readUInt16LE(contentStart + 2);
      const sampleRate = view.readUInt32LE(contentStart + 4);
      const declaredByteRate = view.readUInt32LE(contentStart + 8);
      const declaredBlockAlign = view.readUInt16LE(contentStart + 12);
      const bitsPerSample = view.readUInt16LE(contentStart + 14);
      const expectedBlockAlign = channels * (bitsPerSample / 8);
      if (
        format === null
        || !validWaveBitDepth(format, bitsPerSample)
        || (channels !== 1 && channels !== 2)
        || sampleRate < 8_000
        || sampleRate > 48_000
        || !Number.isInteger(expectedBlockAlign)
        || declaredBlockAlign !== expectedBlockAlign
        || declaredByteRate !== sampleRate * expectedBlockAlign
      ) return false;
      byteRate = declaredByteRate;
      blockAlign = declaredBlockAlign;
    } else if (id.equals(DATA)) {
      if (dataBytes !== null || size === 0) return false;
      dataBytes = size;
    }
    offset = paddedEnd;
  }
  if (
    offset !== view.byteLength
    || chunks === 0
    || chunks > manifest.limits.maxWaveChunks
    || byteRate === null
    || blockAlign === null
    || dataBytes === null
    || dataBytes % blockAlign !== 0
  ) return false;
  const durationMs = (dataBytes * 1_000) / byteRate;
  return durationMs >= manifest.limits.minAudioDurationMs
    && durationMs <= manifest.limits.maxAudioDurationMs;
}

async function parseCanonicalTranscriptionRequest(body, contentType) {
  let form;
  try {
    form = await new Request('http://bob-whisper.invalid/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    }).formData();
  } catch {
    throw Object.assign(new Error('invalid_multipart'), { statusCode: 400 });
  }
  const keys = [...form.keys()];
  if (
    keys.length !== 3
    || form.getAll('file').length !== 1
    || form.getAll('model').length !== 1
    || form.getAll('language').length !== 1
    || keys.some((key) => key !== 'file' && key !== 'model' && key !== 'language')
  ) {
    throw Object.assign(new Error('invalid_fields'), { statusCode: 422 });
  }
  const file = form.get('file');
  const model = form.get('model');
  const language = form.get('language');
  if (
    typeof file === 'string'
    || file === null
    || file.type !== 'audio/wav'
    || file.size > manifest.limits.maxAudioBytes
    || model !== manifest.model.id
    || language !== 'fr'
  ) {
    throw Object.assign(new Error('invalid_fields'), { statusCode: 422 });
  }
  const audio = Buffer.from(await file.arrayBuffer());
  if (!inspectWave(audio)) {
    audio.fill(0);
    throw Object.assign(new Error('invalid_wave'), { statusCode: 422 });
  }
  return audio;
}

export function createInferenceGate() {
  let active = 0;
  const waiters = [];
  return {
    async acquire(signal) {
      signal.throwIfAborted();
      if (active < manifest.limits.maxConcurrentInferences) {
        active += 1;
        return;
      }
      if (waiters.length >= manifest.limits.maxQueuedRequests) {
        throw Object.assign(new Error('capacity_exhausted'), { statusCode: 429 });
      }
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        const abort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        waiter.resolve = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        signal.throwIfAborted();
        waiters.push(waiter);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    release() {
      const next = waiters.shift();
      if (next) next.resolve();
      else active = Math.max(0, active - 1);
    },
    snapshot() {
      return { active, queued: waiters.length };
    },
  };
}

async function readBoundedResponse(response, maximumBytes, signal) {
  const announced = response.headers.get('content-length');
  if (announced !== null) {
    const length = Number(announced);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      await response.body?.cancel('response-too-large').catch(() => undefined);
      throw new Error('invalid_upstream_response');
    }
  }
  if (!response.body) throw new Error('invalid_upstream_response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel('response-too-large');
        throw new Error('invalid_upstream_response');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = Buffer.alloc(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function createWhisperRuntimeClient({ internalPort, fetchImpl = fetch }) {
  const origin = `http://127.0.0.1:${internalPort}`;
  return {
    async health(signal) {
      try {
        const response = await fetchImpl(`${origin}/v1/health`, {
          method: 'GET',
          redirect: 'error',
          signal,
        });
        if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
          await response.body?.cancel('health-not-ready').catch(() => undefined);
          return false;
        }
        const body = await readBoundedResponse(response, 1_024, signal);
        const parsed = JSON.parse(body.toString('utf8'));
        body.fill(0);
        return parsed?.status === 'ok';
      } catch {
        return false;
      }
    },
    async transcribe(audio, signal) {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audit.wav');
      form.append('model', manifest.model.id);
      form.append('language', 'fr');
      form.append('response_format', 'json');
      const response = await fetchImpl(`${origin}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        redirect: 'error',
        signal,
      });
      if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
        await response.body?.cancel('transcription-failed').catch(() => undefined);
        throw new Error('whisper_upstream_failed');
      }
      const body = await readBoundedResponse(response, manifest.limits.maxResponseBytes, signal);
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
        if (
          text.length === 0
          || text.length > manifest.limits.maxTranscriptCharacters
        ) throw new Error('whisper_upstream_invalid_response');
        return text;
      } finally {
        body.fill(0);
      }
    },
  };
}

export function bindClientCancellation(request, response, controller) {
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Client disconnected', 'AbortError'));
    }
  };
  request.once('aborted', abort);
  response.once('close', () => {
    if (!response.writableEnded) abort();
  });
  if (request.aborted || request.destroyed || response.destroyed) abort();
}

export function createAuditGateway({
  config,
  runtimeClient = createWhisperRuntimeClient(config),
  runtimeState = { childAlive: true },
}) {
  const gate = createInferenceGate();
  const server = createServer(async (request, response) => {
    const requestTarget = request.url ?? '';
    if (request.method === 'GET' && requestTarget === manifest.service.healthPath) {
      const signal = AbortSignal.timeout(1_500);
      const healthy = runtimeState.childAlive && await runtimeClient.health(signal);
      sendJson(response, healthy ? 200 : 503, healthy ? {
        status: 'ready',
        schemaVersion: manifest.schemaVersion,
        engine: {
          id: manifest.engine.id,
          version: manifest.engine.version,
          sourceSha256: manifest.engine.sourceSha256,
        },
        model: {
          id: manifest.model.id,
          sha256: manifest.model.sha256,
          bytes: manifest.model.bytes,
        },
        capacity: gate.snapshot(),
      } : { status: 'unavailable' });
      return;
    }
    if (
      request.method !== 'POST'
      || requestTarget !== manifest.service.transcriptionPath
    ) {
      sendRefusal(response, 404, 'not_found');
      return;
    }
    if (!constantTimeBearerMatches(request.headers.authorization, config.token)) {
      sendRefusal(response, 401, 'unauthorized');
      return;
    }
    const contentType = canonicalMultipartContentType(request.headers['content-type']);
    if (contentType === null) {
      sendRefusal(response, 415, 'unsupported_media_type');
      return;
    }
    const controller = new AbortController();
    bindClientCancellation(request, response, controller);
    let acquired = false;
    let body;
    let audio;
    try {
      if (!runtimeState.childAlive) throw Object.assign(new Error('unavailable'), { statusCode: 503 });
      await gate.acquire(controller.signal);
      acquired = true;
      body = await readBoundedRequest(request, manifest.limits.maxRequestBytes, controller.signal);
      audio = await parseCanonicalTranscriptionRequest(body, contentType);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(manifest.limits.inferenceTimeoutMs),
      ]);
      const text = await runtimeClient.transcribe(audio, signal);
      sendJson(response, 200, { text });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        if (!response.destroyed) response.destroy();
      } else {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
        const code = statusCode === 429
          ? 'capacity_exhausted'
          : statusCode === 413
            ? 'payload_too_large'
            : statusCode === 411
              ? 'length_required'
              : statusCode >= 500
                ? 'unavailable'
                : 'invalid_request';
        sendRefusal(response, statusCode, code);
      }
    } finally {
      if (acquired) gate.release();
      audio?.fill(0);
      body?.fill(0);
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = manifest.limits.inferenceTimeoutMs + 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 16;
  server.maxRequestsPerSocket = 100;
  return server;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function waitForRuntime(runtimeClient, child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('whisper_audit_runtime_exited');
    }
    if (await runtimeClient.health(AbortSignal.timeout(1_500))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('whisper_audit_runtime_not_ready');
}

export function observeChildTermination(child, runtimeState) {
  let terminated = child.exitCode !== null || child.signalCode !== null;
  let settle;
  const promise = terminated
    ? Promise.resolve({
        kind: 'exit',
        code: child.exitCode,
        signal: child.signalCode,
      })
    : new Promise((resolve) => {
        settle = resolve;
      });
  if (!terminated) {
    child.once('error', (error) => {
      if (terminated) return;
      terminated = true;
      runtimeState.childAlive = false;
      settle({ kind: 'error', error });
    });
    child.once('exit', (code, signal) => {
      if (terminated) return;
      terminated = true;
      runtimeState.childAlive = false;
      settle({ kind: 'exit', code, signal });
    });
  } else {
    runtimeState.childAlive = false;
  }
  return Object.freeze({
    promise,
    isTerminated: () => terminated || child.exitCode !== null || child.signalCode !== null,
  });
}

async function waitForChildTermination(termination, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      termination.promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    return termination.isTerminated();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function terminateChild(child, termination) {
  if (termination.isTerminated()) return;
  child.kill('SIGTERM');
  if (!await waitForChildTermination(termination, 5_000)) {
    child.kill('SIGKILL');
    if (!await waitForChildTermination(termination, 5_000)) {
      throw new Error('whisper_audit_runtime_stop_timeout');
    }
  }
}

export async function main(environment = process.env) {
  const config = parseAuditGatewayConfig(environment);
  await access(config.binaryPath);
  await access(config.modelPath);
  const digest = await sha256File(config.modelPath);
  if (digest !== manifest.model.sha256) {
    throw new Error('whisper_audit_model_digest_mismatch');
  }
  const child = spawn(config.binaryPath, [
    '--host', '127.0.0.1',
    '--port', String(config.internalPort),
    '--model', config.modelPath,
    '--threads', String(config.threads),
    '--language', 'fr',
    '--request-path', '/v1',
    '--inference-path', '/audio/transcriptions',
    '--no-timestamps',
    '--no-gpu',
  ], {
    env: {
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const runtimeState = { childAlive: true };
  const childTermination = observeChildTermination(child, runtimeState);
  const runtimeClient = createWhisperRuntimeClient(config);
  const server = createAuditGateway({ config, runtimeClient, runtimeState });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtimeState.childAlive = false;
    server.close();
    await terminateChild(child, childTermination);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  try {
    await Promise.race([
      waitForRuntime(runtimeClient, child),
      childTermination.promise.then(() => {
        throw new Error('whisper_audit_runtime_exited');
      }),
    ]);
    server.listen(config.port, '::');
    await Promise.race([
      once(server, 'listening'),
      once(server, 'error').then(([error]) => { throw error; }),
    ]);
    await Promise.race([
      once(server, 'close'),
      childTermination.promise.then(() => {
        if (!shuttingDown) throw new Error('whisper_audit_runtime_exited');
      }),
    ]);
  } finally {
    await shutdown();
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((error) => {
    const code = typeof error?.message === 'string' && error.message.startsWith('whisper_audit_')
      ? error.message.split(':', 1)[0]
      : 'whisper_audit_startup_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
