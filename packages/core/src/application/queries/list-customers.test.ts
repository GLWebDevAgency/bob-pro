import { describe, expect, it } from 'vitest';
import { Customer } from '../../domain/customer/customer';
import { Invoice, type InvoiceSnapshot } from '../../domain/billing/invoice/invoice';
import { Payment } from '../../domain/payment/payment';
import type {
  CustomerRepository,
  InvoiceRepository,
  PaymentRepository,
} from '../ports/repositories';
import { ListCustomers } from './list-customers';

function customer(id = 'customer-a') {
  const result = Customer.of({
    id,
    companyId: 'company-a',
    type: 'b2b',
    name: 'Client réel',
    address: { line1: '', zip: '', city: '' },
  });
  if (!result.ok) throw new Error('client de test invalide');
  return result.value;
}

function invoice(
  id: string,
  overrides: Partial<InvoiceSnapshot> = {},
): Invoice {
  return Invoice.rehydrate({
    id,
    companyId: 'company-a',
    customerId: 'customer-a',
    kind: 'final',
    status: 'issued',
    lines: [],
    number: `F-${id}`,
    frozenTotals: { ht: 100_000, vat: 0, ttc: 100_000, netToPay: 100_000, vatByRate: {} },
    mentions: [],
    issuedAt: '2026-06-01',
    dueAt: '2026-07-01',
    paid: 0,
    depositPct: null,
    parentQuoteId: null,
    ...overrides,
  });
}

function payment(id: string, invoiceId: string, receivedAt: string) {
  const result = Payment.record({
    id,
    companyId: 'company-a',
    invoiceId,
    amount: 100_000,
    method: 'transfer',
    receivedAt,
  });
  if (!result.ok) throw new Error('paiement de test invalide');
  return result.value;
}

function useCase(input: {
  customers?: ReturnType<typeof customer>[];
  invoices?: Invoice[];
  payments?: ReturnType<typeof payment>[];
}) {
  const customers = input.customers ?? [customer()];
  const invoices = input.invoices ?? [];
  const payments = input.payments ?? [];
  const customerRepo: CustomerRepository = {
    findById: async (id) => customers.find((entry) => entry.id === id) ?? null,
    listByCompany: async (companyId) => customers.filter((entry) => entry.companyId === companyId),
    save: async () => undefined,
  };
  const invoiceRepo: InvoiceRepository = {
    findById: async () => null,
    lockById: async () => null,
    findByParentQuoteId: async () => null,
    findCreditNoteBySourceInvoiceId: async () => null,
    listByCompany: async (companyId) => invoices.filter((entry) => entry.companyId === companyId),
    save: async () => undefined,
    deleteById: async () => undefined,
  };
  const paymentRepo: PaymentRepository = {
    save: async () => undefined,
    findById: async () => null,
    listByInvoice: async (invoiceId) => payments.filter((entry) => entry.invoiceId === invoiceId),
    listByCompany: async (companyId) => payments.filter((entry) => entry.companyId === companyId),
    findByIdempotencyKey: async () => null,
  };
  return new ListCustomers({ customers: customerRepo, invoices: invoiceRepo, payments: paymentRepo });
}

describe('ListCustomers — métriques financières exclusivement dérivées', () => {
  it('n’invente ni score ni délai pour un nouveau client', async () => {
    const result = await useCase({}).execute({ companyId: 'company-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      score: null,
      scoreBand: null,
      scoreStatus: 'model_not_ratified',
      outstandingCents: 0,
      avgDelayDays: null,
      paidOnTimeRatio: null,
      paymentHistoryStatus: 'insufficient_history',
      settledInvoiceCount: 0,
    });
    expect(result.value[0]).not.toHaveProperty('outstanding');
  });

  it('projette l’encours réel depuis le net à payer et les encaissements de la facture', async () => {
    const result = await useCase({
      invoices: [invoice('open', { status: 'partially_paid', paid: 25_000 })],
      payments: [
        (() => {
          const recorded = Payment.record({
            id: 'payment-partial',
            companyId: 'company-a',
            invoiceId: 'open',
            amount: 25_000,
            method: 'transfer',
            receivedAt: '2026-06-20T10:00:00.000Z',
          });
          if (!recorded.ok) throw new Error('paiement de test invalide');
          return recorded.value;
        })(),
      ],
    }).execute({ companyId: 'company-a' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.outstandingCents).toBe(75_000);
  });

  it('ne publie un délai qu’après trois factures soldées rapprochées aux paiements', async () => {
    const invoices = ['one', 'two', 'three'].map((id) =>
      invoice(id, { status: 'paid', paid: 100_000 }),
    );
    const payments = [
      payment('p-one', 'one', '2026-06-11T10:00:00.000Z'),
      payment('p-two', 'two', '2026-06-21T10:00:00.000Z'),
      payment('p-three', 'three', '2026-07-01T10:00:00.000Z'),
    ];
    const result = await useCase({ invoices, payments }).execute({ companyId: 'company-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      paymentHistoryStatus: 'known',
      settledInvoiceCount: 3,
      avgDelayDays: 20,
      paidOnTimeRatio: 1,
      score: null,
    });
  });
});
