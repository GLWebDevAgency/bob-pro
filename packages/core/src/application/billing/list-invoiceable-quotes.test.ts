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

function makeEnv(
  input: {
    quotes?: Quote[];
    invoices?: Invoice[];
    customerType?: 'b2c' | 'b2b' | 'b2g';
    customerMissing?: boolean;
    now?: string;
  } = {},
) {
  const quotes = input.quotes ?? [quote()];
  const invoices = input.invoices ?? [];
  const customerR = Customer.of({
    id: 'cus-1',
    companyId: 'co-1',
    name: 'RATP Infrastructures',
    type: input.customerType ?? 'b2b',
    ...(input.customerType === 'b2c' ? {} : { siren: '412280737' }),
    address: { line1: '54 quai de la Rapée', zip: '75012', city: 'Paris' },
  });
  if (!customerR.ok) throw new Error('customer');
  return new ListInvoiceableQuotes({
    quotes: { listByCompany: async (companyId) => quotes.filter((q) => q.companyId === companyId) },
    invoices: {
      listByCompany: async (companyId) => invoices.filter((i) => i.companyId === companyId),
    },
    customers: { listByCompany: async () => (input.customerMissing ? [] : [customerR.value]) },
    clock: {
      now: () => input.now ?? '2026-08-01T09:00:00.000Z',
      today: () => (input.now ?? '2026-08-01T09:00:00.000Z').slice(0, 10),
    },
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
        situationInvoiced: false,
        depositAvailable: false,
        depositUnavailableReason: expect.stringContaining('Factur-X EXTENDED'),
        purchaseOrder: PO,
        finalBlockedUntil: null,
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

  it('signale une situation vivante (situationInvoiced) — brouillon compris, annulée jamais', async () => {
    const living = makeEnv({
      invoices: [invoice({ id: 'inv-sit', kind: 'situation', status: 'draft' })],
    });
    const r = await living.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]?.situationInvoiced).toBe(true);

    const cancelled = makeEnv({
      invoices: [invoice({ id: 'inv-sit', kind: 'situation', status: 'cancelled' })],
    });
    const r2 = await cancelled.execute({ companyId: 'co-1' });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value[0]?.situationInvoiced).toBe(false);
  });

  it('tenant-scoped : les devis d’une autre société sont invisibles', async () => {
    const usecase = makeEnv({ quotes: [quote({ companyId: 'co-autre' })] });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('refuse une option orpheline plutôt que d’inventer le nom ou le canal fiscal du client', async () => {
    const usecase = makeEnv({ customerMissing: true });

    const result = await usecase.execute({ companyId: 'co-1' });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'customer-reference' },
    });
  });

  // ── A3 : le gel de rétractation est ANNONCÉ par la liste (finalBlockedUntil) ──
  // Devis signé le 10/07/2026 (vendredi) → J+14 = 24/07 (vendredi) → délai jusqu'au 25/07 00:00 Paris.

  it('A3 : b2c pendant le délai → finalBlockedUntil = premier jour où la finale est possible', async () => {
    const usecase = makeEnv({ customerType: 'b2c', now: '2026-07-15T09:00:00.000Z' });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]?.finalBlockedUntil).toBe('2026-07-25');
      expect(r.value[0]?.depositAvailable).toBe(true);
      expect(r.value[0]?.depositUnavailableReason).toBeNull();
    }
  });

  it('A3 : b2c après le délai → null (déblocage automatique)', async () => {
    const usecase = makeEnv({ customerType: 'b2c', now: '2026-07-26T09:00:00.000Z' });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]?.finalBlockedUntil).toBeNull();
  });

  it('A3 : b2c avec exécution anticipée tracée → null (aucun gel, L221-25)', async () => {
    const usecase = makeEnv({
      customerType: 'b2c',
      now: '2026-07-15T09:00:00.000Z',
      quotes: [
        quote({
          signature: {
            signerName: 'Ada',
            signedAt: AT,
            method: 'remote_link',
            accepted: true,
            earlyExecution: { requestedAt: AT },
          },
        }),
      ],
    });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]?.finalBlockedUntil).toBeNull();
  });

  it('A3 : b2b pendant la même fenêtre → null (droit inapplicable)', async () => {
    const usecase = makeEnv({ customerType: 'b2b', now: '2026-07-15T09:00:00.000Z' });
    const r = await usecase.execute({ companyId: 'co-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]?.finalBlockedUntil).toBeNull();
  });
});
