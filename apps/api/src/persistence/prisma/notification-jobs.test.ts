import { describe, expect, it, vi } from 'vitest';
import {
  NotificationDedupeConflictError,
  notificationPayloadFingerprint,
} from '../notification-jobs';
import { PrismaNotificationJobRepository } from './repositories';
import type { PrismaService } from './prisma.service';

const JOB_ID = '79e27b85-d458-445e-a759-e8b1a49e1641';
const OTHER_JOB_ID = 'f0853d12-13e0-4c37-90df-3a66131fa3d9';
const NOW = new Date('2026-07-13T02:00:00.000Z');
const NOTIFICATION = {
  channel: 'email' as const,
  to: 'client@example.com',
  subject: 'Relance F-1',
  body: 'Merci de régler.',
  idempotencyKey: JOB_ID,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    companyId: 'co-1',
    kind: 'invoice-relance',
    dedupeKey: 'invoice:inv-1:relance:auto:v1:cordial',
    channel: 'email',
    recipient: NOTIFICATION.to,
    subject: NOTIFICATION.subject,
    payload: NOTIFICATION,
    payloadFingerprint: notificationPayloadFingerprint(NOTIFICATION),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    providerAttemptedAt: null,
    lastError: null,
    readAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    companyId: 'co-1',
    kind: 'invoice-relance' as const,
    dedupeKey: 'invoice:inv-1:relance:auto:v1:cordial',
    notification: NOTIFICATION,
    now: NOW.toISOString(),
    ...overrides,
  };
}

describe('PrismaNotificationJobRepository — fidélité de l’outbox', () => {
  it('persiste la clé provider possédée par le job et une empreinte immuable', async () => {
    const notificationJob = {
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(row()),
      createMany: vi.fn(async () => ({ count: 1 })),
    };
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ notificationJob }),
    } as unknown as PrismaService);

    const job = await repository.enqueue(input());

    expect(job.notification?.idempotencyKey).toBe(JOB_ID);
    expect(job.payloadFingerprint).toBe(notificationPayloadFingerprint(NOTIFICATION));
    expect(notificationJob.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [expect.objectContaining({
        id: JOB_ID,
        payloadFingerprint: notificationPayloadFingerprint(NOTIFICATION),
      })],
    }));
  });

  it('findById applique le tenant dans la requête et masque les autres tenants', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ notificationJob: { findFirst } }),
    } as unknown as PrismaService);

    await expect(repository.findById('co-1', JOB_ID)).resolves.toMatchObject({
      id: JOB_ID,
      companyId: 'co-1',
      subject: NOTIFICATION.subject,
      notification: { body: NOTIFICATION.body },
    });
    await expect(repository.findById('co-2', JOB_ID)).resolves.toBeNull();
    expect(findFirst).toHaveBeenNthCalledWith(1, { where: { id: JOB_ID, companyId: 'co-1' } });
    expect(findFirst).toHaveBeenNthCalledWith(2, { where: { id: JOB_ID, companyId: 'co-2' } });
  });

  it('snapshot et batch utilisent l’horloge DB, le tenant et une borne exclusive', async () => {
    const cutoff = '2026-07-13T02:00:00.000Z';
    const readAt = '2026-07-13T02:01:00.000Z';
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ unreadCount: 73, throughCreatedAt: new Date(cutoff) }])
      .mockResolvedValueOnce([{ updatedCount: 73, readAt: new Date(readAt), cutoffAccepted: true }]);
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ $queryRaw: queryRaw }),
    } as unknown as PrismaService);

    await expect(repository.previewUnread('co-1', '2099-01-01T00:00:00.000Z')).resolves.toEqual({
      unreadCount: 73,
      throughCreatedAt: cutoff,
    });
    await expect(repository.markReadThrough('co-1', cutoff, '2099-01-01T00:00:00.000Z')).resolves.toEqual({
      updatedCount: 73,
      readAt,
      cutoffAccepted: true,
    });

    const previewSql = (queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    const batchSql = (queryRaw.mock.calls[1]![0] as TemplateStringsArray).join('?');
    expect(previewSql).toContain('statement_timestamp()');
    expect(previewSql).toContain('job."createdAt" < cutoff.value');
    expect(batchSql).toContain('job."companyId" =');
    expect(batchSql).toContain('job."readAt" IS NULL');
    expect(batchSql).toContain('job."createdAt" < timing.cutoff');
  });

  it('markRead concurrent conserve le premier instant via updateMany tenant-scoped', async () => {
    let persistedReadAt: Date | null = null;
    const updateMany = vi.fn(async (args: { data: { readAt: Date } }) => {
      if (persistedReadAt !== null) return { count: 0 };
      persistedReadAt = args.data.readAt;
      return { count: 1 };
    });
    const findFirst = vi.fn(async () => row({ readAt: persistedReadAt }));
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ notificationJob: { updateMany, findFirst } }),
    } as unknown as PrismaService);

    const [first, second] = await Promise.all([
      repository.markRead(JOB_ID, 'co-1', '2026-07-13T02:01:00.000Z'),
      repository.markRead(JOB_ID, 'co-1', '2026-07-13T02:02:00.000Z'),
    ]);

    expect(first?.readAt).toBe('2026-07-13T02:01:00.000Z');
    expect(second?.readAt).toBe('2026-07-13T02:01:00.000Z');
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: JOB_ID, companyId: 'co-1', readAt: null },
      data: {
        readAt: new Date('2026-07-13T02:01:00.000Z'),
        updatedAt: new Date('2026-07-13T02:01:00.000Z'),
      },
    });
  });

  it('refuse une collision de dedupeKey avec un payload différent', async () => {
    const notificationJob = {
      findUnique: vi.fn(async () => row()),
      updateMany: vi.fn(),
    };
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ notificationJob }),
    } as unknown as PrismaService);

    await expect(repository.enqueue(input({
      id: OTHER_JOB_ID,
      notification: {
        ...NOTIFICATION,
        subject: 'Autre intention',
        idempotencyKey: OTHER_JOB_ID,
      },
    }))).rejects.toBeInstanceOf(NotificationDedupeConflictError);
    expect(notificationJob.updateMany).not.toHaveBeenCalled();
  });

  it('retourne le gagnant concurrent seulement si son intention est identique', async () => {
    const winnerNotification = { ...NOTIFICATION, idempotencyKey: JOB_ID };
    const winner = row({ payload: winnerNotification });
    const notificationJob = {
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
      createMany: vi.fn(async () => ({ count: 0 })),
    };
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ notificationJob }),
    } as unknown as PrismaService);

    const result = await repository.enqueue(input());

    expect(result.id).toBe(JOB_ID);
    expect(result.notification?.idempotencyKey).toBe(JOB_ID);
    expect(notificationJob.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it('ne raccourcit pas un lease actif lors d’un ré-enqueue identique', async () => {
    const leaseUntil = new Date('2026-07-13T02:05:00.000Z');
    const existing = row({ nextAttemptAt: leaseUntil, leaseToken: 'active-generation' });
    const notificationJob = {
      findUnique: vi.fn(async () => existing),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ notificationJob }),
    } as unknown as PrismaService);

    const result = await repository.enqueue(input());

    expect(result).toMatchObject({ nextAttemptAt: leaseUntil.toISOString(), leaseToken: 'active-generation' });
    expect(notificationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseToken: null, nextAttemptAt: { lte: NOW } }),
      data: expect.not.objectContaining({ payload: expect.anything() }),
    }));
  });

  it('claim atomique : PostgreSQL choisit claimed et ancre la première tentative', async () => {
    const claimed = row({
      nextAttemptAt: new Date('2026-07-13T02:05:00.000Z'),
      leaseToken: 'lease-token-1',
      providerAttemptedAt: NOW,
    });
    const queryRaw = vi.fn(async () => [{ quarantined: false, channelWithoutIdempotency: false }]);
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ notificationJob: { findUnique: vi.fn(async () => claimed) }, $queryRaw: queryRaw }),
    } as unknown as PrismaService);

    await expect(repository.claimForDelivery(
      JOB_ID,
      'co-1',
      NOW.toISOString(),
      NOW.toISOString(),
      '2026-07-13T02:05:00.000Z',
      'lease-token-1',
    )).resolves.toMatchObject({
      outcome: 'claimed',
      job: { id: JOB_ID, providerAttemptedAt: NOW.toISOString(), leaseToken: 'lease-token-1' },
    });
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('claim atomique : une tentative hors fenêtre est mise en quarantaine sans relire le payload', async () => {
    const findUnique = vi.fn();
    const queryRaw = vi.fn(async () => [{ quarantined: true, channelWithoutIdempotency: false }]);
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ notificationJob: { findUnique }, $queryRaw: queryRaw }),
    } as unknown as PrismaService);

    await expect(repository.claimForDelivery(
      JOB_ID,
      'co-1',
      NOW.toISOString(),
      '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:05:00.000Z',
      'lease-token-2',
    )).resolves.toEqual({ outcome: 'quarantined', reason: 'provider-window-expired' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('autorise avec l’horloge DB puis planifie un retry DB-time sous le même fence', async () => {
    const queryRaw = vi.fn(async () => [{ authorized: true }]);
    const executeRaw = vi.fn(async () => 1);
    const repository = new PrismaNotificationJobRepository({
      client: () => ({ $queryRaw: queryRaw, $executeRaw: executeRaw }),
    } as unknown as PrismaService);

    await expect(repository.authorizeDeliveryAttempt(
      JOB_ID,
      'co-1',
      'lease-token-1',
      '2099-01-01T00:00:00.000Z',
    )).resolves.toBe(true);
    await expect(repository.markFailed(
      JOB_ID,
      'co-1',
      'lease-token-1',
      '2099-01-01T00:00:00.000Z',
      60_000,
      'timeout',
    )).resolves.toBe(true);
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledOnce();
  });
});
