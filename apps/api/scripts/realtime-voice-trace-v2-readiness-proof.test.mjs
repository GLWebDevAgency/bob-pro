import assert from 'node:assert/strict';
import test from 'node:test';
import {
  certifyRealtimeVoiceTraceV2ReadinessPayload,
  runRealtimeVoiceTraceV2ReadinessProof,
} from './realtime-voice-trace-v2-readiness-proof.mjs';

const SHA = 'a'.repeat(40);

function payload(environment, trace) {
  return {
    ready: true,
    customers: 0,
    dependencies: { bobLiveSpeechAudit: 'not_applicable' },
    capabilities: {
      documentArchiveB2cHttpFence: 'v1',
      realtimeAdmissionCancellationFence: 'v1',
      agentMissionBootstrapReceipt: 'v1',
      realtimeVoiceTraceV2: trace,
    },
    release: { sha: SHA, environment },
    network: { clientIpSource: 'railway-x-real-ip' },
  };
}

function legacyProductionPayload() {
  return {
    ready: true,
    customers: 0,
    capabilities: { documentArchiveB2cHttpFence: 'v1' },
    release: { sha: null, environment: null },
    network: { clientIpSource: 'railway-x-real-ip' },
  };
}

const PRODUCTION_EXPECTED = {
  environment: 'production',
  trace: 'inactive',
  sha: null,
};

test('snapshot production accepte les profils courant et historique complets', () => {
  const first = certifyRealtimeVoiceTraceV2ReadinessPayload(payload('production', 'off'), {
    ...PRODUCTION_EXPECTED,
  });
  const second = certifyRealtimeVoiceTraceV2ReadinessPayload(
    {
      ...payload('production', 'off'),
      customers: 999,
    },
    PRODUCTION_EXPECTED,
  );
  assert.equal(first.digest, second.digest);
  const withoutCapability = payload('production', 'off');
  delete withoutCapability.capabilities.realtimeVoiceTraceV2;
  const absent = certifyRealtimeVoiceTraceV2ReadinessPayload(
    withoutCapability,
    PRODUCTION_EXPECTED,
  );
  assert.equal(absent.state, 'absent');
  assert.notEqual(absent.digest, first.digest);

  const legacy = certifyRealtimeVoiceTraceV2ReadinessPayload(
    legacyProductionPayload(),
    PRODUCTION_EXPECTED,
  );
  const legacyWithVolatileCount = certifyRealtimeVoiceTraceV2ReadinessPayload(
    { ...legacyProductionPayload(), customers: 999 },
    PRODUCTION_EXPECTED,
  );
  assert.equal(legacy.state, 'absent');
  assert.equal(legacy.environment, 'production');
  assert.equal(legacy.digest, legacyWithVolatileCount.digest);
  assert.notEqual(legacy.digest, absent.digest);
});

test('snapshot production refuse actif et toute forme historique/courante hybride', () => {
  assert.throws(
    () =>
      certifyRealtimeVoiceTraceV2ReadinessPayload(
        payload('production', 'active'),
        PRODUCTION_EXPECTED,
      ),
    /does not match/u,
  );

  const hybrids = [
    { ...legacyProductionPayload(), release: { sha: SHA, environment: null } },
    {
      ...legacyProductionPayload(),
      capabilities: {
        ...legacyProductionPayload().capabilities,
        realtimeAdmissionCancellationFence: 'v1',
      },
    },
    {
      ...legacyProductionPayload(),
      capabilities: {
        ...legacyProductionPayload().capabilities,
        agentMissionBootstrapReceipt: 'v1',
      },
    },
    {
      ...legacyProductionPayload(),
      capabilities: {
        ...legacyProductionPayload().capabilities,
        realtimeVoiceTraceV2: 'off',
      },
    },
    {
      ...payload('production', 'off'),
      capabilities: {
        ...payload('production', 'off').capabilities,
        agentMissionBootstrapReceipt: undefined,
      },
    },
    {
      ...legacyProductionPayload(),
      capabilities: {
        ...legacyProductionPayload().capabilities,
        futureMutationFence: 'active',
      },
    },
    {
      ...legacyProductionPayload(),
      dependencies: { bobLiveSpeechAudit: 'ready' },
    },
    {
      ...payload('production', 'off'),
      dependencies: { bobLiveSpeechAudit: 'unavailable' },
    },
    {
      ...payload('production', 'off'),
      dependencies: { bobLiveSpeechAudit: { state: 'ready' } },
    },
    {
      ...payload('production', 'off'),
      capabilities: {
        ...payload('production', 'off').capabilities,
        futureMutationFence: 'active',
      },
    },
    { ...payload('production', 'off'), futureEnvelope: 'v1' },
    {
      ...payload('production', 'off'),
      release: { ...payload('production', 'off').release, generation: 2 },
    },
    {
      ...payload('production', 'off'),
      network: { ...payload('production', 'off').network, proxy: 'unknown' },
    },
    { ...payload('production', 'off'), customers: -1 },
    { ...payload('production', 'off'), customers: 1.5 },
  ];
  for (const hybrid of hybrids) {
    assert.throws(
      () => certifyRealtimeVoiceTraceV2ReadinessPayload(hybrid, PRODUCTION_EXPECTED),
      /does not match/u,
    );
  }
});

test('staging lie ON/OFF au SHA exact sans secret ni mutation', async () => {
  const calls = [];
  const on = await runRealtimeVoiceTraceV2ReadinessProof(
    'assert-staging-on',
    {
      API_BASE_URL: 'https://api-staging.bob.test',
      BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA: SHA,
    },
    {
      async fetchImpl(url, init) {
        calls.push({ url, init });
        return new Response(JSON.stringify(payload('staging', 'active')), { status: 200 });
      },
    },
  );
  assert.equal(on.state, 'active');
  assert.equal(calls[0].url, 'https://api-staging.bob.test/health/ready');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json' });
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
  await assert.rejects(
    runRealtimeVoiceTraceV2ReadinessProof(
      'assert-staging-off',
      {
        API_BASE_URL: 'https://api-staging.bob.test',
        BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA: SHA,
      },
      { fetchImpl: async () => new Response(JSON.stringify(payload('staging', 'active'))) },
    ),
    /does not match/u,
  );
});

test('staging refuse SHA, environnement, fences et enveloppes divergents', () => {
  const valid = payload('staging', 'off');
  const mutations = [
    { ...valid, release: { ...valid.release, sha: 'b'.repeat(40) } },
    { ...valid, release: { ...valid.release, environment: 'production' } },
    {
      ...valid,
      capabilities: Object.fromEntries(
        Object.entries(valid.capabilities).filter(([key]) => key !== 'documentArchiveB2cHttpFence'),
      ),
    },
    {
      ...valid,
      capabilities: Object.fromEntries(
        Object.entries(valid.capabilities).filter(
          ([key]) => key !== 'realtimeAdmissionCancellationFence',
        ),
      ),
    },
    {
      ...valid,
      capabilities: { ...valid.capabilities, agentMissionBootstrapReceipt: 'v2' },
    },
    {
      ...valid,
      capabilities: Object.fromEntries(
        Object.entries(valid.capabilities).filter(([key]) => key !== 'realtimeVoiceTraceV2'),
      ),
    },
    { ...valid, capabilities: { ...valid.capabilities, realtimeVoiceTraceV2: 'active' } },
    { ...valid, capabilities: { ...valid.capabilities, futureMutationFence: 'active' } },
    { ...valid, dependencies: { bobLiveSpeechAudit: 'unavailable' } },
    { ...valid, ready: false },
    { ...valid, network: { clientIpSource: 'x-forwarded-for' } },
    { ...valid, customers: -1 },
    { ...valid, futureEnvelope: 'v1' },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () =>
        certifyRealtimeVoiceTraceV2ReadinessPayload(mutation, {
          environment: 'staging',
          trace: 'off',
          sha: SHA,
        }),
      /does not match/u,
    );
  }
});

test('preuve publique refuse URL authentifiée, environnement et SHA divergents', async () => {
  await assert.rejects(
    runRealtimeVoiceTraceV2ReadinessProof(
      'snapshot-production',
      { API_BASE_URL: 'https://user:secret@api.bob.test' },
      {},
    ),
    /credential-free/u,
  );
  assert.throws(
    () =>
      certifyRealtimeVoiceTraceV2ReadinessPayload(payload('staging', 'off'), {
        environment: 'production',
        trace: 'inactive',
        sha: null,
      }),
    /does not match/u,
  );

  assert.throws(
    () =>
      certifyRealtimeVoiceTraceV2ReadinessPayload(legacyProductionPayload(), {
        environment: 'staging',
        trace: 'off',
        sha: SHA,
      }),
    /does not match/u,
  );
});

test('readiness borne flux, timeout et retries avant de rendre un verdict', async () => {
  let attempts = 0;
  const retried = await runRealtimeVoiceTraceV2ReadinessProof(
    'assert-staging-off',
    {
      API_BASE_URL: 'https://api-staging.bob.test',
      BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA: SHA,
    },
    {
      sleep: async () => undefined,
      async fetchImpl() {
        attempts += 1;
        if (attempts === 1) return new Response('', { status: 503 });
        return new Response(JSON.stringify(payload('staging', 'off')), { status: 200 });
      },
    },
  );
  assert.equal(attempts, 2);
  assert.equal(retried.state, 'off');

  await assert.rejects(
    runRealtimeVoiceTraceV2ReadinessProof(
      'assert-staging-off',
      {
        API_BASE_URL: 'https://api-staging.bob.test',
        BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA: SHA,
      },
      {
        requestTimeoutMs: 5,
        sleep: async () => undefined,
        fetchImpl(_url, init) {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        },
      },
    ),
    /aborted/u,
  );

  await assert.rejects(
    runRealtimeVoiceTraceV2ReadinessProof(
      'assert-staging-off',
      {
        API_BASE_URL: 'https://api-staging.bob.test',
        BOB_REALTIME_VOICE_TRACE_V2_RELEASE_SHA: SHA,
      },
      {
        fetchImpl: async () => new Response('x'.repeat(131_073), { status: 200 }),
      },
    ),
    /oversized/u,
  );
});
