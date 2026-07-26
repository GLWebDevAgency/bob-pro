import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type BobClient,
  type RealtimeAgentMissionSession,
  type RealtimeVoiceConfig,
  type RealtimeVoiceNativeSpeechDeliveryAcknowledgement,
  type RealtimeVoiceNativeSpeechDeliveryInput,
  type RealtimeVoiceSpeechSourcePolicy,
} from '@bob/api-client';
import { randomUUID } from 'expo-crypto';
import type { MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import type RTCDataChannel from 'react-native-webrtc/lib/typescript/RTCDataChannel';
import type RTCPeerConnection from 'react-native-webrtc/lib/typescript/RTCPeerConnection';
import type RTCRtpTransceiver from 'react-native-webrtc/lib/typescript/RTCRtpTransceiver';
import { processAudioSession, type ProcessAudioLease } from '../audio';
import {
  decodeRealtimeServerEvent,
  realtimeProviderResponseId,
  type RealtimeAgentControlReference,
  type RealtimeNativeSpeechReference,
} from './realtime-event-codecs';
import type { RealtimePublishedContextFence } from './realtime-control-gate';
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
const MAX_PROVIDER_RESPONSES_PER_SESSION = 1_024;
const NATIVE_SPEECH_ACK_MAX_ATTEMPTS = 3;
const NATIVE_SPEECH_ACK_RETRY_DELAYS_MS = [100, 250] as const;
const NATIVE_SPEECH_ACK_ELIGIBILITY_TIMEOUT_MS = 3_000;
// Le drain du buffer provider ne prouve pas que la queue jitter/DAC du mobile est vide. Une
// courte grâce évite de rogner la fin d'une phrase, mais elle reste bornée pour qu'aucun ancien
// tour ne garde la piste ouverte indéfiniment.
const NATIVE_PROVIDER_DRAINED_TAIL_MS = 1_500;
// Après `output_audio_buffer.stopped`, `response.done` est une trame de contrôle attendue quasi
// immédiatement. Cinq secondes couvrent largement une livraison mobile ralentie sans tolérer un
// tour orphelin. Dans l'autre ordre, une réponse courte peut encore finir de jouer : trente
// secondes préservent ce playout légitime tout en fermant enfin si `stopped` n'arrive jamais.
const NATIVE_RESPONSE_DONE_WATCHDOG_MS = 5_000;
const NATIVE_AUDIO_STOPPED_WATCHDOG_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_256 = /^[a-f0-9]{64}$/;
const NATIVE_LOCAL_OBSERVATION = Object.freeze({
  formatVersion: 1 as const,
  kind: 'webrtc_remote_rtp_observed_provider_drained_v1' as const,
});

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
 * topologies audio multiples sont refusées : une connexion Bob Live possède exactement
 * une m-line audio. Sa direction est ensuite contrôlée par le contrat de livraison.
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

  const audioSections = mediaSections.filter((section) => section.kind === 'audio');
  const activeVideoSections = mediaSections.filter(
    (section) => section.kind === 'video' && section.port !== 0,
  );
  if (
    audioSections.length !== 1
    || audioSections[0]?.port === 0
    || activeVideoSections.length > 0
    || sessionDirections.length > 1
  ) return null;
  const [audio] = audioSections;
  if (!audio || audio.directions.length > 1) return null;
  return audio.directions[0] ?? sessionDirections[0] ?? 'sendrecv';
}

function assertMobileOffer(sdp: string, nativeDownlink: boolean): void {
  const expectedDirection = nativeDownlink ? 'sendrecv' : 'sendonly';
  if (activeAudioDirection(sdp) !== expectedDirection) {
    throw new RealtimeTransportError('bootstrap_failed');
  }
}

function assertProviderAnswer(sdp: string, nativeDownlink: boolean): void {
  // La direction d'une answer est exprimée du point de vue du provider. Le contrat audité
  // reste strictement recvonly (uplink mobile), tandis que le contrat OpenAI natif est sendrecv.
  const expectedDirection = nativeDownlink ? 'sendrecv' : 'recvonly';
  if (activeAudioDirection(sdp) !== expectedDirection) {
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
  expectedAudioTransceiver: RTCRtpTransceiver | null;
  remoteAudioTrack: MediaStreamTrack | null;
  agentMissionSession: RealtimeAgentMissionSession | null;
}

interface NativeSpeechAcknowledgementAttempt {
  readonly transportGeneration: number;
  readonly responseId: string;
  readonly reference: RealtimeNativeSpeechReference;
  readonly acknowledgementId: string;
  readonly input: RealtimeVoiceNativeSpeechDeliveryInput;
  readonly abort: AbortController;
}

type NativeSpeechAcknowledgementCall =
  | {
      readonly kind: 'result';
      readonly result: Awaited<ReturnType<BobClient['acknowledgeRealtimeVoiceNativeSpeechDelivery']>>;
    }
  | { readonly kind: 'thrown' }
  | { readonly kind: 'aborted' };

type NativeResponseTerminalWatchdog = 'response_done' | 'audio_stopped';

export class RealtimeWebRtcTransport implements VoiceConversationTransport {
  readonly capabilities: VoiceConversationTransport['capabilities'];
  readonly completionMode = 'continuous' as const;
  private readonly nativeDownlink: boolean;
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
  private expectedAudioTransceiver: RTCRtpTransceiver | null = null;
  private remoteAudioTrack: MediaStreamTrack | null = null;
  private remoteAudioTrackGeneration = 0;
  private responseLocallyMuted = false;
  private responseCancelAttempted = false;
  private responseClearAttempted = false;
  private responseHadAudio = false;
  private responseAudioStopped = false;
  private publishedContextFence: RealtimePublishedContextFence | null = null;
  private activeNativeSpeechReference: RealtimeNativeSpeechReference | null = null;
  private activeNativeTranscript: string | null = null;
  private activeResponseInboundRtpObserved = false;
  private activeResponseFirstInboundRtpMs: number | null = null;
  private nativeSpeechObservationValid = true;
  private pendingNativeSpeechAcknowledgement: NativeSpeechAcknowledgementAttempt | null = null;
  private nativeSpeechAckEligibilityTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeProviderDrainedTailTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeProviderDrainedTailEpoch = 0;
  private nativeResponseTerminalTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeResponseTerminalEpoch = 0;
  private nativeResponseTerminalKind: NativeResponseTerminalWatchdog | null = null;
  private nativeResponseTerminalResponseId: string | null = null;
  private readonly seenProviderResponseIds = new Set<string>();
  private readonly seenNativeSpeechDeliveryIds = new Set<string>();
  private bootstrapAbort: AbortController | null = null;
  private sessionHandle: string | null = null;
  private agentMissionSession: RealtimeAgentMissionSession | null = null;
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
  ) {
    this.nativeDownlink = negotiation.speechDelivery === 'openai-native-webrtc-v1';
    this.capabilities = Object.freeze({
      fullDuplex: this.nativeDownlink,
      bargeIn: true,
      remoteAudio: this.nativeDownlink,
    });
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
      expectedAudioTransceiver: null,
      remoteAudioTrack: null,
      agentMissionSession: null,
    };
    if (input.signal?.aborted) throw new RealtimeTransportError('aborted');
    // Une instance est réutilisable : aucun timer de la connexion précédente ne peut survivre
    // au nouveau peer ni agir sur sa piste distante.
    this.cancelNativeProviderDrainedTail(true);
    this.clearNativeResponseTerminalWatchdog();
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
    this.expectedAudioTransceiver = null;
    this.remoteAudioTrack = null;
    this.remoteAudioTrackGeneration = 0;
    this.responseHadAudio = false;
    this.responseAudioStopped = false;
    this.publishedContextFence = null;
    this.activeNativeSpeechReference = null;
    this.activeNativeTranscript = null;
    this.activeResponseInboundRtpObserved = false;
    this.activeResponseFirstInboundRtpMs = null;
    this.nativeSpeechObservationValid = true;
    this.cancelNativeSpeechAcknowledgement();
    this.resetResponseInterruptionState();
    this.seenProviderResponseIds.clear();
    this.seenNativeSpeechDeliveryIds.clear();
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
      // Une seule transceiver porte le micro et, uniquement avec le contrat OpenAI natif,
      // le downlink RTP. Le contrat audité conserve sa topologie historique uplink-only.
      const transceiverDirection = this.nativeDownlink ? 'sendrecv' : 'sendonly';
      const microphoneTransceiver = peer.addTransceiver(this.microphoneTrack, {
        direction: transceiverDirection,
        streams: [stream],
      });
      if (microphoneTransceiver.direction !== transceiverDirection) {
        throw new RealtimeTransportError('bootstrap_failed');
      }
      resources.expectedAudioTransceiver = microphoneTransceiver;
      this.expectedAudioTransceiver = microphoneTransceiver;
      this.attachPeerEvents(peer, generation, resources, microphoneTransceiver);
      this.attachDataChannelEvents(channel, generation);
      const offer = await peer.createOffer({
        offerToReceiveAudio: this.nativeDownlink,
        offerToReceiveVideo: false,
      });
      this.assertGeneration(generation);
      await peer.setLocalDescription(offer);
      this.assertGeneration(generation);
      const offerSdp = peer.localDescription?.sdp ?? offer?.sdp;
      if (typeof offerSdp !== 'string') throw new RealtimeTransportError('bootstrap_failed');
      assertMobileOffer(offerSdp, this.nativeDownlink);
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
          agentMissionProtocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
        },
        bootstrapAbort.signal,
      );
      if (!bootstrap.ok) {
        throw new RealtimeTransportError('agent_mission_negotiation_failed');
      }
      const agentMissionSession = bootstrap.value.agentMissionSession;
      if (
        !Object.hasOwn(bootstrap.value, 'agentMissionSession')
        || agentMissionSession === undefined
      ) {
        throw new RealtimeTransportError('agent_mission_negotiation_failed');
      }
      resources.agentMissionSession = agentMissionSession;
      this.assertGeneration(generation);
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
        assertProviderAnswer(bootstrap.value.answerSdp, this.nativeDownlink);
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
      this.assertNegotiatedAudioTransceiver(peer, microphoneTransceiver);
      await this.waitForDataChannel(channel, generation);
      this.assertGeneration(generation);
      this.metrics.markDataChannelOpened();
      this.agentMissionSession = resources.agentMissionSession;
      resources.agentMissionSession = null;
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
      this.disposeAttemptAgentMissionSession(resources);
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
    if (this.nativeDownlink) {
      // Le contrat ACK V1 exige une origine SLO `speech_stopped` réellement observée. Un tour
      // texte n'en possède aucune : le refuser avant le réseau vaut mieux que fabriquer un temps
      // de départ ou laisser une réponse native impossible à acquitter.
      this.emit({ type: 'error', code: 'native_text_input_not_supported' });
      return false;
    }
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

  async synchronizePublishedContext(fence: RealtimePublishedContextFence): Promise<boolean> {
    const sessionHandle = this.sessionHandle;
    if (
      sessionHandle === null
      || !UUID.test(fence.sessionHandle)
      || fence.sessionHandle.toLowerCase() !== sessionHandle.toLowerCase()
      || !Number.isSafeInteger(fence.contextRevision)
      || fence.contextRevision < 1
      || fence.contextRevision > 2_147_483_647
      || !SHA_256.test(fence.contextDigest)
    ) return false;

    const canonicalFence = Object.freeze({
      sessionHandle: sessionHandle.toLowerCase(),
      contextRevision: fence.contextRevision,
      contextDigest: fence.contextDigest,
    });
    const previous = this.publishedContextFence;
    const contextChanged = previous !== null
      && (
        previous.contextRevision !== canonicalFence.contextRevision
        || previous.contextDigest !== canonicalFence.contextDigest
      );
    if (contextChanged && this.nativeDownlink) {
      if (this.responseActive) {
        // Une navigation rend toute observation du tour précédent impropre à un ACK. La coupure
        // locale précède la mise à jour de la fence ; un HTTP 200 tardif restera donc sans effet.
        this.interrupt('navigation');
      } else {
        // Une queue locale conservée après l'ACK appartient elle aussi à l'ancien écran. La
        // couper ne dépend pas de `responseActive`, déjà faux après le reçu durable.
        this.cancelNativeProviderDrainedTail(true);
        this.clearNativeResponseTerminalWatchdog();
      }
    }
    this.publishedContextFence = canonicalFence;
    return true;
  }

  interrupt(_reason: 'user_speech' | 'tap' | 'navigation'): boolean {
    this.cancelNativeProviderDrainedTail(true);
    this.clearNativeResponseTerminalWatchdog();
    if (!this.responseActive) return false;
    // Le premier geste coupe la piste locale AVANT toute écriture réseau. Les appels
    // réentrants ou répétés voient ensuite les latches et ne peuvent jamais doubler les
    // commandes provider pour une même réponse.
    if (this.responseLocallyMuted) return true;
    this.responseLocallyMuted = true;
    this.invalidateNativeSpeechObservation();
    this.metrics.markBargeIn();
    this.pendingAgentControlReference = null;
    // `response.done` précède `output_audio_buffer.stopped` en WebRTC. Si toute la réponse est
    // déjà générée mais encore audible, seul le clear est valide et doit rester disponible.
    const shouldCancel = !this.responseGenerationDone
      && this.activeProviderResponseId !== null
      && !this.responseCancelAttempted;
    const shouldClear = !this.responseClearAttempted;
    // Armer tous les latches avant le premier send protège aussi contre un callback de canal
    // synchrone et réentrant. Un échec n'est jamais rejoué : la piste reste muette et la
    // session est fermée fail-safe plutôt que de risquer une commande dupliquée.
    if (shouldCancel) this.responseCancelAttempted = true;
    if (shouldClear) this.responseClearAttempted = true;
    const cancelled = !shouldCancel || this.send({
          type: 'response.cancel',
          event_id: this.nextEventId('cancel'),
          response_id: this.activeProviderResponseId!,
        });
    const cleared = !shouldClear || this.send({
      type: 'output_audio_buffer.clear',
      event_id: this.nextEventId('clear'),
    });
    if (!cancelled || !cleared) {
      this.emit({ type: 'error', code: 'interrupt_delivery_failed' });
      void this.degradeAndClose('provider_error', this.currentState.generation);
    }
    // L'interruption est acquise localement, même si le canal vient de tomber : retourner true
    // empêche l'appelant de tenter un retry réseau alors que les latches sont déjà armés.
    return true;
  }

  close(_reason: RealtimeCloseReason): Promise<void> {
    this.disposeAgentMissionSession();
    if (this.closingPromise) {
      // Un connect demandé pendant le hangup précédent attend sans posséder de micro. Une
      // fermeture/background doit néanmoins annuler cette intention, pas la ressusciter ensuite.
      this.pendingConnectAbort?.abort();
      return this.closingPromise;
    }
    if (this.currentState.phase === 'closed') {
      this.cancelNativeProviderDrainedTail(true);
      this.clearNativeResponseTerminalWatchdog();
      return Promise.resolve();
    }
    // Neutraliser la sortie avec la génération encore autoritative, avant de fencer tous les
    // callbacks du peer. Aucun paquet mis en file ne reste audible pendant le teardown.
    this.cancelNativeProviderDrainedTail(true);
    this.clearNativeResponseTerminalWatchdog();
    this.invalidateNativeSpeechObservation();
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
      expectedAudioTransceiver: this.expectedAudioTransceiver,
      remoteAudioTrack: this.remoteAudioTrack,
      agentMissionSession: null,
    };
    this.responseActive = false;
    this.responseGenerationDone = false;
    this.responseStatus = null;
    this.activeProviderResponseId = null;
    this.pendingAgentControlReference = null;
    this.remoteAudioActive = false;
    this.responseHadAudio = false;
    this.responseAudioStopped = false;
    this.publishedContextFence = null;
    this.activeNativeSpeechReference = null;
    this.activeNativeTranscript = null;
    this.activeResponseInboundRtpObserved = false;
    this.activeResponseFirstInboundRtpMs = null;
    this.nativeSpeechObservationValid = false;
    this.resetResponseInterruptionState();
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
      if (this.remoteAudioTrack === resources.remoteAudioTrack) {
        this.remoteAudioTrack = null;
        this.remoteAudioTrackGeneration = 0;
      }
      if (this.expectedAudioTransceiver === resources.expectedAudioTransceiver) {
        this.expectedAudioTransceiver = null;
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

  private attachPeerEvents(
    peer: RTCPeerConnection,
    generation: number,
    resources: AttemptResources,
    expectedAudioTransceiver: RTCRtpTransceiver,
  ): void {
    runtimeEvents(peer).addEventListener('track', (event: unknown) => {
      this.handleRemoteTrack(event, generation, resources, expectedAudioTransceiver);
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

  private handleRemoteTrack(
    event: unknown,
    generation: number,
    resources: AttemptResources,
    expectedAudioTransceiver: RTCRtpTransceiver,
  ): void {
    const value = event && typeof event === 'object'
      ? event as {
          track?: MediaStreamTrack | null;
          receiver?: { track?: MediaStreamTrack | null } | null;
          transceiver?: RTCRtpTransceiver | null;
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
    // Une piste d'une génération déjà fencée doit être neutralisée, mais elle ne peut plus
    // dégrader ni fermer le nouveau peer devenu autoritaire.
    if (generation !== this.generation) {
      this.neutralizeRejectedRemoteTrack(tracks);
      return;
    }

    const [track] = tracks;
    const validNativeTrack = this.nativeDownlink
      && tracks.size === 1
      && track !== undefined
      && track.kind === 'audio'
      && value.track === track
      && value.transceiver === expectedAudioTransceiver
      && value.transceiver.receiver.track === track
      && (value.receiver === undefined
        || value.receiver === null
        || value.receiver === expectedAudioTransceiver.receiver)
      && this.expectedAudioTransceiver === expectedAudioTransceiver
      && resources.expectedAudioTransceiver === expectedAudioTransceiver
      && resources.remoteAudioTrack === null
      && this.remoteAudioTrack === null;
    if (!validNativeTrack || !track) {
      this.neutralizeRejectedRemoteTrack(tracks);
      this.failClosedUnauthorizedDownlink(generation);
      return;
    }

    // Le track event peut précéder l'accusé `output_audio_buffer.started`. Il entre donc
    // toujours muet, sauf si cet accusé exact a déjà été reçu pour la réponse courante.
    track.enabled = this.remoteAudioActive && !this.responseLocallyMuted;
    resources.remoteAudioTrack = track;
    this.remoteAudioTrack = track;
    this.remoteAudioTrackGeneration = generation;
  }

  private neutralizeRejectedRemoteTrack(tracks: ReadonlySet<MediaStreamTrack>): void {
    for (const track of tracks) {
      try { track.enabled = false; } catch { /* piste provider déjà libérée */ }
      try { track.stop(); } catch { /* piste provider déjà arrêtée */ }
    }
    // Ne jamais appeler RTCRtpTransceiver.stop() en fire-and-forget ici. RN-WebRTC 124
    // lance une Promise native interne non exposée ; sur un peer stale elle rejetterait après
    // ce try/catch. La piste suffit à neutraliser l'audio et le peer courant est fermé ensuite.
  }

  private assertNegotiatedAudioTransceiver(
    peer: RTCPeerConnection,
    expectedAudioTransceiver: RTCRtpTransceiver,
  ): void {
    const transceivers = peer.getTransceivers();
    const expectedDirection = this.nativeDownlink ? 'sendrecv' : 'sendonly';
    if (
      transceivers.length === 1
      && transceivers[0] === expectedAudioTransceiver
      && expectedAudioTransceiver.direction === expectedDirection
      && expectedAudioTransceiver.currentDirection === expectedDirection
    ) return;

    for (const transceiver of transceivers) {
      try { transceiver.receiver.track?.stop(); } catch { /* piste provider déjà arrêtée */ }
    }
    this.emit({ type: 'error', code: 'provider_downlink_rejected' });
    throw new RealtimeTransportError('provider_error');
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
      // Une reprise ICE ne prouve pas que les paquets déjà observés appartiennent encore à la
      // même lecture continue. Le tour courant ne pourra donc plus être acquitté.
      const mustFenceNativeResponse = this.nativeDownlink && this.responseActive;
      this.invalidateNativeSpeechObservation();
      this.emitConnectivity('disconnected');
      if (mustFenceNativeResponse) {
        this.setRemoteAudioEnabled(false);
        void this.degradeAndClose('provider_error', generation);
      }
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
        if (this.seenProviderResponseIds.has(responseId)) {
          // `response.created` est one-shot. Un doublon, y compris après sa terminaison, ne
          // doit ni réarmer la sortie ni dégrader la réponse devenue autoritative ensuite.
          break;
        }
        if (this.responseActive && this.activeProviderResponseId !== null) {
          this.emit({ type: 'error', code: 'overlapping_provider_response' });
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        if (this.seenProviderResponseIds.size >= MAX_PROVIDER_RESPONSES_PER_SESSION) {
          this.emit({ type: 'error', code: 'response_limit_exceeded' });
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        const nativeSpeechReference = event.nativeSpeechReference ?? null;
        if (
          (this.nativeDownlink && (
            nativeSpeechReference === null
            || !this.nativeSpeechReferenceMatchesPublishedFence(nativeSpeechReference)
          ))
          || (!this.nativeDownlink && nativeSpeechReference !== null)
        ) {
          this.emit({ type: 'error', code: 'native_speech_context_mismatch' });
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        if (
          nativeSpeechReference !== null
          && (
            this.seenNativeSpeechDeliveryIds.has(nativeSpeechReference.deliveryId)
            || this.seenNativeSpeechDeliveryIds.size >= MAX_PROVIDER_RESPONSES_PER_SESSION
          )
        ) {
          this.emit({ type: 'error', code: 'native_speech_delivery_replay' });
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        this.seenProviderResponseIds.add(responseId);
        if (nativeSpeechReference !== null) {
          this.seenNativeSpeechDeliveryIds.add(nativeSpeechReference.deliveryId);
        }
        this.activeProviderResponseId = responseId;
        this.responseActive = true;
        this.responseGenerationDone = false;
        this.responseStatus = null;
        this.remoteAudioActive = false;
        this.responseHadAudio = false;
        this.responseAudioStopped = false;
        this.activeNativeSpeechReference = nativeSpeechReference;
        this.activeNativeTranscript = null;
        this.activeResponseInboundRtpObserved = false;
        this.activeResponseFirstInboundRtpMs = null;
        this.nativeSpeechObservationValid = true;
        this.cancelNativeSpeechAcknowledgement();
        this.cancelNativeProviderDrainedTail(true);
        this.clearNativeResponseTerminalWatchdog();
        this.resetResponseInterruptionState();
        // Une ancienne queue RTP peut encore contenir quelques échantillons après le signal de
        // drain fournisseur. Le nouveau tour la neutralise avant de rouvrir explicitement la piste
        // sur son propre `buffer.started`.
        this.setRemoteAudioEnabled(false);
        // Le contrat natif V1 ne possède encore aucun ACK mobile autoritatif. Même des
        // metadata legacy syntaxiquement valides ne peuvent donc produire un effet UI.
        this.pendingAgentControlReference = !this.nativeDownlink && event.controlReference
          ? { responseId, reference: event.controlReference }
          : null;
        this.metrics.markResponseStarted();
        break;
      }
      case 'speech_started':
        // Une queue locale préservée après l'ACK proxy du tour précédent ne doit jamais parler
        // par-dessus l'utilisateur. Cette coupure locale précède toute commande réseau.
        if (this.responseActive) {
          this.interrupt('user_speech');
        } else if (this.nativeDownlink) {
          this.cancelNativeProviderDrainedTail(true);
          this.clearNativeResponseTerminalWatchdog();
        }
        this.transition({ type: 'USER_SPEECH_STARTED' });
        break;
      case 'speech_stopped':
        this.metrics.markSpeechStopped();
        this.rtpProbeBaselinePackets = this.lastInboundPackets;
        this.startRtpProbe(this.currentState.generation);
        this.transition({ type: 'USER_SPEECH_STOPPED' });
        break;
      case 'audio_signal': {
        if (!this.acceptCurrentResponseEvent(event)) break;
        this.responseActive = true;
        // Un delta natif annonce de la génération, pas du son rendu. Il ne doit ni ouvrir la
        // piste ni satisfaire le SLO "premier audio" avant l'accusé exact du buffer de sortie.
        if (this.nativeDownlink && event.source !== 'buffer_started') break;
        const hadFirstAudioSignal = this.metrics.snapshot().speechStoppedEventToFirstAudioSignalMs !== null;
        this.metrics.markFirstAudioSignal();
        this.remoteAudioActive = true;
        this.responseHadAudio = true;
        this.responseAudioStopped = false;
        if (this.nativeDownlink && event.source === 'buffer_started') {
          // Le baseline doit être échantillonné APRÈS le `buffer.started` de cette réponse. Un
          // compteur relevé à `speech_stopped` peut encore progresser à cause de la queue RTP du
          // tour précédent et fabriquer une fausse preuve pour le suivant. Cette fenêtre est
          // réarmée même si le délai provider a dépassé le budget initial ; l'origine SLO reste
          // le `speech_stopped` mémorisé par RealtimeMetricsTracker.
          this.startRtpProbe(this.currentState.generation, true);
        }
        this.setRemoteAudioEnabled(!this.responseLocallyMuted);
        this.transition({ type: 'BOB_AUDIO_STARTED' });
        if (!hadFirstAudioSignal) this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
        break;
      }
      case 'audio_stopped':
        if (!this.acceptCurrentResponseEvent(event)) break;
        this.remoteAudioActive = false;
        this.responseAudioStopped = true;
        // `output_audio_buffer.stopped` atteste le drain du buffer SERVEUR uniquement. Couper la
        // piste ici peut tronquer la queue jitter/DAC locale. Elle reste ouverte en natif jusqu'au
        // prochain tour, au barge-in ou au teardown ; les chemins annulés restent toujours muets.
        if (!this.nativeDownlink) this.setRemoteAudioEnabled(false);
        if (this.nativeDownlink) {
          void this.collectStats(this.currentState.generation, false);
        }
        if (this.responseGenerationDone) {
          this.clearNativeResponseTerminalWatchdog();
          if (
            this.nativeDownlink
            && this.responseHadAudio
            && this.responseStatus === 'completed'
          ) {
            this.maybeAcknowledgeNativeSpeech();
          } else {
            this.completeActiveResponse(this.responseStatus === 'completed');
          }
        } else if (this.nativeDownlink && this.responseHadAudio) {
          this.armNativeResponseTerminalWatchdog('response_done');
        }
        break;
      case 'audio_cleared':
        if (!this.acceptCurrentResponseEvent(event)) break;
        this.clearNativeResponseTerminalWatchdog();
        this.remoteAudioActive = false;
        this.responseAudioStopped = true;
        this.setRemoteAudioEnabled(false);
        this.metrics.markAudioCleared();
        this.invalidateNativeSpeechObservation();
        this.completeActiveResponse(false);
        break;
      case 'response_done':
        if (!this.acceptCurrentResponseEvent(event)) break;
        if (
          this.nativeDownlink
          && (
            event.nativeSpeechReference === undefined
            || this.activeNativeSpeechReference === null
            || !this.sameNativeSpeechReference(
              event.nativeSpeechReference,
              this.activeNativeSpeechReference,
            )
          )
        ) {
          this.emit({ type: 'error', code: 'native_speech_metadata_mismatch' });
          this.invalidateNativeSpeechObservation();
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        if (event.status === 'failed' || event.status === 'incomplete') {
          this.clearNativeResponseTerminalWatchdog();
          this.setRemoteAudioEnabled(false);
          this.pendingAgentControlReference = null;
          this.invalidateNativeSpeechObservation();
          this.emit({ type: 'error', code: `response_${event.status}` });
          void this.degradeAndClose('provider_error', this.currentState.generation);
          break;
        }
        this.responseGenerationDone = true;
        this.responseStatus = event.status;
        if (event.status === 'cancelled') {
          this.clearNativeResponseTerminalWatchdog();
          // Une annulation n'est pas un drain heureux : aucune queue locale de cette réponse ne
          // doit survivre, quelle que soit l'origine fournisseur de l'annulation.
          this.setRemoteAudioEnabled(false);
          this.pendingAgentControlReference = null;
          this.invalidateNativeSpeechObservation();
          // `cancelled` est le terminal de génération. La piste est déjà muette : attendre en
          // plus `stopped` ou `cleared` laisserait le transport bloqué si le provider l'omet.
          this.completeActiveResponse(false);
          break;
        }
        this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
        if (!this.responseHadAudio || this.responseAudioStopped) {
          this.clearNativeResponseTerminalWatchdog();
          if (
            this.nativeDownlink
            && this.responseHadAudio
            && event.status === 'completed'
          ) {
            this.maybeAcknowledgeNativeSpeech();
          } else {
            this.completeActiveResponse(true);
          }
        } else if (this.nativeDownlink && event.status === 'completed') {
          this.armNativeResponseTerminalWatchdog('audio_stopped');
        }
        break;
      case 'user_transcript':
        this.emit(event);
        break;
      case 'bob_transcript':
        if (!this.acceptCurrentResponseEvent(event)) break;
        if (!this.nativeDownlink) {
          this.emit(event);
          break;
        }
        if (event.final) {
          if (this.activeNativeTranscript !== null && this.activeNativeTranscript !== event.text) {
            this.emit({ type: 'error', code: 'native_speech_transcript_conflict' });
            this.invalidateNativeSpeechObservation();
            void this.degradeAndClose('provider_error', this.currentState.generation);
            break;
          }
          this.activeNativeTranscript = event.text;
          this.maybeAcknowledgeNativeSpeech();
        }
        break;
      case 'provider_error':
        this.emit({ type: 'error', code: event.code });
        if (this.nativeDownlink && this.responseActive) {
          this.invalidateNativeSpeechObservation();
          void this.degradeAndClose('provider_error', this.currentState.generation);
        }
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

  private acceptCurrentResponseEvent(event: ReturnType<typeof decodeRealtimeServerEvent>): boolean {
    const responseId = realtimeProviderResponseId(event);
    if (responseId !== null && responseId === this.activeProviderResponseId) return true;
    // Un événement retardé d'une réponse déjà connue reste inerte. Un identifiant jamais créé
    // sur ce canal signale en revanche une rupture de corrélation et ferme la session.
    if (responseId !== null && this.seenProviderResponseIds.has(responseId)) return false;
    this.emit({ type: 'error', code: 'unknown_provider_response' });
    this.invalidateNativeSpeechObservation();
    void this.degradeAndClose('provider_error', this.currentState.generation);
    return false;
  }

  private sameNativeSpeechReference(
    left: RealtimeNativeSpeechReference,
    right: RealtimeNativeSpeechReference,
  ): boolean {
    return left.deliveryId === right.deliveryId
      && left.turnId === right.turnId
      && left.contextRevision === right.contextRevision
      && left.contextDigest === right.contextDigest;
  }

  private nativeSpeechReferenceMatchesPublishedFence(
    reference: RealtimeNativeSpeechReference,
  ): boolean {
    const fence = this.publishedContextFence;
    const sessionHandle = this.sessionHandle;
    return fence !== null
      && sessionHandle !== null
      && fence.sessionHandle === sessionHandle.toLowerCase()
      && fence.contextRevision === reference.contextRevision
      && fence.contextDigest === reference.contextDigest;
  }

  private maybeAcknowledgeNativeSpeech(): void {
    if (!this.nativeDownlink || !this.responseActive || !this.nativeSpeechObservationValid) return;
    if (this.pendingNativeSpeechAcknowledgement !== null) return;
    const responseId = this.activeProviderResponseId;
    const reference = this.activeNativeSpeechReference;
    const transcript = this.activeNativeTranscript;
    const firstInboundRtpMs = this.activeResponseFirstInboundRtpMs;
    const providerDrained = this.responseGenerationDone
      && this.responseStatus === 'completed'
      && this.responseAudioStopped
      && this.responseHadAudio;
    if (!providerDrained) return;
    if (responseId === null) {
      this.failNativeSpeechAcknowledgement('native_speech_response_binding_missing');
      return;
    }
    if (
      reference === null
      || transcript === null
      || !this.activeResponseInboundRtpObserved
      || firstInboundRtpMs === null
      || !Number.isSafeInteger(firstInboundRtpMs)
      || firstInboundRtpMs < 0
      || firstInboundRtpMs > 60_000
      || !this.nativeSpeechReferenceMatchesPublishedFence(reference)
      || this.sessionHandle === null
      || !UUID.test(this.sessionHandle)
      || this.responseLocallyMuted
    ) {
      this.armNativeSpeechAckEligibilityTimeout(responseId);
      return;
    }

    let acknowledgementId: string;
    try {
      acknowledgementId = randomUUID().toLowerCase();
    } catch {
      this.failNativeSpeechAcknowledgement('native_speech_ack_identifier_failed');
      return;
    }
    if (!UUID.test(acknowledgementId)) {
      this.failNativeSpeechAcknowledgement('native_speech_ack_identifier_failed');
      return;
    }
    const input: RealtimeVoiceNativeSpeechDeliveryInput = Object.freeze({
      acknowledgementId,
      contextRevision: reference.contextRevision,
      contextDigest: reference.contextDigest,
      slo: Object.freeze({
        speechStoppedEventToFirstInboundRtpMs: firstInboundRtpMs,
      }),
      localObservation: NATIVE_LOCAL_OBSERVATION,
    });
    const attempt: NativeSpeechAcknowledgementAttempt = Object.freeze({
      transportGeneration: this.generation,
      responseId,
      reference,
      acknowledgementId,
      input,
      abort: new AbortController(),
    });
    this.clearNativeSpeechAckEligibilityTimer();
    this.pendingNativeSpeechAcknowledgement = attempt;
    void this.runNativeSpeechAcknowledgement(attempt);
  }

  private async runNativeSpeechAcknowledgement(
    attempt: NativeSpeechAcknowledgementAttempt,
  ): Promise<void> {
    for (let index = 0; index < NATIVE_SPEECH_ACK_MAX_ATTEMPTS; index += 1) {
      const call = await this.callNativeSpeechAcknowledgement(attempt);
      if (call.kind === 'aborted' || !this.isCurrentNativeSpeechAcknowledgement(attempt)) return;
      if (call.kind === 'result' && call.result.ok) {
        if (!this.nativeSpeechAcknowledgementMatches(call.result.value, attempt)) {
          this.failNativeSpeechAcknowledgement('native_speech_ack_receipt_mismatch', attempt);
          return;
        }
        // Le transcript fournisseur reste une preuve de concordance transport, jamais l'autorité
        // de l'UI. La V1 ne possède pas encore de relecture canonique serveur : publier ce texte,
        // même après un ACK durable, donnerait à une trame provider le dernier mot sur l'historique.
        // Le reçu valide seulement la livraison ; aucun transcript n'est donc émis ici.
        this.pendingNativeSpeechAcknowledgement = null;
        this.completeActiveResponse(false, true);
        return;
      }

      const retryable = call.kind === 'thrown'
        || (
          call.kind === 'result'
          && !call.result.ok
          && this.isRetryableNativeSpeechAckError(call.result)
        );
      if (!retryable || index === NATIVE_SPEECH_ACK_MAX_ATTEMPTS - 1) {
        this.failNativeSpeechAcknowledgement(
          retryable ? 'native_speech_ack_unavailable' : 'native_speech_ack_rejected',
          attempt,
        );
        return;
      }
      const continued = await this.waitForNativeSpeechAckRetry(
        attempt,
        this.nativeSpeechAcknowledgementRetryDelayMs(call, index),
      );
      if (!continued) return;
    }
  }

  private callNativeSpeechAcknowledgement(
    attempt: NativeSpeechAcknowledgementAttempt,
  ): Promise<NativeSpeechAcknowledgementCall> {
    if (attempt.abort.signal.aborted) return Promise.resolve({ kind: 'aborted' });
    const sessionHandle = this.sessionHandle;
    if (sessionHandle === null) return Promise.resolve({ kind: 'aborted' });
    const operation: Promise<NativeSpeechAcknowledgementCall> = Promise.resolve()
      .then(() => this.client.acknowledgeRealtimeVoiceNativeSpeechDelivery(
        sessionHandle,
        attempt.reference.turnId,
        attempt.reference.deliveryId,
        attempt.input,
        attempt.abort.signal,
      ))
      .then(
        (result) => ({ kind: 'result' as const, result }),
        () => ({ kind: 'thrown' as const }),
      );
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: NativeSpeechAcknowledgementCall): void => {
        if (settled) return;
        settled = true;
        attempt.abort.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish({ kind: 'aborted' });
      attempt.abort.signal.addEventListener('abort', onAbort, { once: true });
      void operation.then(finish);
      if (attempt.abort.signal.aborted) onAbort();
    });
  }

  private waitForNativeSpeechAckRetry(
    attempt: NativeSpeechAcknowledgementAttempt,
    delayMs: number,
  ): Promise<boolean> {
    if (!this.isCurrentNativeSpeechAcknowledgement(attempt)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (continued: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        attempt.abort.signal.removeEventListener('abort', onAbort);
        resolve(continued);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(this.isCurrentNativeSpeechAcknowledgement(attempt)), delayMs);
      attempt.abort.signal.addEventListener('abort', onAbort, { once: true });
      if (attempt.abort.signal.aborted) onAbort();
    });
  }

  private isRetryableNativeSpeechAckError(
    result: Exclude<
      Awaited<ReturnType<BobClient['acknowledgeRealtimeVoiceNativeSpeechDelivery']>>,
      { readonly ok: true }
    >,
  ): boolean {
    return result.error.kind === 'unavailable'
      || (result.error.kind === 'dependency' && result.error.port === 'api');
  }

  private nativeSpeechAcknowledgementRetryDelayMs(
    call: Exclude<NativeSpeechAcknowledgementCall, { readonly kind: 'aborted' }>,
    attemptIndex: number,
  ): number {
    const fallbackMs = NATIVE_SPEECH_ACK_RETRY_DELAYS_MS[attemptIndex] ?? 250;
    if (
      call.kind !== 'result'
      || call.result.ok
      || call.result.error.kind !== 'unavailable'
      || call.result.error.retryAfterSeconds === undefined
    ) return fallbackMs;
    // Le codec HTTP borne ce champ à 0..86 400 s. Attendre au moins Retry-After évite qu'un
    // `not_ready` (ACK arrivé avant le CAS fournisseur -> completed) provoque une rafale.
    return Math.max(fallbackMs, call.result.error.retryAfterSeconds * 1_000);
  }

  private nativeSpeechAcknowledgementMatches(
    receipt: RealtimeVoiceNativeSpeechDeliveryAcknowledgement,
    attempt: NativeSpeechAcknowledgementAttempt,
  ): boolean {
    return receipt.deliveryId === attempt.reference.deliveryId
      && receipt.turnId === attempt.reference.turnId
      && receipt.acknowledgementId === attempt.acknowledgementId
      && receipt.contextRevision === attempt.reference.contextRevision
      && receipt.contextDigest === attempt.reference.contextDigest
      && typeof receipt.idempotent === 'boolean';
  }

  private isCurrentNativeSpeechAcknowledgement(
    attempt: NativeSpeechAcknowledgementAttempt,
  ): boolean {
    return this.pendingNativeSpeechAcknowledgement === attempt
      && !attempt.abort.signal.aborted
      && attempt.transportGeneration === this.generation
      && attempt.responseId === this.activeProviderResponseId
      && this.responseActive
      && this.nativeSpeechObservationValid
      && this.activeNativeSpeechReference !== null
      && this.sameNativeSpeechReference(attempt.reference, this.activeNativeSpeechReference)
      && this.nativeSpeechReferenceMatchesPublishedFence(attempt.reference);
  }

  private armNativeSpeechAckEligibilityTimeout(responseId: string): void {
    if (this.nativeSpeechAckEligibilityTimer !== null) return;
    const generation = this.generation;
    this.nativeSpeechAckEligibilityTimer = setTimeout(() => {
      this.nativeSpeechAckEligibilityTimer = null;
      if (
        generation !== this.generation
        || responseId !== this.activeProviderResponseId
        || !this.responseActive
        || this.pendingNativeSpeechAcknowledgement !== null
      ) return;
      this.failNativeSpeechAcknowledgement('native_speech_observation_incomplete');
    }, NATIVE_SPEECH_ACK_ELIGIBILITY_TIMEOUT_MS);
  }

  private clearNativeSpeechAckEligibilityTimer(): void {
    if (this.nativeSpeechAckEligibilityTimer !== null) {
      clearTimeout(this.nativeSpeechAckEligibilityTimer);
      this.nativeSpeechAckEligibilityTimer = null;
    }
  }

  private cancelNativeSpeechAcknowledgement(): void {
    this.clearNativeSpeechAckEligibilityTimer();
    const pending = this.pendingNativeSpeechAcknowledgement;
    this.pendingNativeSpeechAcknowledgement = null;
    pending?.abort.abort();
  }

  private invalidateNativeSpeechObservation(): void {
    this.nativeSpeechObservationValid = false;
    this.activeNativeTranscript = null;
    this.activeResponseInboundRtpObserved = false;
    this.activeResponseFirstInboundRtpMs = null;
    this.cancelNativeSpeechAcknowledgement();
  }

  private failNativeSpeechAcknowledgement(
    code: string,
    attempt?: NativeSpeechAcknowledgementAttempt,
  ): void {
    if (attempt !== undefined && !this.isCurrentNativeSpeechAcknowledgement(attempt)) return;
    this.emit({ type: 'error', code });
    this.invalidateNativeSpeechObservation();
    void this.degradeAndClose('provider_error', this.currentState.generation);
  }

  private completeActiveResponse(
    allowControl: boolean,
    preserveNativeProviderDrainedTail = false,
  ): void {
    const responseId = this.activeProviderResponseId;
    const controlReference = allowControl
      && this.responseStatus === 'completed'
      && this.pendingAgentControlReference?.responseId === responseId
      ? this.pendingAgentControlReference.reference
      : null;
    const preserveProviderTail = preserveNativeProviderDrainedTail
      && this.nativeDownlink
      && !this.responseLocallyMuted;
    this.cancelNativeSpeechAcknowledgement();
    this.clearNativeResponseTerminalWatchdog();
    this.responseActive = false;
    this.responseGenerationDone = false;
    this.activeProviderResponseId = null;
    this.responseStatus = null;
    this.pendingAgentControlReference = null;
    this.remoteAudioActive = false;
    this.responseHadAudio = false;
    this.responseAudioStopped = false;
    this.activeNativeSpeechReference = null;
    this.activeNativeTranscript = null;
    this.activeResponseInboundRtpObserved = false;
    this.activeResponseFirstInboundRtpMs = null;
    this.nativeSpeechObservationValid = false;
    if (preserveProviderTail) this.armNativeProviderDrainedTail();
    else this.cancelNativeProviderDrainedTail(true);
    this.resetResponseInterruptionState();
    this.transition({ type: 'RESPONSE_DONE' });
    this.emit({ type: 'metrics', metrics: this.metrics.snapshot() });
    if (controlReference) {
      this.emit({ type: 'agent_control_candidate', reference: controlReference });
    }
  }

  private resetResponseInterruptionState(): void {
    this.responseLocallyMuted = false;
    this.responseCancelAttempted = false;
    this.responseClearAttempted = false;
  }

  private setRemoteAudioEnabled(enabled: boolean): void {
    const track = this.remoteAudioTrack;
    if (
      !track
      || !this.nativeDownlink
      || this.remoteAudioTrackGeneration !== this.generation
    ) return;
    try { track.enabled = enabled; } catch {
      // Une piste libérée pendant le teardown reste acoustiquement neutre ; le peer sera fermé.
    }
  }

  private armNativeProviderDrainedTail(): void {
    this.cancelNativeProviderDrainedTail(false);
    const generation = this.generation;
    const epoch = this.nativeProviderDrainedTailEpoch;
    this.nativeProviderDrainedTailTimer = setTimeout(() => {
      if (
        generation !== this.generation
        || epoch !== this.nativeProviderDrainedTailEpoch
      ) return;
      this.nativeProviderDrainedTailTimer = null;
      this.setRemoteAudioEnabled(false);
    }, NATIVE_PROVIDER_DRAINED_TAIL_MS);
  }

  private cancelNativeProviderDrainedTail(mute: boolean): void {
    this.nativeProviderDrainedTailEpoch += 1;
    if (this.nativeProviderDrainedTailTimer !== null) {
      clearTimeout(this.nativeProviderDrainedTailTimer);
      this.nativeProviderDrainedTailTimer = null;
    }
    if (mute) this.setRemoteAudioEnabled(false);
  }

  private armNativeResponseTerminalWatchdog(kind: NativeResponseTerminalWatchdog): void {
    const responseId = this.activeProviderResponseId;
    if (!this.nativeDownlink || responseId === null || !this.responseActive) return;
    // Un doublon provider ne doit jamais repousser l'échéance du premier terminal manquant.
    if (
      this.nativeResponseTerminalTimer !== null
      && this.nativeResponseTerminalKind === kind
      && this.nativeResponseTerminalResponseId === responseId
    ) return;
    this.clearNativeResponseTerminalWatchdog();
    const generation = this.generation;
    const epoch = this.nativeResponseTerminalEpoch;
    const delayMs = kind === 'response_done'
      ? NATIVE_RESPONSE_DONE_WATCHDOG_MS
      : NATIVE_AUDIO_STOPPED_WATCHDOG_MS;
    this.nativeResponseTerminalTimer = setTimeout(() => {
      if (
        generation !== this.generation
        || epoch !== this.nativeResponseTerminalEpoch
        || responseId !== this.activeProviderResponseId
        || !this.responseActive
      ) return;
      const terminalStillMissing = kind === 'response_done'
        ? this.responseAudioStopped && !this.responseGenerationDone
        : this.responseGenerationDone
          && this.responseStatus === 'completed'
          && this.responseHadAudio
          && !this.responseAudioStopped;
      if (!terminalStillMissing) return;
      this.nativeResponseTerminalTimer = null;
      this.nativeResponseTerminalKind = null;
      this.nativeResponseTerminalResponseId = null;
      this.failNativeSpeechAcknowledgement(
        kind === 'response_done'
          ? 'native_speech_response_done_timeout'
          : 'native_speech_audio_stopped_timeout',
      );
    }, delayMs);
    this.nativeResponseTerminalKind = kind;
    this.nativeResponseTerminalResponseId = responseId;
  }

  private clearNativeResponseTerminalWatchdog(): void {
    this.nativeResponseTerminalEpoch += 1;
    if (this.nativeResponseTerminalTimer !== null) {
      clearTimeout(this.nativeResponseTerminalTimer);
      this.nativeResponseTerminalTimer = null;
    }
    this.nativeResponseTerminalKind = null;
    this.nativeResponseTerminalResponseId = null;
  }

  private startStats(generation: number): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => { void this.collectStats(generation, true); }, STATS_INTERVAL_MS);
  }

  private startRtpProbe(generation: number, responseObserved = false): void {
    if (this.rtpProbeTimer) clearInterval(this.rtpProbeTimer);
    this.rtpProbeDeadlineAt = Date.now() + RTP_PROBE_BUDGET_MS;
    this.rtpProbeActive = true;
    this.rtpProbeBaselineReady = false;
    this.rtpProbeResponseObserved = responseObserved;
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
      if (inboundPackets > 0 && !this.nativeDownlink) {
        // Défense en profondeur : certains runtimes natifs peuvent exposer les paquets dans
        // getStats avant de livrer l'événement `track`. Le moindre paquet audio entrant viole
        // le contrat audité : seul le lecteur de blobs signés a le droit de parler. Le contrat
        // OpenAI natif, lui, mesure ces paquets comme signal de latence sans fermer le peer.
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
        && this.responseActive
        && this.responseHadAudio
        && this.activeProviderResponseId !== null
        && !baselinePrimed
        && inboundPackets > this.rtpProbeBaselinePackets
      ) {
        this.metrics.markFirstInboundRtp();
        const firstInboundRtpMs = this.metrics.snapshot().speechStoppedToFirstInboundRtpMs;
        if (firstInboundRtpMs !== null) {
          this.activeResponseInboundRtpObserved = true;
          this.activeResponseFirstInboundRtpMs = Math.round(firstInboundRtpMs);
        }
      }
      this.metrics.updateWebRtcStats({ roundTripTimeMs, jitterMs, packetsLost });
      const snapshot = this.metrics.snapshot();
      if (
        publishPeriodicSnapshot
        || (!hadFirstInboundRtp && snapshot.speechStoppedToFirstInboundRtpMs !== null)
      ) {
        this.emit({ type: 'metrics', metrics: snapshot });
      }
      this.maybeAcknowledgeNativeSpeech();
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
    this.disposeAttemptAgentMissionSession(resources);
    resources.bootstrapAbort?.abort();
    // La piste distante est coupée avant le data channel et avant le peer. Son stop fait partie
    // de la preuve de fermeture native : en cas d'échec le lease reste détenu pour un retry.
    const remoteTrackStopped = this.disposeNativeOnce(resources.remoteAudioTrack, (track) => {
      track.enabled = false;
      track.stop();
    });
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
    const closed = remoteTrackStopped && channelClosed && peerClosed && streamReleased;
    if (closed) processAudioSession.release(resources.audioLease);
    return closed;
  }

  private disposeAttemptAgentMissionSession(resources: AttemptResources): void {
    const session = resources.agentMissionSession;
    resources.agentMissionSession = null;
    session?.dispose();
  }

  private disposeAgentMissionSession(): void {
    const session = this.agentMissionSession;
    this.agentMissionSession = null;
    session?.dispose();
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
