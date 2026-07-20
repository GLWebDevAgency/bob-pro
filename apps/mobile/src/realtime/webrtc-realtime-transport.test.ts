import type { BobClient } from '@bob/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAudioSession, type ProcessAudioLease } from '../audio';
import type { WebRtcRuntime } from './webrtc-runtime';
import {
  RealtimeWebRtcTransport,
  type RealtimeWebRtcNegotiation,
} from './webrtc-realtime-transport';

const uuidState = vi.hoisted(() => ({ sequence: 0 }));
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    uuidState.sequence += 1;
    return `00000000-0000-4000-8000-${uuidState.sequence.toString().padStart(12, '0')}`;
  },
}));

class FakeEventSource {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  protected emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeTrack {
  readonly kind = 'audio';
  enabled = true;
  stopCalls = 0;

  stop(): void {
    this.stopCalls += 1;
    this.enabled = false;
  }
}

class FakeTransceiver {
  direction = 'sendonly';
  currentDirection: string | null = 'sendonly';
  stopped = false;
  stopCalls = 0;
  readonly sender: { track: FakeTrack };
  readonly receiver: { track: FakeTrack | null } = { track: null };

  constructor(track: FakeTrack, direction: string) {
    this.direction = direction;
    this.currentDirection = direction;
    this.sender = { track };
  }

  stop(): void {
    this.stopCalls += 1;
    this.stopped = true;
    this.direction = 'stopped';
    this.currentDirection = 'stopped';
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  readonly releaseArguments: boolean[] = [];

  getAudioTracks(): FakeTrack[] { return [this.track]; }
  getTracks(): FakeTrack[] { return [this.track]; }
  release(releaseTracks = true): void { this.releaseArguments.push(releaseTracks); }
}

class FakeDataChannel extends FakeEventSource {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  readonly sent: Array<Record<string, unknown>> = [];

  send(value: string): void {
    if (this.readyState !== 'open') throw new Error('channel closed');
    this.sent.push(JSON.parse(value) as Record<string, unknown>);
  }

  open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.emit('open');
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close');
  }

  closeSilently(): void {
    this.readyState = 'closed';
  }

  receive(event: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(event) });
  }

  receiveRaw(data: string): void {
    this.emit('message', { data });
  }
}

class FakePeer extends FakeEventSource {
  connectionState: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed' = 'new';
  iceConnectionState: 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed' = 'new';
  localDescription: { type: 'offer'; sdp: string } | null = null;
  readonly channel = new FakeDataChannel();
  private stats = new Map<string, unknown>();
  setLocalDescriptionCalls = 0;
  setRemoteDescriptionCalls = 0;
  getStatsCalls = 0;
  createOfferOptions: Record<string, unknown> | undefined;
  addTransceiverInit: Record<string, unknown> | undefined;
  transceiver: FakeTransceiver | null = null;

  constructor(private readonly options: {
    closeChannelOnRemote: boolean;
    localDescriptionGate?: Promise<void>;
    remoteDescriptionGate?: Promise<void>;
    offerSdp: string;
  }) { super(); }

  createDataChannel(): FakeDataChannel { return this.channel; }
  addTransceiver(track: FakeTrack, init: Record<string, unknown>): FakeTransceiver {
    this.addTransceiverInit = init;
    this.transceiver = new FakeTransceiver(track, String(init.direction));
    return this.transceiver;
  }
  getTransceivers(): FakeTransceiver[] {
    return this.transceiver ? [this.transceiver] : [];
  }
  async createOffer(options?: Record<string, unknown>): Promise<{ type: 'offer'; sdp: string }> {
    this.createOfferOptions = options;
    return { type: 'offer', sdp: this.options.offerSdp };
  }
  async setLocalDescription(description: { type: 'offer'; sdp: string }): Promise<void> {
    this.setLocalDescriptionCalls += 1;
    await this.options.localDescriptionGate;
    this.localDescription = description;
  }
  async setRemoteDescription(): Promise<void> {
    this.setRemoteDescriptionCalls += 1;
    await this.options.remoteDescriptionGate;
    if (this.options.closeChannelOnRemote) this.channel.closeSilently();
    else this.channel.open();
  }
  async getStats(): Promise<Map<string, unknown>> {
    this.getStatsCalls += 1;
    return this.stats;
  }
  setInboundPackets(packetsReceived: number): void {
    this.stats = new Map([['audio-inbound', {
      type: 'inbound-rtp',
      kind: 'audio',
      packetsReceived,
      packetsLost: 0,
      jitter: 0.004,
    }]]);
  }
  setConnectivity(input: {
    connectionState?: FakePeer['connectionState'];
    iceConnectionState?: FakePeer['iceConnectionState'];
  }): void {
    if (input.connectionState) {
      this.connectionState = input.connectionState;
      this.emit('connectionstatechange');
    }
    if (input.iceConnectionState) {
      this.iceConnectionState = input.iceConnectionState;
      this.emit('iceconnectionstatechange');
    }
  }
  receiveRemoteTrack(track = new FakeTrack()): { track: FakeTrack; transceiver: FakeTransceiver } {
    const transceiver = new FakeTransceiver(track, 'recvonly');
    transceiver.receiver.track = track;
    this.emit('track', {
      track,
      receiver: transceiver.receiver,
      transceiver,
      streams: [],
    });
    return { track, transceiver };
  }
  close(): void { this.connectionState = 'closed'; }
}

interface RuntimeHarness {
  readonly peers: FakePeer[];
  readonly getUserMedia: ReturnType<typeof vi.fn>;
  readonly runtime: WebRtcRuntime;
}

function runtimeHarness(
  getUserMedia: () => Promise<FakeStream>,
  options: {
    closeChannelOnRemote?: boolean;
    localDescriptionGate?: Promise<void>;
    remoteDescriptionGate?: Promise<void>;
    offerSdp?: string;
  } = {},
): RuntimeHarness {
  const peers: FakePeer[] = [];
  const getUserMediaMock = vi.fn(getUserMedia);
  class Peer {
    constructor() {
      const peer = new FakePeer({
        closeChannelOnRemote: options.closeChannelOnRemote === true,
        localDescriptionGate: options.localDescriptionGate,
        remoteDescriptionGate: options.remoteDescriptionGate,
        offerSdp: options.offerSdp ?? SEND_ONLY_OFFER_SDP,
      });
      peers.push(peer);
      return peer;
    }
  }
  class SessionDescription {
    constructor(readonly init: { type: 'answer'; sdp: string }) {}
  }
  const runtime = {
    RTCPeerConnection: Peer,
    RTCSessionDescription: SessionDescription,
    mediaDevices: { getUserMedia: getUserMediaMock },
  } as unknown as WebRtcRuntime;
  return { peers, getUserMedia: getUserMediaMock, runtime };
}

const SEND_ONLY_OFFER_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=sendonly',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  '',
].join('\r\n');

const RECEIVE_ONLY_ANSWER_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=recvonly',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  '',
].join('\r\n');

const HOSTILE_SEND_RECV_ANSWER_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=sendrecv',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  '',
].join('\r\n');

const realtimeConfig = {
  available: true,
  transport: 'webrtc' as const,
  model: 'gpt-realtime-2.1',
  voice: 'marin' as const,
  configVersion: 'bob-live-webrtc-v1',
  requiresDevelopmentBuild: true as const,
  maxSessionSeconds: 900,
  speechDelivery: 'audited-signed-url-v1' as const,
};

function speechSourcePolicy(sessionHandle: string) {
  return {
    mode: 'signed-url-v1' as const,
    allowedOrigin: 'https://project.supabase.co',
    allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/${sessionHandle}/`,
  };
}

function client(answerSdp = RECEIVE_ONLY_ANSWER_SDP): BobClient {
  return {
    realtimeVoiceConfig: vi.fn(async () => ({ ok: true, value: realtimeConfig })),
    createRealtimeVoiceCall: vi.fn(async (input: { sdp: string; sessionHandle?: string }) => ({
      ok: true,
      value: {
        transport: 'webrtc' as const,
        answerSdp,
        sessionHandle: input.sessionHandle ?? '00000000-0000-4000-8000-000000000001',
        hardExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        model: realtimeConfig.model,
        voice: realtimeConfig.voice,
        configVersion: realtimeConfig.configVersion,
        maxSessionSeconds: realtimeConfig.maxSessionSeconds,
        speechSourcePolicy: speechSourcePolicy(
          input.sessionHandle ?? '00000000-0000-4000-8000-000000000001',
        ),
      },
    })),
    hangupRealtimeVoiceCall: vi.fn(async () => ({ ok: true, value: { ended: true as const } })),
  } as unknown as BobClient;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition de test non atteinte');
}

const transports: RealtimeWebRtcTransport[] = [];
const testAudioLeases: ProcessAudioLease[] = [];

function transport(
  bobClient: BobClient,
  harness: RuntimeHarness,
  negotiation: RealtimeWebRtcNegotiation = realtimeConfig,
): RealtimeWebRtcTransport {
  const value = new RealtimeWebRtcTransport(
    bobClient,
    negotiation,
    { loadRuntime: () => harness.runtime },
  );
  transports.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((value) => value.close('unmount')));
  for (const lease of testAudioLeases.splice(0)) processAudioSession.release(lease);
  vi.useRealTimers();
});

describe('RealtimeWebRtcTransport — courses et autorite serveur', () => {
  it('refuse un plan non éligible avant lease audio, permission micro et appel provider', async () => {
    const bobClient = client();
    vi.mocked(bobClient.realtimeVoiceConfig).mockResolvedValueOnce({
      ok: true,
      value: { ...realtimeConfig, available: false, availabilityReason: 'not_entitled' },
    });
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(
      bobClient,
      harness,
      { ...realtimeConfig, available: false, availabilityReason: 'not_entitled' },
    );

    await expect(value.connect()).rejects.toMatchObject({ reason: 'not_entitled' });

    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(bobClient.createRealtimeVoiceCall).not.toHaveBeenCalled();
    expect(processAudioSession.snapshot().active).toBeNull();
  });

  it('un close réentrant sur START interdit tout probe réseau et tout lease audio', async () => {
    const bobClient = client();
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(bobClient, harness);
    let closing: Promise<void> | null = null;
    value.subscribe((event) => {
      if (event.type === 'state' && event.state.phase === 'authorizing' && closing === null) {
        closing = value.close('background');
      }
    });

    await expect(value.connect()).rejects.toMatchObject({ reason: 'aborted' });
    await closing;

    expect(bobClient.realtimeVoiceConfig).not.toHaveBeenCalled();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(processAudioSession.snapshot().active).toBeNull();
    expect(value.state.phase).toBe('closed');
  });

  it('un close réentrant sur CONNECTED ne laisse ni timer ni succès bootstrap fantôme', async () => {
    vi.useFakeTimers();
    const bobClient = client();
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(bobClient, harness);
    let closing: Promise<void> | null = null;
    value.subscribe((event) => {
      if (event.type === 'state' && event.state.phase === 'ready' && closing === null) {
        closing = value.close('background');
      }
    });

    await expect(value.connect()).rejects.toMatchObject({ reason: 'aborted' });
    await closing;
    await vi.advanceTimersByTimeAsync(6_000);

    expect(harness.peers[0]!.getStatsCalls).toBe(0);
    expect(bobClient.hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
    expect(value.state.phase).toBe('closed');
  });

  it('une fermeture pendant l attente du lease audio ne ressuscite jamais le peer', async () => {
    const preemption = deferred<void>();
    let preemptCalls = 0;
    let legacyLease: ProcessAudioLease | null = null;
    const legacy = await processAudioSession.acquire({
      owner: 'test-legacy-recorder',
      mode: 'legacy_input',
      onPreempt: async () => {
        preemptCalls += 1;
        await preemption.promise;
        processAudioSession.release(legacyLease);
      },
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error('lease audio de test indisponible');
    legacyLease = legacy.lease;
    testAudioLeases.push(legacy.lease);

    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    const connecting = value.connect().then(
      () => null,
      (error: unknown) => error,
    );
    await waitUntil(() => preemptCalls === 1);

    await value.close('background');
    preemption.resolve(undefined);

    await expect(connecting).resolves.toMatchObject({ reason: 'aborted' });
    expect(value.state.phase).toBe('closed');
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(processAudioSession.snapshot().active).toBeNull();
  });

  it('libere le owner apres un signal deja annule et libere les pistes natives avec release(true)', async () => {
    const firstHarness = runtimeHarness(async () => new FakeStream());
    const first = transport(client(), firstHarness);
    const abort = new AbortController();
    abort.abort();

    await expect(first.connect({ signal: abort.signal })).rejects.toMatchObject({ reason: 'aborted' });

    const secondStream = new FakeStream();
    const secondHarness = runtimeHarness(async () => secondStream);
    const secondClient = client();
    const second = transport(secondClient, secondHarness);
    await second.connect();
    expect(second.state.phase).toBe('ready');

    await second.close('user');
    await second.close('user');
    expect(secondStream.track.stopCalls).toBe(1);
    expect(secondStream.releaseArguments).toEqual([true]);
    const sessionHandle = vi.mocked(secondClient.createRealtimeVoiceCall).mock.calls[0]?.[0].sessionHandle;
    expect(sessionHandle).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.getSessionHandle()).toBeNull();
    expect(secondClient.hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
    expect(secondClient.hangupRealtimeVoiceCall).toHaveBeenCalledWith(sessionHandle);
  });

  it.each([
    [
      'track.stop',
      (stream: FakeStream, _peer: FakePeer) => {
        vi.spyOn(stream.track, 'stop').mockImplementationOnce(() => {
          throw new Error('track stop failed');
        });
      },
    ],
    [
      'MediaStream.release',
      (stream: FakeStream, _peer: FakePeer) => {
        vi.spyOn(stream, 'release').mockImplementationOnce(() => {
          throw new Error('stream release failed');
        });
      },
    ],
    [
      'RTCPeerConnection.close',
      (_stream: FakeStream, peer: FakePeer) => {
        vi.spyOn(peer, 'close').mockImplementationOnce(() => {
          throw new Error('peer close failed');
        });
      },
    ],
  ] as const)(
    'conserve le lease et bloque tout fallback si %s ne confirme pas la fermeture',
    async (_label, injectFailure) => {
      const stream = new FakeStream();
      const harness = runtimeHarness(async () => stream);
      const value = transport(client(), harness);
      await value.connect();
      const peer = harness.peers[0];
      if (!peer) throw new Error('peer de test absent');
      injectFailure(stream, peer);

      await expect(value.close('fallback')).rejects.toMatchObject({ reason: 'provider_error' });
      expect(value.state.phase).toBe('closing');
      expect(processAudioSession.snapshot().active).toMatchObject({
        owner: 'bob-live-webrtc',
        mode: 'realtime',
      });

      // Le bridge simulé redevient disponible au second essai : le même owner finit sa
      // fermeture avant que le lease soit rendu au processus.
      await expect(value.close('fallback')).resolves.toBeUndefined();
      expect(value.state.phase).toBe('closed');
      expect(processAudioSession.snapshot().active).toBeNull();
    },
  );

  it('une tentative obsolete ne ferme pas la nouvelle et libere son stream tardif', async () => {
    const delayed = deferred<FakeStream>();
    const staleStream = new FakeStream();
    const currentStream = new FakeStream();
    let capture = 0;
    const harness = runtimeHarness(async () => {
      capture += 1;
      return capture === 1 ? delayed.promise : currentStream;
    });
    const value = transport(client(), harness);
    const staleResult = value.connect().then(
      () => null,
      (error: unknown) => error,
    );
    await waitUntil(() => harness.getUserMedia.mock.calls.length === 1);

    await value.close('user');
    await value.connect();
    expect(value.state.phase).toBe('ready');

    delayed.resolve(staleStream);
    await expect(staleResult).resolves.toMatchObject({ reason: 'aborted' });
    expect(value.state.phase).toBe('ready');
    expect(staleStream.releaseArguments).toEqual([true]);
    expect(currentStream.releaseArguments).toEqual([]);

    const concurrent = transport(client(), runtimeHarness(async () => new FakeStream()));
    await expect(concurrent.connect()).rejects.toMatchObject({ reason: 'audio_busy' });
  });

  it('garde le micro fermé jusqu’à une activation explicite après ACK du contexte', async () => {
    const capture = deferred<FakeStream>();
    const stream = new FakeStream();
    const harness = runtimeHarness(() => capture.promise);
    const bobClient = client();
    const value = transport(bobClient, harness);
    const connecting = value.connect();
    await waitUntil(() => harness.getUserMedia.mock.calls.length === 1);

    capture.resolve(stream);
    await connecting;

    expect(stream.track.enabled).toBe(false);
    expect(value.getSessionHandle()).toMatch(/^[0-9a-f-]{36}$/i);
    expect(bobClient.realtimeVoiceConfig).not.toHaveBeenCalled();
    expect(value.getProcessAudioLease()).not.toBeNull();
    expect(value.getSpeechSourcePolicy()).toEqual(
      speechSourcePolicy(value.getSessionHandle()!),
    );
    expect(harness.peers[0]!.addTransceiverInit).toEqual({
      direction: 'sendonly',
      streams: [stream],
    });
    expect(harness.peers[0]!.createOfferOptions).toEqual({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });
    const bootstrapInput = vi.mocked(bobClient.createRealtimeVoiceCall).mock.calls[0]?.[0];
    expect(bootstrapInput && 'sdp' in bootstrapInput ? bootstrapInput.sdp : null)
      .toBe(SEND_ONLY_OFFER_SDP);
    value.setMicrophoneEnabled(true);
    expect(stream.track.enabled).toBe(true);
  });

  it('refuse une offre locale qui ne prouve pas un unique micro sendonly', async () => {
    const stream = new FakeStream();
    const bobClient = client();
    const harness = runtimeHarness(
      async () => stream,
      { offerSdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    );
    const value = transport(bobClient, harness);

    await expect(value.connect()).rejects.toMatchObject({ reason: 'bootstrap_failed' });

    expect(bobClient.createRealtimeVoiceCall).not.toHaveBeenCalled();
    expect(harness.peers[0]!.setRemoteDescriptionCalls).toBe(0);
    expect(stream.releaseArguments).toEqual([true]);
    expect(value.state.phase).toBe('closed');
  });

  it('refuse une answer SDP qui autorise un downlink avant de l appliquer au peer', async () => {
    const stream = new FakeStream();
    const bobClient = client(HOSTILE_SEND_RECV_ANSWER_SDP);
    const harness = runtimeHarness(async () => stream);
    const value = transport(bobClient, harness);
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });

    await expect(value.connect()).rejects.toMatchObject({ reason: 'provider_error' });

    expect(harness.peers[0]!.setRemoteDescriptionCalls).toBe(0);
    expect(harness.peers[0]!.channel.readyState).toBe('closed');
    expect(stream.releaseArguments).toEqual([true]);
    expect(value.state).toMatchObject({ phase: 'closed', fallbackReason: 'provider_error' });
    expect(bobClient.hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
    expect(errors).toContain('provider_downlink_rejected');
  });

  it('stoppe et clôt immédiatement une piste hostile pendant la négociation', async () => {
    const remoteDescription = deferred<void>();
    const stream = new FakeStream();
    const bobClient = client();
    const harness = runtimeHarness(
      async () => stream,
      { remoteDescriptionGate: remoteDescription.promise },
    );
    const value = transport(bobClient, harness);
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });
    const connecting = value.connect().then(
      () => null,
      (error: unknown) => error,
    );
    await waitUntil(() => harness.peers[0]?.setRemoteDescriptionCalls === 1);

    const hostile = harness.peers[0]!.receiveRemoteTrack();
    await waitUntil(() => vi.mocked(bobClient.hangupRealtimeVoiceCall).mock.calls.length === 1);

    expect(hostile.track.stopCalls).toBe(1);
    expect(hostile.transceiver.stopCalls).toBe(1);
    expect(harness.peers[0]!.channel.readyState).toBe('closed');
    expect(value.state).toMatchObject({ phase: 'closed', fallbackReason: 'provider_error' });
    expect(errors).toContain('provider_downlink_rejected');

    remoteDescription.resolve(undefined);
    await expect(connecting).resolves.toMatchObject({ reason: 'aborted' });
    expect(stream.releaseArguments).toEqual([true]);
    expect(bobClient.hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
  });

  it('stoppe et clôt immédiatement une piste hostile après ouverture du data channel', async () => {
    const bobClient = client();
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(bobClient, harness);
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });
    await value.connect();
    expect(value.sendUserText('Le canal de contrôle reste actif')).toBe(true);

    const hostile = harness.peers[0]!.receiveRemoteTrack();
    await waitUntil(() => vi.mocked(bobClient.hangupRealtimeVoiceCall).mock.calls.length === 1);

    expect(hostile.track.stopCalls).toBe(1);
    expect(hostile.transceiver.stopCalls).toBe(1);
    expect(harness.peers[0]!.channel.readyState).toBe('closed');
    expect(value.state).toMatchObject({ phase: 'closed', fallbackReason: 'provider_error' });
    expect(errors).toContain('provider_downlink_rejected');
    expect(bobClient.hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
  });

  it('neutralise une piste distante tardive sans fermer le peer de reconnexion', async () => {
    const bobClient = client();
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(bobClient, harness);
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });
    await value.connect();
    const stalePeer = harness.peers[0];
    if (!stalePeer) throw new Error('peer initial absent');
    await value.close('fallback');
    await value.connect();

    const hostile = stalePeer.receiveRemoteTrack();

    expect(hostile.track.stopCalls).toBe(1);
    expect(hostile.transceiver.stopCalls).toBe(1);
    expect(value.state.phase).toBe('ready');
    expect(harness.peers).toHaveLength(2);
    expect(errors).not.toContain('provider_downlink_rejected');
  });

  it('ne crée aucun appel serveur si la fermeture gagne pendant setLocalDescription', async () => {
    const localDescription = deferred<void>();
    const bobClient = client();
    const harness = runtimeHarness(
      async () => new FakeStream(),
      { localDescriptionGate: localDescription.promise },
    );
    const value = transport(bobClient, harness);
    const connecting = value.connect().then(
      () => null,
      (error: unknown) => error,
    );
    await waitUntil(() => harness.peers[0]?.setLocalDescriptionCalls === 1);

    await value.close('background');
    localDescription.resolve(undefined);

    await expect(connecting).resolves.toMatchObject({ reason: 'aborted' });
    expect(bobClient.createRealtimeVoiceCall).not.toHaveBeenCalled();
    expect(bobClient.hangupRealtimeVoiceCall).not.toHaveBeenCalled();
    expect(value.state.phase).toBe('closed');
  });

  it('attend la description distante avant le canal et echoue proprement si celui-ci est ferme', async () => {
    const stream = new FakeStream();
    const harness = runtimeHarness(async () => stream, { closeChannelOnRemote: true });
    const value = transport(client(), harness);

    await expect(value.connect()).rejects.toMatchObject({ reason: 'provider_error' });
    expect(value.state.phase).toBe('closed');
    expect(stream.releaseArguments).toEqual([true]);
  });

  it('annule le POST et raccroche avec le handle connu si l utilisateur ferme pendant le bootstrap', async () => {
    const bootstrap = deferred<Awaited<ReturnType<BobClient['createRealtimeVoiceCall']>>>();
    let receivedSignal: AbortSignal | undefined;
    const createRealtimeVoiceCall = vi.fn((
      _input: { sdp: string; sessionHandle?: string },
      signal?: AbortSignal,
    ) => {
      receivedSignal = signal;
      return bootstrap.promise;
    });
    const hangupRealtimeVoiceCall = vi.fn(async () => ({ ok: true as const, value: { ended: true as const } }));
    const bobClient = {
      realtimeVoiceConfig: vi.fn(async () => ({ ok: true as const, value: realtimeConfig })),
      createRealtimeVoiceCall,
      hangupRealtimeVoiceCall,
    } as unknown as BobClient;
    const stream = new FakeStream();
    const harness = runtimeHarness(async () => stream);
    const value = transport(bobClient, harness);
    const connecting = value.connect().then(
      () => null,
      (error: unknown) => error,
    );
    await waitUntil(() => createRealtimeVoiceCall.mock.calls.length === 1);
    const handle = createRealtimeVoiceCall.mock.calls[0]?.[0].sessionHandle;

    await value.close('user');

    expect(receivedSignal?.aborted).toBe(true);
    expect(hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
    expect(hangupRealtimeVoiceCall).toHaveBeenCalledWith(handle);
    bootstrap.resolve({
      ok: true,
      value: {
        transport: 'webrtc',
        answerSdp: RECEIVE_ONLY_ANSWER_SDP,
        sessionHandle: handle!,
        hardExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        model: realtimeConfig.model,
        voice: realtimeConfig.voice,
        configVersion: realtimeConfig.configVersion,
        maxSessionSeconds: realtimeConfig.maxSessionSeconds,
        speechSourcePolicy: speechSourcePolicy(handle!),
      },
    });
    await expect(connecting).resolves.toMatchObject({ reason: 'aborted' });
    expect(stream.track.stopCalls).toBe(1);
    expect(stream.releaseArguments).toEqual([true]);
  });

  it('absorbe un échec synchrone de hangup sans doubler la fermeture locale', async () => {
    const bobClient = client();
    const hangup = vi.fn(() => { throw new Error('réseau indisponible'); });
    bobClient.hangupRealtimeVoiceCall = hangup as BobClient['hangupRealtimeVoiceCall'];
    const stream = new FakeStream();
    const harness = runtimeHarness(async () => stream);
    const value = transport(bobClient, harness);
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });
    await value.connect();

    await expect(value.close('user')).resolves.toBeUndefined();
    await expect(value.close('user')).resolves.toBeUndefined();

    expect(hangup).toHaveBeenCalledOnce();
    expect(stream.track.stopCalls).toBe(1);
    expect(errors).toContain('server_hangup_pending');
  });

  it('annule une reconnexion en attente du hangup si l app passe en arrière-plan', async () => {
    const hangupGate = deferred<{ ok: true; value: { ended: true } }>();
    const bobClient = client();
    bobClient.hangupRealtimeVoiceCall = vi.fn(() => hangupGate.promise);
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(bobClient, harness);
    await value.connect();

    const firstClose = value.close('user');
    const reconnecting = value.connect().then(
      () => null,
      (error: unknown) => error,
    );
    const backgroundClose = value.close('background');

    await expect(reconnecting).resolves.toMatchObject({ reason: 'aborted' });
    expect(bobClient.createRealtimeVoiceCall).toHaveBeenCalledOnce();

    hangupGate.resolve({ ok: true, value: { ended: true } });
    await Promise.all([firstClose, backgroundClose]);
    expect(value.state.phase).toBe('closed');
  });

  it('publie CLOSED seulement après avoir armé le gate de hangup', async () => {
    const hangupGate = deferred<{ ok: true; value: { ended: true } }>();
    const bobClient = client();
    bobClient.hangupRealtimeVoiceCall = vi.fn(() => hangupGate.promise);
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(bobClient, harness);
    let reconnecting: Promise<void> | null = null;
    value.subscribe((event) => {
      if (event.type === 'state' && event.state.phase === 'closed' && reconnecting === null) {
        reconnecting = value.connect();
      }
    });
    await value.connect();

    const closing = value.close('user');
    await Promise.resolve();
    expect(reconnecting).not.toBeNull();
    expect(bobClient.createRealtimeVoiceCall).toHaveBeenCalledOnce();

    hangupGate.resolve({ ok: true, value: { ended: true } });
    await closing;
    await reconnecting;
    expect(bobClient.createRealtimeVoiceCall).toHaveBeenCalledTimes(2);
    expect(value.state.phase).toBe('ready');
  });

  it('laisse le sideband creer les reponses et n interrompt que si une reponse est active', async () => {
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    await value.connect();
    const channel = harness.peers[0]!.channel;

    expect(value.sendUserText('  Prepare un devis  ')).toBe(true);
    expect(channel.sent.map((event) => event.type)).toEqual(['conversation.item.create']);
    expect(value.interrupt('tap')).toBe(false);

    channel.receive({ type: 'response.created', response: { id: 'resp_tap' } });
    expect(value.interrupt('tap')).toBe(true);
    expect(channel.sent.map((event) => event.type)).toEqual([
      'conversation.item.create',
      'response.cancel',
      'output_audio_buffer.clear',
    ]);
    expect(channel.sent.find((event) => event.type === 'response.cancel')).toMatchObject({
      response_id: 'resp_tap',
    });

    channel.receive({ type: 'response.done', response: { id: 'resp_tap', status: 'cancelled' } });
    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_tap' });
    expect(value.interrupt('tap')).toBe(false);
  });

  it('reste interruptible tant que le buffer WebRTC est audible après response.done', async () => {
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    await value.connect();
    const channel = harness.peers[0]!.channel;

    channel.receive({ type: 'response.created', response: { id: 'resp_audible' } });
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_audible' });
    channel.receive({ type: 'response.done', response: { id: 'resp_audible', status: 'completed' } });
    expect(value.state.phase).toBe('bob_speaking');

    expect(value.interrupt('tap')).toBe(true);
    expect(channel.sent.map((event) => event.type)).toEqual(['output_audio_buffer.clear']);
    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_audible' });
    expect(value.state.phase).toBe('ready');
    expect(value.interrupt('tap')).toBe(false);
  });

  it('ne publie qu’une référence ACK sans effet UI après réponse complétée et audio drainé', async () => {
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    const candidates: unknown[] = [];
    value.subscribe((event) => {
      if (event.type === 'agent_control_candidate') candidates.push(event.reference);
    });
    await value.connect();
    const channel = harness.peers[0]!.channel;
    const response = {
      id: 'resp_control',
      metadata: {
        bob_response_nonce: 'a'.repeat(32),
        bob_turn_id: '00000000-0000-4000-8000-000000000010',
        bob_turn_kind: 'proposed',
        bob_proposal_id: '00000000-0000-4000-8000-000000000011',
        bob_proposal_expires_at: '2026-07-13T20:00:00.000Z',
        bob_context_revision: '7',
        bob_context_digest: 'b'.repeat(64),
      },
    };

    channel.receive({ type: 'response.created', response });
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_control' });
    expect(candidates).toEqual([]);
    channel.receive({
      type: 'response.done',
      response: { id: 'resp_control', status: 'completed' },
    });
    expect(candidates).toEqual([]);
    channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_control' });
    expect(candidates).toEqual([
      expect.objectContaining({
        turnId: '00000000-0000-4000-8000-000000000010',
        contextRevision: 7,
        contextDigest: 'b'.repeat(64),
      }),
    ]);
    expect(JSON.stringify(candidates)).not.toContain('proposalId');
    expect(JSON.stringify(candidates)).not.toContain('/devis/new');

    channel.receive({ type: 'response.created', response: { ...response, id: 'resp_cancelled_control' } });
    channel.receive({
      type: 'response.done',
      response: { id: 'resp_cancelled_control', status: 'cancelled' },
    });
    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_cancelled_control' });
    expect(candidates).toHaveLength(1);
  });

  it('coupe immédiatement une réponse OOB côté client au début du barge-in VAD', async () => {
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    await value.connect();
    const channel = harness.peers[0]!.channel;

    channel.receive({ type: 'response.created', response: { id: 'resp_vad' } });
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_vad' });
    channel.receive({ type: 'input_audio_buffer.speech_started' });
    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_vad' });

    expect(channel.sent.map((event) => event.type)).toEqual([
      'response.cancel',
      'output_audio_buffer.clear',
    ]);
    expect(channel.sent[0]).toMatchObject({ response_id: 'resp_vad' });
    expect(value.metricsSnapshot().bargeInToAudioClearedMs).not.toBeNull();
    expect(value.state.phase).toBe('user_speaking');
    channel.receive({ type: 'input_audio_buffer.speech_stopped' });
    expect(value.state.phase).toBe('ready');
  });

  it('ignore un accusé audio tardif d’une ancienne réponse quand la suivante parle', async () => {
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    await value.connect();
    const channel = harness.peers[0]!.channel;

    channel.receive({ type: 'response.created', response: { id: 'resp_old' } });
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_old' });
    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_old' });
    channel.receive({ type: 'response.created', response: { id: 'resp_new' } });
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_new' });
    expect(value.state.phase).toBe('bob_speaking');

    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_old' });
    expect(value.state.phase).toBe('bob_speaking');
    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_new' });
    expect(value.state.phase).toBe('ready');
  });

  it('ferme si getStats révèle un paquet audio entrant avant l événement track', async () => {
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });
    await value.connect();
    const peer = harness.peers[0]!;
    peer.setInboundPackets(1);
    peer.channel.receive({ type: 'input_audio_buffer.speech_stopped' });
    await waitUntil(() => value.state.phase === 'closed');

    expect(value.state.fallbackReason).toBe('provider_error');
    expect(value.metricsSnapshot().speechStoppedToFirstInboundRtpMs).toBeNull();
    expect(errors).toContain('provider_downlink_rejected');
  });

  it('tolère un receiver WebRTC sans paquet et maintient le canal de contrôle', async () => {
    vi.useFakeTimers();
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    await value.connect();
    const peer = harness.peers[0]!;
    peer.setInboundPackets(0);

    peer.channel.receive({ type: 'input_audio_buffer.speech_stopped' });
    await vi.advanceTimersByTimeAsync(500);

    expect(value.state.phase).toBe('ready');
    expect(value.metricsSnapshot().speechStoppedToFirstInboundRtpMs).toBeNull();
    expect(value.sendUserText('Le canal reste utilisable')).toBe(true);
  });

  it('publie les transitions de connectivité dédupliquées et clôt sur échec ICE', async () => {
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    const states: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'connectivity') states.push(event.state);
    });
    await value.connect();
    const peer = harness.peers[0]!;

    peer.setConnectivity({ connectionState: 'connected', iceConnectionState: 'connected' });
    peer.setConnectivity({ iceConnectionState: 'disconnected' });
    peer.setConnectivity({ connectionState: 'disconnected' });
    peer.setConnectivity({ connectionState: 'connected', iceConnectionState: 'connected' });

    expect(states).toEqual(['connected', 'disconnected', 'connected']);

    peer.setConnectivity({ iceConnectionState: 'failed' });
    await waitUntil(() => value.state.phase === 'closed');
    expect(value.state.fallbackReason).toBe('ice_failed');
  });

  it('observe une erreur provider récupérable mais ferme sur trame protocolaire corrompue', async () => {
    const harness = runtimeHarness(async () => new FakeStream());
    const value = transport(client(), harness);
    await value.connect();

    harness.peers[0]!.channel.receive({ type: 'error', error: { code: 'server_error' } });
    await Promise.resolve();
    expect(value.state.phase).toBe('ready');

    harness.peers[0]!.channel.receiveRaw('{');

    await waitUntil(() => value.state.phase === 'closed');
    expect(value.state.fallbackReason).toBe('provider_error');
  });
});
