import { AccountingEntry, ChartOfAccounts, Expense, Invoice, Quote } from '@bob/core';
import type {
  Company,
  Customer,
  Payment,
  Chantier,
  CompanyRepository,
  CustomerRepository,
  QuoteRepository,
  InvoiceRepository,
  PaymentRepository,
  PublicAccessGrant,
  PublicAccessTokenRepository,
  ExpenseRepository,
  AccountingEntryRepository,
  ChartOfAccountsRepository,
  ChantierRepository,
  CatalogueItemRecord,
  CatalogueRepository,
  CatalogueCreateWriteResult,
  CatalogueUpdateWriteResult,
  CatalogueDeleteWriteResult,
} from '@bob/core';

export class InMemoryCompanyRepository implements CompanyRepository {
  private readonly map = new Map<string, Company>();
  seed(c: Company): this {
    this.map.set(c.id, c);
    return this;
  }
  async findById(id: string): Promise<Company | null> {
    return this.map.get(id) ?? null;
  }
  async list(): Promise<Company[]> {
    return [...this.map.values()];
  }
  async save(c: Company): Promise<void> {
    this.map.set(c.id, c);
  }
}

export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly map = new Map<string, Customer>();
  seed(list: Customer[]): this {
    for (const c of list) this.map.set(c.id, c);
    return this;
  }
  async findById(id: string): Promise<Customer | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Customer[]> {
    return [...this.map.values()].filter((customer) => customer.companyId === companyId);
  }
  async save(c: Customer): Promise<void> {
    this.map.set(c.id, c);
  }
}

export class InMemoryQuoteRepository implements QuoteRepository {
  private map = new Map<string, Quote>();
  async findById(id: string): Promise<Quote | null> {
    return this.map.get(id) ?? null;
  }
  async lockById(id: string): Promise<Quote | null> {
    const stored = this.map.get(id);
    return stored ? Quote.rehydrate(stored.toSnapshot()) : null;
  }
  async listByCompany(companyId: string): Promise<Quote[]> {
    return [...this.map.values()].filter((q) => q.companyId === companyId);
  }
  async save(q: Quote): Promise<void> {
    this.map.set(q.id, q);
  }

  snapshot(): Map<string, Quote> {
    return new Map([...this.map].map(([id, quote]) => [id, Quote.rehydrate(quote.toSnapshot())]));
  }

  restore(snapshot: Map<string, Quote>): void {
    this.map = new Map([...snapshot].map(([id, quote]) => [id, Quote.rehydrate(quote.toSnapshot())]));
  }
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly map = new Map<string, Invoice>();
  async findById(id: string): Promise<Invoice | null> {
    return this.map.get(id) ?? null;
  }
  async lockById(id: string): Promise<Invoice | null> {
    const stored = this.map.get(id);
    return stored ? Invoice.rehydrate(stored.toSnapshot()) : null;
  }
  async findByParentQuoteId(companyId: string, parentQuoteId: string, kind: Invoice['kind']): Promise<Invoice | null> {
    return [...this.map.values()].find((i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind) ?? null;
  }
  async findCreditNoteBySourceInvoiceId(companyId: string, sourceInvoiceId: string): Promise<Invoice | null> {
    return [...this.map.values()].find(
      (invoice) => invoice.companyId === companyId && invoice.kind === 'credit_note' && invoice.creditNoteSource?.invoiceId === sourceInvoiceId,
    ) ?? null;
  }
  async listByCompany(companyId: string): Promise<Invoice[]> {
    return [...this.map.values()].filter((i) => i.companyId === companyId);
  }
  async save(i: Invoice): Promise<void> {
    const sourceId = i.creditNoteSource?.invoiceId;
    if (i.kind === 'credit_note' && sourceId) {
      const existing = await this.findCreditNoteBySourceInvoiceId(i.companyId, sourceId);
      if (existing && existing.id !== i.id) return;
    }
    this.map.set(i.id, i);
  }
  async deleteById(id: string): Promise<void> {
    this.map.delete(id);
  }
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly list: Payment[] = [];
  async save(p: Payment): Promise<void> {
    this.list.push(p);
  }
  async findById(companyId: string, id: string): Promise<Payment | null> {
    return this.list.find((p) => p.companyId === companyId && p.id === id) ?? null;
  }
  async listByInvoice(invoiceId: string): Promise<Payment[]> {
    return this.list.filter((p) => p.invoiceId === invoiceId);
  }
  async findByIdempotencyKey(companyId: string, key: string): Promise<Payment | null> {
    return this.list.find((p) => p.companyId === companyId && p.idempotencyKey === key) ?? null;
  }
  /** E3 : encaissements datés du tenant (CA encaissé annuel, seuils 293 B) —
   *  méthode du repo CONCRET, le port core reste inchangé (apps/api en WIP). */
  async listByCompany(companyId: string): Promise<Payment[]> {
    return this.list.filter((p) => p.companyId === companyId);
  }
}

export class InMemoryPublicAccessTokenRepository implements PublicAccessTokenRepository {
  private readonly rows = new Map<string, PublicAccessGrant & { token: string; lastUsedAt: string | null }>();
  private seq = 0;

  async create(input: {
    companyId: string;
    resourceType: 'quote';
    resourceId: string;
    scope: 'quote_signature';
    expiresAt: string;
  }): Promise<{ id: string; token: string }> {
    this.seq += 1;
    const id = `local-public-grant-${this.seq}`;
    const token = `local_pst_${this.seq}`;
    this.rows.set(id, { id, token, ...input, revokedAt: null, lastUsedAt: null });
    return { id, token };
  }

  async findActive(token: string, at: string): Promise<PublicAccessGrant | null> {
    const row = [...this.rows.values()].find((r) => r.token === token);
    if (!row || row.revokedAt !== null || row.expiresAt <= at) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      scope: row.scope,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async markUsed(id: string, at: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, lastUsedAt: at });
  }

  async revoke(id: string, at: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, revokedAt: at });
  }

  async revokeActiveFor(input: {
    companyId: string;
    resourceType: 'quote';
    resourceId: string;
    scope: 'quote_signature';
    at: string;
  }): Promise<void> {
    for (const [id, row] of this.rows) {
      if (
        row.companyId === input.companyId &&
        row.resourceType === input.resourceType &&
        row.resourceId === input.resourceId &&
        row.scope === input.scope &&
        row.revokedAt === null &&
        row.expiresAt > input.at
      ) {
        this.rows.set(id, { ...row, revokedAt: input.at });
      }
    }
  }

  async revokeAllForCompany(input: { companyId: string; at: string }): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.companyId === input.companyId && row.revokedAt === null) {
        this.rows.set(id, { ...row, revokedAt: input.at });
      }
    }
  }
}

export class InMemoryExpenseRepository implements ExpenseRepository {
  private map = new Map<string, Expense>();
  async save(e: Expense): Promise<void> {
    this.map.set(e.id, e);
  }
  async findById(id: string): Promise<Expense | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Expense[]> {
    return [...this.map.values()].filter((e) => e.companyId === companyId);
  }

  snapshot(): Map<string, Expense> {
    return new Map([...this.map].map(([id, expense]) => [id, Expense.rehydrate(expense.toProps())]));
  }

  restore(snapshot: Map<string, Expense>): void {
    this.map = new Map([...snapshot].map(([id, expense]) => [id, Expense.rehydrate(expense.toProps())]));
  }
}

export class InMemoryAccountingEntryRepository implements AccountingEntryRepository {
  private map = new Map<string, AccountingEntry>();

  async save(entry: AccountingEntry): Promise<void> {
    this.map.set(entry.id, AccountingEntry.rehydrate(entry.toProps()));
  }

  async findById(companyId: string, id: string): Promise<AccountingEntry | null> {
    const entry = this.map.get(id);
    return entry && entry.companyId === companyId ? AccountingEntry.rehydrate(entry.toProps()) : null;
  }

  async listByCompany(companyId: string): Promise<AccountingEntry[]> {
    return [...this.map.values()]
      .filter((entry) => entry.companyId === companyId)
      .map((entry) => AccountingEntry.rehydrate(entry.toProps()));
  }

  snapshot(): Map<string, AccountingEntry> {
    return new Map([...this.map].map(([id, entry]) => [id, AccountingEntry.rehydrate(entry.toProps())]));
  }

  restore(snapshot: Map<string, AccountingEntry>): void {
    this.map = new Map([...snapshot].map(([id, entry]) => [id, AccountingEntry.rehydrate(entry.toProps())]));
  }
}

export class InMemoryChartOfAccountsRepository implements ChartOfAccountsRepository {
  private readonly map = new Map<string, ChartOfAccounts>();

  async save(chart: ChartOfAccounts): Promise<void> {
    this.map.set(chart.companyId, ChartOfAccounts.rehydrate(chart.toProps()));
  }

  async findByCompany(companyId: string): Promise<ChartOfAccounts | null> {
    const chart = this.map.get(companyId);
    return chart ? ChartOfAccounts.rehydrate(chart.toProps()) : null;
  }
}

export class InMemoryCatalogueRepository implements CatalogueRepository {
  private readonly map = new Map<string, CatalogueItemRecord>();

  async listByCompany(companyId: string): Promise<readonly CatalogueItemRecord[]> {
    return [...this.map.values()]
      .filter((item) => item.companyId === companyId)
      .map((item) => ({ ...item }));
  }

  async create(item: CatalogueItemRecord): Promise<CatalogueCreateWriteResult> {
    if (this.map.has(item.id)) return { status: 'id_conflict' };
    this.map.set(item.id, { ...item });
    return { status: 'created', item: { ...item } };
  }

  async update(input: Parameters<CatalogueRepository['update']>[0]): Promise<CatalogueUpdateWriteResult> {
    const current = this.map.get(input.id);
    if (current === undefined || current.companyId !== input.companyId) return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    const updated: CatalogueItemRecord = { ...input.item, createdAt: current.createdAt };
    this.map.set(input.id, updated);
    return { status: 'updated', item: { ...updated } };
  }

  async delete(input: Parameters<CatalogueRepository['delete']>[0]): Promise<CatalogueDeleteWriteResult> {
    const current = this.map.get(input.id);
    if (current === undefined || current.companyId !== input.companyId) return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    this.map.delete(input.id);
    return { status: 'deleted' };
  }
}

export class InMemoryChantierRepository implements ChantierRepository {
  private readonly map = new Map<string, Chantier>();
  async save(c: Chantier): Promise<void> {
    this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Chantier | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Chantier[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }
}
