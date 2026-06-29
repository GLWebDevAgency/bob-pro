import { Inject, Injectable } from '@nestjs/common';
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
  buildRelance,
  ok,
  appNotFound,
  MERCIER_PROPS,
  CASH_SNAPSHOT,
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
import { UuidGenerator, FixtureCashflowSnapshot } from './persistence/in-memory';
import { PERSISTENCE, type Persistence } from './persistence/persistence';
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
 * Autorité serveur : wire les use cases du domaine sur le bundle Persistence injecté
 * (in-memory en démo, Prisma/Postgres en prod). L'app bascule en HttpBobClient sans changer d'écran.
 */
@Injectable()
export class BackendService {
  private readonly ids = new UuidGenerator();
  private readonly clock: ClockPort = new SystemClock();
  private readonly snapshots = new FixtureCashflowSnapshot(CASH_SNAPSHOT);
  readonly companyId = MERCIER_PROPS.id;

  constructor(@Inject(PERSISTENCE) private readonly p: Persistence) {}

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
    return new ListCustomers({ customers: this.p.customers }).execute({ companyId: this.companyId });
  }
  getCashflow(scenario: Scenario, horizon: Horizon) {
    return new GetCashflow({ snapshots: this.snapshots }).execute({ companyId: this.companyId, scenario, horizon });
  }
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>) {
    return new CreateQuote({
      quotes: this.p.quotes,
      companies: this.p.companies,
      customers: this.p.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId, ...input });
  }
  sendQuote(quoteId: string) {
    return new SendQuote({ quotes: this.p.quotes, counters: this.p.counters, clock: this.clock }).execute({ quoteId });
  }
  signQuote(input: { quoteId: string; signerName: string }) {
    return new SignQuote({ quotes: this.p.quotes, clock: this.clock }).execute(input);
  }
  generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }) {
    return new GenerateInvoiceFromQuote({ quotes: this.p.quotes, invoices: this.p.invoices, ids: this.ids }).execute(input);
  }
  issueInvoice(input: { invoiceId: string }) {
    return new IssueInvoice({
      invoices: this.p.invoices,
      companies: this.p.companies,
      customers: this.p.customers,
      counters: this.p.counters,
      clock: this.clock,
    }).execute(input);
  }
  registerPayment(input: { invoiceId: string; amount: number; method: PaymentMethod }) {
    return new RegisterPayment({
      invoices: this.p.invoices,
      payments: this.p.payments,
      ids: this.ids,
      clock: this.clock,
    }).execute(input);
  }
  async getQuote(id: string): Promise<Result<QuoteView, AppError>> {
    const q = await this.p.quotes.findById(id);
    if (!q) return { ok: false, error: appNotFound('quote', id) };
    return ok(this.mapQuote(q));
  }
  async listQuotes(): Promise<Result<QuoteView[], AppError>> {
    const list = await this.p.quotes.listByCompany(this.companyId);
    return ok(list.map((q) => this.mapQuote(q)));
  }
  async getInvoice(id: string): Promise<Result<InvoiceView, AppError>> {
    const i = await this.p.invoices.findById(id);
    if (!i) return { ok: false, error: appNotFound('invoice', id) };
    return ok(this.mapInvoice(i));
  }
  async listInvoices(): Promise<Result<InvoiceView[], AppError>> {
    const list = await this.p.invoices.listByCompany(this.companyId);
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
        const draft = buildRelance({
          customerName: top?.name ?? 'le client',
          docNumber: 'dernière facture',
          amountCents: top?.outstanding ?? 0,
          daysLate: 7,
          tone: 'cordial',
          personality: 'Pote',
        });
        return ok({ subject: draft.subject, body: draft.body });
      },
    };
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: hasClaudeKey(), hasGlmKey: hasGlmKey() }),
      caps,
    });
    return agent.ask(message);
  }
}
