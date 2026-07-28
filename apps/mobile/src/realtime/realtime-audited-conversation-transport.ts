import type {
  BobClient,
  RealtimeVoiceSpeechSourcePolicy,
} from '@bob/api-client';
import type { ProcessAudioLease } from '../audio';
import type { RealtimePublishedContextFence } from './realtime-control-gate';
import {
  RealtimeAuditedSpeechPlayerController,
  type RealtimeAuditedSpeechInterruptReason,
  type RealtimeAuditedSpeechPlaybackPort,
  type RealtimeAuditedSpeechPlayerDependencies,
  type RealtimeAuditedSpeechPlayerEvent,
} from './realtime-audited-speech-player';
import {
  RealtimeTransportError,
  type RealtimeCloseReason,
  type RealtimeTransportEvent,
  type RealtimeTransportMetrics,
  type RealtimeTransportState,
  type VoiceConversationTransport,
} from './realtime-transport';

type SpeechClient = Pick<
  BobClient,
  | 'getNextRealtimeVoiceSpeech'
  | 'acknowledgeRealtimeVoiceSpeechDelivery'
  | 'cancelRealtimeVoiceSpeech'
>;

const DEFAULT_RESPONSE_START_TIMEOUT_MS = 30_000;
const MIN_RESPONSE_START_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_START_TIMEOUT_MS = 60_000;

export interface RealtimeAuditedUplinkTransport extends VoiceConversationTransport {
  getProcessAudioLease(): ProcessAudioLease | null;
  getSpeechSourcePolicy(): RealtimeVoiceSpeechSourcePolicy | null;
  /** Présent sur le WebRTC brut, qui peut devenir le transport primaire du contrat natif. */
  readonly completionMode?: 'continuous' | 'one-shot';
  /** Vrai pour un ticket one-shot : la lecture + ACK acoustique clôt toute la mission. */
  readonly completesConversationAfterAuditedSpeech?: boolean;
}

interface AuditedPlayerLike {
  start(): Promise<void>;
  interrupt(reason: RealtimeAuditedSpeechInterruptReason): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: (event: RealtimeAuditedSpeechPlayerEvent) => void): () => void;
}

export interface RealtimeAuditedConversationTransportOptions {
  readonly client: SpeechClient;
  readonly currentFence: () => RealtimePublishedContextFence | null;
  readonly createPlayback: (input: {
    readonly audioLease: ProcessAudioLease;
    readonly speechSourcePolicy: RealtimeVoiceSpeechSourcePolicy;
  }) => RealtimeAuditedSpeechPlaybackPort;
  readonly createIdentifier: () => string;
  readonly createPlayer?: (dependencies: RealtimeAuditedSpeechPlayerDependencies) => AuditedPlayerLike;
  /** Borne entre le commit utilisateur et le premier son audité, injectable pour certification. */
  readonly responseStartTimeoutMs?: number;
}

function interruptReason(
  reason: 'user_speech' | 'tap' | 'navigation',
): RealtimeAuditedSpeechInterruptReason {
  if (reason === 'user_speech') return 'barge_in';
  if (reason === 'navigation') return 'context_changed';
  return 'user_cancel';
}

/**
 * Composition provider-neutral de Bob Live.
 *
 * Le provider ne possède que l'uplink (micro/VAD/transcription). La voix Bob vient exclusivement
 * du feed audité de notre serveur. Les contrôles ne sont relayés qu'après lecture complète et ACK
 * acoustique durable. Un événement de sortie provider est traité comme une dérive de protocole.
 */
export class RealtimeAuditedConversationTransport implements VoiceConversationTransport {
  readonly capabilities: VoiceConversationTransport['capabilities'];
  /** Contrat explicite pour que la glue differe les effets UI d'un ticket one-shot. */
  readonly completionMode: 'continuous' | 'one-shot';
  private readonly listeners = new Set<(event: RealtimeTransportEvent) => void>();
  private currentState: RealtimeTransportState;
  private readonly unsubscribeUplink: () => void;
  private player: AuditedPlayerLike | null = null;
  private unsubscribePlayer: (() => void) | null = null;
  private speechActive = false;
  private driftReported = false;
  private auditedFailureReported = false;
  private responseStartTimer: ReturnType<typeof setTimeout> | null = null;
  private microphoneRequested = false;
  private closed = false;
  private closeTask: Promise<void> | null = null;

  constructor(
    private readonly uplink: RealtimeAuditedUplinkTransport,
    private readonly options: RealtimeAuditedConversationTransportOptions,
  ) {
    this.capabilities = Object.freeze({
      fullDuplex: uplink.capabilities.fullDuplex,
      bargeIn: uplink.capabilities.bargeIn,
      remoteAudio: true,
    });
    this.completionMode = uplink.completesConversationAfterAuditedSpeech === true
      ? 'one-shot'
      : 'continuous';
    this.currentState = uplink.state;
    this.unsubscribeUplink = uplink.subscribe((event) => this.onUplinkEvent(event));
  }

  get state(): RealtimeTransportState {
    return this.currentState;
  }

  getSessionHandle(): string | null {
    return this.uplink.getSessionHandle();
  }

  takeAgentMissionSession(): import('@bob/api-client').RealtimeAgentMissionSession | null {
    return this.uplink.takeAgentMissionSession();
  }

  subscribe(listener: (event: RealtimeTransportEvent) => void): () => void {
    this.listeners.add(listener);
    this.safeNotify(listener, { type: 'state', state: this.currentState });
    return () => this.listeners.delete(listener);
  }

  async connect(input: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.closed) throw new RealtimeTransportError('aborted');
    await this.uplink.connect(input);
    if (this.closed || input.signal?.aborted) {
      await this.uplink.close('aborted');
      throw new RealtimeTransportError('aborted');
    }

    const sessionHandle = this.uplink.getSessionHandle();
    const audioLease = this.uplink.getProcessAudioLease();
    const speechSourcePolicy = this.uplink.getSpeechSourcePolicy();
    if (!sessionHandle || !audioLease || audioLease.mode !== 'realtime' || !speechSourcePolicy) {
      await this.uplink.close('fallback');
      throw new RealtimeTransportError('bootstrap_failed');
    }

    try {
      const playback = this.options.createPlayback({ audioLease, speechSourcePolicy });
      const createIdentifier = this.options.createIdentifier;
      const dependencies: RealtimeAuditedSpeechPlayerDependencies = {
        sessionHandle,
        client: this.options.client,
        playback,
        currentFence: this.options.currentFence,
        createDeliveryId: createIdentifier,
        createCancellationId: createIdentifier,
      };
      const player = this.options.createPlayer?.(dependencies)
        ?? new RealtimeAuditedSpeechPlayerController(dependencies);
      this.player = player;
      this.unsubscribePlayer = player.subscribe((event) => this.onPlayerEvent(event));
      void player.start().catch(() => this.failAuditedDownlink('audited_speech_runtime_failed'));
      // READY signifie désormais uplink + downlink audité composés, jamais le seul peer provider.
      this.emit({ type: 'state', state: this.currentState });
    } catch {
      await this.uplink.close('fallback');
      throw new RealtimeTransportError('bootstrap_failed');
    }
  }

  sendUserText(text: string): boolean {
    return this.uplink.sendUserText(text);
  }

  setMicrophoneEnabled(enabled: boolean): void {
    this.microphoneRequested = enabled;
    if (!enabled || !this.speechActive) this.uplink.setMicrophoneEnabled(enabled);
  }

  async synchronizePublishedContext(fence: RealtimePublishedContextFence): Promise<boolean> {
    const synchronize = this.uplink.synchronizePublishedContext;
    return synchronize === undefined ? true : synchronize.call(this.uplink, fence);
  }

  async finishUserInput(): Promise<boolean> {
    const accepted = await (this.uplink.finishUserInput?.() ?? Promise.resolve(false));
    if (accepted) this.armResponseStartTimeout();
    return accepted;
  }

  interrupt(reason: 'user_speech' | 'tap' | 'navigation'): boolean {
    // Toute interruption annule la reponse attendue. Le watchdog appartient au commit courant,
    // jamais au prochain contexte ni a une utterance annulee.
    this.clearResponseStartTimeout();
    const player = this.player;
    const hadSpeech = this.speechActive;
    if (player) {
      // `interrupt()` stoppe le player natif synchronement avant son premier await.
      void player.interrupt(interruptReason(reason));
      this.speechActive = false;
    }
    const uplinkInterrupted = this.uplink.interrupt(reason);
    return hadSpeech || uplinkInterrupted;
  }

  close(reason: RealtimeCloseReason): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.microphoneRequested = false;
    this.uplink.setMicrophoneEnabled(false);
    const task = this.performClose(reason).finally(() => {
      if (this.closeTask === task) this.closeTask = null;
    });
    this.closeTask = task;
    return task;
  }

  metricsSnapshot(): RealtimeTransportMetrics {
    return this.uplink.metricsSnapshot();
  }

  private async performClose(reason: RealtimeCloseReason): Promise<void> {
    this.clearResponseStartTimeout();
    const player = this.player;
    this.speechActive = false;
    if (player) {
      // Une sortie encore audible interdit de rendre le lease de l'uplink au fallback. Le player
      // reste attaché pour qu'un close explicite puisse retenter la destruction native.
      await player.close();
      if (this.player === player) this.player = null;
    }
    this.unsubscribePlayer?.();
    this.unsubscribePlayer = null;
    this.unsubscribeUplink();
    await this.uplink.close(reason);
  }

  private onUplinkEvent(event: RealtimeTransportEvent): void {
    if (this.closed) return;
    if (event.type === 'user_input_committed') {
      // Signal autoritatif commun au VAD automatique et au commit manuel. Le runtime ne
      // l'emet qu'apres l'envoi local de turn.commit.
      this.armResponseStartTimeout();
    }
    if (event.type === 'bob_transcript' || event.type === 'agent_control_candidate') {
      this.reportProviderDownlinkDrift();
      return;
    }
    if (event.type === 'state') {
      if (event.state.phase === 'bob_speaking') {
        this.reportProviderDownlinkDrift();
        return;
      }
      if (event.state.phase === 'user_speaking' && this.speechActive) {
        // Barge-in local avant toute notification UI ou annulation réseau.
        void this.player?.interrupt('barge_in');
        this.speechActive = false;
      }
      this.currentState = event.state;
      if (event.state.phase === 'ready' && this.player === null) return;
    }
    this.emit(event);
  }

  private onPlayerEvent(event: RealtimeAuditedSpeechPlayerEvent): void {
    if (this.closed) return;
    if (event.type === 'speech_started') {
      this.clearResponseStartTimeout();
      this.speechActive = true;
      // La sortie acoustique auditée possède alors le lease : aucune capture concurrente.
      this.uplink.setMicrophoneEnabled(false);
      this.currentState = { ...this.currentState, phase: 'bob_speaking' };
      this.emit({ type: 'state', state: this.currentState });
      return;
    }
    if (event.type === 'speech_completed') {
      this.clearResponseStartTimeout();
      this.speechActive = false;
      if (this.uplink.completesConversationAfterAuditedSpeech === true) {
        // Le player émet immédiatement ensuite l'éventuel control_candidate. La clôture part
        // donc en microtâche : le contrôleur voit d'abord le candidat, attend son ACK durable,
        // puis ferme la mission sans perdre navigation/proposition.
        this.currentState = { ...this.currentState, phase: 'closing' };
        this.emit({ type: 'state', state: this.currentState });
        queueMicrotask(() => {
          if (!this.closed) this.emit({ type: 'conversation_completed' });
        });
        return;
      }
      this.currentState = { ...this.currentState, phase: 'ready' };
      this.emit({ type: 'state', state: this.currentState });
      if (this.microphoneRequested) this.uplink.setMicrophoneEnabled(true);
      return;
    }
    if (event.type === 'control_candidate') {
      this.emit({ type: 'agent_control_candidate', reference: event.reference });
      return;
    }
    this.failAuditedDownlink(`audited_speech_${event.code}`);
  }

  private reportProviderDownlinkDrift(): void {
    if (this.driftReported) return;
    this.driftReported = true;
    this.emit({ type: 'error', code: 'provider_downlink_rejected' });
    this.emit({ type: 'fallback', reason: 'provider_error' });
  }

  private failAuditedDownlink(code: string): void {
    if (this.closed || this.auditedFailureReported) return;
    this.auditedFailureReported = true;
    this.clearResponseStartTimeout();
    this.uplink.setMicrophoneEnabled(false);
    this.emit({ type: 'error', code });
    this.emit({ type: 'fallback', reason: 'provider_error' });
  }

  private armResponseStartTimeout(): void {
    // finishUserInput() et l'evenement autoritatif peuvent arriver dans la meme pile. Garder
    // l'echeance initiale evite un second timer et interdit de rallonger silencieusement le SLO.
    if (this.closed || this.auditedFailureReported || this.responseStartTimer !== null) return;
    const configured = this.options.responseStartTimeoutMs ?? DEFAULT_RESPONSE_START_TIMEOUT_MS;
    const timeoutMs = Number.isInteger(configured)
      ? Math.min(MAX_RESPONSE_START_TIMEOUT_MS, Math.max(MIN_RESPONSE_START_TIMEOUT_MS, configured))
      : DEFAULT_RESPONSE_START_TIMEOUT_MS;
    this.responseStartTimer = setTimeout(() => {
      this.responseStartTimer = null;
      this.failAuditedDownlink('audited_speech_response_timeout');
    }, timeoutMs);
  }

  private clearResponseStartTimeout(): void {
    if (this.responseStartTimer) clearTimeout(this.responseStartTimer);
    this.responseStartTimer = null;
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
      // Une vue ne peut pas casser l'autorité audio.
    }
  }
}
