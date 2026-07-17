import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaSalesDocumentSearchRepository } from './sales-document-search.repository';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_SALES_SEARCH_CERT === 'true';

/**
 * B9 — certification PostgreSQL réelle de GET /documents/search & /documents/suggest : ranking
 * pg_trgm/word_similarity (accents/casse), isolation tenant, plages de dates. Gardé par un flag
 * env (comme quote-creation-requests.postgres.test.ts) — nécessite une base migrée réelle
 * (DATABASE_URL + DIRECT_URL), jamais exécuté par défaut dans `vitest run`.
 */
describe.skipIf(!RUN_POSTGRES_CERT)('PrismaSalesDocumentSearchRepository — certification PostgreSQL réelle', () => {
  const companyId = `sales-search-cert-${randomUUID()}`;
  const otherCompanyId = `sales-search-other-${randomUUID()}`;
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let worker: PrismaService;
  let repo: PrismaSalesDocumentSearchRepository;

  const customerSevres = `cust-sevres-${randomUUID()}`;
  const customerMartin = `cust-martin-${randomUUID()}`;
  const customerOther = `cust-other-${randomUUID()}`;
  const quoteMartin = `quote-martin-${randomUUID()}`;
  const invoiceSevres = `invoice-sevres-${randomUUID()}`;
  const invoiceOldMartin = `invoice-old-martin-${randomUUID()}`;
  const invoiceOther = `invoice-other-${randomUUID()}`;

  // siret dérivé de l'id (jamais littéral fixe) : une facture ÉMISE ne peut PLUS être nettoyée en
  // afterAll (cf. commentaire plus bas), donc une ré-exécution locale doit tolérer des lignes
  // résiduelles d'un run précédent SANS jamais entrer en collision sur la contrainte unique siret.
  function company(id: string) {
    const siretSuffix = id.replace(/[^0-9]/g, '').slice(0, 4).padStart(4, '0');
    return {
      id,
      name: `Cert ${id}`,
      legalForm: 'EI' as const,
      siren: '552100554',
      siret: `5521005540${siretSuffix}`,
      trade: 'autre',
      vatRegime: 'reel_normal' as const,
      addrLine1: '1 rue de la Certification',
      addrZip: '75001',
      addrCity: 'Paris',
    };
  }

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    worker = new PrismaService({ datasourceUrl: runtimeUrl });
    await Promise.all([admin.$connect(), worker.$connect()]);
    repo = new PrismaSalesDocumentSearchRepository(worker);

    await admin.company.createMany({ data: [company(companyId), company(otherCompanyId)] });
    await admin.customer.createMany({
      data: [
        { id: customerSevres, companyId, type: 'b2g', name: 'Mairie de Sèvres', addrLine1: '1 place', addrZip: '92310', addrCity: 'Sèvres' },
        { id: customerMartin, companyId, type: 'b2b', name: 'SARL Martin Rénovation', addrLine1: '2 rue', addrZip: '75002', addrCity: 'Paris' },
        { id: customerOther, companyId: otherCompanyId, type: 'b2g', name: 'Mairie de Sèvres', addrLine1: '1 place', addrZip: '92310', addrCity: 'Sèvres' },
      ],
    });
    await admin.quote.create({
      data: {
        id: quoteMartin, companyId, customerId: customerMartin, status: 'signed', number: 'D-2026-0042',
        lines: { create: [{ position: 0, label: 'Peinture façade', category: 'labor', qty: 1, unitPriceHt: 100000, vatRate: 20 }] },
      },
    });
    // Créées en 'draft' PUIS émises (update séparé) : un trigger légal
    // (enforce_issued_invoice_line_immutability) interdit d'insérer des lignes sur une facture
    // déjà 'issued' dans la même transaction — même garde que le domaine (assertDraft côté Quote).
    await admin.invoice.create({
      data: {
        id: invoiceSevres, companyId, customerId: customerSevres, kind: 'invoice', status: 'draft',
        number: 'F-2026-0007',
        lines: { create: [{ position: 0, label: 'Remplacement chauffe-eau', category: 'labor', qty: 1, unitPriceHt: 50000, vatRate: 20 }] },
      },
    });
    await admin.invoice.create({
      data: {
        id: invoiceOldMartin, companyId, customerId: customerMartin, kind: 'invoice', status: 'draft',
        number: 'F-2026-0001',
        lines: { create: [{ position: 0, label: 'Devis reprise', category: 'labor', qty: 1, unitPriceHt: 20000, vatRate: 20 }] },
      },
    });
    await admin.invoice.create({
      data: {
        id: invoiceOther, companyId: otherCompanyId, customerId: customerOther, kind: 'invoice', status: 'draft',
        number: 'F-9999-0001',
      },
    });
    await admin.invoice.update({ where: { id: invoiceSevres }, data: { status: 'issued', issuedAt: new Date('2026-07-05T00:00:00.000Z') } });
    await admin.invoice.update({ where: { id: invoiceOldMartin }, data: { status: 'issued', issuedAt: new Date('2026-01-10T00:00:00.000Z') } });
    await admin.invoice.update({ where: { id: invoiceOther }, data: { status: 'issued', issuedAt: new Date('2026-07-05T00:00:00.000Z') } });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      // Le devis (jamais émis) se nettoie sans contrainte.
      await admin.lineItem.deleteMany({ where: { quoteId: quoteMartin } }).catch(() => undefined);
      await admin.quote.deleteMany({ where: { id: quoteMartin } }).catch(() => undefined);
      // Les factures ÉMISES, elles, NE PEUVENT PAS être nettoyées : le trigger légal
      // enforce_issued_invoice_line_immutability interdit tout DELETE sur les lignes d'une
      // facture non-brouillon (même garantie qu'en production — une pièce émise ne se supprime
      // jamais). customers/company restent donc aussi en place (FK depuis invoices). Ces lignes
      // de certification, uniquement identifiées par des UUID aléatoires, s'accumulent sans
      // jamais entrer en collision — acceptable pour une base de développement locale jetable ;
      // pointer RUN_POSTGRES_SALES_SEARCH_CERT vers une base CI éphémère en production du test.
    }
    await Promise.allSettled([worker?.$disconnect(), admin?.$disconnect()]);
  });

  it('« sevres » sans accent retrouve « Mairie de Sèvres » (word_similarity + unaccent, index GIN utilisé)', async () => {
    const result = await repo.search({ companyId, query: 'sevres', scope: 'all' });
    expect(result.hits.map((h) => h.id)).toEqual([invoiceSevres]);
    expect(result.hits[0]?.customerName).toBe('Mairie de Sèvres');
  });

  it('numéro exact classé en tête (rank 1.0) devant un simple "contient"', async () => {
    const result = await repo.search({ companyId, query: 'F-2026-0007', scope: 'all' });
    expect(result.hits[0]?.id).toBe(invoiceSevres);
  });

  it('libellé de ligne « chauffe-eau » retrouve la facture ET expose la ligne matchée', async () => {
    const result = await repo.search({ companyId, query: 'chauffe eau', scope: 'all' });
    expect(result.hits.map((h) => h.id)).toEqual([invoiceSevres]);
    expect(result.hits[0]?.matchedLineLabel).toBe('Remplacement chauffe-eau');
  });

  it('scope="quote" exclut les factures même si le nom client matche', async () => {
    const result = await repo.search({ companyId, query: 'martin', scope: 'quote' });
    expect(result.hits.map((h) => h.id)).toEqual([quoteMartin]);
  });

  it('customerId filtre strictement sur ce client (devis + facture ancienne de Martin)', async () => {
    const result = await repo.search({ companyId, query: '', scope: 'all', customerId: customerMartin });
    expect(result.hits.map((h) => h.id).sort()).toEqual([invoiceOldMartin, quoteMartin].sort());
  });

  it('plage de dates (issuedAt) : la facture de janvier est exclue d’un filtre juillet', async () => {
    const result = await repo.search({ companyId, query: '', scope: 'invoice', from: '2026-07-01', to: '2026-07-31' });
    expect(result.hits.map((h) => h.id)).toEqual([invoiceSevres]);
  });

  it('ISOLATION TENANT : une requête qui matcherait chez un autre tenant ne fuit JAMAIS', async () => {
    const result = await repo.search({ companyId, query: 'sevres', scope: 'all' });
    expect(result.hits.every((h) => h.customerId !== customerOther)).toBe(true);
    expect(result.hits.map((h) => h.id)).not.toContain(invoiceOther);

    const otherTenant = await repo.search({ companyId: otherCompanyId, query: 'sevres', scope: 'all' });
    expect(otherTenant.hits.map((h) => h.id)).toEqual([invoiceOther]);
  });

  it('pagination : limit=1 pose un nextCursor cohérent, la page suivante le consomme sans doublon', async () => {
    const page1 = await repo.search({ companyId, query: '', scope: 'all', limit: 1 });
    expect(page1.hits).toHaveLength(1);
    expect(page1.totalCount).toBe(3);
    expect(page1.nextCursor).toBe('1');
    const page2 = await repo.search({ companyId, query: '', scope: 'all', limit: 1, cursor: page1.nextCursor! });
    expect(page2.hits[0]?.id).not.toBe(page1.hits[0]?.id);
  });

  it('requête sans match : résultat vide, jamais une erreur', async () => {
    const result = await repo.search({ companyId, query: 'xyzxyzxyz-inexistant', scope: 'all' });
    expect(result.hits).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('suggest : mélange typé customer/number/label, LIMIT respecté, tenant isolé', async () => {
    const result = await repo.suggest({ companyId, query: 'martin' });
    expect(result.suggestions.some((s) => s.kind === 'customer' && s.value === 'SARL Martin Rénovation')).toBe(true);

    // La requête étant fuzzy (word_similarity), "2026-000" trouve aussi D-2026-0042 (numéro
    // du devis) — comportement voulu, pas un bug : on vérifie que les DEUX numéros de facture
    // attendus y sont, sans exiger l'exhaustivité de l'ensemble.
    const numbers = await repo.suggest({ companyId, query: '2026-000' });
    const numberValues = numbers.suggestions.filter((s) => s.kind === 'number').map((s) => s.value);
    expect(numberValues).toEqual(expect.arrayContaining(['F-2026-0001', 'F-2026-0007']));

    const isolated = await repo.suggest({ companyId: otherCompanyId, query: 'martin' });
    expect(isolated.suggestions).toEqual([]);
  });

  it('suggest : requête vide -> aucune suggestion', async () => {
    expect(await repo.suggest({ companyId, query: '' })).toEqual({ suggestions: [] });
  });
});
