import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminPort } from '../auth/supabase-admin';
import { SupabaseUserDeletionError } from '../auth/supabase-admin';
import type { AppLogger } from '../observability/logger';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import {
  AccountAuthDeletionService,
  nextAuthUserDeletionRetryDelayMs,
} from './account-auth-deletion.service';

const NOW = new Date('2026-08-02T10:00:00.000Z');

function logger() {
  return {
    audit: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger;
}

function admin(deleteUser: SupabaseAdminPort['deleteUser']): SupabaseAdminPort {
  return {
    deleteUser,
    setUserCompanyId: vi.fn(),
  } as unknown as SupabaseAdminPort;
}

async function request(
  persistence: InMemoryPersistence,
  suffix: string,
): Promise<void> {
  const result = await persistence.authUserDeletionJobs.ensureRequested({
    requestId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    companyId: `company-user-${suffix}`,
    userId: `user-${suffix}`,
    requestedAt: NOW.toISOString(),
  });
  expect(result.outcome).toBe('accepted');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AccountAuthDeletionService', () => {
  it('tente toute la page, finalise un succès et conserve chaque échec pour retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const persistence = new InMemoryPersistence();
    await request(persistence, '1');
    await request(persistence, '2');
    const deleteUser = vi.fn<SupabaseAdminPort['deleteUser']>(async (userId) => {
      if (userId === 'user-1') throw new SupabaseUserDeletionError('http_429');
    });
    const auditLogger = logger();
    const service = new AccountAuthDeletionService(
      persistence,
      admin(deleteUser),
      auditLogger,
    );

    await expect(service.run()).resolves.toEqual({
      skipped: false,
      claimed: 2,
      completed: 1,
      retried: 1,
      leaseLost: 0,
      operationalFailures: 0,
    });
    expect(deleteUser).toHaveBeenCalledTimes(2);
    expect(new Set(deleteUser.mock.calls.map(([userId]) => userId))).toEqual(
      new Set(['user-1', 'user-2']),
    );
    await expect(
      persistence.authUserDeletionJobs.findByCompanyId('company-user-1'),
    ).resolves.toMatchObject({
      status: 'failed',
      userId: 'user-1',
      attempts: 1,
      lastErrorCode: 'http_429',
      leaseToken: null,
      nextAttemptAt: '2026-08-02T10:01:00.000Z',
    });
    await expect(
      persistence.authUserDeletionJobs.findByCompanyId('company-user-2'),
    ).resolves.toMatchObject({
      status: 'done',
      userId: null,
      attempts: 1,
      lastErrorCode: null,
      leaseToken: null,
      completedAt: NOW.toISOString(),
    });
    for (const call of (auditLogger.audit as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).not.toHaveProperty('userId');
    }
  });

  it('retourne skipped lorsqu’un sweep est déjà en cours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const persistence = new InMemoryPersistence();
    await request(persistence, '3');
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleteUser = vi.fn<SupabaseAdminPort['deleteUser']>(() => providerGate);
    const service = new AccountAuthDeletionService(persistence, admin(deleteUser), logger());

    const first = service.run();
    await vi.waitFor(() => expect(deleteUser).toHaveBeenCalledOnce());
    await expect(service.run()).resolves.toEqual({
      skipped: true,
      claimed: 0,
      completed: 0,
      retried: 0,
      leaseLost: 0,
      operationalFailures: 0,
    });
    release();
    await expect(first).resolves.toMatchObject({ completed: 1 });
  });

  it('compte une lease perdue sans réécrire le job', async () => {
    const persistence = new InMemoryPersistence();
    const repository = persistence.authUserDeletionJobs;
    vi.spyOn(repository, 'claimDue').mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000004',
        companyId: 'company-user-4',
        userId: 'user-4',
        leaseToken: '00000000-0000-4000-8000-000000000005',
        attempts: 1,
      },
    ]);
    vi.spyOn(repository, 'markDone').mockResolvedValue(false);
    const service = new AccountAuthDeletionService(
      persistence,
      admin(vi.fn<SupabaseAdminPort['deleteUser']>().mockResolvedValue()),
      logger(),
    );

    await expect(service.run()).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      retried: 0,
      leaseLost: 1,
      operationalFailures: 0,
    });
  });

  it('continue la page si la persistance du retry échoue pour un job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const persistence = new InMemoryPersistence();
    await request(persistence, '5');
    await request(persistence, '6');
    const originalMarkFailed = persistence.authUserDeletionJobs.markFailed.bind(
      persistence.authUserDeletionJobs,
    );
    vi.spyOn(persistence.authUserDeletionJobs, 'markFailed').mockImplementationOnce(() =>
      Promise.reject(new Error('base indisponible')),
    ).mockImplementation(originalMarkFailed);
    const deleteUser = vi.fn<SupabaseAdminPort['deleteUser']>(async (userId) => {
      if (userId === 'user-5') throw new SupabaseUserDeletionError('network');
    });
    const service = new AccountAuthDeletionService(
      persistence,
      admin(deleteUser),
      logger(),
    );

    await expect(service.run()).resolves.toMatchObject({
      claimed: 2,
      completed: 1,
      retried: 0,
      operationalFailures: 1,
    });
    expect(deleteUser).toHaveBeenCalledTimes(2);
    await expect(
      persistence.authUserDeletionJobs.findByCompanyId('company-user-6'),
    ).resolves.toMatchObject({ status: 'done', userId: null });
  });
});

describe('nextAuthUserDeletionRetryDelayMs', () => {
  it('applique un backoff exponentiel borné entre une et cent-vingt minutes', () => {
    expect(nextAuthUserDeletionRetryDelayMs(1)).toBe(60_000);
    expect(nextAuthUserDeletionRetryDelayMs(2)).toBe(120_000);
    expect(nextAuthUserDeletionRetryDelayMs(8)).toBe(120 * 60_000);
    expect(nextAuthUserDeletionRetryDelayMs(10_000)).toBe(120 * 60_000);
  });
});

describe('InMemoryAuthUserDeletionJobRepository — protocole de lease', () => {
  it('reclaim après expiration avec une nouvelle génération et fence l’ancien worker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const persistence = new InMemoryPersistence();
    await request(persistence, '9');

    const first = await persistence.authUserDeletionJobs.claimDue(1);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ attempts: 1, userId: 'user-9' });
    await expect(persistence.authUserDeletionJobs.claimDue(1)).resolves.toEqual([]);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    const second = await persistence.authUserDeletionJobs.claimDue(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ id: first[0]!.id, attempts: 2, userId: 'user-9' });
    expect(second[0]!.leaseToken).not.toBe(first[0]!.leaseToken);
    await expect(
      persistence.authUserDeletionJobs.markDone(first[0]!.id, first[0]!.leaseToken),
    ).resolves.toBe(false);
    await expect(
      persistence.authUserDeletionJobs.markFailed(
        first[0]!.id,
        first[0]!.leaseToken,
        'unknown',
        60_000,
      ),
    ).resolves.toBe(false);
    await expect(
      persistence.authUserDeletionJobs.markDone(second[0]!.id, second[0]!.leaseToken),
    ).resolves.toBe(true);
    await expect(
      persistence.authUserDeletionJobs.findByCompanyId('company-user-9'),
    ).resolves.toMatchObject({ status: 'done', userId: null, attempts: 2 });
  });
});
