import {
  CreateQuote,
  SendQuote,
  SignQuote,
  RefuseQuote,
  GenerateInvoiceFromQuote,
  IssueInvoice,
  RegisterPayment,
  RecordIssuedInvoiceAccountingEntry,
  ListAccountingEntries,
  ListCustomers,
  GetCashflow,
  SystemClock,
  seedCompany,
  seedCustomers,
  CASH_SNAPSHOT,
  PLAN_CATALOG,
  ADDON_CATALOG,
  planEntitlements,
  resolveAutonomyEntitlement,
  runDiagnostic,
  resolveTradeConfig,
  buildDocumentStorageKey,
  buildInvoiceAccountingPreviewEntry,
  createFrenchOperationalChartOfAccounts,
  ExtractDocument,
  DemoOcrAdapter,
  RecordExpense,
  CreateChantier,
  AutofillCompanyFromSiret,
  ValidateVatNumber,
  SearchAddress,
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
  type VatCheckResult,
  type AddressSuggestion,
  type DocumentView,
  type DocumentDownloadUrl,
} from '@bob/core';
import {
  InMemoryCompanyRepository,
  InMemoryCustomerRepository,
  InMemoryQuoteRepository,
  InMemoryInvoiceRepository,
  InMemoryPaymentRepository,
  InMemoryPublicAccessTokenRepository,
  InMemoryExpenseRepository,
  InMemoryChantierRepository,
  InMemoryAccountingEntryRepository,
  InMemoryChartOfAccountsRepository,
} from './in-memory/repositories';
import { DemoCompanyLookupAdapter } from './in-memory/company-lookup';
import { DemoVatAdapter, DemoAddressAdapter } from './in-memory/enrichment';
import { InMemorySequenceCounter, CounterIdGenerator, FixtureCashflowSnapshot } from './in-memory/services';
import type {
  BobClient,
  QuoteView,
  InvoiceView,
  SubscriptionView,
  SendQuoteOutput,
  ListDocumentsClientInput,
  UploadDocumentClientInput,
  VoiceConfig,
  VoiceSynthesisResult,
  InvoiceAccountingPreview,
  AccountingEntryView,
} from './client';

export interface LocalBobClientOptions {
  clock?: ClockPort;
}

function base64ByteSize(contentBase64: string): number {
  const raw = contentBase64.includes(',') ? contentBase64.slice(contentBase64.indexOf(',') + 1) : contentBase64;
  const normalized = raw.replace(/\s/g, '');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function localSha256(seq: number): string {
  return seq.toString(16).padStart(64, '0').slice(-64);
}

function addYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/** Implémentation locale (hors-ligne, fixtures) de BobClient : exécute les use cases du domaine en mémoire. */
export class LocalBobClient implements BobClient {
  readonly companyId: string;

  private readonly companies = new InMemoryCompanyRepository();
  private readonly customers = new InMemoryCustomerRepository();
  private readonly quotes = new InMemoryQuoteRepository();
  private readonly invoices = new InMemoryInvoiceRepository();
  private readonly payments = new InMemoryPaymentRepository();
  private readonly publicAccessTokens = new InMemoryPublicAccessTokenRepository();
  private readonly ids = new CounterIdGenerator();
  private readonly ocr: DemoOcrAdapter;
  private readonly expenses = new InMemoryExpenseRepository();
  private readonly chantiers = new InMemoryChantierRepository();
  private readonly accountingEntries = new InMemoryAccountingEntryRepository();
  private readonly chartOfAccounts = new InMemoryChartOfAccountsRepository();
  private readonly documents: DocumentView[] = [];
  private documentSeq = 0;
  private readonly companyLookup = new DemoCompanyLookupAdapter();
  // Unité de travail in-memory : annule l'allocation du compteur si fn lève (pas de trou) — parité backend.
  private readonly uow = {
    runInTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      const snap = this.counters.snapshot();
      try {
        return await fn();
      } catch (e) {
        this.counters.restore(snap);
        throw e;
      }
    },
  };
  private readonly vat = new DemoVatAdapter();
  private readonly addresses = new DemoAddressAdapter();
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
    const chart = createFrenchOperationalChartOfAccounts(this.companyId);
    if (chart.ok) void this.chartOfAccounts.save(chart.value);
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
      parentQuoteId: i.parentQuoteId,
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
      ai: PLAN_CATALOG.business.ai,
      autonomyEntitlement: resolveAutonomyEntitlement('business'),
      limits: PLAN_CATALOG.business.limits,
      addOns: [],
      addOnCatalog: Object.values(ADDON_CATALOG).map((a) => ({
        addOn: a.addOn,
        kind: a.kind,
        label: a.label,
        priceCents: a.priceCents,
        tagline: a.tagline,
        minTier: a.minTier,
        grants: [...a.grants],
        ...(a.autonomy ? { autonomy: a.autonomy } : {}),
      })),
      catalog: Object.values(PLAN_CATALOG).map((p) => ({
        tier: p.tier,
        label: p.label,
        priceCents: p.priceCents,
        annualMonthlyCents: p.annualMonthlyCents,
        tagline: p.tagline,
        features: [...p.features],
        ai: p.ai,
        limits: p.limits,
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

  async checkVat(vatNumber: string): Promise<Result<VatCheckResult, AppError>> {
    return new ValidateVatNumber({ vat: this.vat, clock: this.clock }).execute({ vatNumber });
  }

  async searchAddress(query: string): Promise<Result<AddressSuggestion[], AppError>> {
    return new SearchAddress({ addresses: this.addresses }).execute({ query });
  }

  async transcribe(): Promise<Result<{ text: string }, AppError>> {
    // Démo hors-ligne : pas de STT cloud ; renvoie une transcription fixe.
    return ok({ text: 'encaisse la facture 2026-014' });
  }

  async synthesizeSpeech(_input: { text: string }): Promise<Result<VoiceSynthesisResult, AppError>> {
    return ok({ audioBase64: null, mimeType: null, model: 'native' });
  }

  async voiceConfig(): Promise<Result<VoiceConfig, AppError>> {
    return ok({ cloudAvailable: false, ttsCloudAvailable: false });
  }

  async listDocuments(input: ListDocumentsClientInput = {}): Promise<Result<DocumentView[], AppError>> {
    return ok(
      this.documents
        .filter((d) => input.includeDeleted === true || d.status === 'active')
        .filter((d) => (input.kind !== undefined ? d.kind === input.kind : true))
        .filter((d) => (input.linkedEntityType !== undefined ? d.linkedEntityType === input.linkedEntityType : true))
        .filter((d) => (input.linkedEntityId !== undefined ? d.linkedEntityId === input.linkedEntityId : true)),
    );
  }

  async uploadDocument(input: UploadDocumentClientInput): Promise<Result<DocumentView, AppError>> {
    const byteSize = base64ByteSize(input.contentBase64);
    if (byteSize <= 0) return err({ kind: 'validation', issues: [{ field: 'contentBase64', message: 'Document vide.' }] });
    this.documentSeq += 1;
    const id = `local-document-${this.documentSeq}`;
    const sha256 = localSha256(this.documentSeq);
    const storageKey = buildDocumentStorageKey({
      companyId: this.companyId,
      documentId: id,
      version: 1,
      sha256,
      filename: input.filename,
      mimeType: input.mimeType,
    });
    const today = this.clock.today();
    const documentDate = input.documentDate ?? null;
    const view: DocumentView = {
      id,
      companyId: this.companyId,
      kind: input.kind ?? 'other',
      origin: 'uploaded',
      status: 'active',
      filename: input.filename.trim() || 'document.bin',
      mimeType: input.mimeType,
      byteSize,
      sha256,
      storageKey,
      version: 1,
      linkedEntityType: input.linkedEntityType ?? null,
      linkedEntityId: input.linkedEntityId ?? null,
      documentDate,
      issuedAt: null,
      createdAt: this.clock.now(),
      createdBy: 'local',
      retentionUntil: addYears(documentDate ?? today, 10),
    };
    this.documents.unshift(view);
    return ok(view);
  }

  async documentDownloadUrl(documentId: string, ttlSeconds = 300): Promise<Result<DocumentDownloadUrl, AppError>> {
    const document = this.documents.find((d) => d.id === documentId && d.status === 'active');
    if (!document) return err(appNotFound('document', documentId));
    return ok({
      url: `memory://local-documents/${encodeURIComponent(document.storageKey)}?ttl=${ttlSeconds}`,
      expiresInSeconds: ttlSeconds,
      filename: document.filename,
      mimeType: document.mimeType,
      byteSize: document.byteSize,
      sha256: document.sha256,
    });
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
    return new CreateChantier({ chantiers: this.chantiers, customers: this.customers, ids: this.ids, clock: this.clock }).execute({ companyId: this.companyId, ...input });
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

  async sendQuote(quoteId: string): Promise<Result<SendQuoteOutput, AppError>> {
    return new SendQuote({ quotes: this.quotes, counters: this.counters, uow: this.uow, clock: this.clock }).execute({ quoteId });
  }

  async signQuote(input: { quoteId: string; signerName: string }): Promise<Result<{ status: string }, AppError>> {
    return new SignQuote({ quotes: this.quotes, uow: this.uow, clock: this.clock }).execute(input);
  }

  async refuseQuote(quoteId: string): Promise<Result<{ status: string }, AppError>> {
    return new RefuseQuote({
      quotes: this.quotes,
      publicAccessTokens: this.publicAccessTokens,
      uow: this.uow,
      clock: this.clock,
    }).execute({ quoteId });
  }

  async generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>> {
    return new GenerateInvoiceFromQuote({ quotes: this.quotes, invoices: this.invoices, ids: this.ids }).execute(input);
  }

  async issueInvoice(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>> {
    const issued = await new IssueInvoice({
      invoices: this.invoices,
      companies: this.companies,
      customers: this.customers,
      counters: this.counters,
      uow: this.uow,
      clock: this.clock,
    }).execute(input);
    if (!issued.ok) return issued;
    const accounting = await new RecordIssuedInvoiceAccountingEntry({
      invoices: this.invoices,
      entries: this.accountingEntries,
      charts: this.chartOfAccounts,
    }).execute({ invoiceId: input.invoiceId });
    if (!accounting.ok) return accounting;
    return issued;
  }

  async registerPayment(input: {
    invoiceId: string;
    amount: number;
    method: PaymentMethod;
    idempotencyKey?: string | null;
  }): Promise<Result<{ status: string }, AppError>> {
    return new RegisterPayment({
      invoices: this.invoices,
      payments: this.payments,
      uow: this.uow,
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

  async invoiceAccountingPreview(invoiceId: string): Promise<Result<InvoiceAccountingPreview, AppError>> {
    const invoice = await this.invoices.findById(invoiceId);
    if (!invoice) return err(appNotFound('invoice', invoiceId));
    const chart = createFrenchOperationalChartOfAccounts(invoice.companyId);
    const entry = buildInvoiceAccountingPreviewEntry({
      entryId: `preview-invoice-${invoice.id}`,
      invoice,
      entryDate: this.clock.today(),
      reference: invoice.number ?? 'a-emettre',
      ...(chart.ok ? { chart: chart.value } : {}),
    });
    if (!entry.ok) {
      return ok({
        invoiceId,
        available: false,
        reason: 'message' in entry.error && typeof entry.error.message === 'string' ? entry.error.message : 'Aperçu comptable indisponible.',
        entryId: null,
        reference: invoice.number,
        entryDate: invoice.issuedAt,
        label: null,
        totalDebitCents: 0,
        totalCreditCents: 0,
        lines: [],
      });
    }
    const props = entry.value.toProps();
    return ok({
      invoiceId,
      available: true,
      reason: null,
      entryId: props.id,
      reference: props.reference,
      entryDate: props.entryDate,
      label: props.label,
      totalDebitCents: entry.value.totalDebitCents,
      totalCreditCents: entry.value.totalCreditCents,
      lines: props.lines,
    });
  }

  async listInvoices(): Promise<Result<InvoiceView[], AppError>> {
    const list = await this.invoices.listByCompany(this.companyId);
    return ok(list.map((i) => this.mapInvoice(i)));
  }

  async listAccountingEntries(): Promise<Result<AccountingEntryView[], AppError>> {
    return new ListAccountingEntries({ entries: this.accountingEntries }).execute({ companyId: this.companyId });
  }
}
