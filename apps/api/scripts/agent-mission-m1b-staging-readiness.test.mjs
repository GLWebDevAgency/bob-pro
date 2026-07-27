import assert from 'node:assert/strict';
import test from 'node:test';
import {
  certifyM1BStagingReadiness,
  parseM1BReadinessEnvironment,
  validateM1BReadinessPayload,
} from './agent-mission-m1b-staging-readiness.mjs';

const RELEASE_SHA = 'a'.repeat(40);

function environment(overrides = {}) {
  return {
    API_BASE_URL: 'https://bob-pro-api-staging.example.test',
    BOB_M1B_RELEASE_SHA: RELEASE_SHA,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    ready: true,
    release: {
      sha: RELEASE_SHA,
      environment: 'staging',
    },
    capabilities: {
      realtimeAdmissionCancellationFence: 'v1',
      agentMissionBootstrapReceipt: 'v1',
    },
    network: {
      clientIpSource: 'railway-x-real-ip',
    },
    ...overrides,
  };
}

function response(status, body = '') {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('exige un origin HTTPS exact et le SHA complet lowercase', () => {
  assert.deepEqual(parseM1BReadinessEnvironment(environment()), {
    apiOrigin: 'https://bob-pro-api-staging.example.test',
    releaseSha: RELEASE_SHA,
  });
  assert.throws(
    () => parseM1BReadinessEnvironment(environment({
      API_BASE_URL: 'http://bob-pro-api-staging.example.test',
    })),
    /HTTPS origin/u,
  );
  assert.throws(
    () => parseM1BReadinessEnvironment(environment({
      API_BASE_URL: 'https://user:secret@bob-pro-api-staging.example.test/path',
    })),
    /HTTPS origin/u,
  );
  assert.throws(
    () => parseM1BReadinessEnvironment(environment({
      BOB_M1B_RELEASE_SHA: 'A'.repeat(40),
    })),
    /lowercase 40-hex/u,
  );
});

test('valide simultanément readiness, SHA, staging et capacités réseau', () => {
  const config = parseM1BReadinessEnvironment(environment());
  assert.deepEqual(validateM1BReadinessPayload(payload(), config), {
    ready: true,
    releaseSha: RELEASE_SHA,
    releaseEnvironment: 'staging',
    realtimeAdmissionCancellationFence: 'v1',
    agentMissionBootstrapReceipt: 'v1',
    clientIpSource: 'railway-x-real-ip',
  });
  assert.throws(
    () => validateM1BReadinessPayload(payload({
      release: { sha: 'b'.repeat(40), environment: 'staging' },
    }), config),
    /not ready/u,
  );
  assert.throws(
    () => validateM1BReadinessPayload(payload({
      capabilities: {
        realtimeAdmissionCancellationFence: 'v1',
        agentMissionBootstrapReceipt: 'v2',
      },
    }), config),
    /not ready/u,
  );
});

test('réessaie la révision précédente puis exige /metrics fermé', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/metrics')) return response(401);
    if (calls.filter((entry) => entry.endsWith('/health/ready')).length === 1) {
      return response(200, JSON.stringify(payload({
        release: { sha: 'b'.repeat(40), environment: 'staging' },
      })));
    }
    return response(200, JSON.stringify(payload()));
  };
  const result = await certifyM1BStagingReadiness(environment(), {
    fetchImpl,
    sleep: async () => undefined,
    attempts: 2,
  });
  assert.equal(result.releaseSha, RELEASE_SHA);
  assert.equal(calls.filter((url) => url.endsWith('/health/ready')).length, 2);
  assert.equal(calls.at(-1).endsWith('/metrics'), true);
});

test('échoue fermé sur métriques publiques, JSON invalide ou fenêtre épuisée', async () => {
  await assert.rejects(
    certifyM1BStagingReadiness(environment(), {
      fetchImpl: async (url) => (
        url.endsWith('/metrics')
          ? response(200, '# public metrics')
          : response(200, JSON.stringify(payload()))
      ),
      attempts: 1,
    }),
    /metrics returned HTTP 200/u,
  );
  await assert.rejects(
    certifyM1BStagingReadiness(environment(), {
      fetchImpl: async () => response(200, 'not-json'),
      attempts: 1,
    }),
    /invalid JSON/u,
  );
  await assert.rejects(
    certifyM1BStagingReadiness(environment(), {
      fetchImpl: async () => response(503),
      attempts: 1,
    }),
    /did not converge/u,
  );
});
