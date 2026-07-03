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
  PrismaDeviceRepository,
  PrismaPaymentRepository,
  PrismaPublicAccessTokenRepository,
  PrismaExpenseRepository,
  PrismaAccountingEntryRepository,
  PrismaChartOfAccountsRepository,
  PrismaAgentJournalRepository,
  PrismaSupplierMemoryRepository,
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
  readonly devices: PrismaDeviceRepository;
  readonly payments: PrismaPaymentRepository;
  readonly publicAccessTokens: PrismaPublicAccessTokenRepository;
  readonly expenses: PrismaExpenseRepository;
  readonly accountingEntries: PrismaAccountingEntryRepository;
  readonly chartOfAccounts: PrismaChartOfAccountsRepository;
  readonly agentJournal: PrismaAgentJournalRepository;
  readonly supplierMemory: PrismaSupplierMemoryRepository;
  readonly counters: PrismaSequenceCounter;

  constructor(private readonly prisma: PrismaService) {
    this.companies = new PrismaCompanyRepository(prisma);
    this.customers = new PrismaCustomerRepository(prisma);
    this.quotes = new PrismaQuoteRepository(prisma);
    this.invoices = new PrismaInvoiceRepository(prisma);
    this.documents = new PrismaDocumentRepository(prisma);
    this.documentArchiveJobs = new PrismaDocumentArchiveJobRepository(prisma);
    this.notificationJobs = new PrismaNotificationJobRepository(prisma);
    this.devices = new PrismaDeviceRepository(prisma);
    this.payments = new PrismaPaymentRepository(prisma);
    this.publicAccessTokens = new PrismaPublicAccessTokenRepository(prisma);
    this.expenses = new PrismaExpenseRepository(prisma);
    this.accountingEntries = new PrismaAccountingEntryRepository(prisma);
    this.chartOfAccounts = new PrismaChartOfAccountsRepository(prisma);
    this.agentJournal = new PrismaAgentJournalRepository(prisma);
    this.supplierMemory = new PrismaSupplierMemoryRepository(prisma);
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
    const customers = seedCustomers().map((c) => customerPropsToCreate(c.toProps()));
    // FORCE RLS s'applique aussi au bootstrap : sous le rôle applicatif non-superuser, les upserts
    // doivent passer par la transaction où le GUC tenant est posé, sinon WITH CHECK rejette (42501).
    await this.prisma.withTenant(company.id, async (tx) => {
      await tx.company.upsert({ where: { id: company.id }, create: company, update: company });
      for (const customer of customers) {
        await tx.customer.upsert({ where: { id: customer.id }, create: customer, update: customer });
      }
    });
  }
}
