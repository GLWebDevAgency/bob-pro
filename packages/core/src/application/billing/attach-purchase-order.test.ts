import { describe, expect, it } from 'vitest';
import {
  AttachPurchaseOrderToQuote,
  AttachPurchaseOrderToInvoice,
  DetachPurchaseOrder,
} from './attach-purchase-order';
import { Quote } from '../../domain/billing/quote/quote';
import { Invoice, type InvoiceSnapshot } from '../../domain/billing/invoice/invoice';
import { type ClockPort } from '../ports/services';

const AT = '2026-07-10T09:00:00.000Z';
const clock: ClockPort = { now: () => AT, today: () => '2026-07-10' };
const PO = { number: 'BC-RATP-4500123456', receivedAt: AT, documentId: null };

function signedQuote(over: { id?: string; companyId?: string } = {}): Quote {
  return Quote.rehydrate({
    id: over.id ?? 'quote-1',
    companyId: over.companyId ?? 'co-1',
    customerId: 'cus-1',
    status: 'signed',
    number: 'D-2026-0001',
    depositPct: null,
    validUntil: null,
    signature: { signerName: 'Ada', signedAt: AT, method: 'onsite_draw', accepted: true },
    lines: [
      { id: 'l1', label: 'Intervention', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 },
    ],
  });
}

function draftInvoice(over: Partial<InvoiceSnapshot> = {}): Invoice {
  return Invoice.rehydrate({
    id: 'invoice-1',
    companyId: 'co-1',
    customerId: 'cus-1',
    kind: 'final',
    status: 'draft',
    lines: [
      { id: 'l1', label: 'Intervention', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 },
    ],
    number: null,
    frozenTotals: null,
    mentions: [],
    issuedAt: null,
    dueAt: null,
    paid: 0,
    depositPct: null,
    parentQuoteId: null,
    ...over,
  });
}

function makeEnv(input: { quote?: Quote; invoices?: Invoice[] } = {}) {
  const quotes = new Map<string, Quote>();
  const invoices = new Map<string, Invoice>();
  const quote = input.quote ?? signedQuote();
  quotes.set(quote.id, quote);
  for (const invoice of input.invoices ?? []) invoices.set(invoice.id, invoice);
  let quoteSaves = 0;
  let invoiceSaves = 0;

  const quoteRepo = {
    findById: async (id: string) => quotes.get(id) ?? null,
    save: async (q: Quote) => {
      quoteSaves += 1;
      quotes.set(q.id, q);
    },
  };
  const invoiceRepo = {
    findById: async (id: string) => invoices.get(id) ?? null,
    listByCompany: async (companyId: string) =>
      [...invoices.values()].filter((i) => i.companyId === companyId),
    save: async (i: Invoice) => {
      invoiceSaves += 1;
      invoices.set(i.id, i);
    },
  };

  return {
    quote,
    quotes,
    invoices,
    attachToQuote: new AttachPurchaseOrderToQuote({ quotes: quoteRepo, invoices: invoiceRepo, clock }),
    attachToInvoice: new AttachPurchaseOrderToInvoice({ invoices: invoiceRepo, clock }),
    detach: new DetachPurchaseOrder({ quotes: quoteRepo, invoices: invoiceRepo, clock }),
    counts: () => ({ quoteSaves, invoiceSaves }),
  };
}

describe('AttachPurchaseOrderToQuote (B8)', () => {
  it('attache le bon de commande à un devis signé non facturé et bump la révision', async () => {
    const env = makeEnv();
    const r = await env.attachToQuote.execute({
      companyId: 'co-1',
      quoteId: 'quote-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      targetType: 'quote',
      targetId: 'quote-1',
      revision: 2,
      purchaseOrder: PO,
    });
    expect(env.quotes.get('quote-1')?.purchaseOrder).toEqual(PO);
    expect(env.counts()).toEqual({ quoteSaves: 1, invoiceSaves: 0 });
    // Le clone protège l'agrégat partagé : l'instance d'origine n'a pas été mutée.
    expect(env.quote.purchaseOrder).toBeNull();
  });

  it('assainit et valide la référence AVANT toute lecture métier', async () => {
    const env = makeEnv();
    const r = await env.attachToQuote.execute({
      companyId: 'co-1',
      quoteId: 'quote-1',
      purchaseOrder: { number: '   ' },
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
  });

  it('tenant-scoped : un devis d’une AUTRE société est invisible (not_found)', async () => {
    const env = makeEnv();
    const r = await env.attachToQuote.execute({
      companyId: 'co-intrus',
      quoteId: 'quote-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    expect(r).toEqual({ ok: false, error: { kind: 'not_found', entity: 'quote', id: 'quote-1' } });
    expect(env.counts()).toEqual({ quoteSaves: 0, invoiceSaves: 0 });
  });

  it('révision optimiste : une révision périmée -> conflict, rien n’est sauvé', async () => {
    const env = makeEnv();
    const r = await env.attachToQuote.execute({
      companyId: 'co-1',
      quoteId: 'quote-1',
      purchaseOrder: PO,
      expectedRevision: 7,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('conflict');
    expect(env.counts()).toEqual({ quoteSaves: 0, invoiceSaves: 0 });
  });

  it('révision invalide (0, NaN) -> validation', async () => {
    const env = makeEnv();
    for (const expectedRevision of [0, Number.NaN, 1.5]) {
      const r = await env.attachToQuote.execute({
        companyId: 'co-1',
        quoteId: 'quote-1',
        purchaseOrder: PO,
        expectedRevision,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('validation');
    }
  });

  it('devis DÉJÀ FACTURÉ (pièce non annulée dérivée) -> conflict qui dirige vers la facture', async () => {
    const env = makeEnv({
      invoices: [draftInvoice({ id: 'inv-derivee', parentQuoteId: 'quote-1' })],
    });
    const r = await env.attachToQuote.execute({
      companyId: 'co-1',
      quoteId: 'quote-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('conflict');
      if (r.error.kind === 'conflict') expect(r.error.reason).toContain('facture');
    }
  });

  it('une facture ANNULÉE ne bloque pas : le devis reste la source du bon de commande', async () => {
    const env = makeEnv({
      invoices: [draftInvoice({ id: 'inv-annulee', parentQuoteId: 'quote-1', status: 'cancelled' })],
    });
    const r = await env.attachToQuote.execute({
      companyId: 'co-1',
      quoteId: 'quote-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    expect(r.ok).toBe(true);
  });

  it('idempotent : rejouer la MÊME référence sur la nouvelle révision ne re-sauve pas', async () => {
    const env = makeEnv();
    const first = await env.attachToQuote.execute({
      companyId: 'co-1',
      quoteId: 'quote-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    expect(first.ok).toBe(true);
    const replay = await env.attachToQuote.execute({
      companyId: 'co-1',
      quoteId: 'quote-1',
      purchaseOrder: { number: ' BC-RATP-4500123456 ', receivedAt: AT }, // assaini -> identique
      expectedRevision: 2,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.revision).toBe(2);
    expect(env.counts()).toEqual({ quoteSaves: 1, invoiceSaves: 0 });
  });
});

describe('AttachPurchaseOrderToInvoice (B8)', () => {
  it('attache sur une facture BROUILLON du tenant', async () => {
    const env = makeEnv({ invoices: [draftInvoice()] });
    const r = await env.attachToInvoice.execute({
      companyId: 'co-1',
      invoiceId: 'invoice-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      targetType: 'invoice',
      targetId: 'invoice-1',
      revision: 2,
      purchaseOrder: PO,
    });
    expect(env.invoices.get('invoice-1')?.purchaseOrder).toEqual(PO);
  });

  it('facture ÉMISE : le PO se fixe AVANT émission -> erreur domaine', async () => {
    const env = makeEnv({
      invoices: [
        draftInvoice({
          status: 'issued',
          number: 'F-2026-0001',
          issuedAt: '2026-07-01',
          dueAt: '2026-07-31',
          frozenTotals: { ht: 100000, vatByRate: { '20': 20000 }, vat: 20000, ttc: 120000, netToPay: 120000 },
        }),
      ],
    });
    const r = await env.attachToInvoice.execute({
      companyId: 'co-1',
      invoiceId: 'invoice-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'domain', error: { field: 'status' } });
    expect(env.counts()).toEqual({ quoteSaves: 0, invoiceSaves: 0 });
  });

  it('tenant-scoped + révision optimiste', async () => {
    const env = makeEnv({ invoices: [draftInvoice()] });
    const intrus = await env.attachToInvoice.execute({
      companyId: 'co-intrus',
      invoiceId: 'invoice-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    expect(intrus).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'invoice', id: 'invoice-1' },
    });
    const perime = await env.attachToInvoice.execute({
      companyId: 'co-1',
      invoiceId: 'invoice-1',
      purchaseOrder: PO,
      expectedRevision: 9,
    });
    expect(perime.ok).toBe(false);
    if (!perime.ok) expect(perime.error.kind).toBe('conflict');
  });

  it('idempotent : même référence rejouée -> ok sans nouvelle sauvegarde', async () => {
    const env = makeEnv({ invoices: [draftInvoice()] });
    await env.attachToInvoice.execute({
      companyId: 'co-1',
      invoiceId: 'invoice-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    const replay = await env.attachToInvoice.execute({
      companyId: 'co-1',
      invoiceId: 'invoice-1',
      purchaseOrder: PO,
      expectedRevision: 2,
    });
    expect(replay.ok).toBe(true);
    expect(env.counts()).toEqual({ quoteSaves: 0, invoiceSaves: 1 });
  });
});

describe('DetachPurchaseOrder (B8 — retrait explicite)', () => {
  it('détache du devis non facturé (après attache : révision 2 -> 3)', async () => {
    const env = makeEnv();
    await env.attachToQuote.execute({
      companyId: 'co-1',
      quoteId: 'quote-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    const r = await env.detach.execute({
      companyId: 'co-1',
      target: { type: 'quote', quoteId: 'quote-1' },
      expectedRevision: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ targetType: 'quote', targetId: 'quote-1', revision: 3, purchaseOrder: null });
    expect(env.quotes.get('quote-1')?.purchaseOrder).toBeNull();
  });

  it('devis déjà facturé -> conflict (le retrait se fait sur la facture brouillon)', async () => {
    const quote = signedQuote();
    const env = makeEnv({
      quote,
      invoices: [draftInvoice({ id: 'inv-derivee', parentQuoteId: 'quote-1' })],
    });
    const r = await env.detach.execute({
      companyId: 'co-1',
      target: { type: 'quote', quoteId: 'quote-1' },
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('conflict');
  });

  it('devis sans bon de commande -> erreur domaine explicite (pas de no-op silencieux)', async () => {
    const env = makeEnv();
    const r = await env.detach.execute({
      companyId: 'co-1',
      target: { type: 'quote', quoteId: 'quote-1' },
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'domain', error: { field: 'purchaseOrder' } });
  });

  it('détache d’une facture BROUILLON ; refuse une facture émise', async () => {
    const env = makeEnv({ invoices: [draftInvoice()] });
    await env.attachToInvoice.execute({
      companyId: 'co-1',
      invoiceId: 'invoice-1',
      purchaseOrder: PO,
      expectedRevision: 1,
    });
    const r = await env.detach.execute({
      companyId: 'co-1',
      target: { type: 'invoice', invoiceId: 'invoice-1' },
      expectedRevision: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.purchaseOrder).toBeNull();
    expect(env.invoices.get('invoice-1')?.purchaseOrder).toBeNull();

    const issued = draftInvoice({
      id: 'inv-emise',
      status: 'issued',
      number: 'F-2026-0002',
      issuedAt: '2026-07-01',
      dueAt: '2026-07-31',
      frozenTotals: { ht: 100000, vatByRate: { '20': 20000 }, vat: 20000, ttc: 120000, netToPay: 120000 },
      purchaseOrder: PO,
      revision: 2,
    });
    env.invoices.set(issued.id, issued);
    const ko = await env.detach.execute({
      companyId: 'co-1',
      target: { type: 'invoice', invoiceId: 'inv-emise' },
      expectedRevision: 2,
    });
    expect(ko.ok).toBe(false);
    if (!ko.ok) expect(ko.error).toMatchObject({ kind: 'domain', error: { field: 'status' } });
  });
});
