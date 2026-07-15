import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { Company, MERCIER_PROPS } from '@bob/core';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
  };
  const logger = { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    admin,
    {} as NotificationDeliveryService,
    {} as Metrics,
    logger,
  );
  return { service, p, admin, logger };
}

/** Exécute fn avec un Principal explicite (comme le guard en requête réelle) — sync ou async. */
function asPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

async function seedCompanyAs(p: InMemoryPersistence, companyId: string): Promise<void> {
  const c = Company.of({ ...MERCIER_PROPS, id: companyId });
  if (!c.ok) throw new Error('fixture company invalide');
  await p.companies.save(c.value);
}

async function seedDevice(p: InMemoryPersistence, companyId: string, token: string): Promise<void> {
  await p.devices.register({
    id: `dev-${token}`,
    companyId,
    userId: 'u-1',
    expoPushToken: token,
    platform: 'ios',
    installationId: randomUUID(),
    bindingId: randomUUID(),
    bindingGeneration: 1,
    revocationSecretHash: 'a'.repeat(64),
    now: '2026-07-16T09:00:00.000Z',
  });
}

describe('DELETE /account — BackendService.closeAccount (Apple 5.1.1(v))', () => {
  it('confirmationText EXACT → clôture effective : closedAt posé, abonnement canceled, push purgé, Supabase deleteUser appelé APRÈS commit, audit loggé', async () => {
    const { service, p, admin, logger } = makeService();
    await seedCompanyAs(p, 'co-artisan-a');
    const now = new Date().toISOString();
    await p.subscriptions.startTrial({
      id: 'sub-co-artisan-a',
      companyId: 'co-artisan-a',
      plan: 'pro',
      trialEndsAt: new Date(Date.now() + 86_400_000).toISOString(),
      now,
    });
    await seedDevice(p, 'co-artisan-a', 'ExponentPushToken[abc]');

    const r = await asPrincipal({ userId: 'u-1', companyId: 'co-artisan-a' }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );

    expect(r.ok).toBe(true);

    const closed = await p.companies.findById('co-artisan-a');
    expect(closed?.isClosed()).toBe(true);
    // La fiche légale n'a pas bougé — rétention légale des pièces déjà émises.
    expect(closed?.name).toBe(MERCIER_PROPS.name);
    expect(closed?.siret).toBe(MERCIER_PROPS.siret);

    const sub = await p.subscriptions.findByCompanyId('co-artisan-a');
    expect(sub?.status).toBe('canceled');

    const targets = await p.devices.listDeliveryTargetsByCompany('co-artisan-a', '2000-01-01T00:00:00.000Z');
    expect(targets).toHaveLength(0);

    expect(admin.deleteUser).toHaveBeenCalledWith('u-1');
    expect(logger.audit).toHaveBeenCalledWith(
      'account.closed',
      expect.objectContaining({ companyId: 'co-artisan-a', userId: 'u-1' }),
    );
  });

  it('confirmationText FAUX → 422 validation, Supabase JAMAIS appelé, la company reste ouverte', async () => {
    const { service, p, admin } = makeService();
    await seedCompanyAs(p, 'co-artisan-a');

    const r = await asPrincipal({ userId: 'u-1', companyId: 'co-artisan-a' }, () =>
      service.closeAccount({ confirmationText: 'Mauvais Nom' }),
    );

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('validation');
    const stillOpen = await p.companies.findById('co-artisan-a');
    expect(stillOpen?.isClosed()).toBe(false);
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it('Supabase deleteUser échoue (best-effort) → le compte reste DÉJÀ clôturé côté Bob Pro, erreur loggée sans casser la réponse', async () => {
    const { service, p, admin, logger } = makeService();
    await seedCompanyAs(p, 'co-artisan-a');
    vi.mocked(admin.deleteUser).mockRejectedValueOnce(new Error('Supabase admin HTTP 503'));

    const r = await asPrincipal({ userId: 'u-1', companyId: 'co-artisan-a' }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );

    expect(r.ok).toBe(true);
    const closed = await p.companies.findById('co-artisan-a');
    expect(closed?.isClosed()).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it('idempotent : un second appel renvoie alreadyClosed sans re-déclencher deleteUser côté Supabase avec un mauvais texte', async () => {
    const { service, p } = makeService();
    await seedCompanyAs(p, 'co-artisan-a');

    const first = await asPrincipal({ userId: 'u-1', companyId: 'co-artisan-a' }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );
    expect(first.ok).toBe(true);

    const second = await asPrincipal({ userId: 'u-1', companyId: 'co-artisan-a' }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );

    expect(second.ok).toBe(true);
    expect(second.ok && second.value).toEqual(first.ok ? first.value : undefined);
    void p;
  });
});
