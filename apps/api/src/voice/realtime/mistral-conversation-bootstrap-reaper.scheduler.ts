import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppLogger } from '../../observability/logger';
import {
  MistralConversationBootstrapReaperUnavailableError,
  type MistralConversationBootstrapReaperPort,
} from './mistral-conversation-bootstrap-reaper';

export const MISTRAL_CONVERSATION_BOOTSTRAP_REAPER = Symbol(
  'MISTRAL_CONVERSATION_BOOTSTRAP_REAPER',
);
export const MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_OPTIONS = Symbol(
  'MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_OPTIONS',
);
export const MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_RUNTIME = Symbol(
  'MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_RUNTIME',
);

export interface MistralConversationBootstrapReaperOptions {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly maxBatchesPerSweep: number;
}

export interface MistralConversationBootstrapReaperRuntime {
  now(): number;
  schedule(callback: () => void, intervalMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface MistralConversationBootstrapReaperSweepSummary {
  readonly outcome: 'disabled' | 'skipped' | 'circuit_open' | 'succeeded' | 'failed';
  readonly batches: number;
  readonly purgedCount: number;
  readonly missionsPurged: number;
  readonly resumeTicketsPurged: number;
  readonly commandsPurged: number;
  readonly outboxEventsPurged: number;
  readonly lockSkipped: number;
  readonly admissionBlocked: number;
  readonly invariantBlocked: number;
  readonly terminalizationBlocked: boolean;
  readonly expiredRowsRemain: boolean;
  readonly limited: boolean;
}

const FAILURE_THRESHOLD = 5;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 3_600_000;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 100;
const MIN_BATCHES_PER_SWEEP = 1;
const MAX_BATCHES_PER_SWEEP = 20;

const defaultRuntime: MistralConversationBootstrapReaperRuntime = Object.freeze({
  now: () => Date.now(),
  schedule: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
  cancel: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
});

function assertOptions(
  options: MistralConversationBootstrapReaperOptions,
): MistralConversationBootstrapReaperOptions {
  if (
    typeof options.enabled !== 'boolean'
    || !Number.isInteger(options.intervalMs)
    || options.intervalMs < MIN_INTERVAL_MS
    || options.intervalMs > MAX_INTERVAL_MS
    || !Number.isInteger(options.batchSize)
    || options.batchSize < MIN_BATCH_SIZE
    || options.batchSize > MAX_BATCH_SIZE
    || !Number.isInteger(options.maxBatchesPerSweep)
    || options.maxBatchesPerSweep < MIN_BATCHES_PER_SWEEP
    || options.maxBatchesPerSweep > MAX_BATCHES_PER_SWEEP
  ) {
    throw new Error('Mistral conversation bootstrap reaper configuration is invalid.');
  }
  return Object.freeze({ ...options });
}

function emptySummary(
  outcome: MistralConversationBootstrapReaperSweepSummary['outcome'],
): MistralConversationBootstrapReaperSweepSummary {
  return Object.freeze({
    outcome,
    batches: 0,
    purgedCount: 0,
    missionsPurged: 0,
    resumeTicketsPurged: 0,
    commandsPurged: 0,
    outboxEventsPurged: 0,
    lockSkipped: 0,
    admissionBlocked: 0,
    invariantBlocked: 0,
    terminalizationBlocked: false,
    expiredRowsRemain: false,
    limited: false,
  });
}

/**
 * Scheduler multi-réplique : la fonction SQL utilise FOR UPDATE SKIP LOCKED et FORCE RLS.
 * Le timer est dynamique (configuration validée), un sweep ne se chevauche jamais localement,
 * et l'arrêt Nest attend la transaction déjà engagée avant de rendre la main.
 */
@Injectable()
export class MistralConversationBootstrapReaperScheduler
implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly options: MistralConversationBootstrapReaperOptions;
  private readonly runtime: MistralConversationBootstrapReaperRuntime;
  private timer: unknown | null = null;
  private inFlight: Promise<MistralConversationBootstrapReaperSweepSummary> | null = null;
  private stopping = false;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private retentionStallLogged = false;

  constructor(
    @Inject(MISTRAL_CONVERSATION_BOOTSTRAP_REAPER)
    private readonly reaper: MistralConversationBootstrapReaperPort | null,
    @Inject(MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_OPTIONS)
    options: MistralConversationBootstrapReaperOptions,
    private readonly logger: AppLogger,
    @Optional()
    @Inject(MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_RUNTIME)
    runtime?: MistralConversationBootstrapReaperRuntime,
  ) {
    this.options = assertOptions(options);
    this.runtime = runtime ?? defaultRuntime;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.enabled) return;
    if (!this.reaper) throw new MistralConversationBootstrapReaperUnavailableError();

    // Le boot refuse une migration absente, un rôle runtime trop puissant ou un GRANT manquant.
    await this.reaper.assertReady();
    const firstSweep = await this.sweep();
    if (firstSweep.outcome !== 'succeeded') {
      throw new MistralConversationBootstrapReaperUnavailableError();
    }
    if (this.stopping) return;
    this.timer = this.runtime.schedule(() => {
      void this.sweep();
    }, this.options.intervalMs);
    this.logger.audit('bob.live.mistral.bootstrap_reaper.ready', {
      intervalMs: this.options.intervalMs,
      batchSize: this.options.batchSize,
      maxBatchesPerSweep: this.options.maxBatchesPerSweep,
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      this.runtime.cancel(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  async sweep(): Promise<MistralConversationBootstrapReaperSweepSummary> {
    if (!this.options.enabled || this.stopping) return emptySummary('disabled');
    if (this.inFlight) return emptySummary('skipped');
    if (this.runtime.now() < this.circuitOpenUntil) return emptySummary('circuit_open');

    const execution = this.executeSweep();
    this.inFlight = execution;
    try {
      return await execution;
    } finally {
      if (this.inFlight === execution) this.inFlight = null;
    }
  }

  private async executeSweep(): Promise<MistralConversationBootstrapReaperSweepSummary> {
    if (!this.reaper) return this.recordFailure();
    try {
      let batches = 0;
      let purgedCount = 0;
      let missionsPurged = 0;
      let resumeTicketsPurged = 0;
      let commandsPurged = 0;
      let outboxEventsPurged = 0;
      let lockSkipped = 0;
      let admissionBlocked = 0;
      let invariantBlocked = 0;
      let terminalizationBlocked = false;
      let expiredRowsRemain = false;
      while (batches < this.options.maxBatchesPerSweep) {
        const batch = await this.reaper.purgeBatch(this.options.batchSize);
        batches += 1;
        purgedCount += batch.purgedCount;
        missionsPurged += batch.missionsPurged;
        resumeTicketsPurged += batch.resumeTicketsPurged;
        commandsPurged += batch.commandsPurged;
        outboxEventsPurged += batch.outboxEventsPurged;
        lockSkipped += batch.lockSkipped;
        admissionBlocked += batch.admissionBlocked;
        invariantBlocked += batch.invariantBlocked;
        terminalizationBlocked ||= batch.terminalizationBlocked;
        expiredRowsRemain = batch.expiredRowsRemain;
        if (batch.purgedCount === 0 || !batch.expiredRowsRemain) break;
      }

      const limited = expiredRowsRemain
        && batches === this.options.maxBatchesPerSweep
        && purgedCount > 0;
      const stalled = expiredRowsRemain && purgedCount === 0;
      if (stalled && !this.retentionStallLogged) {
        this.retentionStallLogged = true;
        this.logger.audit('bob.live.mistral.bootstrap_reaper.retention_blocked', {
          lockSkipped,
          admissionBlocked,
          invariantBlocked,
          terminalizationBlocked,
        });
        this.logger.warn(
          'bob.live.mistral.bootstrap_reaper.retention_dependency_pending',
          'MistralConversationBootstrapReaper',
        );
      } else if (!expiredRowsRemain) {
        this.retentionStallLogged = false;
      }

      const recovered = this.consecutiveFailures > 0 || this.circuitOpenUntil > 0;
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      if (purgedCount > 0 || recovered) {
        this.logger.audit('bob.live.mistral.bootstrap_reaper.sweep', {
          outcome: recovered ? 'recovered' : 'purged',
          batches,
          purgedCount,
          missionsPurged,
          resumeTicketsPurged,
          commandsPurged,
          outboxEventsPurged,
          lockSkipped,
          admissionBlocked,
          invariantBlocked,
          terminalizationBlocked,
          expiredRowsRemain,
          limited,
        });
      } else {
        this.logger.debug(
          'bob.live.mistral.bootstrap_reaper.sweep_empty',
          'MistralConversationBootstrapReaper',
        );
      }
      return Object.freeze({
        outcome: 'succeeded' as const,
        batches,
        purgedCount,
        missionsPurged,
        resumeTicketsPurged,
        commandsPurged,
        outboxEventsPurged,
        lockSkipped,
        admissionBlocked,
        invariantBlocked,
        terminalizationBlocked,
        expiredRowsRemain,
        limited,
      });
    } catch {
      return this.recordFailure();
    }
  }

  private recordFailure(): MistralConversationBootstrapReaperSweepSummary {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < FAILURE_THRESHOLD) {
      this.logger.warn(
        'bob.live.mistral.bootstrap_reaper.sweep_failed',
        'MistralConversationBootstrapReaper',
      );
    } else {
      // Une seule erreur par fenêtre ouverte. Une tentative half-open est permise après le délai.
      this.circuitOpenUntil = this.runtime.now() + this.circuitCooldownMs();
      this.logger.error(
        'bob.live.mistral.bootstrap_reaper.circuit_open',
        undefined,
        'MistralConversationBootstrapReaper',
      );
    }
    return emptySummary('failed');
  }

  private circuitCooldownMs(): number {
    return Math.min(Math.max(this.options.intervalMs * FAILURE_THRESHOLD, 60_000), 900_000);
  }
}
