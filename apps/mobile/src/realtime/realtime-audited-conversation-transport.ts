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
  type RealtimeTurnSettlementStatus,
  type RealtimeClientDiagnosticUpdate,
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
const MAX_TURNS_PER_SESSION = 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  private readonly pendingTurns = new Set<string>();
  private readonly settledTurns = new Map<string, RealtimeTurnSettlementStatus>();
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

  reportClientDiagnostic(update: RealtimeClientDiagnosticUpdate): void {
    this.uplink.reportClientDiagnostic?.(update);
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
      this.reportClientDiagnostic({
        type: 'failure',
        failureCode: 'audited_downlink_binding_rejected',
      });
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
      this.reportClientDiagnostic({ type: 'checkpoint', checkpoint: 'audited_player_created' });
      void player.start().catch(() => {
        this.reportClientDiagnostic({
          type: 'failure',
          failureCode: 'audited_player_runtime_failed',
        });
        this.failAuditedDownlink('audited_speech_runtime_failed');
      });
      // READY signifie désormais uplink + downlink audité composés, jamais le seul peer provider.
      this.emit({ type: 'state', state: this.currentState });
    } catch {
      this.reportClientDiagnostic({
        type: 'failure',
        failureCode: 'audited_player_creation_failed',
      });
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
    const player = this.player;
    const hadSpeech = this.speechActive;
    if (player) {
      // `interrupt()` stoppe le player natif synchronement avant son premier await.
      void player.interrupt(interruptReason(reason));
      this.speechActive = false;
    }
    const uplinkInterrupted = this.uplink.interrupt(reason);
    // Un geste n'est pas une preuve d'annulation. Tant que ni une parole effectivement active ni
    // l'uplink n'a acquis l'interruption, le tour reste dû et son watchdog doit produire le
    // terminal borné. Sinon un tap à vide peut orpheliner définitivement la mission.
    if (hadSpeech || uplinkInterrupted) this.clearResponseStartTimeout();
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
      if (!this.registerCommittedTurn(event.turnId)) return;
      this.armResponseStartTimeout();
    }
    if (
      event.type === 'bob_transcript'
      || event.type === 'agent_control_candidate'
      || event.type === 'turn_settled'
    ) {
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
    if (event.type === 'turn_terminal') {
      this.clearResponseStartTimeout();
      if (!this.publishTurnSettlement(event.turnId, event.status)) {
        this.failAuditedDownlink('audited_speech_turn_terminal_conflict');
      }
      return;
    }
    // Le player de production transforme ses exceptions en événement fermé puis résout start().
    // Cette branche — et non le seul catch de start() — porte donc la panne native réelle.
    this.reportClientDiagnostic({
      type: 'failure',
      failureCode: 'audited_player_runtime_failed',
    });
    this.failAuditedDownlink(`audited_speech_${event.code}`);
  }

  private reportProviderDownlinkDrift(): void {
    if (this.driftReported) return;
    this.driftReported = true;
    this.reportClientDiagnostic({
      type: 'failure',
      failureCode: 'provider_connection_failed',
    });
    this.settlePendingTurns('failed');
    this.emit({ type: 'error', code: 'provider_downlink_rejected' });
    this.emit({ type: 'fallback', reason: 'provider_error' });
  }

  private failAuditedDownlink(code: string): void {
    if (this.closed || this.auditedFailureReported) return;
    this.auditedFailureReported = true;
    // Les erreurs player spécifiques gagnent avant cet appel. Pour les timeouts, conflits de
    // terminal et commits invalides, ce code fermé conserve au moins la frontière auditée exacte.
    this.reportClientDiagnostic({
      type: 'failure',
      failureCode: 'audited_pipeline_failed',
    });
    this.clearResponseStartTimeout();
    this.uplink.setMicrophoneEnabled(false);
    this.settlePendingTurns('failed');
    this.emit({ type: 'error', code });
    this.emit({ type: 'fallback', reason: 'provider_error' });
  }

  private registerCommittedTurn(turnId: string): boolean {
    if (
      !UUID_PATTERN.test(turnId)
      || this.settledTurns.has(turnId)
      || (
        !this.pendingTurns.has(turnId)
        && this.pendingTurns.size + this.settledTurns.size >= MAX_TURNS_PER_SESSION
      )
    ) {
      this.failAuditedDownlink('audited_speech_input_commit_invalid');
      return false;
    }
    if (this.pendingTurns.has(turnId)) return false;
    this.pendingTurns.add(turnId);
    return true;
  }

  private publishTurnSettlement(
    turnId: string,
    status: RealtimeTurnSettlementStatus,
  ): boolean {
    if (!UUID_PATTERN.test(turnId)) return false;
    const previous = this.settledTurns.get(turnId);
    if (previous !== undefined) return previous === status;
    if (!this.pendingTurns.has(turnId) || this.settledTurns.size >= MAX_TURNS_PER_SESSION) {
      return false;
    }
    this.pendingTurns.delete(turnId);
    this.settledTurns.set(turnId, status);
    this.emit({ type: 'turn_settled', turnId, status });
    return true;
  }

  private settlePendingTurns(status: RealtimeTurnSettlementStatus): void {
    for (const turnId of [...this.pendingTurns]) {
      if (!this.publishTurnSettlement(turnId, status)) {
        this.emit({ type: 'error', code: 'audited_speech_turn_terminal_conflict' });
      }
    }
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
