import { describe, expect, it, vi } from 'vitest';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import { requestContext } from '../observability/logger';
import { NotificationsApiService } from './notifications-api.service';

const TENANT = 'co-test';
// C24b : plus AUCUN repli tenant — les tests posent un Principal explicite (comme le guard en requête).
const asPrincipal = <T>(companyId: string, userId: string, fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ correlationId: 'test', principal: { userId, companyId } }, fn);
const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  asPrincipal(TENANT, 'user-test', fn);

const INSTALLATION_A = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_B = '22222222-2222-4222-8222-222222222222';
const BINDING_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const BINDING_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const BINDING_B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SECRET_A = 'ab'.repeat(32);
const SECRET_B = 'cd'.repeat(32);

function registration(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    expoPushToken: 'ExponentPushToken[abcdef123456]',
    platform: 'ios',
    installationId: INSTALLATION_A,
    bindingId: BINDING_A1,
    bindingGeneration: 1,
    revocationSecret: SECRET_A,
    ...overrides,
  };
}

function revocation(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    installationId: INSTALLATION_A,
    throughGeneration: 1,
    revocationSecret: SECRET_A,
    ...overrides,
  };
}

const ALL_ACTIVE = '1970-01-01T00:00:00.000Z';

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

  it('POST /devices v2 : contrat exact, idempotent et aucune capacité ré-émise', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);

    const bad = await asTenant(() => service.registerDevice(registration({ expoPushToken: 'pas-un-token' })));
    expect(!bad.ok && bad.error.kind).toBe('validation');

    await expect(asTenant(() => service.registerDevice(registration())))
      .resolves.toEqual({ ok: true, value: { status: 'bound' } });
    await expect(asTenant(() => service.registerDevice(registration())))
      .resolves.toEqual({ ok: true, value: { status: 'bound' } });
    const targets = await p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      expoPushToken: 'ExponentPushToken[abcdef123456]',
      bindingId: BINDING_A1,
      bindingGeneration: 1,
    });
    expect(targets[0]).not.toHaveProperty('revocationSecretHash');
  });

  it('refuse qu’un ancien token remplace le token actif à génération égale', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    const tokenA = 'ExponentPushToken[tokenrotation111]';
    const tokenB = 'ExponentPushToken[tokenrotation222]';

    await expect(asTenant(() => service.registerDevice(registration({ expoPushToken: tokenA }))))
      .resolves.toEqual({ ok: true, value: { status: 'bound' } });
    await expect(asTenant(() => service.registerDevice(registration({ expoPushToken: tokenB }))))
      .resolves.toEqual({ ok: true, value: { status: 'superseded' } });
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toMatchObject([
      { expoPushToken: tokenA, bindingId: BINDING_A1, bindingGeneration: 1 },
    ]);

    await expect(asTenant(() => service.registerDevice(registration({
      expoPushToken: tokenB,
      bindingId: BINDING_A2,
      bindingGeneration: 2,
    }))))
      .resolves.toEqual({ ok: true, value: { status: 'bound' } });
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toMatchObject([
      { expoPushToken: tokenB, bindingId: BINDING_A2, bindingGeneration: 2 },
    ]);
  });

  it('exclut fail-closed un Device orphelin dès que son fence actif diverge', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    await asTenant(() => service.registerDevice(registration()));

    const internals = p.devices as unknown as {
      installations: Map<string, {
        revocationSecretHash: string;
        maxGeneration: number;
        currentBindingId: string | null;
        currentCompanyId: string | null;
        currentUserId: string | null;
        lastConfirmedAt: string | null;
      }>;
    };
    const fence = internals.installations.get(INSTALLATION_A);
    expect(fence).toBeDefined();
    internals.installations.set(INSTALLATION_A, { ...fence!, currentBindingId: null });

    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toEqual([]);
  });

  it.each([
    null,
    [],
    registration({ companyId: 'forged' }),
    registration({ platform: 'windows' }),
    registration({ bindingGeneration: 1.5 }),
    registration({ revocationSecret: SECRET_A.toUpperCase() }),
  ])('rejette un body push v2 ambigu, enrichi ou malformé (%j)', async (body) => {
    const service = new NotificationsApiService(new InMemoryPersistence());
    const result = await asTenant(() => service.registerDevice(body));
    expect(!result.ok && result.error.kind).toBe('validation');
  });

  it('transfère un token global, neutralise A et refuse son retry retardé', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    const token = 'ExponentPushToken[tenantrebind123]';

    await expect(asPrincipal('co-a', 'user-a', () => service.registerDevice(registration({ expoPushToken: token }))))
      .resolves.toEqual({ ok: true, value: { status: 'bound' } });
    await expect(asPrincipal('co-b', 'user-b', () => service.registerDevice(registration({
      expoPushToken: token,
      platform: 'android',
      installationId: INSTALLATION_B,
      bindingId: BINDING_B1,
      revocationSecret: SECRET_B,
    }))))
      .resolves.toEqual({ ok: true, value: { status: 'bound' } });
    await expect(asPrincipal('co-a', 'user-a', () => service.registerDevice(registration({ expoPushToken: token }))))
      .resolves.toEqual({ ok: true, value: { status: 'superseded' } });

    await expect(p.devices.listDeliveryTargetsByCompany('co-a', ALL_ACTIVE)).resolves.toEqual([]);
    await expect(p.devices.listDeliveryTargetsByCompany('co-b', ALL_ACTIVE)).resolves.toMatchObject([
      { expoPushToken: token, bindingId: BINDING_B1, bindingGeneration: 1 },
    ]);
  });

  it('la révocation authentifiée écrit le fence avant le premier POST et interdit la résurrection', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    await expect(asTenant(() => service.revokeDeviceBinding(revocation(), 'authenticated')))
      .resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(asTenant(() => service.registerDevice(registration())))
      .resolves.toEqual({ ok: true, value: { status: 'superseded' } });
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toEqual([]);
  });

  it('la révocation publique reste sans oracle et ne retire que la capacité exacte', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    await asTenant(() => service.registerDevice(registration()));

    await expect(service.revokeDeviceBinding(revocation({ revocationSecret: SECRET_B }), 'public'))
      .resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toHaveLength(1);

    await expect(service.revokeDeviceBinding(revocation(), 'public'))
      .resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toEqual([]);
  });

  it('compacte les révocations offline jusqu’à N sans toucher une session serveur N+1', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    await asTenant(() => service.registerDevice(registration()));

    await service.revokeDeviceBinding(revocation({ throughGeneration: 3 }), 'public');
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toEqual([]);
    await expect(asTenant(() => service.registerDevice(registration({
      bindingId: BINDING_A2,
      bindingGeneration: 3,
    })))).resolves.toEqual({ ok: true, value: { status: 'superseded' } });
    await expect(asTenant(() => service.registerDevice(registration({
      bindingId: BINDING_A2,
      bindingGeneration: 4,
    })))).resolves.toEqual({ ok: true, value: { status: 'bound' } });

    await service.revokeDeviceBinding(revocation({ throughGeneration: 3 }), 'public');
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toMatchObject([
      { bindingId: BINDING_A2, bindingGeneration: 4 },
    ]);
  });

  it('rejoue un tombstone public après un POST retardé matérialisé plus tard', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    const throughThree = revocation({ throughGeneration: 3 });

    await service.revokeDeviceBinding(throughThree, 'public'); // absent : réponse one-way, pas de fence
    await asTenant(() => service.registerDevice(registration({
      bindingId: BINDING_A2,
      bindingGeneration: 2,
    })));
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toHaveLength(1);

    await service.revokeDeviceBinding(throughThree, 'public');
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toEqual([]);
  });

  it('une nouvelle génération du même propriétaire révoque aussi le binding actif précédent', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    await asTenant(() => service.registerDevice(registration()));
    await asTenant(() => service.revokeDeviceBinding(revocation({
      throughGeneration: 2,
    }), 'authenticated'));

    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toEqual([]);
    await expect(asTenant(() => service.registerDevice(registration({
      bindingId: BINDING_A2,
      bindingGeneration: 2,
    }))))
      .resolves.toEqual({ ok: true, value: { status: 'superseded' } });
  });

  it('DELETE legacy ne peut pas supprimer un binding v2, même avec son token exact', async () => {
    const p = new InMemoryPersistence();
    const service = new NotificationsApiService(p);
    await asTenant(() => service.registerDevice(registration()));
    await expect(asTenant(() => service.unregisterDevice({
      expoPushToken: 'ExponentPushToken[abcdef123456]',
    }))).resolves.toEqual({ ok: true, value: { unregistered: true } });
    await expect(p.devices.listDeliveryTargetsByCompany(TENANT, ALL_ACTIVE)).resolves.toHaveLength(1);
  });
});
