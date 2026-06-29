import {
  seedCompany,
  seedCustomers,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type PaymentRepository,
  type ExpenseRepository,
  type SequenceCounterPort,
} from '@bob/core';
import {
  InMemoryCompanyRepository,
  InMemoryCustomerRepository,
  InMemoryQuoteRepository,
  InMemoryInvoiceRepository,
  InMemoryPaymentRepository,
  InMemoryExpenseRepository,
  InMemorySequenceCounter,
} from './in-memory';

export const PERSISTENCE = Symbol('PERSISTENCE');

/** Bundle de persistance injecté dans BackendService. Deux implémentations : in-memory & Prisma. */
export interface Persistence {
  companies: CompanyRepository;
  customers: CustomerRepository;
  quotes: QuoteRepository;
  invoices: InvoiceRepository;
  payments: PaymentRepository;
  expenses: ExpenseRepository;
  counters: SequenceCounterPort;
  seed(): Promise<void>;
}

export class InMemoryPersistence implements Persistence {
  readonly companies = new InMemoryCompanyRepository();
  readonly customers = new InMemoryCustomerRepository();
  readonly quotes = new InMemoryQuoteRepository();
  readonly invoices = new InMemoryInvoiceRepository();
  readonly payments = new InMemoryPaymentRepository();
  readonly expenses = new InMemoryExpenseRepository();
  readonly counters = new InMemorySequenceCounter();
  async seed(): Promise<void> {
    this.companies.seed(seedCompany());
    this.customers.seed(seedCustomers());
  }
}
