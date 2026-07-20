import { ok } from '@bob/core';
import type { RealtimeVoiceCallInput } from '@bob/api-client';
import type { AgentContext } from '@bob/ai';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-audio', () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: true })),
  },
}));
vi.mock('expo-crypto', () => ({
  randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000999'),
}));
vi.mock('../../modules/bob-live-audio/src/BobLiveAudioModule', () => ({
  default: null,
}));

import type { ProcessAudioLease } from '../audio';
import {
  MISTRAL_PCM_UPLINK_PROTOCOL,
  type MistralPcmCapturePort,
  type MistralPcmMobileSocket,
} from './mistral-pcm-uplink';
import {
  MistralRealtimeTransport,
  type RealtimeMistralPcmNegotiation,
} from './mistral-realtime-transport';
import type { RealtimeTransportEvent } from './realtime-transport';

const NOW = 1_000_000;
const SESSION = '00000000-0000-4000-8000-000000000101';
const CONTEXT_DIGEST = 'a'.repeat(64);
const CONTEXT = {
  screen: { name: 'documents', instanceId: 'documents-1' },
  entities: [],
  capabilities: ['screen.read'],
} as const satisfies AgentContext;

const NEGOTIATION: RealtimeMistralPcmNegotiation = Object.freeze({
  available: true,
  transport: 'mistral-pcm',
  model: 'voxtral-mini-transcribe-realtime-2602',
  voice: 'marin',
  configVersion: 'bob-live-provider-neutral-v2',
  requiresDevelopmentBuild: true,
  maxSessionSeconds: 60,
  speechDelivery: 'audited-signed-url-v1',
});

type Listener = (() => void) | ((event: { readonly data: unknown }) => void);

class FakeSocket implements MistralPcmMobileSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  readonly sent: Array<string | ArrayBuffer> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch('close');
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open');
  }

  server(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) });
  }

  private dispatch(type: string, event?: { readonly data: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (event) (listener as (input: { readonly data: unknown }) => void)(event);
      else (listener as () => void)();
    }
  }
}

function ready(socket: FakeSocket): void {
  socket.server({
    type: 'ready',
    protocol: MISTRAL_PCM_UPLINK_PROTOCOL,
    audio: {
      encoding: 'pcm_s16le',
      sampleRateHz: 16_000,
      channels: 1,
      maxChunkBytes: 16 * 1024,
    },
    hardExpiresAt: new Date(NOW + 60_000).toISOString(),
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition_not_reached');
}

function harness(
  input: {
    permission?: boolean;
    capture?: boolean;
    mismatch?: boolean;
    protocolV2?: boolean;
    createCallGate?: Promise<void>;
    captureGate?: Promise<void>;
    stopCapture?: () => Promise<void>;
  } = {},
) {
  const socket = new FakeSocket();
  const stopCapture = vi.fn(async () => input.stopCapture?.());
  let captureInput: Parameters<MistralPcmCapturePort['start']>[0] | null = null;
  const startCapture = vi.fn(async (next: Parameters<MistralPcmCapturePort['start']>[0]) => {
    captureInput = next;
    await input.captureGate;
    return { stop: stopCapture };
  });
  const capture: MistralPcmCapturePort = { start: startCapture };
  const lease: ProcessAudioLease = Object.freeze({
    generation: 1,
    mode: 'realtime',
    owner: 'mistral-test',
    token: Symbol('mistral-test'),
  });
  const release = vi.fn(() => true);
  const audio = {
    acquire: vi.fn(async () => ({ ok: true as const, lease })),
    release,
    isCurrent: vi.fn(() => true),
    async withPermissionRequest<T>(run: () => Promise<T>): Promise<T> {
      return run();
    },
  };
  const createCall = vi.fn(async (request: RealtimeVoiceCallInput) => {
    if (request.transport !== 'mistral-pcm') throw new Error('unexpected transport');
    await input.createCallGate;
    if (input.protocolV2) {
      return ok({
        transport: 'mistral-pcm' as const,
        websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
        companyId: 'company-1',
        ticket: `b2_${Buffer.alloc(32, 4).toString('base64url')}`,
        protocol: 'bob.mistral-pcm.v2' as const,
        ticketExpiresAt: new Date(NOW + 30_000).toISOString(),
        maxMissionAudioBytes: 1_920_000,
        contextRevision: request.context.revision,
        contextDigest: CONTEXT_DIGEST,
        routeMode: 'push_to_talk' as const,
        fullDuplexCertified: false as const,
        sessionHandle: request.sessionHandle ?? SESSION,
        hardExpiresAt: new Date(NOW + 60_000).toISOString(),
        model: NEGOTIATION.model,
        voice: NEGOTIATION.voice,
        configVersion: NEGOTIATION.configVersion,
        maxSessionSeconds: NEGOTIATION.maxSessionSeconds,
        speechSourcePolicy: {
          mode: 'signed-url-v1' as const,
          allowedOrigin: 'https://project.supabase.co',
          allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/${SESSION}/`,
        },
      });
    }
    return ok({
      transport: 'mistral-pcm' as const,
      websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
      companyId: 'company-1',
      ticket: 'A'.repeat(43),
      protocol: MISTRAL_PCM_UPLINK_PROTOCOL,
      ticketExpiresAt: new Date(NOW + 30_000).toISOString(),
      maxAudioBytes: 1_920_000,
      contextRevision: request.context.revision,
      contextDigest: CONTEXT_DIGEST,
      sessionHandle: request.sessionHandle ?? SESSION,
      hardExpiresAt: new Date(NOW + 60_000).toISOString(),
      model: input.mismatch ? 'another-model' : NEGOTIATION.model,
      voice: NEGOTIATION.voice,
      configVersion: NEGOTIATION.configVersion,
      maxSessionSeconds: NEGOTIATION.maxSessionSeconds,
      speechSourcePolicy: {
        mode: 'signed-url-v1' as const,
        allowedOrigin: 'https://project.supabase.co',
        allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/${SESSION}/`,
      },
    });
  });
  const hangup = vi.fn(async () => ok({ ended: true as const }));
  const transport = new MistralRealtimeTransport(
    {
      createRealtimeVoiceCall: createCall,
      hangupRealtimeVoiceCall: hangup,
    },
    NEGOTIATION,
    {
      getInitialContext: () => CONTEXT,
      createIdentifier: () => SESSION,
      now: () => NOW,
      audioCoordinator: audio,
      requestMicrophonePermission: async () => input.permission !== false,
      createCapture: () => (input.capture === false ? null : capture),
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    },
  );
  return {
    transport,
    socket,
    capture,
    startCapture,
    stopCapture,
    audio,
    release,
    createCall,
    hangup,
    getCaptureInput: () => captureInput,
  };
}

async function connect(h: ReturnType<typeof harness>): Promise<void> {
  const pending = h.transport.connect();
  await eventually(() => h.createCall.mock.calls.length === 1);
  await eventually(() => h.socket.binaryType === 'arraybuffer');
  h.socket.open();
  await Promise.resolve();
  ready(h.socket);
  await pending;
}

describe('MistralRealtimeTransport', () => {
  it('publie r1, garde le micro fermé jusqu’au fence puis commit sans couper le downlink audité', async () => {
    const h = harness();
    const events: RealtimeTransportEvent[] = [];
    h.transport.subscribe((event) => events.push(event));
    await connect(h);

    expect(h.createCall).toHaveBeenCalledWith(
      {
        transport: 'mistral-pcm',
        context: { version: 1, revision: 1, context: CONTEXT },
        sessionHandle: SESSION,
      },
      expect.any(AbortSignal),
    );
    expect(h.startCapture).not.toHaveBeenCalled();
    expect(h.transport.capabilities).toEqual({
      fullDuplex: false,
      bargeIn: false,
      remoteAudio: false,
    });

    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.transport.state.phase === 'user_speaking');
    expect(h.startCapture).toHaveBeenCalledTimes(1);
    expect(h.transport.state.phase).toBe('user_speaking');
    expect(h.getCaptureInput()?.onChunk(Uint8Array.of(1, 0))).toBe(true);

    await expect(h.transport.finishUserInput()).resolves.toBe(true);
    expect(h.stopCapture).toHaveBeenCalledOnce();
    expect(h.transport.state.phase).toBe('ready');

    h.socket.server({ type: 'transcript.final', sequence: 0, text: 'Bonjour Bob', language: 'fr' });
    h.socket.server({ type: 'complete', sequence: 1 });
    await Promise.resolve();
    expect(events).toContainEqual({ type: 'user_transcript', text: 'Bonjour Bob', final: true });
    expect(events.some((event) => event.type === 'fallback')).toBe(false);

    await h.transport.close('user');
    expect(h.hangup).toHaveBeenCalledWith(SESSION);
    expect(h.release).toHaveBeenCalledWith(expect.objectContaining({ mode: 'realtime' }));
  });

  it('permission refusée : aucun bootstrap/socket/capture et lease toujours rendu', async () => {
    const h = harness({ permission: false });

    await expect(h.transport.connect()).rejects.toMatchObject({ reason: 'microphone_denied' });

    expect(h.createCall).not.toHaveBeenCalled();
    expect(h.startCapture).not.toHaveBeenCalled();
    expect(h.socket.sent).toHaveLength(0);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('module natif absent ou bootstrap en dérive : raccroche et ne démarre jamais le micro', async () => {
    const absent = harness({ capture: false });
    await expect(absent.transport.connect()).rejects.toMatchObject({
      reason: 'native_module_unavailable',
    });
    expect(absent.hangup).toHaveBeenCalledWith(SESSION);
    expect(absent.startCapture).not.toHaveBeenCalled();

    const mismatch = harness({ mismatch: true });
    await expect(mismatch.transport.connect()).rejects.toMatchObject({
      reason: 'bootstrap_failed',
    });
    expect(mismatch.hangup).toHaveBeenCalledWith(SESSION);
    expect(mismatch.startCapture).not.toHaveBeenCalled();
  });

  it('refuse explicitement v2 dans le transport v1 historique', async () => {
    const h = harness({ protocolV2: true });

    await expect(h.transport.connect()).rejects.toMatchObject({ reason: 'bootstrap_failed' });

    expect(h.hangup).toHaveBeenCalledWith(SESSION);
    expect(h.startCapture).not.toHaveBeenCalled();
    expect(h.socket.sent).toHaveLength(0);
  });

  it('navigation pendant un ticket lié au contexte ferme et émet un seul repli', async () => {
    const h = harness();
    const events: RealtimeTransportEvent[] = [];
    h.transport.subscribe((event) => events.push(event));
    await connect(h);

    expect(h.transport.interrupt('navigation')).toBe(true);
    await eventually(() => h.transport.state.phase === 'closed');

    expect(events.filter((event) => event.type === 'fallback')).toEqual([
      { type: 'fallback', reason: 'provider_error' },
    ]);
    expect(h.hangup).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('micro OFF coupe la capture et refuse toute trame tardive sans fermer le downlink', async () => {
    const h = harness();
    const events: RealtimeTransportEvent[] = [];
    h.transport.subscribe((event) => events.push(event));
    await connect(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.transport.state.phase === 'user_speaking');
    const captureInput = h.getCaptureInput();
    expect(captureInput?.onChunk(Uint8Array.of(1, 0))).toBe(true);

    h.transport.setMicrophoneEnabled(false);
    await eventually(() => h.stopCapture.mock.calls.length === 1);

    expect(captureInput?.onChunk(Uint8Array.of(2, 0))).toBe(false);
    expect(events.some((event) => event.type === 'fallback')).toBe(false);
    expect(h.hangup).not.toHaveBeenCalled();
    await h.transport.close('user');
  });

  it('micro OFF pendant prepare natif fence sa resolution tardive sans faux fallback', async () => {
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const h = harness({ captureGate });
    const events: RealtimeTransportEvent[] = [];
    h.transport.subscribe((event) => events.push(event));
    await connect(h);

    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.startCapture.mock.calls.length === 1);
    h.transport.setMicrophoneEnabled(false);
    releaseCapture();
    await eventually(() => h.stopCapture.mock.calls.length === 1);

    expect(h.transport.state.phase).toBe('ready');
    expect(events.some((event) => event.type === 'fallback')).toBe(false);
    expect(h.getCaptureInput()?.onChunk(Uint8Array.of(1, 0))).toBe(false);
    await h.transport.close('user');
  });

  it('attend la preuve de stop avant de rouvrir le micro', async () => {
    let confirmStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      confirmStop = resolve;
    });
    const h = harness({ stopCapture: () => stopGate });
    await connect(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.transport.state.phase === 'user_speaking');

    h.transport.setMicrophoneEnabled(false);
    h.transport.setMicrophoneEnabled(false);
    h.transport.setMicrophoneEnabled(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.startCapture).toHaveBeenCalledTimes(1);
    expect(h.transport.state.phase).toBe('user_speaking');

    confirmStop();
    await eventually(() => h.startCapture.mock.calls.length === 2);
    await eventually(() => h.transport.state.phase === 'user_speaking');
    expect(h.stopCapture).toHaveBeenCalledTimes(1);
    await h.transport.close('user');
  });

  it('garde le lease et rejette close si le stop micro n’est jamais confirmé', async () => {
    const h = harness({
      stopCapture: async () => {
        throw new Error('native secret must not leak');
      },
    });
    const events: RealtimeTransportEvent[] = [];
    h.transport.subscribe((event) => events.push(event));
    await connect(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.transport.state.phase === 'user_speaking');

    h.transport.setMicrophoneEnabled(false);
    await eventually(() => events.some((event) => event.type === 'fallback'));

    await expect(h.transport.close('fallback')).rejects.toMatchObject({
      name: 'RealtimeTransportError',
      reason: 'provider_error',
      message: 'provider_error',
    });
    expect(events.filter((event) => event.type === 'fallback')).toEqual([
      { type: 'fallback', reason: 'provider_error' },
    ]);
    expect(events).toContainEqual({ type: 'error', code: 'capture_stop_unconfirmed' });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.hangup).toHaveBeenCalledWith(SESSION);
    expect(h.transport.state.phase).toBe('closing');
    await expect(h.transport.connect()).rejects.toMatchObject({ reason: 'bootstrap_failed' });
    expect(h.createCall).toHaveBeenCalledTimes(1);
  });

  it('raccroche aussi apres un bootstrap serveur qui se termine tardivement', async () => {
    let releaseCall!: () => void;
    const createCallGate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const h = harness({ createCallGate });
    const pending = h.transport.connect();
    await eventually(() => h.createCall.mock.calls.length === 1);

    await h.transport.close('background');
    releaseCall();

    await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
    // 1er hangup pendant l'intention de fermeture, 2e apres le commit tardif possible.
    expect(h.hangup).toHaveBeenCalledTimes(2);
    expect(h.hangup).toHaveBeenNthCalledWith(1, SESSION);
    expect(h.hangup).toHaveBeenNthCalledWith(2, SESSION);
    expect(h.startCapture).not.toHaveBeenCalled();
  });
});
