import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from './prisma.service';
import { PrismaAuthUserDeletionJobRepository } from './auth-user-deletion-jobs.prisma';

function harness() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(1), $queryRaw: vi.fn() };
  const prisma = {
    inTransaction: vi.fn(() => true),
    client: vi.fn(() => tx),
    withIsolatedGlobal: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  return { repository: new PrismaAuthUserDeletionJobRepository(prisma), prisma, tx };
}

describe('PrismaAuthUserDeletionJobRepository', () => {
  it('projette une demande acceptée et une demande Cabinet refusée', async () => {
    const { repository, tx } = harness();
    tx.$queryRaw
      .mockResolvedValueOnce([
        {
          outcome: 'accepted',
          requestId: '00000000-0000-4000-8000-000000000001',
          status: 'pending',
          alreadyRequested: false,
          rejectionReason: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          outcome: 'rejected',
          requestId: null,
          status: null,
          alreadyRequested: null,
          rejectionReason: 'active_cabinet_memberships',
        },
      ]);

    await expect(
      repository.ensureRequested({
        requestId: '00000000-0000-4000-8000-000000000001',
        companyId: 'company-user-1',
        userId: 'user-1',
        requestedAt: '2026-08-02T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      outcome: 'accepted',
      request: {
        requestId: '00000000-0000-4000-8000-000000000001',
        status: 'pending',
        alreadyRequested: false,
      },
    });
    await expect(
      repository.ensureRequested({
        requestId: '00000000-0000-4000-8000-000000000002',
        companyId: 'company-user-2',
        userId: 'user-2',
        requestedAt: '2026-08-02T00:00:00.000Z',
      }),
    ).resolves.toEqual({ outcome: 'rejected', reason: 'active_cabinet_memberships' });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]!,
    );
  });

  it('refuse toute projection acceptée ambiguë avant de l’exposer au domaine', async () => {
    const { repository, tx } = harness();
    tx.$queryRaw.mockResolvedValue([
      {
        outcome: 'accepted',
        requestId: 'pas-un-uuid',
        status: 'pending',
        alreadyRequested: false,
        rejectionReason: null,
      },
    ]);

    await expect(
      repository.ensureRequested({
        requestId: '00000000-0000-4000-8000-000000000003',
        companyId: 'company-user-3',
        userId: 'user-3',
        requestedAt: '2026-08-02T00:00:00.000Z',
      }),
    ).rejects.toThrow('auth_user_deletion_acceptance_projection_rejected');
  });

  it('refuse un claim dont le binding propriétaire n’est pas canonique', async () => {
    const { repository, tx } = harness();
    tx.$queryRaw.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000004',
        companyId: 'company-victim',
        userId: 'attacker',
        leaseToken: '00000000-0000-4000-8000-000000000005',
        attempts: 1,
      },
    ]);

    await expect(repository.claimDue(25)).rejects.toThrow(
      'auth_user_deletion_claim_projection_rejected',
    );
  });

  it('projette les claims canoniques et applique les CAS complete/retry', async () => {
    const { repository, tx } = harness();
    const claimed = {
      id: '00000000-0000-4000-8000-000000000006',
      companyId: 'company-user-6',
      userId: 'user-6',
      leaseToken: '00000000-0000-4000-8000-000000000007',
      attempts: 2,
    };
    tx.$queryRaw
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([{ result: false }]);

    await expect(repository.claimDue(25)).resolves.toEqual([claimed]);
    await expect(repository.markDone(claimed.id, claimed.leaseToken)).resolves.toBe(true);
    await expect(
      repository.markFailed(claimed.id, claimed.leaseToken, 'http_5xx', 60_000),
    ).resolves.toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index += 1) {
      expect(tx.$executeRaw.mock.invocationCallOrder[index]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[index]!,
      );
    }
  });

  it('exige la transaction tenantée pour créer l’intention', async () => {
    const { repository, prisma } = harness();
    vi.mocked(prisma.inTransaction).mockReturnValue(false);

    await expect(
      repository.ensureRequested({
        requestId: '00000000-0000-4000-8000-000000000008',
        companyId: 'company-user-8',
        userId: 'user-8',
        requestedAt: '2026-08-02T00:00:00.000Z',
      }),
    ).rejects.toThrow('auth_user_deletion_request_requires_tenant_transaction');
  });
});
