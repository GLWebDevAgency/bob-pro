import { randomUUID } from 'node:crypto';
import {
  DocNumber,
  type Company,
  type Customer,
  type Quote,
  type Invoice,
  type Payment,
  type Expense,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type PaymentRepository,
  type ExpenseRepository,
  type SequenceCounterPort,
  type CounterKey,
  type IdGeneratorPort,
  type CashflowSnapshotPort,
} from '@bob/core';

/**
 * Adapters in-memory (stockent les objets de domaine directement — aucune réhydratation requise).
 * Permettent de faire tourner l'API SANS base de données. Les adapters Prisma/Postgres sont le
 * prochain incrément (cf. prisma/schema.prisma + réhydratation des agrégats).
 */
export class InMemoryCompanyRepository implements CompanyRepository {
  private readonly map = new Map<string, Company>();
  seed(c: Company): void {
    this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Company | null> {
    return this.map.get(id) ?? null;
  }
  async save(c: Company): Promise<void> {
    this.map.set(c.id, c);
  }
}

export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly map = new Map<string, Customer>();
  seed(list: Customer[]): void {
    for (const c of list) this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Customer | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Customer[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }
  async save(c: Customer): Promise<void> {
    this.map.set(c.id, c);
  }
}

export class InMemoryQuoteRepository implements QuoteRepository {
  private readonly map = new Map<string, Quote>();
  async findById(id: string): Promise<Quote | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Quote[]> {
    return [...this.map.values()].filter((q) => q.companyId === companyId);
  }
  async save(q: Quote): Promise<void> {
    this.map.set(q.id, q);
  }
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly map = new Map<string, Invoice>();
  async findById(id: string): Promise<Invoice | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Invoice[]> {
    return [...this.map.values()].filter((i) => i.companyId === companyId);
  }
  async save(i: Invoice): Promise<void> {
    this.map.set(i.id, i);
  }
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly list: Payment[] = [];
  async save(p: Payment): Promise<void> {
    this.list.push(p);
  }
  async listByInvoice(invoiceId: string): Promise<Payment[]> {
    return this.list.filter((p) => p.invoiceId === invoiceId);
  }
}

export class InMemoryExpenseRepository implements ExpenseRepository {
  private readonly map = new Map<string, Expense>();
  async save(e: Expense): Promise<void> {
    this.map.set(e.id, e);
  }
  async findById(id: string): Promise<Expense | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Expense[]> {
    return [...this.map.values()].filter((e) => e.companyId === companyId);
  }
}

export class InMemorySequenceCounter implements SequenceCounterPort {
  private readonly counters = new Map<string, number>();
  async allocate(input: { companyId: string; counterKey: CounterKey; fiscalYear: number }): Promise<{
    sequence: number;
    formatted: DocNumber;
  }> {
    const key = `${input.companyId}:${input.counterKey}:${input.fiscalYear}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    const prefix = input.counterKey === 'quote' ? 'D' : 'F';
    return { sequence: next, formatted: DocNumber.format(prefix, input.fiscalYear, next) };
  }
}

export class UuidGenerator implements IdGeneratorPort {
  newId(): string {
    // Cryptographiquement aléatoire (122 bits) : ids non énumérables — important car l'id de devis
    // sert de jeton dans le lien de signature publique.
    return randomUUID();
  }
}

export class FixtureCashflowSnapshot implements CashflowSnapshotPort {
  constructor(private readonly snapshot: { bankBalance: number; receivables: number; charges: number; vatDue: number }) {}
  async get(_companyId: string): Promise<{ bankBalance: number; receivables: number; charges: number; vatDue: number }> {
    return this.snapshot;
  }
}
