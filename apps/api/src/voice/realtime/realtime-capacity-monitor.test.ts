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

  it('boote sous closed exact sans confondre ce rollout avec une autorité active', async () => {
    const metrics = new Metrics();
    const capacity = inspector({ mode: 'closed', usedSessions: 0 });
    const monitor = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      capacity,
      metrics,
      new AppLogger(),
    );

    await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('bob_live_capacity_inspections_total{outcome="closed"} 1');
    expect(exposition).toContain('bob_live_capacity_durable_used 0');
  });

  it('laisse les leases N-1 drainer sous closed et publie les bindings réellement observés', async () => {
    const metrics = new Metrics();
    const monitor = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      inspector({
        mode: 'closed',
        providerModel: 'gpt-realtime-previous',
        globalMaxSessions: 40,
        providerMaxSessions: 45,
        configVersion: 2,
        usedSessions: 3,
      }),
      metrics,
      new AppLogger(),
    );

    await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('bob_live_capacity_durable_used 3');
    expect(exposition).toContain('bob_live_capacity_global_limit 40');
    expect(exposition).toContain('bob_live_capacity_provider_limit 45');
    expect(exposition).toContain('bob_live_capacity_config_version 2');
  });

  it('ne fabrique aucune limite ni version pour un closed non configuré', async () => {
    const metrics = new Metrics();
    const monitor = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      inspector({
        mode: 'closed',
        providerId: null,
        providerModel: null,
        globalMaxSessions: null,
        providerMaxSessions: null,
        configVersion: null,
        retryAfterSeconds: null,
        usedSessions: 3,
      }),
      metrics,
      new AppLogger(),
    );

    await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('bob_live_capacity_durable_used 3');
    expect(exposition).not.toMatch(/^bob_live_capacity_global_limit(?:\{[^}]*\})? /mu);
    expect(exposition).not.toMatch(/^bob_live_capacity_provider_limit(?:\{[^}]*\})? /mu);
    expect(exposition).not.toMatch(/^bob_live_capacity_config_version(?:\{[^}]*\})? /mu);
  });

  it('observe la réouverture active exacte sans redémarrer le processus', async () => {
    const capacity = inspector({ mode: 'closed', usedSessions: 2 });
    const metrics = new Metrics();
    const monitor = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      capacity,
      metrics,
      new AppLogger(),
    );

    await monitor.onApplicationBootstrap();
    vi.mocked(capacity.inspect).mockResolvedValueOnce({
      ok: true,
      snapshot: {
        mode: 'active',
        providerId: 'openai',
        providerModel: 'gpt-realtime-2.1',
        globalMaxSessions: 50,
        providerMaxSessions: 60,
        configVersion: 3,
        retryAfterSeconds: 10,
        usedSessions: 2,
        revision: 12n,
        updatedAt: new Date().toISOString(),
      },
    });
    await monitor.inspectPeriodically();

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('bob_live_capacity_inspections_total{outcome="closed"} 1');
    expect(exposition).toContain('bob_live_capacity_inspections_total{outcome="ok"} 1');
    expect(exposition).toContain('bob_live_capacity_global_limit 50');
    expect(exposition).toContain('bob_live_capacity_config_version 3');
  });

  it('efface les jauges actives devenues indisponibles sous closed non configuré', async () => {
    const capacity = inspector();
    const metrics = new Metrics();
    const monitor = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      capacity,
      metrics,
      new AppLogger(),
    );

    await monitor.onApplicationBootstrap();
    vi.mocked(capacity.inspect).mockResolvedValueOnce({
      ok: true,
      snapshot: {
        mode: 'closed',
        providerId: null,
        providerModel: null,
        globalMaxSessions: null,
        providerMaxSessions: null,
        configVersion: null,
        retryAfterSeconds: null,
        usedSessions: 0,
        revision: 12n,
        updatedAt: new Date().toISOString(),
      },
    });
    await monitor.inspectPeriodically();

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('bob_live_capacity_inspections_total{outcome="ok"} 1');
    expect(exposition).toContain('bob_live_capacity_inspections_total{outcome="closed"} 1');
    expect(exposition).not.toMatch(/^bob_live_capacity_global_limit(?:\{[^}]*\})? /mu);
    expect(exposition).not.toMatch(/^bob_live_capacity_provider_limit(?:\{[^}]*\})? /mu);
    expect(exposition).not.toMatch(/^bob_live_capacity_config_version(?:\{[^}]*\})? /mu);
  });

  it('refuse le boot si PostgreSQL diverge, reste en tracking ou devient indisponible', async () => {
    const mismatch = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      inspector({ configVersion: 2 }),
      new Metrics(),
      new AppLogger(),
    );
    await expect(mismatch.onApplicationBootstrap()).rejects.toThrow(/mismatched/i);

    const tracking = new RealtimeGlobalCapacityMonitor(
      true,
      expected,
      inspector({
        mode: 'tracking',
        providerId: null,
        providerModel: null,
        globalMaxSessions: null,
        providerMaxSessions: null,
        configVersion: null,
        retryAfterSeconds: null,
        usedSessions: 0,
      }),
      new Metrics(),
      new AppLogger(),
    );
    await expect(tracking.onApplicationBootstrap()).rejects.toThrow(/mismatched/i);

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
