import type {
  BobClient,
  RealtimeVoiceConfig,
  RealtimeVoiceSpeechSourcePolicy,
} from '@bob/api-client';
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

type SdpDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

interface SdpMediaSection {
  readonly kind: string;
  readonly port: number;
  readonly directions: SdpDirection[];
}

const SDP_DIRECTIONS = new Set<SdpDirection>([
  'sendrecv',
  'sendonly',
  'recvonly',
  'inactive',
]);

/**
 * Retourne la direction effective de l'unique m-line audio active.
 *
 * L'absence de direction vaut `sendrecv` en SDP. Les directions dupliquées ou les
 * topologies audio multiples sont refusées : cette connexion n'a qu'un micro et le
 * flux vocal descendant passe exclusivement par le lecteur local audité.
 */
function activeAudioDirection(sdp: string): SdpDirection | null {
  const sessionDirections: SdpDirection[] = [];
  const mediaSections: SdpMediaSection[] = [];
  let currentSection: SdpMediaSection | null = null;

  for (const rawLine of sdp.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(/\s+/u);
      const portToken = parts[1];
      if (parts.length < 3 || !portToken || !/^\d+(?:\/\d+)?$/u.test(portToken)) {
        return null;
      }
      currentSection = {
        kind: parts[0]?.toLowerCase() ?? '',
        port: Number(portToken.split('/')[0]),
        directions: [],
      };
      mediaSections.push(currentSection);
      continue;
    }
    if (!line.startsWith('a=')) continue;
    const attribute = line.slice(2).toLowerCase();
    if (!SDP_DIRECTIONS.has(attribute as SdpDirection)) continue;
    const direction = attribute as SdpDirection;
    if (currentSection) currentSection.directions.push(direction);
    else sessionDirections.push(direction);
  }

  const activeAudioSections = mediaSections.filter(
    (section) => section.kind === 'audio' && section.port !== 0,
  );
  if (activeAudioSections.length !== 1 || sessionDirections.length > 1) return null;
  const [audio] = activeAudioSections;
  if (!audio || audio.directions.length > 1) return null;
  return audio.directions[0] ?? sessionDirections[0] ?? 'sendrecv';
}

function assertMicrophoneOnlyOffer(sdp: string): void {
  if (activeAudioDirection(sdp) !== 'sendonly') {
    throw new RealtimeTransportError('bootstrap_failed');
  }
}

function assertProviderReceiveOnlyAnswer(sdp: string): void {
  // Dans une answer, `recvonly` est exprimé du point de vue du provider : le mobile
  // envoie le micro, mais ne reçoit aucune piste acoustique WebRTC.
  if (activeAudioDirection(sdp) !== 'recvonly') {
    throw new RealtimeTransportError('provider_error');
  }
}

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

export type RealtimeWebRtcNegotiation = RealtimeVoiceConfig & { readonly transport: 'webrtc' };

export function isRealtimeWebRtcNegotiation(
  value: RealtimeVoiceConfig,
): value is RealtimeWebRtcNegotiation {
  return value.transport === 'webrtc';
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
  /** WebRTC n'est ici que l'oreille/VAD : la bouche est le canal acoustique audité composé. */
  readonly capabilities = { fullDuplex: true, bargeIn: true, remoteAudio: false } as const;
  /** Le chemin WebRTC natif reste une conversation continue ; le duplex RTP vient au lot suivant. */
  readonly completionMode = 'continuous' as const;
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
  private speechSourcePolicy: RealtimeVoiceSpeechSourcePolicy | null = null;
  private readonly hangupTasks = new Map<string, Promise<void>>();
  private closingPromise: Promise<void> | null = null;
  private pendingConnectAbort: AbortController | null = null;
  private connectivityState: 'connected' | 'disconnected' | null = null;
  private readonly disposedNativeResources = new WeakSet<object>();

  constructor(
    private readonly client: BobClient,
    private readonly negotiation: RealtimeWebRtcNegotiation,
    private readonly options: RealtimeWebRtcTransportOptions = {},
  ) {}

  get state(): RealtimeTransportState {
    return this.currentState;
  }

  getSessionHandle(): string | null {
    return this.sessionHandle;
  }

  /** Capacités internes de la composition auditée ; les jetons ne quittent jamais le processus. */
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
    this.speechSourcePolicy = null;
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

      const config = this.negotiation;
      if (!config.available) {
        const reason = config.availabilityReason === 'not_entitled'
          ? 'not_entitled'
          : config.availabilityReason === 'entitlement_unavailable'
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
      // RN-WebRTC 124 expose addTransceiver de façon synchrone. Cette API est préférée à
      // addTrack, qui crée par défaut un transceiver sendrecv et autoriserait donc un
      // downlink provider avant que le lecteur signé/audité ait validé l'audio.
      const microphoneTransceiver = peer.addTransceiver(this.microphoneTrack, {
        direction: 'sendonly',
        streams: [stream],
      });
      if (microphoneTransceiver.direction !== 'sendonly') {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      this.attachPeerEvents(peer, generation);
      this.attachDataChannelEvents(channel, generation);
      const offer = await peer.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      this.assertGeneration(generation);
      await peer.setLocalDescription(offer);
      this.assertGeneration(generation);
      const offerSdp = peer.localDescription?.sdp ?? offer?.sdp;
      if (typeof offerSdp !== 'string') throw new RealtimeTransportError('bootstrap_failed');
      assertMicrophoneOnlyOffer(offerSdp);
      this.metrics.markOfferSent();

      const requestedSessionHandle = randomUUID();
      resources.sessionHandle = requestedSessionHandle;
      this.sessionHandle = requestedSessionHandle;
      const bootstrap = await this.client.createRealtimeVoiceCall(
        {
          transport: 'webrtc',
          sdp: offerSdp,
          sessionHandle: requestedSessionHandle,
          configVersion: config.configVersion,
          speechDelivery: config.speechDelivery,
        },
        bootstrapAbort.signal,
      );
      this.assertGeneration(generation);
      if (!bootstrap.ok) throw new RealtimeTransportError('bootstrap_failed');
      if (
        bootstrap.value.transport !== 'webrtc'
        || bootstrap.value.sessionHandle !== requestedSessionHandle
        || bootstrap.value.configVersion !== config.configVersion
        || bootstrap.value.model !== config.model
        || bootstrap.value.voice !== config.voice
        || bootstrap.value.maxSessionSeconds !== config.maxSessionSeconds
        || bootstrap.value.speechDelivery !== config.speechDelivery
      ) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      this.speechSourcePolicy = bootstrap.value.speechDelivery === 'audited-signed-url-v1'
        ? bootstrap.value.speechSourcePolicy
        : null;
      const hardExpiryDelayMs = Date.parse(bootstrap.value.hardExpiresAt) - Date.now();
      if (!Number.isFinite(hardExpiryDelayMs) || hardExpiryDelayMs <= 0) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      try {
        assertProviderReceiveOnlyAnswer(bootstrap.value.answerSdp);
      } catch (error) {
        this.emit({ type: 'error', code: 'provider_downlink_rejected' });
        throw error;
      }
      this.metrics.markAnswerReceived();
      await peer.setRemoteDescription(new runtime.RTCSessionDescription({
        type: 'answer',
        sdp: bootstrap.value.answerSdp,
      }));
      this.assertGeneration(generation);
      this.assertNoReceivingTransceiver(peer);
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
        const nativeDisposed = this.disposeAttemptResources(resources);
        await this.hangupSession(resources.sessionHandle);
        if (!nativeDisposed) throw new RealtimeTransportError('provider_error');
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
    if (this.currentState.phase === 'closed') return Promise.resolve();
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
    this.responseActive = false;
    this.responseGenerationDone = false;
    this.responseStatus = null;
    this.activeProviderResponseId = null;
    this.pendingAgentControlReference = null;
    this.remoteAudioActive = false;
    this.connectivityState = null;
    const closing = Promise.resolve().then(async (): Promise<void> => {
      // Le hangup est armé avant CLOSED, mais ne retarde pas la preuve de fermeture native.
      // Un connect réentrant verra `closingPromise` et attendra quand même sa résolution.
      const hangup = this.hangupSession(resources.sessionHandle);
      const nativeDisposed = this.disposeAttemptResources(resources);
      if (!nativeDisposed) {
        await hangup;
        this.emit({ type: 'error', code: 'native_audio_stop_unconfirmed' });
        throw new RealtimeTransportError('provider_error');
      }
      if (this.channel === resources.channel) this.channel = null;
      if (this.peer === resources.peer) this.peer = null;
      if (this.localStream === resources.stream) {
        this.localStream = null;
        this.microphoneTrack = null;
      }
      if (this.audioLease?.token === resources.audioLease?.token) this.audioLease = null;
      if (this.sessionHandle === resources.sessionHandle) this.sessionHandle = null;
      if (this.sessionHandle === null) this.speechSourcePolicy = null;
      this.transition({ type: 'CLOSED' });
      this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
      await hangup;
    });
    const tracked = closing.finally(() => {
      if (this.closingPromise === tracked) this.closingPromise = null;
    });
    this.closingPromise = tracked;
    // Le gate est visible AVANT CLOSED : un observateur réentrant ne peut pas démarrer un nouveau
    // peer avant la preuve de fermeture native. Une erreur conserve les références et le lease
    // pour permettre une relance explicite, tout en interdisant tout fallback concurrent.
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
    runtimeEvents(peer).addEventListener('track', (event: unknown) => {
      this.rejectUnauthorizedRemoteTrack(event, generation);
    });
    runtimeEvents(peer).addEventListener('connectionstatechange', () => {
      if (generation !== this.generation) return;
      this.handlePeerConnectivity(peer, generation);
    });
    runtimeEvents(peer).addEventListener('iceconnectionstatechange', () => {
      if (generation !== this.generation) return;
      this.handlePeerConnectivity(peer, generation);
    });
  }

  private rejectUnauthorizedRemoteTrack(event: unknown, generation: number): void {
    const value = event && typeof event === 'object'
      ? event as {
          track?: MediaStreamTrack | null;
          receiver?: { track?: MediaStreamTrack | null } | null;
          transceiver?: { receiver?: { track?: MediaStreamTrack | null }; stop?: () => void } | null;
          streams?: MediaStream[];
        }
      : {};
    const tracks = new Set<MediaStreamTrack>();
    if (value.track) tracks.add(value.track);
    if (value.receiver?.track) tracks.add(value.receiver.track);
    if (value.transceiver?.receiver?.track) tracks.add(value.transceiver.receiver.track);
    for (const stream of value.streams ?? []) {
      for (const track of stream.getTracks()) tracks.add(track);
    }
    for (const track of tracks) {
      try { track.stop(); } catch { /* piste provider déjà arrêtée */ }
    }
    try { value.transceiver?.stop?.(); } catch { /* transceiver provider déjà arrêté */ }
    // Une piste d'une génération déjà fencée doit être neutralisée, mais elle ne peut plus
    // dégrader ni fermer le nouveau peer devenu autoritaire.
    if (generation !== this.generation) return;
    this.failClosedUnauthorizedDownlink(generation);
  }

  private assertNoReceivingTransceiver(peer: RTCPeerConnection): void {
    for (const transceiver of peer.getTransceivers()) {
      if (
        transceiver.direction === 'recvonly'
        || transceiver.direction === 'sendrecv'
        || transceiver.currentDirection === 'recvonly'
        || transceiver.currentDirection === 'sendrecv'
      ) {
        try { transceiver.receiver.track?.stop(); } catch { /* piste provider déjà arrêtée */ }
        try { transceiver.stop(); } catch { /* transceiver provider déjà arrêté */ }
        this.emit({ type: 'error', code: 'provider_downlink_rejected' });
        throw new RealtimeTransportError('provider_error');
      }
    }
  }

  private failClosedUnauthorizedDownlink(generation: number): void {
    if (generation !== this.generation) return;
    this.emit({ type: 'error', code: 'provider_downlink_rejected' });
    // `degradeAndClose` transitionne et dispose le peer de façon synchrone avant son
    // premier await : aucun échantillon distant ne peut atteindre la sortie acoustique.
    void this.degradeAndClose('provider_error', generation);
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
      if (inboundPackets > 0) {
        // Défense en profondeur : certains runtimes natifs peuvent exposer les paquets dans
        // getStats avant de livrer l'événement `track`. Le moindre paquet audio entrant viole
        // le contrat : seul le lecteur de blobs signés/audités a le droit de parler.
        this.failClosedUnauthorizedDownlink(generation);
        return;
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

  private disposeAttemptResources(resources: AttemptResources): boolean {
    resources.bootstrapAbort?.abort();
    const channelClosed = this.disposeNativeOnce(resources.channel, (channel) => channel.close());
    const peerClosed = this.disposeNativeOnce(resources.peer, (peer) => peer.close());
    // RN-WebRTC 124: track.stop() ne libere pas l'AudioSource natif. release(true)
    // retire puis release chaque piste avant de detruire le MediaStream.
    const streamReleased = this.disposeNativeOnce(resources.stream, (stream) => {
      let trackStopFailed = false;
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { trackStopFailed = true; }
      }
      stream.release(true);
      if (trackStopFailed) throw new Error('native_track_stop_unconfirmed');
    });
    const closed = channelClosed && peerClosed && streamReleased;
    if (closed) processAudioSession.release(resources.audioLease);
    return closed;
  }

  private disposeNativeOnce<T extends object>(
    resource: T | null,
    dispose: (value: T) => void,
  ): boolean {
    if (!resource || this.disposedNativeResources.has(resource)) return true;
    try {
      dispose(resource);
      this.disposedNativeResources.add(resource);
      return true;
    } catch {
      // L'absence de preuve de fermeture conserve la ressource et le lease pour un retry.
      return false;
    }
  }

  private async hangupSession(sessionHandle: string | null): Promise<void> {
    if (sessionHandle === null) return;
    const existing = this.hangupTasks.get(sessionHandle);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(() => this.client.hangupRealtimeVoiceCall(sessionHandle))
      .then((result) => {
        if (!result.ok) this.emit({ type: 'error', code: 'server_hangup_pending' });
      })
      .catch(() => {
        this.emit({ type: 'error', code: 'server_hangup_pending' });
      });
    this.hangupTasks.set(sessionHandle, task);
    return task;
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
