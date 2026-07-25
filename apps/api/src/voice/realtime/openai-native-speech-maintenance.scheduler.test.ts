import { describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../../observability/logger';
import type { OpenAiNativeSpeechMaintenancePort } from './openai-native-speech-maintenance';
import { OpenAiNativeSpeechMaintenanceScheduler } from './openai-native-speech-maintenance.scheduler';

const CLAIM = '00000000-0000-4000-8000-000000000099';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(
  companyIds: string[],
  overrides: Partial<OpenAiNativeSpeechMaintenancePort> = {},
  options: { maxTenantsPerSweep?: number; maxBatchesPerSweep?: number } = {},
) {
  const maintenance: OpenAiNativeSpeechMaintenancePort = {
    listDueCompanyIds: vi.fn(async () => ({
      status: 'succeeded' as const,
      companyIds,
      hasMore: false,
      claimId: companyIds.length > 0 ? CLAIM : null,
    })),
    acknowledgeDueCompanyIds: vi.fn(async () => ({
      status: 'succeeded' as const,
      acknowledged: true,
    })),
    renewDueCompanyIdsClaim: vi.fn(async () => ({
      status: 'succeeded' as const,
      renewed: true,
    })),
    reapExpired: vi.fn(async () => ({
      status: 'succeeded' as const,
      expiredCount: 0,
      hasMore: false,
    })),
    purgeRetained: vi.fn(async () => ({
      status: 'succeeded' as const,
      purgedCount: 0,
      dependenciesBlocked: 0,
      hasMore: false,
    })),
    ...overrides,
  };
  const logger = { audit: vi.fn() } as unknown as AppLogger;
  const scheduler = new OpenAiNativeSpeechMaintenanceScheduler(
    maintenance,
    logger,
    {
      maxTenantsPerSweep: options.maxTenantsPerSweep ?? 100,
      maxBatchesPerSweep: options.maxBatchesPerSweep ?? 200,
      expiryLimitPerTenant: 100,
      retentionLimitPerTenant: 100,
      shutdownGraceMs: 1_000,
    },
  );
  return { scheduler, maintenance, logger };
}

describe('OpenAiNativeSpeechMaintenanceScheduler', () => {
  it('découvre les tenants dus depuis PostgreSQL sans settings Bob Live ni JOB_COMPANY_IDS', async () => {
    const { scheduler, maintenance } = harness(['company-2', 'company-1']);
    vi.mocked(maintenance.reapExpired)
      .mockResolvedValueOnce({ status: 'succeeded', expiredCount: 2, hasMore: false })
      .mockResolvedValueOnce({ status: 'succeeded', expiredCount: 3, hasMore: false });

    await expect(scheduler.sweepExpiry()).resolves.toEqual({
      skipped: false,
      tenants: 2,
      batches: 2,
      expired: 5,
      saturatedTenants: 0,
      unavailableTenants: 0,
      discoveryUnavailable: false,
      discoverySaturated: false,
      claimUnacknowledged: false,
    });
    expect(maintenance.listDueCompanyIds).toHaveBeenCalledWith({ lane: 'expiry', limit: 100 });
    expect(maintenance.reapExpired).toHaveBeenNthCalledWith(1, {
      companyId: 'company-2', limit: 100,
    });
    expect(maintenance.reapExpired).toHaveBeenNthCalledWith(2, {
      companyId: 'company-1', limit: 100,
    });
    expect(maintenance.acknowledgeDueCompanyIds).toHaveBeenCalledWith({
      lane: 'expiry', claimId: CLAIM,
    });
  });

  it('traite un lot par tenant puis ACK la page sans laisser un gros tenant affamer les autres', async () => {
    const { scheduler, maintenance } = harness(['company-1', 'company-2']);
    vi.mocked(maintenance.reapExpired)
      .mockResolvedValueOnce({ status: 'succeeded', expiredCount: 100, hasMore: true })
      .mockResolvedValueOnce({ status: 'succeeded', expiredCount: 1, hasMore: false })
      .mockResolvedValueOnce({ status: 'succeeded', expiredCount: 100, hasMore: true })
      .mockResolvedValueOnce({ status: 'succeeded', expiredCount: 23, hasMore: false });

    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({
      tenants: 2,
      batches: 2,
      expired: 101,
      saturatedTenants: 1,
    });
    expect(vi.mocked(maintenance.reapExpired).mock.calls.map(([input]) => input.companyId))
      .toEqual(['company-1', 'company-2']);
    expect(maintenance.acknowledgeDueCompanyIds).toHaveBeenCalledOnce();
  });

  it('borne un backlog persistant et l’expose comme saturation', async () => {
    const { scheduler, maintenance, logger } = harness(
      ['company-1'],
      {
        reapExpired: vi.fn(async () => ({
          status: 'succeeded' as const,
          expiredCount: 100,
          hasMore: true,
        })),
      },
      { maxTenantsPerSweep: 1, maxBatchesPerSweep: 3 },
    );

    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({
      batches: 1,
      expired: 100,
      saturatedTenants: 1,
    });
    expect(maintenance.reapExpired).toHaveBeenCalledOnce();
    expect(logger.audit).toHaveBeenCalledWith(
      'bob.live.openai_native.expiry_sweep',
      expect.objectContaining({ saturatedTenants: 1 }),
    );
  });

  it('expose une page globale saturée puis traite le tenant suivant au sweep durable suivant', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => `company-${index + 1}`);
    const { scheduler, maintenance, logger } = harness(firstPage);
    vi.mocked(maintenance.listDueCompanyIds)
      .mockResolvedValueOnce({
        status: 'succeeded', companyIds: firstPage, hasMore: true, claimId: CLAIM,
      })
      .mockResolvedValueOnce({
        status: 'succeeded', companyIds: ['company-101'], hasMore: false, claimId: CLAIM,
      });

    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({
      tenants: 100,
      batches: 100,
      discoverySaturated: true,
    });
    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({
      tenants: 1,
      batches: 1,
      discoverySaturated: false,
    });
    expect(maintenance.reapExpired).toHaveBeenCalledTimes(101);
    expect(logger.audit).toHaveBeenCalledWith(
      'bob.live.openai_native.expiry_sweep',
      expect.objectContaining({ discoverySaturated: true }),
    );
  });

  it('isole indisponibilité et exception sans journaliser tenant ni détail SQL', async () => {
    const sensitive = 'tenant-secret-SQL';
    const { scheduler, maintenance, logger } = harness(['company-1', 'company-2']);
    vi.mocked(maintenance.reapExpired)
      .mockRejectedValueOnce(new Error(sensitive))
      .mockResolvedValueOnce({ status: 'unavailable' });

    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({
      unavailableTenants: 2,
      claimUnacknowledged: false,
    });
    expect(JSON.stringify(vi.mocked(logger.audit).mock.calls)).not.toContain(sensitive);
    expect(JSON.stringify(vi.mocked(logger.audit).mock.calls)).not.toContain('company-');
    // Sémantique reaper : la page ENTIÈREMENT TENTÉE est acquittée malgré les échecs —
    // les tenants en panne restent dus et seront redécouverts, sans figer le lane (ni le
    // retrait des versions de clés) pour les autres tenants.
    expect(maintenance.acknowledgeDueCompanyIds).toHaveBeenCalledWith({
      lane: 'expiry',
      claimId: expect.any(String),
    });
  });

  it('ne perd jamais une page non acquittée et expose un ACK devenu obsolète', async () => {
    const { scheduler, logger } = harness(['company-1'], {
      acknowledgeDueCompanyIds: vi.fn(async () => ({
        status: 'succeeded' as const, acknowledged: false,
      })),
    });

    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({
      expired: 0,
      claimUnacknowledged: true,
    });
    expect(logger.audit).toHaveBeenCalledWith(
      'bob.live.openai_native.expiry_sweep',
      expect.objectContaining({ claimUnacknowledged: true }),
    );
  });

  it('cesse avant mutation si le heartbeat prouve que le claim a été repris', async () => {
    const { scheduler, maintenance } = harness(['company-1'], {
      renewDueCompanyIdsClaim: vi.fn(async () => ({
        status: 'succeeded' as const, renewed: false,
      })),
    });

    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({
      batches: 0,
      claimUnacknowledged: true,
    });
    expect(maintenance.reapExpired).not.toHaveBeenCalled();
    expect(maintenance.acknowledgeDueCompanyIds).not.toHaveBeenCalled();
  });

  it('échoue fermé si la découverte globale est indisponible', async () => {
    const { scheduler, maintenance, logger } = harness([], {
      listDueCompanyIds: vi.fn(async () => ({ status: 'unavailable' as const })),
    });

    await expect(scheduler.sweepRetention()).resolves.toMatchObject({
      batches: 0,
      purged: 0,
      discoveryUnavailable: true,
    });
    expect(maintenance.purgeRetained).not.toHaveBeenCalled();
    expect(logger.audit).toHaveBeenCalledOnce();
  });

  it('purge un lot borné et laisse le prochain cycle reprendre un tenant saturé', async () => {
    const { scheduler, maintenance } = harness(['company-1']);
    vi.mocked(maintenance.purgeRetained)
      .mockResolvedValueOnce({
        status: 'succeeded', purgedCount: 100, dependenciesBlocked: 1, hasMore: true,
      })
      .mockResolvedValueOnce({
        status: 'succeeded', purgedCount: 7, dependenciesBlocked: 1, hasMore: false,
      });

    await expect(scheduler.sweepRetention()).resolves.toMatchObject({
      batches: 1,
      purged: 100,
      dependenciesBlocked: 1,
      saturatedTenants: 1,
    });
    // Les purges bloquées par dépendance restent dues (leurs lignes persistent) : elles
    // n'empêchent pas l'acquittement de la page ni l'avancée des autres tenants.
    expect(maintenance.acknowledgeDueCompanyIds).toHaveBeenCalledWith({
      lane: 'retention',
      claimId: expect.any(String),
    });
  });

  it('ne chevauche pas une même lane tout en laissant les deux lanes avancer', async () => {
    const expiry = deferred<{ status: 'succeeded'; expiredCount: number; hasMore: boolean }>();
    const retention = deferred<{
      status: 'succeeded'; purgedCount: number; dependenciesBlocked: number; hasMore: boolean;
    }>();
    const { scheduler } = harness(['company-1'], {
      reapExpired: vi.fn(() => expiry.promise),
      purgeRetained: vi.fn(() => retention.promise),
    });

    const firstExpiry = scheduler.sweepExpiry();
    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({ skipped: true });
    const firstRetention = scheduler.sweepRetention();
    await expect(scheduler.sweepRetention()).resolves.toMatchObject({ skipped: true });

    expiry.resolve({ status: 'succeeded', expiredCount: 1, hasMore: false });
    retention.resolve({
      status: 'succeeded', purgedCount: 1, dependenciesBlocked: 0, hasMore: false,
    });
    await expect(firstExpiry).resolves.toMatchObject({ expired: 1 });
    await expect(firstRetention).resolves.toMatchObject({ purged: 1 });
  });

  it('pose le fence shutdown avant d’attendre et n’ouvre plus de transaction suivante', async () => {
    const first = deferred<{ status: 'succeeded'; expiredCount: number; hasMore: boolean }>();
    const { scheduler, maintenance } = harness(['company-1', 'company-2'], {
      reapExpired: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue({ status: 'succeeded', expiredCount: 1, hasMore: false }),
    });
    const running = scheduler.sweepExpiry();
    await vi.waitFor(() => expect(maintenance.reapExpired).toHaveBeenCalledOnce());
    const shutdown = scheduler.onApplicationShutdown();

    await expect(scheduler.sweepRetention()).resolves.toMatchObject({ skipped: true });
    first.resolve({ status: 'succeeded', expiredCount: 1, hasMore: true });
    await Promise.all([running, shutdown]);
    expect(maintenance.reapExpired).toHaveBeenCalledOnce();
    await expect(scheduler.sweepExpiry()).resolves.toMatchObject({ skipped: true });
  });
});
