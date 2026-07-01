import {
  seedCompany,
  seedCustomers,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type DocumentRepository,
  type PaymentRepository,
  type PublicAccessTokenRepository,
  type ExpenseRepository,
  type SequenceCounterPort,
} from '@bob/core';
import type { DocumentArchiveJobRepository } from './document-archive-jobs';
import type { NotificationJobRepository } from './notification-jobs';
import type { AgentJournalRepository } from './agent-journal';
import { InMemoryAgentJournalRepository } from './agent-journal';
import {
  InMemoryCompanyRepository,
  InMemoryCustomerRepository,
  InMemoryQuoteRepository,
  InMemoryInvoiceRepository,
  InMemoryDocumentRepository,
  InMemoryPaymentRepository,
  InMemoryPublicAccessTokenRepository,
  InMemoryExpenseRepository,
  InMemorySequenceCounter,
  InMemoryDocumentArchiveJobRepository,
  InMemoryNotificationJobRepository,
} from './in-memory';

export const PERSISTENCE = Symbol('PERSISTENCE');

/** Bundle de persistance injecté dans BackendService. Deux implémentations : in-memory & Prisma. */
export interface Persistence {
  companies: CompanyRepository;
  customers: CustomerRepository;
  quotes: QuoteRepository;
  invoices: InvoiceRepository;
  documents: DocumentRepository;
  documentArchiveJobs: DocumentArchiveJobRepository;
  notificationJobs: NotificationJobRepository;
  payments: PaymentRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  expenses: ExpenseRepository;
  agentJournal: AgentJournalRepository;
  counters: SequenceCounterPort;
  /** Unité de travail : exécute `fn` atomiquement (transaction DB en prod ; direct en mémoire). */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Défense tenant DB : no-op en mémoire, transaction RLS avec app.current_company_id côté Prisma. */
  runWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T>;
  seed(): Promise<void>;
}

export class InMemoryPersistence implements Persistence {
  readonly companies = new InMemoryCompanyRepository();
  readonly customers = new InMemoryCustomerRepository();
  readonly quotes = new InMemoryQuoteRepository();
  readonly invoices = new InMemoryInvoiceRepository();
  readonly documents = new InMemoryDocumentRepository();
  readonly documentArchiveJobs = new InMemoryDocumentArchiveJobRepository();
  readonly notificationJobs = new InMemoryNotificationJobRepository();
  readonly payments = new InMemoryPaymentRepository();
  readonly publicAccessTokens = new InMemoryPublicAccessTokenRepository();
  readonly expenses = new InMemoryExpenseRepository();
  readonly agentJournal = new InMemoryAgentJournalRepository();
  readonly counters = new InMemorySequenceCounter();
  // En mémoire (JS mono-thread) : pas de transaction réelle, mais on annule l'allocation du compteur
  // si `fn` lève — sinon une erreur métier après allocation laisserait un trou (symétrie avec Prisma).
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const snap = this.counters.snapshot();
    try {
      return await fn();
    } catch (e) {
      this.counters.restore(snap);
      throw e;
    }
  }
  async runWithTenant<T>(_companyId: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async seed(): Promise<void> {
    this.companies.seed(seedCompany());
    this.customers.seed(seedCustomers());
  }
}
