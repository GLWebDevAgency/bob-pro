import type { AgentContext } from '@bob/ai';
import {
  HttpBobClient,
  REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
  type RealtimeVoiceConfig,
  type RealtimeVoiceClientTerminationDiagnostic,
} from '@bob/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processAudioSession } from '../audio';
import type { WebRtcRuntime } from '../realtime/webrtc-runtime';
import { AgentMissionRuntimeOwner } from './agent-mission-runtime';
import { createAgentRealtimeSessionController } from './realtime-session-composition';
import {
  type RealtimeSessionHooks,
} from './realtime-session';
import type { RealtimeSessionController } from './realtime-session';

const uuidState = vi.hoisted(() => ({ sequence: 0 }));
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    uuidState.sequence += 1;
    return `00000000-0000-4000-8000-${uuidState.sequence.toString().padStart(12, '0')}`;
  },
}));
// Le composition root reste celui de production. Seule la branche audité NON SÉLECTIONNÉE évite
// de charger ses modules Expo natifs dans le runner Node ; toute tentative de l'instancier échoue.
vi.mock('../realtime/expo-realtime-audited-speech-playback', () => ({
  ExpoRealtimeAuditedSpeechPlayback: class UnexpectedAuditedPlayback {
    constructor() {
      throw new Error('unexpected_audited_playback');
    }
  },
}));
vi.mock('expo-audio', () => ({
  AudioModule: Object.freeze({}),
}));
vi.mock('expo-file-system', () => ({
  File: class {},
  FileMode: Object.freeze({}),
  Paths: Object.freeze({ cache: '/tmp' }),
}));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('../../modules/bob-live-audio', () => ({
  BOB_LIVE_AUDIO_FRAME_BYTES: 640,
  BOB_LIVE_AUDIO_FRAME_DURATION_MS: 20,
  BobLiveAudioModule: null,
}));

const API_BASE_URL = 'https://api.bob.test';
const COMPANY_ID = 'company-vertical';
const CAPABILITY = `bam2_${'A'.repeat(43)}`;
const CONTEXT_DIGEST = 'a'.repeat(64);
const CONTEXT = Object.freeze({
  screen: Object.freeze({ name: 'ventes', instanceId: 'ventes-vertical' }),
  entities: Object.freeze([]),
  capabilities: Object.freeze(['screen.read'] as const),
}) satisfies AgentContext;
const NATIVE_CONFIG = Object.freeze({
  available: true,
  transport: 'webrtc',
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  configVersion: 'bob-live-provider-neutral-v4',
  requiresDevelopmentBuild: true,
  maxSessionSeconds: 900,
  speechDelivery: 'openai-native-webrtc-v1',
} as const satisfies RealtimeVoiceConfig);

const SEND_RECV_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=sendrecv',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  '',
].join('\r\n');

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  readonly kind = 'audio' as const;
  readonly enabledWrites: boolean[] = [];
  stopCalls = 0;
  private enabledValue = true;

  get enabled(): boolean {
    return this.enabledValue;
  }

  set enabled(value: boolean) {
    this.enabledValue = value;
    this.enabledWrites.push(value);
  }

  stop(): void {
    this.stopCalls += 1;
    this.enabled = false;
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  readonly releaseArguments: boolean[] = [];

  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }

  getTracks(): FakeTrack[] {
    return [this.track];
  }

  release(releaseTracks = true): void {
    this.releaseArguments.push(releaseTracks);
  }
}

class FakeDataChannel extends FakeEventSource {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  closeCalls = 0;
  readonly sent: string[] = [];

  send(value: string): void {
    if (this.readyState !== 'open') throw new Error('channel_closed');
    this.sent.push(value);
  }

  open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.emit('open');
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close');
  }
}

class FakeTransceiver {
  direction: string;
  currentDirection: string | null;
  readonly sender: { readonly track: FakeTrack };
  readonly receiver: { track: FakeTrack | null } = { track: null };

  constructor(track: FakeTrack, direction: string) {
    this.direction = direction;
    this.currentDirection = direction;
    this.sender = { track };
  }
}

class FakePeer extends FakeEventSource {
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { readonly type: 'offer'; readonly sdp: string } | null = null;
  remoteDescription: { readonly type: 'answer'; readonly sdp: string } | null = null;
  readonly channel = new FakeDataChannel();
  closeCalls = 0;
  transceiver: FakeTransceiver | null = null;

  createDataChannel(): FakeDataChannel {
    return this.channel;
  }

  addTransceiver(track: FakeTrack, init: { readonly direction?: string }): FakeTransceiver {
    const transceiver = new FakeTransceiver(track, String(init.direction));
    this.transceiver = transceiver;
    return transceiver;
  }

  getTransceivers(): FakeTransceiver[] {
    return this.transceiver === null ? [] : [this.transceiver];
  }

  createOffer(): Promise<{ readonly type: 'offer'; readonly sdp: string }> {
    return Promise.resolve({ type: 'offer', sdp: SEND_RECV_SDP });
  }

  setLocalDescription(description: { readonly type: 'offer'; readonly sdp: string }): Promise<void> {
    this.localDescription = { ...description };
    return Promise.resolve();
  }

  setRemoteDescription(
    description: { readonly type: 'answer'; readonly sdp: string },
  ): Promise<void> {
    this.remoteDescription = { ...description };
    if (this.transceiver !== null) this.transceiver.currentDirection = 'sendrecv';
    this.channel.open();
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }

  close(): void {
    this.closeCalls += 1;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  }
}

interface RuntimeHarness {
  readonly peers: FakePeer[];
  readonly stream: FakeStream;
  readonly runtime: WebRtcRuntime;
}

function runtimeHarness(): RuntimeHarness {
  const peers: FakePeer[] = [];
  const stream = new FakeStream();
  class Peer {
    constructor() {
      const peer = new FakePeer();
      peers.push(peer);
      return peer;
    }
  }
  class SessionDescription {
    readonly type: 'answer';
    readonly sdp: string;

    constructor(input: { readonly type: 'answer'; readonly sdp: string }) {
      this.type = input.type;
      this.sdp = input.sdp;
    }
  }
  return {
    peers,
    stream,
    runtime: {
      RTCPeerConnection: Peer,
      RTCSessionDescription: SessionDescription,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    } as unknown as WebRtcRuntime,
  };
}

type ContextOutcome = 'confirmed' | 'unavailable';

interface VerticalHarness {
  readonly controller: RealtimeSessionController;
  readonly missionRuntime: AgentMissionRuntimeOwner;
  readonly runtime: RuntimeHarness;
  readonly contextStarted: Promise<void>;
  readonly resolveContext: () => void;
  readonly allowMicrophoneActivation: ReturnType<typeof vi.fn>;
  readonly failedClosed: string[];
  readonly phases: string[];
  readonly fallbackCalls: string[];
  readonly checkpointUses: unknown[];
  readonly requestPaths: string[];
  readonly requestBodies: unknown[];
  readonly deleteDiagnostics: RealtimeVoiceClientTerminationDiagnostic[];
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function createVerticalHarness(contextOutcome: ContextOutcome): VerticalHarness {
  const runtime = runtimeHarness();
  const missionRuntime = new AgentMissionRuntimeOwner();
  const contextResponse = deferred<Response>();
  const contextStarted = deferred<void>();
  const requestPaths: string[] = [];
  const requestBodies: unknown[] = [];
  const deleteDiagnostics: RealtimeVoiceClientTerminationDiagnostic[] = [];
  const failedClosed: string[] = [];
  const phases: string[] = [];
  const fallbackCalls: string[] = [];
  const checkpointUses: unknown[] = [];
  let sessionHandle: string | null = null;
  let contextRequestObserved = false;

  const fetchMock = vi.fn(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    const path = url.pathname;
    requestPaths.push(path);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requestBodies.push(body);

    if (path === '/voice/realtime/config' && init?.method === 'GET') {
      return json(NATIVE_CONFIG);
    }
    if (path === '/voice/realtime/calls' && init?.method === 'POST') {
      expect(body).toEqual({
        sdp: SEND_RECV_SDP,
        agentMissionProtocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
        configVersion: NATIVE_CONFIG.configVersion,
        speechDelivery: NATIVE_CONFIG.speechDelivery,
        sessionHandle: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
      });
      expect(body).not.toHaveProperty('bootstrapTerminationOwner');
      sessionHandle = (body as { readonly sessionHandle: string }).sessionHandle;
      return json({
        transport: 'webrtc',
        answerSdp: SEND_RECV_SDP,
        sessionHandle,
        hardExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        model: NATIVE_CONFIG.model,
        voice: NATIVE_CONFIG.voice,
        configVersion: NATIVE_CONFIG.configVersion,
        maxSessionSeconds: NATIVE_CONFIG.maxSessionSeconds,
        speechDelivery: NATIVE_CONFIG.speechDelivery,
        agentMissionProtocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
        agentMissionCapability: CAPABILITY,
      });
    }
    if (
      sessionHandle !== null
      && path
        === `/voice/realtime/calls/${sessionHandle}/agent-mission-bootstrap-acknowledgements`
      && init?.method === 'POST'
    ) {
      expect(new Headers(init.headers).get('x-bob-agent-mission-capability')).toBe(CAPABILITY);
      return json({ acknowledged: true, replayed: false });
    }
    if (
      sessionHandle !== null
      && path === `/voice/realtime/calls/${sessionHandle}/context`
      && init?.method === 'PUT'
    ) {
      expect(body).toEqual({ version: 1, revision: 1, context: CONTEXT });
      if (!contextRequestObserved) {
        contextRequestObserved = true;
        contextStarted.resolve();
      }
      return contextResponse.promise;
    }
    if (
      sessionHandle !== null
      && path === `/voice/realtime/calls/${sessionHandle}`
      && init?.method === 'DELETE'
    ) {
      deleteDiagnostics.push(body as RealtimeVoiceClientTerminationDiagnostic);
      return json({ ended: true });
    }
    throw new Error(`route_inattendue:${init?.method ?? 'GET'}:${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const client = new HttpBobClient({ baseUrl: API_BASE_URL, companyId: COMPANY_ID });
  const allowMicrophoneActivation = vi.fn(async () => {
    const snapshot = missionRuntime.snapshot();
    return snapshot.protocolVersion === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
      && snapshot.confirmedContext?.realtimeSessionId === sessionHandle
      && snapshot.confirmedContext.revision === 1
      && snapshot.confirmedContext.digest === CONTEXT_DIGEST
      && snapshot.confirmedContext.screen.name === CONTEXT.screen.name
      && snapshot.confirmedContext.screen.instanceId === CONTEXT.screen.instanceId;
  });
  const hooks: RealtimeSessionHooks = {
    onPhase: (phase) => phases.push(phase),
    onUserTranscript: () => undefined,
    onBobTranscript: () => undefined,
    onDiagnosticTrace: () => undefined,
    onReview: () => undefined,
    onNavigate: () => undefined,
    onFallback: (reason, channel) => fallbackCalls.push(`${reason}:${channel}`),
    onFailedClosed: (reason) => failedClosed.push(reason),
    getContextSnapshot: () => CONTEXT,
  };

  const controller = createAgentRealtimeSessionController({
    client,
    hooks,
    agentMissionRuntime: missionRuntime,
    ensureConfirmedTimeZoneForMissionV2: async () => true,
    confirmDiagnosticTraceBeforeListening: async () => true,
    allowMicrophoneActivation,
    getContextSnapshot: () => CONTEXT,
    getMistralConversationCheckpoint: () => null,
    recordMistralConversationCheckpointUsed: (checkpoint) => checkpointUses.push(checkpoint),
    loadWebRtcRuntime: () => runtime.runtime,
  });

  return {
    controller,
    missionRuntime,
    runtime,
    contextStarted: contextStarted.promise,
    resolveContext: () => {
      contextResponse.resolve(
        contextOutcome === 'confirmed'
          ? json({ revision: 1, contextDigest: CONTEXT_DIGEST })
          : json({ error: 'context_unavailable' }, 503),
      );
    },
    allowMicrophoneActivation,
    failedClosed,
    phases,
    fallbackCalls,
    checkpointUses,
    requestPaths,
    requestBodies,
    deleteDiagnostics,
  };
}

const controllers: RealtimeSessionController[] = [];
const missionRuntimes: AgentMissionRuntimeOwner[] = [];

beforeEach(() => {
  uuidState.sequence = 0;
  expect(processAudioSession.snapshot().active).toBeNull();
});

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop('unmount')));
  for (const runtime of missionRuntimes.splice(0)) runtime.dispose();
  vi.unstubAllGlobals();
  expect(processAudioSession.snapshot().active).toBeNull();
});

describe('Bob Live natif — preuve verticale pré-contrôle', () => {
  it('transfère Mission V2 et confirme le contexte avant la première ouverture du micro', async () => {
    const harness = createVerticalHarness('confirmed');
    controllers.push(harness.controller);
    missionRuntimes.push(harness.missionRuntime);

    let settled = false;
    const resumed = harness.controller.start().finally(() => {
      settled = true;
    });
    await harness.contextStarted;

    const sessionHandle = harness.requestBodies[1] as { readonly sessionHandle: string };
    expect(harness.requestPaths).toEqual([
      '/voice/realtime/config',
      '/voice/realtime/calls',
      `/voice/realtime/calls/${sessionHandle.sessionHandle}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${sessionHandle.sessionHandle}/context`,
    ]);
    expect(harness.missionRuntime.snapshot()).toMatchObject({
      protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
      realtimeSessionId: sessionHandle.sessionHandle,
      confirmedContext: null,
    });
    expect(settled).toBe(false);
    expect(harness.allowMicrophoneActivation).not.toHaveBeenCalled();
    expect(harness.runtime.stream.track.enabled).toBe(false);
    expect(harness.runtime.stream.track.enabledWrites).not.toContain(true);
    expect(harness.fallbackCalls).toEqual([]);
    expect(harness.failedClosed).toEqual([]);
    expect(harness.phases).not.toContain('listening');
    expect(harness.checkpointUses).toEqual([null]);

    harness.resolveContext();
    await expect(resumed).resolves.toBe('realtime');

    expect(harness.missionRuntime.snapshot()).toMatchObject({
      protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
      realtimeSessionId: sessionHandle.sessionHandle,
      confirmedContext: {
        realtimeSessionId: sessionHandle.sessionHandle,
        revision: 1,
        digest: CONTEXT_DIGEST,
        screen: CONTEXT.screen,
      },
    });
    expect(harness.allowMicrophoneActivation).toHaveBeenCalledTimes(1);
    expect(harness.runtime.stream.track.enabled).toBe(true);
    expect(harness.runtime.stream.track.enabledWrites.at(-1)).toBe(true);
    expect(harness.phases.at(-1)).toBe('listening');
    expect(harness.checkpointUses).toEqual([null]);

    await harness.controller.stop('user');

    expect(harness.requestPaths.filter((path) => (
      path === `/voice/realtime/calls/${sessionHandle.sessionHandle}`
    ))).toHaveLength(1);
    expect(harness.deleteDiagnostics).toEqual([{
      version: 1,
      terminationSource: 'user',
      lastSuccessfulCheckpoint: 'microphone_opened',
      closeReason: 'user',
    }]);
    expect(harness.runtime.stream.track.stopCalls).toBe(1);
    expect(harness.runtime.stream.releaseArguments).toEqual([true]);
    expect(harness.runtime.peers[0]?.channel.closeCalls).toBe(1);
    expect(harness.runtime.peers[0]?.closeCalls).toBe(1);
    expect(harness.missionRuntime.snapshot().realtimeSessionId).toBeNull();
    expect(processAudioSession.snapshot().active).toBeNull();
  });

  it('échoue fermé et libère l’unique autorité si la publication du contexte est refusée', async () => {
    const harness = createVerticalHarness('unavailable');
    controllers.push(harness.controller);
    missionRuntimes.push(harness.missionRuntime);

    const resumed = harness.controller.start();
    await harness.contextStarted;
    const sessionHandle = harness.requestBodies[1] as { readonly sessionHandle: string };

    expect(harness.missionRuntime.snapshot()).toMatchObject({
      protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
      realtimeSessionId: sessionHandle.sessionHandle,
      confirmedContext: null,
    });
    expect(harness.runtime.stream.track.enabledWrites).not.toContain(true);

    harness.resolveContext();
    await expect(resumed).resolves.toBe('failed_closed');

    expect(harness.allowMicrophoneActivation).not.toHaveBeenCalled();
    expect(harness.runtime.stream.track.enabledWrites).not.toContain(true);
    expect(harness.fallbackCalls).toEqual([]);
    expect(harness.phases).not.toContain('listening');
    // Pendant le bootstrap, l'outcome est l'unique autorité UX. Le hook est réservé aux ruptures
    // d'une session qui a déjà rendu `resumed`.
    expect(harness.failedClosed).toEqual([]);
    expect(harness.requestPaths.filter((path) => (
      path === `/voice/realtime/calls/${sessionHandle.sessionHandle}`
    ))).toHaveLength(1);
    expect(harness.deleteDiagnostics).toEqual([{
      version: 1,
      terminationSource: 'automatic_failure',
      lastSuccessfulCheckpoint: 'context_put_started',
      failureCode: 'context_publish_failed',
    }]);
    expect(harness.runtime.stream.track.stopCalls).toBe(1);
    expect(harness.runtime.stream.releaseArguments).toEqual([true]);
    expect(harness.runtime.peers[0]?.channel.closeCalls).toBe(1);
    expect(harness.runtime.peers[0]?.closeCalls).toBe(1);
    expect(harness.missionRuntime.snapshot().realtimeSessionId).toBeNull();
    expect(processAudioSession.snapshot().active).toBeNull();
  });
});
