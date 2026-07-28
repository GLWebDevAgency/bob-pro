import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type BobClient,
  type RealtimeAgentMissionSession,
  type RealtimeVoiceNativeSpeechDeliveryInput,
} from '@bob/api-client';
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
  readonly kind: 'audio' | 'video';
  enabled = true;
  stopCalls = 0;

  constructor(kind: 'audio' | 'video' = 'audio') {
    this.kind = kind;
  }

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
  receiveRemoteTrack(input: {
    track?: FakeTrack;
    transceiver?: FakeTransceiver;
    receiver?: FakeTransceiver['receiver'] | null;
  } = {}): { track: FakeTrack; transceiver: FakeTransceiver } {
    const track = input.track ?? new FakeTrack();
    const transceiver = input.transceiver ?? this.transceiver ?? new FakeTransceiver(track, 'recvonly');
    transceiver.receiver.track = track;
    this.emit('track', {
      track,
      receiver: input.receiver === undefined ? transceiver.receiver : input.receiver,
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
        offerSdp: options.offerSdp ?? SEND_ONLY_SDP,
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

const SEND_ONLY_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=sendonly',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  '',
].join('\r\n');

const RECEIVE_ONLY_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=recvonly',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  '',
].join('\r\n');

const SEND_RECV_SDP = [
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

const nativeRealtimeConfig = {
  ...realtimeConfig,
  configVersion: 'bob-live-provider-neutral-v4',
  speechDelivery: 'openai-native-webrtc-v1' as const,
};

function speechSourcePolicy(sessionHandle: string) {
  return {
    mode: 'signed-url-v1' as const,
    allowedOrigin: 'https://project.supabase.co',
    allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/${sessionHandle}/`,
  };
}

function missionSessionStub(realtimeSessionId: string) {
  let disposed = false;
  const unused = async (): Promise<never> => {
    throw new Error('unused_agent_mission_method');
  };
  const dispose = vi.fn(() => {
    disposed = true;
  });
  const session = {
    protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
    realtimeSessionId,
    get disposed() {
      return disposed;
    },
    getCurrentQuoteCreation: unused,
    startQuoteCreation: unused,
    cancelQuoteCreation: unused,
    acknowledgeQuoteScreen: unused,
    dispose,
  } as unknown as RealtimeAgentMissionSession;
  return { session, dispose };
}

function client(
  answerSdp = RECEIVE_ONLY_SDP,
  config: RealtimeWebRtcNegotiation = realtimeConfig,
  agentMissionSession: RealtimeAgentMissionSession | null = null,
  includeAgentMissionSession = true,
): BobClient {
  return {
    realtimeVoiceConfig: vi.fn(async () => ({ ok: true, value: config })),
    createRealtimeVoiceCall: vi.fn(async (input: { sdp: string; sessionHandle?: string }) => ({
      ok: true,
      value: {
        transport: 'webrtc' as const,
        answerSdp,
        sessionHandle: input.sessionHandle ?? '00000000-0000-4000-8000-000000000001',
        hardExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        model: config.model,
        voice: config.voice,
        configVersion: config.configVersion,
        maxSessionSeconds: config.maxSessionSeconds,
        speechDelivery: config.speechDelivery,
        ...(includeAgentMissionSession ? { agentMissionSession } : {}),
        ...(config.speechDelivery === 'audited-signed-url-v1'
          ? {
              speechSourcePolicy: speechSourcePolicy(
                input.sessionHandle ?? '00000000-0000-4000-8000-000000000001',
              ),
            }
          : {}),
      },
    })),
    acknowledgeRealtimeVoiceNativeSpeechDelivery: vi.fn(async (
      _sessionHandle: string,
      turnId: string,
      deliveryId: string,
      input: RealtimeVoiceNativeSpeechDeliveryInput,
    ) => ({
      ok: true as const,
      value: {
        deliveryId,
        turnId,
        acknowledgementId: input.acknowledgementId,
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        idempotent: false,
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
    expect(value.capabilities).toEqual({
      fullDuplex: false,
      bargeIn: true,
      remoteAudio: false,
    });
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
    expect(bootstrapInput).toMatchObject({
      transport: 'webrtc',
      configVersion: realtimeConfig.configVersion,
      speechDelivery: realtimeConfig.speechDelivery,
      agentMissionProtocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
    });
    expect(bootstrapInput && 'sdp' in bootstrapInput ? bootstrapInput.sdp : null)
      .toBe(SEND_ONLY_SDP);
    value.setMicrophoneEnabled(true);
    expect(stream.track.enabled).toBe(true);
  });

  it('transfère la capability mission exactement une fois sans la détruire après transfert', async () => {
    const capability = missionSessionStub('00000000-0000-4000-8000-000000000301');
    const bobClient = client(RECEIVE_ONLY_SDP, realtimeConfig, capability.session);
    const value = transport(bobClient, runtimeHarness(async () => new FakeStream()));

    await value.connect();

    expect(value.takeAgentMissionSession()).toBe(capability.session);
    expect(value.takeAgentMissionSession()).toBeNull();
    await value.close('user');
    expect(capability.dispose).not.toHaveBeenCalled();

    capability.session.dispose();
    expect(capability.dispose).toHaveBeenCalledOnce();
  });

  it('détruit synchroniquement une capability non transférée avant d attendre le hangup', async () => {
    const capability = missionSessionStub('00000000-0000-4000-8000-000000000302');
    const hangupGate = deferred<{ ok: true; value: { ended: true } }>();
    const bobClient = client(RECEIVE_ONLY_SDP, realtimeConfig, capability.session);
    bobClient.hangupRealtimeVoiceCall = vi.fn(() => hangupGate.promise);
    const value = transport(bobClient, runtimeHarness(async () => new FakeStream()));
    await value.connect();

    const closing = value.close('background');

    expect(capability.dispose).toHaveBeenCalledOnce();
    expect(capability.session.disposed).toBe(true);
    await waitUntil(() => vi.mocked(bobClient.hangupRealtimeVoiceCall).mock.calls.length === 1);
    expect(bobClient.hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
    hangupGate.resolve({ ok: true, value: { ended: true } });
    await closing;
  });

  it('échoue fermé si le bootstrap omet la négociation mission explicite', async () => {
    const bobClient = client(RECEIVE_ONLY_SDP, realtimeConfig, null, false);
    const value = transport(bobClient, runtimeHarness(async () => new FakeStream()));

    await expect(value.connect()).rejects.toMatchObject({
      reason: 'agent_mission_negotiation_failed',
    });

    expect(value.takeAgentMissionSession()).toBeNull();
    expect(bobClient.hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
    expect(value.state).toMatchObject({
      phase: 'closed',
      fallbackReason: 'agent_mission_negotiation_failed',
    });
  });

  it('après perte de réponse bootstrap, clôt le handle demandé et réserve un nouvel UUID au retry utilisateur', async () => {
    const bobClient = client();
    bobClient.createRealtimeVoiceCall = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'dependency' as const,
        port: 'realtime',
        cause: 'response_lost',
      },
    }));
    const value = transport(bobClient, runtimeHarness(async () => new FakeStream()));

    await expect(value.connect()).rejects.toMatchObject({
      reason: 'agent_mission_negotiation_failed',
    });
    await expect(value.connect()).rejects.toMatchObject({
      reason: 'agent_mission_negotiation_failed',
    });

    const requestedHandles = vi.mocked(bobClient.createRealtimeVoiceCall).mock.calls.map(
      ([input]) => input.sessionHandle,
    );
    expect(requestedHandles).toHaveLength(2);
    expect(requestedHandles[0]).not.toBe(requestedHandles[1]);
    expect(vi.mocked(bobClient.hangupRealtimeVoiceCall).mock.calls.map(([handle]) => handle))
      .toEqual(requestedHandles);
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
    const bobClient = client(SEND_RECV_SDP);
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
    expect(hostile.transceiver.stopCalls).toBe(0);
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
    expect(hostile.transceiver.stopCalls).toBe(0);
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
    expect(hostile.transceiver.stopCalls).toBe(0);
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
        answerSdp: RECEIVE_ONLY_SDP,
        sessionHandle: handle!,
        hardExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        model: realtimeConfig.model,
        voice: realtimeConfig.voice,
        configVersion: realtimeConfig.configVersion,
        maxSessionSeconds: realtimeConfig.maxSessionSeconds,
        speechDelivery: realtimeConfig.speechDelivery,
        agentMissionSession: null,
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

describe('RealtimeWebRtcTransport — downlink OpenAI natif', () => {
  const NATIVE_CONTEXT_REVISION = 7;
  const NATIVE_CONTEXT_DIGEST = 'c'.repeat(64);

  function nativeMetadata(sequence = 21): Record<string, string> {
    const suffix = sequence.toString().padStart(12, '0');
    return {
      bob_protocol: 'bob.openai-native-response.v1',
      bob_delivery_id: `00000000-0000-4000-8000-${suffix}`,
      bob_turn_id: `10000000-0000-4000-8000-${suffix}`,
      bob_context_revision: String(NATIVE_CONTEXT_REVISION),
      bob_context_digest: NATIVE_CONTEXT_DIGEST,
      bob_request_nonce: `request_nonce_${sequence.toString().padStart(20, '0')}`,
    };
  }

  async function connectNative(value: RealtimeWebRtcTransport): Promise<void> {
    await value.connect();
    const sessionHandle = value.getSessionHandle();
    expect(sessionHandle).not.toBeNull();
    await expect(value.synchronizePublishedContext!({
      sessionHandle: sessionHandle!,
      contextRevision: NATIVE_CONTEXT_REVISION,
      contextDigest: NATIVE_CONTEXT_DIGEST,
    })).resolves.toBe(true);
  }

  function startNativeResponse(peer: FakePeer, id: string, sequence = 21): Record<string, unknown> {
    const response = { id, metadata: nativeMetadata(sequence) };
    peer.channel.receive({ type: 'response.created', response });
    return response;
  }

  function finishNativeResponse(
    peer: FakePeer,
    response: Record<string, unknown>,
    status: 'completed' | 'cancelled' | 'failed' | 'incomplete' = 'completed',
  ): void {
    peer.channel.receive({ type: 'response.done', response: { ...response, status } });
  }

  async function prepareAuditableNativeResponse(
    peer: FakePeer,
    id: string,
    sequence: number,
  ): Promise<Record<string, unknown>> {
    if (!peer.transceiver?.receiver.track) peer.receiveRemoteTrack();
    peer.setInboundPackets(0);
    peer.channel.receive({ type: 'input_audio_buffer.speech_started' });
    peer.channel.receive({ type: 'input_audio_buffer.speech_stopped' });
    await Promise.resolve();
    await Promise.resolve();
    const response = startNativeResponse(peer, id, sequence);
    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: id });
    peer.setInboundPackets(4);
    await vi.advanceTimersByTimeAsync(200);
    expect(peer.getStatsCalls).toBeGreaterThan(0);
    return response;
  }

  async function finishAuditableNativeResponse(
    value: RealtimeWebRtcTransport,
    bobClient: BobClient,
    peer: FakePeer,
    id: string,
    sequence: number,
  ): Promise<void> {
    const acknowledgement = vi.mocked(
      bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery,
    );
    const acknowledgementCount = acknowledgement.mock.calls.length;
    const response = await prepareAuditableNativeResponse(peer, id, sequence);
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: id,
      transcript: `Réponse ${sequence}`,
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: id });
    await waitUntil(
      () => acknowledgement.mock.calls.length === acknowledgementCount + 1
        && value.state.phase === 'ready',
    );
  }

  function nativeHarness(): {
    bobClient: BobClient;
    harness: RuntimeHarness;
    value: RealtimeWebRtcTransport;
  } {
    const bobClient = client(SEND_RECV_SDP, nativeRealtimeConfig);
    const harness = runtimeHarness(
      async () => new FakeStream(),
      { offerSdp: SEND_RECV_SDP },
    );
    return {
      bobClient,
      harness,
      value: transport(bobClient, harness, nativeRealtimeConfig),
    };
  }

  it('négocie exactement une m-line sendrecv et n ouvre la piste qu au buffer.started', async () => {
    const { bobClient, harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;

    expect(value.capabilities).toEqual({
      fullDuplex: true,
      bargeIn: true,
      remoteAudio: true,
    });
    expect(value.getSpeechSourcePolicy()).toBeNull();
    expect(peer.addTransceiverInit).toMatchObject({ direction: 'sendrecv' });
    expect(peer.createOfferOptions).toEqual({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    const bootstrapInput = vi.mocked(bobClient.createRealtimeVoiceCall).mock.calls[0]?.[0];
    expect(bootstrapInput).toMatchObject({
      speechDelivery: 'openai-native-webrtc-v1',
      configVersion: nativeRealtimeConfig.configVersion,
      sdp: SEND_RECV_SDP,
    });

    const remote = peer.receiveRemoteTrack();
    expect(remote.transceiver).toBe(peer.transceiver);
    expect(remote.track.enabled).toBe(false);
    peer.channel.receive({ type: 'input_audio_buffer.speech_started' });
    peer.channel.receive({ type: 'input_audio_buffer.speech_stopped' });
    const response = startNativeResponse(peer, 'resp_native');
    peer.channel.receive({ type: 'response.output_audio.delta', response_id: 'resp_native', delta: 'opaque' });
    expect(remote.track.enabled).toBe(false);
    expect(value.state.phase).toBe('ready');
    expect(value.metricsSnapshot().speechStoppedEventToFirstAudioSignalMs).toBeNull();

    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_native' });
    expect(remote.track.enabled).toBe(true);
    expect(value.state.phase).toBe('bob_speaking');
    expect(value.metricsSnapshot().speechStoppedEventToFirstAudioSignalMs).not.toBeNull();

    // OpenAI peut terminer la génération avant que le buffer appareil soit drainé.
    finishNativeResponse(peer, response);
    expect(remote.track.enabled).toBe(true);
    expect(value.state.phase).toBe('bob_speaking');
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_native' });
    expect(remote.track.enabled).toBe(true);
    // Le drain provider seul n'est pas un ACK : sans RTP observé + transcript final, le tour
    // reste fermé et ne publie rien.
    expect(value.state.phase).toBe('bob_speaking');
  });

  it('refuse une answer non sendrecv avant de l appliquer au peer natif', async () => {
    const bobClient = client(RECEIVE_ONLY_SDP, nativeRealtimeConfig);
    const harness = runtimeHarness(
      async () => new FakeStream(),
      { offerSdp: SEND_RECV_SDP },
    );
    const value = transport(bobClient, harness, nativeRealtimeConfig);

    await expect(value.connect()).rejects.toMatchObject({ reason: 'provider_error' });

    expect(harness.peers[0]!.setRemoteDescriptionCalls).toBe(0);
    expect(value.state).toMatchObject({ phase: 'closed', fallbackReason: 'provider_error' });
  });

  it('refuse un tour texte natif avant le réseau plutôt que de fabriquer une origine SLO', async () => {
    const { harness, value } = nativeHarness();
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });
    await connectNative(value);

    expect(value.sendUserText('Crée un devis')).toBe(false);
    expect(harness.peers[0]!.channel.sent).toEqual([]);
    expect(errors).toContain('native_text_input_not_supported');
  });

  it('termine une réponse tool-call sans audio et accepte immédiatement la suivante', async () => {
    const { harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();

    const toolOnly = startNativeResponse(peer, 'resp_tool_only', 22);
    finishNativeResponse(peer, toolOnly);
    expect(value.state.phase).toBe('ready');
    expect(remote.track.enabled).toBe(false);

    startNativeResponse(peer, 'resp_after_tool', 23);
    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_after_tool' });
    expect(value.state.phase).toBe('bob_speaking');
    expect(remote.track.enabled).toBe(true);
  });

  it('ne publie aucun controlReference legacy depuis le contrat natif V1', async () => {
    const { harness, value } = nativeHarness();
    const candidates: unknown[] = [];
    value.subscribe((event) => {
      if (event.type === 'agent_control_candidate') candidates.push(event.reference);
    });
    await connectNative(value);
    const peer = harness.peers[0]!;
    peer.receiveRemoteTrack();
    const response = startNativeResponse(peer, 'resp_native_no_legacy_control', 24);
    finishNativeResponse(peer, response);

    expect(candidates).toEqual([]);
    expect(value.state.phase).toBe('ready');
  });

  it('ferme sur un événement audio d un responseId jamais créé', async () => {
    const { harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    peer.receiveRemoteTrack();
    startNativeResponse(peer, 'resp_known', 42);

    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_unknown' });

    await waitUntil(() => value.state.phase === 'closed');
    expect(value.state.fallbackReason).toBe('provider_error');
  });

  it('ferme si response.done ne répète pas exactement la corrélation native créée', async () => {
    const { harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    startNativeResponse(peer, 'resp_metadata_mismatch', 43);

    peer.channel.receive({
      type: 'response.done',
      response: {
        id: 'resp_metadata_mismatch',
        status: 'completed',
        metadata: nativeMetadata(44),
      },
    });

    await waitUntil(() => value.state.phase === 'closed');
    expect(value.state.fallbackReason).toBe('provider_error');
  });

  it.each([
    [
      'deux m-lines audio',
      `${SEND_RECV_SDP}m=audio 0 UDP/TLS/RTP/SAVPF 111\r\na=inactive\r\n`,
    ],
    [
      'une m-line vidéo active',
      `${SEND_RECV_SDP}m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n`,
    ],
  ] as const)('refuse une offre native avec %s', async (_label, offerSdp) => {
    const bobClient = client(SEND_RECV_SDP, nativeRealtimeConfig);
    const harness = runtimeHarness(async () => new FakeStream(), { offerSdp });
    const value = transport(bobClient, harness, nativeRealtimeConfig);

    await expect(value.connect()).rejects.toMatchObject({ reason: 'bootstrap_failed' });

    expect(bobClient.createRealtimeVoiceCall).not.toHaveBeenCalled();
    expect(value.state.phase).toBe('closed');
  });

  it.each([
    ['vidéo', (peer: FakePeer) => peer.receiveRemoteTrack({ track: new FakeTrack('video') })],
    ['transceiver inattendue', (peer: FakePeer) => {
      const track = new FakeTrack();
      return peer.receiveRemoteTrack({
        track,
        transceiver: new FakeTransceiver(track, 'recvonly'),
      });
    }],
  ] as const)('neutralise une piste %s et ferme uniquement sa génération', async (_label, inject) => {
    const { bobClient, harness, value } = nativeHarness();
    await value.connect();
    const rejected = inject(harness.peers[0]!);

    await waitUntil(() => value.state.phase === 'closed');

    expect(rejected.track.enabled).toBe(false);
    expect(rejected.track.stopCalls).toBe(1);
    expect(value.state.fallbackReason).toBe('provider_error');
    expect(bobClient.hangupRealtimeVoiceCall).toHaveBeenCalledOnce();
  });

  it('refuse une deuxième piste distante au lieu de remplacer silencieusement la première', async () => {
    const { harness, value } = nativeHarness();
    await value.connect();
    const peer = harness.peers[0]!;
    const accepted = peer.receiveRemoteTrack();
    const duplicate = peer.receiveRemoteTrack();

    await waitUntil(() => value.state.phase === 'closed');

    expect(duplicate.track.enabled).toBe(false);
    expect(duplicate.track.stopCalls).toBe(1);
    expect(accepted.track.enabled).toBe(false);
    expect(accepted.track.stopCalls).toBe(1);
    expect(value.state.fallbackReason).toBe('provider_error');
  });

  it('neutralise une track tardive sans jamais fermer le peer natif reconnecté', async () => {
    const { harness, value } = nativeHarness();
    await value.connect();
    const stalePeer = harness.peers[0]!;
    await value.close('fallback');
    await value.connect();
    expect(value.state.phase).toBe('ready');

    const stale = stalePeer.receiveRemoteTrack();

    expect(stale.track.enabled).toBe(false);
    expect(stale.track.stopCalls).toBe(1);
    expect(stale.transceiver.stopCalls).toBe(0);
    expect(value.state.phase).toBe('ready');
    expect(harness.peers).toHaveLength(2);
  });

  it('mute localement avant le réseau et envoie cancel puis clear au plus une fois', async () => {
    const { harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();
    const channel = peer.channel;
    startNativeResponse(peer, 'resp_barge', 25);
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_barge' });
    expect(remote.track.enabled).toBe(true);

    const originalSend = channel.send.bind(channel);
    const enabledAtSend: boolean[] = [];
    let reentered = false;
    vi.spyOn(channel, 'send').mockImplementation((payload: string) => {
      enabledAtSend.push(remote.track.enabled);
      originalSend(payload);
      if (!reentered) {
        reentered = true;
        expect(value.interrupt('tap')).toBe(true);
      }
    });

    expect(value.interrupt('user_speech')).toBe(true);
    expect(value.interrupt('tap')).toBe(true);
    expect(remote.track.enabled).toBe(false);
    expect(enabledAtSend).toEqual([false, false]);
    expect(channel.sent.map((event) => event.type)).toEqual([
      'response.cancel',
      'output_audio_buffer.clear',
    ]);

    // Des signaux tardifs de la réponse coupée ne peuvent jamais rouvrir la piste.
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_barge' });
    expect(remote.track.enabled).toBe(false);
    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_barge' });
    startNativeResponse(peer, 'resp_next', 26);
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_next' });
    expect(remote.track.enabled).toBe(true);
    channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_barge' });
    channel.receive({ type: 'output_audio_buffer.cleared', response_id: 'resp_barge' });
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_barge' });
    expect(remote.track.enabled).toBe(true);

    expect(value.interrupt('tap')).toBe(true);
    expect(remote.track.enabled).toBe(false);
    channel.receive({
      type: 'response.created',
      response: { id: 'resp_barge', metadata: nativeMetadata(25) },
    });
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_barge' });
    expect(remote.track.enabled).toBe(false);
    expect(channel.sent.map((event) => event.type)).toEqual([
      'response.cancel',
      'output_audio_buffer.clear',
      'response.cancel',
      'output_audio_buffer.clear',
    ]);
  });

  it('échoue fermé sans retry si output_audio_buffer.clear ne part pas', async () => {
    const { harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();
    const channel = peer.channel;
    startNativeResponse(peer, 'resp_clear_failure', 27);
    channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_clear_failure' });

    const originalSend = channel.send.bind(channel);
    let clearAttempts = 0;
    let remoteEnabledWhenNetworkWasCalled: boolean | null = null;
    vi.spyOn(channel, 'send').mockImplementation((payload: string) => {
      const decoded = JSON.parse(payload) as { type?: string };
      remoteEnabledWhenNetworkWasCalled = remote.track.enabled;
      if (decoded.type === 'output_audio_buffer.clear') {
        clearAttempts += 1;
        throw new Error('data channel write failed');
      }
      originalSend(payload);
    });

    expect(value.interrupt('tap')).toBe(true);
    await waitUntil(() => value.state.phase === 'closed');

    expect(remoteEnabledWhenNetworkWasCalled).toBe(false);
    expect(clearAttempts).toBe(1);
    expect(channel.sent.map((event) => event.type)).toEqual(['response.cancel']);
    expect(value.interrupt('tap')).toBe(false);
    expect(clearAttempts).toBe(1);
    expect(value.state.fallbackReason).toBe('provider_error');
  });

  it('mesure le RTP entrant natif sans fermer la conversation', async () => {
    vi.useFakeTimers();
    const { harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    peer.receiveRemoteTrack();
    peer.setInboundPackets(0);
    peer.channel.receive({ type: 'input_audio_buffer.speech_started' });
    peer.channel.receive({ type: 'input_audio_buffer.speech_stopped' });
    await Promise.resolve();
    startNativeResponse(peer, 'resp_stats', 28);
    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_stats' });
    peer.setInboundPackets(4);

    await vi.advanceTimersByTimeAsync(200);

    expect(value.state.phase).toBe('bob_speaking');
    expect(value.metricsSnapshot().speechStoppedToFirstInboundRtpMs).not.toBeNull();
    expect(value.metricsSnapshot()).toMatchObject({ jitterMs: 4, packetsLost: 0 });
    expect(value.state.fallbackReason).toBeNull();
  });

  it('prime un baseline RTP frais après buffer.started et refuse les paquets tardifs du tour précédent', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    peer.receiveRemoteTrack();
    peer.setInboundPackets(40);
    peer.channel.receive({ type: 'input_audio_buffer.speech_started' });
    peer.channel.receive({ type: 'input_audio_buffer.speech_stopped' });
    await Promise.resolve();
    await Promise.resolve();

    const response = startNativeResponse(peer, 'resp_fresh_rtp_baseline', 45);
    // Ces paquets arrivent avant l'ouverture du buffer courant : ils appartiennent encore à la
    // queue précédente et ne doivent jamais rendre la nouvelle livraison acquittable.
    peer.setInboundPackets(44);
    await vi.advanceTimersByTimeAsync(100);
    peer.channel.receive({
      type: 'output_audio_buffer.started',
      response_id: 'resp_fresh_rtp_baseline',
    });
    await Promise.resolve();
    await Promise.resolve();
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_fresh_rtp_baseline',
      transcript: 'Baseline frais',
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({
      type: 'output_audio_buffer.stopped',
      response_id: 'resp_fresh_rtp_baseline',
    });
    await vi.advanceTimersByTimeAsync(200);

    const ack = vi.mocked(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery);
    expect(value.metricsSnapshot().speechStoppedToFirstInboundRtpMs).toBeNull();
    expect(ack).not.toHaveBeenCalled();

    peer.setInboundPackets(45);
    await vi.advanceTimersByTimeAsync(100);
    await waitUntil(() => ack.mock.calls.length === 1 && value.state.phase === 'ready');
  });

  it('réarme le probe RTP après un délai provider supérieur au budget sans déplacer l origine speech_stopped', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    peer.receiveRemoteTrack();
    peer.setInboundPackets(10);
    peer.channel.receive({ type: 'input_audio_buffer.speech_started' });
    peer.channel.receive({ type: 'input_audio_buffer.speech_stopped' });

    // La fenêtre de 2,5 s armée au speech_stopped est entièrement expirée avant que le provider
    // n'ouvre sa réponse. Le buffer.started doit en armer une nouvelle, sans réinitialiser le SLO.
    await vi.advanceTimersByTimeAsync(2_600);
    expect(value.metricsSnapshot().speechStoppedToFirstInboundRtpMs).toBeNull();

    const response = startNativeResponse(peer, 'resp_slow_provider', 47);
    peer.channel.receive({
      type: 'output_audio_buffer.started',
      response_id: 'resp_slow_provider',
    });
    await Promise.resolve();
    await Promise.resolve();
    peer.setInboundPackets(11);
    await vi.advanceTimersByTimeAsync(100);
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_slow_provider',
      transcript: 'Réponse après calcul',
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({
      type: 'output_audio_buffer.stopped',
      response_id: 'resp_slow_provider',
    });

    const ack = vi.mocked(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery);
    await waitUntil(() => ack.mock.calls.length === 1 && value.state.phase === 'ready');
    expect(ack.mock.calls[0]?.[3].slo.speechStoppedEventToFirstInboundRtpMs)
      .toBeGreaterThanOrEqual(2_700);
  });

  it('borne à 1,5 s la queue locale préservée après ACK puis mute exactement à échéance', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();

    await finishAuditableNativeResponse(value, bobClient, peer, 'resp_tail_bounded', 48);
    expect(value.state.phase).toBe('ready');
    expect(remote.track.enabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(remote.track.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(remote.track.enabled).toBe(false);
  });

  it('annule le tail du tour précédent et son timer stale avant d ouvrir le suivant', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();

    await finishAuditableNativeResponse(value, bobClient, peer, 'resp_tail_previous', 49);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(remote.track.enabled).toBe(true);

    startNativeResponse(peer, 'resp_tail_next', 50);
    expect(remote.track.enabled).toBe(false);
    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_tail_next' });
    expect(remote.track.enabled).toBe(true);

    // L'ancien timer aurait expiré ici ; son epoch est fencé et ne peut pas muter le nouveau tour.
    await vi.advanceTimersByTimeAsync(500);
    expect(remote.track.enabled).toBe(true);
    expect(value.state.phase).toBe('bob_speaking');
  });

  it.each(['speech', 'context', 'teardown'] as const)(
    'coupe synchroniquement le tail ACK sur %s et neutralise son timer',
    async (invalidation) => {
      vi.useFakeTimers();
      const { bobClient, harness, value } = nativeHarness();
      await connectNative(value);
      const peer = harness.peers[0]!;
      const remote = peer.receiveRemoteTrack();
      const sequence = invalidation === 'speech' ? 51 : invalidation === 'context' ? 52 : 53;
      await finishAuditableNativeResponse(
        value,
        bobClient,
        peer,
        `resp_tail_${invalidation}`,
        sequence,
      );
      expect(remote.track.enabled).toBe(true);

      let pendingClose: Promise<void> | null = null;
      if (invalidation === 'speech') {
        peer.channel.receive({ type: 'input_audio_buffer.speech_started' });
      } else if (invalidation === 'context') {
        const synchronization = value.synchronizePublishedContext!({
          sessionHandle: value.getSessionHandle()!,
          contextRevision: NATIVE_CONTEXT_REVISION + 1,
          contextDigest: 'd'.repeat(64),
        });
        expect(remote.track.enabled).toBe(false);
        await expect(synchronization).resolves.toBe(true);
      } else {
        pendingClose = value.close('background');
      }
      expect(remote.track.enabled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(remote.track.enabled).toBe(false);
      await pendingClose;
    },
  );

  it('ferme après 5 s si stopped arrive sans response.done', async () => {
    vi.useFakeTimers();
    const { harness, value } = nativeHarness();
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();
    startNativeResponse(peer, 'resp_missing_done', 54);
    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_missing_done' });
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_missing_done' });

    await vi.advanceTimersByTimeAsync(2_500);
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_missing_done' });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(value.state.phase).toBe('bob_speaking');
    expect(remote.track.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await waitUntil(() => value.state.phase === 'closed');
    expect(remote.track.enabled).toBe(false);
    expect(errors).toContain('native_speech_response_done_timeout');
  });

  it('laisse jouer une réponse courte puis ferme à 30 s si stopped manque après done', async () => {
    vi.useFakeTimers();
    const { harness, value } = nativeHarness();
    const errors: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'error') errors.push(event.code);
    });
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();
    const response = startNativeResponse(peer, 'resp_missing_stopped', 55);
    peer.channel.receive({
      type: 'output_audio_buffer.started',
      response_id: 'resp_missing_stopped',
    });
    finishNativeResponse(peer, response);

    await vi.advanceTimersByTimeAsync(15_000);
    finishNativeResponse(peer, response);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(value.state.phase).toBe('bob_speaking');
    expect(remote.track.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await waitUntil(() => value.state.phase === 'closed');
    expect(remote.track.enabled).toBe(false);
    expect(errors).toContain('native_speech_audio_stopped_timeout');
  });

  it('annule le watchdog terminal au barge-in et rend son timer stale inerte', async () => {
    vi.useFakeTimers();
    const { harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();
    const response = startNativeResponse(peer, 'resp_watchdog_interrupted', 56);
    peer.channel.receive({
      type: 'output_audio_buffer.started',
      response_id: 'resp_watchdog_interrupted',
    });
    finishNativeResponse(peer, response);
    expect(value.interrupt('tap')).toBe(true);
    expect(remote.track.enabled).toBe(false);
    peer.channel.receive({
      type: 'output_audio_buffer.cleared',
      response_id: 'resp_watchdog_interrupted',
    });
    expect(value.state.phase).toBe('ready');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(value.state.phase).toBe('ready');
    expect(value.state.fallbackReason).toBeNull();
  });

  it.each(['done-puis-stopped', 'stopped-puis-done'] as const)(
    'acquitte une seule fois après RTP + transcript + %s sans publier le transcript fournisseur',
    async (order) => {
      vi.useFakeTimers();
      const { bobClient, harness, value } = nativeHarness();
      const bobTranscripts: Array<{ text: string; final: boolean }> = [];
      value.subscribe((event) => {
        if (event.type === 'bob_transcript') {
          bobTranscripts.push({ text: event.text, final: event.final });
        }
      });
      await connectNative(value);
      const peer = harness.peers[0]!;
      const responseId = `resp_ack_${order}`;
      const response = await prepareAuditableNativeResponse(
        peer,
        responseId,
        order === 'done-puis-stopped' ? 30 : 31,
      );
      peer.channel.receive({
        type: 'response.output_audio_transcript.delta',
        response_id: responseId,
        delta: 'Réponse ',
      });
      peer.channel.receive({
        type: 'response.output_audio_transcript.done',
        response_id: responseId,
        transcript: 'Réponse Bob validée',
      });
      expect(bobTranscripts).toEqual([]);

      if (order === 'done-puis-stopped') {
        finishNativeResponse(peer, response);
        expect(bobTranscripts).toEqual([]);
        peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: responseId });
      } else {
        peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: responseId });
        expect(bobTranscripts).toEqual([]);
        finishNativeResponse(peer, response);
      }
      const ack = vi.mocked(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery);
      await waitUntil(() => ack.mock.calls.length === 1 && value.state.phase === 'ready');
      expect(ack).toHaveBeenCalledOnce();
      expect(ack.mock.calls[0]?.slice(1, 3)).toEqual([
        nativeMetadata(order === 'done-puis-stopped' ? 30 : 31).bob_turn_id,
        nativeMetadata(order === 'done-puis-stopped' ? 30 : 31).bob_delivery_id,
      ]);
      expect(ack.mock.calls[0]?.[3]).toMatchObject({
        contextRevision: NATIVE_CONTEXT_REVISION,
        contextDigest: NATIVE_CONTEXT_DIGEST,
        slo: { speechStoppedEventToFirstInboundRtpMs: expect.any(Number) },
        localObservation: {
          formatVersion: 1,
          kind: 'webrtc_remote_rtp_observed_provider_drained_v1',
        },
      });
      expect(JSON.stringify(ack.mock.calls[0]?.[3])).not.toContain('request_nonce');
      expect(bobTranscripts).toEqual([]);
      expect(value.state.phase).toBe('ready');
      expect(peer.transceiver?.receiver.track?.enabled).toBe(true);

      // Tous les doublons provider deviennent inertes après le reçu durable.
      finishNativeResponse(peer, response);
      peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: responseId });
      peer.channel.receive({
        type: 'response.output_audio_transcript.done',
        response_id: responseId,
        transcript: 'Réponse Bob validée',
      });
      await Promise.resolve();
      expect(ack).toHaveBeenCalledOnce();
      expect(bobTranscripts).toHaveLength(0);
      peer.channel.receive({ type: 'input_audio_buffer.speech_started' });
      expect(peer.transceiver?.receiver.track?.enabled).toBe(false);
    },
  );

  it('réessaie une réponse HTTP perdue avec le même acknowledgementId et le même corps', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    const ack = vi.mocked(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery);
    ack.mockImplementation(async (_handle, turnId, deliveryId, input) => {
      if (ack.mock.calls.length === 1) {
        return { ok: false, error: { kind: 'dependency', port: 'api', cause: 'réponse perdue' } };
      }
      return {
        ok: true,
        value: {
          deliveryId,
          turnId,
          acknowledgementId: input.acknowledgementId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
          idempotent: true,
        },
      };
    });
    const transcripts: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'bob_transcript') transcripts.push(event.text);
    });
    await connectNative(value);
    const peer = harness.peers[0]!;
    const response = await prepareAuditableNativeResponse(peer, 'resp_retry', 32);
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_retry',
      transcript: 'Une seule publication',
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_retry' });
    await waitUntil(() => ack.mock.calls.length === 1);
    expect(transcripts).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    await waitUntil(() => ack.mock.calls.length === 2 && value.state.phase === 'ready');

    expect(ack.mock.calls[0]?.[3]).toBe(ack.mock.calls[1]?.[3]);
    expect(ack.mock.calls[0]?.[3].acknowledgementId)
      .toBe(ack.mock.calls[1]?.[3].acknowledgementId);
    expect(transcripts).toEqual([]);
    expect(value.state.phase).toBe('ready');
  });

  it('respecte Retry-After sur not_ready et rejoue strictement le même ACK', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    const ack = vi.mocked(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery);
    ack.mockImplementation(async (_handle, turnId, deliveryId, input) => {
      if (ack.mock.calls.length === 1) {
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            service: 'bob-live-native-acknowledgement-not-ready',
            retryAfterSeconds: 1,
          },
        };
      }
      return {
        ok: true,
        value: {
          deliveryId,
          turnId,
          acknowledgementId: input.acknowledgementId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
          idempotent: false,
        },
      };
    });
    await connectNative(value);
    const peer = harness.peers[0]!;
    const response = await prepareAuditableNativeResponse(peer, 'resp_not_ready', 46);
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_not_ready',
      transcript: 'ACK trop tôt',
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_not_ready' });
    await waitUntil(() => ack.mock.calls.length === 1);

    await vi.advanceTimersByTimeAsync(999);
    expect(ack).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await waitUntil(() => ack.mock.calls.length === 2 && value.state.phase === 'ready');

    expect(ack.mock.calls[0]?.[3]).toBe(ack.mock.calls[1]?.[3]);
    expect(ack.mock.calls[0]?.[3].acknowledgementId)
      .toBe(ack.mock.calls[1]?.[3].acknowledgementId);
  });

  it('refuse le replay d une delivery native sous un nouvel identifiant provider', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    const response = await prepareAuditableNativeResponse(peer, 'resp_delivery_once', 41);
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_delivery_once',
      transcript: 'Livraison unique',
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_delivery_once' });
    await waitUntil(() => value.state.phase === 'ready');

    peer.channel.receive({
      type: 'response.created',
      response: { id: 'resp_delivery_replayed', metadata: nativeMetadata(41) },
    });
    await waitUntil(() => value.state.phase === 'closed');

    expect(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery).toHaveBeenCalledOnce();
    expect(value.state.fallbackReason).toBe('provider_error');
  });

  it.each([
    ['404', { kind: 'not_found', entity: 'native_speech_delivery', id: 'redacted' }],
    ['409', { kind: 'conflict', entity: 'native_speech_delivery', reason: 'binding_mismatch' }],
  ] as const)('traite un rejet %s comme fatal sans retry ni transcript', async (_status, error) => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    const ack = vi.mocked(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery);
    ack.mockResolvedValueOnce({ ok: false, error });
    const transcripts: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'bob_transcript') transcripts.push(event.text);
    });
    await connectNative(value);
    const peer = harness.peers[0]!;
    const response = await prepareAuditableNativeResponse(peer, `resp_fatal_${_status}`, 33);
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: `resp_fatal_${_status}`,
      transcript: 'Ne doit jamais apparaître',
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({
      type: 'output_audio_buffer.stopped',
      response_id: `resp_fatal_${_status}`,
    });

    await waitUntil(() => value.state.phase === 'closed');
    expect(ack).toHaveBeenCalledOnce();
    expect(transcripts).toEqual([]);
  });

  it('refuse l ACK sans RTP entrant et ne transforme jamais le drain provider en preuve acoustique', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    const transcripts: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'bob_transcript') transcripts.push(event.text);
    });
    await connectNative(value);
    const peer = harness.peers[0]!;
    peer.receiveRemoteTrack();
    peer.setInboundPackets(0);
    peer.channel.receive({ type: 'input_audio_buffer.speech_started' });
    peer.channel.receive({ type: 'input_audio_buffer.speech_stopped' });
    await Promise.resolve();
    const response = startNativeResponse(peer, 'resp_no_rtp', 34);
    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_no_rtp' });
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_no_rtp',
      transcript: 'RTP absent',
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_no_rtp' });
    await vi.advanceTimersByTimeAsync(3_100);
    await waitUntil(() => value.state.phase === 'closed');

    expect(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery).not.toHaveBeenCalled();
    expect(transcripts).toEqual([]);
  });

  it('n acquitte ni ne publie une réponse sans audio, annulée ou purgée', async () => {
    const { bobClient, harness, value } = nativeHarness();
    const transcripts: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'bob_transcript') transcripts.push(event.text);
    });
    await connectNative(value);
    const peer = harness.peers[0]!;

    const noAudio = startNativeResponse(peer, 'resp_no_audio', 35);
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_no_audio',
      transcript: 'Pas de flux audio',
    });
    finishNativeResponse(peer, noAudio);
    expect(value.state.phase).toBe('ready');

    const remote = peer.receiveRemoteTrack();
    const cancelled = startNativeResponse(peer, 'resp_cancelled', 36);
    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_cancelled' });
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_cancelled',
      transcript: 'Réponse annulée',
    });
    finishNativeResponse(peer, cancelled, 'cancelled');
    expect(value.state.phase).toBe('ready');
    expect(remote.track.enabled).toBe(false);
    // Le terminal cancelled suffit : les trames de drain/clear peuvent manquer ou arriver tard.
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_cancelled' });

    expect(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery).not.toHaveBeenCalled();
    expect(transcripts).toEqual([]);
    expect(value.state.phase).toBe('ready');
    expect(remote.track.enabled).toBe(false);
  });

  it('aborte l ACK au background et rend un HTTP 200 tardif totalement inerte', async () => {
    vi.useFakeTimers();
    const { bobClient, harness, value } = nativeHarness();
    type NativeAckResult = Awaited<ReturnType<BobClient['acknowledgeRealtimeVoiceNativeSpeechDelivery']>>;
    const pending = deferred<NativeAckResult>();
    const ack = vi.mocked(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery);
    ack.mockImplementation(() => pending.promise);
    const transcripts: string[] = [];
    value.subscribe((event) => {
      if (event.type === 'bob_transcript') transcripts.push(event.text);
    });
    await connectNative(value);
    const peer = harness.peers[0]!;
    const response = await prepareAuditableNativeResponse(peer, 'resp_late', 37);
    peer.channel.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_late',
      transcript: 'Réponse devenue obsolète',
    });
    finishNativeResponse(peer, response);
    peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'resp_late' });
    await waitUntil(() => ack.mock.calls.length === 1);
    const input = ack.mock.calls[0]![3];
    const signal = ack.mock.calls[0]![4];
    expect(signal?.aborted).toBe(false);

    await value.close('background');
    expect(signal?.aborted).toBe(true);
    pending.resolve({
      ok: true,
      value: {
        deliveryId: nativeMetadata(37).bob_delivery_id!,
        turnId: nativeMetadata(37).bob_turn_id!,
        acknowledgementId: input.acknowledgementId,
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        idempotent: false,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(transcripts).toEqual([]);
    expect(value.state.phase).toBe('closed');
  });

  it.each(['barge-in', 'context-change', 'disconnect'] as const)(
    'fence un ACK en vol sur %s et ignore définitivement son reçu tardif',
    async (invalidation) => {
      vi.useFakeTimers();
      const sequence = invalidation === 'barge-in' ? 38 : invalidation === 'context-change' ? 39 : 40;
      const responseId = `resp_invalidated_${invalidation}`;
      const { bobClient, harness, value } = nativeHarness();
      type NativeAckResult = Awaited<ReturnType<BobClient['acknowledgeRealtimeVoiceNativeSpeechDelivery']>>;
      const pending = deferred<NativeAckResult>();
      const ack = vi.mocked(bobClient.acknowledgeRealtimeVoiceNativeSpeechDelivery);
      ack.mockImplementation(() => pending.promise);
      const transcripts: string[] = [];
      value.subscribe((event) => {
        if (event.type === 'bob_transcript') transcripts.push(event.text);
      });
      await connectNative(value);
      const peer = harness.peers[0]!;
      const response = await prepareAuditableNativeResponse(peer, responseId, sequence);
      peer.channel.receive({
        type: 'response.output_audio_transcript.done',
        response_id: responseId,
        transcript: 'Réponse invalidée',
      });
      finishNativeResponse(peer, response);
      peer.channel.receive({ type: 'output_audio_buffer.stopped', response_id: responseId });
      await waitUntil(() => ack.mock.calls.length === 1);
      const input = ack.mock.calls[0]![3];
      const signal = ack.mock.calls[0]![4];

      if (invalidation === 'barge-in') {
        expect(value.interrupt('user_speech')).toBe(true);
        peer.channel.receive({ type: 'output_audio_buffer.cleared', response_id: responseId });
      } else if (invalidation === 'context-change') {
        await expect(value.synchronizePublishedContext!({
          sessionHandle: value.getSessionHandle()!,
          contextRevision: 8,
          contextDigest: 'd'.repeat(64),
        })).resolves.toBe(true);
        peer.channel.receive({ type: 'output_audio_buffer.cleared', response_id: responseId });
      } else {
        peer.setConnectivity({ connectionState: 'disconnected' });
        await waitUntil(() => value.state.phase === 'closed');
      }
      expect(signal?.aborted).toBe(true);

      pending.resolve({
        ok: true,
        value: {
          deliveryId: nativeMetadata(sequence).bob_delivery_id!,
          turnId: nativeMetadata(sequence).bob_turn_id!,
          acknowledgementId: input.acknowledgementId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
          idempotent: false,
        },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(ack).toHaveBeenCalledOnce();
      expect(transcripts).toEqual([]);
      expect(value.state.phase).toBe(invalidation === 'disconnect' ? 'closed' : 'ready');
    },
  );

  it('neutralise la piste distante synchroniquement puis la stoppe avant le peer', async () => {
    const { harness, value } = nativeHarness();
    await connectNative(value);
    const peer = harness.peers[0]!;
    const remote = peer.receiveRemoteTrack();
    startNativeResponse(peer, 'resp_close', 29);
    peer.channel.receive({ type: 'output_audio_buffer.started', response_id: 'resp_close' });
    expect(remote.track.enabled).toBe(true);

    const order: string[] = [];
    const originalRemoteStop = remote.track.stop.bind(remote.track);
    vi.spyOn(remote.track, 'stop').mockImplementation(() => {
      order.push('remote-track');
      originalRemoteStop();
    });
    const originalPeerClose = peer.close.bind(peer);
    vi.spyOn(peer, 'close').mockImplementation(() => {
      order.push('peer');
      originalPeerClose();
    });

    const closing = value.close('user');
    expect(remote.track.enabled).toBe(false);
    await closing;

    expect(order).toEqual(['remote-track', 'peer']);
    expect(processAudioSession.snapshot().active).toBeNull();
  });

  it('conserve le lease et permet un retry si le stop de la piste distante échoue', async () => {
    const { harness, value } = nativeHarness();
    await value.connect();
    const remote = harness.peers[0]!.receiveRemoteTrack();
    vi.spyOn(remote.track, 'stop').mockImplementationOnce(() => {
      throw new Error('remote stop failed');
    });

    await expect(value.close('fallback')).rejects.toMatchObject({ reason: 'provider_error' });
    expect(value.state.phase).toBe('closing');
    expect(processAudioSession.snapshot().active).toMatchObject({ owner: 'bob-live-webrtc' });

    await expect(value.close('fallback')).resolves.toBeUndefined();
    expect(remote.track.stopCalls).toBe(1);
    expect(value.state.phase).toBe('closed');
    expect(processAudioSession.snapshot().active).toBeNull();
  });
});
