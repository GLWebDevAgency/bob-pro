import { describe, expect, it } from 'vitest';
import { Company, Customer } from '@bob/core';
import type { PaymentGatewayPort, PdfRendererPort, OcrPort } from '@bob/core';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

/**
 * B9 — GET /documents/search & /documents/suggest, côté BackendService/InMemoryPersistence
 * (mode démo, pendant du mode Postgres réel certifié par
 * persistence/prisma/sales-document-search.repository.postgres.test.ts). Le ranking pg_trgm lui-
 * même est déjà couvert deux fois (core pur + Postgres réel) : ce fichier vérifie la validation
 * de forme et — surtout — l'ISOLATION TENANT à ce niveau de câblage précis (BackendService →
 * this.companyId() → port).
 */
function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: async () => undefined,
    deleteUser: async () => undefined,
  };
  const logger = { audit: () => undefined, error: () => undefined, warn: () => undefined, log: () => undefined } as unknown as AppLogger;
  const notificationDelivery = {
    enqueue: async (input: { notification: unknown }) => ({ id: 'job-1', status: 'pending', notification: input.notification }),
    tryDeliver: async () => true,
  } as unknown as NotificationDeliveryService;
  const metrics = {
    aiRequests: { inc: () => undefined },
    aiDuration: { observe: () => undefined },
    aiGuardViolations: { inc: () => undefined },
  } as unknown as Metrics;
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    admin,
    notificationDelivery,
    metrics,
    logger,
  );
  return { service, p };
}

function asPrincipal<T>(principal: Principal, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', principal }, fn);
}

const MERCIER: Principal = { userId: 'u-mercier', companyId: 'company-mercier' };

async function seedIntrusTenant(p: InMemoryPersistence): Promise<Principal> {
  // siren/siret repris de MERCIER_PROPS (même précédent que seedFranchiseTenant dans
  // pont-serveur.test.ts) : Company.of valide un VRAI checksum SIREN/SIRET, un « 111111111 »
  // de convenance échoue à la construction — seul id/name/vatRegime distinguent ce tenant.
  const company = Company.of({
    id: 'company-intrus',
    name: 'Intrus SARL',
    legalForm: 'EI',
    siren: '732829320',
    siret: '73282932000074',
    trade: 'autre',
    vatRegime: 'reel_simpl',
    address: { line1: '1 rue Intrus', zip: '75000', city: 'Paris' },
  });
  if (!company.ok) throw new Error('fixture: company intrus invalide');
  await p.companies.save(company.value);
  // MÊME nom client que le tenant Mercier ("Mairie de Sèvres") : preuve qu'un texte qui
  // matcherait chez l'autre tenant ne fuit jamais si l'isolation est correcte.
  const customer = Customer.of({
    id: 'cust-intrus-sevres',
    companyId: 'company-intrus',
    type: 'b2g',
    name: 'Mairie de Sèvres',
    address: { line1: '1 place', zip: '92310', city: 'Sèvres' },
    score: 0,
    avgDelayDays: 0,
    outstanding: 0,
  });
  if (!customer.ok) throw new Error('fixture: customer intrus invalide');
  await p.customers.save(customer.value);
  return { userId: 'u-intrus', companyId: 'company-intrus' };
}

describe('BackendService.searchSalesDocuments / suggestSalesDocuments (B9, mode démo InMemoryPersistence)', () => {
  it('valide la FORME des dates avant tout appel au port (jamais une plage incohérente)', async () => {
    const { service, p } = makeService();
    await p.seed();
    const badFrom = await asPrincipal(MERCIER, () => service.searchSalesDocuments({ query: '', scope: 'all', from: '2026-13-40' }));
    expect(badFrom).toMatchObject({ ok: false, error: { kind: 'validation' } });

    const inverted = await asPrincipal(MERCIER, () =>
      service.searchSalesDocuments({ query: '', scope: 'all', from: '2026-08-01', to: '2026-07-01' }),
    );
    expect(inverted).toMatchObject({ ok: false, error: { kind: 'validation' } });
  });

  it('« sevres » retrouve le client de seed Mairie de Sèvres (fixture partagée du proto)', async () => {
    const { service, p } = makeService();
    await p.seed();
    const quote = await asPrincipal(MERCIER, () =>
      service.createQuote({
        customerId: 'cust-sevres',
        lines: [{ label: 'Réfection toiture mairie', category: 'labor', qty: 1, unitPriceHT: 500000, vatRate: 20 }],
      }),
    );
    expect(quote.ok).toBe(true);

    const result = await asPrincipal(MERCIER, () => service.searchSalesDocuments({ query: 'sevres', scope: 'all' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.some((h) => h.customerName === 'Mairie de Sèvres')).toBe(true);
  });

  it('ISOLATION TENANT : un devis Mercier n’apparaît JAMAIS dans la recherche d’un autre tenant, même nom client identique', async () => {
    const { service, p } = makeService();
    await p.seed();
    const intrus = await seedIntrusTenant(p);

    const mercierQuote = await asPrincipal(MERCIER, () =>
      service.createQuote({
        customerId: 'cust-sevres',
        lines: [{ label: 'Réfection toiture mairie', category: 'labor', qty: 1, unitPriceHT: 500000, vatRate: 20 }],
      }),
    );
    expect(mercierQuote.ok).toBe(true);
    if (!mercierQuote.ok) return;

    const fromIntrus = await asPrincipal(intrus, () => service.searchSalesDocuments({ query: 'sevres', scope: 'all' }));
    expect(fromIntrus.ok).toBe(true);
    if (!fromIntrus.ok) return;
    expect(fromIntrus.value.hits.map((h) => h.id)).not.toContain(mercierQuote.value.quoteId);
    // Le tenant intrus a SON PROPRE client "Mairie de Sèvres" : il doit le voir, juste pas la pièce de Mercier.
    expect(fromIntrus.value.hits.every((h) => h.customerName === 'Mairie de Sèvres' ? h.id !== mercierQuote.value.quoteId : true)).toBe(true);

    const fromMercier = await asPrincipal(MERCIER, () => service.searchSalesDocuments({ query: 'sevres', scope: 'all' }));
    expect(fromMercier.ok).toBe(true);
    if (!fromMercier.ok) return;
    expect(fromMercier.value.hits.map((h) => h.id)).toContain(mercierQuote.value.quoteId);
  });

  it('suggest : ISOLATION TENANT également côté autocomplétion', async () => {
    const { service, p } = makeService();
    await p.seed();
    await seedIntrusTenant(p);

    const fromMercier = await asPrincipal(MERCIER, () => service.suggestSalesDocuments({ query: 'sevres' }));
    expect(fromMercier.ok).toBe(true);
    if (!fromMercier.ok) return;
    expect(fromMercier.value.suggestions.some((s) => s.kind === 'customer' && s.value === 'Mairie de Sèvres')).toBe(true);

    const intrus: Principal = { userId: 'u-intrus', companyId: 'company-intrus' };
    const fromIntrus = await asPrincipal(intrus, () => service.suggestSalesDocuments({ query: 'sevres' }));
    expect(fromIntrus.ok).toBe(true);
    if (!fromIntrus.ok) return;
    // Le tenant intrus voit SON client (même nom), le compte de pièces reste 0 (aucun devis/facture chez lui).
    const intrusSuggestion = fromIntrus.value.suggestions.find((s) => s.kind === 'customer');
    expect(intrusSuggestion).toMatchObject({ value: 'Mairie de Sèvres', count: 0 });
  });

  it('scope="quote" exclut les factures (et inversement) — délégué tel quel au port', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, () =>
      service.createQuote({
        customerId: 'cust-martin',
        lines: [{ label: 'Peinture façade', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 }],
      }),
    );
    const quotesOnly = await asPrincipal(MERCIER, () => service.searchSalesDocuments({ query: 'martin', scope: 'quote' }));
    expect(quotesOnly.ok).toBe(true);
    if (!quotesOnly.ok) return;
    expect(quotesOnly.value.hits.every((h) => h.source === 'quote')).toBe(true);

    const invoicesOnly = await asPrincipal(MERCIER, () => service.searchSalesDocuments({ query: 'martin', scope: 'invoice' }));
    expect(invoicesOnly.ok).toBe(true);
    if (!invoicesOnly.ok) return;
    expect(invoicesOnly.value.hits).toEqual([]);
  });
});
