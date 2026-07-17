import { describe, expect, it, vi } from 'vitest';
import { buildFacturXBasicXml, type FacturXInvoiceData } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { UnavailableDocumentIntelligence } from './documents/document-intelligence';
import { InMemoryDocumentStorage } from './documents/storage.testing';

// jose mocké (politique commune aux tests backend) : on teste le POSTE DE RÉCEPTION, pas la crypto.
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => async () => ({})),
  jwtVerify: vi.fn(),
}));

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
  };
  const logger = { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
  const notificationDelivery = {
    enqueue: vi.fn(async () => ({ id: 'job-1', status: 'done', notification: null })),
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const metrics = {
    aiRequests: { inc: vi.fn() },
    aiDuration: { observe: vi.fn() },
    aiGuardViolations: { inc: vi.fn() },
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
    new UnavailableDocumentIntelligence(),
    new InMemoryDocumentStorage(),
  );
  return { service, p };
}

function asPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

const MERCIER: Principal = { userId: 'u-mercier', companyId: MERCIER_PROPS.id };
const MY_SIREN = MERCIER_PROPS.siren; // 732829320
const SUPPLIER_SIREN = '552100554'; // Luhn valide

/** Facture fournisseur multi-taux (20 % + 10 % + 5,5 %) adressée à Mercier, échéance BT-9. */
const inboundData = (): FacturXInvoiceData => ({
  number: 'FC-2026-118',
  typeCode: '380',
  issueDate: '2026-06-20',
  dueDate: '2026-07-20',
  currency: 'EUR',
  seller: {
    name: 'Sanit Chauffe SAS',
    legalId: SUPPLIER_SIREN,
    address: { line1: '4 rue des Forges', postcode: '69007', city: 'Lyon', countryCode: 'FR' },
  },
  buyer: {
    name: 'Mercier Plomberie',
    legalId: MY_SIREN,
    address: { line1: '12 rue des Artisans', postcode: '92000', city: 'Nanterre', countryCode: 'FR' },
  },
  lines: [
    { id: '1', name: 'Chauffe-eau 200 L', qty: 1, unitCode: 'C62', unitPriceHTCents: 41000, netAmountCents: 41000, vatCategory: 'S', vatRatePct: 20 },
    { id: '2', name: 'Abonnement entretien', qty: 1, unitCode: 'C62', unitPriceHTCents: 6000, netAmountCents: 6000, vatCategory: 'S', vatRatePct: 10 },
    { id: '3', name: 'Denrées chantier', qty: 1, unitCode: 'C62', unitPriceHTCents: 1234, netAmountCents: 1234, vatCategory: 'S', vatRatePct: 5.5 },
  ],
  vatBreakdown: [
    { category: 'S', ratePct: 5.5, basisCents: 1234, vatCents: 68 },
    { category: 'S', ratePct: 10, basisCents: 6000, vatCents: 600 },
    { category: 'S', ratePct: 20, basisCents: 41000, vatCents: 8200 },
  ],
  lineTotalHTCents: 48234,
  taxBasisTotalCents: 48234,
  taxTotalCents: 8868,
  grandTotalCents: 57102,
  prepaidCents: 0,
  duePayableCents: 57102,
});

/** Sous-traitance en AUTOLIQUIDATION preneur (catégorie AE — art. 283-2 nonies CGI). */
const autoliquidationData = (): FacturXInvoiceData => ({
  number: 'ST-2026-007',
  typeCode: '380',
  issueDate: '2026-06-25',
  currency: 'EUR',
  seller: {
    name: 'Bâti Sous-Traitance SARL',
    legalId: SUPPLIER_SIREN,
    address: { line1: '9 rue Haute', postcode: '59000', city: 'Lille', countryCode: 'FR' },
  },
  buyer: {
    name: 'Mercier Plomberie',
    legalId: MY_SIREN,
    address: { line1: '12 rue des Artisans', postcode: '92000', city: 'Nanterre', countryCode: 'FR' },
  },
  lines: [
    { id: '1', name: 'Sous-traitance pose réseau cuivre', qty: 1, unitCode: 'C62', unitPriceHTCents: 100000, netAmountCents: 100000, vatCategory: 'AE', vatRatePct: 0 },
  ],
  vatBreakdown: [
    { category: 'AE', ratePct: 0, basisCents: 100000, vatCents: 0, exemptionReason: 'Autoliquidation, art. 283-2 nonies CGI' },
  ],
  lineTotalHTCents: 100000,
  taxBasisTotalCents: 100000,
  taxTotalCents: 0,
  grandTotalCents: 100000,
  prepaidCents: 0,
  duePayableCents: 100000,
});

async function seeded() {
  const { service, p } = makeService();
  await p.seed(); // Mercier + clients — le contrôle destinataire lit la fiche société RÉELLE
  return { service, p };
}

describe('C-EXP6b ① — POST /expenses/import-facturx : contrôles + brouillon (rien d’enregistré)', () => {
  it('facture valide → brouillon expert (multi-taux au centime, BT-9 → dueAt) et AUCUNE dépense créée', async () => {
    const { service } = await seeded();
    await asPrincipal(MERCIER, async () => {
      const review = await service.importFacturXExpense({ xml: buildFacturXBasicXml(inboundData()) });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.controls).toEqual(['destinataire', 'coherence_en16931', 'doublon']);
      expect(review.value.draft).toMatchObject({
        supplierName: 'Sanit Chauffe SAS',
        supplierSiren: SUPPLIER_SIREN,
        supplierInvoiceNumber: 'FC-2026-118',
        documentDate: '2026-06-20',
        dueAt: '2026-07-20',
        totalTtcCents: 57102,
        totalHtCents: 48234,
        vatCents: 8868, // somme EXACTE des 3 taux — jamais un taux rejoué
        vatRatePct: null,
        vatNonDeductible: false,
        source: 'facturx',
      });
      const expenses = await service.listExpenses();
      expect(expenses.ok && expenses.value.some((e) => e.supplierInvoiceNumber === 'FC-2026-118')).toBe(false);
    });
  });

  it('MAL ADRESSÉE : SIREN acheteur ≠ ma société → contrôle bloquant avec LES 2 SIREN', async () => {
    const { service } = await seeded();
    await asPrincipal(MERCIER, async () => {
      const data = inboundData();
      data.buyer = { ...data.buyer, legalId: '900123456' };
      const r = await service.importFacturXExpense({ xml: buildFacturXBasicXml(data) });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('validation');
      if (r.error.kind !== 'validation') return;
      expect(r.error.issues[0]?.field).toBe('facturx.mal_adressee');
      expect(r.error.issues[0]?.message).toContain('900123456');
      expect(r.error.issues[0]?.message).toContain(MY_SIREN);
    });
  });

  it('INCOHÉRENTE : totaux EN 16931 faux → contrôle bloquant (validateFacturXBasic rejoué)', async () => {
    const { service } = await seeded();
    await asPrincipal(MERCIER, async () => {
      const data = inboundData();
      data.grandTotalCents = 57103;
      const r = await service.importFacturXExpense({ xml: buildFacturXBasicXml(data) });
      expect(r.ok).toBe(false);
      if (r.ok || r.error.kind !== 'validation') return;
      expect(r.error.issues[0]?.field).toBe('facturx.incoherente');
      expect(r.error.issues[0]?.message).toContain('BR-CO-15');
    });
  });

  it('la MÉMOIRE FOURNISSEUR prime pour la catégorie proposée (habitude validée > défaut)', async () => {
    const { service } = await seeded();
    await asPrincipal(MERCIER, async () => {
      // Une dépense VALIDÉE du même fournisseur apprend la catégorie (recordExpense → rememberSupplier).
      const prior = await service.recordExpense({
        supplierName: 'Sanit Chauffe SAS',
        documentDate: '2026-06-01',
        totalTtcCents: 12000,
        category: 'materiel',
        source: 'manual',
      });
      expect(prior.ok).toBe(true);
      const review = await service.importFacturXExpense({ xml: buildFacturXBasicXml(inboundData()) });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.draft.categoryGuess).toBe('materiel');
      expect(review.value.draft.categorySource).toBe('memory');
    });
  });
});

describe('C-EXP6b ② — POST /expenses/import-facturx/confirm : la décision AFNOR explicite', () => {
  it('APPROVE → Expense (n° fournisseur + échéance), écritures E1 6xx/44566/401, XML archivé au coffre', async () => {
    const { service } = await seeded();
    await asPrincipal(MERCIER, async () => {
      const xml = buildFacturXBasicXml(inboundData());
      const outcome = await service.confirmFacturXExpense({ xml, decision: { action: 'approve', category: 'materiel' } });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok || outcome.value.status !== 'approved') return;
      const expenseId = outcome.value.expenseId;

      // L'Expense créée porte les champs Factur-X (extension additive).
      const expenses = await service.listExpenses();
      expect(expenses.ok).toBe(true);
      if (!expenses.ok) return;
      const expense = expenses.value.find((e) => e.id === expenseId);
      expect(expense).toMatchObject({
        supplierName: 'Sanit Chauffe SAS',
        supplierSiren: SUPPLIER_SIREN,
        supplierInvoiceNumber: 'FC-2026-118',
        dueAt: '2026-07-20',
        totalTtcCents: 57102,
        vatCents: 8868,
        category: 'materiel',
        source: 'facturx',
        status: 'to_pay',
      });

      // Les écritures du cycle achats sont parties AUTOMATIQUEMENT (câblage E1).
      const entries = await service.listAccountingEntries();
      expect(entries.ok).toBe(true);
      if (!entries.ok) return;
      const purchase = entries.value.find((e) => e.id === `expense:${expenseId}:recorded`);
      expect(purchase?.journal).toBe('purchases');
      expect(purchase?.lines).toEqual([
        expect.objectContaining({ account: '606', debitCents: 48234, creditCents: 0 }), // TTC − TVA = HT exact
        expect.objectContaining({ account: '44566', debitCents: 8868, creditCents: 0 }), // multi-taux au centime
        expect.objectContaining({ account: '401', debitCents: 0, creditCents: 57102 }),
      ]);

      // Le XML de la facture APPROUVÉE est archivé au coffre, lié à l'Expense (kind facturx_xml).
      expect(outcome.value.xmlDocumentId).not.toBeNull();
      const docs = await service.listDocuments({ kind: 'facturx_xml', linkedEntityType: 'expense', linkedEntityId: expenseId });
      expect(docs.ok).toBe(true);
      if (!docs.ok) return;
      expect(docs.value).toHaveLength(1);
      expect(docs.value[0]?.id).toBe(outcome.value.xmlDocumentId);
      expect(docs.value[0]?.mimeType).toBe('application/xml');
    });
  });

  it('DOUBLON : la même facture (SIREN + n°) réimportée après approbation est REFUSÉE (anti P17)', async () => {
    const { service } = await seeded();
    await asPrincipal(MERCIER, async () => {
      const xml = buildFacturXBasicXml(inboundData());
      const first = await service.confirmFacturXExpense({ xml, decision: { action: 'approve' } });
      expect(first.ok).toBe(true);
      const again = await service.importFacturXExpense({ xml });
      expect(again.ok).toBe(false);
      if (again.ok || again.error.kind !== 'validation') return;
      expect(again.error.issues[0]?.field).toBe('facturx.doublon');
      expect(again.error.issues[0]?.message).toContain(`${SUPPLIER_SIREN}|FC-2026-118`);
      // Et la confirmation rejoue le contrôle (serveur sans état — pas de brouillon caché).
      const confirmAgain = await service.confirmFacturXExpense({ xml, decision: { action: 'approve' } });
      expect(confirmAgain.ok).toBe(false);
    });
  });

  it('AUTOLIQUIDATION (AE) approuvée → ZÉRO ligne 44566 : charge TTC intégrale, TVA à autoliquider', async () => {
    const { service } = await seeded();
    await asPrincipal(MERCIER, async () => {
      const review = await service.importFacturXExpense({ xml: buildFacturXBasicXml(autoliquidationData()) });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.draft.vatNonDeductible).toBe(true);
      expect(review.value.draft.vatNote).toContain('283-2 nonies');
      expect(review.value.draft.categoryGuess).toBe('sous_traitance');

      const outcome = await service.confirmFacturXExpense({
        xml: buildFacturXBasicXml(autoliquidationData()),
        decision: { action: 'approve' },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok || outcome.value.status !== 'approved') return;
      const aeExpenseId = outcome.value.expenseId;

      const entries = await service.listAccountingEntries();
      expect(entries.ok).toBe(true);
      if (!entries.ok) return;
      const purchase = entries.value.find((e) => e.id === `expense:${aeExpenseId}:recorded`);
      expect(purchase).toBeDefined();
      // LE test du piège P21 : un import naïf aurait déduit la TVA du sous-traitant.
      expect(purchase?.lines.some((l) => l.account === '44566')).toBe(false);
      expect(purchase?.lines).toEqual([
        expect.objectContaining({ account: '611', debitCents: 100000, creditCents: 0 }),
        expect.objectContaining({ account: '401', debitCents: 0, creditCents: 100000 }),
      ]);
    });
  });

  it('REFUS sans motif = IMPOSSIBLE (machine InboundEinvoice) ; avec motif → statut AFNOR tracé', async () => {
    const { service } = await seeded();
    await asPrincipal(MERCIER, async () => {
      const data = inboundData();
      data.buyer = { ...data.buyer, legalId: '900123456' }; // mal adressée : LE cas du refus 210
      const xml = buildFacturXBasicXml(data);

      const sansMotif = await service.confirmFacturXExpense({
        xml,
        decision: { action: 'refuse', afnorStatus: 210, reason: '   ' },
      });
      expect(sansMotif.ok).toBe(false);
      if (!sansMotif.ok) {
        expect(sansMotif.error).toEqual({
          kind: 'domain',
          error: { code: 'VALIDATION', field: 'reason', message: 'Motif de refus obligatoire (AFNOR 210/213).' },
        });
      }

      // Refuser une facture MAL ADRESSÉE est précisément le geste attendu : pas de contrôles rejoués.
      const refused = await service.confirmFacturXExpense({
        xml,
        decision: { action: 'refuse', afnorStatus: 210, reason: 'Facture mal adressée : SIREN acheteur ≠ ma société.' },
      });
      expect(refused.ok).toBe(true);
      if (!refused.ok || refused.value.status !== 'refused') return;
      expect(refused.value.afnorStatus).toBe(210);
      expect(refused.value.invoiceKey).toBe(`${SUPPLIER_SIREN}|FC-2026-118`);
      // Rien n'est entré en comptabilité.
      const expenses = await service.listExpenses();
      expect(expenses.ok && expenses.value.some((e) => e.supplierInvoiceNumber === 'FC-2026-118')).toBe(false);
    });
  });
});
