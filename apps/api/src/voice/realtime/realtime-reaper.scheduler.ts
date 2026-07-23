import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppLogger } from '../../observability/logger';
import {
  type RealtimeAdmissionPort,
  type RealtimeReapingClaim,
} from './realtime-admission';
import type { RealtimeReaperDirectoryPort } from './realtime-reaper-directory';
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

export const REALTIME_REAPER_DIRECTORY = Symbol('REALTIME_REAPER_DIRECTORY');
export const REALTIME_REAPER_OPTIONS = Symbol('REALTIME_REAPER_OPTIONS');

export interface RealtimeReaperOptions {
  maxTenantsPerSweep: number;
  maxClaimsPerTenant: number;
  maxConcurrentTenants: number;
  maxConcurrentHangups: number;
  shutdownGraceMs: number;
}

export interface RealtimeReaperSweepSummary {
  skipped: boolean;
  tenants: number;
  claims: number;
  terminated: number;
  failures: number;
  unavailableTenants: number;
  discoveryUnavailable: boolean;
  discoverySaturated: boolean;
  claimUnacknowledged: boolean;
}

const DEFAULT_OPTIONS: RealtimeReaperOptions = {
  maxTenantsPerSweep: 100,
  // Deux claims par tenant et deux tenants concurrents : les quatre hangups démarrent
  // immédiatement, bien avant l'expiration du fence reaper de 30 secondes.
  maxClaimsPerTenant: 2,
  maxConcurrentTenants: 2,
  maxConcurrentHangups: 4,
  shutdownGraceMs: 5_000,
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
    shutdownGraceMs: boundedInteger(input?.shutdownGraceMs, DEFAULT_OPTIONS.shutdownGraceMs, 30_000),
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
export class RealtimeAdmissionReaperScheduler implements OnApplicationShutdown {
  private readonly options: RealtimeReaperOptions;
  private readonly providers: RealtimeProviderTerminationRegistry;
  private inFlight: Promise<RealtimeReaperSweepSummary> | null = null;
  private stopping = false;

  constructor(
    @Inject(REALTIME_ADMISSION) private readonly admission: RealtimeAdmissionPort,
    @Inject(REALTIME_PROVIDER_TERMINATION_REGISTRY)
    provider: OpenAiRealtimeCallProvider | RealtimeProviderTerminationRegistry,
    @Inject(REALTIME_REAPER_DIRECTORY) private readonly directory: RealtimeReaperDirectoryPort,
    @Inject(REALTIME_VOICE_SETTINGS) settings: RealtimeVoiceSettings,
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
    // La maintenance continue après un kill-switch : les appels déjà créés doivent être drainés.
    if (this.stopping || this.inFlight) return this.emptySummary(true);
    const task = this.runSweep();
    this.inFlight = task;
    try {
      return await task;
    } finally {
      if (this.inFlight === task) this.inFlight = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (!this.inFlight) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.shutdownGraceMs);
      timer.unref?.();
    });
    await Promise.race([this.inFlight.then(() => undefined, () => undefined), deadline]);
    if (timer) clearTimeout(timer);
  }

  private async runSweep(): Promise<RealtimeReaperSweepSummary> {
    const summary = this.emptySummary(false);
    try {
      const due = await this.directory.listDueCompanyIds({
        limit: this.options.maxTenantsPerSweep,
      });
      if (due.status !== 'succeeded') {
        summary.discoveryUnavailable = true;
        summary.failures += 1;
        this.logger.warn('bob.live.reaper.directory_unavailable', 'BobLiveReaper');
        return this.audit(summary);
      }
      if (
        (due.companyIds.length === 0) !== (due.claimId === null)
        || (due.companyIds.length === 0 && due.hasMore)
      ) {
        summary.discoveryUnavailable = true;
        summary.failures += 1;
        this.logger.warn('bob.live.reaper.directory_projection_rejected', 'BobLiveReaper');
        return this.audit(summary);
      }
      const companyIds = [...due.companyIds];
      summary.tenants = companyIds.length;
      summary.discoverySaturated = due.hasMore;
      const hangups = new AsyncLimiter(this.options.maxConcurrentHangups);
      let directoryClaimOwned = true;
      for (
        let offset = 0;
        offset < companyIds.length && !this.stopping;
        offset += this.options.maxConcurrentTenants
      ) {
        if (due.claimId === null) {
          directoryClaimOwned = false;
          break;
        }
        let renewal;
        try {
          renewal = await this.directory.renewClaim({ claimId: due.claimId });
        } catch {
          renewal = { status: 'unavailable' as const };
        }
        if (renewal.status !== 'succeeded' || !renewal.renewed) {
          directoryClaimOwned = false;
          summary.claimUnacknowledged = true;
          summary.failures += 1;
          this.logger.warn('bob.live.reaper.directory_claim_lost', 'BobLiveReaper');
          break;
        }
        const wave = companyIds.slice(offset, offset + this.options.maxConcurrentTenants);
        await Promise.all(
          wave.map((companyId) => this.processTenant(companyId, hangups, summary)),
        );
      }
      if (this.stopping) directoryClaimOwned = false;
      if (due.claimId !== null) {
        if (directoryClaimOwned) {
          let ack;
          try {
            ack = await this.directory.acknowledgeClaim({ claimId: due.claimId });
          } catch {
            ack = { status: 'unavailable' as const };
          }
          summary.claimUnacknowledged = ack.status !== 'succeeded' || !ack.acknowledged;
          if (summary.claimUnacknowledged) summary.failures += 1;
        } else {
          summary.claimUnacknowledged = true;
        }
      }
      return this.audit(summary);
    } catch {
      summary.failures += 1;
      this.logger.warn('bob.live.reaper.sweep_failed', 'BobLiveReaper');
      return this.audit(summary);
    }
  }

  private async processTenant(
    companyId: string,
    hangups: AsyncLimiter,
    summary: RealtimeReaperSweepSummary,
  ): Promise<boolean> {
    let batch;
    try {
      batch = await this.admission.claimExpired({
        companyId,
        limit: this.options.maxClaimsPerTenant,
      });
    } catch {
      batch = { ok: false as const, reason: 'unavailable' as const };
    }
    if (!batch.ok) {
      summary.unavailableTenants += 1;
      summary.failures += 1;
      this.logger.warn('bob.live.reaper.admission_unavailable', 'BobLiveReaper');
      return false;
    }
    summary.claims += batch.claims.length;
    const terminations = await Promise.all(
      batch.claims.map((claim) => hangups.run(() => this.terminate(claim, summary))),
    );
    return terminations.every(Boolean);
  }

  private async terminate(
    claim: RealtimeReapingClaim,
    summary: RealtimeReaperSweepSummary,
  ): Promise<boolean> {
    try {
      // I/O externe hors transaction : claimExpired a déjà rendu le contrôle et libéré ses locks.
      await this.providers.hangupCall({
        companyId: claim.companyId,
        subjectHash: claim.subjectHash,
        sessionId: claim.sessionId,
        providerId: claim.providerId,
        providerCallId: claim.providerCallId,
        reaperToken: claim.reaperToken,
        reaperLeaseExpiresAt: claim.reaperLeaseExpiresAt,
        terminationCause: 'lease_expired',
        hardExpiryProof: claim.hardExpiryProof,
      });
    } catch {
      summary.failures += 1;
      this.logger.warn('bob.live.reaper.provider_hangup_failed', 'BobLiveReaper');
      return false;
    }
    let completed;
    try {
      completed = await this.admission.completeReaping({
        companyId: claim.companyId,
        subjectHash: claim.subjectHash,
        sessionId: claim.sessionId,
        reaperToken: claim.reaperToken,
      });
    } catch {
      completed = { ok: false as const, reason: 'unavailable' as const };
    }
    if (!completed.ok) {
      summary.failures += 1;
      this.logger.warn('bob.live.reaper.completion_failed', 'BobLiveReaper');
      return false;
    }
    summary.terminated += 1;
    return true;
  }

  private emptySummary(skipped: boolean): RealtimeReaperSweepSummary {
    return {
      skipped,
      tenants: 0,
      claims: 0,
      terminated: 0,
      failures: 0,
      unavailableTenants: 0,
      discoveryUnavailable: false,
      discoverySaturated: false,
      claimUnacknowledged: false,
    };
  }

  private audit(summary: RealtimeReaperSweepSummary): RealtimeReaperSweepSummary {
    if (
      summary.tenants > 0
      || summary.claims > 0
      || summary.failures > 0
      || summary.discoveryUnavailable
      || summary.discoverySaturated
      || summary.claimUnacknowledged
    ) this.logger.audit('bob.live.reaper.sweep', { ...summary });
    return summary;
  }
}
