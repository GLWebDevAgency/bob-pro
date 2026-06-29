import { describe, it, expect } from 'vitest';
import { CreateQuote } from './create-quote';
import { SendQuote } from './send-quote';
import { SignQuote } from './sign-quote';
import { GenerateInvoiceFromQuote } from './generate-invoice-from-quote';
import { IssueInvoice } from './issue-invoice';
import { RegisterPayment } from './register-payment';
import { type Quote } from '../../domain/billing/quote/quote';
import { type Invoice } from '../../domain/billing/invoice/invoice';
import { type Payment } from '../../domain/payment/payment';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { seedCompany, seedCustomers } from '../fixtures';
import {
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type PaymentRepository,
} from '../ports/repositories';
import { type SequenceCounterPort, type ClockPort, type IdGeneratorPort, type CounterKey } from '../ports/services';

function makeEnv() {
  const company = seedCompany();
  const customers = seedCustomers();
  const customer = customers[1]!; // M. Martin (b2c)

  const quotesMap = new Map<string, Quote>();
  const invoicesMap = new Map<string, Invoice>();
  const paymentsArr: Payment[] = [];

  const companyRepo: CompanyRepository = {
    findById: async (id) => (id === company.id ? company : null),
    save: async () => {},
  };
  const customerRepo: CustomerRepository = {
    findById: async (id) => customers.find((c) => c.id === id) ?? null,
    listByCompany: async () => customers,
    save: async () => {},
  };
  const quoteRepo: QuoteRepository = {
    findById: async (id) => quotesMap.get(id) ?? null,
    save: async (q) => {
      quotesMap.set(q.id, q);
    },
  };
  const invoiceRepo: InvoiceRepository = {
    findById: async (id) => invoicesMap.get(id) ?? null,
    save: async (i) => {
      invoicesMap.set(i.id, i);
    },
  };
  const paymentRepo: PaymentRepository = {
    save: async (p) => {
      paymentsArr.push(p);
    },
    listByInvoice: async (invoiceId) => paymentsArr.filter((p) => p.invoiceId === invoiceId),
  };

  let idCounter = 0;
  const ids: IdGeneratorPort = {
    newId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
  };
  const clock: ClockPort = {
    now: () => '2026-06-01T09:00:00.000Z',
    today: () => '2026-06-01',
  };
  const sequences: Record<CounterKey, number> = { quote: 0, invoice: 0, credit: 0 };
  const counters: SequenceCounterPort = {
    allocate: async ({ counterKey, fiscalYear }) => {
      sequences[counterKey] += 1;
      const prefix = counterKey === 'quote' ? 'D' : 'F';
      return { sequence: sequences[counterKey], formatted: DocNumber.format(prefix, fiscalYear, sequences[counterKey]) };
    },
  };

  return { company, customer, companyRepo, customerRepo, quoteRepo, invoiceRepo, paymentRepo, ids, clock, counters };
}

describe('Flux Devis -> signature -> facture -> paiement (intégration)', () => {
  it('déroule le flux complet avec numéros séquentiels et acompte 488,40 €', async () => {
    const env = makeEnv();

    const created = await new CreateQuote({
      quotes: env.quoteRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({
      companyId: env.company.id,
      customerId: env.customer.id,
      lines: [
        { label: 'Chauffe-eau 200 L', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
        { label: "Main d'oeuvre", category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
      ],
      depositPct: 30,
      context: { housingOlderThan2y: true },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.totals.ttc).toBe(162800);
    const quoteId = created.value.quoteId;

    const sent = await new SendQuote({ quotes: env.quoteRepo, counters: env.counters, clock: env.clock }).execute({ quoteId });
    expect(sent.ok).toBe(true);
    if (sent.ok) expect(sent.value.number).toBe('D-2026-0001');

    const signed = await new SignQuote({ quotes: env.quoteRepo, clock: env.clock }).execute({ quoteId, signerName: 'M. Martin' });
    expect(signed.ok).toBe(true);

    const gen = await new GenerateInvoiceFromQuote({ quotes: env.quoteRepo, invoices: env.invoiceRepo, ids: env.ids }).execute({ quoteId });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const invoiceId = gen.value.invoiceId;

    const issued = await new IssueInvoice({
      invoices: env.invoiceRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      counters: env.counters,
      clock: env.clock,
    }).execute({ invoiceId });
    expect(issued.ok).toBe(true);
    if (issued.ok) expect(issued.value.number).toBe('F-2026-0001');

    const paid = await new RegisterPayment({
      invoices: env.invoiceRepo,
      payments: env.paymentRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({ invoiceId, amount: 48840, method: 'transfer' });
    expect(paid.ok).toBe(true);
    if (paid.ok) expect(paid.value.status).toBe('paid');

    const invoice = await env.invoiceRepo.findById(invoiceId);
    expect(invoice?.status).toBe('paid');
    expect(invoice?.number).toBe('F-2026-0001');
    expect(invoice?.dueAt).toBe('2026-07-01');
    expect((invoice?.mentions.length ?? 0)).toBeGreaterThan(0);
  });

  it('numérotation séquentielle sans trou sur deux devis', async () => {
    const env = makeEnv();
    const create = new CreateQuote({
      quotes: env.quoteRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    });
    const send = new SendQuote({ quotes: env.quoteRepo, counters: env.counters, clock: env.clock });
    const line = { label: 'Intervention', category: 'labor' as const, qty: 1, unitPriceHT: 50000, vatRate: 20 as const };

    const q1 = await create.execute({ companyId: env.company.id, customerId: env.customer.id, lines: [line] });
    const q2 = await create.execute({ companyId: env.company.id, customerId: env.customer.id, lines: [line] });
    expect(q1.ok && q2.ok).toBe(true);
    if (!q1.ok || !q2.ok) return;

    const s1 = await send.execute({ quoteId: q1.value.quoteId });
    const s2 = await send.execute({ quoteId: q2.value.quoteId });
    expect(s1.ok && s1.value.number).toBe('D-2026-0001');
    expect(s2.ok && s2.value.number).toBe('D-2026-0002');
  });
});
