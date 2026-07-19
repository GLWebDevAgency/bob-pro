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

function terminalCompleteBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: 'terminal_complete',
    companyId: 'company-1',
    sessionHandle: SESSION_HANDLE,
    protocol: 'bob.mistral-pcm.v2',
    missionConnectionEpoch: 9,
    nextServerSequence: 43,
    reason: 'user',
    closedAt: '2026-07-19T12:00:20.000Z',
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

  it('encode le handle et lie la preuve terminale complète à la mission demandée', async () => {
    const handle = 'conversation/session?tenant=1#checkpoint';
    const receipt = terminalCompleteBody({ sessionHandle: handle });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://api.bob.test/voice/realtime/calls/'
          + 'conversation%2Fsession%3Ftenant%3D1%23checkpoint/resume-tickets',
      );
      expect(JSON.parse(String(init?.body))).toEqual(INPUT);
      return jsonResponse(receipt);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().requestRealtimeVoiceResumeTicket(handle, INPUT)).resolves.toEqual({
      ok: true,
      value: receipt,
    });
  });

  it('accepte les bornes publiques exactes de la preuve terminale', async () => {
    const receipt = terminalCompleteBody({
      missionConnectionEpoch: 0x7fff_ffff,
      nextServerSequence: 0x1_0000_0000,
      reason: 'fatal_error',
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(receipt)));

    await expect(
      client().requestRealtimeVoiceResumeTicket(SESSION_HANDLE, INPUT),
    ).resolves.toEqual({ ok: true, value: receipt });
  });

  it('accepte un reçu CLOSED exactement égal à la preuve locale envoyée', async () => {
    const receipt = terminalCompleteBody({
      missionConnectionEpoch: INPUT.missionConnectionEpoch,
      nextServerSequence: INPUT.nextServerSequence,
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(receipt)));

    await expect(
      client().requestRealtimeVoiceResumeTicket(SESSION_HANDLE, INPUT),
    ).resolves.toEqual({ ok: true, value: receipt });
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
    ['preuve terminale historique incomplète', { status: 'terminal_complete' }],
    ['preuve terminale avec champ supplémentaire', terminalCompleteBody({ ticket: TICKET })],
    ['preuve terminale autre tenant', terminalCompleteBody({ companyId: 'company-2' })],
    [
      'preuve terminale autre mission',
      terminalCompleteBody({ sessionHandle: 'conversation_session_0002' }),
    ],
    ['preuve terminale protocole v1', terminalCompleteBody({ protocol: 'bob.mistral-pcm.v1' })],
    ['preuve terminale epoch zéro', terminalCompleteBody({ missionConnectionEpoch: 0 })],
    ['preuve terminale epoch fractionnaire', terminalCompleteBody({ missionConnectionEpoch: 1.5 })],
    [
      'preuve terminale epoch antérieur à la preuve locale',
      terminalCompleteBody({ missionConnectionEpoch: 6 }),
    ],
    [
      'preuve terminale epoch hors int32',
      terminalCompleteBody({ missionConnectionEpoch: 0x8000_0000 }),
    ],
    ['preuve terminale curseur zéro', terminalCompleteBody({ nextServerSequence: 0 })],
    ['preuve terminale curseur un', terminalCompleteBody({ nextServerSequence: 1 })],
    ['preuve terminale curseur deux', terminalCompleteBody({ nextServerSequence: 2 })],
    ['preuve terminale curseur fractionnaire', terminalCompleteBody({ nextServerSequence: 1.5 })],
    [
      'preuve terminale curseur global antérieur à la preuve locale',
      terminalCompleteBody({ missionConnectionEpoch: 7, nextServerSequence: 41 }),
    ],
    [
      'preuve terminale nouvel epoch sans avance stricte du curseur',
      terminalCompleteBody({ missionConnectionEpoch: 8, nextServerSequence: 42 }),
    ],
    [
      'preuve terminale curseur hors uint32',
      terminalCompleteBody({ nextServerSequence: 0x1_0000_0001 }),
    ],
    ['preuve terminale raison inconnue', terminalCompleteBody({ reason: 'unknown' })],
    [
      'preuve terminale timestamp non canonique',
      terminalCompleteBody({ closedAt: '2026-07-19T12:00:20Z' }),
    ],
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
