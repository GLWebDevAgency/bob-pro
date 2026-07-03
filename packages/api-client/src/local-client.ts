import {
  BobAgent,
  ModelRouter,
  InMemoryJournalStore,
  pendingToInvocations,
  type BobActions,
  type AgentRun,
  type AgentAutonomy,
  type PendingAction,
  type JournalEntry,
  type PayableInvoice,
  type SendableQuote,
  type IssuableInvoice,
  type AgentDocument,
} from '@bob/ai';
import {
  CreateQuote,
  SendQuote,
  SignQuote,
  RefuseQuote,
  GenerateInvoiceFromQuote,
  IssueInvoice,
  RegisterPayment,
  RecordIssuedInvoiceAccountingEntry,
  RecordPaymentAccountingEntry,
  ListAccountingEntries,
  ExportFec,
  PreviewPaymentAccountingEntry,
  ListCustomers,
  GetCashflow,
  SystemClock,
  seedCompany,
  seedCustomers,
  seedExpenses,
  seedVaultDocuments,
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
  Customer,
  deriveRelancePlan,
  ok,
  err,
  appNotFound,
  appForbidden,
  appDomain,
  type ClockPort,
  type IdGeneratorPort,
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
  SendRelanceClientOutput,
  ListDocumentsClientInput,
  UploadDocumentClientInput,
  VoiceConfig,
  VoiceSynthesisResult,
  SuggestExpenseDefaultsInput,
  ExpenseDefaultsView,
  InvoiceAccountingPreview,
  PaymentAccountingPreview,
  AccountingEntryView,
  ClassifyDocumentClientInput,
  AskBobClientInput,
  CreateCustomerClientInput,
} from './client';

export interface LocalBobClientOptions {
  clock?: ClockPort;
  /** Générateur d'ids injectable (tests déterministes — ex. journal d'agent rejouable). */
  ids?: IdGeneratorPort;
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

function normalizeSupplierNameLocal(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function addYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

// —— Assistant local (C40 ⑧, parité serveur) ——————————————————————————————————
const PAYABLE_STATUSES = new Set(['issued', 'partially_paid', 'late']);
const SENDABLE_QUOTE_STATUSES = new Set(['draft', 'sent', 'viewed']);

/** Clamp d'autonomie identique au serveur (apps/api ai/autonomy-entitlements) : jamais au-delà de l'offre. */
const AUTONOMY_RANK: Record<AgentAutonomy, number> = { confirm_all: 0, confirm_outbound: 1, auto: 2 };
function clampAutonomy(requested: AgentAutonomy | undefined, entitlement: AgentAutonomy): AgentAutonomy {
  const desired = requested ?? entitlement;
  return AUTONOMY_RANK[desired] <= AUTONOMY_RANK[entitlement] ? desired : entitlement;
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
  private readonly ids: IdGeneratorPort;
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
  // Assistant local (C40 ⑧) : journal append-only en mémoire + agent @bob/ai instancié à la demande.
  private readonly journal = new InMemoryJournalStore();
  private agent: BobAgent | null = null;

  constructor(opts?: LocalBobClientOptions) {
    const company = seedCompany();
    this.companyId = company.id;
    this.companies.seed(company);
    this.customers.seed(seedCustomers());
    this.clock = opts?.clock ?? new SystemClock();
    this.ids = opts?.ids ?? new CounterIdGenerator();
    this.ocr = new DemoOcrAdapter(this.clock);
    this.snapshots = new FixtureCashflowSnapshot(CASH_SNAPSHOT);
    const chart = createFrenchOperationalChartOfAccounts(this.companyId);
    if (chart.ok) void this.chartOfAccounts.save(chart.value);
    // Coffre de démo (A1-C14) : dépenses fournisseurs + reçu Leroy Merlin « à valider »
    // → exerce le flux réel scan → proposition → « Classer là » → dossier Achats.
    for (const expense of seedExpenses(this.companyId, this.clock.today())) void this.expenses.save(expense);
    this.documents.push(...seedVaultDocuments(this.companyId, this.clock.now(), this.clock.today()));
    // Facturation de démo (C16) : mêmes FLOWS que l'utilisateur — devis signé avec acompte
    // (test d'or 488,40), facture d'acompte émise puis ENCAISSÉE → le briefing du jour
    // propose la facture finale (proto), la pièce montre suivi payé + frise + mentions figées.
    this.ready = this.seedBillingDemo().catch(() => undefined);
  }

  /** Barrière du seed asynchrone : les lectures billing attendent la démo posée. */
  private ready: Promise<void> = Promise.resolve();

  private async seedBillingDemo(): Promise<void> {
    const created = await this.createQuote({
      customerId: 'cust-martin',
      depositPct: 30,
      lines: [
        { label: 'Pose pompe à chaleur — main-d’œuvre', category: 'labor', qty: 1, unitPriceHT: 98000, vatRate: 20 },
        { label: 'Fournitures hydrauliques', category: 'supply', qty: 1, unitPriceHT: 37667, vatRate: 20 },
      ],
    });
    if (!created.ok) return;
    const quoteId = created.value.quoteId;
    await this.sendQuote(quoteId);
    await this.signQuote({ quoteId, signerName: 'SARL Martin Rénovation' });
    const generated = await this.generateInvoice({ quoteId, mode: 'deposit' });
    if (!generated.ok) return;
    await this.issueInvoice({ invoiceId: generated.value.invoiceId });
    // L'acompte est encaissé — plafonné netToPay (488,40 €), comme la doctrine l'exige.
    await this.registerPayment({ invoiceId: generated.value.invoiceId, amount: 48840, method: 'card' });
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
      lines: i.lines.map((l) => ({ ...l })),
      depositDeductionCents: i.depositDeductionCents,
      depositInvoiceId: i.depositInvoiceId,
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
      tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2 && t.length <= 32))].slice(0, 16),
    };
    this.documents.unshift(view);
    return ok(view);
  }

  async classifyDocument(input: ClassifyDocumentClientInput): Promise<Result<DocumentView, AppError>> {
    const document = this.documents.find((d) => d.id === input.documentId && d.status === 'active');
    if (!document) return err(appNotFound('document', input.documentId));
    if (!input.linkedEntityId.trim())
      return err({ kind: 'validation', issues: [{ field: 'linkedEntityId', message: 'Rattachement métier incomplet.' }] });
    document.linkedEntityType = input.linkedEntityType;
    document.linkedEntityId = input.linkedEntityId;
    return ok({ ...document });
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

  async suggestExpenseDefaults(input: SuggestExpenseDefaultsInput): Promise<Result<ExpenseDefaultsView, AppError>> {
    const key = normalizeSupplierNameLocal(input.supplierName);
    const expenses = await this.expenses.listByCompany(this.companyId);
    const known = expenses
      .map((expense) => expense.toProps())
      .filter((expense) => normalizeSupplierNameLocal(expense.supplierName) === key)
      .at(-1);
    if (known) {
      return ok({
        supplierName: known.supplierName,
        supplierSiren: input.supplierSiren ?? known.supplierSiren,
        category: known.category,
        vatRatePct: input.vatRatePctApplied ?? known.vatRatePct,
        source: 'memory',
      });
    }
    return ok({
      supplierName: input.supplierName,
      supplierSiren: input.supplierSiren ?? null,
      category: input.categoryGuess,
      vatRatePct: input.vatRatePctApplied ?? null,
      source: 'ocr',
    });
  }

  async listCustomers(): Promise<Result<CustomerListItem[], AppError>> {
    return new ListCustomers({ customers: this.customers }).execute({ companyId: this.companyId });
  }

  /** Crée une fiche client — même chemin que POST /customers côté serveur (Customer.of + save). */
  async createCustomer(input: CreateCustomerClientInput): Promise<Result<{ id: string }, AppError>> {
    const id = this.ids.newId();
    const r = Customer.of({ id, companyId: this.companyId, ...input });
    if (!r.ok) return err(appDomain(r.error));
    await this.customers.save(r.value);
    return ok({ id });
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

  /** C25 ② : l'envoi réel est une capacité SERVEUR (notifier + notification_jobs) — le mode démo
   * ne simule jamais un envoi sortant. Échec propre, même contrat que l'adaptateur HTTP. */
  async sendRelance(_invoiceId: string): Promise<Result<SendRelanceClientOutput, AppError>> {
    return err({
      kind: 'dependency',
      port: 'api/relance',
      cause: 'Envoi de relance non disponible côté serveur — endpoint POST /invoices/:id/relance à venir (contrat C25).',
    });
  }

  async registerPayment(input: {
    invoiceId: string;
    amount: number;
    method: PaymentMethod;
    idempotencyKey?: string | null;
  }) {
    let accountingAlreadyChecked = false;
    const postPaymentAccounting = async (paymentId: string) => {
      const accounting = await new RecordPaymentAccountingEntry({
        invoices: this.invoices,
        payments: this.payments,
        entries: this.accountingEntries,
        charts: this.chartOfAccounts,
      }).execute({ companyId: this.companyId, paymentId });
      if (accounting.ok) accountingAlreadyChecked = true;
      return accounting;
    };
    const paid = await new RegisterPayment({
      invoices: this.invoices,
      payments: this.payments,
      uow: this.uow,
      ids: this.ids,
      clock: this.clock,
      afterPaymentRecorded: ({ paymentId }) => postPaymentAccounting(paymentId),
    }).execute(input);
    if (!paid.ok) return paid;
    if (!accountingAlreadyChecked) {
      const accounting = await postPaymentAccounting(paid.value.paymentId);
      if (!accounting.ok) return accounting;
    }
    return paid;
  }

  async getQuote(id: string): Promise<Result<QuoteView, AppError>> {
    await this.ready;
    const q = await this.quotes.findById(id);
    if (!q) return err(appNotFound('quote', id));
    return ok(this.mapQuote(q));
  }

  async listQuotes(): Promise<Result<QuoteView[], AppError>> {
    await this.ready;
    const list = await this.quotes.listByCompany(this.companyId);
    return ok(list.map((q) => this.mapQuote(q)));
  }

  async getInvoice(id: string): Promise<Result<InvoiceView, AppError>> {
    await this.ready;
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

  async paymentAccountingPreview(input: {
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
  }): Promise<Result<PaymentAccountingPreview, AppError>> {
    return new PreviewPaymentAccountingEntry({ invoices: this.invoices }).execute({
      companyId: this.companyId,
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
      method: input.method,
    });
  }

  async listInvoices(): Promise<Result<InvoiceView[], AppError>> {
    await this.ready;
    const list = await this.invoices.listByCompany(this.companyId);
    return ok(list.map((i) => this.mapInvoice(i)));
  }

  async listAccountingEntries(): Promise<Result<AccountingEntryView[], AppError>> {
    return new ListAccountingEntries({ entries: this.accountingEntries }).execute({ companyId: this.companyId });
  }

  async exportFec(input: { from: string; to: string }) {
    return new ExportFec({
      companies: this.companies,
      entries: this.accountingEntries,
      charts: this.chartOfAccounts,
    }).execute({ companyId: this.companyId, ...input });
  }

  // ── Assistant Bob local (C40 ⑧) — équivalent on-device du chemin serveur /ai ──────────────────
  // MÊME surface d'actions que le serveur (parité : chaque outil délègue à un use case ci-dessus),
  // MÊMES capacités optionnelles que le mobile (creer_devis, scan_depense, generer_facture,
  // export_fec, creer_client) — le mode démo exerce tout le registre.

  /** Autonomie maximale de l'offre locale (démo = business, aligné sur getSubscription). */
  private autonomyEntitlement(): AgentAutonomy {
    return resolveAutonomyEntitlement('business') as AgentAutonomy;
  }

  private bobActions(): BobActions {
    return {
      computePayout: async () => {
        const r = await this.getCashflow({ scenario: 'realiste', horizon: 30 });
        if (!r.ok) return r;
        return ok({ payoutCents: r.value.payout, availableCents: r.value.available });
      },
      // C25 ① : brouillon CIBLABLE, dérivé du plan de relances réel (@bob/core — ton par
      // ancienneté, reste dû netToPay − paid). Fini le « plus gros encours, J+7 inventé ».
      draftRelance: async (input) => {
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        if (!cust.ok) return cust;
        const plan = deriveRelancePlan({ invoices: inv.value, customers: cust.value, today: this.clock.today() });
        const entry = input?.invoiceId
          ? plan.find((e) => e.invoiceId === input.invoiceId)
          : input?.customerId
            ? plan.find((e) => e.customerId === input.customerId)
            : plan[0]; // tri du plan : retard le plus long puis montant
        if (!entry) {
          return ok(
            input?.invoiceId || input?.customerId
              ? { subject: 'Rien à relancer pour cette cible', body: 'Aucun retard sur cette cible — facture réglée ou pas encore échue. Je ne relance pas pour rien.' }
              : { subject: 'Rien à relancer', body: 'Aucune facture en retard — tout est réglé ou dans les temps. 🎉' },
          );
        }
        return ok({ subject: entry.message.subject, body: entry.message.body });
      },
      listPayableInvoices: async () => {
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
        const payable: PayableInvoice[] = inv.value
          .filter((i) => PAYABLE_STATUSES.has(i.status) && i.number)
          .map((i) => ({
            id: i.id,
            number: i.number ?? i.id,
            remainingCents: Math.max(0, i.totals.netToPay - i.paid),
            customerName: names.get(i.customerId) ?? 'Client',
          }))
          .filter((i) => i.remainingCents > 0);
        return ok(payable);
      },
      listSendableQuotes: async () => {
        const [q, cust] = await Promise.all([this.listQuotes(), this.listCustomers()]);
        if (!q.ok) return q;
        const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
        const quotes: SendableQuote[] = q.value
          .filter((x) => SENDABLE_QUOTE_STATUSES.has(x.status))
          .map((x) => ({
            id: x.id,
            number: x.number,
            customerName: names.get(x.customerId) ?? 'Client',
            totalTtcCents: x.totals.ttc,
            status: x.status,
          }));
        return ok(quotes);
      },
      listIssuableInvoices: async () => {
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
        const invoices: IssuableInvoice[] = inv.value
          .filter((x) => x.status === 'draft')
          .map((x) => ({
            id: x.id,
            number: x.number,
            customerName: names.get(x.customerId) ?? 'Client',
            totalTtcCents: x.totals.ttc,
            status: x.status,
          }));
        return ok(invoices);
      },
      listDocuments: async () => {
        const r = await this.listDocuments();
        if (!r.ok) return r;
        const docs: AgentDocument[] = r.value.slice(0, 12).map((d) => ({
          id: d.id,
          filename: d.filename,
          kind: d.kind,
          linkedEntityType: d.linkedEntityType,
          linkedEntityId: d.linkedEntityId,
          createdAt: d.createdAt,
        }));
        return ok(docs);
      },
      registerPayment: async (input) =>
        this.registerPayment({
          invoiceId: input.invoiceId,
          amount: input.amountCents,
          method: 'transfer',
          idempotencyKey: input.idempotencyKey ?? `local-bob:payment:${input.invoiceId}:${input.amountCents}:transfer`,
        }),
      sendQuote: async (input) => this.sendQuote(input.quoteId),
      issueInvoice: async (input) => this.issueInvoice({ invoiceId: input.invoiceId }),
      // —— Capacités optionnelles (C20 ③④ + C40 ⑤⑥ + creer_client) ——
      createQuote: async (input) => {
        const r = await this.createQuote({
          customerId: input.customerId,
          lines: input.lines,
          ...(input.depositPct !== undefined ? { depositPct: input.depositPct } : {}),
        });
        if (!r.ok) return r;
        return ok({ quoteId: r.value.quoteId });
      },
      recordExpense: async (input) =>
        this.recordExpense({
          supplierName: input.supplierName,
          documentDate: input.documentDate ?? this.clock.today(),
          totalTtcCents: input.totalTtcCents,
          category: input.category,
          vatRatePct: input.vatRatePct ?? null,
          source: 'manual',
        }),
      generateInvoice: async (input) =>
        this.generateInvoice({ quoteId: input.quoteId, ...(input.mode !== undefined ? { mode: input.mode } : {}) }),
      exportFec: async (input) => {
        const r = await this.exportFec(input);
        if (!r.ok) return r;
        return ok({
          filename: r.value.filename,
          entryCount: r.value.entryCount,
          rowCount: r.value.rowCount,
          warnings: [...r.value.warnings],
        });
      },
      createCustomer: async (input) =>
        // Défauts neutres d'une fiche minimale : adresse à compléter, aucun historique (score 100, encours 0).
        this.createCustomer({
          name: input.name,
          type: input.type,
          address: { line1: '', zip: '', city: '' },
          score: 100,
          avgDelayDays: 0,
          outstanding: 0,
        }),
    };
  }

  /** Agent local, journalisé en mémoire — même construction que le serveur (runtime clock+ids+store). */
  private bobAgent(): BobAgent {
    if (!this.agent) {
      this.agent = new BobAgent({
        router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
        actions: this.bobActions(),
        runtime: { clock: this.clock, ids: this.ids, store: this.journal },
      });
    }
    return this.agent;
  }

  /** POST /ai/ask local : autonomie demandée clampée par l'offre, comme le serveur. */
  async askBob(input: AskBobClientInput): Promise<Result<AgentRun, AppError>> {
    const autonomy = clampAutonomy(input.autonomy, this.autonomyEntitlement());
    return this.bobAgent().ask(input.message, { autonomy });
  }

  /** POST /ai/confirm local : exécution JOURNALISÉE (append-only) — mêmes sémantiques que le serveur. */
  async confirmBob(pending: PendingAction): Promise<Result<AgentRun, AppError>> {
    const record = await this.bobAgent().runJournaled(pendingToInvocations(pending), {
      autonomy: this.autonomyEntitlement(),
    });
    const blocked = record.outcomes.find((o) => o.status === 'denied' || o.status === 'failed');
    if (blocked) {
      if (blocked.status === 'denied') return err(appForbidden(blocked.reason ?? 'Action refusée par la policy.'));
      return err({ kind: 'dependency', port: 'agent-runtime', cause: blocked.reason ?? 'agent execution failed' });
    }
    const isBatch = pending.batch !== undefined && pending.batch.length > 0;
    return ok({
      kind: 'done',
      intent: 'encaisser',
      model: 'agent-runtime',
      plan: record.outcomes.map((o) => o.label),
      card: {
        title: 'Fait ✓',
        body: isBatch ? record.outcomes.map((o) => `✓ ${o.label}`).join('\n') : `${pending.label} — c’est noté.`,
      },
    });
  }

  /** GET /ai/runs/:runId/journal local : entrées d'audit du run (journal mémoire append-only). */
  async getRunJournal(runId: string): Promise<Result<JournalEntry[], AppError>> {
    return ok(await this.journal.load(runId));
  }
}
