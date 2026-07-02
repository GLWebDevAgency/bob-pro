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
import {
  type SequenceCounterPort,
  type ClockPort,
  type IdGeneratorPort,
  type CounterKey,
} from '../ports/services';

/**
 * Environnement billing in-memory pour les TESTS (repos + horloge + compteurs déterministes).
 * Extrait de flow.integration.test.ts pour être partagé avec les tests de flows (C02).
 * Ne fait PAS partie de l'API publique du package (non exporté par src/index.ts).
 */
export function makeEnv() {
  const company = seedCompany();
  const customers = seedCustomers();
  // Client b2c du test d'or TVA 10 % chauffe-eau (HT 1480 / TVA 148 / TTC 1628 / acompte 488,40).
  // Martin est devenu b2b à l'alignement proto (C02 PARITY-FAIL #1) → on prend M. Bernard.
  const customer = customers.find((c) => c.id === 'cust-bernard')!; // M. Bernard (b2c)

  const quotesMap = new Map<string, Quote>();
  const invoicesMap = new Map<string, Invoice>();
  const paymentsArr: Payment[] = [];

  const companyRepo: CompanyRepository = {
    findById: async (id) => (id === company.id ? company : null),
    list: async () => [company],
    save: async () => {},
  };
  const customerRepo: CustomerRepository = {
    findById: async (id) => customers.find((c) => c.id === id) ?? null,
    listByCompany: async () => customers,
    save: async () => {},
  };
  const quoteRepo: QuoteRepository = {
    findById: async (id) => quotesMap.get(id) ?? null,
    lockById: async (id) => quotesMap.get(id) ?? null,
    listByCompany: async (companyId) => [...quotesMap.values()].filter((q) => q.companyId === companyId),
    save: async (q) => {
      quotesMap.set(q.id, q);
    },
  };
  const invoiceRepo: InvoiceRepository = {
    findById: async (id) => invoicesMap.get(id) ?? null,
    lockById: async (id) => invoicesMap.get(id) ?? null,
    findByParentQuoteId: async (companyId, parentQuoteId, kind) =>
      [...invoicesMap.values()].find(
        (i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind,
      ) ?? null,
    listByCompany: async (companyId) => [...invoicesMap.values()].filter((i) => i.companyId === companyId),
    save: async (i) => {
      invoicesMap.set(i.id, i);
    },
  };
  const paymentRepo: PaymentRepository = {
    save: async (p) => {
      paymentsArr.push(p);
    },
    findById: async (companyId, id) => paymentsArr.find((p) => p.companyId === companyId && p.id === id) ?? null,
    listByInvoice: async (invoiceId) => paymentsArr.filter((p) => p.invoiceId === invoiceId),
    findByIdempotencyKey: async (companyId, key) =>
      paymentsArr.find((p) => p.companyId === companyId && p.idempotencyKey === key) ?? null,
  };
  const uow = { runInTransaction: <T>(fn: () => Promise<T>): Promise<T> => fn() };

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

  return { company, customer, companyRepo, customerRepo, quoteRepo, invoiceRepo, paymentRepo, uow, ids, clock, counters };
}
