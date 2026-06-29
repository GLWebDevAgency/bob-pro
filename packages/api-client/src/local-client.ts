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
  PLAN_CATALOG,
  planEntitlements,
  runDiagnostic,
  resolveTradeConfig,
  ExtractDocument,
  DemoOcrAdapter,
  RecordExpense,
  CreateChantier,
  AutofillCompanyFromSiret,
  ok,
  err,
  appNotFound,
  type ClockPort,
  type CreateQuoteInput,
  type IssueInvoiceInput,
  type Quote,
  type Invoice,
  type Result,
  type AppError,
  type Scenario,
  type Horizon,
  type PaymentMethod,
  type CashflowProjection,
  type CustomerListItem,
  type CreateQuoteOutput,
  type DiagnosticResult,
  type OcrExtraction,
  type ExpenseProps,
  type RecordExpenseInput,
  type PlanTier,
  type TradeConfig,
  type ChantierProps,
  type CreateChantierInput,
  type CompanyLookupResult,
} from '@bob/core';
import {
  InMemoryCompanyRepository,
  InMemoryCustomerRepository,
  InMemoryQuoteRepository,
  InMemoryInvoiceRepository,
  InMemoryPaymentRepository,
  InMemoryExpenseRepository,
  InMemoryChantierRepository,
} from './in-memory/repositories';
import { DemoCompanyLookupAdapter } from './in-memory/company-lookup';
import { InMemorySequenceCounter, CounterIdGenerator, FixtureCashflowSnapshot } from './in-memory/services';
import type { BobClient, QuoteView, InvoiceView, SubscriptionView } from './client';

export interface LocalBobClientOptions {
  clock?: ClockPort;
}

/** Implémentation locale (hors-ligne, fixtures) de BobClient : exécute les use cases du domaine en mémoire. */
export class LocalBobClient implements BobClient {
  readonly companyId: string;

  private readonly companies = new InMemoryCompanyRepository();
  private readonly customers = new InMemoryCustomerRepository();
  private readonly quotes = new InMemoryQuoteRepository();
  private readonly invoices = new InMemoryInvoiceRepository();
  private readonly payments = new InMemoryPaymentRepository();
  private readonly ids = new CounterIdGenerator();
  private readonly ocr: DemoOcrAdapter;
  private readonly expenses = new InMemoryExpenseRepository();
  private readonly chantiers = new InMemoryChantierRepository();
  private readonly companyLookup = new DemoCompanyLookupAdapter();
  private readonly counters = new InMemorySequenceCounter();
  private readonly clock: ClockPort;
  private readonly snapshots: FixtureCashflowSnapshot;

  constructor(opts?: LocalBobClientOptions) {
    const company = seedCompany();
    this.companyId = company.id;
    this.companies.seed(company);
    this.customers.seed(seedCustomers());
    this.clock = opts?.clock ?? new SystemClock();
    this.ocr = new DemoOcrAdapter(this.clock);
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

  async getSubscription(): Promise<Result<SubscriptionView, AppError>> {
    return ok({
      tier: 'business',
      status: 'active',
      currentPeriodEnd: null,
      features: [...planEntitlements('business')],
      catalog: Object.values(PLAN_CATALOG).map((p) => ({
        tier: p.tier,
        label: p.label,
        priceCents: p.priceCents,
        annualMonthlyCents: p.annualMonthlyCents,
        tagline: p.tagline,
        features: [...p.features],
      })),
    });
  }

  async startCheckout(tier: PlanTier): Promise<Result<{ url: string }, AppError>> {
    // Démo hors-ligne : pas de passerelle de paiement, on renvoie une URL de démonstration.
    return ok({ url: `https://demo.bobpro.fr/abo/${tier}` });
  }

  async billingPortal(): Promise<Result<{ url: string }, AppError>> {
    return ok({ url: 'https://demo.bobpro.fr/portail' });
  }

  async invoicePaymentLink(invoiceId: string): Promise<Result<{ url: string }, AppError>> {
    return ok({ url: `https://demo.bobpro.fr/pay/${invoiceId}` });
  }

  async getProfile(): Promise<Result<TradeConfig, AppError>> {
    return ok(resolveTradeConfig(seedCompany().trade, 'business'));
  }

  async lookupCompany(siret: string): Promise<Result<CompanyLookupResult, AppError>> {
    return new AutofillCompanyFromSiret({ lookup: this.companyLookup }).execute({ siret });
  }

  async getDiagnostic(): Promise<Result<DiagnosticResult, AppError>> {
    const company = seedCompany();
    const types = [...new Set(seedCustomers().map((c) => c.type))];
    return ok(
      runDiagnostic({
        country: 'FR',
        trade: company.trade,
        vatRegime: company.vatRegime,
        customerTypes: types,
        hasDecennale: company.hasValidDecennale('2026-06-29'),
        asOf: '2026-06-29',
      }),
    );
  }

  async extractDocument(input: { contentBase64: string; mimeType: string }): Promise<Result<OcrExtraction, AppError>> {
    return new ExtractDocument({ ocr: this.ocr }).execute(input);
  }

  async listCustomers(): Promise<Result<CustomerListItem[], AppError>> {
    return new ListCustomers({ customers: this.customers }).execute({ companyId: this.companyId });
  }

  async getCashflow(input: { scenario: Scenario; horizon: Horizon }): Promise<Result<CashflowProjection, AppError>> {
    return new GetCashflow({ snapshots: this.snapshots, expenses: this.expenses }).execute({ companyId: this.companyId, ...input });
  }

  async recordExpense(input: Omit<RecordExpenseInput, 'companyId'>): Promise<Result<{ id: string }, AppError>> {
    return new RecordExpense({ expenses: this.expenses, ids: this.ids, clock: this.clock }).execute({ companyId: this.companyId, ...input });
  }

  async listExpenses(): Promise<Result<ExpenseProps[], AppError>> {
    const list = await this.expenses.listByCompany(this.companyId);
    return ok(list.map((e) => e.toProps()));
  }

  async createChantier(input: Omit<CreateChantierInput, 'companyId'>): Promise<Result<{ id: string }, AppError>> {
    return new CreateChantier({ chantiers: this.chantiers, ids: this.ids, clock: this.clock }).execute({ companyId: this.companyId, ...input });
  }

  async listChantiers(): Promise<Result<ChantierProps[], AppError>> {
    const list = await this.chantiers.listByCompany(this.companyId);
    return ok(list.map((c) => c.toProps()));
  }

  async createQuote(input: Omit<CreateQuoteInput, 'companyId'>): Promise<Result<CreateQuoteOutput, AppError>> {
    return new CreateQuote({
      quotes: this.quotes,
      companies: this.companies,
      customers: this.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId, ...input });
  }

  async sendQuote(quoteId: string): Promise<Result<{ number: string }, AppError>> {
    return new SendQuote({ quotes: this.quotes, counters: this.counters, clock: this.clock }).execute({ quoteId });
  }

  async signQuote(input: { quoteId: string; signerName: string }): Promise<Result<{ status: string }, AppError>> {
    return new SignQuote({ quotes: this.quotes, clock: this.clock }).execute(input);
  }

  async generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>> {
    return new GenerateInvoiceFromQuote({ quotes: this.quotes, invoices: this.invoices, ids: this.ids }).execute(input);
  }

  async issueInvoice(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>> {
    return new IssueInvoice({
      invoices: this.invoices,
      companies: this.companies,
      customers: this.customers,
      counters: this.counters,
      clock: this.clock,
    }).execute(input);
  }

  async registerPayment(input: { invoiceId: string; amount: number; method: PaymentMethod }): Promise<Result<{ status: string }, AppError>> {
    return new RegisterPayment({
      invoices: this.invoices,
      payments: this.payments,
      ids: this.ids,
      clock: this.clock,
    }).execute(input);
  }

  async getQuote(id: string): Promise<Result<QuoteView, AppError>> {
    const q = await this.quotes.findById(id);
    if (!q) return err(appNotFound('quote', id));
    return ok(this.mapQuote(q));
  }

  async listQuotes(): Promise<Result<QuoteView[], AppError>> {
    const list = await this.quotes.listByCompany(this.companyId);
    return ok(list.map((q) => this.mapQuote(q)));
  }

  async getInvoice(id: string): Promise<Result<InvoiceView, AppError>> {
    const i = await this.invoices.findById(id);
    if (!i) return err(appNotFound('invoice', id));
    return ok(this.mapInvoice(i));
  }

  async listInvoices(): Promise<Result<InvoiceView[], AppError>> {
    const list = await this.invoices.listByCompany(this.companyId);
    return ok(list.map((i) => this.mapInvoice(i)));
  }
}
