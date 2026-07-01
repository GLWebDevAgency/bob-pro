import { seedCompany, seedCustomers } from '@bob/core';
import type { Persistence } from '../persistence';
import { PrismaService } from './prisma.service';
import {
  PrismaCompanyRepository,
  PrismaCustomerRepository,
  PrismaQuoteRepository,
  PrismaInvoiceRepository,
  PrismaDocumentRepository,
  PrismaDocumentArchiveJobRepository,
  PrismaNotificationJobRepository,
  PrismaPaymentRepository,
  PrismaPublicAccessTokenRepository,
  PrismaExpenseRepository,
  PrismaAgentJournalRepository,
  PrismaSequenceCounter,
} from './repositories';
import { companyPropsToCreate, customerPropsToCreate } from './mappers';

export class PrismaPersistence implements Persistence {
  readonly companies: PrismaCompanyRepository;
  readonly customers: PrismaCustomerRepository;
  readonly quotes: PrismaQuoteRepository;
  readonly invoices: PrismaInvoiceRepository;
  readonly documents: PrismaDocumentRepository;
  readonly documentArchiveJobs: PrismaDocumentArchiveJobRepository;
  readonly notificationJobs: PrismaNotificationJobRepository;
  readonly payments: PrismaPaymentRepository;
  readonly publicAccessTokens: PrismaPublicAccessTokenRepository;
  readonly expenses: PrismaExpenseRepository;
  readonly agentJournal: PrismaAgentJournalRepository;
  readonly counters: PrismaSequenceCounter;

  constructor(private readonly prisma: PrismaService) {
    this.companies = new PrismaCompanyRepository(prisma);
    this.customers = new PrismaCustomerRepository(prisma);
    this.quotes = new PrismaQuoteRepository(prisma);
    this.invoices = new PrismaInvoiceRepository(prisma);
    this.documents = new PrismaDocumentRepository(prisma);
    this.documentArchiveJobs = new PrismaDocumentArchiveJobRepository(prisma);
    this.notificationJobs = new PrismaNotificationJobRepository(prisma);
    this.payments = new PrismaPaymentRepository(prisma);
    this.publicAccessTokens = new PrismaPublicAccessTokenRepository(prisma);
    this.expenses = new PrismaExpenseRepository(prisma);
    this.agentJournal = new PrismaAgentJournalRepository(prisma);
    this.counters = new PrismaSequenceCounter(prisma);
  }

  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.prisma.runInTransaction(fn);
  }

  runWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.withTenant(companyId, () => fn());
  }

  async seed(): Promise<void> {
    const company = companyPropsToCreate(seedCompany().toProps());
    await this.prisma.company.upsert({ where: { id: company.id }, create: company, update: company });
    for (const customer of seedCustomers().map((c) => customerPropsToCreate(c.toProps()))) {
      await this.prisma.customer.upsert({ where: { id: customer.id }, create: customer, update: customer });
    }
  }
}
