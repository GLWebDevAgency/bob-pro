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

test('snapshot production refuse active, accepte absent ou OFF et reste déterministe', () => {
  const first = certifyRealtimeVoiceTraceV2ReadinessPayload(payload('production', 'off'), {
    environment: 'production',
    trace: 'inactive',
    sha: null,
  });
  const second = certifyRealtimeVoiceTraceV2ReadinessPayload(
    {
      ...payload('production', 'off'),
      customers: 999,
    },
    {
      environment: 'production',
      trace: 'inactive',
      sha: null,
    },
  );
  assert.equal(first.digest, second.digest);
  const withoutCapability = payload('production', 'off');
  delete withoutCapability.capabilities.realtimeVoiceTraceV2;
  const absent = certifyRealtimeVoiceTraceV2ReadinessPayload(withoutCapability, {
    environment: 'production',
    trace: 'inactive',
    sha: null,
  });
  assert.equal(absent.state, 'absent');
  assert.notEqual(absent.digest, first.digest);
  assert.throws(
    () =>
      certifyRealtimeVoiceTraceV2ReadinessPayload(payload('production', 'active'), {
        environment: 'production',
        trace: 'inactive',
        sha: null,
      }),
    /does not match/u,
  );
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
