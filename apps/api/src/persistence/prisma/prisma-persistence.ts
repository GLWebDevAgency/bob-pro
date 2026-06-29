import { seedCompany, seedCustomers, MERCIER_PROPS } from '@bob/core';
import type { Persistence } from '../persistence';
import { PrismaService } from './prisma.service';
import {
  PrismaCompanyRepository,
  PrismaCustomerRepository,
  PrismaQuoteRepository,
  PrismaInvoiceRepository,
  PrismaPaymentRepository,
  PrismaSequenceCounter,
} from './repositories';
import { companyPropsToCreate, customerPropsToCreate } from './mappers';

export class PrismaPersistence implements Persistence {
  readonly companies: PrismaCompanyRepository;
  readonly customers: PrismaCustomerRepository;
  readonly quotes: PrismaQuoteRepository;
  readonly invoices: PrismaInvoiceRepository;
  readonly payments: PrismaPaymentRepository;
  readonly counters: PrismaSequenceCounter;

  constructor(private readonly prisma: PrismaService) {
    this.companies = new PrismaCompanyRepository(prisma);
    this.customers = new PrismaCustomerRepository(prisma);
    this.quotes = new PrismaQuoteRepository(prisma);
    this.invoices = new PrismaInvoiceRepository(prisma);
    this.payments = new PrismaPaymentRepository(prisma);
    this.counters = new PrismaSequenceCounter(prisma);
  }

  async seed(): Promise<void> {
    const company = companyPropsToCreate(seedCompany().toProps());
    await this.prisma.company.upsert({ where: { id: company.id }, create: company, update: company });
    for (const customer of seedCustomers().map((c) => customerPropsToCreate(c.toProps(), MERCIER_PROPS.id))) {
      await this.prisma.customer.upsert({ where: { id: customer.id }, create: customer, update: customer });
    }
  }
}
