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
  PlanTier,
  DiagnosticResult,
  OcrExtraction,
  ExpenseProps,
  RecordExpenseInput,
  TradeConfig,
  ChantierProps,
  CreateChantierInput,
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
  SubscriptionView,
  RegisterPaymentClientInput,
  SendQuoteOutput,
  ListDocumentsClientInput,
  UploadDocumentClientInput,
  VoiceConfig,
  VoiceSynthesisResult,
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
  documentDownloadUrl(documentId: string, ttlSeconds?: number) {
    const qs = ttlSeconds !== undefined ? `?ttl=${encodeURIComponent(String(ttlSeconds))}` : '';
    return this.req<DocumentDownloadUrl>('GET', `/documents/${documentId}/download-url${qs}`);
  }
  extractDocument(input: { contentBase64: string; mimeType: string }) {
    return this.req<OcrExtraction>('POST', '/documents/ocr', input);
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
  issueInvoice(input: IssueInvoiceInput) {
    return this.req<{ number: string }>('POST', `/invoices/${input.invoiceId}/issue`, input);
  }
  registerPayment(input: RegisterPaymentClientInput) {
    const body = { amount: input.amount, method: input.method, idempotencyKey: input.idempotencyKey ?? undefined };
    const headers = input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : undefined;
    return this.req<{ status: string }>('POST', `/invoices/${input.invoiceId}/pay`, body, headers);
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
  listInvoices() {
    return this.req<InvoiceView[]>('GET', '/invoices');
  }
}
