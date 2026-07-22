import { describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import type { RealtimeGlobalCapacityInspector } from './realtime-capacity';
import { RealtimeGlobalCapacityMonitor } from './realtime-capacity-monitor';

const expected = {
  providerId: 'openai' as const,
  providerModel: 'gpt-realtime-2.1',
  globalMaxSessions: 50,
  providerMaxSessions: 60,
  configVersion: 3,
};

function inspector(overrides: Record<string, unknown> = {}): RealtimeGlobalCapacityInspector {
  return {
    inspect: vi.fn().mockResolvedValue({
      ok: true,
      snapshot: {
        mode: 'active',
        providerId: 'openai',
        providerModel: 'gpt-realtime-2.1',
        globalMaxSessions: 50,
        providerMaxSessions: 60,
        configVersion: 3,
        retryAfterSeconds: 10,
        usedSessions: 7,
        revision: 11n,
        updatedAt: new Date().toISOString(),
        ...overrides,
      },
    }),
  };
}

describe('RealtimeGlobalCapacityMonitor', () => {
  it('ne touche pas PostgreSQL quand Bob Live est désactivé', async () => {
    const capacity = inspector();
    const monitor = new RealtimeGlobalCapacityMonitor(
      false,
      null,
      capacity,
      new Metrics(),
      new AppLogger(),
    );
    await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(capacity.inspect).not.toHaveBeenCalled();
  });

  it('atteste la configuration exacte au boot et publie les jauges durables', async () => {
    const metrics = new Metrics();
    const capacity = inspector();
    const monitor = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      capacity,
      metrics,
      new AppLogger(),
    );

    await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(capacity.inspect).toHaveBeenCalledOnce();
    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('bob_live_capacity_durable_used 7');
    expect(exposition).toContain('bob_live_capacity_global_limit 50');
    expect(exposition).toContain('bob_live_capacity_provider_limit 60');
    expect(exposition).toContain('bob_live_capacity_config_version 3');
  });

  it('refuse le boot si PostgreSQL diverge ou devient indisponible', async () => {
    const mismatch = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      inspector({ configVersion: 2 }),
      new Metrics(),
      new AppLogger(),
    );
    await expect(mismatch.onApplicationBootstrap()).rejects.toThrow(/mismatched/i);

    const unavailable = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      { inspect: vi.fn().mockResolvedValue({ ok: false, reason: 'unavailable' }) },
      new Metrics(),
      new AppLogger(),
    );
    await expect(unavailable.onApplicationBootstrap()).rejects.toThrow(/unavailable/i);
  });
});
