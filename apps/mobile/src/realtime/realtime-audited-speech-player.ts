import type {
  BobClient,
  RealtimeVoiceControlReference,
  RealtimeVoiceSpeechCancellationReason,
  RealtimeVoiceSpeechDeliveryAcknowledgement,
  RealtimeVoiceSpeechFeed,
  RealtimeVoiceSpeechMimeType,
} from '@bob/api-client';
import type { RealtimePublishedContextFence } from './realtime-control-gate';
import type { RealtimeTurnSettlementStatus } from './realtime-transport';

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_TURNS_PER_SESSION = 60;
const DEFAULT_LONG_POLL_MS = 2_500;
const DEFAULT_IDLE_DELAY_MS = 75;
const DEFAULT_MAX_FEED_ERRORS = 3;
const DEFAULT_MAX_MUTATION_ATTEMPTS = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const AUDIO_MIME_TYPES = new Set<RealtimeVoiceSpeechMimeType>([
  'audio/mpeg',
  'audio/wav',
]);

type SpeechClient = Pick<
  BobClient,
  | 'getNextRealtimeVoiceSpeech'
  | 'acknowledgeRealtimeVoiceSpeechDelivery'
  | 'cancelRealtimeVoiceSpeech'
>;

type BoundSpeechFeed = Exclude<RealtimeVoiceSpeechFeed, { status: 'none' }>;
type ReadySpeechFeed = Extract<RealtimeVoiceSpeechFeed, { status: 'ready' }>;

export interface RealtimeVerifiedSpeechAudio {
  /** Handle opaque propre à l'adaptateur. Il ne doit jamais être propagé dans un événement. */
  readonly opaqueHandle: unknown;
  readonly sha256: string;
  readonly mimeType: RealtimeVoiceSpeechMimeType;
  readonly byteSize: number;
}

export interface RealtimeSpeechDownloadRequest {
  /** URL éphémère et confidentielle : l'implémentation ne doit jamais la journaliser. */
  readonly sourceUrl: string;
  readonly expectedSha256: string;
  readonly expectedMimeType: RealtimeVoiceSpeechMimeType;
  readonly expectedByteSize: number;
  /** L'adaptateur doit interrompre le flux avant de dépasser cette limite. */
  readonly maximumBytes: number;
  /** Liaison exacte avec le feed durable : l'URL ne choisit jamais elle-même son artefact. */
  readonly expectedTurnId: string;
  readonly expectedArtifactId: string;
}

/**
 * Frontière native de lecture des artefacts acoustiques audités.
 *
 * `downloadVerified` doit borner le flux, refuser les redirections/protocoles non autorisés,
 * vérifier SHA-256, MIME/signature et taille avant de produire le handle opaque. `play` doit
 * honorer physiquement l'AbortSignal. `stopImmediately` est volontairement synchrone : le
 * barge-in ne dépend jamais d'un aller-retour JS, réseau ou serveur.
 */
export interface RealtimeAuditedSpeechPlaybackPort {
  downloadVerified(
    request: RealtimeSpeechDownloadRequest,
    signal: AbortSignal,
  ): Promise<RealtimeVerifiedSpeechAudio>;
  play(audio: RealtimeVerifiedSpeechAudio, signal: AbortSignal): Promise<void>;
  stopImmediately(): void;
  release(audio: RealtimeVerifiedSpeechAudio): void;
}

export class RealtimeAuditedSpeechStopError extends Error {
  readonly code = 'playback_stop_unconfirmed' as const;

  constructor() {
    super('playback_stop_unconfirmed');
    this.name = 'RealtimeAuditedSpeechStopError';
  }
}

export type RealtimeAuditedSpeechErrorCode =
  | 'invalid_session'
  | 'feed_unavailable'
  | 'sequence_violation'
  | 'artifact_binding_violation'
  | 'context_stale'
  | 'download_failed'
  | 'playback_failed'
  | 'playback_contract_violation'
  | 'delivery_failed'
  | 'cancellation_failed'
  | 'identifier_generation_failed'
  | 'control_reference_invalid'
  | 'turn_terminal_conflict'
  | 'internal_failure';

export type RealtimeAuditedSpeechPlayerEvent =
  | { readonly type: 'speech_started'; readonly sequence: number; readonly atMs: number }
  | { readonly type: 'speech_completed'; readonly sequence: number; readonly atMs: number }
  | {
    readonly type: 'control_candidate';
    readonly reference: RealtimeVoiceControlReference;
    readonly atMs: number;
  }
  | {
    /**
     * Terminal autoritatif du tour acoustique. Il provient exclusivement d'un ACK durable,
     * d'une annulation durable ou du feed serveur terminal — jamais d'un transcript/état UI.
     */
    readonly type: 'turn_terminal';
    readonly turnId: string;
    readonly status: RealtimeTurnSettlementStatus;
    readonly atMs: number;
  }
  | { readonly type: 'error'; readonly code: RealtimeAuditedSpeechErrorCode; readonly atMs: number };

export interface RealtimeAuditedSpeechMetrics {
  readonly firstPollStartedAtMs: number | null;
  readonly lastArtifactReadyAtMs: number | null;
  readonly lastPlaybackStartedAtMs: number | null;
  readonly lastPlaybackCompletedAtMs: number | null;
  readonly lastDeliveryAcknowledgedAtMs: number | null;
  readonly lastInterruptedAtMs: number | null;
  readonly completedSegments: number;
  readonly errorCount: number;
  readonly cursor: number;
}

export type RealtimeAuditedSpeechInterruptReason = Extract<
  RealtimeVoiceSpeechCancellationReason,
  'barge_in' | 'user_cancel' | 'context_changed' | 'superseded'
>;

export interface RealtimeAuditedSpeechPlayerDependencies {
  readonly sessionHandle: string;
  readonly client: SpeechClient;
  readonly playback: RealtimeAuditedSpeechPlaybackPort;
  readonly currentFence: () => RealtimePublishedContextFence | null;
  readonly createDeliveryId: () => string;
  readonly createCancellationId: () => string;
  readonly now?: () => number;
  readonly pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly longPollMs?: number;
  readonly idleDelayMs?: number;
  readonly maxConsecutiveFeedErrors?: number;
  readonly maxMutationAttempts?: number;
}

interface ArtifactBinding {
  readonly artifactId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

interface ActiveArtifact extends ArtifactBinding {
  ready: ReadySpeechFeed | null;
  operationStarted: boolean;
  cancelled: boolean;
  cancellationId: string | null;
  cancellationReason: RealtimeVoiceSpeechCancellationReason | null;
  cancellationPromise: Promise<void> | null;
  rejectionReported: boolean;
  settled: boolean;
}

function defaultNow(): number {
  return Date.now();
}

function defaultPause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value > 0;
}

function bindingOf(value: BoundSpeechFeed): ArtifactBinding {
  return {
    artifactId: value.artifactId,
    turnId: value.turnId,
    sequence: value.sequence,
    contextRevision: value.contextRevision,
    contextDigest: value.contextDigest,
  };
}

function isValidBinding(value: ArtifactBinding): boolean {
  return UUID_PATTERN.test(value.artifactId)
    && UUID_PATTERN.test(value.turnId)
    && isPositiveInteger(value.sequence)
    && value.sequence <= 2_147_483_647
    && isPositiveInteger(value.contextRevision)
    && value.contextRevision <= 2_147_483_647
    && SHA_256_PATTERN.test(value.contextDigest);
}

function sameBinding(left: ArtifactBinding, right: ArtifactBinding): boolean {
  return left.artifactId === right.artifactId
    && left.turnId === right.turnId
    && left.sequence === right.sequence
    && left.contextRevision === right.contextRevision
    && left.contextDigest === right.contextDigest;
}

function isValidReadyFeed(value: ReadySpeechFeed): boolean {
  return SHA_256_PATTERN.test(value.audioSha256)
    && AUDIO_MIME_TYPES.has(value.mimeType)
    && isPositiveInteger(value.byteSize)
    && value.byteSize <= MAX_AUDIO_BYTES
    && isPositiveInteger(value.durationMs)
    && value.durationMs <= 45_000
    && typeof value.audioUrl === 'string'
    && value.audioUrl.length > 0;
}

function verifiedAudioMatches(
  audio: RealtimeVerifiedSpeechAudio,
  feed: ReadySpeechFeed,
): boolean {
  return audio.sha256 === feed.audioSha256
    && audio.mimeType === feed.mimeType
    && audio.byteSize === feed.byteSize;
}

function controlMatches(
  value: RealtimeVoiceControlReference,
  artifact: ArtifactBinding,
  deliveryId: string,
): boolean {
  return UUID_PATTERN.test(value.turnId)
    && UUID_PATTERN.test(value.acknowledgementId)
    && value.acknowledgementId === deliveryId
    && value.turnId === artifact.turnId
    && value.contextRevision === artifact.contextRevision
    && value.contextDigest === artifact.contextDigest
    && SHA_256_PATTERN.test(value.contextDigest);
}

/**
 * Séquenceur local du canal acoustique audité.
 *
 * Il n'exécute aucun contrôle métier. Sa seule sortie de contrôle est une référence opaque,
 * après lecture complète, ACK durable et quatrième fence de contexte. Toute course perdue est
 * abandonnée plutôt que rejouée.
 */
export class RealtimeAuditedSpeechPlayerController {
  private readonly listeners = new Set<(event: RealtimeAuditedSpeechPlayerEvent) => void>();
  private readonly now: () => number;
  private readonly pause: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly longPollMs: number;
  private readonly idleDelayMs: number;
  private readonly maxConsecutiveFeedErrors: number;
  private readonly maxMutationAttempts: number;

  private closed = false;
  private halted = false;
  private runGeneration = 0;
  private operationGeneration = 0;
  private runPromise: Promise<void> | null = null;
  private pollAbort: AbortController | null = null;
  private pauseAbort: AbortController | null = null;
  private operationAbort: AbortController | null = null;
  private active: ActiveArtifact | null = null;
  private readonly terminalTurns = new Map<string, RealtimeTurnSettlementStatus>();
  private cursor = 0;
  private consecutiveFeedErrors = 0;
  private metrics: RealtimeAuditedSpeechMetrics = {
    firstPollStartedAtMs: null,
    lastArtifactReadyAtMs: null,
    lastPlaybackStartedAtMs: null,
    lastPlaybackCompletedAtMs: null,
    lastDeliveryAcknowledgedAtMs: null,
    lastInterruptedAtMs: null,
    completedSegments: 0,
    errorCount: 0,
    cursor: 0,
  };

  constructor(private readonly dependencies: RealtimeAuditedSpeechPlayerDependencies) {
    this.now = dependencies.now ?? defaultNow;
    this.pause = dependencies.pause ?? defaultPause;
    this.longPollMs = this.boundedOption(dependencies.longPollMs, DEFAULT_LONG_POLL_MS, 0, 2_500);
    this.idleDelayMs = this.boundedOption(
      dependencies.idleDelayMs,
      DEFAULT_IDLE_DELAY_MS,
      1,
      1_000,
    );
    this.maxConsecutiveFeedErrors = this.boundedOption(
      dependencies.maxConsecutiveFeedErrors,
      DEFAULT_MAX_FEED_ERRORS,
      1,
      10,
    );
    this.maxMutationAttempts = this.boundedOption(
      dependencies.maxMutationAttempts,
      DEFAULT_MAX_MUTATION_ATTEMPTS,
      1,
      3,
    );
  }

  start(): Promise<void> {
    if (this.closed || this.halted) return Promise.resolve();
    if (this.runPromise) return this.runPromise;
    if (!UUID_PATTERN.test(this.dependencies.sessionHandle)) {
      this.halt('invalid_session');
      return Promise.resolve();
    }
    const generation = ++this.runGeneration;
    const promise = this.run(generation)
      .catch(() => {
        if (this.isRunCurrent(generation)) this.halt('internal_failure');
      })
      .finally(() => {
        if (this.runPromise === promise) this.runPromise = null;
      });
    this.runPromise = promise;
    return promise;
  }

  /**
   * Coupe le haut-parleur dans la pile synchrone appelante, puis annule l'artefact une seule fois.
   */
  interrupt(reason: RealtimeAuditedSpeechInterruptReason): Promise<void> {
    const stopped = this.stopLocally();
    if (this.closed || this.halted) return this.requireLocalStop(stopped, Promise.resolve());
    this.metrics = { ...this.metrics, lastInterruptedAtMs: this.now() };
    this.operationGeneration += 1;
    this.operationAbort?.abort();
    this.operationAbort = null;
    const active = this.active;
    if (!active) return this.requireLocalStop(stopped, Promise.resolve());
    active.cancelled = true;
    return this.requireLocalStop(stopped, this.requestCancellation(active, reason));
  }

  /** Fermeture irréversible ; les callbacks tardifs ne peuvent ni rejouer ni émettre. */
  close(): Promise<void> {
    const stopped = this.stopLocally();
    if (this.closed) {
      return this.requireLocalStop(
        stopped,
        this.active?.cancellationPromise ?? Promise.resolve(),
      );
    }
    this.closed = true;
    this.runGeneration += 1;
    this.operationGeneration += 1;
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.pauseAbort?.abort();
    this.pauseAbort = null;
    this.operationAbort?.abort();
    this.operationAbort = null;
    const active = this.active;
    if (!active) return this.requireLocalStop(stopped, Promise.resolve());
    active.cancelled = true;
    return this.requireLocalStop(stopped, this.requestCancellation(active, 'session_end'));
  }

  /** Le passage en arrière-plan suit exactement la clôture irréversible. */
  background(): Promise<void> {
    return this.close();
  }

  subscribe(listener: (event: RealtimeAuditedSpeechPlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  metricsSnapshot(): RealtimeAuditedSpeechMetrics {
    return { ...this.metrics };
  }

  private async run(generation: number): Promise<void> {
    while (this.isRunCurrent(generation)) {
      const published = this.dependencies.currentFence();
      if (!published || published.sessionHandle !== this.dependencies.sessionHandle) {
        await this.pauseWhileCurrent(generation);
        continue;
      }

      const abort = new AbortController();
      this.pollAbort = abort;
      if (this.metrics.firstPollStartedAtMs === null) {
        this.metrics = { ...this.metrics, firstPollStartedAtMs: this.now() };
      }

      let result: Awaited<ReturnType<SpeechClient['getNextRealtimeVoiceSpeech']>>;
      try {
        result = await this.dependencies.client.getNextRealtimeVoiceSpeech(
          this.dependencies.sessionHandle,
          { afterSequence: this.cursor, waitMs: this.longPollMs },
          abort.signal,
        );
      } catch {
        if (!this.isRunCurrent(generation) || abort.signal.aborted) return;
        if (!(await this.onFeedFailure(generation))) return;
        continue;
      } finally {
        if (this.pollAbort === abort) this.pollAbort = null;
      }

      if (!this.isRunCurrent(generation) || abort.signal.aborted) return;
      if (!result.ok) {
        if (!(await this.onFeedFailure(generation))) return;
        continue;
      }
      this.consecutiveFeedErrors = 0;

      const feed = result.value;
      if (feed.status === 'none') {
        await this.pauseWhileCurrent(generation);
        continue;
      }
      if (!(await this.consumeFeed(feed, generation))) return;
    }
  }

  private async consumeFeed(feed: BoundSpeechFeed, generation: number): Promise<boolean> {
    const binding = bindingOf(feed);
    if (!isValidBinding(binding) || binding.sequence !== this.cursor + 1) {
      this.halt('sequence_violation');
      return false;
    }
    if (this.active && !sameBinding(this.active, binding)) {
      this.halt('artifact_binding_violation');
      return false;
    }

    if (feed.status === 'terminal') {
      const activeAlreadySettled = this.active?.settled === true
        && this.terminalTurns.has(binding.turnId);
      if (this.active) this.active.settled = true;
      if (
        !activeAlreadySettled
        && !this.publishTurnTerminal(binding.turnId, this.statusForTerminalFeed(feed.reason))
      ) {
        this.halt('turn_terminal_conflict');
        return false;
      }
      this.cursor = binding.sequence;
      this.active = null;
      this.metrics = { ...this.metrics, cursor: this.cursor };
      return true;
    }

    const active = this.active ?? this.createActive(binding);
    this.active = active;

    if (feed.status === 'rendering') {
      await this.pauseWhileCurrent(generation);
      return this.isRunCurrent(generation);
    }
    if (!isValidReadyFeed(feed)) {
      this.halt('artifact_binding_violation');
      return false;
    }
    if (active.ready && (
      active.ready.audioSha256 !== feed.audioSha256
      || active.ready.mimeType !== feed.mimeType
      || active.ready.byteSize !== feed.byteSize
      || active.ready.durationMs !== feed.durationMs
      || active.ready.audioUrl !== feed.audioUrl
    )) {
      this.halt('artifact_binding_violation');
      return false;
    }
    active.ready = feed;
    this.metrics = { ...this.metrics, lastArtifactReadyAtMs: this.now() };

    if (active.cancelled || active.operationStarted) {
      await this.pauseWhileCurrent(generation);
      return this.isRunCurrent(generation);
    }
    active.operationStarted = true;
    await this.processReady(active, generation);
    return this.isRunCurrent(generation);
  }

  private async processReady(active: ActiveArtifact, runGeneration: number): Promise<void> {
    const ready = active.ready;
    if (!ready) return;
    const operationGeneration = ++this.operationGeneration;
    const abort = new AbortController();
    this.operationAbort = abort;
    let verified: RealtimeVerifiedSpeechAudio | null = null;

    try {
      if (!this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) return;
      if (!this.contextMatches(active)) {
        await this.rejectActive(active, 'context_stale', 'context_changed');
        return;
      }

      try {
        verified = await this.dependencies.playback.downloadVerified(
          {
            sourceUrl: ready.audioUrl,
            expectedSha256: ready.audioSha256,
            expectedMimeType: ready.mimeType,
            expectedByteSize: ready.byteSize,
            maximumBytes: Math.min(ready.byteSize, MAX_AUDIO_BYTES),
            expectedTurnId: active.turnId,
            expectedArtifactId: active.artifactId,
          },
          abort.signal,
        );
      } catch {
        if (!this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) return;
        await this.rejectActive(active, 'download_failed', 'playback_error');
        return;
      }

      if (!this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) return;
      if (!verifiedAudioMatches(verified, ready)) {
        await this.rejectActive(active, 'playback_contract_violation', 'playback_error');
        return;
      }
      if (!this.contextMatches(active)) {
        await this.rejectActive(active, 'context_stale', 'context_changed');
        return;
      }

      const playbackStartedAtMs = this.now();
      this.metrics = { ...this.metrics, lastPlaybackStartedAtMs: playbackStartedAtMs };
      this.emit({ type: 'speech_started', sequence: active.sequence, atMs: playbackStartedAtMs });
      try {
        await this.dependencies.playback.play(verified, abort.signal);
      } catch {
        if (!this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) return;
        await this.rejectActive(active, 'playback_failed', 'playback_error');
        return;
      }

      if (!this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) return;
      const playbackCompletedAtMs = this.now();
      this.metrics = { ...this.metrics, lastPlaybackCompletedAtMs: playbackCompletedAtMs };
      if (!this.contextMatches(active)) {
        await this.rejectActive(active, 'context_stale', 'context_changed');
        return;
      }

      let deliveryId: string;
      try {
        deliveryId = this.dependencies.createDeliveryId();
      } catch {
        await this.rejectActive(active, 'identifier_generation_failed', 'playback_error');
        return;
      }
      if (!UUID_PATTERN.test(deliveryId)) {
        await this.rejectActive(active, 'identifier_generation_failed', 'playback_error');
        return;
      }
      const delivery = await this.acknowledgeDelivery(
        active,
        ready.audioSha256,
        deliveryId,
        abort,
        runGeneration,
        operationGeneration,
      );
      if (!delivery || !this.operationIsCurrent(
        active,
        runGeneration,
        operationGeneration,
        abort,
      )) return;

      const deliveredAtMs = this.now();
      active.settled = true;
      this.cursor = active.sequence;
      this.active = null;
      this.metrics = {
        ...this.metrics,
        lastDeliveryAcknowledgedAtMs: deliveredAtMs,
        cursor: this.cursor,
      };

      if (!this.contextMatches(active)) {
        this.publishTurnTerminal(active.turnId, 'done', deliveredAtMs);
        this.reportError('context_stale');
        return;
      }
      if (
        delivery.controlReference
        && !controlMatches(delivery.controlReference, active, deliveryId)
      ) {
        this.publishTurnTerminal(active.turnId, 'failed', deliveredAtMs);
        this.halt('control_reference_invalid');
        return;
      }

      this.metrics = {
        ...this.metrics,
        completedSegments: this.metrics.completedSegments + 1,
      };
      this.emit({ type: 'speech_completed', sequence: active.sequence, atMs: deliveredAtMs });
      if (delivery.controlReference) {
        this.emit({
          type: 'control_candidate',
          reference: delivery.controlReference,
          atMs: deliveredAtMs,
        });
      }
      if (!this.publishTurnTerminal(active.turnId, 'done', deliveredAtMs)) {
        this.halt('turn_terminal_conflict');
      }
    } finally {
      if (verified) {
        try {
          this.dependencies.playback.release(verified);
        } catch {
          if (this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) {
            this.halt('playback_contract_violation');
          }
        }
      }
      if (this.operationAbort === abort) this.operationAbort = null;
    }
  }

  private async acknowledgeDelivery(
    active: ActiveArtifact,
    audioSha256: string,
    deliveryId: string,
    abort: AbortController,
    runGeneration: number,
    operationGeneration: number,
  ): Promise<RealtimeVoiceSpeechDeliveryAcknowledgement | null> {
    for (let attempt = 1; attempt <= this.maxMutationAttempts; attempt += 1) {
      try {
        const result = await this.dependencies.client.acknowledgeRealtimeVoiceSpeechDelivery(
          this.dependencies.sessionHandle,
          active.turnId,
          active.artifactId,
          { deliveryId, audioSha256 },
          abort.signal,
        );
        if (!this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) return null;
        if (result.ok) return result.value;
      } catch {
        if (!this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) return null;
      }
      if (attempt < this.maxMutationAttempts) {
        await this.pause(this.idleDelayMs, abort.signal);
        if (!this.operationIsCurrent(active, runGeneration, operationGeneration, abort)) return null;
      }
    }
    await this.rejectActive(active, 'delivery_failed', 'playback_error');
    return null;
  }

  private async rejectActive(
    active: ActiveArtifact,
    code: RealtimeAuditedSpeechErrorCode,
    reason: RealtimeVoiceSpeechCancellationReason,
  ): Promise<void> {
    this.stopLocally();
    active.cancelled = true;
    if (!active.rejectionReported) {
      active.rejectionReported = true;
      this.reportError(code);
    }
    await this.requestCancellation(active, reason);
  }

  private requestCancellation(
    active: ActiveArtifact,
    reason: RealtimeVoiceSpeechCancellationReason,
  ): Promise<void> {
    if (active.cancellationPromise) return active.cancellationPromise;
    let cancellationId: string;
    try {
      cancellationId = this.dependencies.createCancellationId();
    } catch {
      if (!this.closed) this.halt('identifier_generation_failed');
      return Promise.resolve();
    }
    if (!UUID_PATTERN.test(cancellationId)) {
      if (!this.closed) this.halt('identifier_generation_failed');
      return Promise.resolve();
    }
    active.cancellationId = cancellationId;
    active.cancellationReason = reason;
    const promise = this.sendCancellation(active, cancellationId, reason);
    active.cancellationPromise = promise;
    return promise;
  }

  private async sendCancellation(
    active: ActiveArtifact,
    cancellationId: string,
    reason: RealtimeVoiceSpeechCancellationReason,
  ): Promise<void> {
    const abort = new AbortController();
    for (let attempt = 1; attempt <= this.maxMutationAttempts; attempt += 1) {
      try {
        const result = await this.dependencies.client.cancelRealtimeVoiceSpeech(
          this.dependencies.sessionHandle,
          active.turnId,
          active.artifactId,
          { cancellationId, reason },
          abort.signal,
        );
        if (result.ok) {
          active.settled = true;
          const terminalStatus: RealtimeTurnSettlementStatus =
            reason === 'playback_error' ? 'failed' : 'cancelled';
          if (!this.publishTurnTerminal(active.turnId, terminalStatus)) {
            this.halt('turn_terminal_conflict');
          }
          return;
        }
      } catch {
        // Le code externe n'est jamais propagé ni journalisé.
      }
      if (attempt < this.maxMutationAttempts) await this.pause(this.idleDelayMs, abort.signal);
    }
    if (!this.closed && !active.settled) this.halt('cancellation_failed');
  }

  private createActive(binding: ArtifactBinding): ActiveArtifact {
    return {
      ...binding,
      ready: null,
      operationStarted: false,
      cancelled: false,
      cancellationId: null,
      cancellationReason: null,
      cancellationPromise: null,
      rejectionReported: false,
      settled: false,
    };
  }

  private contextMatches(binding: ArtifactBinding): boolean {
    const fence = this.dependencies.currentFence();
    return fence !== null
      && fence.sessionHandle === this.dependencies.sessionHandle
      && fence.contextRevision === binding.contextRevision
      && fence.contextDigest === binding.contextDigest;
  }

  private operationIsCurrent(
    active: ActiveArtifact,
    runGeneration: number,
    operationGeneration: number,
    abort: AbortController,
  ): boolean {
    return this.isRunCurrent(runGeneration)
      && !abort.signal.aborted
      && this.operationGeneration === operationGeneration
      && this.active === active
      && !active.cancelled;
  }

  private isRunCurrent(generation: number): boolean {
    return !this.closed && !this.halted && this.runGeneration === generation;
  }

  private async onFeedFailure(generation: number): Promise<boolean> {
    this.consecutiveFeedErrors += 1;
    if (this.consecutiveFeedErrors >= this.maxConsecutiveFeedErrors) {
      this.halt('feed_unavailable');
      return false;
    }
    await this.pauseWhileCurrent(generation);
    return this.isRunCurrent(generation);
  }

  private async pauseWhileCurrent(generation: number): Promise<void> {
    const abort = new AbortController();
    this.pauseAbort = abort;
    if (!this.isRunCurrent(generation)) abort.abort();
    try {
      await this.pause(this.idleDelayMs, abort.signal);
    } finally {
      if (this.pauseAbort === abort) this.pauseAbort = null;
    }
  }

  private halt(code: RealtimeAuditedSpeechErrorCode): void {
    if (this.halted || this.closed) return;
    this.halted = true;
    this.runGeneration += 1;
    this.operationGeneration += 1;
    this.stopLocally();
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.pauseAbort?.abort();
    this.pauseAbort = null;
    this.operationAbort?.abort();
    this.operationAbort = null;
    const active = this.active;
    if (active !== null && !active.settled) {
      active.settled = true;
      this.publishTurnTerminal(active.turnId, 'failed');
    }
    this.reportError(code);
  }

  private statusForTerminalFeed(
    reason: Extract<RealtimeVoiceSpeechFeed, { status: 'terminal' }>['reason'],
  ): RealtimeTurnSettlementStatus {
    if (reason === 'delivered') return 'done';
    if (reason === 'cancelled') return 'cancelled';
    return 'failed';
  }

  /**
   * Ledger borné par le maximum contractuel de tours d'une session. Le premier terminal gagne ;
   * un replay identique est idempotent, un statut contradictoire ferme le protocole.
   */
  private publishTurnTerminal(
    turnId: string,
    status: RealtimeTurnSettlementStatus,
    atMs = this.now(),
  ): boolean {
    if (!UUID_PATTERN.test(turnId)) return false;
    const previous = this.terminalTurns.get(turnId);
    if (previous !== undefined) return previous === status;
    if (this.terminalTurns.size >= MAX_TURNS_PER_SESSION) return false;
    this.terminalTurns.set(turnId, status);
    this.emit({ type: 'turn_terminal', turnId, status, atMs });
    return true;
  }

  private stopLocally(): boolean {
    try {
      this.dependencies.playback.stopImmediately();
      return true;
    } catch {
      if (!this.closed && !this.halted) this.reportError('playback_contract_violation');
      return false;
    }
  }

  private requireLocalStop(stopped: boolean, completion: Promise<void>): Promise<void> {
    if (stopped) return completion;
    return completion.then(
      () => Promise.reject(new RealtimeAuditedSpeechStopError()),
      () => Promise.reject(new RealtimeAuditedSpeechStopError()),
    );
  }

  private reportError(code: RealtimeAuditedSpeechErrorCode): void {
    if (this.closed) return;
    const atMs = this.now();
    this.metrics = { ...this.metrics, errorCount: this.metrics.errorCount + 1 };
    this.emit({ type: 'error', code, atMs });
  }

  private emit(event: RealtimeAuditedSpeechPlayerEvent): void {
    if (this.closed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Une vue défaillante ne peut pas perturber la sécurité du player.
      }
    }
  }

  private boundedOption(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    return Number.isInteger(value) && value !== undefined && value >= minimum && value <= maximum
      ? value
      : fallback;
  }
}
