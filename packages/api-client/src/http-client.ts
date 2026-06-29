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
} from '@bob/core';
import type { BobClient, QuoteView, InvoiceView, SubscriptionView } from './client';

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

  private async req<T>(method: string, path: string, body?: unknown): Promise<Result<T, AppError>> {
    try {
      const token = this.opts.getToken ? await this.opts.getToken() : null;
      const init: RequestInit = {
        method,
        headers: {
          'content-type': 'application/json',
          'x-company-id': this.companyId,
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
  extractDocument(input: { contentBase64: string; mimeType: string }) {
    return this.req<OcrExtraction>('POST', '/documents/ocr', input);
  }
  recordExpense(input: Omit<RecordExpenseInput, 'companyId'>) {
    return this.req<{ id: string }>('POST', '/expenses', input);
  }
  listExpenses() {
    return this.req<ExpenseProps[]>('GET', '/expenses');
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
    return this.req<{ number: string }>('POST', `/quotes/${quoteId}/send`);
  }
  signQuote(input: { quoteId: string; signerName: string }) {
    return this.req<{ status: string }>('POST', `/quotes/${input.quoteId}/sign`, { signerName: input.signerName });
  }
  generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }) {
    return this.req<{ invoiceId: string }>('POST', `/quotes/${input.quoteId}/invoice`, { mode: input.mode });
  }
  issueInvoice(input: IssueInvoiceInput) {
    return this.req<{ number: string }>('POST', `/invoices/${input.invoiceId}/issue`, input);
  }
  registerPayment(input: { invoiceId: string; amount: number; method: PaymentMethod }) {
    return this.req<{ status: string }>('POST', `/invoices/${input.invoiceId}/pay`, { amount: input.amount, method: input.method });
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
