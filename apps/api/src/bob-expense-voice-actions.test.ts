import { describe, expect, it, vi } from 'vitest';
import { Chantier, type OcrPort, type PaymentGatewayPort, type PdfRendererPort } from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import type { BobActions } from '@bob/ai';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

/**
 * M3/M4 — actions hôte de l'agent Bob (buildBobActions) côté serveur :
 * - listRecentExpenses : dépenses récentes du tenant, imputation chantier EXPLICITE, tri décroissant ;
 * - assignExpenseChantier : PURE délégation au même chemin que PUT /expenses/:id/chantier
 *   (use case AssignExpenseToChantier @bob/core — anti-IDOR fail-closed, idempotent) ;
 * - recordExpense : MÊME chemin transactionnel que POST /expenses (coordinateur E1), source
 *   'manual', défaut de date = jour métier, règlement déclaré → dépense née payée avec preuve.
 * L'hôte n'ajoute AUCUNE logique : ces tests prouvent le câblage, pas le domaine (déjà testé).
 */
function makeService() {
  const p = new InMemoryPersistence();
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    {
      setUserCompanyId: async () => undefined,
      deleteUser: async () => undefined,
    } as SupabaseAdminPort,
    {} as NotificationDeliveryService,
    {} as Metrics,
    { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger,
  );
  return { service, p };
}

function bobActions(service: BackendService): BobActions {
  return (service as unknown as { buildBobActions(): BobActions }).buildBobActions();
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

describe('buildBobActions M3/M4 — expenses vocales (parité stricte avec les chemins UI)', () => {
  it('recordExpense (dictée) : source manual, règlement déclaré → née payée, chantier prouvé, listRecentExpenses l’expose triée', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);
    await seedChantier(p, 'chantier-durand', companyId);
    const principal: Principal = { userId: 'u-1', companyId };
    const actions = bobActions(service);
    expect(actions.recordExpense).toBeDefined();
    expect(actions.listRecentExpenses).toBeDefined();
    expect(actions.assignExpenseChantier).toBeDefined();

    const created = await asPrincipal(principal, () =>
      actions.recordExpense!({
        supplierName: 'Leroy Merlin',
        totalTtcCents: 8900,
        category: 'materiel',
        documentDate: '2026-07-18',
        chantierId: 'chantier-durand',
        payment: { paidOn: '2026-07-18', method: 'card' },
      }),
    );
    expect(created.ok).toBe(true);

    const older = await asPrincipal(principal, () =>
      actions.recordExpense!({
        supplierName: 'Aldi',
        totalTtcCents: 4500,
        category: 'repas',
        documentDate: '2026-07-10',
      }),
    );
    expect(older.ok).toBe(true);

    // La dépense dictée est née PAYÉE avec sa preuve (mêmes gardes domaine que l'écran).
    const list = await asPrincipal(principal, () => service.listExpenses());
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const dictated = list.value.find((e) => e.supplierName === 'Leroy Merlin')!;
    expect(dictated.status).toBe('paid');
    expect(dictated.paymentEvidence).toMatchObject({ paidOn: '2026-07-18', method: 'card' });
    expect(dictated.chantierId).toBe('chantier-durand');
    expect(dictated.source).toBe('manual');

    // listRecentExpenses : plus récentes d'abord, chantierId TOUJOURS explicite (null = hors chantier).
    const recent = await asPrincipal(principal, () => actions.listRecentExpenses!());
    expect(recent.ok).toBe(true);
    if (!recent.ok) return;
    expect(recent.value.map((e) => e.supplierName)).toEqual(['Leroy Merlin', 'Aldi']);
    expect(recent.value[0]).toEqual({
      id: dictated.id,
      supplierName: 'Leroy Merlin',
      totalTtcCents: 8900,
      documentDate: '2026-07-18',
      chantierId: 'chantier-durand',
    });
    expect(recent.value[1]!.chantierId).toBeNull();
  });

  it('recordExpense anti-IDOR : chantier inconnu du tenant → not_found, RIEN n’est créé', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);
    await seedChantier(p, 'chantier-intrus', 'company-intrus');
    const principal: Principal = { userId: 'u-1', companyId };
    const actions = bobActions(service);

    const denied = await asPrincipal(principal, () =>
      actions.recordExpense!({
        supplierName: 'Leroy Merlin',
        totalTtcCents: 8900,
        category: 'materiel',
        chantierId: 'chantier-intrus',
        payment: { paidOn: '2026-07-18', method: 'card' },
      }),
    );
    expect(denied).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'chantier', id: 'chantier-intrus' },
    });
    const list = await asPrincipal(principal, () => service.listExpenses());
    expect(list.ok && list.value).toEqual([]);
  });

  it('assignExpenseChantier : même contrat que PUT /expenses/:id/chantier (imputer, idempotence, anti-IDOR)', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenantCompany(p);
    await seedChantier(p, 'chantier-durand', companyId);
    const principal: Principal = { userId: 'u-1', companyId };
    const actions = bobActions(service);

    const created = await asPrincipal(principal, () =>
      actions.recordExpense!({ supplierName: 'Aldi', totalTtcCents: 4500, category: 'repas' }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const expenseId = created.value.id;

    const assigned = await asPrincipal(principal, () =>
      actions.assignExpenseChantier!({ expenseId, chantierId: 'chantier-durand' }),
    );
    expect(assigned).toEqual({ ok: true, value: { chantierId: 'chantier-durand', changed: true } });

    // Retry idempotent : aucune écriture (changed=false) — même sémantique que la route HTTP.
    const replay = await asPrincipal(principal, () =>
      actions.assignExpenseChantier!({ expenseId, chantierId: 'chantier-durand' }),
    );
    expect(replay).toEqual({ ok: true, value: { chantierId: 'chantier-durand', changed: false } });

    // Anti-IDOR : chantier fantôme indistinguable d'un chantier d'autrui — lien inchangé.
    const denied = await asPrincipal(principal, () =>
      actions.assignExpenseChantier!({ expenseId, chantierId: 'chantier-fantome' }),
    );
    expect(denied).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'chantier', id: 'chantier-fantome' },
    });
    const recent = await asPrincipal(principal, () => actions.listRecentExpenses!());
    expect(recent.ok && recent.value[0]!.chantierId).toBe('chantier-durand');
  });
});
