import { Injectable } from '@nestjs/common';
import {
  CreateQuote,
  SendQuote,
  SignQuote,
  GenerateInvoiceFromQuote,
  IssueInvoice,
  RegisterPayment,
  ListCustomers,
  GetCashflow,
  SystemClock,
  seedCompany,
  seedCustomers,
  CASH_SNAPSHOT,
  buildRelance,
  ok,
  appNotFound,
  type Result,
  type AppError,
  type CreateQuoteInput,
  type Scenario,
  type Horizon,
  type PaymentMethod,
  type Quote,
  type Invoice,
  type ClockPort,
  type QuoteLine,
  type Totals,
} from '@bob/core';
import { BobAgent, ModelRouter, type BobCapabilities, type AgentRun } from '@bob/ai';
import {
  InMemoryCompanyRepository,
  InMemoryCustomerRepository,
  InMemoryQuoteRepository,
  InMemoryInvoiceRepository,
  InMemoryPaymentRepository,
  InMemorySequenceCounter,
  UuidGenerator,
  FixtureCashflowSnapshot,
} from './persistence/in-memory';
import { hasClaudeKey, hasGlmKey } from './config/env';

export interface QuoteView {
  id: string;
  companyId: string;
  customerId: string;
  status: string;
  number: string | null;
  depositPct: number | null;
  lines: QuoteLine[];
  totals: Totals;
  validUntil: string | null;
  signed: boolean;
}

export interface InvoiceView {
  id: string;
  companyId: string;
  customerId: string;
  kind: string;
  status: string;
  number: string | null;
  totals: Totals;
  mentions: string[];
  dueAt: string | null;
  paid: number;
}

/**
 * Autorité serveur : wire les use cases du domaine sur des adapters in-memory (V1, sans base).
 * Mêmes opérations que LocalBobClient — l'app bascule en HttpBobClient sans changer d'écran.
 */
@Injectable()
export class BackendService {
  private readonly companies = new InMemoryCompanyRepository();
  private readonly customers = new InMemoryCustomerRepository();
  private readonly quotes = new InMemoryQuoteRepository();
  private readonly invoices = new InMemoryInvoiceRepository();
  private readonly payments = new InMemoryPaymentRepository();
  private readonly counters = new InMemorySequenceCounter();
  private readonly ids = new UuidGenerator();
  private readonly clock: ClockPort = new SystemClock();
  private readonly snapshots: FixtureCashflowSnapshot;
  readonly companyId: string;

  constructor() {
    const company = seedCompany();
    this.companyId = company.id;
    this.companies.seed(company);
    this.customers.seed(seedCustomers());
    this.snapshots = new FixtureCashflowSnapshot(CASH_SNAPSHOT);
  }

  private mapQuote(q: Quote): QuoteView {
    return {
      id: q.id,
      companyId: q.companyId,
      customerId: q.customerId,
      status: q.status,
      number: q.number,
      depositPct: q.depositPct,
      lines: [...q.lines],
      totals: q.totals(),
      validUntil: q.validUntil,
      signed: q.signature !== null,
    };
  }

  private mapInvoice(i: Invoice): InvoiceView {
    return {
      id: i.id,
      companyId: i.companyId,
      customerId: i.customerId,
      kind: i.kind,
      status: i.status,
      number: i.number,
      totals: i.totals(),
      mentions: [...i.mentions],
      dueAt: i.dueAt,
      paid: i.paid,
    };
  }

  listCustomers() {
    return new ListCustomers({ customers: this.customers }).execute({ companyId: this.companyId });
  }
  getCashflow(scenario: Scenario, horizon: Horizon) {
    return new GetCashflow({ snapshots: this.snapshots }).execute({ companyId: this.companyId, scenario, horizon });
  }
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>) {
    return new CreateQuote({
      quotes: this.quotes,
      companies: this.companies,
      customers: this.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId, ...input });
  }
  sendQuote(quoteId: string) {
    return new SendQuote({ quotes: this.quotes, counters: this.counters, clock: this.clock }).execute({ quoteId });
  }
  signQuote(input: { quoteId: string; signerName: string }) {
    return new SignQuote({ quotes: this.quotes, clock: this.clock }).execute(input);
  }
  generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }) {
    return new GenerateInvoiceFromQuote({ quotes: this.quotes, invoices: this.invoices, ids: this.ids }).execute(input);
  }
  issueInvoice(input: { invoiceId: string }) {
    return new IssueInvoice({
      invoices: this.invoices,
      companies: this.companies,
      customers: this.customers,
      counters: this.counters,
      clock: this.clock,
    }).execute(input);
  }
  registerPayment(input: { invoiceId: string; amount: number; method: PaymentMethod }) {
    return new RegisterPayment({
      invoices: this.invoices,
      payments: this.payments,
      ids: this.ids,
      clock: this.clock,
    }).execute(input);
  }
  async getQuote(id: string): Promise<Result<QuoteView, AppError>> {
    const q = await this.quotes.findById(id);
    if (!q) return { ok: false, error: appNotFound('quote', id) };
    return ok(this.mapQuote(q));
  }
  async listQuotes(): Promise<Result<QuoteView[], AppError>> {
    const list = await this.quotes.listByCompany(this.companyId);
    return ok(list.map((q) => this.mapQuote(q)));
  }
  async getInvoice(id: string): Promise<Result<InvoiceView, AppError>> {
    const i = await this.invoices.findById(id);
    if (!i) return { ok: false, error: appNotFound('invoice', id) };
    return ok(this.mapInvoice(i));
  }
  async listInvoices(): Promise<Result<InvoiceView[], AppError>> {
    const list = await this.invoices.listByCompany(this.companyId);
    return ok(list.map((i) => this.mapInvoice(i)));
  }

  askBob(message: string): Promise<Result<AgentRun, AppError>> {
    const caps: BobCapabilities = {
      computePayout: async () => {
        const r = await this.getCashflow('realiste', 30);
        if (!r.ok) return r;
        return ok({ payoutCents: r.value.payout, availableCents: r.value.available });
      },
      draftRelance: async () => {
        const r = await this.listCustomers();
        if (!r.ok) return r;
        const sorted = [...r.value].filter((c) => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding);
        const top = sorted[0];
        const message2 = buildRelance({
          customerName: top?.name ?? 'le client',
          docNumber: 'dernière facture',
          amountCents: top?.outstanding ?? 0,
          daysLate: 7,
          tone: 'cordial',
          personality: 'Pote',
        });
        return ok({ subject: message2.subject, body: message2.body });
      },
    };
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: hasClaudeKey(), hasGlmKey: hasGlmKey() }),
      caps,
    });
    return agent.ask(message);
  }
}
