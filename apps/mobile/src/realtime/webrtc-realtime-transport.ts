import type { BobClient } from '@bob/api-client';
import { randomUUID } from 'expo-crypto';
import type { MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import type RTCDataChannel from 'react-native-webrtc/lib/typescript/RTCDataChannel';
import type RTCPeerConnection from 'react-native-webrtc/lib/typescript/RTCPeerConnection';
import { processAudioSession, type ProcessAudioLease } from '../audio';
import {
  decodeRealtimeServerEvent,
  realtimeProviderResponseId,
  type RealtimeAgentControlReference,
} from './realtime-event-codecs';
import { RealtimeMetricsTracker } from './realtime-metrics';
import { INITIAL_REALTIME_STATE, reduceRealtimeState, type RealtimeMachineEvent } from './realtime-session-machine';
import {
  RealtimeTransportError,
  type RealtimeCloseReason,
  type RealtimeFallbackReason,
  type RealtimeTransportEvent,
  type RealtimeTransportMetrics,
  type RealtimeTransportState,
  type VoiceConversationTransport,
} from './realtime-transport';
import { loadWebRtcRuntime, type WebRtcRuntime } from './webrtc-runtime';

const DATA_CHANNEL_TIMEOUT_MS = 15_000;
const STATS_INTERVAL_MS = 5_000;
const RTP_PROBE_INTERVAL_MS = 100;
const RTP_PROBE_BUDGET_MS = 2_500;
const MAX_USER_TEXT_CHARS = 2_000;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface RuntimeEventSource {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

function runtimeEvents(target: unknown): RuntimeEventSource {
  return target as RuntimeEventSource;
}

export interface RealtimeWebRtcTransportOptions {
  /** Injection reservee aux tests deterministes ; le runtime de production reste charge paresseusement. */
  loadRuntime?: () => WebRtcRuntime | null;
}

interface AttemptResources {
  audioLease: ProcessAudioLease | null;
  stream: MediaStream | null;
  peer: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  bootstrapAbort: AbortController | null;
  sessionHandle: string | null;
}

export class RealtimeWebRtcTransport implements VoiceConversationTransport {
  readonly capabilities = { fullDuplex: true, bargeIn: true, remoteAudio: true } as const;
  private currentState: RealtimeTransportState = INITIAL_REALTIME_STATE;
  private readonly listeners = new Set<(event: RealtimeTransportEvent) => void>();
  private readonly metrics = new RealtimeMetricsTracker();
  private generation = 0;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private microphoneTrack: MediaStreamTrack | null = null;
  private microphoneEnabled = false;
  private audioLease: ProcessAudioLease | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private rtpProbeTimer: ReturnType<typeof setInterval> | null = null;
  private rtpProbeDeadlineAt = 0;
  private rtpProbeBaselinePackets = 0;
  private rtpProbeBaselineReady = false;
  private rtpProbeActive = false;
  private rtpProbeResponseObserved = false;
  private rtpProbeEpoch = 0;
  private lastInboundPackets = 0;
  private statsInFlightGeneration: number | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private abortSignal: AbortSignal | null = null;
  private abortListener: (() => void) | null = null;
  private eventSequence = 0;
  private responseActive = false;
  private responseGenerationDone = false;
  private responseStatus: 'completed' | 'cancelled' | null = null;
  private activeProviderResponseId: string | null = null;
  private pendingAgentControlReference: {
    responseId: string;
    reference: RealtimeAgentControlReference;
  } | null = null;
  private remoteAudioActive = false;
  private bootstrapAbort: AbortController | null = null;
  private sessionHandle: string | null = null;
  private closingPromise: Promise<void> | null = null;
  private pendingConnectAbort: AbortController | null = null;
  private connectivityState: 'connected' | 'disconnected' | null = null;
  private readonly disposedNativeResources = new WeakSet<object>();

  constructor(
    private readonly client: BobClient,
    private readonly options: RealtimeWebRtcTransportOptions = {},
  ) {}

  get state(): RealtimeTransportState {
    return this.currentState;
  }

  getSessionHandle(): string | null {
    return this.sessionHandle;
  }

  subscribe(listener: (event: RealtimeTransportEvent) => void): () => void {
    this.listeners.add(listener);
    this.safeNotify(listener, { type: 'state', state: this.currentState });
    return () => this.listeners.delete(listener);
  }

  async connect(input: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.pendingConnectAbort) throw new RealtimeTransportError('bootstrap_failed');
    if (this.closingPromise) await this.waitForPreviousHangup(input.signal);
    if (this.currentState.phase !== 'idle' && this.currentState.phase !== 'closed') {
      throw new RealtimeTransportError('bootstrap_failed');
    }
    const resources: AttemptResources = {
      audioLease: null,
      stream: null,
      peer: null,
      channel: null,
      bootstrapAbort: null,
      sessionHandle: null,
    };
    if (input.signal?.aborted) throw new RealtimeTransportError('aborted');
    const generation = ++this.generation;
    // Le contexte écran durable doit être acquitté par le serveur avant toute trame micro.
    // Chaque nouveau peer repart fermé, même si la session précédente avait été activée.
    this.microphoneEnabled = false;
    this.metrics.markConnectStarted();
    this.responseActive = false;
    this.responseGenerationDone = false;
    this.responseStatus = null;
    this.activeProviderResponseId = null;
    this.pendingAgentControlReference = null;
    this.remoteAudioActive = false;
    this.connectivityState = null;
    this.lastInboundPackets = 0;
    this.rtpProbeBaselinePackets = 0;
    this.rtpProbeBaselineReady = false;
    this.rtpProbeActive = false;
    this.rtpProbeResponseObserved = false;
    this.rtpProbeEpoch += 1;
    const bootstrapAbort = new AbortController();
    resources.bootstrapAbort = bootstrapAbort;
    this.bootstrapAbort = bootstrapAbort;
    // Publier l'état seulement une fois tous les verrous locaux armés : un observateur peut
    // fermer de façon réentrante dès START, sans laisser de contrôleur orphelin.
    this.transition({ type: 'START', generation });

    try {
      this.assertGeneration(generation);
      this.bindAbortSignal(input.signal, generation);
      const runtime = (this.options.loadRuntime ?? loadWebRtcRuntime)();
      if (!runtime) throw new RealtimeTransportError('native_module_unavailable');

      const config = await this.client.realtimeVoiceConfig();
      this.assertGeneration(generation);
      if (!config.ok) throw new RealtimeTransportError('bootstrap_failed');
      if (!config.value.available) {
        const reason = config.value.availabilityReason === 'not_entitled'
          ? 'not_entitled'
          : config.value.availabilityReason === 'entitlement_unavailable'
            ? 'entitlement_unavailable'
            : 'backend_disabled';
        throw new RealtimeTransportError(reason);
      }
      this.transition({ type: 'AUTHORIZED' });
      this.assertGeneration(generation);

      // La génération est publiée AVANT l'attente du lease. Une fermeture/background durant
      // une préemption audio ne peut donc jamais ressusciter cette tentative après coup. Le
      // probe de capacité/config, lui, n'accapare jamais le micro d'une session legacy.
      const audio = await processAudioSession.acquire({
        owner: 'bob-live-webrtc',
        mode: 'realtime',
        preemptLegacy: true,
      });
      if (!audio.ok) throw new RealtimeTransportError('audio_busy');
      resources.audioLease = audio.lease;
      this.assertGeneration(generation);
      this.audioLease = audio.lease;

      let stream: MediaStream;
      try {
        // react-native-webrtc active son pipeline voix natif (AEC/NS/AGC). Ses types 124.x
        // n'exposent pas encore les contraintes Web standard correspondantes.
        stream = await processAudioSession.withPermissionRequest(
          () => runtime.mediaDevices.getUserMedia({ audio: true, video: false }),
        );
      } catch {
        throw new RealtimeTransportError('microphone_denied');
      }
      resources.stream = stream;
      this.assertGeneration(generation);
      this.localStream = stream;
      this.microphoneTrack = stream.getAudioTracks()[0] ?? null;
      if (!this.microphoneTrack) throw new RealtimeTransportError('microphone_denied');
      this.microphoneTrack.enabled = this.microphoneEnabled;
      this.metrics.markPermissionGranted();

      const peer = new runtime.RTCPeerConnection({ bundlePolicy: 'max-bundle' });
      resources.peer = peer;
      this.peer = peer;
      const channel = peer.createDataChannel('oai-events', { ordered: true });
      resources.channel = channel;
      this.channel = channel;
      peer.addTrack(this.microphoneTrack, stream);
      this.attachPeerEvents(peer, generation);
      this.attachDataChannelEvents(channel, generation);
      const offer = await peer.createOffer();
      this.assertGeneration(generation);
      await peer.setLocalDescription(offer);
      this.assertGeneration(generation);
      const offerSdp = peer.localDescription?.sdp ?? offer?.sdp;
      if (typeof offerSdp !== 'string') throw new RealtimeTransportError('bootstrap_failed');
      this.metrics.markOfferSent();

      const requestedSessionHandle = randomUUID();
      resources.sessionHandle = requestedSessionHandle;
      this.sessionHandle = requestedSessionHandle;
      const bootstrap = await this.client.createRealtimeVoiceCall(
        { sdp: offerSdp, sessionHandle: requestedSessionHandle },
        bootstrapAbort.signal,
      );
      this.assertGeneration(generation);
      if (!bootstrap.ok) throw new RealtimeTransportError('bootstrap_failed');
      if (
        bootstrap.value.sessionHandle !== requestedSessionHandle
        || bootstrap.value.configVersion !== config.value.configVersion
        || bootstrap.value.model !== config.value.model
        || bootstrap.value.voice !== config.value.voice
        || bootstrap.value.maxSessionSeconds !== config.value.maxSessionSeconds
      ) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      const hardExpiryDelayMs = Date.parse(bootstrap.value.hardExpiresAt) - Date.now();
      if (!Number.isFinite(hardExpiryDelayMs) || hardExpiryDelayMs <= 0) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      this.metrics.markAnswerReceived();
      await peer.setRemoteDescription(new runtime.RTCSessionDescription({
        type: 'answer',
        sdp: bootstrap.value.answerSdp,
      }));
      this.assertGeneration(generation);
      await this.waitForDataChannel(channel, generation);
      this.assertGeneration(generation);
      this.metrics.markDataChannelOpened();
      this.transition({ type: 'CONNECTED' });
      this.assertGeneration(generation);
      this.startStats(generation);
      this.sessionTimer = setTimeout(() => {
        if (generation !== this.generation) return;
        this.emit({ type: 'error', code: 'session_max_duration' });
        void this.close('max_duration');
      }, Math.min(bootstrap.value.maxSessionSeconds * 1_000, hardExpiryDelayMs));
      this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
      this.assertGeneration(generation);
    } catch (error) {
      if (generation !== this.generation) {
        this.disposeAttemptResources(resources);
        throw new RealtimeTransportError('aborted');
      }
      const reason = error instanceof RealtimeTransportError ? error.reason : 'bootstrap_failed';
      await this.degradeAndClose(reason, generation);
      throw error instanceof RealtimeTransportError ? error : new RealtimeTransportError(reason);
    }
  }

  sendUserText(text: string): boolean {
    const value = text.trim();
    if (!value || value.length > MAX_USER_TEXT_CHARS || !this.isChannelOpen()) return false;
    // Autorite serveur : le mobile ajoute uniquement le tour utilisateur. Le sideband Bob
    // decide ensuite si/quand une reponse peut etre creee, apres contexte et garde-fous.
    return this.send({
      type: 'conversation.item.create',
      event_id: this.nextEventId('text'),
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: value }],
      },
    });
  }

  setMicrophoneEnabled(enabled: boolean): void {
    this.microphoneEnabled = enabled;
    if (this.microphoneTrack) this.microphoneTrack.enabled = enabled;
  }

  interrupt(_reason: 'user_speech' | 'tap' | 'navigation'): boolean {
    if (!this.isChannelOpen() || !this.responseActive) return false;
    this.metrics.markBargeIn();
    this.pendingAgentControlReference = null;
    // `response.done` précède `output_audio_buffer.stopped` en WebRTC. Si toute la réponse est
    // déjà générée mais encore audible, seul le clear est valide et doit rester disponible.
    const cancelled = this.responseGenerationDone
      ? true
      : this.activeProviderResponseId !== null && this.send({
          type: 'response.cancel',
          event_id: this.nextEventId('cancel'),
          response_id: this.activeProviderResponseId,
        });
    const cleared = this.send({ type: 'output_audio_buffer.clear', event_id: this.nextEventId('clear') });
    return cancelled && cleared;
  }

  close(_reason: RealtimeCloseReason): Promise<void> {
    if (this.closingPromise) {
      // Un connect demandé pendant le hangup précédent attend sans posséder de micro. Une
      // fermeture/background doit néanmoins annuler cette intention, pas la ressusciter ensuite.
      this.pendingConnectAbort?.abort();
      return this.closingPromise;
    }
    if (this.currentState.phase === 'closed' || this.currentState.phase === 'closing') return Promise.resolve();
    ++this.generation;
    this.transition({ type: 'CLOSE' });
    this.bootstrapAbort?.abort();
    this.bootstrapAbort = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.rtpProbeTimer) clearInterval(this.rtpProbeTimer);
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.statsTimer = null;
    this.rtpProbeTimer = null;
    this.rtpProbeActive = false;
    this.rtpProbeBaselineReady = false;
    this.rtpProbeResponseObserved = false;
    this.sessionTimer = null;
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener('abort', this.abortListener);
    }
    this.abortSignal = null;
    this.abortListener = null;
    const resources: AttemptResources = {
      audioLease: this.audioLease,
      stream: this.localStream,
      peer: this.peer,
      channel: this.channel,
      bootstrapAbort: null,
      sessionHandle: this.sessionHandle,
    };
    this.channel = null;
    this.peer = null;
    this.localStream = null;
    this.microphoneTrack = null;
    this.audioLease = null;
    this.sessionHandle = null;
    this.responseActive = false;
    this.responseGenerationDone = false;
    this.responseStatus = null;
    this.activeProviderResponseId = null;
    this.pendingAgentControlReference = null;
    this.remoteAudioActive = false;
    this.connectivityState = null;
    this.disposeAttemptResources(resources);
    const closing = resources.sessionHandle === null
      ? Promise.resolve()
      : Promise.resolve().then(() => this.client.hangupRealtimeVoiceCall(resources.sessionHandle!)).then((result) => {
          if (!result.ok) this.emit({ type: 'error', code: 'server_hangup_pending' });
        }).catch(() => {
          this.emit({ type: 'error', code: 'server_hangup_pending' });
        });
    const tracked = closing.finally(() => {
      if (this.closingPromise === tracked) this.closingPromise = null;
    });
    this.closingPromise = tracked;
    // Le gate est visible AVANT CLOSED : un observateur réentrant ne peut pas démarrer un nouveau
    // peer avant que le hangup opaque précédent soit au moins réglé ou explicitement annulé.
    this.transition({ type: 'CLOSED' });
    this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
    return tracked;
  }

  metricsSnapshot(): RealtimeTransportMetrics {
    return this.metrics.snapshot();
  }

  private bindAbortSignal(signal: AbortSignal | undefined, generation: number): void {
    if (!signal) return;
    if (signal.aborted) throw new RealtimeTransportError('aborted');
    this.abortSignal = signal;
    this.abortListener = () => { void this.degradeAndClose('aborted', generation); };
    signal.addEventListener('abort', this.abortListener, { once: true });
  }

  private async waitForPreviousHangup(signal: AbortSignal | undefined): Promise<void> {
    const closing = this.closingPromise;
    if (!closing) return;
    if (signal?.aborted) throw new RealtimeTransportError('aborted');
    const controller = new AbortController();
    this.pendingConnectAbort = controller;
    const relayAbort = (): void => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new RealtimeTransportError('aborted'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        void closing.then(
          () => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          },
          () => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          },
        );
      });
    } finally {
      signal?.removeEventListener('abort', relayAbort);
      if (this.pendingConnectAbort === controller) this.pendingConnectAbort = null;
    }
  }

  private attachPeerEvents(peer: RTCPeerConnection, generation: number): void {
    runtimeEvents(peer).addEventListener('connectionstatechange', () => {
      if (generation !== this.generation) return;
      this.handlePeerConnectivity(peer, generation);
    });
    runtimeEvents(peer).addEventListener('iceconnectionstatechange', () => {
      if (generation !== this.generation) return;
      this.handlePeerConnectivity(peer, generation);
    });
  }

  private handlePeerConnectivity(peer: RTCPeerConnection, generation: number): void {
    if (generation !== this.generation) return;
    if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed') {
      void this.degradeAndClose('ice_failed', generation);
      return;
    }
    if (peer.connectionState === 'closed' || peer.iceConnectionState === 'closed') {
      void this.degradeAndClose('provider_error', generation);
      return;
    }
    if (peer.connectionState === 'disconnected' || peer.iceConnectionState === 'disconnected') {
      this.emitConnectivity('disconnected');
      return;
    }
    if (
      peer.connectionState === 'connected'
      || peer.iceConnectionState === 'connected'
      || peer.iceConnectionState === 'completed'
    ) {
      this.emitConnectivity('connected');
    }
  }

  private emitConnectivity(state: 'connected' | 'disconnected'): void {
    if (this.connectivityState === state) return;
    this.connectivityState = state;
    this.emit({ type: 'connectivity', state });
  }

  private attachDataChannelEvents(channel: RTCDataChannel, generation: number): void {
    runtimeEvents(channel).addEventListener('message', (event: unknown) => {
      if (generation !== this.generation) return;
      const data = (event as unknown as { data?: unknown }).data;
      this.handleServerEvent(decodeRealtimeServerEvent(data));
    });
    runtimeEvents(channel).addEventListener('error', () => {
      if (generation === this.generation) this.emit({ type: 'error', code: 'data_channel_error' });
    });
    runtimeEvents(channel).addEventListener('close', () => {
      if (generation === this.generation && this.currentState.phase !== 'closing') {
        void this.degradeAndClose('provider_error', generation);
      }
    });
  }

  private waitForDataChannel(channel: RTCDataChannel, generation: number): Promise<void> {
    if (channel.readyState === 'open') return Promise.resolve();
    if (channel.readyState === 'closing' || channel.readyState === 'closed') {
      return Promise.reject(new RealtimeTransportError('provider_error'));
    }
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        runtimeEvents(channel).removeEventListener('open', onOpen);
        runtimeEvents(channel).removeEventListener('close', onClose);
      };
      const onOpen = (): void => {
        cleanup();
        if (generation === this.generation) resolve();
        else reject(new RealtimeTransportError('aborted'));
      };
      const onClose = (): void => {
        cleanup();
        reject(new RealtimeTransportError('provider_error'));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new RealtimeTransportError('data_channel_timeout'));
      }, DATA_CHANNEL_TIMEOUT_MS);
      runtimeEvents(channel).addEventListener('open', onOpen);
      runtimeEvents(channel).addEventListener('close', onClose);
    });
  }

  private handleServerEvent(event: ReturnType<typeof decodeRealtimeServerEvent>): void {
    switch (event.type) {
      case 'session_ready':
        this.metrics.markSessionReady();
        break;
      case 'response_started': {
        const responseId = realtimeProviderResponseId(event);
        if (!responseId) {
          this.emit({ type: 'error', code: 'invalid_response_id' });
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        if (
          this.responseActive
          && this.activeProviderResponseId !== null
          && this.activeProviderResponseId !== responseId
        ) {
          this.emit({ type: 'error', code: 'overlapping_provider_response' });
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        this.activeProviderResponseId = responseId;
        this.responseActive = true;
        this.responseGenerationDone = false;
        this.responseStatus = null;
        this.remoteAudioActive = false;
        this.pendingAgentControlReference = event.controlReference
          ? { responseId, reference: event.controlReference }
          : null;
        if (this.rtpProbeActive) this.rtpProbeResponseObserved = true;
        this.metrics.markResponseStarted();
        break;
      }
      case 'speech_started':
        if (this.responseActive) this.interrupt('user_speech');
        this.transition({ type: 'USER_SPEECH_STARTED' });
        break;
      case 'speech_stopped':
        this.metrics.markSpeechStopped();
        this.rtpProbeBaselinePackets = this.lastInboundPackets;
        this.startRtpProbe(this.currentState.generation);
        this.transition({ type: 'USER_SPEECH_STOPPED' });
        break;
      case 'audio_signal': {
        if (realtimeProviderResponseId(event) !== this.activeProviderResponseId) break;
        this.responseActive = true;
        this.remoteAudioActive = true;
        const hadFirstAudioSignal = this.metrics.snapshot().speechStoppedEventToFirstAudioSignalMs !== null;
        this.metrics.markFirstAudioSignal();
        this.transition({ type: 'BOB_AUDIO_STARTED' });
        if (!hadFirstAudioSignal) this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
        break;
      }
      case 'audio_stopped':
        if (realtimeProviderResponseId(event) !== this.activeProviderResponseId) break;
        this.remoteAudioActive = false;
        if (this.responseGenerationDone) {
          const controlReference = this.responseStatus === 'completed'
            && this.pendingAgentControlReference?.responseId === this.activeProviderResponseId
            ? this.pendingAgentControlReference.reference
            : null;
          this.responseActive = false;
          this.activeProviderResponseId = null;
          this.responseStatus = null;
          this.pendingAgentControlReference = null;
          this.transition({ type: 'RESPONSE_DONE' });
          this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
          if (controlReference) {
            this.emit({ type: 'agent_control_candidate', reference: controlReference });
          }
        }
        break;
      case 'audio_cleared':
        if (realtimeProviderResponseId(event) !== this.activeProviderResponseId) break;
        this.remoteAudioActive = false;
        this.responseActive = false;
        this.activeProviderResponseId = null;
        this.responseStatus = null;
        this.pendingAgentControlReference = null;
        this.metrics.markAudioCleared();
        this.transition({ type: 'RESPONSE_DONE' });
        this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
        break;
      case 'response_done':
        if (realtimeProviderResponseId(event) !== this.activeProviderResponseId) break;
        if (event.status === 'failed' || event.status === 'incomplete') {
          this.pendingAgentControlReference = null;
          this.emit({ type: 'error', code: `response_${event.status}` });
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        this.responseGenerationDone = true;
        this.responseStatus = event.status;
        if (event.status === 'cancelled') this.pendingAgentControlReference = null;
        this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
        break;
      case 'user_transcript':
        this.emit(event);
        break;
      case 'bob_transcript':
        this.emit(event);
        break;
      case 'provider_error':
        this.emit({ type: 'error', code: event.code });
        break;
      case 'protocol_error':
        this.emit({ type: 'error', code: event.code });
        // Une trame malformée/surdimensionnée signifie que le canal n'est plus une autorité
        // fiable. Les erreurs provider structurées restent, elles, récupérables par contrat.
        void this.degradeAndClose('provider_error', this.currentState.generation);
        break;
      case 'ignored':
        break;
    }
  }

  private startStats(generation: number): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => { void this.collectStats(generation, true); }, STATS_INTERVAL_MS);
  }

  private startRtpProbe(generation: number): void {
    if (this.rtpProbeTimer) clearInterval(this.rtpProbeTimer);
    this.rtpProbeDeadlineAt = Date.now() + RTP_PROBE_BUDGET_MS;
    this.rtpProbeActive = true;
    this.rtpProbeBaselineReady = false;
    this.rtpProbeResponseObserved = false;
    this.rtpProbeEpoch += 1;
    void this.collectStats(generation, false);
    this.rtpProbeTimer = setInterval(() => {
      if (
        generation !== this.generation
        || Date.now() >= this.rtpProbeDeadlineAt
        || this.metrics.snapshot().speechStoppedToFirstInboundRtpMs !== null
      ) {
        if (this.rtpProbeTimer) clearInterval(this.rtpProbeTimer);
        this.rtpProbeTimer = null;
        this.rtpProbeActive = false;
        this.rtpProbeBaselineReady = false;
        this.rtpProbeResponseObserved = false;
        return;
      }
      void this.collectStats(generation, false);
    }, RTP_PROBE_INTERVAL_MS);
  }

  private async collectStats(generation: number, publishPeriodicSnapshot: boolean): Promise<void> {
    const peer = this.peer;
    if (!peer || generation !== this.generation || this.statsInFlightGeneration === generation) return;
    // Un getStats lent d'une ancienne génération ne bloque jamais les métriques de la suivante.
    this.statsInFlightGeneration = generation;
    const rtpProbeEpochAtStart = this.rtpProbeEpoch;
    try {
      const report = await peer.getStats();
      if (generation !== this.generation) return;
      const values: unknown[] = typeof report?.values === 'function'
        ? [...report.values()]
        : Array.isArray(report)
          ? report
          : report && typeof report === 'object'
            ? Object.values(report)
            : [];
      let roundTripTimeMs: number | undefined;
      let jitterMs: number | undefined;
      let packetsLost: number | undefined;
      let inboundPackets = 0;
      for (const raw of values) {
        if (!raw || typeof raw !== 'object') continue;
        const stat = raw as Record<string, unknown>;
        if (stat.type === 'candidate-pair' && (stat.nominated === true || stat.selected === true)) {
          const rtt = finiteNumber(stat.currentRoundTripTime);
          if (rtt !== null) roundTripTimeMs = rtt * 1_000;
        }
        if (stat.type === 'inbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio')) {
          const jitter = finiteNumber(stat.jitter);
          const lost = finiteNumber(stat.packetsLost);
          const received = finiteNumber(stat.packetsReceived);
          if (jitter !== null) jitterMs = Math.max(jitterMs ?? 0, jitter * 1_000);
          if (lost !== null) packetsLost = (packetsLost ?? 0) + Math.max(0, lost);
          if (received !== null) inboundPackets += Math.max(0, received);
        }
      }
      const hadFirstInboundRtp = this.metrics.snapshot().speechStoppedToFirstInboundRtpMs !== null;
      let baselinePrimed = false;
      if (
        this.rtpProbeActive
        && !this.rtpProbeBaselineReady
        && rtpProbeEpochAtStart === this.rtpProbeEpoch
      ) {
        // Échantillon frais au début du tour : `lastInboundPackets` peut dater de 5 secondes et
        // contenir la réponse précédente. Sans ce prime, la latence RTP serait souvent 0 ms.
        this.rtpProbeBaselinePackets = inboundPackets;
        this.rtpProbeBaselineReady = true;
        baselinePrimed = true;
      } else if (inboundPackets < this.lastInboundPackets) {
        // Un changement de SSRC peut remettre le compteur à zéro : réaligner le baseline sans
        // fabriquer une latence négative ou attribuer d'anciens paquets au nouveau tour.
        this.rtpProbeBaselinePackets = inboundPackets;
        baselinePrimed = true;
      }
      this.lastInboundPackets = inboundPackets;
      if (
        this.rtpProbeActive
        && this.rtpProbeBaselineReady
        && this.rtpProbeResponseObserved
        && this.remoteAudioActive
        && !baselinePrimed
        && inboundPackets > this.rtpProbeBaselinePackets
      ) {
        this.metrics.markFirstInboundRtp();
      }
      this.metrics.updateWebRtcStats({ roundTripTimeMs, jitterMs, packetsLost });
      const snapshot = this.metrics.snapshot();
      if (
        publishPeriodicSnapshot
        || (!hadFirstInboundRtp && snapshot.speechStoppedToFirstInboundRtpMs !== null)
      ) {
        this.emit({ type: 'metrics', metrics: snapshot });
      }
    } catch {
      // Stats qualité best-effort ; aucune donnée sensible ni impact sur la conversation.
    } finally {
      if (this.statsInFlightGeneration === generation) this.statsInFlightGeneration = null;
    }
  }

  private isChannelOpen(): boolean {
    return this.channel?.readyState === 'open';
  }

  private send(event: Record<string, unknown>): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    try {
      this.channel.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  private nextEventId(kind: string): string {
    this.eventSequence += 1;
    return `bob_${this.currentState.generation}_${kind}_${this.eventSequence}`;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new RealtimeTransportError('aborted');
  }

  private async degradeAndClose(reason: RealtimeFallbackReason, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (this.currentState.phase === 'closed' || this.currentState.phase === 'closing') return;
    this.transition({ type: 'DEGRADED', reason });
    if (generation !== this.generation) return;
    this.emit({ type: 'fallback', reason });
    if (generation !== this.generation) return;
    await this.close(reason === 'aborted' ? 'aborted' : 'fallback');
  }

  private disposeAttemptResources(resources: AttemptResources): void {
    resources.bootstrapAbort?.abort();
    this.disposeNativeOnce(resources.channel, (channel) => channel.close());
    this.disposeNativeOnce(resources.peer, (peer) => peer.close());
    // RN-WebRTC 124: track.stop() ne libere pas l'AudioSource natif. release(true)
    // retire puis release chaque piste avant de detruire le MediaStream.
    this.disposeNativeOnce(resources.stream, (stream) => {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* piste deja arretee */ }
      }
      stream.release(true);
    });
    processAudioSession.release(resources.audioLease);
  }

  private disposeNativeOnce<T extends object>(resource: T | null, dispose: (value: T) => void): void {
    if (!resource || this.disposedNativeResources.has(resource)) return;
    this.disposedNativeResources.add(resource);
    try { dispose(resource); } catch { /* ressource native deja fermee */ }
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
      // Une projection UI/telemetrie ne peut jamais casser le peer, le micro ou sa fermeture.
    }
  }
}
