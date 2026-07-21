import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InvoicePdfData,
  OcrPort,
  PaymentGatewayPort,
  PdfRendererPort,
  QuotePdfData,
} from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { PdfRenderer } from './documents/pdf-renderer';
import { pdfVisibleText } from './documents/pdf-text.testing';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { renderPdfFixture } from './documents/pdf-fixtures.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

/**
 * ÉPIC « pièces conformes » — lot RENDUS + MENTIONS (AUDIT_INDISPENSABLES_V1) :
 * - A1 : mentions légales imprimées sur le DEVIS (PDF + payload public de signature) — L243-2
 *   code des assurances, 293 B CGI, arrêté du 24/01/2017 (date d'établissement, gratuité) ;
 * - A2 : mention médiateur de la consommation B2C (L612-1/L616-1 c. conso) ;
 * - A5 : PDF d'avoir conforme — titre « Avoir » + référence à la facture rectifiée
 *   (art. 242 nonies A annexe II CGI ; récupération TVA art. 272 CGI) ;
 * - A6 : bloc émetteur complet (SIREN, TVA intracom, forme + capital / « EI ») ;
 * - A7 : date de prestation + adresse de chantier imprimées et injectées au XML Factur-X
 *   (BT-72 / BG-14 / BG-13 EN 16931).
 * Flow serveur réel (BackendService + InMemoryPersistence) + rendu pdf-lib réel — jamais de
 * mock du domaine. IMMUTABILITÉ : seules les NOUVELLES émissions portent ces nouveautés
 * (les archives existantes ne sont jamais re-rendues, cf. invoice-pdf-immutability.test.ts).
 */

const OWNER: Principal = { userId: 'owner-rendus', companyId: MERCIER_PROPS.id };

afterEach(() => {
  vi.unstubAllEnvs();
});

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'pieces-conformes-rendus', principal: OWNER }, run);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const rendered: InvoicePdfData[] = [];
  const renderedQuotes: QuotePdfData[] = [];
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data, facturX) => {
      rendered.push(structuredClone(data));
      return renderPdfFixture(`archive:${data.number}`, facturX?.xml);
    }),
    renderQuote: vi.fn(async (data) => {
      renderedQuotes.push(structuredClone(data));
      return renderPdfFixture(`quote:${data.number}`);
    }),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'notification-job-rendus',
      status: 'pending',
      notification: input.notification,
    })),
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const logger = {
    audit: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  } as unknown as AppLogger;
  const metrics = {
    aiRequests: { inc: vi.fn() },
    aiDuration: { observe: vi.fn() },
    aiGuardViolations: { inc: vi.fn() },
  } as unknown as Metrics;
  const storage = new InMemoryDocumentStorage();
  const service = new BackendService(
    persistence,
    {} as PaymentGatewayPort,
    renderer,
    {} as OcrPort,
    { setUserCompanyId: vi.fn(), deleteUser: vi.fn() },
    notificationDelivery,
    metrics,
    logger,
    undefined,
    storage,
  );
  return { persistence, rendered, renderedQuotes, service };
}

// Texte visible du PDF : helper d'extraction PARTAGÉ (ToUnicode-aware depuis l'embarquement
// des polices TTF) — ./documents/pdf-text.testing.

const baseInvoiceData: InvoicePdfData = {
  number: 'F-2026-0042',
  companyName: 'Mercier Plomberie',
  companyAddress: '12 rue des Artisans, 92000 Nanterre',
  companyRcsOrRm: 'RM 92',
  customerName: 'M. Bernard',
  customerAddress: '8 allée des Roses, 92190 Meudon',
  issuedAt: '2026-07-19',
  dueAt: '2026-08-18',
  kind: 'final',
  lines: [{ label: 'Rénovation salle d’eau', qty: 1, unitPriceHT: 180_000, vatRate: 20 }],
  totals: { ht: 180_000, vat: 36_000, ttc: 216_000, netToPay: 216_000 },
  mentions: ['Mention légale'],
  billingPresentation: { accentColor: 'navy', rib: null, insurance: null },
};

describe('A5 — PDF d’avoir conforme (PdfRenderer réel)', () => {
  it('titre « Avoir », référence à la facture rectifiée, montants en formulation créditrice', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoiceData,
      number: 'A-2026-0007',
      kind: 'credit_note',
      creditNoteSource: {
        invoiceId: 'inv-source-42',
        kind: 'final',
        number: 'F-2026-0042',
        issuedAt: '2026-07-01',
      },
    });
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Avoir A-2026-0007');
    expect(text).not.toContain('Facture A-2026-0007');
    // 242 nonies A annexe II CGI : la pièce rectificative référence la facture initiale (n° + date).
    expect(text).toContain('Annule totalement la facture n');
    expect(text).toContain('F-2026-0042');
    expect(text).toContain('du 2026-07-01');
    // Formulation créditrice (le domaine fige des montants positifs, miroir de la source).
    expect(text).toContain('Total HT credite');
    expect(text).toContain('TVA creditee');
    expect(text).toContain('Total TTC credite');
    expect(text).toContain('Net a crediter au client');
    expect(text).not.toContain('Net a payer');
    // Pas d'« échéance » sur un avoir : rien n'est dû par le client sur cette pièce.
    expect(text).not.toContain('Echeance');
  });

  it('facture ordinaire : titre « Facture » et libellés débiteurs inchangés (aucune régression)', async () => {
    const bytes = await new PdfRenderer().renderInvoice(baseInvoiceData);
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Facture F-2026-0042');
    expect(text).toContain('Net a payer');
    expect(text).toContain('Echeance : 2026-08-18');
    expect(text).not.toContain('credite');
    expect(text).not.toContain('Annule totalement');
  });
});

describe('A7 — date de prestation + adresse de chantier imprimées (PdfRenderer réel)', () => {
  it('jour unique (end null) : « Prestation realisee le … »', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoiceData,
      servicePeriod: { start: '2026-06-02', end: null },
    });
    expect(await pdfVisibleText(bytes)).toContain('Prestation realisee le 2026-06-02');
  });

  it('période : « Prestation du … au … » + adresse de chantier imprimée', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoiceData,
      servicePeriod: { start: '2026-06-02', end: '2026-06-13' },
      deliveryAddress: 'Chantier — 8 allée des Roses, 92190 Meudon',
    });
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Prestation du 2026-06-02 au 2026-06-13');
    expect(text).toContain('Adresse de chantier / livraison : Chantier - 8 all');
  });

  it('null honnête (pièces legacy) : rien d’imprimé, jamais inventé', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoiceData,
      servicePeriod: null,
      deliveryAddress: null,
    });
    const text = await pdfVisibleText(bytes);
    expect(text).not.toContain('Prestation');
    expect(text).not.toContain('Adresse de chantier');
  });
});

describe('A1 — mentions légales sur le PDF du devis (PdfRenderer réel)', () => {
  const baseQuoteData: QuotePdfData = {
    number: 'D-2026-0031',
    companyName: 'Mercier Plomberie',
    companyAddress: '12 rue des Artisans, 92000 Nanterre',
    companyRcsOrRm: 'RM 92',
    customerName: 'Mme Durand',
    customerAddress: '12 rue des Lilas, 92310 Sèvres',
    validUntil: '2026-08-19',
    lines: [{ label: 'Remplacement chauffe-eau', qty: 1, unitPriceHT: 120_000, vatRate: 10 }],
    totals: { ht: 120_000, vat: 12_000, ttc: 132_000, netToPay: 132_000 },
    depositPct: null,
    signedBy: null,
    mentions: [],
  };

  it('imprime le bloc « Mentions legales » avec chaque mention fournie', async () => {
    const bytes = await new PdfRenderer().renderQuote({
      ...baseQuoteData,
      mentions: [
        'Assurance decennale : AXA, police n°DEC-2026-1182, couverture France entiere.',
        'Devis établi le 2026-07-19.',
        'Devis gratuit.',
        'Bon pour accord (date + signature) :',
      ],
    });
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Mentions legales');
    expect(text).toContain('Assurance decennale : AXA');
    expect(text).toContain('2026-07-19');
    expect(text).toContain('Devis gratuit.');
    expect(text).toContain('Bon pour accord');
  });

  it('sans mention : pas de bloc vide', async () => {
    const bytes = await new PdfRenderer().renderQuote(baseQuoteData);
    expect(await pdfVisibleText(bytes)).not.toContain('Mentions legales');
  });
});

describe('A1/A2/A6 — flow serveur : mentions du devis (payload public de signature)', () => {
  it('B2C avec médiateur renseigné : le payload du token porte le MÊME bloc mentions que le PDF', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    const token = await asOwner(async () => {
      const written = await service.updateCompanyLegal({
        mediateurConso: { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris — cm2c.net' },
      });
      expect(written.ok).toBe(true);
      // cust-durand = b2c (fixtures) : déclenche la mention médiateur (L612-1/L616-1 c. conso).
      // Contexte P11 saisi (habitation > 2 ans) : le taux réduit 10 % est légitime (279-0 bis CGI).
      const quote = await service.createQuote({
        customerId: 'cust-durand',
        lines: [
          { label: 'Remplacement chauffe-eau', category: 'labor', qty: 1, unitPriceHT: 120_000, vatRate: 10 },
        ],
        context: { housingOlderThan2y: true, energyRenovation: false },
      });
      if (!quote.ok) throw new Error('createQuote failed');
      const sent = await service.sendQuote(quote.value.quoteId);
      if (!sent.ok || !sent.value.signatureToken) throw new Error('sendQuote failed');
      return sent.value.signatureToken;
    });

    const view = await service.publicQuoteForSignature(token);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const mentions = view.value.mentions;
    // A6 — bloc émetteur : « EI » (décret 2022-725), SIREN lisible, TVA intracom dérivée.
    expect(mentions[0]).toContain('Mercier Plomberie, EI —');
    expect(mentions).toContain('SIREN 732 829 320');
    expect(mentions.some((m) => m.startsWith('TVA intracommunautaire : FR'))).toBe(true);
    // A2 — médiateur B2C.
    expect(
      mentions.some((m) => m.includes('Médiateur de la consommation : CM2C')),
    ).toBe(true);
    // A1 — décennale L243-2 (renseignée au profil Mercier), date d'établissement, gratuité, accord.
    expect(mentions.some((m) => m.startsWith('Assurance decennale : AXA'))).toBe(true);
    expect(mentions.some((m) => /^Devis établi le \d{4}-\d{2}-\d{2}\.$/.test(m))).toBe(true);
    expect(mentions).toContain('Devis gratuit.');
    expect(mentions).toContain('Bon pour accord (date + signature) :');
    // P11 — la ligne à 10 % déclenche la mention certifiée taux réduit (279-0 bis CGI).
    expect(mentions.some((m) => m.includes('279-0 bis'))).toBe(true);
  });
});

describe('A5/A7 — flow serveur : données de rendu des nouvelles émissions', () => {
  async function issuedInvoiceWithA7(service: BackendService) {
    const quote = await service.createQuote({
      customerId: 'cust-martin',
      lines: [
        { label: 'Rénovation salle d’eau', category: 'labor', qty: 1, unitPriceHT: 180_000, vatRate: 20 },
      ],
    });
    if (!quote.ok) throw new Error('createQuote failed');
    const sent = await service.sendQuote(quote.value.quoteId);
    if (!sent.ok) throw new Error('sendQuote failed');
    const signed = await service.signQuote({ quoteId: quote.value.quoteId, signerName: 'M. Martin' });
    if (!signed.ok) throw new Error('signQuote failed');
    const generated = await service.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
    if (!generated.ok) throw new Error('generateInvoice failed');
    const issued = await service.issueInvoice({
      invoiceId: generated.value.invoiceId,
      servicePeriod: { start: '2026-06-02', end: '2026-06-13' },
      deliveryAddress: 'Chantier — 8 allée des Roses, 92190 Meudon',
    });
    if (!issued.ok) throw new Error('issueInvoice failed');
    return { invoiceId: generated.value.invoiceId, number: issued.value.number };
  }

  it('A7 : l’émission rend un PDF avec période + adresse, et le XML Factur-X porte BG-14 + BG-13', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, rendered, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const { invoiceId } = await issuedInvoiceWithA7(service);

      // L'archive de l'original est rendue À L'ÉMISSION avec les données A7 figées.
      const data = rendered.find((d) => d.kind === 'final');
      expect(data?.servicePeriod).toEqual({ start: '2026-06-02', end: '2026-06-13' });
      expect(data?.deliveryAddress).toBe('Chantier — 8 allée des Roses, 92190 Meudon');
      expect(data?.creditNoteSource).toBeNull();

      const xml = await service.invoiceFacturXXml(invoiceId);
      expect(xml.ok).toBe(true);
      if (!xml.ok) return;
      expect(xml.value).toContain('<ram:BillingSpecifiedPeriod>');
      expect(xml.value).toContain('<udt:DateTimeString format="102">20260602</udt:DateTimeString>');
      expect(xml.value).toContain('<udt:DateTimeString format="102">20260613</udt:DateTimeString>');
      expect(xml.value).toContain('<ram:ShipToTradeParty>');
      expect(xml.value).toContain(
        '<ram:LineOne>Chantier — 8 allée des Roses, 92190 Meudon</ram:LineOne>',
      );
    });
  });

  it('A5 : l’avoir total est rendu avec kind credit_note + référence figée à la pièce annulée', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, rendered, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const { invoiceId, number } = await issuedInvoiceWithA7(service);
      const credit = await service.createCreditNote({ invoiceId });
      expect(credit.ok).toBe(true);
      if (!credit.ok) return;
      const issuedCredit = await service.issueInvoice({ invoiceId: credit.value.creditNoteId });
      expect(issuedCredit.ok).toBe(true);

      const data = rendered.find((d) => d.kind === 'credit_note');
      expect(data).toBeDefined();
      expect(data?.creditNoteSource?.number).toBe(number);
      expect(data?.creditNoteSource?.kind).toBe('final');
      expect(data?.creditNoteSource?.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A7 : l'avoir reprend la période et l'adresse de la pièce annulée (jamais de valeurs neuves).
      expect(data?.servicePeriod).toEqual({ start: '2026-06-02', end: '2026-06-13' });
      expect(data?.deliveryAddress).toBe('Chantier — 8 allée des Roses, 92190 Meudon');
    });
  });
});
