import { Inject, Injectable, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppLogger } from '../../observability/logger';
import {
  isRealtimeCompanyId,
  type RealtimeAdmissionPort,
  type RealtimeReapingClaim,
} from './realtime-admission';
import {
  REALTIME_ADMISSION,
  REALTIME_PROVIDER_TERMINATION_REGISTRY,
  REALTIME_VOICE_SETTINGS,
} from './realtime.tokens';
import {
  RealtimeProviderTerminationRegistry,
  realtimeProviderTerminationAdapter,
} from './realtime-provider-registry';
import type { OpenAiRealtimeCallProvider, RealtimeVoiceSettings } from './realtime.types';

export const REALTIME_REAPER_TENANT_DIRECTORY = Symbol('REALTIME_REAPER_TENANT_DIRECTORY');
export const REALTIME_REAPER_OPTIONS = Symbol('REALTIME_REAPER_OPTIONS');

export interface RealtimeReaperTenantDirectory {
  listCompanyIds(): Promise<string[]>;
}

export interface RealtimeReaperOptions {
  maxTenantsPerSweep: number;
  maxClaimsPerTenant: number;
  maxConcurrentTenants: number;
  maxConcurrentHangups: number;
}

export interface RealtimeReaperSweepSummary {
  skipped: boolean;
  tenants: number;
  claims: number;
  terminated: number;
  failures: number;
  unavailableTenants: number;
}

const DEFAULT_OPTIONS: RealtimeReaperOptions = {
  maxTenantsPerSweep: 100,
  // Deux claims par tenant et deux tenants concurrents : les quatre hangups démarrent
  // immédiatement, bien avant l'expiration du fence reaper de 30 secondes.
  maxClaimsPerTenant: 2,
  maxConcurrentTenants: 2,
  maxConcurrentHangups: 4,
};

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1) return fallback;
  return Math.min(value!, max);
}

function normalizedOptions(input?: Partial<RealtimeReaperOptions>): RealtimeReaperOptions {
  return {
    maxTenantsPerSweep: boundedInteger(input?.maxTenantsPerSweep, DEFAULT_OPTIONS.maxTenantsPerSweep, 1_000),
    maxClaimsPerTenant: boundedInteger(input?.maxClaimsPerTenant, DEFAULT_OPTIONS.maxClaimsPerTenant, 10),
    maxConcurrentTenants: boundedInteger(input?.maxConcurrentTenants, DEFAULT_OPTIONS.maxConcurrentTenants, 8),
    maxConcurrentHangups: boundedInteger(input?.maxConcurrentHangups, DEFAULT_OPTIONS.maxConcurrentHangups, 16),
  };
}

class AsyncLimiter {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.running += 1;
    try {
      return await operation();
    } finally {
      this.running -= 1;
      this.waiters.shift()?.();
    }
  }
}

/**
 * Reaper multi-réplique. Le claim/fence se termine avant l'I/O provider ; un échec de hangup laisse
 * donc le bail `reaping` en base. Une autre réplique ne pourra le reprendre qu'après expiration du
 * reaper token, et `completeReaping` n'est jamais appelé sans terminaison provider confirmée.
 */
@Injectable()
export class RealtimeAdmissionReaperScheduler {
  private readonly options: RealtimeReaperOptions;
  private readonly providers: RealtimeProviderTerminationRegistry;
  private running = false;

  constructor(
    @Inject(REALTIME_ADMISSION) private readonly admission: RealtimeAdmissionPort,
    @Inject(REALTIME_PROVIDER_TERMINATION_REGISTRY)
    provider: OpenAiRealtimeCallProvider | RealtimeProviderTerminationRegistry,
    @Inject(REALTIME_REAPER_TENANT_DIRECTORY) private readonly tenants: RealtimeReaperTenantDirectory,
    @Inject(REALTIME_VOICE_SETTINGS) private readonly settings: RealtimeVoiceSettings,
    private readonly logger: AppLogger,
    @Optional() @Inject(REALTIME_REAPER_OPTIONS) options?: Partial<RealtimeReaperOptions>,
  ) {
    this.options = normalizedOptions(options);
    // Compatibilité du module OpenAI existant. En configuration Mistral, l'adapter historique a
    // été construit avec une autre base URL : ne surtout pas le présenter comme adapter OpenAI.
    // Le registre complet injecté par la tranche transport remplacera ce fallback sans modifier
    // le protocole du reaper.
    this.providers = provider instanceof RealtimeProviderTerminationRegistry
      ? provider
      : new RealtimeProviderTerminationRegistry(
          settings.provider === 'openai'
            ? [realtimeProviderTerminationAdapter('openai', provider)]
            : [],
        );
  }

  @Interval('bob-live-admission-reaper', 10_000)
  async scheduledSweep(): Promise<void> {
    await this.sweep();
  }

  async sweep(): Promise<RealtimeReaperSweepSummary> {
    if (!this.settings.enabled || this.running) return this.emptySummary(true);
    this.running = true;
    const summary = this.emptySummary(false);
    try {
      const companyIds = [...new Set(await this.tenants.listCompanyIds())]
        .filter(isRealtimeCompanyId)
        .slice(0, this.options.maxTenantsPerSweep);
      summary.tenants = companyIds.length;
      const hangups = new AsyncLimiter(this.options.maxConcurrentHangups);
      await this.forEachBounded(companyIds, this.options.maxConcurrentTenants, async (companyId) => {
        const batch = await this.admission.claimExpired({
          companyId,
          limit: this.options.maxClaimsPerTenant,
        });
        if (!batch.ok) {
          summary.unavailableTenants += 1;
          summary.failures += 1;
          this.logger.warn('bob.live.reaper.admission_unavailable', 'BobLiveReaper');
          return;
        }
        summary.claims += batch.claims.length;
        await Promise.all(batch.claims.map((claim) => hangups.run(() => this.terminate(claim, summary))));
      });
      this.logger.audit('bob.live.reaper.sweep', {
        tenants: summary.tenants,
        claims: summary.claims,
        terminated: summary.terminated,
        failures: summary.failures,
        unavailableTenants: summary.unavailableTenants,
      });
      return summary;
    } catch {
      summary.failures += 1;
      this.logger.warn('bob.live.reaper.sweep_failed', 'BobLiveReaper');
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async terminate(
    claim: RealtimeReapingClaim,
    summary: RealtimeReaperSweepSummary,
  ): Promise<void> {
    try {
      // I/O externe hors transaction : claimExpired a déjà rendu le contrôle et libéré ses locks.
      await this.providers.hangupCall({
        companyId: claim.companyId,
        subjectHash: claim.subjectHash,
        sessionId: claim.sessionId,
        providerId: claim.providerId,
        providerCallId: claim.providerCallId,
        hardExpiryProof: claim.hardExpiryProof,
      });
    } catch {
      summary.failures += 1;
      this.logger.warn('bob.live.reaper.provider_hangup_failed', 'BobLiveReaper');
      return;
    }
    const completed = await this.admission.completeReaping({
      companyId: claim.companyId,
      subjectHash: claim.subjectHash,
      sessionId: claim.sessionId,
      reaperToken: claim.reaperToken,
    });
    if (!completed.ok) {
      summary.failures += 1;
      this.logger.warn('bob.live.reaper.completion_failed', 'BobLiveReaper');
      return;
    }
    summary.terminated += 1;
  }

  private async forEachBounded<T>(
    items: T[],
    concurrency: number,
    operation: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await operation(items[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  }

  private emptySummary(skipped: boolean): RealtimeReaperSweepSummary {
    return {
      skipped,
      tenants: 0,
      claims: 0,
      terminated: 0,
      failures: 0,
      unavailableTenants: 0,
    };
  }
}
