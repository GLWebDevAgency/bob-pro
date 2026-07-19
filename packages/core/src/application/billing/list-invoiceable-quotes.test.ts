import { describe, expect, it } from 'vitest';
import { ListInvoiceableQuotes } from './list-invoiceable-quotes';
import { Quote, type QuoteSnapshot } from '../../domain/billing/quote/quote';
import { Invoice, type InvoiceSnapshot } from '../../domain/billing/invoice/invoice';
import { Customer } from '../../domain/customer/customer';

const AT = '2026-07-10T09:00:00.000Z';
const PO = { number: 'BC-RATP-4500123456', receivedAt: AT, documentId: null };

function quote(over: Partial<QuoteSnapshot> = {}): Quote {
  return Quote.rehydrate({
    id: 'quote-1',
    companyId: 'co-1',
    customerId: 'cus-1',
    status: 'signed',
    number: 'D-2026-0001',
    depositPct: 30,
    validUntil: null,
    signature: { signerName: 'Ada', signedAt: AT, method: 'onsite_draw', accepted: true },
    lines: [
      { id: 'l1', label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 },
    ],
    ...over,
  });
}

function invoice(over: Partial<InvoiceSnapshot> = {}): Invoice {
  return Invoice.rehydrate({
    id: 'inv-1',
    companyId: 'co-1',
    customerId: 'cus-1',
    kind: 'final',
    status: 'draft',
    lines: [],
    number: null,
    frozenTotals: null,
    mentions: [],
    issuedAt: null,
    dueAt: null,
    paid: 0,
    depositPct: null,
    parentQuoteId: 'quote-1',
    ...over,
  });
}

function makeEnv(input: { quotes?: Quote[]; invoices?: Invoice[] } = {}) {
  const quotes = input.quotes ?? [quote()];
  const invoices = input.invoices ?? [];
  const customerR = Customer.of({
    id: 'cus-1',
    companyId: 'co-1',
    name: 'RATP Infrastructures',
    type: 'b2b',
    siren: '412280737',
    address: { line1: '54 quai de la Rapée', zip: '75012', city: 'Paris' },
  });
  if (!customerR.ok) throw new Error('customer');
  return new ListInvoiceableQuotes({
    quotes: { listByCompany: async (companyId) => quotes.filter((q) => q.companyId === companyId) },
    invoices: {
      listByCompany: async (companyId) => invoices.filter((i) => i.companyId === companyId),
    },
    customers: { listByCompany: async () => [customerR.value] },
  });
}

describe('ListInvoiceableQuotes (ASK-2 / B8)', () => {
  it('expose le devis signé avec son bon de commande — le flow facturation l’affiche', async () => {
    const usecase = makeEnv({ quotes: [quote({ purchaseOrder: PO, revision: 2 })] });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([
      {
        id: 'quote-1',
        number: 'D-2026-0001',
        customerName: 'RATP Infrastructures',
        totalTtcCents: 120000,
        depositPct: 30,
        depositInvoiced: false,
        purchaseOrder: PO,
      },
    ]);
  });

  it('compat : devis sans bon de commande -> purchaseOrder null (jamais inventé)', async () => {
    const usecase = makeEnv();
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]?.purchaseOrder).toBeNull();
  });

  it('seuls les devis SIGNÉS sont facturables', async () => {
    const usecase = makeEnv({ quotes: [quote({ status: 'sent' })] });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('sort de la liste dès qu’une finale non annulée existe ; une annulée ne compte pas', async () => {
    const withFinal = makeEnv({ invoices: [invoice()] });
    const r1 = await withFinal.execute({ companyId: 'co-1' });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toEqual([]);

    const withCancelled = makeEnv({ invoices: [invoice({ status: 'cancelled' })] });
    const r2 = await withCancelled.execute({ companyId: 'co-1' });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toHaveLength(1);
  });

  it('signale l’acompte déjà émis (depositInvoiced) pour rendre la finale évidente', async () => {
    const usecase = makeEnv({
      invoices: [invoice({ id: 'inv-dep', kind: 'deposit', status: 'issued' })],
    });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]?.depositInvoiced).toBe(true);
  });

  it('tenant-scoped : les devis d’une autre société sont invisibles', async () => {
    const usecase = makeEnv({ quotes: [quote({ companyId: 'co-autre' })] });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});
