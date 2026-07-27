import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createConnection } from 'node:net';
import test from 'node:test';
import manifest from './manifest.json' with { type: 'json' };
import {
  bindClientCancellation,
  constantTimeBearerMatches,
  createAuditGateway,
  createInferenceGate,
  inspectWave,
  observeChildTermination,
  parseAuditGatewayConfig,
  terminateChild,
} from './server.mjs';

const TOKEN = 'audit_token_abcdefghijklmnopqrstuvwxyz_1234567890';
const CONFIG = Object.freeze({
  token: TOKEN,
  port: 0,
  internalPort: 18_080,
  threads: 4,
  modelPath: `/opt/bob-whisper/${manifest.model.artifact}`,
  binaryPath: '/usr/local/bin/whisper-server',
});

function waveFixture({
  durationMs = 100,
  sampleRate = 16_000,
  channels = 1,
  bitsPerSample = 16,
  format = 1,
} = {}) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataBytes = Math.round((durationMs * byteRate) / 1_000);
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(format, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(byteRate, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

function formFixture(overrides = {}) {
  const form = new FormData();
  form.append(
    'file',
    overrides.file ?? new Blob([waveFixture()], { type: 'audio/wav' }),
    overrides.filename ?? 'caller-controlled-name.wav',
  );
  form.append('model', overrides.model ?? manifest.model.id);
  form.append('language', overrides.language ?? 'fr');
  if (overrides.extra) form.append('prompt', 'must-be-refused');
  return form;
}

async function listen(runtimeClient, runtimeState = { childAlive: true }) {
  const server = createAuditGateway({ config: CONFIG, runtimeClient, runtimeState });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function rawRequest(port, request) {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setEncoding('utf8');
  let response = '';
  socket.on('data', (chunk) => { response += chunk; });
  await once(socket, 'connect');
  socket.end(request);
  await once(socket, 'close');
  return response;
}

test('la configuration est canonique et les secrets/configs ambigus échouent fermés', () => {
  assert.deepEqual(parseAuditGatewayConfig({
    BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN,
    PORT: '8080',
    WHISPER_AUDIT_INTERNAL_PORT: '18080',
    WHISPER_AUDIT_THREADS: '4',
  }), {
    token: TOKEN,
    port: 8_080,
    internalPort: 18_080,
    threads: 4,
    modelPath: `/opt/bob-whisper/${manifest.model.artifact}`,
    binaryPath: '/usr/local/bin/whisper-server',
  });
  for (const environment of [
    {},
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: 'short' },
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: 'a'.repeat(257) },
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: `é${'a'.repeat(31)}` },
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: ` ${'a'.repeat(32)}` },
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN, PORT: '08080' },
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN, PORT: '18080', WHISPER_AUDIT_INTERNAL_PORT: '18080' },
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN, WHISPER_AUDIT_THREADS: '0' },
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN, WHISPER_AUDIT_MODEL_PATH: '/tmp/model.bin' },
    { BOB_LIVE_LOCAL_AUDIT_TOKEN: TOKEN, WHISPER_AUDIT_BINARY_PATH: '/tmp/whisper-server' },
  ]) {
    assert.throws(() => parseAuditGatewayConfig(environment), /whisper_audit_invalid_config/u);
  }
});

test('le bearer est comparé avec la primitive constant-time et sans tolérance de forme', () => {
  assert.equal(constantTimeBearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(constantTimeBearerMatches(`bearer ${TOKEN}`, TOKEN), false);
  assert.equal(constantTimeBearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(constantTimeBearerMatches(undefined, TOKEN), false);
});

test('la signature WAV et la capacité sont strictement bornées', async () => {
  assert.equal(inspectWave(waveFixture()), true);
  assert.equal(inspectWave(waveFixture({ durationMs: 45_000 })), true);
  assert.equal(inspectWave(Buffer.from('RIFF----NOTWAVE')), false);
  assert.equal(inspectWave(Buffer.alloc(manifest.limits.maxAudioBytes + 1)), false);
  assert.equal(inspectWave(waveFixture({ durationMs: 99 })), false);
  assert.equal(inspectWave(waveFixture({ durationMs: 45_001 })), false);
  assert.equal(inspectWave(waveFixture({ channels: 3 })), false);
  assert.equal(inspectWave(waveFixture({ sampleRate: 96_000 })), false);
  assert.equal(inspectWave(waveFixture({ bitsPerSample: 20 })), false);
  assert.equal(inspectWave(waveFixture({ format: 7 })), false);
  const lyingRiff = waveFixture();
  lyingRiff.writeUInt32LE(36, 4);
  assert.equal(inspectWave(lyingRiff), false);
  const lyingByteRate = waveFixture();
  lyingByteRate.writeUInt32LE(1, 28);
  assert.equal(inspectWave(lyingByteRate), false);

  const gate = createInferenceGate();
  const signal = new AbortController().signal;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(gate.acquire(alreadyAborted.signal), { name: 'AbortError' });
  assert.deepEqual(gate.snapshot(), { active: 0, queued: 0 });
  await gate.acquire(signal);
  const queuedA = gate.acquire(signal);
  const queuedB = gate.acquire(signal);
  await assert.rejects(gate.acquire(signal), (error) => error?.statusCode === 429);
  assert.deepEqual(gate.snapshot(), { active: 1, queued: 2 });
  gate.release();
  await queuedA;
  assert.deepEqual(gate.snapshot(), { active: 1, queued: 1 });
  gate.release();
  await queuedB;
  assert.deepEqual(gate.snapshot(), { active: 1, queued: 0 });
  gate.release();
  assert.deepEqual(gate.snapshot(), { active: 0, queued: 0 });
});

test('une déconnexion déjà observée annule avant toute admission', () => {
  const request = Object.assign(new EventEmitter(), {
    aborted: true,
    destroyed: true,
  });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  });
  const controller = new AbortController();

  bindClientCancellation(request, response, controller);

  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason?.name, 'AbortError');
});

test('le gateway expose uniquement health et transcription authentifiée', async (t) => {
  const calls = [];
  const runtimeClient = {
    async health() {
      return true;
    },
    async transcribe(audio) {
      calls.push(Buffer.from(audio));
      return 'Je vérifie.';
    },
  };
  const gateway = await listen(runtimeClient);
  t.after(() => gateway.close());

  const health = await fetch(`${gateway.origin}${manifest.service.healthPath}`, { redirect: 'error' });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: 'ready',
    schemaVersion: 1,
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
    capacity: { active: 0, queued: 0 },
  });
  assert.equal(health.headers.get('cache-control'), 'no-store');

  for (const path of ['/', '/load', '/v1/load', '/v1/audio/transcriptions?redirect=1']) {
    const response = await fetch(`${gateway.origin}${path}`, {
      method: path.includes('audio') ? 'POST' : 'GET',
      redirect: 'error',
    });
    assert.equal(response.status, 404);
  }

  const unauthorized = await fetch(
    `${gateway.origin}${manifest.service.transcriptionPath}`,
    { method: 'POST', body: formFixture(), redirect: 'error' },
  );
  assert.equal(unauthorized.status, 401);

  const accepted = await fetch(`${gateway.origin}${manifest.service.transcriptionPath}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: formFixture(),
    redirect: 'error',
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { text: 'Je vérifie.' });
  assert.equal(calls.length, 1);
  assert.equal(inspectWave(calls[0]), true);
});

test('un request-target absolu invalide est refusé sans faire tomber le processus', async (t) => {
  const runtimeClient = {
    async health() {
      return true;
    },
    async transcribe() {
      assert.fail('Whisper ne doit pas être appelé');
    },
  };
  const gateway = await listen(runtimeClient);
  t.after(() => gateway.close());
  const port = Number(new URL(gateway.origin).port);

  const refusal = await rawRequest(
    port,
    'GET http://[ HTTP/1.1\r\nHost: bob-whisper.invalid\r\nConnection: close\r\n\r\n',
  );
  assert.match(refusal, /^HTTP\/1\.1 404 /u);
  const health = await fetch(`${gateway.origin}${manifest.service.healthPath}`, {
    redirect: 'error',
  });
  assert.equal(health.status, 200);
});

test('le gateway refuse les champs, formats et volumes non canoniques avant Whisper', async (t) => {
  const runtimeClient = {
    async health() {
      return true;
    },
    async transcribe() {
      assert.fail('Whisper ne doit pas être appelé');
    },
  };
  const gateway = await listen(runtimeClient);
  t.after(() => gateway.close());
  const request = (body, headers = {}) => fetch(
    `${gateway.origin}${manifest.service.transcriptionPath}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      body,
      redirect: 'error',
    },
  );

  for (const form of [
    formFixture({ model: 'latest' }),
    formFixture({ language: 'auto' }),
    formFixture({ file: new Blob([waveFixture()], { type: 'audio/mpeg' }) }),
    formFixture({ file: new Blob([Buffer.alloc(44)], { type: 'audio/wav' }) }),
    formFixture({ extra: true }),
  ]) {
    const response = await request(form);
    assert.equal(response.status, 422);
  }
  const wrongMime = await request(Buffer.from('{}'), { 'content-type': 'application/json' });
  assert.equal(wrongMime.status, 415);
  const oversized = await request(
    Buffer.alloc(manifest.limits.maxRequestBytes + 1),
    { 'content-type': 'multipart/form-data; boundary=bob' },
  );
  assert.equal(oversized.status, 413);
});

test('health échoue fermé si le processus ou le modèle ne répond plus', async (t) => {
  const runtimeState = { childAlive: true };
  const runtimeClient = {
    async health() {
      return false;
    },
    async transcribe() {
      assert.fail('inatteignable');
    },
  };
  const gateway = await listen(runtimeClient, runtimeState);
  t.after(() => gateway.close());
  const response = await fetch(`${gateway.origin}${manifest.service.healthPath}`, {
    redirect: 'error',
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable' });
});

test('une fin enfant par signal reste observable et ne bloque jamais un arrêt tardif', async () => {
  const child = spawn(process.execPath, [
    '--eval',
    'process.kill(process.pid, "SIGTERM")',
  ], {
    stdio: 'ignore',
  });
  const runtimeState = { childAlive: true };
  const termination = observeChildTermination(child, runtimeState);
  const outcome = await termination.promise;

  assert.deepEqual(outcome, { kind: 'exit', code: null, signal: 'SIGTERM' });
  assert.equal(runtimeState.childAlive, false);
  assert.equal(termination.isTerminated(), true);
  await terminateChild(child, termination);
});
