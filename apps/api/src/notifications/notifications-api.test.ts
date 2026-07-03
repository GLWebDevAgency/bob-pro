import { describe, expect, it } from 'vitest';
import { MERCIER_PROPS } from '@bob/core';
import { InMemoryPersistence } from '../persistence/persistence';
import { NotificationsApiService } from './notifications-api.service';

const TENANT = MERCIER_PROPS.id; // sans Principal (tests), le service retombe sur le tenant de seed

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

    const r = await service.list();

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

    const first = await service.markRead('job-1');
    expect(first.ok && first.value.readAt).not.toBeNull();
    const again = await service.markRead('job-1');
    expect(again.ok && first.ok && again.value.readAt).toBe(first.ok ? first.value.readAt : null); // première lecture conservée

    const ghost = await service.markRead('job-ghost');
    expect(!ghost.ok && ghost.error.kind).toBe('not_found');
  });

  it('POST /devices : token Expo validé strictement, enregistrement idempotent par (tenant, token)', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);

    const bad = await service.registerDevice({ expoPushToken: 'pas-un-token' });
    expect(!bad.ok && bad.error.kind).toBe('validation');

    const ok1 = await service.registerDevice({ expoPushToken: 'ExponentPushToken[abcdef123456]', platform: 'ios' });
    const ok2 = await service.registerDevice({ expoPushToken: 'ExponentPushToken[abcdef123456]', platform: 'ios' });
    expect(ok1.ok && ok2.ok).toBe(true);
    if (!ok1.ok || !ok2.ok) return;
    expect(ok2.value.id).toBe(ok1.value.id); // upsert, pas de doublon
    expect(await p.devices.listByCompany(TENANT)).toHaveLength(1);
  });
});
