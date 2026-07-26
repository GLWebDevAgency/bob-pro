import {
  MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
  MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES,
  MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
  MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS,
  MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES,
  MISTRAL_CONVERSATION_PROTOCOL,
  encodeMistralConversationClientControl,
  type AgentContext,
  type MistralConversationCancelReason,
  type MistralConversationClientSessionEndReason,
  type MistralConversationClientControl,
  type MistralConversationResumeScope,
  type MistralConversationServerEvent,
  type MistralConversationSessionEndReason,
} from '@bob/ai';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type BobClient,
  type RealtimeAgentMissionSession,
  type RealtimeVoiceConfig,
  type RealtimeVoiceIssuedBootstrapReconciliation,
  type RealtimeVoiceMistralConversationCall,
  type RealtimeVoiceSpeechSourcePolicy,
} from '@bob/api-client';
import { AudioModule } from 'expo-audio';
import { randomUUID } from 'expo-crypto';

import {
  BOB_LIVE_AUDIO_FRAME_BYTES,
  BOB_LIVE_AUDIO_FRAME_DURATION_MS,
} from '../../modules/bob-live-audio';
import {
  processAudioSession,
  type ProcessAudioLease,
  type ProcessAudioSessionCoordinator,
} from '../audio';
import {
  BobLiveNativeVadSessionError,
  createBobLiveNativeVadSession,
  type BobLiveNativeSpeechCancellationReason,
  type BobLiveNativeVadSession,
  type BobLiveNativeVadSessionPort,
} from './bob-live-native-vad-session';
import type {
  BobLiveNativeCaptureFrame,
  BobLiveNativePcmAcceptance,
  BobLiveNativeVadAcceptance,
} from './bob-live-native-vad-capture';
import {
  MistralConversationAudioAdmission,
  MistralConversationAudioAdmissionError,
} from './mistral-conversation-audio-admission';
import type {
  MistralConversationCheckpointOwnerFence,
  MistralConversationCheckpointStore,
} from './mistral-conversation-checkpoint-store';
import {
  MistralConversationEventStreamError,
  MistralConversationServerEventStream,
} from './mistral-conversation-event-stream';
import type {
  MistralPcmMobileSocket,
  MistralPcmMobileSocketFactory,
} from './mistral-pcm-uplink';
import type { RealtimePublishedContextFence } from './realtime-control-gate';
import type { RealtimeAuditedUplinkTransport } from './realtime-audited-conversation-transport';
import { RealtimeMetricsTracker } from './realtime-metrics';
import {
  applyMistralConversationTerminalCompleteReceipt,
  recoverMistralConversationTerminalCheckpoint,
} from './mistral-conversation-terminal-recovery';
import {
  INITIAL_REALTIME_STATE,
  reduceRealtimeState,
  type RealtimeMachineEvent,
} from './realtime-session-machine';
import {
  RealtimeTransportError,
  type RealtimeCloseReason,
  type RealtimeFallbackReason,
  type RealtimeTransportEvent,
  type RealtimeTransportMetrics,
  type RealtimeTransportState,
  type VoiceConversationTransport,
} from './realtime-transport';

const PCM_BYTES_PER_SECOND = 16_000 * 2;
const MIN_CAPTURE_DURATION_MS = 1_000;
const MAX_CAPTURE_DURATION_MS = 900_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_TIMEOUT_MS = 5_000;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;
const MAX_PRE_ADMISSION_AUDIO_BYTES =
  MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS * PCM_BYTES_PER_SECOND / 1_000
  + BOB_LIVE_AUDIO_FRAME_BYTES;
const MAX_PENDING_SERVER_EVENTS = 128;
const MAX_DIRECT_ROUTE_RETRIES = 2;
const MAX_RECONCILIATION_ATTEMPTS = 8;
const MAX_RECONCILIATION_NETWORK_RETRIES = 3;
const TERMINAL_CONFIRM_ATTEMPTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

type ConversationClient = Pick<
  BobClient,
  | 'createRealtimeVoiceCall'
  | 'reconcileRealtimeVoiceBootstrap'
  | 'requestRealtimeVoiceResumeTicket'
  | 'hangupRealtimeVoiceCall'
>;

type AudioCoordinator = Pick<
  ProcessAudioSessionCoordinator,
  'acquire' | 'release' | 'isCurrent' | 'withPermissionRequest'
>;

export type RealtimeMistralConversationNegotiation = RealtimeVoiceConfig & {
  readonly transport: 'mistral-pcm';
  readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
};

export function isRealtimeMistralConversationNegotiation(
  value: RealtimeVoiceConfig,
): value is RealtimeMistralConversationNegotiation {
  return value.transport === 'mistral-pcm' && value.protocol === MISTRAL_CONVERSATION_PROTOCOL;
}

export interface MistralConversationCheckpointBinding {
  readonly store: MistralConversationCheckpointStore;
  readonly fence: MistralConversationCheckpointOwnerFence;
}

export interface MistralConversationTransportOptions {
  /** Snapshot écran capturé avant toute admission serveur. */
  readonly getInitialContext: () => AgentContext;
  /** Coffre terminal owner-bound. V2 refuse de démarrer sans cette durabilité. */
  readonly checkpoint: MistralConversationCheckpointBinding;
  readonly createIdentifier?: () => string;
  readonly now?: () => number;
  readonly socketFactory?: MistralPcmMobileSocketFactory;
  readonly createVadSession?: (input: {
    readonly sessionId: string;
    readonly maxCaptureDurationMs: number;
  }) => BobLiveNativeVadSessionPort | null;
  readonly requestMicrophonePermission?: () => Promise<boolean>;
  readonly audioCoordinator?: AudioCoordinator;
  readonly connectTimeoutMs?: number;
  readonly contextTimeoutMs?: number;
  readonly retryDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

interface SocketMessageEvent {
  readonly data: unknown;
}

interface RouteCredential {
  readonly websocketUrl: string;
  readonly companyId: string;
  readonly ticket: string;
  readonly ticketExpiresAt: string;
  readonly scope: 'initial' | MistralConversationResumeScope;
  readonly expectedMissionConnectionEpoch: number | null;
  readonly resumeNextServerSequence: number;
}

/** Projection mission sans capability : le b2 ne doit jamais survivre dans l'état long-vivant. */
type MissionBinding = Pick<
  RealtimeVoiceMistralConversationCall,
  | 'sessionHandle'
  | 'companyId'
  | 'hardExpiresAt'
  | 'contextRevision'
  | 'contextDigest'
  | 'routeMode'
  | 'fullDuplexCertified'
  | 'maxMissionAudioBytes'
>;

interface RouteFailure extends Error {
  readonly authSent: boolean;
}

interface ActiveTurn {
  readonly clientTurnId: string;
  readonly nativeUtteranceIndex: number;
  readonly nativeVadStartedAtMonotonicMs: number;
  readonly vadStartedAtMs: number;
  readonly preRollMs: number;
  vadEndedAtMs: number | null;
  lastCaptureSequence: number | null;
  lastCaptureStartedAtMonotonicMs: number;
  turnId: string | null;
  ordinal: number | null;
  admission: MistralConversationAudioAdmission | null;
  bufferedAudioBytes: number;
  readonly bufferedAudio: Array<{ readonly captureSequence: number; readonly pcm: Uint8Array }>;
  committed: boolean;
  cancelled: boolean;
}

interface ContextWaiter {
  readonly fence: RealtimePublishedContextFence;
  readonly deferred: Deferred<boolean>;
  readonly timer: ReturnType<typeof setTimeout>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function routeFailure(code: string, authSent: boolean): RouteFailure {
  return Object.assign(new Error(code), { name: 'MistralConversationRouteFailure', authSent });
}

function defaultSocketFactory(url: string, protocols: readonly string[]): MistralPcmMobileSocket {
  const Constructor = globalThis.WebSocket;
  if (typeof Constructor !== 'function') throw new Error('websocket_unavailable');
  return new Constructor(url, [...protocols]) as unknown as MistralPcmMobileSocket;
}

async function defaultPermissionRequest(): Promise<boolean> {
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  return permission.granted === true;
}

function canonicalFutureTimestamp(value: string, now: number): number | null {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value && epoch > now
    ? epoch
    : null;
}

function validTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 30_000 ? value : -1;
}

function captureDurationMs(
  call: RealtimeVoiceMistralConversationCall,
  negotiation: RealtimeMistralConversationNegotiation,
  now: number,
): number | null {
  const hardExpiry = canonicalFutureTimestamp(call.hardExpiresAt, now);
  const ticketExpiry = canonicalFutureTimestamp(call.ticketExpiresAt, now);
  if (hardExpiry === null || ticketExpiry === null || ticketExpiry > hardExpiry) return null;
  const budgetMs = Math.floor((call.maxMissionAudioBytes / PCM_BYTES_PER_SECOND) * 1_000);
  const duration = Math.floor(Math.min(
    negotiation.maxSessionSeconds * 1_000,
    call.maxSessionSeconds * 1_000,
    hardExpiry - now,
    budgetMs,
    MAX_CAPTURE_DURATION_MS,
  ));
  return duration >= MIN_CAPTURE_DURATION_MS ? duration : null;
}

function bootstrapMatches(
  call: RealtimeVoiceMistralConversationCall,
  negotiation: RealtimeMistralConversationNegotiation,
  requestedSessionHandle: string,
): boolean {
  return call.transport === 'mistral-pcm'
    && call.protocol === MISTRAL_CONVERSATION_PROTOCOL
    && call.sessionHandle === requestedSessionHandle
    && call.model === negotiation.model
    && call.voice === negotiation.voice
    && call.configVersion === negotiation.configVersion
    && call.speechDelivery === negotiation.speechDelivery
    && call.maxSessionSeconds === negotiation.maxSessionSeconds
    && call.contextRevision === 1
    && SHA256.test(call.contextDigest)
    && call.routeMode === 'push_to_talk'
    && call.fullDuplexCertified === false
    && Number.isSafeInteger(call.maxMissionAudioBytes)
    && call.maxMissionAudioBytes >= MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES
    && call.maxMissionAudioBytes <= MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES
    && call.maxMissionAudioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES === 0
    && call.speechSourcePolicy.mode === 'signed-url-v1';
}

function reconciliationCredential(
  value: RealtimeVoiceIssuedBootstrapReconciliation,
): RouteCredential {
  return {
    websocketUrl: value.websocketUrl,
    companyId: value.companyId,
    ticket: value.ticket,
    ticketExpiresAt: value.ticketExpiresAt,
    scope: value.scope,
    expectedMissionConnectionEpoch: value.expectedMissionConnectionEpoch,
    resumeNextServerSequence: value.resumeNextServerSequence,
  };
}

function closeReason(reason: RealtimeCloseReason): MistralConversationClientSessionEndReason {
  if (reason === 'background') return 'background';
  if (reason === 'navigation') return 'context_changed';
  if (reason === 'fallback' || reason === 'aborted' || reason === 'unmount') return 'client_handoff';
  return 'user';
}

function cancelReason(reason: 'user_speech' | 'tap' | 'navigation'): MistralConversationCancelReason {
  if (reason === 'navigation') return 'context_changed';
  if (reason === 'user_speech') return 'barge_in';
  return 'user';
}

function nativeCancellationReason(
  reason: BobLiveNativeSpeechCancellationReason,
): MistralConversationCancelReason {
  if (reason === 'requested') return 'user';
  if (reason === 'background' || reason === 'context_destroyed') return 'context_changed';
  if (reason === 'aborted') return 'session_ending';
  if (reason === 'transport_rejected') return 'network_backpressure';
  return 'route_lost';
}

function isUint32(value: number): boolean {
  return Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 0
    && value <= 0xffff_ffff;
}

function isNativeTimestamp(value: number): boolean {
  return Number.isFinite(value) && !Object.is(value, -0) && value >= 0;
}

/** iOS conserve les fractions nanoseconde; le protocole milliseconde suit le floor Android. */
function canonicalVadTimestamp(value: number): number | null {
  if (!isNativeTimestamp(value)) return null;
  const canonical = Math.floor(value);
  return Number.isSafeInteger(canonical) ? canonical : null;
}

function sameNativeTimestamp(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.01;
}

function validCapturedPcm(pcm: unknown): pcm is Uint8Array {
  return pcm instanceof Uint8Array
    && pcm.byteLength >= MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES
    && pcm.byteLength <= MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES
    && pcm.byteLength % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES === 0;
}

function retryableReconciliationFailure(
  result: Awaited<ReturnType<ConversationClient['reconcileRealtimeVoiceBootstrap']>>,
): boolean {
  return !result.ok && (
    result.error.kind === 'dependency'
    || result.error.kind === 'unavailable'
    || result.error.kind === 'rate_limited'
  );
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new RealtimeTransportError('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new RealtimeTransportError('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Conversation durable Mistral v2.
 *
 * Le b2 ne quitte jamais la mémoire de cette instance et est déréférencé dès que le premier
 * `session.ready` lié à la mission est appliqué. Toute panne WSS post-auth est réconciliée via
 * HTTP avant un éventuel r2 ; aucun retry aveugle d'une capability consommée n'est autorisé.
 */
export class MistralConversationTransport
  implements VoiceConversationTransport, RealtimeAuditedUplinkTransport
{
  readonly capabilities = Object.freeze({
    fullDuplex: false,
    bargeIn: false,
    remoteAudio: false,
  });

  readonly completesConversationAfterAuditedSpeech = false;

  private currentState: RealtimeTransportState = INITIAL_REALTIME_STATE;
  private readonly listeners = new Set<(event: RealtimeTransportEvent) => void>();
  private readonly metrics: RealtimeMetricsTracker;
  private readonly audio: AudioCoordinator;
  private generation = 0;
  private lifecycle: AbortController | null = null;
  private audioLease: ProcessAudioLease | null = null;
  private vadPort: BobLiveNativeVadSessionPort | null = null;
  private vadSession: BobLiveNativeVadSession | null = null;
  private vadAbort: AbortController | null = null;
  private vadStartTask: Promise<void> | null = null;
  private vadStopTask: Promise<void> | null = null;
  private vadGeneration = 0;
  private vadAuthorityUnproven = false;
  private socket: MistralPcmMobileSocket | null = null;
  private socketBinding: {
    readonly socket: MistralPcmMobileSocket;
    readonly generation: number;
    readonly onOpen: () => void;
    readonly onMessage: (event: SocketMessageEvent) => void;
    readonly onClose: () => void;
    readonly onError: () => void;
  } | null = null;
  private routeReady: Deferred<void> | null = null;
  private routeReadyScope: RouteCredential['scope'] | null = null;
  private routeExpectedEpoch: number | null = null;
  private routeAuthSent = false;
  private routeGeneration = 0;
  private serverEventTail = Promise.resolve();
  private pendingServerEvents = 0;
  private stream: MistralConversationServerEventStream | null = null;
  private call: MissionBinding | null = null;
  private bootstrapTicket: string | null = null;
  private sessionHandle: string | null = null;
  private agentMissionSession: RealtimeAgentMissionSession | null = null;
  private speechSourcePolicy: RealtimeVoiceSpeechSourcePolicy | null = null;
  private publishedFence: RealtimePublishedContextFence | null = null;
  private contextWaiter: ContextWaiter | null = null;
  private microphoneRequested = false;
  private awaitingAuditedResponse = false;
  private auditedCapturePauseObserved = false;
  private activeTurn: ActiveTurn | null = null;
  private missionAudioBytes = 0;
  private nextAudioSequence = 0;
  private terminalReason: MistralConversationSessionEndReason | null = null;
  private terminalReached = deferred<void>();
  private runtimeFailureSignalled = false;
  private closeTask: Promise<void> | null = null;

  constructor(
    private readonly client: ConversationClient,
    private readonly negotiation: RealtimeMistralConversationNegotiation,
    private readonly options: MistralConversationTransportOptions,
  ) {
    const now = options.now ?? Date.now;
    this.metrics = new RealtimeMetricsTracker(now);
    this.audio = options.audioCoordinator ?? processAudioSession;
  }

  get state(): RealtimeTransportState {
    return this.currentState;
  }

  getSessionHandle(): string | null {
    return this.sessionHandle;
  }

  takeAgentMissionSession(): RealtimeAgentMissionSession | null {
    const session = this.agentMissionSession;
    this.agentMissionSession = null;
    return session;
  }

  getProcessAudioLease(): ProcessAudioLease | null {
    return this.audioLease;
  }

  getSpeechSourcePolicy(): RealtimeVoiceSpeechSourcePolicy | null {
    return this.speechSourcePolicy;
  }

  subscribe(listener: (event: RealtimeTransportEvent) => void): () => void {
    this.listeners.add(listener);
    this.safeNotify(listener, { type: 'state', state: this.currentState });
    return () => this.listeners.delete(listener);
  }

  async connect(input: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.closeTask) await this.closeTask.catch(() => undefined);
    if (
      this.audioLease !== null
      || this.vadPort !== null
      || this.vadSession !== null
      || this.vadAbort !== null
      || this.vadStartTask !== null
      || this.vadStopTask !== null
      || this.vadAuthorityUnproven
    ) {
      // Une preuve native manquante conserve volontairement le lease et interdit une relève.
      throw new RealtimeTransportError('provider_error');
    }
    if (this.currentState.phase !== 'idle' && this.currentState.phase !== 'closed') {
      throw new RealtimeTransportError('bootstrap_failed');
    }
    if (input.signal?.aborted) throw new RealtimeTransportError('aborted');
    if (!this.negotiation.available) {
      throw new RealtimeTransportError(
        this.negotiation.availabilityReason === 'not_entitled'
          ? 'not_entitled'
          : this.negotiation.availabilityReason === 'entitlement_unavailable'
            ? 'entitlement_unavailable'
            : 'backend_disabled',
      );
    }
    if (validTimeout(this.options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS) < 0
      || validTimeout(this.options.contextTimeoutMs, DEFAULT_CONTEXT_TIMEOUT_MS) < 0) {
      throw new RealtimeTransportError('bootstrap_failed');
    }

    const generation = ++this.generation;
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    const externalAbort = (): void => lifecycle.abort();
    input.signal?.addEventListener('abort', externalAbort, { once: true });
    this.resetAttempt();
    this.metrics.markConnectStarted();
    this.transition({ type: 'START', generation });

    try {
      const terminalRecovered = await recoverMistralConversationTerminalCheckpoint({
        client: this.client,
        store: this.options.checkpoint.store,
        fence: this.options.checkpoint.fence,
        socketFactory: this.options.socketFactory,
        signal: lifecycle.signal,
        now: this.options.now,
        routeTimeoutMs: this.options.connectTimeoutMs,
      }).catch(() => false);
      if (!terminalRecovered) throw new RealtimeTransportError('bootstrap_failed');
      this.assertCurrent(generation, lifecycle.signal);
      this.transition({ type: 'AUTHORIZED' });

      const acquired = await this.audio.acquire({
        owner: 'bob-live-mistral-conversation-v2',
        mode: 'realtime',
        preemptLegacy: true,
      });
      if (!acquired.ok) throw new RealtimeTransportError('audio_busy');
      this.audioLease = acquired.lease;

      let permission = false;
      try {
        permission = await this.audio.withPermissionRequest(
          this.options.requestMicrophonePermission ?? defaultPermissionRequest,
        );
      } catch {
        permission = false;
      }
      this.assertCurrent(generation, lifecycle.signal);
      if (!permission) throw new RealtimeTransportError('microphone_denied');
      this.metrics.markPermissionGranted();

      const requestedSessionHandle = (this.options.createIdentifier ?? randomUUID)();
      if (!UUID.test(requestedSessionHandle)) throw new RealtimeTransportError('bootstrap_failed');
      this.sessionHandle = requestedSessionHandle;
      const callResult = await this.client.createRealtimeVoiceCall({
        transport: 'mistral-pcm',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        context: { version: 1, revision: 1, context: this.options.getInitialContext() },
        configVersion: this.negotiation.configVersion,
        speechDelivery: this.negotiation.speechDelivery,
        agentMissionProtocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
        sessionHandle: requestedSessionHandle,
      }, lifecycle.signal);
      if (!callResult.ok) {
        throw new RealtimeTransportError('agent_mission_negotiation_failed');
      }
      const agentMissionSession = callResult.value.agentMissionSession;
      if (
        !Object.hasOwn(callResult.value, 'agentMissionSession')
        || agentMissionSession === undefined
      ) {
        throw new RealtimeTransportError('agent_mission_negotiation_failed');
      }
      this.agentMissionSession = agentMissionSession;
      this.assertCurrent(generation, lifecycle.signal);
      if (callResult.value.transport !== 'mistral-pcm'
        || callResult.value.protocol !== MISTRAL_CONVERSATION_PROTOCOL
        || !bootstrapMatches(callResult.value, this.negotiation, requestedSessionHandle)) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      if (this.options.checkpoint.fence.identity.companyId !== callResult.value.companyId) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      const duration = captureDurationMs(
        callResult.value,
        this.negotiation,
        (this.options.now ?? Date.now)(),
      );
      if (duration === null) throw new RealtimeTransportError('bootstrap_failed');
      const vadPort = (this.options.createVadSession ?? createBobLiveNativeVadSession)({
        sessionId: requestedSessionHandle,
        maxCaptureDurationMs: duration,
      });
      if (vadPort === null) {
        throw new RealtimeTransportError('native_module_unavailable');
      }
      this.vadPort = vadPort;
      let quarantined = true;
      try {
        quarantined = vadPort.isQuarantined();
      } catch {
        // Une frontière native illisible ne constitue jamais une preuve d'absence de capture.
      }
      if (quarantined) {
        this.vadAuthorityUnproven = true;
        throw new RealtimeTransportError('provider_error');
      }

      this.call = Object.freeze({
        sessionHandle: callResult.value.sessionHandle,
        companyId: callResult.value.companyId,
        hardExpiresAt: callResult.value.hardExpiresAt,
        contextRevision: callResult.value.contextRevision,
        contextDigest: callResult.value.contextDigest,
        routeMode: callResult.value.routeMode,
        fullDuplexCertified: callResult.value.fullDuplexCertified,
        maxMissionAudioBytes: callResult.value.maxMissionAudioBytes,
      });
      this.speechSourcePolicy = callResult.value.speechSourcePolicy;
      this.bootstrapTicket = callResult.value.ticket;
      this.stream = new MistralConversationServerEventStream();
      await this.establishRoute(callResult.value, lifecycle.signal);
      this.assertCurrent(generation, lifecycle.signal);
      if (!this.stream.sessionReadyAccepted || this.stream.closed) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      this.metrics.markSessionReady();
      this.transition({ type: 'CONNECTED' });
      await this.startVadIfRequested();
      this.assertCurrent(generation, lifecycle.signal);
      this.emit({ type: 'connectivity', state: 'connected' });
      this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
    } catch (error) {
      this.disposeAgentMissionSession();
      let reason: RealtimeFallbackReason = lifecycle.signal.aborted || generation !== this.generation
        ? 'aborted'
        : error instanceof RealtimeTransportError
          ? error.reason
          : 'bootstrap_failed';
      let vadStopped = true;
      try {
        await this.stopVadSession();
      } catch {
        vadStopped = false;
        reason = 'provider_error';
      }
      try {
        await this.dispose(true, vadStopped);
      } catch {
        this.transition({ type: 'DEGRADED', reason: 'provider_error' });
        throw new RealtimeTransportError('provider_error');
      } finally {
        input.signal?.removeEventListener('abort', externalAbort);
      }
      this.transition({ type: 'DEGRADED', reason });
      this.transition({ type: 'CLOSED' });
      throw new RealtimeTransportError(reason);
    }
    input.signal?.removeEventListener('abort', externalAbort);
  }

  sendUserText(_text: string): boolean {
    return false;
  }

  setMicrophoneEnabled(enabled: boolean): void {
    this.microphoneRequested = enabled;
    if (!enabled) {
      if (this.awaitingAuditedResponse) this.auditedCapturePauseObserved = true;
      void this.stopVadSession().catch(() => {
        void this.failRuntime('native_vad_stop_unconfirmed', 'provider_error');
      });
      return;
    }
    if (this.awaitingAuditedResponse) {
      if (!this.auditedCapturePauseObserved || this.activeTurn !== null) return;
      this.awaitingAuditedResponse = false;
      this.auditedCapturePauseObserved = false;
    }
    void this.startVadIfRequested().catch(() => {
      void this.failRuntime('native_vad_start_failed', 'provider_error');
    });
  }

  async synchronizePublishedContext(fence: RealtimePublishedContextFence): Promise<boolean> {
    if (
      this.currentState.phase === 'closed'
      || this.currentState.phase === 'closing'
      || this.sessionHandle !== fence.sessionHandle
      || !Number.isSafeInteger(fence.contextRevision)
      || fence.contextRevision < 1
      || !SHA256.test(fence.contextDigest)
      || this.activeTurn !== null
    ) return false;
    if (
      this.publishedFence?.contextRevision === fence.contextRevision
      && this.publishedFence.contextDigest === fence.contextDigest
    ) return true;
    if (this.contextWaiter !== null) return false;
    const timeoutMs = validTimeout(this.options.contextTimeoutMs, DEFAULT_CONTEXT_TIMEOUT_MS);
    const waiter = deferred<boolean>();
    const timer = setTimeout(() => waiter.resolve(false), timeoutMs);
    this.contextWaiter = { fence: Object.freeze({ ...fence }), deferred: waiter, timer };
    try {
      await this.stopVadSession();
    } catch {
      clearTimeout(timer);
      this.contextWaiter = null;
      void this.failRuntime('native_vad_stop_unconfirmed', 'provider_error');
      return false;
    }
    // Dès que la publication change, aucun nouvel énoncé ne peut encore utiliser l'ancien fence.
    this.publishedFence = null;
    if (!this.sendControl({
      type: 'context.update',
      contextRevision: fence.contextRevision,
      contextDigest: fence.contextDigest,
    })) {
      clearTimeout(timer);
      this.contextWaiter = null;
      return false;
    }
    try {
      const synchronized = await waiter.promise;
      if (this.contextWaiter?.deferred === waiter) this.contextWaiter = null;
      if (synchronized) await this.startVadIfRequested();
      return synchronized;
    } finally {
      clearTimeout(timer);
      if (this.contextWaiter?.deferred === waiter) this.contextWaiter = null;
    }
  }

  async finishUserInput(): Promise<boolean> {
    const turn = this.activeTurn;
    if (
      !turn
      || turn.committed
      || turn.cancelled
      || turn.admission === null
      || turn.turnId === null
    ) return false;
    this.microphoneRequested = false;
    const nativeFrameEnd = turn.lastCaptureStartedAtMonotonicMs
      + BOB_LIVE_AUDIO_FRAME_DURATION_MS;
    const canonicalFrameEnd = canonicalVadTimestamp(nativeFrameEnd);
    if (canonicalFrameEnd === null) return false;
    turn.vadEndedAtMs = Math.max(turn.vadStartedAtMs, canonicalFrameEnd);
    this.metrics.markSpeechStopped();
    if (this.currentState.phase === 'user_speaking') {
      this.transition({ type: 'USER_SPEECH_STOPPED' });
    }
    try {
      if (!this.commitTurn(turn)) throw new Error('commit_send_failed');
      await this.stopVadSession();
      this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
      return true;
    } catch {
      if (!turn.committed) await this.cancelActiveTurn('network_backpressure').catch(() => undefined);
      else void this.failRuntime('native_vad_stop_unconfirmed', 'provider_error');
      return false;
    }
  }

  interrupt(reason: 'user_speech' | 'tap' | 'navigation'): boolean {
    if (reason === 'user_speech') return false;
    const turn = this.activeTurn;
    if (!turn || turn.cancelled || this.currentState.phase === 'closed') return false;
    this.microphoneRequested = false;
    void this.stopVadSession()
      .then(() => this.cancelActiveTurn(cancelReason(reason)))
      .catch(() => this.failRuntime('native_vad_stop_unconfirmed', 'provider_error'));
    return true;
  }

  close(reason: RealtimeCloseReason): Promise<void> {
    this.disposeAgentMissionSession();
    if (this.closeTask) return this.closeTask;
    if (
      this.currentState.phase === 'closed'
      && this.call === null
      && this.audioLease === null
      && this.socket === null
    ) return Promise.resolve();
    const task = this.performClose(reason).finally(() => {
      if (this.closeTask === task) this.closeTask = null;
    });
    this.closeTask = task;
    return task;
  }

  metricsSnapshot(): RealtimeTransportMetrics {
    return this.metrics.snapshot();
  }

  private async establishRoute(
    call: RealtimeVoiceMistralConversationCall,
    signal: AbortSignal,
  ): Promise<void> {
    let credential: RouteCredential = {
      websocketUrl: call.websocketUrl,
      companyId: call.companyId,
      ticket: call.ticket,
      ticketExpiresAt: call.ticketExpiresAt,
      scope: 'initial',
      expectedMissionConnectionEpoch: null,
      resumeNextServerSequence: 0,
    };
    let reconciliationAttempt = 1;
    let directRetries = 0;

    while (!signal.aborted) {
      let failure: RouteFailure;
      try {
        await this.openRoute(credential, signal);
        return;
      } catch (error) {
        failure = error && typeof error === 'object' && 'authSent' in error
          ? error as RouteFailure
          : routeFailure('route_failed', false);
        this.detachSocket(true);
      }
      if (signal.aborted) throw new RealtimeTransportError('aborted');
      const ticketExpiry = canonicalFutureTimestamp(
        credential.ticketExpiresAt,
        (this.options.now ?? Date.now)(),
      );
      if (!failure.authSent && directRetries < MAX_DIRECT_ROUTE_RETRIES && ticketExpiry !== null) {
        directRetries += 1;
        this.metrics.markReconnect();
        await this.retryDelay(directRetries, signal);
        continue;
      }

      directRetries = 0;
      let networkRetries = 0;
      while (reconciliationAttempt <= MAX_RECONCILIATION_ATTEMPTS) {
        const bootstrapTicket = this.bootstrapTicket;
        if (bootstrapTicket === null) throw new RealtimeTransportError('bootstrap_failed');
        const result = await this.client.reconcileRealtimeVoiceBootstrap(
          call.sessionHandle,
          {
            protocol: MISTRAL_CONVERSATION_PROTOCOL,
            bootstrapTicket,
            attempt: reconciliationAttempt,
          },
          signal,
        );
        if (!result.ok) {
          if (retryableReconciliationFailure(result)
            && networkRetries < MAX_RECONCILIATION_NETWORK_RETRIES) {
            networkRetries += 1;
            await this.retryDelay(networkRetries, signal);
            continue;
          }
          throw new RealtimeTransportError('bootstrap_failed');
        }
        const next = result.value;
        if (next.status === 'attempt_consumed') {
          reconciliationAttempt += 1;
          networkRetries = 0;
          continue;
        }
        credential = next.status === 'retry_initial'
          ? {
              websocketUrl: call.websocketUrl,
              companyId: call.companyId,
              ticket: bootstrapTicket,
              ticketExpiresAt: call.ticketExpiresAt,
              scope: 'initial',
              expectedMissionConnectionEpoch: null,
              resumeNextServerSequence: 0,
            }
          : reconciliationCredential(next);
        this.metrics.markReconnect();
        break;
      }
      if (reconciliationAttempt > MAX_RECONCILIATION_ATTEMPTS) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
    }
    throw new RealtimeTransportError('aborted');
  }

  private async openRoute(credential: RouteCredential, signal: AbortSignal): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const ticketExpiry = canonicalFutureTimestamp(credential.ticketExpiresAt, now);
    if (ticketExpiry === null) throw routeFailure('ticket_expired', false);
    const timeoutMs = Math.min(
      validTimeout(this.options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
      ticketExpiry - now,
    );
    if (timeoutMs <= 0) throw routeFailure('ticket_expired', false);
    const routeGeneration = ++this.routeGeneration;
    this.routeAuthSent = false;
    this.routeReadyScope = credential.scope;
    this.routeExpectedEpoch = credential.expectedMissionConnectionEpoch;
    const routeReady = deferred<void>();
    this.routeReady = routeReady;

    let socket: MistralPcmMobileSocket;
    try {
      socket = (this.options.socketFactory ?? defaultSocketFactory)(
        credential.websocketUrl,
        [MISTRAL_CONVERSATION_PROTOCOL],
      );
    } catch {
      throw routeFailure('socket_unavailable', false);
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    const opened = deferred<void>();
    const binding = {
      socket,
      generation: routeGeneration,
      onOpen: () => opened.resolve(undefined),
      onMessage: (event: SocketMessageEvent) => this.enqueueServerEvent(
        socket,
        routeGeneration,
        event.data,
      ),
      onClose: () => this.onSocketUnavailable(socket, routeGeneration),
      onError: () => this.onSocketUnavailable(socket, routeGeneration),
    };
    this.socketBinding = binding;
    socket.addEventListener('open', binding.onOpen);
    socket.addEventListener('message', binding.onMessage);
    socket.addEventListener('close', binding.onClose);
    socket.addEventListener('error', binding.onError);
    const timer = setTimeout(
      () => routeReady.reject(routeFailure('connect_timeout', this.routeAuthSent)),
      timeoutMs,
    );
    const onAbort = (): void => routeReady.reject(routeFailure('aborted', this.routeAuthSent));
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await Promise.race([
        opened.promise,
        routeReady.promise.then(() => undefined),
      ]);
      if (signal.aborted || socket.readyState !== 1) {
        throw routeFailure('socket_unavailable', false);
      }
      let ticket = credential.ticket;
      const authentication: Extract<
        MistralConversationClientControl,
        { readonly type: 'authenticate' }
      > = {
        type: 'authenticate',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        companyId: credential.companyId,
        ticket,
        ...(credential.scope === 'initial' ? {} : { resumeScope: credential.scope }),
        resumeNextServerSequence: credential.resumeNextServerSequence,
      };
      socket.send(encodeMistralConversationClientControl(authentication));
      this.routeAuthSent = true;
      ticket = '';
      await routeReady.promise;
    } catch (error) {
      const known = error && typeof error === 'object' && 'authSent' in error
        ? error as RouteFailure
        : routeFailure('route_failed', this.routeAuthSent);
      throw known;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.routeReady === routeReady) this.routeReady = null;
    }
  }

  private enqueueServerEvent(
    socket: MistralPcmMobileSocket,
    routeGeneration: number,
    raw: unknown,
  ): void {
    if (!this.isCurrentSocket(socket, routeGeneration)) return;
    this.pendingServerEvents += 1;
    if (this.pendingServerEvents > MAX_PENDING_SERVER_EVENTS) {
      this.routeReady?.reject(routeFailure('backpressure', this.routeAuthSent));
      void this.failRuntime('server_event_backpressure', 'provider_error');
      return;
    }
    this.serverEventTail = this.serverEventTail
      .then(() => this.handleServerEvent(raw, socket, routeGeneration))
      .catch((error: unknown) => {
        const code = error instanceof MistralConversationEventStreamError
          ? error.code
          : 'protocol_error';
        this.routeReady?.reject(routeFailure(code, this.routeAuthSent));
        if (this.currentState.phase === 'ready' || this.currentState.phase === 'user_speaking') {
          void this.failRuntime(code, 'provider_error');
        }
      })
      .finally(() => {
        this.pendingServerEvents = Math.max(0, this.pendingServerEvents - 1);
      });
  }

  private async handleServerEvent(
    raw: unknown,
    socket: MistralPcmMobileSocket,
    routeGeneration: number,
  ): Promise<void> {
    if (!this.isCurrentSocket(socket, routeGeneration) || !this.stream) return;
    // `accept()` avance volontairement son curseur. On l'exécute donc sur une candidate : les
    // effets locaux (et le checkpoint terminal) doivent réussir AVANT que la projection active
    // puisse avancer et produire son ACK cumulatif.
    const previous = this.stream;
    const candidate = new MistralConversationServerEventStream(previous.snapshot() ?? undefined);
    const accepted = candidate.accept(raw);
    if (accepted.kind === 'duplicate') {
      // Un ACK peut être perdu après application locale. Le replay de son doublon doit donc
      // réémettre le curseur stable sans rejouer aucun effet.
      const acknowledgement = previous.acknowledgement();
      if (acknowledgement !== null && !this.sendControl(acknowledgement)) {
        throw new Error('ack_send_failed');
      }
      return;
    }
    const event = accepted.event;
    await this.applyServerEvent(event, candidate);
    this.stream = candidate;
    const acknowledgement = candidate.acknowledgement();
    if (acknowledgement !== null && !this.sendControl(acknowledgement)) {
      throw new Error('ack_send_failed');
    }

    if (event.type === 'session.ready') {
      // Le b2 n'est plus utile dès que la mission exacte est attestée localement.
      this.bootstrapTicket = null;
      if (this.routeReadyScope === 'initial') this.routeReady?.resolve(undefined);
    } else if (event.type === 'session.route_recovered') {
      if (this.routeReadyScope === 'live_takeover') {
        if (this.routeExpectedEpoch !== event.missionConnectionEpoch) {
          throw new MistralConversationEventStreamError('invalid_server_handshake');
        }
        this.routeReady?.resolve(undefined);
      }
    } else if (event.type === 'session.closed') {
      this.terminalReached.resolve(undefined);
      if (this.routeReadyScope === 'terminal_replay') this.routeReady?.resolve(undefined);
      await this.confirmTerminalCheckpoint();
      if (this.closeTask === null) {
        // Expiration/service shutdown sans close local : ne jamais laisser le contrôleur actif
        // autour d'une mission morte ni conserver le lease audio.
        this.emit({ type: 'error', code: `mistral_session_closed_${event.reason}` });
        this.emit({ type: 'fallback', reason: 'provider_error' });
        await this.close('fallback');
      }
    }
  }

  private async applyServerEvent(
    event: MistralConversationServerEvent,
    candidateStream: MistralConversationServerEventStream,
  ): Promise<void> {
    const call = this.call;
    if (!call || !this.stream) throw new Error('missing_call');
    if (event.type === 'session.ready') {
      if (
        event.sessionHandle !== call.sessionHandle
        || event.contextRevision !== call.contextRevision
        || event.contextDigest !== call.contextDigest
        || event.expiresAt !== call.hardExpiresAt
        || event.routeMode !== call.routeMode
        || event.fullDuplexCertified !== call.fullDuplexCertified
        || event.maxMissionAudioBytes !== call.maxMissionAudioBytes
      ) throw new MistralConversationEventStreamError('invalid_server_handshake');
      this.nextAudioSequence = event.nextAudioSequence;
      this.publishedFence = {
        sessionHandle: call.sessionHandle,
        contextRevision: event.contextRevision,
        contextDigest: event.contextDigest,
      };
      return;
    }
    if (event.type === 'turn.started') {
      const turn = this.activeTurn;
      if (!turn || turn.clientTurnId !== event.clientTurnId || turn.committed) {
        throw new MistralConversationEventStreamError('invalid_server_handshake');
      }
      if (
        event.contextRevision !== this.publishedFence?.contextRevision
        || event.contextDigest !== this.publishedFence.contextDigest
        || event.firstAudioSequence !== this.nextAudioSequence
        || event.vadStartedAtMs !== turn.vadStartedAtMs
        || event.preRollMs !== turn.preRollMs
      ) throw new MistralConversationEventStreamError('invalid_server_handshake');
      turn.turnId = event.turnId;
      turn.ordinal = event.ordinal;
      // WebSocket préserve l'ordre : une annulation locale peut partir après turn.start mais
      // avant la réception de cet ACK. Le serveur doit alors émettre turn.started puis
      // turn.cancelled. On authentifie l'ACK sans rouvrir l'admission, flusher le pré-roll ni
      // produire un commit ; le prochain événement terminal libérera le tour.
      if (turn.cancelled) return;
      const remainingMission = call.maxMissionAudioBytes - this.missionAudioBytes;
      const remainingTurn = Math.min(MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES, remainingMission);
      turn.admission = new MistralConversationAudioAdmission({
        turnOrdinal: event.ordinal,
        nextAudioSequence: event.firstAudioSequence,
        remainingTurnAudioBytes: remainingTurn,
        remainingMissionAudioBytes: remainingMission,
      });
      if (!this.flushBufferedTurnAudio(turn)) {
        throw new MistralConversationAudioAdmissionError('send_failed');
      }
      if (turn.vadEndedAtMs !== null && !this.commitTurn(turn)) {
        throw new MistralConversationAudioAdmissionError('send_failed');
      }
      return;
    }
    if (event.type === 'turn.transcript') {
      this.emit({ type: 'user_transcript', text: event.text, final: event.final });
      return;
    }
    if (event.type === 'turn.cancelled') {
      const turn = this.activeTurn;
      if (turn?.clientTurnId === event.clientTurnId) {
        await this.stopVadSession();
        turn.admission?.cancel();
        this.clearBufferedTurnAudio(turn);
        this.activeTurn = null;
        this.awaitingAuditedResponse = false;
        this.auditedCapturePauseObserved = false;
        if (this.currentState.phase === 'user_speaking') {
          this.transition({ type: 'USER_SPEECH_STOPPED' });
        }
      }
      return;
    }
    if (event.type === 'turn.completed') {
      const turn = this.activeTurn;
      if (!turn || turn.clientTurnId !== event.clientTurnId || !turn.committed) {
        throw new MistralConversationEventStreamError('invalid_server_handshake');
      }
      await this.stopVadSession();
      const snapshot = turn.admission?.snapshot;
      if (snapshot?.nextAudioSequence !== null && snapshot?.nextAudioSequence !== undefined) {
        this.nextAudioSequence = snapshot.nextAudioSequence;
      }
      this.activeTurn = null;
      this.transition({ type: 'RESPONSE_DONE' });
      this.resumeVadAfterAuditedOutputIfReady();
      return;
    }
    if (event.type === 'session.context_updated') {
      const waiter = this.contextWaiter;
      if (waiter
        && waiter.fence.contextRevision === event.contextRevision
        && waiter.fence.contextDigest === event.contextDigest) {
        this.publishedFence = waiter.fence;
        waiter.deferred.resolve(true);
      }
      return;
    }
    if (event.type === 'session.route_recovering') {
      await this.stopVadSession();
      if (this.activeTurn && !this.activeTurn.cancelled) {
        this.activeTurn.admission?.beginRecovery();
      }
      return;
    }
    if (event.type === 'session.draining' || event.type === 'session.closed') {
      await this.stopVadSession();
      this.microphoneRequested = false;
      this.terminalReason = event.reason;
      const snapshot = candidateStream.snapshot();
      if (snapshot === null) throw new Error('terminal_snapshot_missing');
      await this.options.checkpoint.store.save(this.options.checkpoint.fence, {
        sessionHandle: call.sessionHandle,
        missionExpiresAt: call.hardExpiresAt,
        stream: snapshot,
        projection: { phase: event.type === 'session.closed' ? 'closed' : 'draining', reason: event.reason },
      });
      if (event.type === 'session.closed') this.transition({ type: 'CLOSED' });
      return;
    }
    if (event.type === 'error') {
      this.emit({ type: 'error', code: `mistral_${event.code}` });
      if (!event.retryable) void this.failRuntime(event.code, 'provider_error');
      return;
    }
  }

  private async startVadIfRequested(): Promise<void> {
    if (this.vadStartTask) return this.vadStartTask;
    if (this.vadStopTask) {
      await this.vadStopTask;
      return this.startVadIfRequested();
    }
    const port = this.vadPort;
    const lifecycle = this.lifecycle;
    if (
      !this.microphoneRequested
      || this.awaitingAuditedResponse
      || this.currentState.phase !== 'ready'
      || this.activeTurn !== null
      || this.contextWaiter !== null
      || this.publishedFence === null
      || this.socket === null
      || lifecycle === null
      || lifecycle.signal.aborted
      || port === null
      || this.vadSession !== null
    ) return;
    let quarantined = true;
    try {
      quarantined = port.isQuarantined();
    } catch {
      // Le bridge doit prouver explicitement qu'il n'est pas quarantiné.
    }
    if (quarantined) {
      this.vadAuthorityUnproven = true;
      throw new RealtimeTransportError('provider_error');
    }

    const runtimeGeneration = this.generation;
    const vadGeneration = ++this.vadGeneration;
    const vadAbort = new AbortController();
    const abortFromLifecycle = (): void => vadAbort.abort();
    lifecycle.signal.addEventListener('abort', abortFromLifecycle, { once: true });
    if (lifecycle.signal.aborted) vadAbort.abort();
    this.vadAbort = vadAbort;
    const task = (async (): Promise<void> => {
      try {
        const session = await port.start({
          signal: vadAbort.signal,
          onSpeechStarted: (acceptance) => this.onNativeSpeechStarted(
            acceptance,
            runtimeGeneration,
            vadGeneration,
          ),
          onSpeechFrame: (acceptance) => this.onNativeSpeechFrame(
            acceptance,
            runtimeGeneration,
            vadGeneration,
          ),
          onSpeechEnded: (acceptance) => this.onNativeSpeechEnded(
            acceptance,
            runtimeGeneration,
            vadGeneration,
          ),
          onSpeechCancelled: (cancellation) => {
            if (!this.isCurrentVadCallback(runtimeGeneration, vadGeneration)) return;
            const turn = this.activeTurn;
            if (
              !turn
              || turn.nativeUtteranceIndex !== cancellation.utteranceIndex
              || turn.vadEndedAtMs !== null
              || turn.committed
              || turn.cancelled
              || !isUint32(cancellation.lastCaptureSequence)
              || cancellation.lastCaptureSequence !== turn.lastCaptureSequence
            ) return;
            this.microphoneRequested = false;
            void this.cancelActiveTurn(nativeCancellationReason(cancellation.reason))
              .catch(() => this.failRuntime('turn_cancel_failed', 'provider_error'));
          },
          onError: () => {
            if (this.isCurrentVadCallback(runtimeGeneration, vadGeneration)) {
              void this.failRuntime('native_vad_capture_failed', 'provider_error');
            }
          },
        });
        if (
          !this.isCurrentVadCallback(runtimeGeneration, vadGeneration)
          || !this.microphoneRequested
          || this.awaitingAuditedResponse
          || (
            this.currentState.phase !== 'ready'
            && this.currentState.phase !== 'user_speaking'
          )
        ) {
          this.vadSession = session;
          await this.stopResolvedVadSession(session);
          return;
        }
        this.vadSession = session;
      } catch (error) {
        if (
          error instanceof BobLiveNativeVadSessionError
          && (
            error.code === 'native_vad_session_quarantined'
            || error.code === 'native_vad_session_stop_failed'
          )
        ) this.vadAuthorityUnproven = true;
        const expectedAbort = error instanceof BobLiveNativeVadSessionError
          && error.code === 'native_vad_session_aborted'
          && (vadAbort.signal.aborted || vadGeneration !== this.vadGeneration);
        if (!expectedAbort) throw error;
      } finally {
        lifecycle.signal.removeEventListener('abort', abortFromLifecycle);
        if (this.vadAbort === vadAbort) this.vadAbort = null;
      }
    })();
    this.vadStartTask = task;
    try {
      await task;
    } finally {
      if (this.vadStartTask === task) this.vadStartTask = null;
    }
  }

  private isCurrentVadCallback(runtimeGeneration: number, vadGeneration: number): boolean {
    return runtimeGeneration === this.generation
      && vadGeneration === this.vadGeneration
      && this.lifecycle?.signal.aborted === false;
  }

  private onNativeSpeechStarted(
    acceptance: Extract<BobLiveNativeVadAcceptance, { readonly kind: 'speech_started' }>,
    runtimeGeneration: number,
    vadGeneration: number,
  ): boolean {
    const fence = this.publishedFence;
    const event = acceptance.event;
    const vadStartedAtMs = canonicalVadTimestamp(event.startedAtMonotonicMs);
    if (
      !this.isCurrentVadCallback(runtimeGeneration, vadGeneration)
      || !this.microphoneRequested
      || this.awaitingAuditedResponse
      || this.currentState.phase !== 'ready'
      || this.activeTurn !== null
      || this.contextWaiter !== null
      || fence === null
      || this.socket === null
      || event.kind !== 'speech_started'
      || !isUint32(event.utteranceIndex)
      || vadStartedAtMs === null
      || !isNativeTimestamp(event.detectedAtMonotonicMs)
      || event.detectedAtMonotonicMs < event.startedAtMonotonicMs
      || !Number.isSafeInteger(event.preRollMs)
      || event.preRollMs < 0
      || event.preRollMs > MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS
      || event.startedAtMonotonicMs < event.preRollMs
      || event.endedAtMonotonicMs !== null
      || !Array.isArray(acceptance.initialFrames)
      || acceptance.initialFrames.length === 0
    ) return false;

    const bufferedAudio: ActiveTurn['bufferedAudio'] = [];
    let bufferedAudioBytes = 0;
    let lastCaptureSequence: number | null = null;
    let lastCaptureStartedAtMonotonicMs = -1;
    for (const frame of acceptance.initialFrames) {
      if (
        !isUint32(frame.captureSequence)
        || (lastCaptureSequence !== null && frame.captureSequence !== lastCaptureSequence + 1)
        || !isNativeTimestamp(frame.startedAtMonotonicMs)
        || frame.startedAtMonotonicMs < lastCaptureStartedAtMonotonicMs
        || !validCapturedPcm(frame.pcm)
      ) {
        this.clearBufferedAudio(bufferedAudio);
        return false;
      }
      const pcm = Uint8Array.from(frame.pcm);
      bufferedAudioBytes += pcm.byteLength;
      if (bufferedAudioBytes > MAX_PRE_ADMISSION_AUDIO_BYTES) {
        for (const buffered of bufferedAudio) buffered.pcm.fill(0);
        return false;
      }
      bufferedAudio.push({ captureSequence: frame.captureSequence, pcm });
      lastCaptureSequence = frame.captureSequence;
      lastCaptureStartedAtMonotonicMs = frame.startedAtMonotonicMs;
    }
    if (
      !sameNativeTimestamp(
        acceptance.initialFrames[0]?.startedAtMonotonicMs ?? -1,
        event.startedAtMonotonicMs - event.preRollMs,
      )
      || lastCaptureStartedAtMonotonicMs > event.detectedAtMonotonicMs
    ) {
      this.clearBufferedAudio(bufferedAudio);
      return false;
    }

    let clientTurnId: string;
    try {
      clientTurnId = (this.options.createIdentifier ?? randomUUID)();
    } catch {
      this.clearBufferedAudio(bufferedAudio);
      return false;
    }
    if (!UUID.test(clientTurnId)) {
      this.clearBufferedAudio(bufferedAudio);
      return false;
    }
    const turn: ActiveTurn = {
      clientTurnId,
      nativeUtteranceIndex: event.utteranceIndex,
      nativeVadStartedAtMonotonicMs: event.startedAtMonotonicMs,
      vadStartedAtMs,
      preRollMs: event.preRollMs,
      vadEndedAtMs: null,
      lastCaptureSequence,
      lastCaptureStartedAtMonotonicMs,
      turnId: null,
      ordinal: null,
      admission: null,
      bufferedAudioBytes,
      bufferedAudio,
      committed: false,
      cancelled: false,
    };
    this.activeTurn = turn;
    if (!this.sendControl({
      type: 'turn.start',
      clientTurnId,
      contextRevision: fence.contextRevision,
      contextDigest: fence.contextDigest,
      vadStartedAtMs: turn.vadStartedAtMs,
      preRollMs: turn.preRollMs,
    })) {
      this.clearBufferedTurnAudio(turn);
      this.activeTurn = null;
      return false;
    }
    this.transition({ type: 'USER_SPEECH_STARTED' });
    return true;
  }

  private onNativeSpeechFrame(
    acceptance: Extract<BobLiveNativePcmAcceptance, { readonly kind: 'speech_frame' }>,
    runtimeGeneration: number,
    vadGeneration: number,
  ): boolean {
    const turn = this.activeTurn;
    if (
      !this.isCurrentVadCallback(runtimeGeneration, vadGeneration)
      || !this.microphoneRequested
      || !turn
      || turn.cancelled
      || turn.committed
      || turn.vadEndedAtMs !== null
    ) return false;
    return this.acceptNativeTurnFrame(turn, acceptance.frame);
  }

  private onNativeSpeechEnded(
    acceptance: Extract<BobLiveNativeVadAcceptance, { readonly kind: 'speech_ended' }>,
    runtimeGeneration: number,
    vadGeneration: number,
  ): boolean {
    const turn = this.activeTurn;
    const event = acceptance.event;
    const vadEndedAtMs = event.endedAtMonotonicMs === null
      ? null
      : canonicalVadTimestamp(event.endedAtMonotonicMs);
    if (
      !this.isCurrentVadCallback(runtimeGeneration, vadGeneration)
      || !turn
      || turn.cancelled
      || turn.committed
      || turn.vadEndedAtMs !== null
      || event.kind !== 'speech_ended'
      || event.utteranceIndex !== turn.nativeUtteranceIndex
      || !sameNativeTimestamp(
        event.startedAtMonotonicMs,
        turn.nativeVadStartedAtMonotonicMs,
      )
      || event.preRollMs !== turn.preRollMs
      || vadEndedAtMs === null
      || event.endedAtMonotonicMs === null
      || event.endedAtMonotonicMs < turn.nativeVadStartedAtMonotonicMs
      || !isUint32(acceptance.lastForwardedCaptureSequence)
      || acceptance.lastForwardedCaptureSequence !== turn.lastCaptureSequence
    ) return false;

    turn.vadEndedAtMs = Math.max(turn.vadStartedAtMs, vadEndedAtMs);
    this.metrics.markSpeechStopped();
    if (this.currentState.phase === 'user_speaking') {
      this.transition({ type: 'USER_SPEECH_STOPPED' });
    }
    if (turn.admission !== null && !this.commitTurn(turn)) return false;
    this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
    // Le ring VAD efface son utterance actif juste après ce retour synchrone.
    queueMicrotask(() => {
      void this.stopVadSession().catch(() => {
        void this.failRuntime('native_vad_stop_unconfirmed', 'provider_error');
      });
    });
    return true;
  }

  private acceptNativeTurnFrame(turn: ActiveTurn, frame: BobLiveNativeCaptureFrame): boolean {
    if (
      !isUint32(frame.captureSequence)
      || turn.lastCaptureSequence === null
      || frame.captureSequence !== turn.lastCaptureSequence + 1
      || !isNativeTimestamp(frame.startedAtMonotonicMs)
      || frame.startedAtMonotonicMs < turn.lastCaptureStartedAtMonotonicMs
      || !validCapturedPcm(frame.pcm)
    ) return false;
    if (turn.admission !== null) {
      if (!this.admitTurnFrame(turn, frame.captureSequence, frame.pcm)) return false;
      turn.lastCaptureSequence = frame.captureSequence;
      turn.lastCaptureStartedAtMonotonicMs = frame.startedAtMonotonicMs;
      return true;
    }
    const pcm = Uint8Array.from(frame.pcm);
    if (turn.bufferedAudioBytes + pcm.byteLength > MAX_PRE_ADMISSION_AUDIO_BYTES) {
      pcm.fill(0);
      this.clearBufferedTurnAudio(turn);
      return false;
    }
    turn.bufferedAudio.push({ captureSequence: frame.captureSequence, pcm });
    turn.bufferedAudioBytes += pcm.byteLength;
    turn.lastCaptureSequence = frame.captureSequence;
    turn.lastCaptureStartedAtMonotonicMs = frame.startedAtMonotonicMs;
    return true;
  }

  private admitTurnFrame(
    turn: ActiveTurn,
    captureSequence: number,
    pcm: Uint8Array,
  ): boolean {
    const admission = turn.admission;
    if (admission === null) return false;
    const admitted = admission.tryAdmit(
      { captureSequence, pcm },
      (frame) => this.sendBinary(frame),
    );
    if (admitted.kind !== 'admitted') return false;
    this.missionAudioBytes += admitted.audioBytes;
    return true;
  }

  private flushBufferedTurnAudio(turn: ActiveTurn): boolean {
    let flushed = true;
    try {
      for (const frame of turn.bufferedAudio) {
        if (!this.admitTurnFrame(turn, frame.captureSequence, frame.pcm)) {
          flushed = false;
          break;
        }
      }
      return flushed;
    } finally {
      this.clearBufferedTurnAudio(turn);
    }
  }

  private clearBufferedAudio(
    bufferedAudio: Array<{ readonly captureSequence: number; readonly pcm: Uint8Array }>,
  ): void {
    for (const frame of bufferedAudio) frame.pcm.fill(0);
    bufferedAudio.length = 0;
  }

  private clearBufferedTurnAudio(turn: ActiveTurn): void {
    this.clearBufferedAudio(turn.bufferedAudio);
    turn.bufferedAudioBytes = 0;
  }

  private commitTurn(turn: ActiveTurn): boolean {
    if (turn.committed) return true;
    if (
      turn.cancelled
      || turn.vadEndedAtMs === null
      || turn.turnId === null
      || turn.admission === null
    ) return false;
    let lastAudioSequence: number;
    try {
      lastAudioSequence = turn.admission.commit();
    } catch {
      return false;
    }
    if (!this.sendControl({
      type: 'turn.commit',
      clientTurnId: turn.clientTurnId,
      lastAudioSequence,
      vadEndedAtMs: turn.vadEndedAtMs,
    })) return false;
    turn.committed = true;
    this.awaitingAuditedResponse = true;
    this.auditedCapturePauseObserved = false;
    // L'état READY précède toujours ce signal : le contrôleur publie ensuite `thinking`.
    this.emit({ type: 'user_input_committed', turnId: turn.turnId });
    return true;
  }

  private async stopResolvedVadSession(session: BobLiveNativeVadSession): Promise<void> {
    if (this.vadStopTask) return this.vadStopTask;
    const callbackGeneration = this.vadGeneration;
    let nativeStop: Promise<void>;
    try {
      // Le wrapper natif publie synchroniquement l'éventuelle annulation avant ce retour.
      nativeStop = session.stop();
    } catch (error) {
      nativeStop = Promise.reject(error);
    }
    if (this.vadGeneration === callbackGeneration) this.vadGeneration += 1;
    const task = nativeStop;
    this.vadStopTask = task;
    try {
      await task;
      if (this.vadSession === session) {
        this.vadSession = null;
        this.vadAuthorityUnproven = false;
      }
    } finally {
      if (this.vadStopTask === task) this.vadStopTask = null;
    }
  }

  private async stopVadSession(): Promise<void> {
    if (this.vadStopTask) return this.vadStopTask;
    const startTask = this.vadStartTask;
    if (this.vadSession === null && startTask) {
      const callbackGeneration = this.vadGeneration;
      // Abort déclenche d'abord l'annulation corrélée, puis on ferme la génération JS.
      this.vadAbort?.abort();
      if (this.vadGeneration === callbackGeneration) this.vadGeneration += 1;
      await startTask;
    }
    const session = this.vadSession;
    if (session === null) {
      this.vadAbort = null;
      if (this.vadAuthorityUnproven) throw new RealtimeTransportError('provider_error');
      return;
    }
    await this.stopResolvedVadSession(session);
  }

  private resumeVadAfterAuditedOutputIfReady(): void {
    if (
      !this.awaitingAuditedResponse
      || !this.auditedCapturePauseObserved
      || !this.microphoneRequested
      || this.activeTurn !== null
    ) return;
    this.awaitingAuditedResponse = false;
    this.auditedCapturePauseObserved = false;
    void this.startVadIfRequested().catch(() => {
      void this.failRuntime('native_vad_start_failed', 'provider_error');
    });
  }

  private async cancelActiveTurn(reason: MistralConversationCancelReason): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || turn.cancelled || turn.committed) return;
    turn.cancelled = true;
    turn.admission?.cancel();
    this.clearBufferedTurnAudio(turn);
    this.awaitingAuditedResponse = false;
    this.auditedCapturePauseObserved = false;
    if (this.currentState.phase === 'user_speaking') {
      this.metrics.markSpeechStopped();
      this.transition({ type: 'USER_SPEECH_STOPPED' });
    }
    const cancellationId = (this.options.createIdentifier ?? randomUUID)();
    if (!UUID.test(cancellationId) || !this.sendControl({
      type: 'turn.cancel',
      clientTurnId: turn.clientTurnId,
      cancellationId,
      reason,
    })) throw new Error('turn_cancel_failed');
  }

  private sendControl(control: MistralConversationClientControl): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    try {
      const encoded = encodeMistralConversationClientControl(control);
      const bytes = new TextEncoder().encode(encoded).byteLength;
      if (socket.bufferedAmount + bytes > MAX_SOCKET_BUFFERED_BYTES) return false;
      socket.send(encoded);
      return true;
    } catch {
      return false;
    }
  }

  private sendBinary(frame: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    try {
      if (socket.bufferedAmount + frame.byteLength > MAX_SOCKET_BUFFERED_BYTES) return false;
      socket.send(Uint8Array.from(frame).buffer);
      return true;
    } catch {
      return false;
    }
  }

  private async confirmTerminalCheckpoint(): Promise<void> {
    const call = this.call;
    const stream = this.stream;
    const reason = this.terminalReason;
    if (!call || !stream || reason === null) return;
    const snapshot = stream.snapshot();
    if (!snapshot?.closed) return;
    for (let attempt = 1; attempt <= TERMINAL_CONFIRM_ATTEMPTS; attempt += 1) {
      const result = await this.client.requestRealtimeVoiceResumeTicket(call.sessionHandle, {
        missionConnectionEpoch: snapshot.missionConnectionEpoch,
        nextServerSequence: snapshot.nextServerSequence,
      });
      if (!result.ok) {
        if (attempt < TERMINAL_CONFIRM_ATTEMPTS && (
          result.error.kind === 'dependency' || result.error.kind === 'unavailable'
        )) {
          await this.retryDelay(attempt, this.lifecycle?.signal ?? new AbortController().signal)
            .catch(() => undefined);
          continue;
        }
        return;
      }
      if (result.value.status !== 'terminal_complete') {
        // Le ticket r2 reste strictement en mémoire. On détache d'abord la route terminale qui a
        // produit le checkpoint, puis le worker commun rejoue/sauve/ACKe jusqu'à la preuve HTTP.
        this.detachSocket(true);
        await recoverMistralConversationTerminalCheckpoint({
          client: this.client,
          store: this.options.checkpoint.store,
          fence: this.options.checkpoint.fence,
          socketFactory: this.options.socketFactory,
          signal: this.lifecycle?.signal,
          now: this.options.now,
          routeTimeoutMs: this.options.connectTimeoutMs,
          initialTicket: result.value,
        }).catch(() => false);
        return;
      }
      await applyMistralConversationTerminalCompleteReceipt({
        receipt: result.value,
        checkpoint: {
          version: 1,
          protocol: MISTRAL_CONVERSATION_PROTOCOL,
          subjectId: this.options.checkpoint.fence.identity.subjectId,
          companyId: this.options.checkpoint.fence.identity.companyId,
          sessionHandle: call.sessionHandle,
          missionExpiresAt: call.hardExpiresAt,
          stream: snapshot,
          projection: { phase: 'closed', reason },
        },
        store: this.options.checkpoint.store,
        fence: this.options.checkpoint.fence,
      });
      return;
    }
  }

  private async performClose(reason: RealtimeCloseReason): Promise<void> {
    ++this.generation;
    this.microphoneRequested = false;
    this.transition({ type: 'CLOSE' });
    this.contextWaiter?.deferred.resolve(false);
    this.contextWaiter = null;
    let vadStopped = true;
    try {
      await this.stopVadSession();
    } catch {
      vadStopped = false;
    }
    const socket = this.socket;
    if (socket?.readyState === 1 && this.stream?.sessionReadyAccepted && !this.stream.closed) {
      this.sendControl({ type: 'session.end', reason: closeReason(reason) });
      await Promise.race([
        this.terminalReached.promise,
        sleepWithAbort(2_000, new AbortController().signal),
      ]).catch(() => undefined);
    }
    await this.dispose(true, vadStopped);
    this.transition({ type: 'CLOSED' });
    this.emit({ type: 'connectivity', state: 'disconnected' });
    this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
    if (!vadStopped) throw new RealtimeTransportError('provider_error');
  }

  private async dispose(hangup: boolean, releaseAudio = true): Promise<void> {
    this.disposeAgentMissionSession();
    this.lifecycle?.abort();
    this.lifecycle = null;
    this.bootstrapTicket = null;
    this.detachSocket(true);
    if (hangup && this.sessionHandle) {
      const ended = await this.client.hangupRealtimeVoiceCall(this.sessionHandle).catch(() => null);
      if (ended === null || !ended.ok) this.emit({ type: 'error', code: 'server_hangup_pending' });
    }
    if (releaseAudio) {
      this.audio.release(this.audioLease);
      this.audioLease = null;
      this.vadPort = null;
      this.vadSession = null;
      this.vadAbort = null;
      this.vadStartTask = null;
      this.vadStopTask = null;
      this.vadAuthorityUnproven = false;
      this.sessionHandle = null;
      this.speechSourcePolicy = null;
      this.call = null;
    }
    if (this.activeTurn) this.clearBufferedTurnAudio(this.activeTurn);
    this.activeTurn = null;
    this.awaitingAuditedResponse = false;
    this.auditedCapturePauseObserved = false;
  }

  private disposeAgentMissionSession(): void {
    const session = this.agentMissionSession;
    this.agentMissionSession = null;
    session?.dispose();
  }

  private detachSocket(close: boolean): void {
    const binding = this.socketBinding;
    if (binding) {
      binding.socket.removeEventListener('open', binding.onOpen);
      binding.socket.removeEventListener('message', binding.onMessage);
      binding.socket.removeEventListener('close', binding.onClose);
      binding.socket.removeEventListener('error', binding.onError);
      if (close) {
        try {
          binding.socket.close(1000, 'client_close');
        } catch {
          // Socket déjà détruite.
        }
      }
    }
    this.socketBinding = null;
    this.socket = null;
    this.routeReady = null;
  }

  private onSocketUnavailable(socket: MistralPcmMobileSocket, routeGeneration: number): void {
    if (!this.isCurrentSocket(socket, routeGeneration)) return;
    const failure = routeFailure('socket_unavailable', this.routeAuthSent);
    if (this.routeReady !== null) {
      this.routeReady.reject(failure);
      return;
    }
    if (this.currentState.phase !== 'closing' && this.currentState.phase !== 'closed') {
      void this.failRuntime('mistral_socket_closed', 'provider_error');
    }
  }

  private isCurrentSocket(socket: MistralPcmMobileSocket, routeGeneration: number): boolean {
    return this.socket === socket
      && this.socketBinding?.socket === socket
      && this.socketBinding.generation === routeGeneration;
  }

  private async retryDelay(attempt: number, signal: AbortSignal): Promise<void> {
    if (this.options.retryDelay) return this.options.retryDelay(attempt, signal);
    return sleepWithAbort(Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1)), signal);
  }

  private async failRuntime(code: string, reason: RealtimeFallbackReason): Promise<void> {
    if (this.runtimeFailureSignalled
      || this.currentState.phase === 'closing'
      || this.currentState.phase === 'closed') return;
    this.runtimeFailureSignalled = true;
    this.emit({ type: 'error', code });
    this.transition({ type: 'DEGRADED', reason });
    this.emit({ type: 'fallback', reason });
    try {
      await this.close('fallback');
    } catch {
      // L'orchestrateur constatera lui-même l'absence de preuve d'arrêt au close suivant.
    }
  }

  private resetAttempt(): void {
    this.detachSocket(true);
    this.audioLease = null;
    this.vadPort = null;
    this.vadSession = null;
    this.vadAbort = null;
    this.vadStartTask = null;
    this.vadStopTask = null;
    this.vadAuthorityUnproven = false;
    this.vadGeneration += 1;
    this.call = null;
    this.bootstrapTicket = null;
    this.sessionHandle = null;
    this.speechSourcePolicy = null;
    this.publishedFence = null;
    this.contextWaiter = null;
    this.microphoneRequested = false;
    this.awaitingAuditedResponse = false;
    this.auditedCapturePauseObserved = false;
    this.activeTurn = null;
    this.missionAudioBytes = 0;
    this.nextAudioSequence = 0;
    this.terminalReason = null;
    this.terminalReached = deferred<void>();
    this.runtimeFailureSignalled = false;
    this.stream = null;
    this.serverEventTail = Promise.resolve();
    this.pendingServerEvents = 0;
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (generation !== this.generation || signal.aborted) {
      throw new RealtimeTransportError('aborted');
    }
  }

  private transition(event: RealtimeMachineEvent): void {
    const next = reduceRealtimeState(this.currentState, event);
    if (next === this.currentState) return;
    this.currentState = next;
    this.emit({ type: 'state', state: next });
  }

  private emit(event: RealtimeTransportEvent): void {
    for (const listener of this.listeners) this.safeNotify(listener, event);
  }

  private safeNotify(
    listener: (event: RealtimeTransportEvent) => void,
    event: RealtimeTransportEvent,
  ): void {
    try {
      listener(event);
    } catch {
      // Une projection UI ne possède jamais l'autorité audio ou réseau.
    }
  }
}
