import { type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppLogger } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import {
  classifyRealtimeGlobalCapacityAuthority,
  type RealtimeGlobalCapacityExpectation,
  type RealtimeGlobalCapacityInspector,
} from './realtime-capacity';

const INSPECTION_INTERVAL_MS = 10_000;

/**
 * Gate de boot + métrologie de l'autorité globale. L'admission SQL revalide toujours elle-même :
 * ce snapshot n'est jamais une autorisation et peut donc être rafraîchi hors transaction métier.
 */
export class RealtimeGlobalCapacityMonitor implements OnApplicationBootstrap {
  private refreshing: Promise<boolean> | null = null;
  private unhealthyLogged = false;

  constructor(
    private readonly enabled: boolean,
    private readonly expected: RealtimeGlobalCapacityExpectation | null,
    private readonly inspector: RealtimeGlobalCapacityInspector,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    if (!this.expected) throw new Error('Bob Live global capacity configuration is missing.');
    if (!await this.refresh()) {
      throw new Error('Bob Live global capacity authority is unavailable or mismatched.');
    }
  }

  @Interval('bob-live-global-capacity-inspection', INSPECTION_INTERVAL_MS)
  async inspectPeriodically(): Promise<void> {
    if (!this.enabled) return;
    await this.refresh();
  }

  private refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async performRefresh(): Promise<boolean> {
    const result = await this.inspector.inspect();
    if (!result.ok) {
      this.metrics.bobLiveCapacityInspections.inc({ outcome: 'unavailable' });
      this.logUnhealthyOnce('Bob Live global capacity inspection unavailable.');
      return false;
    }
    const authority = this.expected
      ? classifyRealtimeGlobalCapacityAuthority(result.snapshot, this.expected)
      : 'invalid';
    if (authority === 'invalid') {
      this.metrics.bobLiveCapacityInspections.inc({ outcome: 'mismatch' });
      this.logUnhealthyOnce('Bob Live global capacity configuration mismatch.');
      return false;
    }

    this.unhealthyLogged = false;
    this.metrics.bobLiveCapacityInspections.inc({
      outcome: authority === 'closed_safe' ? 'closed' : 'ok',
    });
    this.metrics.bobLiveCapacityUsed.set(result.snapshot.usedSessions);
    if (result.snapshot.globalMaxSessions === null) {
      this.metrics.bobLiveCapacityGlobalLimit.remove();
    } else {
      this.metrics.bobLiveCapacityGlobalLimit.set(result.snapshot.globalMaxSessions);
    }
    if (result.snapshot.providerMaxSessions === null) {
      this.metrics.bobLiveCapacityProviderLimit.remove();
    } else {
      this.metrics.bobLiveCapacityProviderLimit.set(result.snapshot.providerMaxSessions);
    }
    if (result.snapshot.configVersion === null) {
      this.metrics.bobLiveCapacityConfigVersion.remove();
    } else {
      this.metrics.bobLiveCapacityConfigVersion.set(result.snapshot.configVersion);
    }
    this.metrics.bobLiveCapacitySnapshotAge.set(Math.max(
      0,
      (Date.now() - Date.parse(result.snapshot.updatedAt)) / 1_000,
    ));
    return true;
  }

  private logUnhealthyOnce(message: string): void {
    if (this.unhealthyLogged) return;
    this.unhealthyLogged = true;
    this.logger.error(message, undefined, RealtimeGlobalCapacityMonitor.name);
  }
}
