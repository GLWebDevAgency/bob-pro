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
  appForbidden,
  appDomain,
  Company,
  Customer,
  Subscription,
  PLAN_CATALOG,
  planEntitlements,
  runDiagnostic,
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
  type PlanTier,
  type PaymentGatewayPort,
  type PdfRendererPort,
  type InvoicePdfData,
  type CompanyProps,
  type CustomerProps,
  type DiagnosticResult,
} from '@bob/core';
import { BobAgent, ModelRouter, type BobCapabilities, type AgentRun } from '@bob/ai';
import { UuidGenerator, FixtureCashflowSnapshot } from './persistence/in-memory';
import { PERSISTENCE, type Persistence } from './persistence/persistence';
import { Metrics } from './observability/metrics';
import { AppLogger, getPrincipal } from './observability/logger';
import { PAYMENT_GATEWAY } from './payments/payment-gateway';
import { PDF_RENDERER } from './documents/pdf-renderer';
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
  private readonly subscription: Subscription;

  /** Tenant courant : companyId du Principal authentifié (défaut = société de seed en démo). */
  private companyId(): string {
    return getPrincipal()?.companyId ?? MERCIER_PROPS.id;
  }

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {
    const seed = Subscription.start({ id: 'sub-mercier', companyId: MERCIER_PROPS.id, tier: 'pro', status: 'active' });
    if (!seed.ok) throw new Error('abonnement de seed invalide');
    this.subscription = seed.value;
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
    return new ListCustomers({ customers: this.p.customers }).execute({ companyId: this.companyId() });
  }
  getCashflow(scenario: Scenario, horizon: Horizon) {
    return new GetCashflow({ snapshots: this.snapshots }).execute({ companyId: this.companyId(), scenario, horizon });
  }
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>) {
    return new CreateQuote({
      quotes: this.p.quotes,
      companies: this.p.companies,
      customers: this.p.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId(), ...input });
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
  async issueInvoice(input: { invoiceId: string }) {
    const r = await new IssueInvoice({
      invoices: this.p.invoices,
      companies: this.p.companies,
      customers: this.p.customers,
      counters: this.p.counters,
      clock: this.clock,
    }).execute(input);
    if (r.ok) this.logger.audit('invoice.issued', { invoiceId: input.invoiceId, number: r.value.number });
    return r;
  }
  async registerPayment(input: { invoiceId: string; amount: number; method: PaymentMethod }) {
    const r = await new RegisterPayment({
      invoices: this.p.invoices,
      payments: this.p.payments,
      ids: this.ids,
      clock: this.clock,
    }).execute(input);
    if (r.ok) this.logger.audit('payment.registered', { invoiceId: input.invoiceId, amount: input.amount, status: r.value.status });
    return r;
  }
  async getQuote(id: string): Promise<Result<QuoteView, AppError>> {
    const q = await this.p.quotes.findById(id);
    if (!q) return { ok: false, error: appNotFound('quote', id) };
    return ok(this.mapQuote(q));
  }
  async listQuotes(): Promise<Result<QuoteView[], AppError>> {
    const list = await this.p.quotes.listByCompany(this.companyId());
    return ok(list.map((q) => this.mapQuote(q)));
  }
  async getInvoice(id: string): Promise<Result<InvoiceView, AppError>> {
    const i = await this.p.invoices.findById(id);
    if (!i) return { ok: false, error: appNotFound('invoice', id) };
    return ok(this.mapInvoice(i));
  }
  async listInvoices(): Promise<Result<InvoiceView[], AppError>> {
    const list = await this.p.invoices.listByCompany(this.companyId());
    return ok(list.map((i) => this.mapInvoice(i)));
  }

  async askBob(message: string): Promise<Result<AgentRun, AppError>> {
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
    const start = Date.now();
    const r = await agent.ask(message);
    const ms = Date.now() - start;
    const intent = r.ok ? r.value.intent : 'error';
    const model = r.ok ? r.value.model : 'demo';
    const outcome = r.ok ? 'ok' : 'error';
    this.metrics.aiRequests.inc({ model, intent, outcome });
    this.metrics.aiDuration.observe({ model, intent }, ms / 1000);
    if (!r.ok && r.error.kind === 'dependency' && r.error.port === 'money-guard') this.metrics.aiGuardViolations.inc();
    this.logger.audit('ai.ask', { model, intent, outcome, ms });
    return r;
  }

  // ——— Monétisation ———
  getSubscription() {
    return {
      tier: this.subscription.tier,
      status: this.subscription.status,
      currentPeriodEnd: this.subscription.currentPeriodEnd,
      features: [...planEntitlements(this.subscription.tier)],
      catalog: Object.values(PLAN_CATALOG),
    };
  }

  async getDiagnostic(): Promise<Result<DiagnosticResult, AppError>> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return { ok: false, error: appNotFound('company', this.companyId()) };
    const customers = await this.p.customers.listByCompany(this.companyId());
    const customerTypes = [...new Set(customers.map((c) => c.type))];
    return ok(
      runDiagnostic({
        country: 'FR',
        trade: company.trade,
        vatRegime: company.vatRegime,
        customerTypes,
        hasDecennale: company.hasValidDecennale(this.clock.today()),
        asOf: this.clock.today(),
      }),
    );
  }

  startCheckout(tier: PlanTier) {
    return this.gateway.createSubscriptionCheckout({
      companyId: this.companyId(),
      tier,
      successUrl: 'https://demo.bobpro.fr/abo/ok',
      cancelUrl: 'https://demo.bobpro.fr/abo/cancel',
    });
  }

  billingPortal() {
    return this.gateway.createBillingPortal({ companyId: this.companyId(), returnUrl: 'https://demo.bobpro.fr/compte' });
  }

  /** Lien de paiement en ligne d'une facture — gated par l'offre (Pro+). */
  async invoicePaymentLink(invoiceId: string): Promise<Result<{ url: string }, AppError>> {
    if (!this.subscription.can('online_payment')) {
      return { ok: false, error: appForbidden("Le paiement en ligne nécessite l'offre Pro ou Business.") };
    }
    const inv = await this.p.invoices.findById(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    const link = await this.gateway.createInvoicePaymentLink({
      invoiceId,
      amountCents: inv.totals().netToPay,
      label: `Facture ${inv.number ?? ''}`,
    });
    this.logger.audit('invoice.payment_link', { invoiceId, amountCents: inv.totals().netToPay });
    return ok(link);
  }

  /** Génère le PDF conforme d'une facture (mentions figées + totaux déterministes). */
  async invoicePdf(invoiceId: string): Promise<Result<Uint8Array, AppError>> {
    const inv = await this.p.invoices.findById(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    const company = await this.p.companies.findById(inv.companyId);
    const customer = await this.p.customers.findById(inv.customerId);
    if (!company || !customer) return { ok: false, error: appNotFound('company-or-customer', invoiceId) };
    const addr = customer.toProps().address;
    const totals = inv.totals();
    const data: InvoicePdfData = {
      number: inv.number ?? '(brouillon)',
      companyName: company.name,
      companyAddress: `${company.address.line1}, ${company.address.zip} ${company.address.city}`,
      companyRcsOrRm: company.rcsOrRm ?? null,
      customerName: customer.name,
      customerAddress: `${addr.line1}, ${addr.zip} ${addr.city}`,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      kind: inv.kind,
      lines: inv.lines.map((l) => ({ label: l.label, qty: l.qty, unitPriceHT: l.unitPriceHT, vatRate: l.vatRate })),
      totals: { ht: totals.ht, vat: totals.vat, ttc: totals.ttc, netToPay: totals.netToPay },
      mentions: [...inv.mentions],
    };
    const bytes = await this.pdf.renderInvoice(data);
    this.logger.audit('invoice.pdf', { invoiceId, number: data.number });
    return ok(bytes);
  }

  // ——— Onboarding / multi-tenant ———
  /** Crée (ou met à jour) la société du tenant courant — première étape de l'onboarding. */
  async registerCompany(input: Omit<CompanyProps, 'id'>): Promise<Result<{ companyId: string }, AppError>> {
    const r = Company.of({ id: this.companyId(), ...input });
    if (!r.ok) return { ok: false, error: appDomain(r.error) };
    await this.p.companies.save(r.value);
    this.logger.audit('company.registered', { companyId: this.companyId(), name: input.name });
    return ok({ companyId: this.companyId() });
  }

  async createCustomer(input: Omit<CustomerProps, 'id' | 'companyId'>): Promise<Result<{ id: string }, AppError>> {
    const id = this.ids.newId();
    const r = Customer.of({ id, companyId: this.companyId(), ...input });
    if (!r.ok) return { ok: false, error: appDomain(r.error) };
    await this.p.customers.save(r.value);
    this.logger.audit('customer.created', { id, companyId: this.companyId() });
    return ok({ id });
  }
}
