import { describe, expect, it, vi } from 'vitest';
import { Chantier, type OcrPort, type PaymentGatewayPort, type PdfRendererPort } from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

/**
 * Imputation chantier des dépenses (rentabilité par chantier) — câblage serveur du use case
 * AssignExpenseToChantier (@bob/core) + naissance liée via RecordExpense (chantierTargets).
 * Anti-IDOR : le chantier visé est PROUVÉ dans le tenant ; un chantier d'un autre tenant est
 * indistinguable d'un chantier inexistant (not_found, pas d'oracle).
 */
function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: async () => undefined,
    deleteUser: async () => undefined,
  } as SupabaseAdminPort;
  const audit = vi.fn();
  const logger = {
    audit,
    error: () => undefined,
    warn: () => undefined,
    log: () => undefined,
  } as unknown as AppLogger;
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
  return { service, p, audit };
}

function asPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'test', principal }, fn);
}

async function seedTenantCompany(p: InMemoryPersistence): Promise<string> {
  const company = seedCompany();
  await p.companies.save(company);
  return company.id;
}

function seedChantier(p: InMemoryPersistence, id: string, companyId: string): Promise<void> {
  const r = Chantier.record({
    id,
    companyId,
    name: `Chantier ${id}`,
    customerId: null,
    address: null,
    notes: null,
    status: 'open',
    openedAt: '2026-07-01',
  });
  if (!r.ok) throw new Error('fixture chantier invalide');
  return p.chantiers.save(r.value);
}

const EXPENSE_INPUT = {
  supplierName: 'Point P',
  documentDate: '2026-07-01',
  totalTtcCents: 12_000,
  category: 'materiel' as const,
};

describe('recordExpense — la dépense peut NAÎTRE imputée à un chantier (destination choisie au scan)', () => {
  it('chantierId fourni et prouvé dans le tenant : la dépense naît liée, listExpenses l’expose', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);
    await seedChantier(p, 'chantier-durand', companyId);

    const created = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.recordExpense({ ...EXPENSE_INPUT, chantierId: 'chantier-durand' }),
    );
    expect(created.ok).toBe(true);

    const list = await asPrincipal({ userId: 'u-1', companyId }, () => service.listExpenses());
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    expect(list.value[0]!.chantierId).toBe('chantier-durand');
  });

  it('sans chantierId : comportement historique intact, chantierId null EXPLICITE en projection', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);

    const created = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.recordExpense(EXPENSE_INPUT),
    );
    expect(created.ok).toBe(true);

    const list = await asPrincipal({ userId: 'u-1', companyId }, () => service.listExpenses());
    expect(list.ok && list.value[0]!.chantierId).toBeNull();
  });

  it('anti-IDOR : chantier inexistant OU d’un autre tenant → not_found, AUCUNE dépense créée', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);
    // Chantier réel mais possédé par un AUTRE tenant : même réponse qu'un id inventé (pas d'oracle).
    await seedChantier(p, 'chantier-intrus', 'company-intrus');

    for (const chantierId of ['chantier-fantome', 'chantier-intrus']) {
      const created = await asPrincipal({ userId: 'u-1', companyId }, () =>
        service.recordExpense({ ...EXPENSE_INPUT, chantierId }),
      );
      expect(created).toEqual({
        ok: false,
        error: { kind: 'not_found', entity: 'chantier', id: chantierId },
      });
    }
    const list = await asPrincipal({ userId: 'u-1', companyId }, () => service.listExpenses());
    expect(list.ok && list.value).toEqual([]);
  });
});

describe('assignExpenseChantier — imputer / délier, idempotent, tenant strict', () => {
  async function seedExpense(service: BackendService, companyId: string): Promise<string> {
    const created = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.recordExpense(EXPENSE_INPUT),
    );
    if (!created.ok) throw new Error('fixture dépense invalide');
    return created.value.id;
  }

  it('impute puis délie (null explicite), avec idempotence prouvée aux deux étapes', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);
    await seedChantier(p, 'chantier-durand', companyId);
    const expenseId = await seedExpense(service, companyId);

    const assigned = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.assignExpenseChantier({ expenseId, chantierId: 'chantier-durand' }),
    );
    expect(assigned).toEqual({ ok: true, value: { chantierId: 'chantier-durand', changed: true } });

    // Retry de la même imputation : succès SANS écriture (changed=false).
    const replay = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.assignExpenseChantier({ expenseId, chantierId: 'chantier-durand' }),
    );
    expect(replay).toEqual({ ok: true, value: { chantierId: 'chantier-durand', changed: false } });

    const linked = await asPrincipal({ userId: 'u-1', companyId }, () => service.listExpenses());
    expect(linked.ok && linked.value[0]!.chantierId).toBe('chantier-durand');

    // Retrait = même route, chantierId null EXPLICITE.
    const unlinked = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.assignExpenseChantier({ expenseId, chantierId: null }),
    );
    expect(unlinked).toEqual({ ok: true, value: { chantierId: null, changed: true } });

    const unlinkReplay = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.assignExpenseChantier({ expenseId, chantierId: null }),
    );
    expect(unlinkReplay).toEqual({ ok: true, value: { chantierId: null, changed: false } });

    const list = await asPrincipal({ userId: 'u-1', companyId }, () => service.listExpenses());
    expect(list.ok && list.value[0]!.chantierId).toBeNull();
  });

  it('anti-IDOR chantier : cible inexistante ou d’un autre tenant → not_found, lien inchangé', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);
    await seedChantier(p, 'chantier-intrus', 'company-intrus');
    const expenseId = await seedExpense(service, companyId);

    const denied = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.assignExpenseChantier({ expenseId, chantierId: 'chantier-intrus' }),
    );
    expect(denied).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'chantier', id: 'chantier-intrus' },
    });

    const list = await asPrincipal({ userId: 'u-1', companyId }, () => service.listExpenses());
    expect(list.ok && list.value[0]!.chantierId).toBeNull();
  });

  it('tenant strict : la dépense d’un autre tenant est un not_found indistinguable', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);
    await seedChantier(p, 'chantier-durand', companyId);
    const expenseId = await seedExpense(service, companyId);

    const denied = await asPrincipal({ userId: 'u-intrus', companyId: 'company-intrus' }, () =>
      service.assignExpenseChantier({ expenseId, chantierId: 'chantier-durand' }),
    );
    expect(denied).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'expense', id: expenseId },
    });
  });

  it('audit : expense.chantier_assigned tracé avec l’imputation effective', async () => {
    const { service, p, audit } = makeService();
    const companyId = await seedTenantCompany(p);
    await seedChantier(p, 'chantier-durand', companyId);
    const expenseId = await seedExpense(service, companyId);

    await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.assignExpenseChantier({ expenseId, chantierId: 'chantier-durand' }),
    );

    expect(audit).toHaveBeenCalledWith('expense.chantier_assigned', {
      companyId,
      expenseId,
      chantierId: 'chantier-durand',
      changed: true,
    });
  });
});
