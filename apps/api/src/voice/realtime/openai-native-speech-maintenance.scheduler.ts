import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { AppLogger } from '../../observability/logger';
import {
  OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
  OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_TENANTS,
  type OpenAiNativeSpeechMaintenancePort,
} from './openai-native-speech-maintenance';
import {
  OPENAI_NATIVE_SPEECH_MAINTENANCE,
  OPENAI_NATIVE_SPEECH_MAINTENANCE_OPTIONS,
} from './realtime.tokens';

const EXPIRY_INTERVAL_MS = 10_000;

export interface OpenAiNativeSpeechMaintenanceOptions {
  readonly maxTenantsPerSweep: number;
  /** Budget global de transactions, toujours au moins égal au nombre de tenants sélectionnés. */
  readonly maxBatchesPerSweep: number;
  readonly expiryLimitPerTenant: number;
  readonly retentionLimitPerTenant: number;
  readonly shutdownGraceMs: number;
}

export interface OpenAiNativeSpeechExpirySweepSummary {
  readonly skipped: boolean;
  readonly tenants: number;
  readonly batches: number;
  readonly expired: number;
  readonly saturatedTenants: number;
  readonly unavailableTenants: number;
  readonly discoveryUnavailable: boolean;
  readonly discoverySaturated: boolean;
  readonly claimUnacknowledged: boolean;
}

export interface OpenAiNativeSpeechRetentionSweepSummary {
  readonly skipped: boolean;
  readonly tenants: number;
  readonly batches: number;
  readonly purged: number;
  /** Compte borné par tenant ; un résultat non nul est une anomalie V1. */
  readonly dependenciesBlocked: number;
  readonly saturatedTenants: number;
  readonly unavailableTenants: number;
  readonly discoveryUnavailable: boolean;
  readonly discoverySaturated: boolean;
  readonly claimUnacknowledged: boolean;
}

const DEFAULT_OPTIONS: OpenAiNativeSpeechMaintenanceOptions = {
  maxTenantsPerSweep: 100,
  maxBatchesPerSweep: 200,
  expiryLimitPerTenant: OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
  retentionLimitPerTenant: OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
  shutdownGraceMs: 5_000,
};

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 1
    ? Math.min(value!, max)
    : fallback;
}

function normalizedOptions(
  input?: Partial<OpenAiNativeSpeechMaintenanceOptions>,
): OpenAiNativeSpeechMaintenanceOptions {
  const maxTenantsPerSweep = boundedInteger(
    input?.maxTenantsPerSweep,
    DEFAULT_OPTIONS.maxTenantsPerSweep,
    OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_TENANTS,
  );
  return {
    maxTenantsPerSweep,
    maxBatchesPerSweep: Math.max(
      maxTenantsPerSweep,
      boundedInteger(input?.maxBatchesPerSweep, DEFAULT_OPTIONS.maxBatchesPerSweep, 10_000),
    ),
    expiryLimitPerTenant: boundedInteger(
      input?.expiryLimitPerTenant,
      OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
      OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
    ),
    retentionLimitPerTenant: boundedInteger(
      input?.retentionLimitPerTenant,
      OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
      OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
    ),
    shutdownGraceMs: boundedInteger(
      input?.shutdownGraceMs,
      DEFAULT_OPTIONS.shutdownGraceMs,
      30_000,
    ),
  };
}

/**
 * Maintenance DB-only du registre natif. La découverte SQL porte exclusivement sur les lignes
 * dues : elle ne dépend donc ni d'un flag produit, ni d'un provider, ni d'une liste de tenants
 * configurée à la main. Chaque page est louée, renouvelée avant chaque transaction tenantée puis
 * acquittée seulement après traitement intégral ; un crash la rend donc rejouable sans famine.
 */
@Injectable()
export class OpenAiNativeSpeechMaintenanceScheduler implements OnApplicationShutdown {
  private readonly options: OpenAiNativeSpeechMaintenanceOptions;
  private expiryInFlight: Promise<OpenAiNativeSpeechExpirySweepSummary> | null = null;
  private retentionInFlight: Promise<OpenAiNativeSpeechRetentionSweepSummary> | null = null;
  private stopping = false;

  constructor(
    @Inject(OPENAI_NATIVE_SPEECH_MAINTENANCE)
    private readonly maintenance: OpenAiNativeSpeechMaintenancePort,
    private readonly logger: AppLogger,
    @Optional() @Inject(OPENAI_NATIVE_SPEECH_MAINTENANCE_OPTIONS)
    options?: Partial<OpenAiNativeSpeechMaintenanceOptions>,
  ) {
    this.options = normalizedOptions(options);
  }

  @Interval('bob-live-openai-native-speech-expiry', EXPIRY_INTERVAL_MS)
  async scheduledExpiry(): Promise<void> {
    await this.sweepExpiry();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledRetention(): Promise<void> {
    await this.sweepRetention();
  }

  async sweepExpiry(): Promise<OpenAiNativeSpeechExpirySweepSummary> {
    if (this.stopping || this.expiryInFlight) return this.skippedExpiry();
    const task = this.runExpiry();
    this.expiryInFlight = task;
    try {
      return await task;
    } finally {
      if (this.expiryInFlight === task) this.expiryInFlight = null;
    }
  }

  async sweepRetention(): Promise<OpenAiNativeSpeechRetentionSweepSummary> {
    if (this.stopping || this.retentionInFlight) return this.skippedRetention();
    const task = this.runRetention();
    this.retentionInFlight = task;
    try {
      return await task;
    } finally {
      if (this.retentionInFlight === task) this.retentionInFlight = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    const tasks: Promise<unknown>[] = [];
    if (this.expiryInFlight) tasks.push(this.expiryInFlight);
    if (this.retentionInFlight) tasks.push(this.retentionInFlight);
    if (tasks.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.shutdownGraceMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(tasks).then(() => undefined), deadline]);
    if (timer) clearTimeout(timer);
  }

  private skippedExpiry(): OpenAiNativeSpeechExpirySweepSummary {
    return {
      skipped: true,
      tenants: 0,
      batches: 0,
      expired: 0,
      saturatedTenants: 0,
      unavailableTenants: 0,
      discoveryUnavailable: false,
      discoverySaturated: false,
      claimUnacknowledged: false,
    };
  }

  private skippedRetention(): OpenAiNativeSpeechRetentionSweepSummary {
    return {
      skipped: true,
      tenants: 0,
      batches: 0,
      purged: 0,
      dependenciesBlocked: 0,
      saturatedTenants: 0,
      unavailableTenants: 0,
      discoveryUnavailable: false,
      discoverySaturated: false,
      claimUnacknowledged: false,
    };
  }

  private async runExpiry(): Promise<OpenAiNativeSpeechExpirySweepSummary> {
    const summary = { ...this.skippedExpiry(), skipped: false };
    try {
      const due = await this.maintenance.listDueCompanyIds({
        lane: 'expiry',
        limit: this.options.maxTenantsPerSweep,
      });
      if (due.status !== 'succeeded') {
        summary.discoveryUnavailable = true;
        this.logger.audit('bob.live.openai_native.expiry_sweep', summary);
        return summary;
      }
      if ((due.companyIds.length === 0) !== (due.claimId === null)) {
        summary.discoveryUnavailable = true;
        this.logger.audit('bob.live.openai_native.expiry_sweep', summary);
        return summary;
      }
      const queue = [...due.companyIds];
      summary.discoverySaturated = due.hasMore;
      const saturated = new Set<string>();
      summary.tenants = queue.length;
      while (
        queue.length > 0
        && summary.batches < this.options.maxBatchesPerSweep
        && !this.stopping
      ) {
        const renewal = await this.maintenance.renewDueCompanyIdsClaim({
          lane: 'expiry', claimId: due.claimId!,
        });
        if (renewal.status !== 'succeeded' || !renewal.renewed) {
          summary.claimUnacknowledged = true;
          break;
        }
        const companyId = queue.shift()!;
        summary.batches += 1;
        try {
          const result = await this.maintenance.reapExpired({
            companyId,
            limit: this.options.expiryLimitPerTenant,
          });
          if (result.status === 'succeeded') {
            summary.expired += result.expiredCount;
            if (result.hasMore) {
              saturated.add(companyId);
            } else {
              saturated.delete(companyId);
            }
          } else {
            saturated.delete(companyId);
            summary.unavailableTenants += 1;
          }
        } catch {
          saturated.delete(companyId);
          summary.unavailableTenants += 1;
        }
      }
      summary.saturatedTenants = saturated.size;
      if (due.claimId !== null) {
        if (
          queue.length === 0
          && summary.unavailableTenants === 0
          && !summary.claimUnacknowledged
          && !this.stopping
        ) {
          try {
            const ack = await this.maintenance.acknowledgeDueCompanyIds({
              lane: 'expiry', claimId: due.claimId,
            });
            summary.claimUnacknowledged = ack.status !== 'succeeded' || !ack.acknowledged;
          } catch {
            summary.claimUnacknowledged = true;
          }
        } else {
          summary.claimUnacknowledged = true;
        }
      }
    } catch {
      summary.discoveryUnavailable = true;
    }
    if (
      summary.expired > 0
      || summary.saturatedTenants > 0
      || summary.unavailableTenants > 0
      || summary.discoveryUnavailable
      || summary.discoverySaturated
      || summary.claimUnacknowledged
    ) this.logger.audit('bob.live.openai_native.expiry_sweep', summary);
    return summary;
  }

  private async runRetention(): Promise<OpenAiNativeSpeechRetentionSweepSummary> {
    const summary = { ...this.skippedRetention(), skipped: false };
    try {
      const due = await this.maintenance.listDueCompanyIds({
        lane: 'retention',
        limit: this.options.maxTenantsPerSweep,
      });
      if (due.status !== 'succeeded') {
        summary.discoveryUnavailable = true;
        this.logger.audit('bob.live.openai_native.retention_sweep', summary);
        return summary;
      }
      if ((due.companyIds.length === 0) !== (due.claimId === null)) {
        summary.discoveryUnavailable = true;
        this.logger.audit('bob.live.openai_native.retention_sweep', summary);
        return summary;
      }
      const queue = [...due.companyIds];
      summary.discoverySaturated = due.hasMore;
      const saturated = new Set<string>();
      summary.tenants = queue.length;
      while (
        queue.length > 0
        && summary.batches < this.options.maxBatchesPerSweep
        && !this.stopping
      ) {
        const renewal = await this.maintenance.renewDueCompanyIdsClaim({
          lane: 'retention', claimId: due.claimId!,
        });
        if (renewal.status !== 'succeeded' || !renewal.renewed) {
          summary.claimUnacknowledged = true;
          break;
        }
        const companyId = queue.shift()!;
        summary.batches += 1;
        try {
          const result = await this.maintenance.purgeRetained({
            companyId,
            limit: this.options.retentionLimitPerTenant,
          });
          if (result.status === 'succeeded') {
            summary.purged += result.purgedCount;
            summary.dependenciesBlocked = Math.max(
              summary.dependenciesBlocked,
              result.dependenciesBlocked,
            );
            if (result.hasMore) {
              saturated.add(companyId);
            } else {
              saturated.delete(companyId);
            }
          } else {
            saturated.delete(companyId);
            summary.unavailableTenants += 1;
          }
        } catch {
          saturated.delete(companyId);
          summary.unavailableTenants += 1;
        }
      }
      summary.saturatedTenants = saturated.size;
      if (due.claimId !== null) {
        if (
          queue.length === 0
          && summary.unavailableTenants === 0
          && summary.dependenciesBlocked === 0
          && !summary.claimUnacknowledged
          && !this.stopping
        ) {
          try {
            const ack = await this.maintenance.acknowledgeDueCompanyIds({
              lane: 'retention', claimId: due.claimId,
            });
            summary.claimUnacknowledged = ack.status !== 'succeeded' || !ack.acknowledged;
          } catch {
            summary.claimUnacknowledged = true;
          }
        } else {
          summary.claimUnacknowledged = true;
        }
      }
    } catch {
      summary.discoveryUnavailable = true;
    }
    if (
      summary.purged > 0
      || summary.dependenciesBlocked > 0
      || summary.saturatedTenants > 0
      || summary.unavailableTenants > 0
      || summary.discoveryUnavailable
      || summary.discoverySaturated
      || summary.claimUnacknowledged
    ) this.logger.audit('bob.live.openai_native.retention_sweep', summary);
    return summary;
  }
}
