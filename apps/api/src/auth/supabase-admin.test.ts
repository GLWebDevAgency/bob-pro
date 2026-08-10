import { describe, expect, it, vi } from 'vitest';
import {
  HttpSupabaseAdmin,
  MisconfiguredSupabaseAdmin,
  SupabaseUserDeletionError,
  type SupabaseAdminPort,
} from './supabase-admin';
import type { AppLogger } from '../observability/logger';

function logger(): AppLogger {
  return {
    audit: vi.fn(),
  } as unknown as AppLogger;
}

describe('HttpSupabaseAdmin.setUserConfirmedTimeZone', () => {
  it('écrit les trois claims autoritaires dans un unique PUT puis audite', async () => {
    const auditLogger = logger();
    const fetchFn = vi.fn(
      async (_input: string, _init: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    const admin = new HttpSupabaseAdmin(
      auditLogger,
      {
        url: 'https://tenant.supabase.co/',
        serviceRoleKey: 'service-role-test',
      },
      fetchFn,
    );

    await admin.setUserConfirmedTimeZone(
      'user/1',
      'company-1',
      'Europe/Paris',
      '2026-07-31T00:00:00.000Z',
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://tenant.supabase.co/auth/v1/admin/users/user%2F1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      app_metadata: {
        bob_time_zone: 'Europe/Paris',
        bob_time_zone_confirmed_at: '2026-07-31T00:00:00.000Z',
        bob_time_zone_company_id: 'company-1',
      },
    });
    expect(auditLogger.audit).toHaveBeenCalledWith('auth.time_zone_confirmed', {
      userId: 'user/1',
      companyId: 'company-1',
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T00:00:00.000Z',
    });
  });

  it('refuse un fuseau ou un instant non canonique avant tout appel réseau', async () => {
    const fetchFn = vi.fn(
      async (_input: string, _init: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    const admin = new HttpSupabaseAdmin(
      logger(),
      {
        url: 'https://tenant.supabase.co',
        serviceRoleKey: 'service-role-test',
      },
      fetchFn,
    );

    await expect(
      admin.setUserConfirmedTimeZone(
        'user-1',
        'company-1',
        'Europe/Introuvable',
        '2026-07-31',
      ),
    ).rejects.toThrow('Confirmation de fuseau invalide');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('propage une panne GoTrue sans faux succès', async () => {
    const admin = new HttpSupabaseAdmin(
      logger(),
      {
        url: 'https://tenant.supabase.co',
        serviceRoleKey: 'service-role-test',
      },
      vi.fn(
        async (_input: string, _init: RequestInit) =>
          new Response(null, { status: 503 }),
      ),
    );

    await expect(
      admin.setUserConfirmedTimeZone(
        'user-1',
        'company-1',
        'Europe/Paris',
        '2026-07-31T00:00:00.000Z',
      ),
    ).rejects.toThrow('Supabase admin HTTP 503');
  });
});

describe('SupabaseAdmin.deleteUser', () => {
  it.each([
    [204, false],
    [404, true],
  ] as const)('traite HTTP %i comme un succès idempotent sans journaliser le sujet', async (status, alreadyGone) => {
    const auditLogger = logger();
    const fetchFn = vi.fn(async () => new Response(null, { status }));
    const admin = new HttpSupabaseAdmin(
      auditLogger,
      { url: 'https://tenant.supabase.co/', serviceRoleKey: 'service-role-test' },
      fetchFn,
    );

    await expect(admin.deleteUser('user/secret')).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledWith(
      'https://tenant.supabase.co/auth/v1/admin/users/user%2Fsecret',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(auditLogger.audit).toHaveBeenCalledWith('auth.user_deleted', { alreadyGone });
    expect((auditLogger.audit as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).not.toHaveProperty(
      'userId',
    );
  });

  it.each([
    [408, 'http_408'],
    [429, 'http_429'],
    [400, 'http_4xx'],
    [503, 'http_5xx'],
  ] as const)('classe HTTP %i sans exposer le corps fournisseur', async (status, code) => {
    const admin = new HttpSupabaseAdmin(
      logger(),
      { url: 'https://tenant.supabase.co', serviceRoleKey: 'service-role-test' },
      vi.fn(async () => new Response('PII fournisseur à ne pas propager', { status })),
    );

    const failure = await admin.deleteUser('user-secret').catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(SupabaseUserDeletionError);
    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain('PII fournisseur');
  });

  it.each([
    ['AbortError', 'timeout'],
    ['TimeoutError', 'timeout'],
    ['TypeError', 'network'],
  ] as const)('classe une exception %s en %s', async (name, code) => {
    const failure = new Error('secret réseau');
    failure.name = name;
    const admin = new HttpSupabaseAdmin(
      logger(),
      { url: 'https://tenant.supabase.co', serviceRoleKey: 'service-role-test' },
      vi.fn(async () => Promise.reject(failure)),
    );

    await expect(admin.deleteUser('user-secret')).rejects.toMatchObject({ code });
  });

  it('échoue fermé avec une classe durable quand la configuration manque', async () => {
    const admin: SupabaseAdminPort = new MisconfiguredSupabaseAdmin();
    await expect(admin.deleteUser('user-secret')).rejects.toMatchObject({
      code: 'misconfigured',
    });
  });
});
