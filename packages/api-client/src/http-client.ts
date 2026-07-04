import type { AgentRun, JournalEntry, PendingAction } from '@bob/ai';
import type {
  Result,
  AppError,
  CreateQuoteInput,
  CreateQuoteOutput,
  IssueInvoiceInput,
  CustomerListItem,
  CashflowProjection,
  Scenario,
  Horizon,
  PaymentMethod,
  PlanTier,
  DiagnosticResult,
  OcrExtraction,
  ExpenseProps,
  RecordExpenseInput,
  TradeConfig,
  ChantierProps,
  CreateChantierInput,
  CompanyProps,
  CompanyLookupResult,
  VatCheckResult,
  AddressSuggestion,
  DocumentView,
  DocumentDownloadUrl,
} from '@bob/core';
import type {
  BobClient,
  QuoteView,
  InvoiceView,
  PaymentView,
  SubscriptionView,
  RegisterPaymentClientInput,
  RegisterPaymentClientOutput,
  SendQuoteOutput,
  SendRelanceClientOutput,
  NotificationView,
  RegisterDeviceClientInput,
  SuggestExpenseDefaultsInput,
  ExpenseDefaultsView,
  ListDocumentsClientInput,
  UploadDocumentClientInput,
  VoiceConfig,
  VoiceSynthesisResult,
  InvoiceAccountingPreview,
  PaymentAccountingPreview,
  AccountingEntryView,
  ExportFecMetadata,
  ExportFecClientInput,
  ExportFecClientOutput,
  ClassifyDocumentClientInput,
  AskBobClientInput,
  CreateCustomerClientInput,
} from './client';

export interface HttpBobClientOptions {
  baseUrl: string;
  companyId: string;
  getToken?: () => Promise<string | null>;
}

/**
 * Implémentation HTTP de BobClient : parle au backend NestJS.
 * Brancher le backend = `new BobClientProvider client={new HttpBobClient(...)}` — aucun écran touché.
 */
export class HttpBobClient implements BobClient {
  readonly companyId: string;

  constructor(private readonly opts: HttpBobClientOptions) {
    this.companyId = opts.companyId;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Result<T, AppError>> {
    try {
      const token = this.opts.getToken ? await this.opts.getToken() : null;
      const init: RequestInit = {
        method,
        headers: {
          'content-type': 'application/json',
          'x-company-id': this.companyId,
          ...headers,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(`${this.opts.baseUrl}${path}`, init);
      const data: unknown = await res.json();
      if (!res.ok) {
        const error: AppError =
          data && typeof data === 'object' && 'error' in data
            ? (data as { error: AppError }).error
            : { kind: 'dependency', port: 'api', cause: `HTTP ${res.status}` };
        return { ok: false, error };
      }
      return { ok: true, value: data as T };
    } catch (e) {
      return { ok: false, error: { kind: 'dependency', port: 'api', cause: e instanceof Error ? e.message : 'réseau' } };
    }
  }

  private async reqText(path: string): Promise<Result<{ content: string; headers: Headers; contentType: string | null }, AppError>> {
    try {
      const token = this.opts.getToken ? await this.opts.getToken() : null;
      const res = await fetch(`${this.opts.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          'x-company-id': this.companyId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      const contentType = res.headers.get('content-type');
      const content = await res.text();
      if (!res.ok) {
        try {
          const data = JSON.parse(content) as unknown;
          const error: AppError =
            data && typeof data === 'object' && 'error' in data
              ? (data as { error: AppError }).error
              : { kind: 'dependency', port: 'api', cause: `HTTP ${res.status}` };
          return { ok: false, error };
        } catch {
          return { ok: false, error: { kind: 'dependency', port: 'api', cause: `HTTP ${res.status}` } };
        }
      }
      return { ok: true, value: { content, headers: res.headers, contentType } };
    } catch (e) {
      return { ok: false, error: { kind: 'dependency', port: 'api', cause: e instanceof Error ? e.message : 'réseau' } };
    }
  }

  getSubscription() {
    return this.req<SubscriptionView>('GET', '/subscription');
  }
  startCheckout(tier: PlanTier) {
    return this.req<{ url: string }>('POST', '/subscription/checkout', { tier });
  }
  billingPortal() {
    return this.req<{ url: string }>('POST', '/subscription/portal');
  }
  invoicePaymentLink(invoiceId: string) {
    return this.req<{ url: string }>('POST', `/invoices/${invoiceId}/payment-link`);
  }
  getDiagnostic() {
    return this.req<DiagnosticResult>('GET', '/diagnostic');
  }
  getProfile() {
    return this.req<TradeConfig>('GET', '/profile');
  }
  lookupCompany(siret: string) {
    return this.req<CompanyLookupResult>('GET', `/company/lookup?siret=${encodeURIComponent(siret)}`);
  }
  /** C24b : le serveur décide l'id (provisioning déterministe company-<userId>) — jamais d'id envoyé. */
  registerCompany(input: Omit<CompanyProps, 'id'>) {
    return this.req<{ companyId: string }>('POST', '/onboarding/company', input);
  }
  checkVat(vatNumber: string) {
    return this.req<VatCheckResult>('GET', `/vat/check?vat=${encodeURIComponent(vatNumber)}`);
  }
  searchAddress(query: string) {
    return this.req<AddressSuggestion[]>('GET', `/address/search?q=${encodeURIComponent(query)}`);
  }
  transcribe(input: { audioBase64: string; mimeType: string }) {
    return this.req<{ text: string }>('POST', '/voice/transcribe', input);
  }
  synthesizeSpeech(input: { text: string }) {
    return this.req<VoiceSynthesisResult>('POST', '/voice/synthesize', input);
  }
  voiceConfig() {
    return this.req<VoiceConfig>('GET', '/voice/config');
  }
  listDocuments(input: ListDocumentsClientInput = {}) {
    const params = new URLSearchParams();
    if (input.kind !== undefined) params.set('kind', input.kind);
    if (input.linkedEntityType !== undefined) params.set('linkedEntityType', input.linkedEntityType);
    if (input.linkedEntityId !== undefined) params.set('linkedEntityId', input.linkedEntityId);
    if (input.includeDeleted !== undefined) params.set('includeDeleted', String(input.includeDeleted));
    const qs = params.toString();
    return this.req<DocumentView[]>('GET', `/documents${qs ? `?${qs}` : ''}`);
  }
  uploadDocument(input: UploadDocumentClientInput) {
    return this.req<DocumentView>('POST', '/documents/upload', input);
  }
  classifyDocument(input: ClassifyDocumentClientInput) {
    const { documentId, ...body } = input;
    return this.req<DocumentView>('POST', `/documents/${documentId}/classify`, body);
  }
  documentDownloadUrl(documentId: string, ttlSeconds?: number) {
    const qs = ttlSeconds !== undefined ? `?ttl=${encodeURIComponent(String(ttlSeconds))}` : '';
    return this.req<DocumentDownloadUrl>('GET', `/documents/${documentId}/download-url${qs}`);
  }
  extractDocument(input: { contentBase64: string; mimeType: string }) {
    return this.req<OcrExtraction>('POST', '/documents/ocr', input);
  }
  suggestExpenseDefaults(input: SuggestExpenseDefaultsInput) {
    return this.req<ExpenseDefaultsView>('POST', '/expenses/defaults', input);
  }
  recordExpense(input: Omit<RecordExpenseInput, 'companyId'>) {
    return this.req<{ id: string }>('POST', '/expenses', input);
  }
  listExpenses() {
    return this.req<ExpenseProps[]>('GET', '/expenses');
  }
  createChantier(input: Omit<CreateChantierInput, 'companyId'>) {
    return this.req<{ id: string }>('POST', '/chantiers', input);
  }
  listChantiers() {
    return this.req<ChantierProps[]>('GET', '/chantiers');
  }
  listCustomers() {
    return this.req<CustomerListItem[]>('GET', '/customers');
  }
  createCustomer(input: CreateCustomerClientInput) {
    return this.req<{ id: string }>('POST', '/customers', input);
  }
  // —— Assistant Bob (C40 ⑧) : l'agent tourne CÔTÉ SERVEUR — journal company-scoped, autonomie clampée ——
  askBob(input: AskBobClientInput) {
    return this.req<AgentRun>('POST', '/ai/ask', input);
  }
  confirmBob(pending: PendingAction) {
    return this.req<AgentRun>('POST', '/ai/confirm', pending);
  }
  getRunJournal(runId: string) {
    return this.req<JournalEntry[]>('GET', `/ai/runs/${encodeURIComponent(runId)}/journal`);
  }
  getCashflow(input: { scenario: Scenario; horizon: Horizon }) {
    return this.req<CashflowProjection>(
      'GET',
      `/cashflow?scenario=${encodeURIComponent(input.scenario)}&horizon=${encodeURIComponent(String(input.horizon))}`,
    );
  }
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>) {
    return this.req<CreateQuoteOutput>('POST', '/quotes', input);
  }
  sendQuote(quoteId: string) {
    return this.req<SendQuoteOutput>('POST', `/quotes/${quoteId}/send`);
  }
  signQuote(input: { quoteId: string; signerName: string }) {
    return this.req<{ status: string }>('POST', `/quotes/${input.quoteId}/sign`, { signerName: input.signerName });
  }
  refuseQuote(quoteId: string) {
    return this.req<{ status: string }>('POST', `/quotes/${quoteId}/refuse`);
  }
  generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }) {
    return this.req<{ invoiceId: string }>('POST', `/quotes/${input.quoteId}/invoice`, { mode: input.mode });
  }
  /** A6 — endpoint serveur à poser (suivi CLAIMS, même précédent que classifyDocument). */
  createCreditNote(input: { invoiceId: string }) {
    return this.req<{ creditNoteId: string }>('POST', `/invoices/${input.invoiceId}/credit-note`);
  }
  /** E3 — endpoint serveur à poser (suivi CLAIMS) : encaissements datés du tenant. */
  listPayments() {
    return this.req<PaymentView[]>('GET', '/payments');
  }
  issueInvoice(input: IssueInvoiceInput) {
    return this.req<{ number: string }>('POST', `/invoices/${input.invoiceId}/issue`, input);
  }
  /** C25 ② : envoi RÉEL — le serveur choisit le ton (plan @bob/core) et livre email + miroir push. */
  sendRelance(invoiceId: string) {
    return this.req<SendRelanceClientOutput>('POST', `/invoices/${invoiceId}/relance`);
  }
  listNotifications() {
    return this.req<NotificationView[]>('GET', '/notifications');
  }
  markNotificationRead(id: string) {
    return this.req<NotificationView>('POST', `/notifications/${id}/read`);
  }
  registerDevice(input: RegisterDeviceClientInput) {
    return this.req<{ id: string }>('POST', '/devices', input);
  }
  registerPayment(input: RegisterPaymentClientInput) {
    const body = { amount: input.amount, method: input.method, idempotencyKey: input.idempotencyKey ?? undefined };
    const headers = input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : undefined;
    return this.req<RegisterPaymentClientOutput>('POST', `/invoices/${input.invoiceId}/pay`, body, headers);
  }
  getQuote(id: string) {
    return this.req<QuoteView>('GET', `/quotes/${id}`);
  }
  listQuotes() {
    return this.req<QuoteView[]>('GET', '/quotes');
  }
  getInvoice(id: string) {
    return this.req<InvoiceView>('GET', `/invoices/${id}`);
  }
  invoiceAccountingPreview(invoiceId: string) {
    return this.req<InvoiceAccountingPreview>('GET', `/invoices/${invoiceId}/accounting-preview`);
  }
  paymentAccountingPreview(input: { invoiceId: string; amountCents: number; method: PaymentMethod }) {
    const qs = new URLSearchParams({ amount: String(input.amountCents), method: input.method }).toString();
    return this.req<PaymentAccountingPreview>('GET', `/invoices/${input.invoiceId}/payment-accounting-preview?${qs}`);
  }
  listInvoices() {
    return this.req<InvoiceView[]>('GET', '/invoices');
  }
  listAccountingEntries() {
    return this.req<AccountingEntryView[]>('GET', '/accounting/entries');
  }
  async exportFec(input: ExportFecClientInput): Promise<Result<ExportFecClientOutput, AppError>> {
    const qs = new URLSearchParams({ from: input.from, to: input.to }).toString();
    const metadata = await this.req<ExportFecMetadata>('GET', `/accounting/fec-metadata?${qs}`);
    if (!metadata.ok) return metadata;
    const r = await this.reqText(`/accounting/fec?${qs}`);
    if (!r.ok) return r;
    const description = await this.reqText(`/accounting/fec-description?${qs}`);
    if (!description.ok) return description;
    const disposition = r.value.headers.get('content-disposition') ?? '';
    const descriptionDisposition = description.value.headers.get('content-disposition') ?? '';
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const descriptionFilenameMatch = descriptionDisposition.match(/filename="?([^";]+)"?/i);
    const filename = filenameMatch?.[1] ?? metadata.value.filename;
    const descriptionFilename = descriptionFilenameMatch?.[1] ?? metadata.value.descriptionFilename;
    return {
      ok: true,
      value: {
        filename,
        mimeType: r.value.contentType ?? 'text/plain; charset=utf-8',
        content: r.value.content,
        descriptionFilename,
        descriptionContent: description.value.content,
        entryCount: metadata.value.entryCount,
        rowCount: metadata.value.rowCount,
        warnings: metadata.value.warnings,
      },
    };
  }
}
