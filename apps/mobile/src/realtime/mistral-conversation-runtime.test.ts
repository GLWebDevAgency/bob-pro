import {
  MISTRAL_CONVERSATION_PROTOCOL,
  decodeMistralConversationAudioFrame,
  decodeMistralConversationClientControl,
  encodeMistralConversationServerEvent,
  type AgentContext,
  type MistralConversationClientControl,
  type MistralConversationServerEvent,
} from '@bob/ai';
import type {
  BobClient,
  RealtimeVoiceBootstrapReconciliationResult,
  RealtimeVoiceCallInput,
  RealtimeVoiceIssuedBootstrapReconciliation,
  RealtimeVoiceIssuedResumeTicket,
  RealtimeVoiceMistralConversationCall,
  RealtimeVoiceResumeTicketResult,
  RealtimeVoiceTerminalCompleteReceipt,
} from '@bob/api-client';
import { ok } from '@bob/core';
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
import type {
  BobLiveAudioCapabilities,
  BobLiveAudioVadEvent,
} from '../../modules/bob-live-audio';
import type {
  BobLiveNativeVadSessionInput,
  BobLiveNativeVadSessionPort,
} from './bob-live-native-vad-session';
import type {
  MistralConversationCheckpointOwnerFence,
  MistralConversationCheckpointStore,
  MistralConversationTerminalCheckpoint,
} from './mistral-conversation-checkpoint-store';
import type { MistralPcmMobileSocket } from './mistral-pcm-uplink';
import {
  MistralConversationTransport,
  type RealtimeMistralConversationNegotiation,
} from './mistral-conversation-runtime';
import type { RealtimeTransportEvent } from './realtime-transport';

const NOW = Date.parse('2026-07-19T12:00:00.000Z');
const HARD_EXPIRES_AT = '2026-07-19T12:01:00.000Z';
const TICKET_EXPIRES_AT = '2026-07-19T12:00:30.000Z';
const SESSION = '00000000-0000-4000-8000-000000000101';
const TURN = '00000000-0000-4000-8000-000000000202';
const COMPANY = 'company-1';
const OWNER = Object.freeze({ subjectId: 'subject-1', companyId: COMPANY });
const CONTEXT_DIGEST = 'a'.repeat(64);
const MAX_MISSION_AUDIO_BYTES = 1_920_000;
const B2 = `b2_${Buffer.alloc(32, 2).toString('base64url')}`;
const R2 = `r2_${Buffer.alloc(32, 3).toString('base64url')}`;
const PCM_A = Uint8Array.from({ length: 1_280 }, (_, index) => index % 251);
const PCM_B = Uint8Array.from({ length: 1_280 }, (_, index) => (index + 17) % 251);

const CONTEXT = {
  screen: { name: 'documents', instanceId: 'documents-1' },
  entities: [],
  capabilities: ['screen.read'],
} as const satisfies AgentContext;

const NEGOTIATION: RealtimeMistralConversationNegotiation = Object.freeze({
  available: true,
  transport: 'mistral-pcm',
  protocol: MISTRAL_CONVERSATION_PROTOCOL,
  model: 'voxtral-mini-transcribe-realtime-2602',
  voice: 'marin',
  configVersion: 'bob-live-provider-neutral-v2',
  requiresDevelopmentBuild: true,
  maxSessionSeconds: 60,
  speechDelivery: 'audited-signed-url-v1',
});

type SocketMessage = { readonly data: unknown };
type SocketListener = (() => void) | ((event: SocketMessage) => void);
type RuntimeClient = Pick<
  BobClient,
  | 'createRealtimeVoiceCall'
  | 'reconcileRealtimeVoiceBootstrap'
  | 'requestRealtimeVoiceResumeTicket'
  | 'hangupRealtimeVoiceCall'
>;

class FakeSocket implements MistralPcmMobileSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];
  private readonly listeners = new Map<string, Set<SocketListener>>();
  private readonly historicalListeners = new Map<string, Set<SocketListener>>();

  constructor(private readonly operations: string[]) {}

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: SocketMessage) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: string, listener: SocketListener): void {
    const current = this.listeners.get(type) ?? new Set<SocketListener>();
    current.add(listener);
    this.listeners.set(type, current);
    const historical = this.historicalListeners.get(type) ?? new Set<SocketListener>();
    historical.add(listener);
    this.historicalListeners.set(type, historical);
  }

  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: SocketMessage) => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
    if (typeof data !== 'string') {
      this.operations.push('send:binary');
      return;
    }
    const control = decodeMistralConversationClientControl(data);
    this.operations.push(
      control.type === 'events.ack'
        ? `send:events.ack:${control.nextServerSequence}`
        : `send:${control.type}`,
    );
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    this.readyState = 3;
    this.dispatch('close');
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open');
  }

  server(event: MistralConversationServerEvent): void {
    this.dispatch('message', { data: encodeMistralConversationServerEvent(event) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.dispatch('close');
  }

  /** Simule un callback natif déjà capturé avant removeEventListener. */
  staleServer(event: MistralConversationServerEvent): void {
    this.dispatchHistorical('message', { data: encodeMistralConversationServerEvent(event) });
  }

  staleClose(): void {
    this.dispatchHistorical('close');
  }

  staleError(): void {
    this.dispatchHistorical('error');
  }

  private dispatch(type: string, event?: SocketMessage): void {
    this.dispatchSet(this.listeners.get(type), event);
  }

  private dispatchHistorical(type: string, event?: SocketMessage): void {
    this.dispatchSet(this.historicalListeners.get(type), event);
  }

  private dispatchSet(listeners: Set<SocketListener> | undefined, event?: SocketMessage): void {
    for (const listener of [...(listeners ?? [])]) {
      if (event === undefined) (listener as () => void)();
      else (listener as (input: SocketMessage) => void)(event);
    }
  }
}

interface HarnessOptions {
  readonly reconciliation?: readonly RealtimeVoiceBootstrapReconciliationResult[];
  readonly terminal?: readonly RealtimeVoiceResumeTicketResult[];
  readonly checkpointSaveError?: Error;
  readonly vadStopError?: Error;
  readonly vadQuarantined?: boolean;
  readonly onVadStart?: (input: BobLiveNativeVadSessionInput) => void;
}

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function call(input: RealtimeVoiceCallInput): RealtimeVoiceMistralConversationCall {
  if (input.transport !== 'mistral-pcm' || input.protocol !== MISTRAL_CONVERSATION_PROTOCOL) {
    throw new Error('unexpected_create_input');
  }
  return {
    transport: 'mistral-pcm',
    websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
    companyId: COMPANY,
    ticket: B2,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    ticketExpiresAt: TICKET_EXPIRES_AT,
    maxMissionAudioBytes: MAX_MISSION_AUDIO_BYTES,
    contextRevision: 1,
    contextDigest: CONTEXT_DIGEST,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    sessionHandle: input.sessionHandle ?? SESSION,
    hardExpiresAt: HARD_EXPIRES_AT,
    model: NEGOTIATION.model,
    voice: NEGOTIATION.voice,
    configVersion: NEGOTIATION.configVersion,
    maxSessionSeconds: NEGOTIATION.maxSessionSeconds,
    speechSourcePolicy: {
      mode: 'signed-url-v1',
      allowedOrigin: 'https://project.supabase.co',
      allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/${COMPANY}/bob-live/${SESSION}/`,
    },
  };
}

function readyEvent(
  serverSequence = 0,
  missionConnectionEpoch = 1,
): Extract<MistralConversationServerEvent, { readonly type: 'session.ready' }> {
  return {
    type: 'session.ready',
    serverSequence,
    sessionHandle: SESSION,
    missionConnectionEpoch,
    expiresAt: HARD_EXPIRES_AT,
    contextRevision: 1,
    contextDigest: CONTEXT_DIGEST,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    nextAudioSequence: 0,
    maxMissionAudioBytes: MAX_MISSION_AUDIO_BYTES,
  };
}

function routeRecoveringEvent(
  serverSequence: number,
): Extract<MistralConversationServerEvent, { readonly type: 'session.route_recovering' }> {
  return {
    type: 'session.route_recovering',
    serverSequence,
    cancellationGeneration: 1,
  };
}

function routeRecoveredEvent(
  serverSequence: number,
  missionConnectionEpoch = 2,
): Extract<MistralConversationServerEvent, { readonly type: 'session.route_recovered' }> {
  return {
    type: 'session.route_recovered',
    serverSequence,
    missionConnectionEpoch,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
  };
}

function drainingEvent(
  serverSequence: number,
): Extract<MistralConversationServerEvent, { readonly type: 'session.draining' }> {
  return {
    type: 'session.draining',
    serverSequence,
    reason: 'user',
    cancellationGeneration: 1,
  };
}

function closedEvent(
  serverSequence: number,
): Extract<MistralConversationServerEvent, { readonly type: 'session.closed' }> {
  return { type: 'session.closed', serverSequence, reason: 'user' };
}

function issuedBootstrap(
  expectedMissionConnectionEpoch = 2,
): RealtimeVoiceIssuedBootstrapReconciliation {
  return {
    status: 'issued',
    websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
    companyId: COMPANY,
    sessionHandle: SESSION,
    ticket: R2,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    scope: 'live_takeover',
    ticketExpiresAt: TICKET_EXPIRES_AT,
    expectedMissionConnectionEpoch,
    clientAcceptedMissionConnectionEpoch: 0,
    resumeNextServerSequence: 0,
  };
}

function issuedTerminal(): RealtimeVoiceIssuedResumeTicket {
  return {
    status: 'issued',
    websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
    companyId: COMPANY,
    sessionHandle: SESSION,
    ticket: R2,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    scope: 'terminal_replay',
    ticketExpiresAt: TICKET_EXPIRES_AT,
    expectedMissionConnectionEpoch: 1,
    clientAcceptedMissionConnectionEpoch: 1,
    resumeNextServerSequence: 3,
  };
}

function terminalReceipt(
  overrides: Partial<RealtimeVoiceTerminalCompleteReceipt> = {},
): RealtimeVoiceTerminalCompleteReceipt {
  return {
    status: 'terminal_complete',
    companyId: COMPANY,
    sessionHandle: SESSION,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    missionConnectionEpoch: 1,
    nextServerSequence: 3,
    reason: 'user',
    closedAt: '2026-07-19T12:00:20.000Z',
    ...overrides,
  };
}

function controls(socket: FakeSocket): MistralConversationClientControl[] {
  return socket.sent
    .filter((value): value is string => typeof value === 'string')
    .map((value) => decodeMistralConversationClientControl(value));
}

function acknowledgements(
  socket: FakeSocket,
): Array<Extract<MistralConversationClientControl, { readonly type: 'events.ack' }>> {
  return controls(socket).filter(
    (control): control is Extract<
      MistralConversationClientControl,
      { readonly type: 'events.ack' }
    > => control.type === 'events.ack',
  );
}

async function eventually(predicate: () => boolean, label = 'condition_not_reached'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(label);
}

function harness(options: HarnessOptions = {}) {
  const operations: string[] = [];
  const sockets: FakeSocket[] = [];
  const reconciliation = [...(options.reconciliation ?? [])];
  const terminal = [...(options.terminal ?? [])];
  const events: RealtimeTransportEvent[] = [];
  let identifier = 101;

  const lease: ProcessAudioLease = Object.freeze({
    generation: 1,
    mode: 'realtime',
    owner: 'mistral-conversation-test',
    token: Symbol('mistral-conversation-test'),
  });
  const audio = {
    acquire: vi.fn(async () => ({ ok: true as const, lease })),
    release: vi.fn(() => true),
    isCurrent: vi.fn((candidate: ProcessAudioLease | null | undefined) => candidate === lease),
    async withPermissionRequest<T>(run: () => Promise<T>): Promise<T> {
      return run();
    },
  };

  const vadInputs: BobLiveNativeVadSessionInput[] = [];
  const stopVad = vi.fn(async () => {
    if (options.vadStopError) throw options.vadStopError;
  });
  const vadPort: BobLiveNativeVadSessionPort = {
    start: vi.fn(async (input) => {
      vadInputs.push(input);
      options.onVadStart?.(input);
      const captureId = `capture-${vadInputs.length}`;
      const capabilities: BobLiveAudioCapabilities = {
        sessionId: SESSION,
        captureId,
        encoding: 'pcm_s16le',
        sampleRateHz: 16_000,
        channels: 1,
        frameDurationMs: 40,
        maxInFlightFrames: 16,
        maxCaptureDurationMs: 60_000,
        acousticEchoCancellation: 'enabled',
        noiseSuppression: 'enabled',
        automaticGainControl: 'enabled',
        vadConfigVersion: 'bob-live-vad-foundation-1',
        vadEventOrdering: 'pcm_before_vad',
        vadAnalysisWindowMs: 20,
        vadPreRollMs: 240,
        vadSpeechStartMs: 60,
        vadSpeechEndMs: 700,
        vadMaximumUtteranceMs: 30_000,
        fullDuplexCertified: false,
      };
      return { captureId, capabilities, stop: stopVad };
    }),
    isQuarantined: vi.fn(() => options.vadQuarantined === true),
  };

  const fence: MistralConversationCheckpointOwnerFence = Object.freeze({
    identity: OWNER,
    generation: 1,
  });
  const clearAfterTerminalComplete = vi.fn(async () => {
    operations.push('checkpoint:clear');
  });
  const checkpointStore: MistralConversationCheckpointStore = {
    activeOwnerFence: vi.fn(() => fence),
    activateOwner: vi.fn((identity) => Object.freeze({ identity, generation: 1 })),
    deactivateOwner: vi.fn(() => undefined),
    load: vi.fn(async () => {
      operations.push('checkpoint:load');
      return null;
    }),
    save: vi.fn(async (_owner, state): Promise<MistralConversationTerminalCheckpoint> => {
      operations.push(`checkpoint:save:${state.projection.phase}`);
      if (options.checkpointSaveError) throw options.checkpointSaveError;
      return {
        version: 1,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        ...OWNER,
        ...state,
      };
    }),
    clearAfterTerminalComplete,
    retryInterruptedTerminalClear: vi.fn(async () => undefined),
    purgeForAuthBoundary: vi.fn(async () => undefined),
    scrubRequiredCheckpoint: vi.fn(async () => undefined),
  };

  const createRealtimeVoiceCall = vi.fn(async (input: RealtimeVoiceCallInput) => ok(call(input)));
  const reconcileRealtimeVoiceBootstrap: RuntimeClient['reconcileRealtimeVoiceBootstrap'] = vi.fn(
    async () => {
      const next = reconciliation.shift();
      if (next === undefined) throw new Error('unexpected_bootstrap_reconciliation');
      return ok(next);
    },
  );
  const requestRealtimeVoiceResumeTicket: RuntimeClient['requestRealtimeVoiceResumeTicket'] = vi.fn(
    async () => {
      const next = terminal.shift();
      if (next === undefined) throw new Error('unexpected_terminal_confirmation');
      return ok(next);
    },
  );
  const hangupRealtimeVoiceCall = vi.fn(async () => ok({ ended: true as const }));
  const client: RuntimeClient = {
    createRealtimeVoiceCall,
    reconcileRealtimeVoiceBootstrap,
    requestRealtimeVoiceResumeTicket,
    hangupRealtimeVoiceCall,
  };
  const socketFactory = vi.fn((url: string, protocols: readonly string[]) => {
    if (url !== 'wss://api.bob.test/v1/voice/realtime/mistral') {
      throw new Error('unexpected_socket_url');
    }
    if (protocols.length !== 1 || protocols[0] !== MISTRAL_CONVERSATION_PROTOCOL) {
      throw new Error('unexpected_socket_protocol');
    }
    const socket = new FakeSocket(operations);
    sockets.push(socket);
    return socket;
  });
  const retryDelay = vi.fn(async (_attempt: number, signal: AbortSignal) => {
    if (signal.aborted) throw new Error('retry_after_abort');
  });
  const transport = new MistralConversationTransport(client, NEGOTIATION, {
    getInitialContext: () => CONTEXT,
    checkpoint: { store: checkpointStore, fence },
    createIdentifier: () => uuid(identifier++),
    now: () => NOW,
    socketFactory,
    createVadSession: () => vadPort,
    requestMicrophonePermission: async () => true,
    audioCoordinator: audio,
    connectTimeoutMs: 1_000,
    contextTimeoutMs: 1_000,
    retryDelay,
  });
  transport.subscribe((event) => events.push(event));

  return {
    transport,
    operations,
    sockets,
    events,
    audio,
    vadPort,
    vadInputs,
    stopVad,
    checkpointStore,
    clearAfterTerminalComplete,
    fence,
    client,
    createRealtimeVoiceCall,
    reconcileRealtimeVoiceBootstrap: reconcileRealtimeVoiceBootstrap as ReturnType<typeof vi.fn>,
    requestRealtimeVoiceResumeTicket: requestRealtimeVoiceResumeTicket as ReturnType<typeof vi.fn>,
    hangupRealtimeVoiceCall,
    socketFactory,
    retryDelay,
  };
}

async function waitForAuthentication(socket: FakeSocket): Promise<void> {
  await eventually(
    () => controls(socket).some((control) => control.type === 'authenticate'),
    'authentication_not_sent',
  );
}

async function connectInitial(h: ReturnType<typeof harness>): Promise<FakeSocket> {
  const pending = h.transport.connect();
  await eventually(() => h.sockets.length === 1, 'initial_socket_not_created');
  const socket = h.sockets[0]!;
  socket.open();
  await waitForAuthentication(socket);
  socket.server(readyEvent());
  await pending;
  return socket;
}

async function finishLiveTakeover(
  socket: FakeSocket,
  pending: Promise<void>,
  expectedMissionConnectionEpoch = 2,
): Promise<void> {
  socket.open();
  await waitForAuthentication(socket);
  socket.server(readyEvent());
  socket.server(routeRecoveringEvent(1));
  socket.server(routeRecoveredEvent(2, expectedMissionConnectionEpoch));
  await pending;
}

async function sendTerminal(socket: FakeSocket): Promise<void> {
  socket.server(drainingEvent(1));
  await eventually(
    () => acknowledgements(socket).some((ack) => ack.nextServerSequence === 2),
    'draining_not_acknowledged',
  );
  socket.server(closedEvent(2));
}

function nativeVadEvent(input: {
  readonly kind: 'speech_started' | 'speech_ended';
  readonly utteranceIndex?: number;
  readonly startedAtMonotonicMs?: number;
  readonly detectedAtMonotonicMs?: number;
  readonly preRollMs?: number;
  readonly endedAtMonotonicMs?: number | null;
}): BobLiveAudioVadEvent {
  return {
    sessionId: SESSION,
    captureId: 'capture-1',
    kind: input.kind,
    configVersion: 'bob-live-vad-foundation-1',
    utteranceIndex: input.utteranceIndex ?? 0,
    detectedAtMonotonicMs: input.detectedAtMonotonicMs ?? 1_060,
    preRollMs: input.preRollMs ?? 240,
    startedAtMonotonicMs: input.startedAtMonotonicMs ?? 1_000,
    endedAtMonotonicMs: input.endedAtMonotonicMs
      ?? (input.kind === 'speech_ended' ? 1_500 : null),
    forcedEnd: false,
    energyDbfs: -22,
    noiseFloorDbfs: -55,
  };
}

function nativeFrame(
  captureSequence: number,
  pcm: Uint8Array = PCM_A,
  startedAtMonotonicMs = 760 + captureSequence * 40,
) {
  return { captureSequence, startedAtMonotonicMs, pcm };
}

function startNativeSpeech(
  input: BobLiveNativeVadSessionInput,
  initialFrames: readonly ReturnType<typeof nativeFrame>[] = [nativeFrame(0)],
  utteranceIndex = 0,
): boolean {
  return input.onSpeechStarted({
    kind: 'speech_started',
    event: nativeVadEvent({ kind: 'speech_started', utteranceIndex }),
    initialFrames,
  });
}

function endNativeSpeech(
  input: BobLiveNativeVadSessionInput,
  lastForwardedCaptureSequence: number,
  utteranceIndex = 0,
  endedAtMonotonicMs = 1_500,
): boolean {
  return input.onSpeechEnded({
    kind: 'speech_ended',
    event: nativeVadEvent({ kind: 'speech_ended', utteranceIndex, endedAtMonotonicMs }),
    lastForwardedCaptureSequence,
  });
}

function turnStartControl(
  socket: FakeSocket,
): Extract<MistralConversationClientControl, { readonly type: 'turn.start' }> {
  const start = controls(socket).find(
    (control): control is Extract<
      MistralConversationClientControl,
      { readonly type: 'turn.start' }
    > => control.type === 'turn.start',
  );
  if (!start) throw new Error('turn_start_missing');
  return start;
}

function serverTurnStarted(
  socket: FakeSocket,
  start: Extract<MistralConversationClientControl, { readonly type: 'turn.start' }>,
  serverSequence = 1,
): void {
  socket.server({
    type: 'turn.started',
    serverSequence,
    clientTurnId: start.clientTurnId,
    turnId: TURN,
    ordinal: 7,
    contextRevision: 1,
    contextDigest: CONTEXT_DIGEST,
    cancellationGeneration: 0,
    firstAudioSequence: 0,
    vadStartedAtMs: start.vadStartedAtMs,
    preRollMs: start.preRollMs,
  });
}

describe('MistralConversationTransport', () => {
  it('ouvre strictement v2, applique session.ready puis ACKe son curseur', async () => {
    const h = harness();
    const socket = await connectInitial(h);

    expect(h.createRealtimeVoiceCall).toHaveBeenCalledWith(
      {
        transport: 'mistral-pcm',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        context: { version: 1, revision: 1, context: CONTEXT },
        sessionHandle: SESSION,
      },
      expect.any(AbortSignal),
    );
    expect(h.socketFactory).toHaveBeenCalledWith(
      'wss://api.bob.test/v1/voice/realtime/mistral',
      [MISTRAL_CONVERSATION_PROTOCOL],
    );
    expect(controls(socket)).toEqual([
      {
        type: 'authenticate',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        companyId: COMPANY,
        ticket: B2,
        resumeNextServerSequence: 0,
      },
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 1 },
    ]);
    expect(h.transport.state.phase).toBe('ready');
    expect(h.transport.getSessionHandle()).toBe(SESSION);
    expect(h.vadPort.start).not.toHaveBeenCalled();
  });

  it('n’acquiert la session VAD continue qu’après session.ready et son fence publié', async () => {
    const h = harness();
    const pending = h.transport.connect();
    await eventually(() => h.sockets.length === 1);
    const socket = h.sockets[0]!;
    socket.open();
    await waitForAuthentication(socket);

    h.transport.setMicrophoneEnabled(true);
    await Promise.resolve();
    expect(h.vadPort.start).not.toHaveBeenCalled();

    socket.server(readyEvent());
    await pending;
    await eventually(() => h.vadInputs.length === 1, 'vad_not_started_after_ready');
    expect(h.transport.state.phase).toBe('ready');
  });

  it('conserve la session si speech_started arrive avant la résolution de start()', async () => {
    let speechAccepted = false;
    const h = harness({
      onVadStart: (input) => {
        speechAccepted = startNativeSpeech(input);
      },
    });
    const socket = await connectInitial(h);

    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    await Promise.resolve();
    expect(speechAccepted).toBe(true);
    expect(h.stopVad).not.toHaveBeenCalled();
    expect(h.transport.state.phase).toBe('user_speaking');
    expect(controls(socket).filter((control) => control.type === 'turn.start')).toHaveLength(1);
  });

  it('coupe la VAD pendant un changement de fence puis repart seulement après son ACK', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    const obsolete = h.vadInputs[0]!;
    const contextDigest = 'b'.repeat(64);

    const synchronized = h.transport.synchronizePublishedContext!({
      sessionHandle: SESSION,
      contextRevision: 2,
      contextDigest,
    });
    await eventually(
      () => controls(socket).some((control) => control.type === 'context.update'),
      'context_update_not_sent',
    );
    expect(h.stopVad).toHaveBeenCalledOnce();
    expect(startNativeSpeech(obsolete)).toBe(false);
    expect(h.vadInputs).toHaveLength(1);

    socket.server({
      type: 'session.context_updated',
      serverSequence: 1,
      contextRevision: 2,
      contextDigest,
    });
    await expect(synchronized).resolves.toBe(true);
    await eventually(() => h.vadInputs.length === 2, 'vad_not_restarted_after_context_ack');
  });

  it('préserve le pré-roll natif, borne le buffer puis auto-committe une fin antérieure à turn.started', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.events.length = 0;

    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1, 'vad_not_started');
    const vad = h.vadInputs[0]!;
    expect(startNativeSpeech(vad, [nativeFrame(4, PCM_A, 760)])).toBe(true);
    expect(socket.sent.some((value) => value instanceof ArrayBuffer)).toBe(false);

    const start = turnStartControl(socket);
    expect(start).toMatchObject({ vadStartedAtMs: 1_000, preRollMs: 240 });
    expect(endNativeSpeech(vad, 4)).toBe(true);
    expect(controls(socket).some((control) => control.type === 'turn.commit')).toBe(false);
    await eventually(() => h.stopVad.mock.calls.length === 1, 'vad_not_stopped_after_end');

    serverTurnStarted(socket, start);
    await eventually(
      () => socket.sent.some((value) => value instanceof ArrayBuffer),
      'preroll_not_flushed',
    );
    await eventually(
      () => controls(socket).some((control) => control.type === 'turn.commit'),
      'automatic_commit_not_sent',
    );

    const frames = socket.sent
      .filter((value): value is ArrayBuffer => value instanceof ArrayBuffer)
      .map((value) => decodeMistralConversationAudioFrame(new Uint8Array(value)));
    expect(frames).toEqual([{ turnOrdinal: 7, audioSequence: 0, pcm: PCM_A }]);
    expect(controls(socket)).toContainEqual({
      type: 'turn.commit',
      clientTurnId: start.clientTurnId,
      lastAudioSequence: 0,
      vadEndedAtMs: 1_500,
    });
    const readyIndex = h.events.findIndex(
      (event) => event.type === 'state' && event.state.phase === 'ready',
    );
    const commitIndex = h.events.findIndex((event) => event.type === 'user_input_committed');
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(readyIndex);
    expect(h.events[commitIndex]).toEqual({ type: 'user_input_committed', turnId: TURN });
  });

  it('canonise les fractions monotones iOS sans revenir à l’horloge murale JS', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    const vad = h.vadInputs[0]!;
    const nativeStart = 1_000.123_456;
    expect(vad.onSpeechStarted({
      kind: 'speech_started',
      event: nativeVadEvent({
        kind: 'speech_started',
        startedAtMonotonicMs: nativeStart,
        detectedAtMonotonicMs: nativeStart + 60,
      }),
      initialFrames: [nativeFrame(0, PCM_A, nativeStart - 240)],
    })).toBe(true);
    const start = turnStartControl(socket);
    expect(start.vadStartedAtMs).toBe(1_000);
    serverTurnStarted(socket, start);
    await eventually(() => socket.sent.some((value) => value instanceof ArrayBuffer));

    expect(vad.onSpeechEnded({
      kind: 'speech_ended',
      event: nativeVadEvent({
        kind: 'speech_ended',
        startedAtMonotonicMs: nativeStart,
        detectedAtMonotonicMs: 2_200.987_654,
        endedAtMonotonicMs: 1_500.987_654,
      }),
      lastForwardedCaptureSequence: 0,
    })).toBe(true);
    expect(controls(socket)).toContainEqual({
      type: 'turn.commit',
      clientTurnId: start.clientTurnId,
      lastAudioSequence: 0,
      vadEndedAtMs: 1_500,
    });
  });

  it('admet les frames après turn.started puis auto-committe le dernier curseur serveur exact', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    const vad = h.vadInputs[0]!;
    expect(startNativeSpeech(vad)).toBe(true);
    const start = turnStartControl(socket);
    serverTurnStarted(socket, start);
    await eventually(() => socket.sent.some((value) => value instanceof ArrayBuffer));

    expect(vad.onSpeechFrame({ kind: 'speech_frame', frame: nativeFrame(1, PCM_B) })).toBe(true);
    expect(endNativeSpeech(vad, 1)).toBe(true);
    const frames = socket.sent
      .filter((value): value is ArrayBuffer => value instanceof ArrayBuffer)
      .map((value) => decodeMistralConversationAudioFrame(new Uint8Array(value)));
    expect(frames).toEqual([
      { turnOrdinal: 7, audioSequence: 0, pcm: PCM_A },
      { turnOrdinal: 7, audioSequence: 1, pcm: PCM_B },
    ]);
    expect(controls(socket)).toContainEqual({
      type: 'turn.commit',
      clientTurnId: start.clientTurnId,
      lastAudioSequence: 1,
      vadEndedAtMs: 1_500,
    });
  });

  it('émet une seule preuve de commit sur finishUserInput manuel', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    expect(startNativeSpeech(h.vadInputs[0]!)).toBe(true);
    const start = turnStartControl(socket);
    serverTurnStarted(socket, start);
    await eventually(() => socket.sent.some((value) => value instanceof ArrayBuffer));

    await expect(h.transport.finishUserInput()).resolves.toBe(true);
    await expect(h.transport.finishUserInput()).resolves.toBe(false);
    expect(controls(socket).filter((control) => control.type === 'turn.commit')).toHaveLength(1);
    expect(h.events.filter((event) => event.type === 'user_input_committed')).toEqual([
      { type: 'user_input_committed', turnId: TURN },
    ]);
  });

  it('converge si la VAD annule avant l’ACK turn.started, sans audio ni preuve de commit', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    const vad = h.vadInputs[0]!;
    expect(startNativeSpeech(vad)).toBe(true);
    const start = turnStartControl(socket);

    vad.onSpeechCancelled({
      utteranceIndex: 0,
      lastCaptureSequence: 0,
      reason: 'background',
    });
    expect(controls(socket)).toContainEqual(expect.objectContaining({
      type: 'turn.cancel',
      clientTurnId: start.clientTurnId,
      reason: 'context_changed',
    }));
    const cancel = controls(socket).find(
      (control): control is Extract<
        MistralConversationClientControl,
        { readonly type: 'turn.cancel' }
      > => control.type === 'turn.cancel',
    );
    if (!cancel) throw new Error('turn_cancel_missing');

    serverTurnStarted(socket, start);
    await eventually(
      () => acknowledgements(socket).some((ack) => ack.nextServerSequence === 2),
      'cancelled_turn_start_not_acknowledged',
    );
    expect(socket.sent.some((value) => value instanceof ArrayBuffer)).toBe(false);
    socket.server({
      type: 'turn.cancelled',
      serverSequence: 2,
      clientTurnId: start.clientTurnId,
      turnId: TURN,
      ordinal: 7,
      cancellationId: cancel.cancellationId,
      cancellationGeneration: 1,
    });
    await eventually(
      () => acknowledgements(socket).some((ack) => ack.nextServerSequence === 3),
      'turn_cancelled_not_acknowledged',
    );
    expect(controls(socket).some((control) => control.type === 'turn.commit')).toBe(false);
    expect(h.events.some((event) => event.type === 'user_input_committed')).toBe(false);
    expect(h.events.some((event) => event.type === 'fallback')).toBe(false);
    expect(h.transport.state.phase).toBe('ready');
  });

  it('refuse synchroniquement le PCM qui dépasse le buffer pré-admission et ferme fail-closed', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    const vad = h.vadInputs[0]!;
    const boundedFrames = Array.from({ length: 8 }, (_, sequence) => nativeFrame(sequence));
    expect(startNativeSpeech(vad, boundedFrames)).toBe(true);
    expect(vad.onSpeechFrame({ kind: 'speech_frame', frame: nativeFrame(8, PCM_B) })).toBe(false);
    expect(socket.sent.some((value) => value instanceof ArrayBuffer)).toBe(false);

    vad.onSpeechCancelled({
      utteranceIndex: 0,
      lastCaptureSequence: 7,
      reason: 'transport_rejected',
    });
    vi.useFakeTimers();
    try {
      vad.onError();
      expect(h.events).toContainEqual({ type: 'fallback', reason: 'provider_error' });
      expect(controls(socket).some((control) => control.type === 'turn.commit')).toBe(false);
      await vi.advanceTimersByTimeAsync(2_100);
      await eventually(() => h.hangupRealtimeVoiceCall.mock.calls.length === 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne réarme la VAD qu’après pause puis reprise du rendu acoustique audité', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    const vad = h.vadInputs[0]!;
    expect(startNativeSpeech(vad)).toBe(true);
    const start = turnStartControl(socket);
    serverTurnStarted(socket, start);
    await eventually(() => socket.sent.some((value) => value instanceof ArrayBuffer));
    expect(endNativeSpeech(vad, 0)).toBe(true);
    await eventually(() => h.stopVad.mock.calls.length === 1);

    socket.server({
      type: 'turn.completed',
      serverSequence: 2,
      clientTurnId: start.clientTurnId,
      turnId: TURN,
      ordinal: 7,
    });
    await eventually(
      () => acknowledgements(socket).some((ack) => ack.nextServerSequence === 3),
      'turn_completed_not_applied',
    );
    expect(h.vadInputs).toHaveLength(1);

    // Ces deux appels sont exactement ceux du wrapper sur speech_started/speech_completed.
    h.transport.setMicrophoneEnabled(false);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 2, 'vad_not_restarted_after_audited_output');
  });

  it('rend inertes les callbacks VAD d’une génération arrêtée', async () => {
    const h = harness();
    const socket = await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);
    const obsolete = h.vadInputs[0]!;

    h.transport.setMicrophoneEnabled(false);
    await eventually(() => h.stopVad.mock.calls.length === 1);
    await Promise.resolve();
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 2, 'replacement_vad_not_started');
    const current = h.vadInputs[1]!;

    expect(startNativeSpeech(obsolete)).toBe(false);
    expect(controls(socket).filter((control) => control.type === 'turn.start')).toHaveLength(0);
    expect(startNativeSpeech(current)).toBe(true);
    expect(controls(socket).filter((control) => control.type === 'turn.start')).toHaveLength(1);
    expect(h.events.some((event) => event.type === 'fallback')).toBe(false);
  });

  it('refuse un port VAD quarantiné sans rendre le lease à un fallback', async () => {
    const h = harness({ vadQuarantined: true });
    await expect(h.transport.connect()).rejects.toMatchObject({
      reason: 'provider_error',
    });
    expect(h.vadPort.start).not.toHaveBeenCalled();
    expect(h.audio.release).not.toHaveBeenCalled();
  });

  it('conserve le lease audio si la preuve native d’arrêt échoue', async () => {
    const h = harness({ vadStopError: new Error('native_vad_session_quarantined') });
    await connectInitial(h);
    h.transport.setMicrophoneEnabled(true);
    await eventually(() => h.vadInputs.length === 1);

    vi.useFakeTimers();
    try {
      const closing = h.transport.close('user');
      const rejected = expect(closing).rejects.toMatchObject({ reason: 'provider_error' });
      await vi.advanceTimersByTimeAsync(2_100);
      await rejected;
      expect(h.audio.release).not.toHaveBeenCalled();
      await expect(h.transport.connect()).rejects.toMatchObject({ reason: 'provider_error' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('réconcilie deux ambiguïtés : retry_initial réemploie b2 puis issued ouvre r2 live_takeover', async () => {
    const h = harness({
      reconciliation: [{ status: 'retry_initial' }, issuedBootstrap()],
    });
    const pending = h.transport.connect();

    await eventually(() => h.sockets.length === 1);
    const initial = h.sockets[0]!;
    initial.open();
    await waitForAuthentication(initial);
    initial.serverClose();

    await eventually(() => h.sockets.length === 2, 'retry_initial_socket_not_created');
    const retriedInitial = h.sockets[1]!;
    retriedInitial.open();
    await waitForAuthentication(retriedInitial);
    retriedInitial.serverClose();

    await eventually(() => h.sockets.length === 3, 'r2_socket_not_created');
    const takeover = h.sockets[2]!;
    await finishLiveTakeover(takeover, pending);

    expect(h.reconcileRealtimeVoiceBootstrap.mock.calls.map((call) => call[1])).toEqual([
      { protocol: MISTRAL_CONVERSATION_PROTOCOL, bootstrapTicket: B2, attempt: 1 },
      { protocol: MISTRAL_CONVERSATION_PROTOCOL, bootstrapTicket: B2, attempt: 1 },
    ]);
    const authentications = h.sockets.map((socket) => controls(socket).find(
      (control): control is Extract<
        MistralConversationClientControl,
        { readonly type: 'authenticate' }
      > => control.type === 'authenticate',
    ));
    expect(authentications).toEqual([
      {
        type: 'authenticate',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        companyId: COMPANY,
        ticket: B2,
        resumeNextServerSequence: 0,
      },
      {
        type: 'authenticate',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        companyId: COMPANY,
        ticket: B2,
        resumeNextServerSequence: 0,
      },
      {
        type: 'authenticate',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        companyId: COMPANY,
        ticket: R2,
        resumeScope: 'live_takeover',
        resumeNextServerSequence: 0,
      },
    ]);
    expect(acknowledgements(takeover).at(-1)).toEqual({
      type: 'events.ack',
      missionConnectionEpoch: 2,
      nextServerSequence: 3,
    });
  });

  it('n’incrémente la tentative qu’après attempt_consumed', async () => {
    const h = harness({
      reconciliation: [{ status: 'attempt_consumed' }, issuedBootstrap()],
    });
    const pending = h.transport.connect();

    await eventually(() => h.sockets.length === 1);
    const initial = h.sockets[0]!;
    initial.open();
    await waitForAuthentication(initial);
    initial.serverClose();

    await eventually(() => h.sockets.length === 2, 'takeover_socket_not_created');
    await finishLiveTakeover(h.sockets[1]!, pending);

    expect(h.reconcileRealtimeVoiceBootstrap.mock.calls.map((call) => call[1].attempt)).toEqual([
      1,
      2,
    ]);
    expect(h.retryDelay).not.toHaveBeenCalled();
  });

  it('persiste chaque projection terminale avant son ACK', async () => {
    const h = harness({ terminal: [terminalReceipt()] });
    const socket = await connectInitial(h);
    h.operations.length = 0;

    socket.server(drainingEvent(1));
    await eventually(() => acknowledgements(socket).some((ack) => ack.nextServerSequence === 2));
    expect(h.operations.indexOf('checkpoint:save:draining')).toBeLessThan(
      h.operations.indexOf('send:events.ack:2'),
    );

    socket.server(closedEvent(2));
    await eventually(() => acknowledgements(socket).some((ack) => ack.nextServerSequence === 3));
    expect(h.operations.indexOf('checkpoint:save:closed')).toBeLessThan(
      h.operations.indexOf('send:events.ack:3'),
    );
  });

  it('n’ACKe pas un terminal dont la sauvegarde échoue', async () => {
    const h = harness({ checkpointSaveError: new Error('secure_store_unavailable') });
    const socket = await connectInitial(h);
    const acknowledgedBefore = acknowledgements(socket);

    vi.useFakeTimers();
    try {
      socket.server(drainingEvent(1));
      await eventually(
        () => h.events.some((event) => event.type === 'fallback'),
        'checkpoint_failure_not_fail_closed',
      );
      expect(acknowledgements(socket)).toEqual(acknowledgedBefore);
      expect(h.checkpointStore.save).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_100);
      await eventually(() => h.hangupRealtimeVoiceCall.mock.calls.length === 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne supprime le checkpoint que sur terminal_complete', async () => {
    const issued = harness({ terminal: [issuedTerminal()] });
    const issuedSocket = await connectInitial(issued);
    await sendTerminal(issuedSocket);
    await eventually(() => issued.requestRealtimeVoiceResumeTicket.mock.calls.length === 1);
    expect(issued.checkpointStore.clearAfterTerminalComplete).not.toHaveBeenCalled();

    const complete = harness({ terminal: [terminalReceipt()] });
    const completeSocket = await connectInitial(complete);
    await sendTerminal(completeSocket);
    await eventually(() => complete.clearAfterTerminalComplete.mock.calls.length === 1);
    expect(complete.clearAfterTerminalComplete).toHaveBeenCalledWith(
      complete.fence,
      {
        kind: 'terminal_complete',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        ...OWNER,
        sessionHandle: SESSION,
        missionConnectionEpoch: 1,
        nextServerSequence: 3,
        reason: 'user',
      },
    );
    expect(complete.checkpointStore.save).toHaveBeenLastCalledWith(complete.fence, {
      sessionHandle: SESSION,
      missionExpiresAt: HARD_EXPIRES_AT,
      stream: {
        sessionReadyAccepted: true,
        sessionHandle: SESSION,
        missionConnectionEpoch: 1,
        nextServerSequence: 3,
        closed: true,
      },
      projection: { phase: 'closed', reason: 'user' },
    });
    expect(complete.operations.lastIndexOf('checkpoint:save:closed')).toBeLessThan(
      complete.operations.indexOf('checkpoint:clear'),
    );
  });

  it.each([
    ['appartient à un autre tenant', { companyId: 'company-other' }],
    ['avance un checkpoint CLOSED', { missionConnectionEpoch: 2, nextServerSequence: 4 }],
    ['régresse le curseur CLOSED', { nextServerSequence: 2 }],
  ] as const)('conserve le checkpoint inline si le reçu terminal %s', async (_label, patch) => {
    const h = harness({ terminal: [terminalReceipt(patch)] });
    const socket = await connectInitial(h);

    await sendTerminal(socket);
    await eventually(() => h.requestRealtimeVoiceResumeTicket.mock.calls.length === 1);
    await Promise.resolve();

    expect(h.checkpointStore.save).toHaveBeenCalledTimes(2);
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
  });

  it('rend inertes les callbacks d’une socket remplacée', async () => {
    const h = harness({ reconciliation: [{ status: 'retry_initial' }] });
    const pending = h.transport.connect();

    await eventually(() => h.sockets.length === 1);
    const obsolete = h.sockets[0]!;
    obsolete.open();
    await waitForAuthentication(obsolete);
    obsolete.serverClose();

    await eventually(() => h.sockets.length === 2, 'replacement_socket_not_created');
    const current = h.sockets[1]!;
    current.open();
    await waitForAuthentication(current);
    obsolete.staleServer(readyEvent());
    obsolete.staleClose();
    obsolete.staleError();
    await Promise.resolve();
    await Promise.resolve();

    expect(acknowledgements(current)).toEqual([]);
    expect(h.events.some((event) => event.type === 'fallback')).toBe(false);
    current.server(readyEvent());
    await pending;
    expect(h.transport.state.phase).toBe('ready');
    expect(acknowledgements(current)).toEqual([
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 1 },
    ]);
  });
});
