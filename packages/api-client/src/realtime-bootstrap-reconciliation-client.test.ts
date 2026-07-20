import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeVoiceBootstrapReconciliationInput } from './client';
import { HttpBobClient } from './http-client';
import { LocalBobClient } from './local-client';

const SESSION_HANDLE = 'mistral_reconcile_session_0001';
const BOOTSTRAP_TICKET = 'b2_QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI';
const RESUME_TICKET = 'r2_UlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlI';
const INPUT: RealtimeVoiceBootstrapReconciliationInput = {
  protocol: 'bob.mistral-pcm.v2',
  bootstrapTicket: BOOTSTRAP_TICKET,
  attempt: 1,
};

function client(): HttpBobClient {
  return new HttpBobClient({
    baseUrl: 'https://api.bob.test',
    companyId: 'company-1',
    getToken: async () => 'supabase-token',
  });
}

function issuedBody(
  scope: 'live_takeover' | 'terminal_replay',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: 'issued',
    websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
    companyId: 'company-1',
    sessionHandle: SESSION_HANDLE,
    ticket: RESUME_TICKET,
    protocol: 'bob.mistral-pcm.v2',
    scope,
    ticketExpiresAt: '2026-07-19T12:00:30.000Z',
    expectedMissionConnectionEpoch: 2,
    clientAcceptedMissionConnectionEpoch: 0,
    resumeNextServerSequence: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('BobClient — réconciliation du bootstrap Mistral v2', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['live_takeover', 'terminal_replay'] as const)(
    'envoie le body public exact et décode une capability %s',
    async (scope) => {
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toBe(
          `https://api.bob.test/voice/realtime/calls/${SESSION_HANDLE}/bootstrap-reconciliations`,
        );
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual(INPUT);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer supabase-token');
        return jsonResponse(issuedBody(scope));
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(client().reconcileRealtimeVoiceBootstrap(SESSION_HANDLE, INPUT))
        .resolves.toEqual({ ok: true, value: issuedBody(scope) });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(['retry_initial', 'attempt_consumed'] as const)(
    'reconnaît uniquement la forme exacte de %s',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status })));

      await expect(client().reconcileRealtimeVoiceBootstrap(SESSION_HANDLE, INPUT))
        .resolves.toEqual({ ok: true, value: { status } });
    },
  );

  it.each([
    ['champ fournisseur supplémentaire', issuedBody('live_takeover', { callId: 'secret' })],
    ['tenant différent', issuedBody('live_takeover', { companyId: 'company-2' })],
    ['mission différente', issuedBody('live_takeover', { sessionHandle: 'other_session_0000001' })],
    ['ticket bootstrap', issuedBody('live_takeover', { ticket: BOOTSTRAP_TICKET })],
    ['protocole v1', issuedBody('live_takeover', { protocol: 'bob.mistral-pcm.v1' })],
    ['scope inconnu', issuedBody('live_takeover', { scope: 'general_live_takeover' })],
    [
      'URL WebSocket avec query',
      issuedBody('live_takeover', {
        websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral?ticket=secret',
      }),
    ],
    ['epoch client inventé', issuedBody('live_takeover', { clientAcceptedMissionConnectionEpoch: 1 })],
    ['curseur client inventé', issuedBody('live_takeover', { resumeNextServerSequence: 1 })],
    ['epoch serveur nul', issuedBody('live_takeover', { expectedMissionConnectionEpoch: 0 })],
    ['timestamp non canonique', issuedBody('live_takeover', { ticketExpiresAt: '2026-07-19T12:00:30Z' })],
    ['retry enrichi', { status: 'retry_initial', ticket: RESUME_TICKET }],
    ['attempt consommé enrichi', { status: 'attempt_consumed', attempt: 1 }],
  ])('décode fail-closed une réponse invalide : %s', async (_label, payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));

    await expect(client().reconcileRealtimeVoiceBootstrap(SESSION_HANDLE, INPUT))
      .resolves.toMatchObject({
        ok: false,
        error: { kind: 'dependency', port: 'api-contract' },
      });
  });

  it.each([
    ['champ supplémentaire', { ...INPUT, providerSessionId: 'private' }],
    ['protocole v1', { ...INPUT, protocol: 'bob.mistral-pcm.v1' }],
    ['ticket r2', { ...INPUT, bootstrapTicket: `r2_${'R'.repeat(43)}` }],
    ['ticket court', { ...INPUT, bootstrapTicket: BOOTSTRAP_TICKET.slice(0, -1) }],
    ['tentative nulle', { ...INPUT, attempt: 0 }],
    ['tentative trop haute', { ...INPUT, attempt: 9 }],
    ['tentative fractionnaire', { ...INPUT, attempt: 1.5 }],
  ])('refuse un body non canonique avant le réseau : %s', async (_label, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().reconcileRealtimeVoiceBootstrap(
      SESSION_HANDLE,
      input as RealtimeVoiceBootstrapReconciliationInput,
    )).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuse un handle non canonique avant le réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().reconcileRealtimeVoiceBootstrap('../other-tenant', INPUT))
      .resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reste explicitement unavailable dans le client local', async () => {
    await expect(new LocalBobClient().reconcileRealtimeVoiceBootstrap(SESSION_HANDLE, INPUT))
      .resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'bob-live-bootstrap-reconciliation' },
      });
  });
});
