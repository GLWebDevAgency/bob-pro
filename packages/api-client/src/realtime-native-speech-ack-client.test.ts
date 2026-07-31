import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BobClient, RealtimeVoiceNativeSpeechDeliveryInput } from './client';
import { HttpBobClient } from './http-client';
import { LocalBobClient } from './local-client';
import {
  REALTIME_NATIVE_SPEECH_LOCAL_OBSERVATION,
  decodeRealtimeVoiceNativeSpeechDeliveryAcknowledgement,
  encodeRealtimeVoiceNativeSpeechDeliveryInput,
} from './realtime-native-speech-ack-codec';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const TURN_ID = '20000000-0000-4000-8000-000000000002';
const DELIVERY_ID = '30000000-0000-4000-8000-000000000003';
const ACKNOWLEDGEMENT_ID = '40000000-0000-4000-8000-000000000004';
const CONTEXT_DIGEST = 'a'.repeat(64);

function input(
  overrides: Record<string, unknown> = {},
): RealtimeVoiceNativeSpeechDeliveryInput {
  return {
    acknowledgementId: ACKNOWLEDGEMENT_ID,
    contextRevision: 7,
    contextDigest: CONTEXT_DIGEST,
    slo: {
      speechStoppedEventToFirstInboundRtpMs: 701,
      pendingBargeIn: { status: 'complete', durationsMs: [91, 120] },
    },
    localObservation: REALTIME_NATIVE_SPEECH_LOCAL_OBSERVATION,
    ...overrides,
  } as RealtimeVoiceNativeSpeechDeliveryInput;
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryId: DELIVERY_ID,
    turnId: TURN_ID,
    acknowledgementId: ACKNOWLEDGEMENT_ID,
    contextRevision: 7,
    contextDigest: CONTEXT_DIGEST,
    idempotent: false,
    ...overrides,
  };
}

function expectedBinding() {
  return {
    deliveryId: DELIVERY_ID,
    turnId: TURN_ID,
    acknowledgementId: ACKNOWLEDGEMENT_ID,
    contextRevision: 7,
    contextDigest: CONTEXT_DIGEST,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function httpClient(): HttpBobClient {
  return new HttpBobClient({
    baseUrl: 'https://api.bob.test',
    companyId: 'company-1',
    getToken: async () => 'supabase-token',
  });
}

describe('codec ACK OpenAI native', () => {
  it('reconstruit et fige le corps exact, sans metadata fournisseur', () => {
    const source = input();
    const encoded = encodeRealtimeVoiceNativeSpeechDeliveryInput(source);

    expect(encoded).toEqual(source);
    expect(Object.isFrozen(encoded)).toBe(true);
    expect(Object.isFrozen(encoded?.slo)).toBe(true);
    expect(Object.isFrozen(encoded?.slo.pendingBargeIn)).toBe(true);
    if (encoded?.slo.pendingBargeIn?.status === 'complete') {
      expect(Object.isFrozen(encoded.slo.pendingBargeIn.durationsMs)).toBe(true);
    }
  });

  it('accepte le SLO minimal et le statut barge-in overflowed', () => {
    expect(encodeRealtimeVoiceNativeSpeechDeliveryInput(input({
      slo: { speechStoppedEventToFirstInboundRtpMs: 0 },
    }))).toMatchObject({ slo: { speechStoppedEventToFirstInboundRtpMs: 0 } });
    expect(encodeRealtimeVoiceNativeSpeechDeliveryInput(input({
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 60_000,
        pendingBargeIn: { status: 'overflowed' },
      },
    }))).toMatchObject({ slo: { pendingBargeIn: { status: 'overflowed' } } });
  });

  it.each([
    ['corps nul', null],
    ['clé racine inconnue', { ...input(), providerResponseId: 'resp_private' }],
    ['clé racine absente', (() => {
      const value = { ...input() } as Record<string, unknown>;
      delete value.localObservation;
      return value;
    })()],
    ['ACK invalide', input({ acknowledgementId: 'ack-provider' })],
    ['révision nulle', input({ contextRevision: 0 })],
    ['révision flottante', input({ contextRevision: 1.5 })],
    ['révision -0', input({ contextRevision: -0 })],
    ['révision hors int4', input({ contextRevision: 2_147_483_648 })],
    ['digest majuscule', input({ contextDigest: 'A'.repeat(64) })],
    ['SLO nul', input({ slo: null })],
    ['SLO vide', input({ slo: {} })],
    ['SLO sans mesure RTP', input({
      slo: { pendingBargeIn: { status: 'overflowed' } },
    })],
    ['SLO enrichi', input({
      slo: { speechStoppedEventToFirstInboundRtpMs: 1, providerMs: 2 },
    })],
    ['mesure RTP négative', input({ slo: { speechStoppedEventToFirstInboundRtpMs: -1 } })],
    ['mesure RTP -0', input({ slo: { speechStoppedEventToFirstInboundRtpMs: -0 } })],
    ['mesure RTP flottante', input({ slo: { speechStoppedEventToFirstInboundRtpMs: 1.5 } })],
    ['mesure RTP hors borne', input({ slo: { speechStoppedEventToFirstInboundRtpMs: 60_001 } })],
    ['barge-in vide', input({
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 1,
        pendingBargeIn: { status: 'complete', durationsMs: [] },
      },
    })],
    ['barge-in hors borne', input({
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 1,
        pendingBargeIn: { status: 'complete', durationsMs: [10_001] },
      },
    })],
    ['barge-in trop nombreux', input({
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 1,
        pendingBargeIn: { status: 'complete', durationsMs: Array.from({ length: 17 }, () => 1) },
      },
    })],
    ['barge-in enrichi', input({
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 1,
        pendingBargeIn: { status: 'overflowed', durationsMs: [1] },
      },
    })],
    ['observation future réservée', input({
      localObservation: { formatVersion: 1, kind: 'native_playout_queue_drained_v1' },
    })],
    ['observation enrichie', input({
      localObservation: { ...REALTIME_NATIVE_SPEECH_LOCAL_OBSERVATION, audible: true },
    })],
  ])('refuse %s avant transport', (_label, candidate) => {
    expect(encodeRealtimeVoiceNativeSpeechDeliveryInput(candidate)).toBeNull();
  });

  it('décode uniquement le reçu exact lié à la requête', () => {
    expect(decodeRealtimeVoiceNativeSpeechDeliveryAcknowledgement(
      200,
      receipt({ idempotent: true }),
      expectedBinding(),
    )).toEqual({ ...receipt({ idempotent: true }) });
  });

  it.each([
    ['statut alternatif', 201, receipt()],
    ['clé inconnue', 200, receipt({ providerResponseId: 'resp_private' })],
    ['delivery différente', 200, receipt({ deliveryId: '30000000-0000-4000-8000-000000000099' })],
    ['tour différent', 200, receipt({ turnId: '20000000-0000-4000-8000-000000000099' })],
    ['ACK différent', 200, receipt({ acknowledgementId: '40000000-0000-4000-8000-000000000099' })],
    ['contexte différent', 200, receipt({ contextRevision: 8 })],
    ['digest différent', 200, receipt({ contextDigest: 'b'.repeat(64) })],
    ['idempotence non booléenne', 200, receipt({ idempotent: 0 })],
  ])('refuse un reçu non corrélé : %s', (_label, status, candidate) => {
    expect(decodeRealtimeVoiceNativeSpeechDeliveryAcknowledgement(
      status,
      candidate,
      expectedBinding(),
    )).toBeNull();
  });
});

describe('clients ACK OpenAI native', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('POSTe le wire exact, authentifié et sans identifiant tenant client', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(
        `https://api.bob.test/voice/realtime/calls/${SESSION_ID}/turns/${TURN_ID}/native-speech/${DELIVERY_ID}/deliveries`,
      );
      expect(init).toMatchObject({
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer supabase-token');
      expect(headers.has('x-company-id')).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual(input());
      return jsonResponse(receipt());
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpClient().acknowledgeRealtimeVoiceNativeSpeechDelivery(
      SESSION_ID,
      TURN_ID,
      DELIVERY_ID,
      input(),
    )).resolves.toEqual({ ok: true, value: receipt() });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejette chemins et corps invalides sans aucun appel réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const bob = httpClient();

    for (const args of [
      ['provider-session', TURN_ID, DELIVERY_ID, input()],
      [SESSION_ID, 'provider-turn', DELIVERY_ID, input()],
      [SESSION_ID, TURN_ID, 'provider-delivery', input()],
      [SESSION_ID, TURN_ID, DELIVERY_ID, { ...input(), providerResponseId: 'resp_private' }],
    ] as const) {
      await expect(bob.acknowledgeRealtimeVoiceNativeSpeechDelivery(
        args[0],
        args[1],
        args[2],
        args[3] as RealtimeVoiceNativeSpeechDeliveryInput,
      )).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuse un reçu HTTP 200 enrichi ou délié du contexte', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(receipt({ providerResponseId: 'resp_private' })))
      .mockResolvedValueOnce(jsonResponse(receipt({ contextRevision: 8 })));
    vi.stubGlobal('fetch', fetchMock);
    const bob = httpClient();

    await expect(bob.acknowledgeRealtimeVoiceNativeSpeechDelivery(
      SESSION_ID,
      TURN_ID,
      DELIVERY_ID,
      input(),
    )).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
    await expect(bob.acknowledgeRealtimeVoiceNativeSpeechDelivery(
      SESSION_ID,
      TURN_ID,
      DELIVERY_ID,
      input(),
    )).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('préserve exactement le not_ready machine-typé et son Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: {
        kind: 'unavailable',
        service: 'bob-live-native-acknowledgement-not-ready',
        retryAfterSeconds: 1,
      },
    }, 503)));

    await expect(httpClient().acknowledgeRealtimeVoiceNativeSpeechDelivery(
      SESSION_ID,
      TURN_ID,
      DELIVERY_ID,
      input(),
    )).resolves.toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'bob-live-native-acknowledgement-not-ready',
        retryAfterSeconds: 1,
        code: 'BOB-LIVE-503',
        correlationId: expect.stringMatching(/^[0-9a-f-]{8,64}$/),
      },
    });
  });

  it('maintient la parité de méthode mais le client local échoue fermé', async () => {
    const clients: readonly BobClient[] = [httpClient(), new LocalBobClient()];
    for (const client of clients) {
      expect(typeof client.acknowledgeRealtimeVoiceNativeSpeechDelivery).toBe('function');
    }

    await expect(clients[1]?.acknowledgeRealtimeVoiceNativeSpeechDelivery(
      SESSION_ID,
      TURN_ID,
      DELIVERY_ID,
      input(),
    )).resolves.toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-native-acknowledgement' },
    });
  });
});
