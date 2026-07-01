import { describe, expect, it, vi } from 'vitest';
import type { NotificationPort } from '@bob/core';
import { NotificationDeliveryService } from '../jobs/notification-delivery.service';
import type { AppLogger } from '../observability/logger';
import { InMemoryNotificationJobRepository } from './in-memory';
import { InMemoryPersistence } from './persistence';

const logger = {
  audit: vi.fn(),
  warn: vi.fn(),
} as unknown as AppLogger;

describe('InMemoryNotificationJobRepository', () => {
  it('enqueue de façon idempotente et liste les jobs dus par tenant', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const notification = { channel: 'email' as const, to: 'client@example.com', subject: 'Devis', body: 'Lien' };

    await repo.enqueue({
      id: 'job-1',
      companyId: 'co-1',
      kind: 'quote-signature',
      dedupeKey: 'quote:q-1:token:h-1',
      notification,
      now: '2026-07-01T10:00:00.000Z',
    });
    await repo.enqueue({
      id: 'job-duplicate',
      companyId: 'co-1',
      kind: 'quote-signature',
      dedupeKey: 'quote:q-1:token:h-1',
      notification: { ...notification, subject: 'Devis relancé' },
      now: '2026-07-01T10:01:00.000Z',
    });
    await repo.enqueue({
      id: 'job-other-tenant',
      companyId: 'co-2',
      kind: 'quote-signature',
      dedupeKey: 'quote:q-1:token:h-1',
      notification,
      now: '2026-07-01T10:00:00.000Z',
    });

    const due = await repo.listDue('co-1', '2026-07-01T10:01:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]!).toMatchObject({ id: 'job-1', status: 'pending', subject: 'Devis relancé' });
  });

  it('efface le payload après livraison réussie', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const input = {
      id: 'job-1',
      companyId: 'co-1',
      kind: 'quote-signature' as const,
      dedupeKey: 'quote:q-1:token:h-1',
      notification: { channel: 'email' as const, to: 'client@example.com', subject: 'Devis', body: 'Lien secret' },
      now: '2026-07-01T10:00:00.000Z',
    };
    await repo.enqueue(input);
    await repo.markDone('job-1', '2026-07-01T10:00:05.000Z');

    expect(await repo.listDue('co-1', '2026-07-01T11:00:00.000Z', 10)).toHaveLength(0);
    const replay = await repo.enqueue({ ...input, id: 'job-replay', now: '2026-07-01T11:00:00.000Z' });
    expect(replay).toMatchObject({ id: 'job-1', status: 'done', notification: null });
  });
});

describe('NotificationDeliveryService', () => {
  it('marque failed puis retry avant de passer done', async () => {
    const persistence = new InMemoryPersistence();
    const notifier = {
      send: vi.fn<NotificationPort['send']>().mockRejectedValueOnce(new Error('brevo down')).mockResolvedValueOnce(undefined),
    } satisfies NotificationPort;
    const service = new NotificationDeliveryService(persistence, notifier, logger);

    const job = await service.enqueue({
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-1:relance:2026-07-01',
      notification: { channel: 'email', to: 'client@example.com', subject: 'Relance', body: 'Merci de régler.' },
    });
    expect(job.notification).not.toBeNull();

    const first = await service.tryDeliver('co-1', { ...job, notification: job.notification! });
    expect(first).toBe(false);
    expect(notifier.send).toHaveBeenCalledTimes(1);

    const due = await persistence.notificationJobs.listDue('co-1', '2030-01-01T00:00:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]!).toMatchObject({ status: 'failed', attempts: 1, lastError: 'brevo down' });

    const second = await service.tryDeliver('co-1', due[0]!);
    expect(second).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(2);
    expect(await persistence.notificationJobs.listDue('co-1', '2030-01-01T00:00:00.000Z', 10)).toHaveLength(0);
  });
});
