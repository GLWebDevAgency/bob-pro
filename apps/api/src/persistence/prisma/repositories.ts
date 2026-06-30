import {
  Company,
  Customer,
  Quote,
  Invoice,
  Payment,
  Expense,
  DocNumber,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type PaymentRepository,
  type ExpenseRepository,
  type ExpenseCategory,
  type ExpenseStatus,
  type ExpenseSource,
  type SequenceCounterPort,
  type CounterKey,
} from '@bob/core';
import type { PrismaService } from './prisma.service';
import {
  companyRowToProps,
  companyPropsToCreate,
  customerRowToProps,
  customerPropsToCreate,
  quoteRowToSnapshot,
  invoiceRowToSnapshot,
  quoteLineToCreate,
  invoiceKindToDocKind,
} from './mappers';

const LINES_INCLUDE = { lines: { orderBy: { position: 'asc' as const } } };

export class PrismaCompanyRepository implements CompanyRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Company | null> {
    const row = await this.prisma.company.findUnique({ where: { id } });
    if (!row) return null;
    const r = Company.of(companyRowToProps(row));
    return r.ok ? r.value : null;
  }
  async save(c: Company): Promise<void> {
    const data = companyPropsToCreate(c.toProps());
    await this.prisma.company.upsert({ where: { id: data.id }, create: data, update: data });
  }
}

export class PrismaCustomerRepository implements CustomerRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Customer | null> {
    const row = await this.prisma.customer.findUnique({ where: { id } });
    if (!row) return null;
    const r = Customer.of(customerRowToProps(row));
    return r.ok ? r.value : null;
  }
  async listByCompany(companyId: string): Promise<Customer[]> {
    const rows = await this.prisma.customer.findMany({ where: { companyId } });
    return rows.map((row) => Customer.of(customerRowToProps(row))).flatMap((r) => (r.ok ? [r.value] : []));
  }
  async save(c: Customer): Promise<void> {
    const data = customerPropsToCreate(c.toProps());
    await this.prisma.customer.upsert({ where: { id: data.id }, create: data, update: data });
  }
}

export class PrismaQuoteRepository implements QuoteRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Quote | null> {
    const row = await this.prisma.quote.findUnique({ where: { id }, include: LINES_INCLUDE });
    if (!row) return null;
    return Quote.rehydrate(quoteRowToSnapshot(row));
  }
  async listByCompany(companyId: string): Promise<Quote[]> {
    const rows = await this.prisma.quote.findMany({ where: { companyId }, include: LINES_INCLUDE });
    return rows.map((row) => Quote.rehydrate(quoteRowToSnapshot(row)));
  }
  async save(q: Quote): Promise<void> {
    const s = q.toSnapshot();
    const totals = q.totals();
    const base = {
      companyId: s.companyId,
      customerId: s.customerId,
      status: s.status,
      number: s.number,
      depositPct: s.depositPct,
      validUntil: s.validUntil ? new Date(s.validUntil) : null,
      signerName: s.signature?.signerName ?? null,
      signedAt: s.signature ? new Date(s.signature.signedAt) : null,
      totalsHt: totals.ht,
      totalsVat: totals.vat,
      totalsTtc: totals.ttc,
      totalsNetToPay: totals.netToPay,
      vatByRate: totals.vatByRate as Record<string, number>,
    };
    await this.prisma.$transaction([
      this.prisma.quote.upsert({ where: { id: s.id }, create: { id: s.id, ...base }, update: base }),
      this.prisma.lineItem.deleteMany({ where: { quoteId: s.id } }),
      this.prisma.lineItem.createMany({ data: s.lines.map((l, i) => quoteLineToCreate(l, { quoteId: s.id }, i)) }),
    ]);
  }
}

export class PrismaInvoiceRepository implements InvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Invoice | null> {
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: LINES_INCLUDE });
    if (!row) return null;
    return Invoice.rehydrate(invoiceRowToSnapshot(row));
  }
  async lockById(id: string): Promise<Invoice | null> {
    // Verrou de ligne DANS la transaction courante (sérialise émission/encaissement concurrents) + reload frais.
    const db = this.prisma.client();
    await db.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
    const row = await db.invoice.findUnique({ where: { id }, include: LINES_INCLUDE });
    if (!row) return null;
    return Invoice.rehydrate(invoiceRowToSnapshot(row));
  }
  async listByCompany(companyId: string): Promise<Invoice[]> {
    const rows = await this.prisma.invoice.findMany({ where: { companyId }, include: LINES_INCLUDE });
    return rows.map((row) => Invoice.rehydrate(invoiceRowToSnapshot(row)));
  }
  async save(i: Invoice): Promise<void> {
    const s = i.toSnapshot();
    const totals = i.totals();
    const base = {
      companyId: s.companyId,
      customerId: s.customerId,
      kind: invoiceKindToDocKind(s.kind),
      status: s.status,
      number: s.number,
      issuedAt: s.issuedAt ? new Date(s.issuedAt) : null,
      dueAt: s.dueAt ? new Date(s.dueAt) : null,
      parentQuoteId: s.parentQuoteId,
      depositPct: s.depositPct,
      paidCents: s.paid,
      totalsHt: totals.ht,
      totalsVat: totals.vat,
      totalsTtc: totals.ttc,
      totalsNetToPay: totals.netToPay,
      vatByRate: totals.vatByRate as Record<string, number>,
      legalMentions: s.mentions,
    };
    const lines = s.lines.map((l, idx) => quoteLineToCreate(l, { invoiceId: s.id }, idx));
    if (this.prisma.inTransaction()) {
      // Déjà dans la transaction d'émission/encaissement : on exécute en séquence sur le client tx.
      const tx = this.prisma.client();
      await tx.invoice.upsert({ where: { id: s.id }, create: { id: s.id, ...base }, update: base });
      await tx.lineItem.deleteMany({ where: { invoiceId: s.id } });
      await tx.lineItem.createMany({ data: lines });
    } else {
      await this.prisma.$transaction([
        this.prisma.invoice.upsert({ where: { id: s.id }, create: { id: s.id, ...base }, update: base }),
        this.prisma.lineItem.deleteMany({ where: { invoiceId: s.id } }),
        this.prisma.lineItem.createMany({ data: lines }),
      ]);
    }
  }
}

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}
  async save(p: Payment): Promise<void> {
    // client() => participe à la transaction d'encaissement (paiement + facture atomiques).
    await this.prisma.client().payment.create({
      data: {
        id: p.id,
        companyId: p.companyId,
        invoiceId: p.invoiceId,
        amount: p.amount,
        method: p.method,
        receivedAt: new Date(p.receivedAt),
        idempotencyKey: p.idempotencyKey,
      },
    });
  }
  async findByIdempotencyKey(companyId: string, key: string): Promise<Payment | null> {
    const row = await this.prisma.payment.findFirst({ where: { companyId, idempotencyKey: key } });
    if (!row) return null;
    const r = Payment.record({
      id: row.id,
      companyId: row.companyId,
      invoiceId: row.invoiceId,
      amount: row.amount,
      method: row.method,
      receivedAt: row.receivedAt.toISOString(),
      idempotencyKey: row.idempotencyKey,
    });
    return r.ok ? r.value : null;
  }
  async listByInvoice(invoiceId: string): Promise<Payment[]> {
    const rows = await this.prisma.payment.findMany({ where: { invoiceId } });
    return rows.flatMap((row) => {
      const r = Payment.record({
        id: row.id,
        companyId: row.companyId,
        invoiceId: row.invoiceId,
        amount: row.amount,
        method: row.method,
        receivedAt: row.receivedAt.toISOString(),
      });
      return r.ok ? [r.value] : [];
    });
  }
}

export class PrismaExpenseRepository implements ExpenseRepository {
  constructor(private readonly prisma: PrismaService) {}
  async save(e: Expense): Promise<void> {
    const data = e.toProps();
    await this.prisma.expense.upsert({ where: { id: data.id }, create: data, update: data });
  }
  async findById(id: string): Promise<Expense | null> {
    const row = await this.prisma.expense.findUnique({ where: { id } });
    if (!row) return null;
    return Expense.rehydrate(this.toProps(row));
  }
  async listByCompany(companyId: string): Promise<Expense[]> {
    // Réhydratation (données déjà validées) : ne jamais faire disparaître une dépense persistée
    // — sinon la trésorerie sous-compterait les charges (cf. revue EN 16931 / cashflow).
    const rows = await this.prisma.expense.findMany({ where: { companyId } });
    return rows.map((row) => Expense.rehydrate(this.toProps(row)));
  }
  private toProps(row: {
    id: string;
    companyId: string;
    supplierName: string;
    supplierSiren: string | null;
    documentDate: string;
    totalTtcCents: number;
    totalHtCents: number | null;
    vatCents: number | null;
    vatRatePct: number | null;
    category: string;
    status: string;
    source: string;
  }) {
    return {
      id: row.id,
      companyId: row.companyId,
      supplierName: row.supplierName,
      supplierSiren: row.supplierSiren,
      documentDate: row.documentDate,
      totalTtcCents: row.totalTtcCents,
      totalHtCents: row.totalHtCents,
      vatCents: row.vatCents,
      vatRatePct: row.vatRatePct,
      category: row.category as ExpenseCategory,
      status: row.status as ExpenseStatus,
      source: row.source as ExpenseSource,
    };
  }
}

export class PrismaSequenceCounter implements SequenceCounterPort {
  constructor(private readonly prisma: PrismaService) {}
  async allocate(input: { companyId: string; counterKey: CounterKey; fiscalYear: number }): Promise<{
    sequence: number;
    formatted: DocNumber;
  }> {
    // client() => participe à la transaction d'émission (allocation + save facture atomiques = no-gap réel).
    const rows = await this.prisma.client().$queryRaw<{ next_value: number | bigint }[]>`
      INSERT INTO document_counters ("companyId", "counterKey", "fiscalYear", "nextValue")
      VALUES (${input.companyId}, ${input.counterKey}, ${input.fiscalYear}, 1)
      ON CONFLICT ("companyId", "counterKey", "fiscalYear")
      DO UPDATE SET "nextValue" = document_counters."nextValue" + 1
      RETURNING "nextValue" AS next_value`;
    const seq = Number(rows[0]?.next_value ?? 1);
    const prefix = input.counterKey === 'quote' ? 'D' : 'F';
    return { sequence: seq, formatted: DocNumber.format(prefix, input.fiscalYear, seq) };
  }
}
