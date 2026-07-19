import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeVoiceResumeTicketInput } from './client';
import { HttpBobClient } from './http-client';
import { LocalBobClient } from './local-client';

const SESSION_HANDLE = 'conversation_session_0001';
const INPUT: RealtimeVoiceResumeTicketInput = {
  missionConnectionEpoch: 7,
  nextServerSequence: 42,
};
const TICKET = `r2_${'A'.repeat(43)}`;

function client(): HttpBobClient {
  return new HttpBobClient({
    baseUrl: 'https://api.bob.test',
    companyId: 'company-1',
    getToken: async () => 'supabase-token',
  });
}

function issuedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'issued',
    websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
    companyId: 'company-1',
    sessionHandle: SESSION_HANDLE,
    ticket: TICKET,
    protocol: 'bob.mistral-pcm.v2',
    scope: 'terminal_replay',
    ticketExpiresAt: '2026-07-19T12:00:30.000Z',
    expectedMissionConnectionEpoch: 9,
    clientAcceptedMissionConnectionEpoch: INPUT.missionConnectionEpoch,
    resumeNextServerSequence: INPUT.nextServerSequence,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('BobClient — ticket de reprise terminale Mistral v2', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('envoie le body public exact et décode une capability terminal_replay liée à la mission', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(
        `https://api.bob.test/voice/realtime/calls/${SESSION_HANDLE}/resume-tickets`,
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        missionConnectionEpoch: 7,
        nextServerSequence: 42,
      });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer supabase-token');
      return jsonResponse(issuedBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().requestRealtimeVoiceResumeTicket(SESSION_HANDLE, INPUT)).resolves.toEqual({
      ok: true,
      value: issuedBody(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('encode le handle dans le chemin et ne reconnaît terminal_complete qu’avec sa forme exacte', async () => {
    const handle = 'conversation/session?tenant=1#checkpoint';
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://api.bob.test/voice/realtime/calls/'
          + 'conversation%2Fsession%3Ftenant%3D1%23checkpoint/resume-tickets',
      );
      expect(JSON.parse(String(init?.body))).toEqual(INPUT);
      return jsonResponse({ status: 'terminal_complete' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().requestRealtimeVoiceResumeTicket(handle, INPUT)).resolves.toEqual({
      ok: true,
      value: { status: 'terminal_complete' },
    });
  });

  it.each([
    ['champ fournisseur supplémentaire', issuedBody({ providerSessionId: 'secret' })],
    ['tenant différent', issuedBody({ companyId: 'company-2' })],
    ['mission différente', issuedBody({ sessionHandle: 'conversation_session_0002' })],
    ['ticket bootstrap v1', issuedBody({ ticket: 'A'.repeat(43) })],
    ['protocole v1', issuedBody({ protocol: 'bob.mistral-pcm.v1' })],
    ['scope live', issuedBody({ scope: 'live_takeover' })],
    [
      'URL WebSocket avec query',
      issuedBody({ websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral?ticket=secret' }),
    ],
    ['epoch accepté différent', issuedBody({ clientAcceptedMissionConnectionEpoch: 8 })],
    ['epoch serveur antérieur', issuedBody({ expectedMissionConnectionEpoch: 6 })],
    ['curseur différent', issuedBody({ resumeNextServerSequence: 43 })],
    ['timestamp non canonique', issuedBody({ ticketExpiresAt: '2026-07-19T12:00:30Z' })],
    ['terminal enrichi', { status: 'terminal_complete', ticket: TICKET }],
  ])('décode fail-closed une réponse invalide : %s', async (_label, payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));

    await expect(client().requestRealtimeVoiceResumeTicket(SESSION_HANDLE, INPUT)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it.each([
    ['champ supplémentaire', { ...INPUT, providerSessionId: 'private' }],
    ['epoch zéro', { ...INPUT, missionConnectionEpoch: 0 }],
    ['epoch fractionnaire', { ...INPUT, missionConnectionEpoch: 1.5 }],
    ['curseur négatif', { ...INPUT, nextServerSequence: -1 }],
    ['curseur moins zéro', { ...INPUT, nextServerSequence: -0 }],
    ['curseur au-delà de uint32', { ...INPUT, nextServerSequence: 0x1_0000_0001 }],
  ])('refuse un body non canonique avant le réseau : %s', async (_label, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().requestRealtimeVoiceResumeTicket(
        SESSION_HANDLE,
        input as RealtimeVoiceResumeTicketInput,
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reste explicitement unavailable dans le client local et ne fabrique aucun ticket', async () => {
    await expect(
      new LocalBobClient().requestRealtimeVoiceResumeTicket(SESSION_HANDLE, INPUT),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-resume-ticket' },
    });
  });
});
