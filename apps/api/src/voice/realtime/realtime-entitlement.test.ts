import { describe, expect, it, vi } from 'vitest';
import { getPrincipal } from '../../observability/logger';
import type { Persistence } from '../../persistence/persistence';
import { RealtimeBackendEntitlementAdapter } from './realtime-entitlement';

describe('RealtimeBackendEntitlementAdapter', () => {
  it('vérifie le plan dans une portée identité+tenant fraîche', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, operation: () => Promise<unknown>) => operation());
    const realtimeVoiceEntitlement = vi.fn(async () => {
      expect(getPrincipal()).toEqual({ userId: 'user-1', companyId: 'company-1' });
      return { allowed: true, plan: 'pro' as const };
    });
    const adapter = new RealtimeBackendEntitlementAdapter(
      { runWithTenant } as unknown as Persistence,
      () => ({ realtimeVoiceEntitlement }),
    );

    await expect(adapter.check({ userId: 'user-1', companyId: 'company-1' }))
      .resolves.toEqual({ allowed: true, plan: 'pro' });
    expect(runWithTenant).toHaveBeenCalledWith('company-1', expect.any(Function));
  });

  it('échoue fermé si la source d’abonnement est indisponible', async () => {
    const adapter = new RealtimeBackendEntitlementAdapter(
      {
        runWithTenant: vi.fn(async () => { throw new Error('billing unavailable'); }),
      } as unknown as Persistence,
      () => ({ realtimeVoiceEntitlement: async () => ({ allowed: true, plan: 'business' }) }),
    );

    await expect(adapter.check({ userId: 'user-1', companyId: 'company-1' }))
      .rejects.toThrow('billing unavailable');
  });
});
