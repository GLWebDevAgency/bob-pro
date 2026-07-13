import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBobClient } from './http-client';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TURN_ID = '00000000-0000-4000-8000-000000000002';
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000003';
const DELIVERY_ID = '00000000-0000-4000-8000-000000000004';
const CANCELLATION_ID = '00000000-0000-4000-8000-000000000005';
const CONTEXT_DIGEST = 'a'.repeat(64);
const AUDIO_SHA256 = 'b'.repeat(64);

function client(): HttpBobClient {
  return new HttpBobClient({
    baseUrl: 'https://api.bob.test',
    companyId: 'company-1',
    getToken: async () => 'supabase-token',
  });
}

function readyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactId: ARTIFACT_ID,
    turnId: TURN_ID,
    audioUrl: 'https://storage.bob.test/speech.mp3?signature=opaque',
    audioSha256: AUDIO_SHA256,
    mimeType: 'audio/mpeg',
    byteSize: 24_000,
    durationMs: 1_250,
    sequence: 1,
    contextRevision: 7,
    contextDigest: CONTEXT_DIGEST,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpBobClient — feed vocal audité Bob Live', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lit le prochain artefact prêt depuis le feed session authentifié et borné', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(
        `https://api.bob.test/voice/realtime/calls/${SESSION_ID}/speech?afterSequence=0&waitMs=2500`,
      );
      expect(init).toMatchObject({ method: 'GET' });
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer supabase-token',
        'x-company-id': 'company-1',
      });
      return jsonResponse(readyBody());
    }));

    await expect(client().getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 0 })).resolves.toEqual({
      ok: true,
      value: {
        status: 'ready',
        artifactId: ARTIFACT_ID,
        turnId: TURN_ID,
        audioUrl: 'https://storage.bob.test/speech.mp3?signature=opaque',
        audioSha256: AUDIO_SHA256,
        mimeType: 'audio/mpeg',
        byteSize: 24_000,
        durationMs: 1_250,
        sequence: 1,
        contextRevision: 7,
        contextDigest: CONTEXT_DIGEST,
      },
    });
  });

  it('décode 202 rendering, 204 none et 410 terminal comme états métier monotones', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'rendering',
        artifactId: ARTIFACT_ID,
        turnId: TURN_ID,
        sequence: 3,
        contextRevision: 7,
        contextDigest: CONTEXT_DIGEST,
      }, 202))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'terminal',
        artifactId: ARTIFACT_ID,
        turnId: TURN_ID,
        sequence: 3,
        reason: 'cancelled',
        contextRevision: 7,
        contextDigest: CONTEXT_DIGEST,
      }, 410));
    vi.stubGlobal('fetch', fetchMock);
    const bob = client();

    await expect(bob.getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 2, waitMs: 100 }))
      .resolves.toEqual({
        ok: true,
        value: {
          status: 'rendering',
          artifactId: ARTIFACT_ID,
          turnId: TURN_ID,
          sequence: 3,
          contextRevision: 7,
          contextDigest: CONTEXT_DIGEST,
        },
      });
    await expect(bob.getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 3, waitMs: 0 }))
      .resolves.toEqual({ ok: true, value: { status: 'none' } });
    await expect(bob.getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 2, waitMs: 0 }))
      .resolves.toEqual({
        ok: true,
        value: {
          status: 'terminal',
          artifactId: ARTIFACT_ID,
          turnId: TURN_ID,
          sequence: 3,
          reason: 'cancelled',
          contextRevision: 7,
          contextDigest: CONTEXT_DIGEST,
        },
      });
  });

  it.each([
    ['champ fournisseur supplémentaire', readyBody({ responseId: 'resp_private' })],
    ['URL HTTP distante', readyBody({ audioUrl: 'http://storage.bob.test/speech.mp3' })],
    ['faux localhost', readyBody({ audioUrl: 'http://localhost.evil.test/speech.mp3' })],
    ['credentials URL', readyBody({ audioUrl: 'https://user:secret@storage.bob.test/speech.mp3' })],
    ['fragment URL', readyBody({ audioUrl: 'https://storage.bob.test/speech.mp3#fragment' })],
    ['hash non canonique', readyBody({ audioSha256: AUDIO_SHA256.toUpperCase() })],
    ['mime alias non canonique', readyBody({ mimeType: 'audio/mp3' })],
    ['audio trop volumineux', readyBody({ byteSize: 2 * 1024 * 1024 + 1 })],
    ['audio trop long', readyBody({ durationMs: 45_001 })],
    ['séquence serveur sentinelle', readyBody({ sequence: 0 })],
    ['UUID invalide', readyBody({ artifactId: 'artifact-provider-private' })],
  ])('échoue fermé sur un artefact prêt invalide : %s', async (_label, payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));

    await expect(client().getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 0, waitMs: 0 }))
      .resolves.toMatchObject({
        ok: false,
        error: { kind: 'dependency', port: 'api-contract' },
      });
  });

  it.each([
    'http://localhost:3000/speech.mp3?token=dev',
    'http://127.0.0.1:3000/speech.mp3?token=dev',
    'http://[::1]:3000/speech.mp3?token=dev',
  ])('accepte uniquement le HTTP local de développement : %s', async (audioUrl) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(readyBody({ audioUrl }))));

    await expect(client().getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 0, waitMs: 0 }))
      .resolves.toMatchObject({ ok: true, value: { status: 'ready', audioUrl } });
  });

  it('refuse les curseurs, attentes et handles invalides avant le réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const bob = client();

    await expect(bob.getNextRealtimeVoiceSpeech('provider-call-id', { afterSequence: 0 }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    await expect(bob.getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: -1 }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    await expect(bob.getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 0, waitMs: 2_501 }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acquitte une livraison idempotente et ne laisse sortir que la référence de contrôle', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(
        `https://api.bob.test/voice/realtime/calls/${SESSION_ID}/turns/${TURN_ID}/speech/${ARTIFACT_ID}/deliveries`,
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        deliveryId: DELIVERY_ID,
        audioSha256: AUDIO_SHA256,
      });
      return jsonResponse({
        controlReference: {
          turnId: TURN_ID,
          contextRevision: 7,
          contextDigest: CONTEXT_DIGEST,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtimeInput = {
      deliveryId: DELIVERY_ID,
      audioSha256: AUDIO_SHA256,
      providerResponseId: 'must-not-cross-http',
    };

    await expect(client().acknowledgeRealtimeVoiceSpeechDelivery(
      SESSION_ID,
      TURN_ID,
      ARTIFACT_ID,
      runtimeInput,
    )).resolves.toEqual({
      ok: true,
      value: {
        controlReference: {
          turnId: TURN_ID,
          contextRevision: 7,
          contextDigest: CONTEXT_DIGEST,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuse un contrôle de livraison d’un autre tour ou enrichi par le fournisseur', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        controlReference: {
          turnId: '00000000-0000-4000-8000-000000000099',
          contextRevision: 7,
          contextDigest: CONTEXT_DIGEST,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        controlReference: {
          turnId: TURN_ID,
          contextRevision: 7,
          contextDigest: CONTEXT_DIGEST,
          navigate: '/cloture',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const bob = client();
    const input = { deliveryId: DELIVERY_ID, audioSha256: AUDIO_SHA256 };

    await expect(bob.acknowledgeRealtimeVoiceSpeechDelivery(SESSION_ID, TURN_ID, ARTIFACT_ID, input))
      .resolves.toMatchObject({ ok: false, error: { kind: 'dependency', port: 'api-contract' } });
    await expect(bob.acknowledgeRealtimeVoiceSpeechDelivery(SESSION_ID, TURN_ID, ARTIFACT_ID, input))
      .resolves.toMatchObject({ ok: false, error: { kind: 'dependency', port: 'api-contract' } });
  });

  it('annule l’artefact avec une raison allowlistée et une réponse sans contenu', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(
        `https://api.bob.test/voice/realtime/calls/${SESSION_ID}/turns/${TURN_ID}/speech/${ARTIFACT_ID}/cancellations`,
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        cancellationId: CANCELLATION_ID,
        reason: 'barge_in',
      });
      return new Response(null, { status: 204 });
    }));

    await expect(client().cancelRealtimeVoiceSpeech(
      SESSION_ID,
      TURN_ID,
      ARTIFACT_ID,
      { cancellationId: CANCELLATION_ID, reason: 'barge_in' },
    )).resolves.toEqual({ ok: true, value: undefined });
  });

  it('refuse une raison libre et un identifiant d’idempotence invalide avant le réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const bob = client();

    await expect(bob.cancelRealtimeVoiceSpeech(
      SESSION_ID,
      TURN_ID,
      ARTIFACT_ID,
      { cancellationId: CANCELLATION_ID, reason: 'provider_error' as 'barge_in' },
    )).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    await expect(bob.cancelRealtimeVoiceSpeech(
      SESSION_ID,
      TURN_ID,
      ARTIFACT_ID,
      { cancellationId: 'cancel-provider', reason: 'user_cancel' },
    )).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propage physiquement AbortSignal pendant un long-poll', async () => {
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    }));
    const abort = new AbortController();
    const pending = client().getNextRealtimeVoiceSpeech(
      SESSION_ID,
      { afterSequence: 0 },
      abort.signal,
    );
    await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));

    abort.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api', cause: 'Requête annulée.' },
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('borne le corps HTTP avant décodage et échoue fermé sur un 410 malformé', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(readyBody()), {
        headers: {
          'content-type': 'application/json',
          'content-length': String(16 * 1024 + 1),
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'terminal', providerReason: 'secret' }, 410));
    vi.stubGlobal('fetch', fetchMock);
    const bob = client();

    await expect(bob.getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 0, waitMs: 0 }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'dependency', port: 'api' } });
    await expect(bob.getNextRealtimeVoiceSpeech(SESSION_ID, { afterSequence: 0, waitMs: 0 }))
      .resolves.toMatchObject({
        ok: false,
        error: { kind: 'dependency', port: 'api', cause: 'HTTP 410' },
      });
  });
});
