import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  authSessionCacheIdentity,
  publishAuthSessionWithCacheFence,
  shouldPurgeAuthSessionCache,
  type AuthSessionCacheIdentity,
  type AuthSessionLike,
} from './auth-session-cache-policy';

function session(
  ownerId: string,
  companyId: string | null,
  accessToken = 'access-token',
): AuthSessionLike & { readonly accessToken: string } {
  return {
    accessToken,
    user: {
      id: ownerId,
      app_metadata: companyId === null ? {} : { company_id: companyId },
    },
  };
}

describe('auth session cache identity', () => {
  it('purge pour A → B même tenant, changement de tenant, logout et login', () => {
    const companyA = authSessionCacheIdentity(session('owner-a', 'company-1'));
    const companyB = authSessionCacheIdentity(session('owner-b', 'company-1'));
    const otherTenant = authSessionCacheIdentity(session('owner-a', 'company-2'));

    expect(shouldPurgeAuthSessionCache(companyA, companyB)).toBe(true);
    expect(shouldPurgeAuthSessionCache(companyA, otherTenant)).toBe(true);
    expect(shouldPurgeAuthSessionCache(companyA, null)).toBe(true);
    expect(shouldPurgeAuthSessionCache(null, companyA)).toBe(true);
    expect(shouldPurgeAuthSessionCache(null, null)).toBe(false);
  });

  it('conserve le cache pendant un refresh du même owner et tenant', () => {
    const before = authSessionCacheIdentity(session('owner-a', 'company-1', 'old-token'));
    const after = authSessionCacheIdentity(session('owner-a', 'company-1', 'new-token'));

    expect(shouldPurgeAuthSessionCache(before, after)).toBe(false);
  });

  it('purge au provisioning null → company du même owner', () => {
    const before = authSessionCacheIdentity(session('owner-a', null));
    const after = authSessionCacheIdentity(session('owner-a', 'company-1'));

    expect(shouldPurgeAuthSessionCache(before, after)).toBe(true);
  });
});

describe('publishAuthSessionWithCacheFence', () => {
  it('vide réellement QueryClient avant de publier une nouvelle identité', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['private', 'owner-a'], { secret: 'A' });
    const order: string[] = [];
    const next = session('owner-b', 'company-1');

    const identity = publishAuthSessionWithCacheFence({
      previousIdentity: authSessionCacheIdentity(session('owner-a', 'company-1')),
      nextSession: next,
      clearCache: () => {
        order.push('clear');
        queryClient.clear();
      },
      publishSession: (published) => {
        order.push('publish');
        expect(published).toBe(next);
        expect(queryClient.getQueryData(['private', 'owner-a'])).toBeUndefined();
      },
    });

    expect(order).toEqual(['clear', 'publish']);
    expect(identity).toEqual({ ownerId: 'owner-b', companyId: 'company-1' });
  });

  it('ne vide pas QueryClient lors du refresh de la même identité', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['private', 'owner-a'], { stable: true });
    const clearCache = vi.fn(() => queryClient.clear());
    const publishSession = vi.fn();
    const previousIdentity: AuthSessionCacheIdentity = {
      ownerId: 'owner-a',
      companyId: 'company-1',
    };

    publishAuthSessionWithCacheFence({
      previousIdentity,
      nextSession: session('owner-a', 'company-1', 'refreshed-token'),
      clearCache,
      publishSession,
    });

    expect(clearCache).not.toHaveBeenCalled();
    expect(publishSession).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(['private', 'owner-a'])).toEqual({ stable: true });
  });
});
