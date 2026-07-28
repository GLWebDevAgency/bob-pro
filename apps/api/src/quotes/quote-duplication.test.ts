import { describe, expect, it, vi } from 'vitest';
import {
  Quote,
  type OcrPort,
  type PaymentGatewayPort,
  type PdfRendererPort,
  type QuoteSnapshot,
} from '@bob/core';
import { seedCompany, seedCustomers } from '@bob/core/testing';
import { BackendService } from '../backend.service';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from '../observability/logger';
import type { SupabaseAdminPort } from '../auth/supabase-admin';
import type { NotificationDeliveryService } from '../jobs/notification-delivery.service';
import type { Metrics } from '../observability/metrics';
import { QuotesController } from '../api.controllers';

/**
 * PR-14 « Refaire ce devis » — câblage serveur : POST /quotes/:id/duplicate repasse par le
 * coordinateur de création (CreateQuote intégral). Frontière stricte + non-copie des faits
 * légaux + TVA re-suggérée, au niveau service (persistance en mémoire du harnais).
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

async function seedTenant(p: InMemoryPersistence): Promise<{ companyId: string; customerId: string }> {
  const company = seedCompany();
  await p.companies.save(company);
  const customer = seedCustomers().find((c) => c.id === 'cust-martin')!; // b2b
  await p.customers.save(customer);
  return { companyId: company.id, customerId: customer.id };
}

function signedSnapshot(companyId: string, customerId: string): QuoteSnapshot {
  return {
    id: 'quote-source',
    companyId,
    customerId,
    status: 'signed',
    lines: [
      { id: 'line-1', label: 'Entretien annuel fontaines', category: 'subscription', qty: 2, unitPriceHT: 40_000, vatRate: 20 },
    ],
    number: 'D-2026-0042',
    depositPct: null,
    validUntil: '2026-05-31',
    issuedAt: '2026-04-02',
    signature: {
      signerName: 'RATP CAP',
      signedAt: '2026-04-03T09:00:00.000Z',
      method: 'onsite_draw',
      accepted: true,
    },
    retenueGarantiePct: null,
    chantierId: null,
    revision: 1,
  };
}

describe('duplicateQuote — service (PR-14)', () => {
  it('crée un NOUVEAU brouillon sans jamais copier n°, signature ni dates', async () => {
    const { service, p, audit } = makeService();
    const { companyId, customerId } = await seedTenant(p);
    await p.quotes.save(Quote.rehydrate(signedSnapshot(companyId, customerId)));

    const duplicated = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.duplicateQuote('quote-source', {}),
    );
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.value.quoteId).not.toBe('quote-source');
    expect(duplicated.value.vatAdjustments).toEqual([]);

    const copy = await p.quotes.findById(duplicated.value.quoteId);
    const snapshot = copy!.toSnapshot();
    expect(snapshot.status).toBe('draft');
    expect(snapshot.number).toBeNull();
    expect(snapshot.signature).toBeNull();
    expect(snapshot.validUntil).toBeNull();
    expect(snapshot.lines[0]).toMatchObject({ category: 'subscription', vatRate: 20 });
    expect(audit).toHaveBeenCalledWith(
      'quote.duplicated',
      expect.objectContaining({ sourceQuoteId: 'quote-source' }),
    );
  });

  it('anti-IDOR : le devis d’un autre tenant est introuvable', async () => {
    const { service, p } = makeService();
    const { customerId } = await seedTenant(p);
    await p.quotes.save(Quote.rehydrate(signedSnapshot('company-autre', customerId)));

    const refused = await asPrincipal({ userId: 'u-1', companyId: seedCompany().id }, () =>
      service.duplicateQuote('quote-source', {}),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.kind).toBe('not_found');
  });

  it('rejoue la clé d’idempotence : deux appels avec la même clé rendent le MÊME devis', async () => {
    const { service, p } = makeService();
    const { companyId, customerId } = await seedTenant(p);
    await p.quotes.save(Quote.rehydrate(signedSnapshot(companyId, customerId)));

    const first = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.duplicateQuote('quote-source', { idempotencyKey: 'refaire-1' }),
    );
    const second = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.duplicateQuote('quote-source', { idempotencyKey: 'refaire-1' }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.quoteId).toBe(first.value.quoteId);
    const all = await p.quotes.listByCompany(companyId);
    expect(all).toHaveLength(2); // source + un seul duplicata
  });
});

describe('QuotesController.duplicate — frontière HTTP stricte', () => {
  function controller(overrides: Partial<BackendService> = {}) {
    return new QuotesController(overrides as BackendService);
  }

  it('refuse tout champ hors contrat (le contenu vient du devis source, jamais du client)', async () => {
    const duplicateQuote = vi.fn();
    const c = controller({ duplicateQuote } as never);
    await expect(c.duplicate('q-1', { lines: [] })).rejects.toMatchObject({ status: 422 });
    await expect(c.duplicate('q-1', { context: { autre: true } })).rejects.toMatchObject({ status: 422 });
    await expect(c.duplicate('q-1', { standardRateForReducedLines: 'oui' })).rejects.toMatchObject({ status: 422 });
    expect(duplicateQuote).not.toHaveBeenCalled();
  });

  it('transmet uniquement l’éligibilité re-déclarée, le choix 20 % et la clé d’idempotence', async () => {
    const duplicateQuote = vi.fn(async () => ({
      ok: true as const,
      value: { quoteId: 'q-2', totals: { ht: 0, vat: 0, ttc: 0, netToPay: 0, vatByRate: {} }, vatAdjustments: [] },
    }));
    const c = controller({ duplicateQuote } as never);
    await c.duplicate('q-1', {
      context: { housingOlderThan2y: true },
      standardRateForReducedLines: false,
      idempotencyKey: 'refaire-1',
    });
    expect(duplicateQuote).toHaveBeenCalledWith('q-1', {
      context: { housingOlderThan2y: true },
      standardRateForReducedLines: false,
      idempotencyKey: 'refaire-1',
    });
  });
});
