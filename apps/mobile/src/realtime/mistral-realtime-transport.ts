import type { AgentContext } from '@bob/ai';
import type {
  BobClient,
  RealtimeVoiceConfig,
  RealtimeVoiceMistralPcmCall,
  RealtimeVoiceSpeechSourcePolicy,
} from '@bob/api-client';
import { AudioModule } from 'expo-audio';
import { randomUUID } from 'expo-crypto';
import {
  processAudioSession,
  type ProcessAudioLease,
  type ProcessAudioSessionCoordinator,
} from '../audio';
import { createBobLiveNativePcmCapture } from './bob-live-native-pcm-capture';
import {
  MISTRAL_PCM_UPLINK_PROTOCOL,
  MistralPcmUplink,
  type MistralPcmCapturePort,
  type MistralPcmMobileSocket,
  type MistralPcmMobileSocketFactory,
  type MistralPcmUplinkEvent,
} from './mistral-pcm-uplink';
import { RealtimeMetricsTracker } from './realtime-metrics';
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
import type { RealtimeAuditedUplinkTransport } from './realtime-audited-conversation-transport';

const PCM_BYTES_PER_SECOND = 16_000 * 2;
const MIN_NATIVE_CAPTURE_DURATION_MS = 1_000;
const MAX_NATIVE_CAPTURE_DURATION_MS = 900_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type MistralRealtimeClient = Pick<BobClient, 'createRealtimeVoiceCall' | 'hangupRealtimeVoiceCall'>;

type AudioCoordinator = Pick<
  ProcessAudioSessionCoordinator,
  'acquire' | 'release' | 'isCurrent' | 'withPermissionRequest'
>;

export type RealtimeMistralPcmNegotiation = RealtimeVoiceConfig & {
  readonly transport: 'mistral-pcm';
  readonly protocol?: typeof MISTRAL_PCM_UPLINK_PROTOCOL;
};

export function isRealtimeMistralPcmNegotiation(
  value: RealtimeVoiceConfig,
): value is RealtimeMistralPcmNegotiation {
  return value.transport === 'mistral-pcm'
    && (value.protocol === undefined || value.protocol === MISTRAL_PCM_UPLINK_PROTOCOL);
}

export interface MistralRealtimeTransportOptions {
  /** Snapshot focalisé au moment exact du bootstrap ; le PUT r1 suivant doit être identique. */
  readonly getInitialContext: () => AgentContext;
  readonly createIdentifier?: () => string;
  readonly now?: () => number;
  readonly socketFactory?: MistralPcmMobileSocketFactory;
  readonly createCapture?: (input: {
    readonly sessionId: string;
    readonly maxCaptureDurationMs: number;
  }) => MistralPcmCapturePort | null;
  readonly requestMicrophonePermission?: () => Promise<boolean>;
  readonly audioCoordinator?: AudioCoordinator;
  readonly connectTimeoutMs?: number;
}

interface AttemptResources {
  audioLease: ProcessAudioLease | null;
  uplink: MistralPcmUplink | null;
  unsubscribeUplink: (() => void) | null;
  sessionHandle: string | null;
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
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && parsed > now
    ? parsed
    : null;
}

function nativeCaptureDurationMs(
  call: RealtimeVoiceMistralPcmCall,
  negotiation: RealtimeMistralPcmNegotiation,
  now: number,
): number | null {
  const hardExpiry = canonicalFutureTimestamp(call.hardExpiresAt, now);
  const ticketExpiry = canonicalFutureTimestamp(call.ticketExpiresAt, now);
  if (hardExpiry === null || ticketExpiry === null || ticketExpiry > hardExpiry) return null;
  if (!Number.isSafeInteger(call.maxAudioBytes) || call.maxAudioBytes < PCM_BYTES_PER_SECOND) {
    return null;
  }
  const audioBudgetMs = Math.floor((call.maxAudioBytes / PCM_BYTES_PER_SECOND) * 1_000);
  const duration = Math.floor(
    Math.min(
      negotiation.maxSessionSeconds * 1_000,
      call.maxSessionSeconds * 1_000,
      hardExpiry - now,
      audioBudgetMs,
      MAX_NATIVE_CAPTURE_DURATION_MS,
    ),
  );
  return duration >= MIN_NATIVE_CAPTURE_DURATION_MS ? duration : null;
}

function bootstrapMatchesNegotiation(
  call: RealtimeVoiceMistralPcmCall,
  negotiation: RealtimeMistralPcmNegotiation,
  requestedSessionHandle: string,
): boolean {
  return (
    call.transport === 'mistral-pcm' &&
    call.sessionHandle === requestedSessionHandle &&
    call.protocol === MISTRAL_PCM_UPLINK_PROTOCOL &&
    call.model === negotiation.model &&
    call.voice === negotiation.voice &&
    call.configVersion === negotiation.configVersion &&
    call.speechDelivery === negotiation.speechDelivery &&
    call.maxSessionSeconds === negotiation.maxSessionSeconds &&
    call.contextRevision === 1 &&
    /^[a-f0-9]{64}$/u.test(call.contextDigest) &&
    call.speechSourcePolicy.mode === 'signed-url-v1'
  );
}

/**
 * Oreille Mistral de Bob Live.
 *
 * Le ticket actuel est volontairement one-shot : PCM montant seulement, puis réponse issue du
 * feed acoustique audité Bob. Cette classe ne prétend donc ni full-duplex ni barge-in. Elle garde
 * néanmoins les frontières du futur runtime extractible (transport, capture, lease, métriques et
 * client injectables) sans faire remonter une dépendance métier dans le module natif.
 */
export class MistralRealtimeTransport
  implements VoiceConversationTransport, RealtimeAuditedUplinkTransport
{
  readonly capabilities = {
    fullDuplex: false,
    bargeIn: false,
    remoteAudio: false,
  } as const;

  readonly completesConversationAfterAuditedSpeech = true;

  private currentState: RealtimeTransportState = INITIAL_REALTIME_STATE;
  private readonly listeners = new Set<(event: RealtimeTransportEvent) => void>();
  private readonly metrics: RealtimeMetricsTracker;
  private readonly audio: AudioCoordinator;
  private generation = 0;
  private audioLease: ProcessAudioLease | null = null;
  private uplink: MistralPcmUplink | null = null;
  private unsubscribeUplink: (() => void) | null = null;
  private sessionHandle: string | null = null;
  private speechSourcePolicy: RealtimeVoiceSpeechSourcePolicy | null = null;
  private microphoneRequested = false;
  private captureActive = false;
  private captureStartTask: Promise<void> | null = null;
  private captureStopTask: Promise<void> | null = null;
  private captureGeneration = 0;
  private inputFinalized = false;
  private providerCompleted = false;
  private runtimeFailureSignalled = false;
  private abortSignal: AbortSignal | null = null;
  private abortListener: (() => void) | null = null;
  private bootstrapAbort: AbortController | null = null;
  private closeTask: Promise<void> | null = null;

  constructor(
    private readonly client: MistralRealtimeClient,
    private readonly negotiation: RealtimeMistralPcmNegotiation,
    private readonly options: MistralRealtimeTransportOptions,
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
    if (this.closeTask) {
      try {
        await this.closeTask;
      } catch {
        throw new RealtimeTransportError('provider_error');
      }
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

    const generation = ++this.generation;
    const resources: AttemptResources = {
      audioLease: null,
      uplink: null,
      unsubscribeUplink: null,
      sessionHandle: null,
    };
    this.resetAttemptState();
    this.metrics.markConnectStarted();
    this.transition({ type: 'START', generation });
    this.bindAbort(input.signal, generation);
    const bootstrapAbort = new AbortController();
    this.bootstrapAbort = bootstrapAbort;

    try {
      this.assertGeneration(generation);
      this.transition({ type: 'AUTHORIZED' });
      const acquired = await this.audio.acquire({
        owner: 'bob-live-mistral-pcm',
        mode: 'realtime',
        preemptLegacy: true,
      });
      if (!acquired.ok) throw new RealtimeTransportError('audio_busy');
      resources.audioLease = acquired.lease;
      this.audioLease = acquired.lease;
      this.assertGeneration(generation);

      let permissionGranted = false;
      try {
        permissionGranted = await this.audio.withPermissionRequest(
          this.options.requestMicrophonePermission ?? defaultPermissionRequest,
        );
      } catch {
        permissionGranted = false;
      }
      this.assertGeneration(generation);
      if (!permissionGranted) throw new RealtimeTransportError('microphone_denied');
      this.metrics.markPermissionGranted();

      const requestedSessionHandle = (this.options.createIdentifier ?? randomUUID)();
      if (!UUID.test(requestedSessionHandle)) throw new RealtimeTransportError('bootstrap_failed');
      resources.sessionHandle = requestedSessionHandle;
      this.sessionHandle = requestedSessionHandle;
      const context = this.options.getInitialContext();
      const call = await this.client.createRealtimeVoiceCall(
        {
          transport: 'mistral-pcm',
          context: { version: 1, revision: 1, context },
          configVersion: this.negotiation.configVersion,
          speechDelivery: this.negotiation.speechDelivery,
          sessionHandle: requestedSessionHandle,
        },
        bootstrapAbort.signal,
      );
      this.assertGeneration(generation);
      if (
        !call.ok
        || call.value.transport !== 'mistral-pcm'
        || call.value.protocol !== MISTRAL_PCM_UPLINK_PROTOCOL
      ) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      if (!bootstrapMatchesNegotiation(call.value, this.negotiation, requestedSessionHandle)) {
        throw new RealtimeTransportError('bootstrap_failed');
      }

      const now = (this.options.now ?? Date.now)();
      const maxCaptureDurationMs = nativeCaptureDurationMs(call.value, this.negotiation, now);
      if (maxCaptureDurationMs === null) throw new RealtimeTransportError('bootstrap_failed');
      const capture = (this.options.createCapture ?? createBobLiveNativePcmCapture)({
        sessionId: requestedSessionHandle,
        maxCaptureDurationMs,
      });
      if (!capture) throw new RealtimeTransportError('native_module_unavailable');

      const uplink = new MistralPcmUplink({
        socketFactory: this.options.socketFactory ?? defaultSocketFactory,
        capture,
        ...(this.options.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: this.options.connectTimeoutMs }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
      resources.uplink = uplink;
      this.uplink = uplink;
      resources.unsubscribeUplink = uplink.subscribe((event) =>
        this.onUplinkEvent(event, generation),
      );
      this.unsubscribeUplink = resources.unsubscribeUplink;
      this.speechSourcePolicy = call.value.speechSourcePolicy;
      await uplink.connect(
        {
          websocketUrl: call.value.websocketUrl,
          companyId: call.value.companyId,
          ticket: call.value.ticket,
          protocol: call.value.protocol,
          ticketExpiresAt: call.value.ticketExpiresAt,
          hardExpiresAt: call.value.hardExpiresAt,
          maxAudioBytes: call.value.maxAudioBytes,
        },
        { signal: bootstrapAbort.signal },
      );
      this.assertGeneration(generation);
      this.metrics.markSessionReady();
      this.transition({ type: 'CONNECTED' });
      this.emit({ type: 'connectivity', state: 'connected' });
      this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
    } catch (error) {
      this.unbindAbort();
      if (generation !== this.generation) {
        // Un DELETE parti avant le commit serveur peut avoir repondu 404. Une seconde
        // compensation apres la resolution du bootstrap est donc obligatoire et idempotente.
        try {
          await this.disposeAttempt(resources, true);
        } catch {
          throw new RealtimeTransportError('provider_error');
        }
        throw new RealtimeTransportError('aborted');
      }
      const reason = error instanceof RealtimeTransportError ? error.reason : 'bootstrap_failed';
      try {
        await this.disposeAttempt(resources, true);
      } catch {
        this.transition({ type: 'DEGRADED', reason: 'provider_error' });
        throw new RealtimeTransportError('provider_error');
      }
      this.transition({ type: 'DEGRADED', reason });
      this.transition({ type: 'CLOSED' });
      throw error instanceof RealtimeTransportError ? error : new RealtimeTransportError(reason);
    } finally {
      if (this.bootstrapAbort === bootstrapAbort) this.bootstrapAbort = null;
    }
  }

  sendUserText(_text: string): boolean {
    // Le protocole v1 est un flux PCM strict. Le texte reste sur le canal Assistant historique.
    return false;
  }

  setMicrophoneEnabled(enabled: boolean): void {
    this.microphoneRequested = enabled;
    if (!enabled) {
      // Le fence est synchrone : onChunk retourne false des maintenant, avant le stop natif.
      this.captureActive = false;
      const uplink = this.uplink;
      if (!uplink || this.captureStopTask) return;
      const captureGeneration = ++this.captureGeneration;
      const generation = this.generation;
      const task = uplink
        .stopCapture()
        .then(() => {
          if (
            generation === this.generation &&
            captureGeneration === this.captureGeneration &&
            this.currentState.phase === 'user_speaking'
          )
            this.transition({ type: 'USER_SPEECH_STOPPED' });
        })
        .catch(async () => {
          if (generation === this.generation) {
            await this.failRuntime('capture_stop_unconfirmed', 'provider_error');
          }
        })
        .finally(() => {
          if (this.captureStopTask === task) this.captureStopTask = null;
          if (
            generation === this.generation &&
            captureGeneration === this.captureGeneration &&
            this.microphoneRequested
          )
            this.startCaptureIfRequested();
        });
      this.captureStopTask = task;
      return;
    }
    this.startCaptureIfRequested();
  }

  private startCaptureIfRequested(): void {
    if (!this.microphoneRequested || this.captureStopTask) return;
    if (this.currentState.phase !== 'ready' || this.inputFinalized) return;
    if (this.captureActive || this.captureStartTask) return;
    const uplink = this.uplink;
    if (!uplink) return;
    const generation = this.generation;
    const captureGeneration = ++this.captureGeneration;
    const task = uplink
      .startCapture()
      .then(() => {
        if (
          generation !== this.generation ||
          captureGeneration !== this.captureGeneration ||
          !this.microphoneRequested ||
          this.inputFinalized ||
          this.currentState.phase !== 'ready'
        ) {
          return uplink.stopCapture();
        }
        this.captureActive = true;
        this.transition({ type: 'USER_SPEECH_STARTED' });
      })
      .catch(() => {
        if (
          generation === this.generation &&
          captureGeneration === this.captureGeneration &&
          this.microphoneRequested
        )
          void this.failRuntime('capture_error', 'provider_error');
      })
      .finally(() => {
        if (this.captureStartTask === task) this.captureStartTask = null;
      });
    this.captureStartTask = task;
  }

  async finishUserInput(): Promise<boolean> {
    if (this.inputFinalized || !this.uplink) return false;
    await this.captureStartTask?.catch(() => undefined);
    if (!this.captureActive || this.currentState.phase !== 'user_speaking') return false;
    this.microphoneRequested = false;
    this.captureGeneration += 1;
    this.inputFinalized = true;
    this.metrics.markSpeechStopped();
    try {
      await this.uplink.finishInput();
    } catch {
      await this.failRuntime('capture_stop_unconfirmed', 'provider_error');
      return false;
    }
    if (this.uplink.state !== 'ending' && this.uplink.state !== 'closed') return false;
    this.captureActive = false;
    this.transition({ type: 'USER_SPEECH_STOPPED' });
    this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
    return true;
  }

  interrupt(reason: 'user_speech' | 'tap' | 'navigation'): boolean {
    if (reason !== 'navigation') return false;
    if (this.currentState.phase === 'closed' || this.currentState.phase === 'closing') return false;
    // Le ticket v1 est lié au digest initial : une navigation invalide le tour au lieu de faire
    // croire qu'il peut continuer sur le nouvel écran. Le repli recrée une autorité propre.
    void this.failRuntime('context_changed', 'provider_error');
    return true;
  }

  close(_reason: RealtimeCloseReason): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (this.currentState.phase === 'closed') return Promise.resolve();
    const task = this.performClose().finally(() => {
      if (this.closeTask === task) this.closeTask = null;
    });
    this.closeTask = task;
    return task;
  }

  metricsSnapshot(): RealtimeTransportMetrics {
    return this.metrics.snapshot();
  }

  private async performClose(): Promise<void> {
    ++this.generation;
    this.microphoneRequested = false;
    this.transition({ type: 'CLOSE' });
    this.bootstrapAbort?.abort();
    this.bootstrapAbort = null;
    this.unbindAbort();
    const resources: AttemptResources = {
      audioLease: this.audioLease,
      uplink: this.uplink,
      unsubscribeUplink: this.unsubscribeUplink,
      sessionHandle: this.sessionHandle,
    };
    await this.disposeAttempt(resources, true);
    this.transition({ type: 'CLOSED' });
    this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
  }

  private async disposeAttempt(resources: AttemptResources, hangup: boolean): Promise<void> {
    try {
      resources.unsubscribeUplink?.();
    } catch {
      // Un observateur déjà détruit ne possède jamais l'autorité audio.
    }
    if (this.unsubscribeUplink === resources.unsubscribeUplink) this.unsubscribeUplink = null;
    let uplinkClosed = true;
    try {
      await resources.uplink?.close();
    } catch {
      uplinkClosed = false;
    }
    if (hangup && resources.sessionHandle) {
      const ended = await this.client
        .hangupRealtimeVoiceCall(resources.sessionHandle)
        .catch(() => null);
      if (ended === null || !ended.ok) this.emit({ type: 'error', code: 'server_hangup_pending' });
    }
    if (!uplinkClosed) {
      // Tant que le bridge ne confirme pas l'arrêt, ni le lease process ni l'identité de la
      // session ne sont libérés. L'orchestrateur verra close() rejeter et interdira le fallback.
      throw new RealtimeTransportError('provider_error');
    }
    this.audio.release(resources.audioLease);
    if (this.audioLease?.token === resources.audioLease?.token) this.audioLease = null;
    if (this.uplink === resources.uplink) this.uplink = null;
    if (this.unsubscribeUplink === resources.unsubscribeUplink) this.unsubscribeUplink = null;
    if (this.sessionHandle === resources.sessionHandle) this.sessionHandle = null;
    if (this.sessionHandle === null) this.speechSourcePolicy = null;
  }

  private onUplinkEvent(event: MistralPcmUplinkEvent, generation: number): void {
    if (generation !== this.generation || this.currentState.phase === 'closing') return;
    if (event.type === 'transcript_delta') {
      this.emit({ type: 'user_transcript', text: event.text, final: false });
      return;
    }
    if (event.type === 'transcript_segment') {
      this.emit({ type: 'user_transcript', text: event.text, final: false });
      return;
    }
    if (event.type === 'transcript_final') {
      this.emit({ type: 'user_transcript', text: event.text, final: true });
      return;
    }
    if (event.type === 'complete') {
      this.providerCompleted = true;
      return;
    }
    if (event.type === 'error') {
      void this.failRuntime(event.code, 'provider_error');
      return;
    }
    if (event.type === 'state' && event.state === 'closed' && !this.providerCompleted) {
      void this.failRuntime('mistral_socket_closed', 'provider_error');
    }
  }

  private async failRuntime(code: string, reason: RealtimeFallbackReason): Promise<void> {
    if (
      this.runtimeFailureSignalled ||
      this.currentState.phase === 'closed' ||
      this.currentState.phase === 'closing'
    )
      return;
    this.runtimeFailureSignalled = true;
    this.emit({ type: 'error', code });
    this.transition({ type: 'DEGRADED', reason });
    this.emit({ type: 'fallback', reason });
    try {
      await this.close('fallback');
    } catch {
      // La rejection reste observable par l'orchestrateur via son propre close(). Elle ne doit
      // pas devenir une rejection non gérée dans le callback qui a signalé la panne.
    }
  }

  private bindAbort(signal: AbortSignal | undefined, generation: number): void {
    if (!signal) return;
    this.abortSignal = signal;
    this.abortListener = () => {
      if (generation === this.generation) void this.failRuntime('aborted', 'aborted');
    };
    signal.addEventListener('abort', this.abortListener, { once: true });
  }

  private unbindAbort(): void {
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener('abort', this.abortListener);
    }
    this.abortSignal = null;
    this.abortListener = null;
  }

  private resetAttemptState(): void {
    this.detachResources();
    this.microphoneRequested = false;
    this.captureActive = false;
    this.captureStartTask = null;
    this.captureStopTask = null;
    this.captureGeneration += 1;
    this.inputFinalized = false;
    this.providerCompleted = false;
    this.runtimeFailureSignalled = false;
  }

  private detachResources(): void {
    this.audioLease = null;
    this.uplink = null;
    this.unsubscribeUplink = null;
    this.sessionHandle = null;
    this.speechSourcePolicy = null;
    this.captureActive = false;
    this.captureStartTask = null;
    this.captureStopTask = null;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new RealtimeTransportError('aborted');
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
      // Une projection UI ou de télémétrie ne possède jamais le micro ni le socket.
    }
  }
}
