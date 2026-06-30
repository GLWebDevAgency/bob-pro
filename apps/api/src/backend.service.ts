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
  planCan,
  runDiagnostic,
  resolveTradeConfig,
  facturXDataFromInvoice,
  buildFacturXBasicXml,
  ExtractDocument,
  RecordExpense,
  CreateChantier,
  AutofillCompanyFromSiret,
  ValidateVatNumber,
  SearchAddress,
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
  type TradeConfig,
  type ChantierProps,
  type CreateChantierInput,
  type CompanyLookupPort,
  type CompanyLookupResult,
  type VatValidationPort,
  type VatCheckResult,
  type AddressAutocompletePort,
  type AddressSuggestion,
  type OcrExtraction,
  type OcrPort,
  type RecordExpenseInput,
  type ExpenseProps,
} from '@bob/core';
import { BobAgent, ModelRouter, type BobActions, type AgentRun, type PendingAction, type AgentAutonomy } from '@bob/ai';
import { UuidGenerator, FixtureCashflowSnapshot, InMemoryChantierRepository } from './persistence/in-memory';
import { RechercheEntreprisesAdapter } from './adapters/recherche-entreprises.adapter';
import { ViesVatAdapter } from './adapters/vies-vat.adapter';
import { BanAddressAdapter } from './adapters/ban-address.adapter';
import { PERSISTENCE, type Persistence } from './persistence/persistence';
import { Metrics } from './observability/metrics';
import { AppLogger, getPrincipal } from './observability/logger';
import { PAYMENT_GATEWAY } from './payments/payment-gateway';
import { PDF_RENDERER } from './documents/pdf-renderer';
import { OCR_PORT } from './ocr/ocr';
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

/** Vue publique d'un devis pour la page de signature client à distance (lien tokenisé). */
export interface SignatureView {
  number: string | null;
  companyName: string;
  customerName: string;
  status: string;
  signed: boolean;
  expired: boolean;
  validUntil: string | null;
  lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
  totals: Totals;
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
  // Module Chantiers (BTP) en mémoire pour l'instant — persistance Prisma = incrément suivant.
  private readonly chantiers = new InMemoryChantierRepository();
  // Recherche d'entreprise par SIRET (API publique gratuite) — autofill onboarding/client.
  private readonly companyLookup: CompanyLookupPort = new RechercheEntreprisesAdapter();
  // Validation TVA (VIES) + autocomplétion d'adresse (BAN) — APIs publiques gratuites.
  private readonly vat: VatValidationPort = new ViesVatAdapter();
  private readonly addresses: AddressAutocompletePort = new BanAddressAdapter();
  private readonly subscription: Subscription;

  /** Tenant courant : companyId du Principal authentifié (défaut = société de seed en démo). */
  private companyId(): string {
    return getPrincipal()?.companyId ?? MERCIER_PROPS.id;
  }

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(OCR_PORT) private readonly ocr: OcrPort,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {
    const seed = Subscription.start({ id: 'sub-mercier', companyId: MERCIER_PROPS.id, tier: 'business', status: 'active' });
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
    return new GetCashflow({ snapshots: this.snapshots, expenses: this.p.expenses }).execute({
      companyId: this.companyId(),
      scenario,
      horizon,
    });
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

  // ——— Signature client à distance (public, par lien tokenisé) ———
  /** Vue publique d'un devis par son token (= identifiant du devis en V1). */
  async publicQuoteForSignature(token: string): Promise<Result<SignatureView, AppError>> {
    const q = await this.p.quotes.findById(token);
    if (!q) return { ok: false, error: appNotFound('quote', token) };
    const company = await this.p.companies.findById(q.companyId);
    const customer = await this.p.customers.findById(q.customerId);
    return ok({
      number: q.number,
      companyName: company?.name ?? '',
      customerName: customer?.name ?? '',
      status: q.status,
      signed: q.signature !== null,
      expired: q.validUntil !== null && q.validUntil < this.clock.today(),
      validUntil: q.validUntil,
      lines: q.lines.map((l) => ({ label: l.label, qty: l.qty, unitPriceHT: l.unitPriceHT, vatRate: l.vatRate })),
      totals: q.totals(),
    });
  }

  async publicSignQuote(token: string, signerName: string): Promise<Result<{ status: string }, AppError>> {
    const q = await this.p.quotes.findById(token);
    if (!q) return { ok: false, error: appNotFound('quote', token) };
    if (q.validUntil !== null && q.validUntil < this.clock.today())
      return { ok: false, error: appForbidden('Devis expiré : signature impossible.') };
    const r = await new SignQuote({ quotes: this.p.quotes, clock: this.clock }).execute({ quoteId: token, signerName });
    if (r.ok) this.logger.audit('quote.public_signed', { quoteId: token, signerName });
    return r;
  }

  /** Surface d'actions de Bob (parité) — délègue aux mêmes use cases que l'UI manuelle. */
  private buildBobActions(): BobActions {
    return {
      computePayout: async () => {
        const r = await this.getCashflow('realiste', 30);
        if (!r.ok) return r;
        return ok({ payoutCents: r.value.payout, availableCents: r.value.available });
      },
      draftRelance: async () => {
        const r = await this.listCustomers();
        if (!r.ok) return r;
        const top = [...r.value].filter((c) => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)[0];
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
      listPayableInvoices: async () => {
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
        const payable = inv.value
          .filter((i) => ['issued', 'partially_paid', 'late'].includes(i.status) && i.number)
          .map((i) => ({
            id: i.id,
            number: i.number ?? i.id,
            remainingCents: Math.max(0, i.totals.ttc - i.paid),
            customerName: names.get(i.customerId) ?? 'Client',
          }))
          .filter((i) => i.remainingCents > 0);
        return ok(payable);
      },
      registerPayment: async (input) =>
        this.registerPayment({ invoiceId: input.invoiceId, amount: input.amountCents, method: 'transfer' }),
    };
  }

  private bobAgent(): BobAgent {
    return new BobAgent({
      router: new ModelRouter({ hasClaudeKey: hasClaudeKey(), hasGlmKey: hasGlmKey() }),
      actions: this.buildBobActions(),
    });
  }

  async askBob(message: string, autonomy?: AgentAutonomy): Promise<Result<AgentRun, AppError>> {
    // L'assistant agentique est réservé aux offres avec IA (Pro+). Sans lui, l'app reste 100 % manuelle.
    if (!planCan(this.subscription.tier, 'ai_assistant'))
      return { ok: false, error: appForbidden("L'assistant Bob est inclus à partir de l'offre Pro.") };
    const start = Date.now();
    const r = await this.bobAgent().ask(message, { autonomy });
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

  async confirmBob(pending: PendingAction): Promise<Result<AgentRun, AppError>> {
    if (!planCan(this.subscription.tier, 'ai_assistant'))
      return { ok: false, error: appForbidden("L'assistant Bob est inclus à partir de l'offre Pro.") };
    const r = await this.bobAgent().confirm(pending);
    this.logger.audit('ai.confirm', { tool: pending.tool, outcome: r.ok ? 'ok' : 'error' });
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

  async getProfile(): Promise<Result<TradeConfig, AppError>> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return { ok: false, error: appNotFound('company', this.companyId()) };
    return ok(resolveTradeConfig(company.trade, this.subscription.tier, this.subscription.addOns));
  }

  async lookupCompany(siret: string): Promise<Result<CompanyLookupResult, AppError>> {
    return new AutofillCompanyFromSiret({ lookup: this.companyLookup }).execute({ siret });
  }

  async checkVat(vatNumber: string): Promise<Result<VatCheckResult, AppError>> {
    return new ValidateVatNumber({ vat: this.vat, clock: this.clock }).execute({ vatNumber });
  }

  async searchAddress(query: string): Promise<Result<AddressSuggestion[], AppError>> {
    return new SearchAddress({ addresses: this.addresses }).execute({ query });
  }

  // ——— Module Chantiers (vertical BTP, gated par métier × palier/add-on) ———
  private async chantiersAllowed(): Promise<boolean> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return false;
    return resolveTradeConfig(company.trade, this.subscription.tier, this.subscription.addOns).modules.some(
      (m) => m.key === 'chantiers' && m.active,
    );
  }

  async createChantier(input: Omit<CreateChantierInput, 'companyId'>): Promise<Result<{ id: string }, AppError>> {
    if (!(await this.chantiersAllowed()))
      return {
        ok: false,
        error: appForbidden('Module Chantiers réservé aux métiers du bâtiment (offre Solo minimum, ou Pack BTP).'),
      };
    const r = await new CreateChantier({
      chantiers: this.chantiers,
      customers: this.p.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId(), ...input });
    if (r.ok) this.logger.audit('chantier.created', { companyId: this.companyId(), id: r.value.id });
    return r;
  }

  async listChantiers(): Promise<Result<ChantierProps[], AppError>> {
    if (!(await this.chantiersAllowed()))
      return {
        ok: false,
        error: appForbidden('Module Chantiers réservé aux métiers du bâtiment (offre Solo minimum, ou Pack BTP).'),
      };
    const list = await this.chantiers.listByCompany(this.companyId());
    return ok(list.map((c) => c.toProps()));
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
    // Facture émise -> PDF hybride Factur-X (XML CII embarqué).
    let facturX: { xml: string } | undefined;
    if (inv.number && inv.issuedAt) {
      const buyer = customer.toProps();
      const fxData = facturXDataFromInvoice(inv, company, {
        name: customer.name,
        ...(buyer.siren ? { siren: buyer.siren } : {}),
        address: buyer.address,
      });
      facturX = { xml: buildFacturXBasicXml(fxData) };
    }
    const bytes = await this.pdf.renderInvoice(data, facturX);
    this.logger.audit('invoice.pdf', { invoiceId, number: data.number, facturX: !!facturX });
    return ok(bytes);
  }

  /** XML Factur-X (CII BASIC) seul, pour transmission e-invoicing. Facture émise requise. */
  async invoiceFacturXXml(invoiceId: string): Promise<Result<string, AppError>> {
    const inv = await this.p.invoices.findById(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    if (!inv.number || !inv.issuedAt)
      return { ok: false, error: appForbidden('Facture non émise : Factur-X indisponible.') };
    const company = await this.p.companies.findById(inv.companyId);
    const customer = await this.p.customers.findById(inv.customerId);
    if (!company || !customer) return { ok: false, error: appNotFound('company-or-customer', invoiceId) };
    const buyer = customer.toProps();
    const fxData = facturXDataFromInvoice(inv, company, {
      name: customer.name,
      ...(buyer.siren ? { siren: buyer.siren } : {}),
      address: buyer.address,
    });
    return ok(buildFacturXBasicXml(fxData));
  }

  /** OCR d'un document fournisseur (base64) -> extraction structurée, scopée au tenant. */
  async extractDocument(input: { contentBase64: string; mimeType: string }): Promise<Result<OcrExtraction, AppError>> {
    const r = await new ExtractDocument({ ocr: this.ocr }).execute(input);
    if (r.ok)
      this.logger.audit('document.ocr', {
        companyId: this.companyId(),
        mimeType: input.mimeType,
        confidence: r.value.confidence,
      });
    return r;
  }

  async recordExpense(input: Omit<RecordExpenseInput, 'companyId'>): Promise<Result<{ id: string }, AppError>> {
    const r = await new RecordExpense({ expenses: this.p.expenses, ids: this.ids, clock: this.clock }).execute({
      companyId: this.companyId(),
      ...input,
    });
    if (r.ok) this.logger.audit('expense.recorded', { companyId: this.companyId(), id: r.value.id, ttc: input.totalTtcCents });
    return r;
  }

  async listExpenses(): Promise<Result<ExpenseProps[], AppError>> {
    const list = await this.p.expenses.listByCompany(this.companyId());
    return ok(list.map((e) => e.toProps()));
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
