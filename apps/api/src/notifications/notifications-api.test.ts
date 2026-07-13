import { describe, expect, it, vi } from 'vitest';
import { InMemoryPersistence } from '../persistence/persistence';
import { requestContext } from '../observability/logger';
import { NotificationsApiService } from './notifications-api.service';

const TENANT = 'co-test';
// C24b : plus AUCUN repli tenant — les tests posent un Principal explicite (comme le guard en requête).
const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ correlationId: 'test', principal: { userId: 'user-test', companyId: TENANT } }, fn);

async function seedJob(p: InMemoryPersistence, id: string, dedupeKey: string, at: string): Promise<void> {
  await p.notificationJobs.enqueue({
    id,
    companyId: TENANT,
    kind: 'invoice-relance',
    dedupeKey,
    notification: { channel: 'email', to: 'client@example.com', subject: `Relance ${id}`, body: 'Merci de régler.' },
    now: at,
  });
}

describe('NotificationsApiService — fil company-scoped (C25)', () => {
  it('GET /notifications : items récents avec deep link dérivé et lu/non-lu', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    await seedJob(p, 'job-1', 'invoice:inv-1:relance:2026-07-01', '2026-07-01T06:00:00.000Z');
    await seedJob(p, 'job-2', 'invoice:inv-2:relance:2026-07-03', '2026-07-03T06:00:00.000Z');
    await p.notificationJobs.enqueue({
      id: 'job-autre-tenant',
      companyId: 'co-intrus',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-9:relance:2026-07-03',
      notification: { channel: 'email', to: 'x@example.com', subject: 'X', body: 'X' },
      now: '2026-07-03T07:00:00.000Z',
    });

    const r = await asTenant(() => service.list());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((n) => n.id)).toEqual(['job-2', 'job-1']); // récents d'abord, tenant seul
    expect(r.value[0]).toMatchObject({
      kind: 'invoice-relance',
      title: 'Relance job-2',
      route: '/facture/inv-2',
      readAt: null,
      status: 'pending',
    });
  });

  it('POST /notifications/:id/read : idempotent, refuse un job hors tenant (anti-IDOR)', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    await seedJob(p, 'job-1', 'invoice:inv-1:relance:2026-07-03', '2026-07-03T06:00:00.000Z');
    await p.notificationJobs.enqueue({
      id: 'job-other-tenant',
      companyId: 'co-intrus',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-secret:relance:2026-07-03',
      notification: { channel: 'email', to: 'secret@example.com', subject: 'Secret', body: 'Secret' },
      now: '2026-07-03T06:00:00.000Z',
    });

    const first = await asTenant(() => service.markRead('job-1'));
    expect(first.ok && first.value.readAt).not.toBeNull();
    const again = await asTenant(() => service.markRead('job-1'));
    expect(again.ok && first.ok && again.value.readAt).toBe(first.ok ? first.value.readAt : null); // première lecture conservée

    const ghost = await asTenant(() => service.markRead('job-ghost'));
    expect(!ghost.ok && ghost.error.kind).toBe('not_found');
    const otherTenant = await asTenant(() => service.markRead('job-other-tenant'));
    expect(!otherTenant.ok && otherTenant.error.kind).toBe('not_found');
    await expect(p.notificationJobs.findById('co-intrus', 'job-other-tenant')).resolves.toMatchObject({
      readAt: null,
    });
  });

  it('aperçu + read-through : portée figée, tenant seul, égalité/futur exclus et rejeu idempotent', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
      const p = new InMemoryPersistence();
      const service = new NotificationsApiService(p);
      await seedJob(p, 'job-old-1', 'invoice:inv-old-1:relance:2026-07-13', '2026-07-13T09:59:59.000Z');
      await seedJob(p, 'job-old-2', 'invoice:inv-old-2:relance:2026-07-13', '2026-07-13T09:59:59.999Z');
      await p.notificationJobs.enqueue({
        id: 'job-other-company',
        companyId: 'co-intrus',
        kind: 'invoice-relance',
        dedupeKey: 'invoice:inv-other:relance:2026-07-13',
        notification: { channel: 'email', to: 'other@example.com', subject: 'Autre', body: 'Autre' },
        now: '2026-07-13T09:00:00.000Z',
      });

      const preview = await asTenant(() => service.unreadPreview());
      expect(preview).toEqual({
        ok: true,
        value: { unreadCount: 2, throughCreatedAt: '2026-07-13T10:00:00.000Z' },
      });
      if (!preview.ok) return;

      // Insertion concurrente à la même milliseconde puis après : toutes deux hors snapshot.
      await seedJob(p, 'job-at-cutoff', 'invoice:inv-at:relance:2026-07-13', preview.value.throughCreatedAt);
      await seedJob(p, 'job-after-cutoff', 'invoice:inv-after:relance:2026-07-13', '2026-07-13T10:00:00.001Z');

      const forgedFuture = await asTenant(() =>
        service.markReadThrough({ throughCreatedAt: '2026-07-13T10:00:00.001Z' }),
      );
      expect(!forgedFuture.ok && forgedFuture.error.kind).toBe('validation');
      await expect(p.notificationJobs.findById(TENANT, 'job-old-1')).resolves.toMatchObject({ readAt: null });

      const marked = await asTenant(() =>
        service.markReadThrough({ throughCreatedAt: preview.value.throughCreatedAt }),
      );
      expect(marked).toEqual({
        ok: true,
        value: { updatedCount: 2, readAt: '2026-07-13T10:00:00.000Z' },
      });
      const replay = await asTenant(() =>
        service.markReadThrough({ throughCreatedAt: preview.value.throughCreatedAt }),
      );
      expect(replay.ok && replay.value.updatedCount).toBe(0);
      await expect(p.notificationJobs.findById(TENANT, 'job-at-cutoff')).resolves.toMatchObject({ readAt: null });
      await expect(p.notificationJobs.findById(TENANT, 'job-after-cutoff')).resolves.toMatchObject({ readAt: null });
      await expect(p.notificationJobs.findById('co-intrus', 'job-other-company')).resolves.toMatchObject({ readAt: null });

      const malformed = await asTenant(() => service.markReadThrough({ throughCreatedAt: 'demain' }));
      expect(!malformed.ok && malformed.error.kind).toBe('validation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('POST /devices : token Expo validé strictement, enregistrement idempotent par (tenant, token)', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);

    const bad = await asTenant(() => service.registerDevice({ expoPushToken: 'pas-un-token' }));
    expect(!bad.ok && bad.error.kind).toBe('validation');

    const ok1 = await asTenant(() => service.registerDevice({ expoPushToken: 'ExponentPushToken[abcdef123456]', platform: 'ios' }));
    const ok2 = await asTenant(() => service.registerDevice({ expoPushToken: 'ExponentPushToken[abcdef123456]', platform: 'ios' }));
    expect(ok1.ok && ok2.ok).toBe(true);
    if (!ok1.ok || !ok2.ok) return;
    expect(ok2.value.id).toBe(ok1.value.id); // upsert, pas de doublon
    expect(await p.devices.listByCompany(TENANT)).toHaveLength(1);
  });
});
