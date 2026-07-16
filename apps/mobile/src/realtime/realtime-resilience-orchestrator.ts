import {
  classifyRealtimeFailure,
  isRealtimeFallbackReason,
  legacyFallbackChannelFor,
  type LegacyFallbackChannel,
} from './realtime-recovery-policy';
import {
  RealtimeTransportError,
  type RealtimeCloseReason,
  type RealtimeFallbackReason,
  type RealtimeTransportEvent,
  type VoiceConversationTransport,
} from './realtime-transport';

const MAX_RECONNECT_ATTEMPTS = 1;
const DEFAULT_RECONNECT_DELAY_MS = 350;
const DEFAULT_DISCONNECTED_GRACE_MS = 1_500;
const MAX_SCHEDULED_DELAY_MS = 5_000;

export type RealtimeResiliencePhase =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'disconnected_grace'
  | 'reconnect_wait'
  | 'reconnecting'
  | 'falling_back'
  | 'legacy'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface RealtimeResilienceState {
  readonly phase: RealtimeResiliencePhase;
  readonly sessionGeneration: number;
  readonly reconnectAttempts: number;
  readonly lastFailureReason: RealtimeFallbackReason | null;
  readonly fallbackChannel: LegacyFallbackChannel | null;
}

export type RealtimeResilienceEvent =
  | { readonly type: 'state'; readonly state: RealtimeResilienceState }
  | { readonly type: 'transport'; readonly event: RealtimeTransportEvent };

export interface LegacyVoiceFallbackSession {
  /** Ferme uniquement la session retournée par `start`, jamais une génération suivante. */
  close(reason: RealtimeCloseReason): Promise<void>;
}

export interface LegacyVoiceFallbackPort {
  /**
   * Le port choisit son implémentation historique (ASR/TTS ou composer local), mais ne démarre
   * qu'après fermeture confirmée du transport primaire. Il ne doit jamais lancer un second cerveau.
   */
  start(input: {
    readonly reason: RealtimeFallbackReason;
    readonly channel: LegacyFallbackChannel;
  }): Promise<LegacyVoiceFallbackSession>;
}

export interface RealtimeReconnectDelayInput {
  readonly attempt: 1;
  readonly reason: RealtimeFallbackReason;
  readonly baseDelayMs: number;
}

export interface RealtimeResilienceOptions {
  /** Fabrique une instance fraîche : une reconnexion ne réutilise jamais un peer dégradé. */
  readonly createPrimary: () => VoiceConversationTransport;
  readonly legacyFallback: LegacyVoiceFallbackPort;
  /** Jitter injectable et déterministe en test. La valeur est bornée avant usage. */
  readonly reconnectDelayMs?: (input: RealtimeReconnectDelayInput) => number;
  readonly disconnectedGraceMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface PrimaryAttempt {
  readonly transport: VoiceConversationTransport;
  unsubscribe: (() => void) | null;
  ready: boolean;
  connectivity: 'connected' | 'disconnected' | null;
  closed: boolean;
  closeTask: Promise<boolean> | null;
}

type ConnectAttemptResult =
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly reason: RealtimeFallbackReason }
  | { readonly kind: 'stale' };

const INITIAL_STATE: RealtimeResilienceState = Object.freeze({
  phase: 'idle',
  sessionGeneration: 0,
  reconnectAttempts: 0,
  lastFailureReason: null,
  fallbackChannel: null,
});

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultReconnectDelay(input: RealtimeReconnectDelayInput): number {
  // ±20 %, suffisant pour éviter un troupeau de peers sans rendre le repli perceptiblement lent.
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(input.baseDelayMs * factor);
}

function boundedDelay(value: number, fallback: number): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.min(MAX_SCHEDULED_DELAY_MS, Math.max(0, Math.round(finite)));
}

function failureReason(error: unknown): RealtimeFallbackReason {
  if (error instanceof RealtimeTransportError) return error.reason;
  if (
    error !== null
    && typeof error === 'object'
    && 'reason' in error
    && isRealtimeFallbackReason((error as { readonly reason?: unknown }).reason)
  ) {
    return (error as { readonly reason: RealtimeFallbackReason }).reason;
  }
  return 'bootstrap_failed';
}

/**
 * Autorité de cycle de vie d'une mission Bob Live.
 *
 * Invariant principal : un seul moteur peut produire/écouter à la fois. Avant toute activation
 * legacy, le peer primaire est désabonné puis fermé. Les générations empêchent une continuation
 * async ancienne de reconnecter ou de démarrer le fallback après stop/background.
 */
export class RealtimeResilienceOrchestrator {
  private currentState: RealtimeResilienceState = INITIAL_STATE;
  private readonly listeners = new Set<(event: RealtimeResilienceEvent) => void>();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly reconnectDelay: (input: RealtimeReconnectDelayInput) => number;
  private readonly disconnectedGraceMs: number;
  private sessionGeneration = 0;
  private reconnectAttempts = 0;
  private primary: PrimaryAttempt | null = null;
  private fallbackSession: LegacyVoiceFallbackSession | null = null;
  private fallbackActivationTask: Promise<void> | null = null;
  private startTask: Promise<RealtimeResilienceState> | null = null;
  private stopTask: Promise<void> | null = null;
  private recoveryTask: Promise<void> | null = null;
  private disconnectTask: Promise<void> | null = null;
  private connectivityGeneration = 0;
  private abortController: AbortController | null = null;

  constructor(private readonly options: RealtimeResilienceOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.reconnectDelay = options.reconnectDelayMs ?? defaultReconnectDelay;
    this.disconnectedGraceMs = boundedDelay(
      options.disconnectedGraceMs ?? DEFAULT_DISCONNECTED_GRACE_MS,
      DEFAULT_DISCONNECTED_GRACE_MS,
    );
  }

  get state(): RealtimeResilienceState {
    return this.currentState;
  }

  subscribe(listener: (event: RealtimeResilienceEvent) => void): () => void {
    this.listeners.add(listener);
    this.safeNotify(listener, { type: 'state', state: this.currentState });
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<RealtimeResilienceState> {
    if (this.stopTask) await this.stopTask;
    if (
      this.currentState.phase !== 'idle'
      && this.currentState.phase !== 'stopped'
      && this.currentState.phase !== 'failed'
    ) {
      return this.startTask ?? this.currentState;
    }
    if (
      this.currentState.phase === 'failed'
      && (this.primary !== null || this.fallbackSession !== null || this.fallbackActivationTask !== null)
    ) {
      // Une fermeture non confirmée bloque toute nouvelle autorité audio.
      return this.currentState;
    }

    const generation = ++this.sessionGeneration;
    this.recoveryTask = null;
    this.connectivityGeneration += 1;
    this.disconnectTask = null;
    this.reconnectAttempts = 0;
    this.abortController = new AbortController();
    this.transition({
      phase: 'connecting',
      sessionGeneration: generation,
      reconnectAttempts: 0,
      lastFailureReason: null,
      fallbackChannel: null,
    });

    const task = this.runInitialConnection(generation);
    this.startTask = task;
    try {
      return await task;
    } finally {
      if (this.startTask === task) this.startTask = null;
    }
  }

  /**
   * Signale un état WebRTC `disconnected` encore récupérable. Le peer reste seul propriétaire
   * de l'audio durant la grâce ; un retour `connected` annule logiquement toute reconnexion.
   */
  notifyDisconnected(reason: RealtimeFallbackReason = 'ice_failed'): Promise<void> {
    if (this.currentState.phase !== 'ready' || !this.primary?.ready) return Promise.resolve();
    if (this.disconnectTask) return this.disconnectTask;
    const generation = this.sessionGeneration;
    const connectivity = ++this.connectivityGeneration;
    // La continuation part en microtâche afin que son identité soit publiée avant tout callback
    // réentrant d'un observateur d'état. Un `notifyConnected()` immédiat peut ainsi l'annuler sans
    // qu'elle écrase ensuite la prochaine vraie déconnexion.
    const task = Promise.resolve().then(async (): Promise<void> => {
      await this.wait(this.disconnectedGraceMs);
      if (
        !this.isCurrent(generation)
        || connectivity !== this.connectivityGeneration
        || this.currentState.phase !== 'disconnected_grace'
      ) return;
      await this.scheduleRecovery(reason, generation);
    });
    this.disconnectTask = task;
    this.transition({
      ...this.currentState,
      phase: 'disconnected_grace',
      lastFailureReason: reason,
    });
    void task.then(
      () => { if (this.disconnectTask === task) this.disconnectTask = null; },
      () => { if (this.disconnectTask === task) this.disconnectTask = null; },
    );
    return task;
  }

  notifyConnected(): void {
    if (this.currentState.phase !== 'disconnected_grace') return;
    this.connectivityGeneration += 1;
    this.disconnectTask = null;
    this.transition({ ...this.currentState, phase: 'ready', lastFailureReason: null });
  }

  async stop(reason: RealtimeCloseReason = 'user'): Promise<void> {
    if (this.stopTask) return this.stopTask;
    // Publier le verrou avant d'entrer dans la fermeture protège aussi contre un observateur
    // réentrant qui redemanderait stop/start pendant une transition d'état.
    let resolveTask!: () => void;
    let rejectTask!: (error: unknown) => void;
    const task = new Promise<void>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    this.stopTask = task;
    void this.performStop(reason).then(resolveTask, rejectTask);
    try {
      await task;
    } finally {
      if (this.stopTask === task) this.stopTask = null;
    }
  }

  private async performStop(reason: RealtimeCloseReason): Promise<void> {
    const generation = ++this.sessionGeneration;
    this.connectivityGeneration += 1;
    this.disconnectTask = null;
    // La continuation ancienne reste fencée par génération, mais ne doit pas empêcher une
    // future mission explicite de posséder son propre cycle de récupération.
    this.recoveryTask = null;
    this.abortController?.abort();
    this.abortController = null;
    this.transition({
      ...this.currentState,
      phase: 'stopping',
      sessionGeneration: generation,
    });

    const primary = this.primary;
    let fullyClosed = primary ? await this.disposePrimary(primary, reason) : true;

    // Une activation legacy déjà lancée doit rendre son lease puis le fermer avant qu'une
    // nouvelle mission puisse démarrer. Cela interdit tout chevauchement de TTS/cerveau.
    if (this.fallbackActivationTask) {
      await this.fallbackActivationTask.catch(() => undefined);
    }
    const fallback = this.fallbackSession;
    if (fallback) {
      const fallbackClosed = await Promise.resolve()
        .then(() => fallback.close(reason))
        .then(() => true, () => false);
      fullyClosed = fullyClosed && fallbackClosed;
      if (fallbackClosed && this.fallbackSession === fallback) this.fallbackSession = null;
    }

    if (generation !== this.sessionGeneration) return;
    if (!fullyClosed) {
      this.transition({
        phase: 'failed',
        sessionGeneration: generation,
        reconnectAttempts: this.reconnectAttempts,
        lastFailureReason: this.currentState.lastFailureReason ?? 'provider_error',
        fallbackChannel: this.currentState.fallbackChannel,
      });
      return;
    }
    this.reconnectAttempts = 0;
    this.transition({
      phase: 'stopped',
      sessionGeneration: generation,
      reconnectAttempts: 0,
      lastFailureReason: null,
      fallbackChannel: null,
    });
  }

  private async runInitialConnection(generation: number): Promise<RealtimeResilienceState> {
    const result = await this.connectPrimary(generation);
    if (result.kind === 'failed' && this.isCurrent(generation)) {
      await this.recoverOrFallback(result.reason, generation);
    }
    return this.currentState;
  }

  private async connectPrimary(generation: number): Promise<ConnectAttemptResult> {
    if (!this.isCurrent(generation)) return { kind: 'stale' };
    let transport: VoiceConversationTransport;
    try {
      transport = this.options.createPrimary();
    } catch (error) {
      return { kind: 'failed', reason: failureReason(error) };
    }

    const attempt: PrimaryAttempt = {
      transport,
      unsubscribe: null,
      ready: false,
      connectivity: null,
      closed: false,
      closeTask: null,
    };
    this.primary = attempt;
    try {
      const unsubscribe = transport.subscribe((event) => {
        const observedEvent: RealtimeTransportEvent = event.type === 'metrics'
          ? {
              type: 'metrics',
              metrics: { ...event.metrics, reconnectCount: this.reconnectAttempts },
            }
          : event;
        this.emit({ type: 'transport', event: observedEvent });
        if (event.type === 'connectivity') attempt.connectivity = event.state;
        if (!attempt.ready || attempt.closed || this.primary !== attempt) return;
        if (event.type === 'fallback') {
          void this.scheduleRecovery(event.reason, generation);
        } else if (event.type === 'connectivity' && event.state === 'disconnected') {
          void this.notifyDisconnected('ice_failed');
        } else if (event.type === 'connectivity' && event.state === 'connected') {
          this.notifyConnected();
        } else if (event.type === 'error' && event.code === 'data_channel_error') {
          void this.scheduleRecovery('provider_error', generation);
        } else if (event.type === 'error' && event.code === 'session_max_duration') {
          void this.stop('max_duration');
        }
      });
      attempt.unsubscribe = unsubscribe;
      if (!this.isCurrent(generation) || this.primary !== attempt || attempt.closed) {
        this.unsubscribePrimary(attempt);
        await this.disposePrimary(attempt, 'aborted');
        return { kind: 'stale' };
      }
    } catch {
      await this.disposePrimary(attempt, 'fallback');
      return { kind: 'failed', reason: 'bootstrap_failed' };
    }

    try {
      await transport.connect({ signal: this.abortController?.signal });
      if (!this.isCurrent(generation) || this.primary !== attempt) {
        await this.disposePrimary(attempt, 'aborted');
        return { kind: 'stale' };
      }
      attempt.ready = true;
      this.transition({
        phase: 'ready',
        sessionGeneration: generation,
        reconnectAttempts: this.reconnectAttempts,
        lastFailureReason: null,
        fallbackChannel: null,
      });
      if (attempt.connectivity === 'disconnected') {
        void this.notifyDisconnected('ice_failed');
      }
      return { kind: 'ready' };
    } catch (error) {
      const reason = failureReason(error);
      await this.disposePrimary(attempt, reason === 'aborted' ? 'aborted' : 'fallback');
      return this.isCurrent(generation)
        ? { kind: 'failed', reason }
        : { kind: 'stale' };
    }
  }

  private scheduleRecovery(reason: RealtimeFallbackReason, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return Promise.resolve();
    if (this.recoveryTask) {
      const nextPrimary = this.primary;
      if (
        (this.currentState.phase !== 'ready' && this.currentState.phase !== 'disconnected_grace')
        || !nextPrimary?.ready
      ) return this.recoveryTask;
      // Le peer reconnecté peut échouer dans la micro-fenêtre où la première récupération a
      // déjà publié `ready` mais n'a pas encore exécuté son `finally`. On chaîne ce NOUVEL
      // incident ; les doublons du peer précédent sont ignorés car celui-ci n'est plus `ready`.
      const previous = this.recoveryTask;
      const chained = previous.then(async () => {
        if (
          !this.isCurrent(generation)
          || this.primary !== nextPrimary
          || !nextPrimary.ready
          || (
            this.currentState.phase !== 'ready'
            && this.currentState.phase !== 'disconnected_grace'
          )
        ) return;
        await this.recoverOrFallback(reason, generation);
      });
      this.recoveryTask = chained;
      void chained.then(
        () => { if (this.recoveryTask === chained) this.recoveryTask = null; },
        () => { if (this.recoveryTask === chained) this.recoveryTask = null; },
      );
      return chained;
    }
    this.connectivityGeneration += 1;
    this.disconnectTask = null;
    const task = this.recoverOrFallback(reason, generation);
    this.recoveryTask = task;
    void task.then(
      () => { if (this.recoveryTask === task) this.recoveryTask = null; },
      () => { if (this.recoveryTask === task) this.recoveryTask = null; },
    );
    return task;
  }

  private async recoverOrFallback(
    initialReason: RealtimeFallbackReason,
    generation: number,
  ): Promise<void> {
    let reason = initialReason;
    const active = this.primary;
    if (active && !(await this.disposePrimary(active, 'fallback'))) {
      this.failClosed(reason, generation);
      return;
    }
    if (!this.isCurrent(generation)) return;

    if (
      classifyRealtimeFailure(reason) === 'transient'
      && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    ) {
      this.reconnectAttempts += 1;
      let requestedDelay = DEFAULT_RECONNECT_DELAY_MS;
      try {
        requestedDelay = this.reconnectDelay({
          attempt: 1,
          reason,
          baseDelayMs: DEFAULT_RECONNECT_DELAY_MS,
        });
      } catch {
        // Une stratégie de jitter optionnelle ne doit jamais casser le chemin de secours.
      }
      const delay = boundedDelay(requestedDelay, DEFAULT_RECONNECT_DELAY_MS);
      this.transition({
        phase: 'reconnect_wait',
        sessionGeneration: generation,
        reconnectAttempts: this.reconnectAttempts,
        lastFailureReason: reason,
        fallbackChannel: null,
      });
      await this.wait(delay);
      if (!this.isCurrent(generation)) return;
      this.transition({ ...this.currentState, phase: 'reconnecting' });
      const result = await this.connectPrimary(generation);
      if (result.kind === 'ready' || result.kind === 'stale') return;
      reason = result.reason;
    }

    if (!this.isCurrent(generation)) return;
    await this.activateFallback(reason, generation);
  }

  private async activateFallback(
    reason: RealtimeFallbackReason,
    generation: number,
  ): Promise<void> {
    const channel = legacyFallbackChannelFor(reason);
    if (channel === null) {
      this.transition({
        phase: 'stopped',
        sessionGeneration: generation,
        reconnectAttempts: this.reconnectAttempts,
        lastFailureReason: reason,
        fallbackChannel: null,
      });
      return;
    }
    if (this.primary !== null) {
      // Invariant défensif : le fallback ne prend jamais le son si un peer reste propriétaire.
      this.failClosed(reason, generation);
      return;
    }

    this.transition({
      phase: 'falling_back',
      sessionGeneration: generation,
      reconnectAttempts: this.reconnectAttempts,
      lastFailureReason: reason,
      fallbackChannel: channel,
    });
    if (!this.isCurrent(generation)) return;
    // Le démarrage externe est différé d'une microtâche : `fallbackActivationTask` devient donc
    // visible avant que le port legacy puisse provoquer un stop/background réentrant.
    const task = Promise.resolve().then(async (): Promise<void> => {
      if (!this.isCurrent(generation)) return;
      try {
        const session = await this.options.legacyFallback.start({ reason, channel });
        if (!this.isCurrent(generation)) {
          const closed = await Promise.resolve()
            .then(() => session.close('aborted'))
            .then(() => true, () => false);
          if (!closed) this.fallbackSession = session;
          return;
        }
        this.fallbackSession = session;
        this.transition({
          phase: 'legacy',
          sessionGeneration: generation,
          reconnectAttempts: this.reconnectAttempts,
          lastFailureReason: reason,
          fallbackChannel: channel,
        });
      } catch {
        this.failClosed(reason, generation);
      }
    });
    this.fallbackActivationTask = task;
    try {
      await task;
    } finally {
      if (this.fallbackActivationTask === task) this.fallbackActivationTask = null;
    }
  }

  private failClosed(reason: RealtimeFallbackReason, generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.transition({
      phase: 'failed',
      sessionGeneration: generation,
      reconnectAttempts: this.reconnectAttempts,
      lastFailureReason: reason,
      fallbackChannel: null,
    });
  }

  private async disposePrimary(
    attempt: PrimaryAttempt,
    reason: RealtimeCloseReason,
  ): Promise<boolean> {
    if (attempt.closed) return true;
    if (attempt.closeTask) return attempt.closeTask;
    attempt.ready = false;
    this.unsubscribePrimary(attempt);
    const task = Promise.resolve().then(() => attempt.transport.close(reason)).then(
      () => {
        attempt.closed = true;
        if (this.primary === attempt) this.primary = null;
        return true;
      },
      () => false,
    );
    attempt.closeTask = task;
    return task;
  }

  private unsubscribePrimary(attempt: PrimaryAttempt): void {
    const unsubscribe = attempt.unsubscribe;
    attempt.unsubscribe = null;
    try { unsubscribe?.(); } catch { /* observateur déjà détruit */ }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.sessionGeneration
      && this.currentState.phase !== 'stopping'
      && this.currentState.phase !== 'stopped';
  }

  private async wait(milliseconds: number): Promise<void> {
    try {
      await this.sleep(milliseconds);
    } catch {
      // Un scheduler injecté défaillant ne peut ni relancer en boucle ni bloquer la fermeture.
    }
  }

  private transition(state: RealtimeResilienceState): void {
    this.currentState = Object.freeze({ ...state });
    this.emit({ type: 'state', state: this.currentState });
  }

  private emit(event: RealtimeResilienceEvent): void {
    for (const listener of this.listeners) this.safeNotify(listener, event);
  }

  private safeNotify(
    listener: (event: RealtimeResilienceEvent) => void,
    event: RealtimeResilienceEvent,
  ): void {
    try {
      listener(event);
    } catch {
      // Un observateur UI/metrics ne doit jamais casser l'autorité audio ou la fermeture.
    }
  }
}
