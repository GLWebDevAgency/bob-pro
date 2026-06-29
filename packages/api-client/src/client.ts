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
  Totals,
  QuoteLine,
  QuoteStatus,
  InvoiceStatus,
  InvoiceKind,
  PlanTier,
  DiagnosticResult,
  OcrExtraction,
  ExpenseProps,
  RecordExpenseInput,
} from '@bob/core';

export interface QuoteView {
  id: string;
  companyId: string;
  customerId: string;
  status: QuoteStatus;
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
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string | null;
  totals: Totals;
  mentions: string[];
  dueAt: string | null;
  paid: number;
}

/**
 * Façade data consommée par l'app mobile (via TanStack Query).
 * Deux implémentations : LocalBobClient (fixtures, hors-ligne — V1) et, plus tard, HttpBobClient (NestJS).
 * L'UI ne connaît que cette interface : brancher le backend = changer d'implémentation, sans toucher aux écrans.
 */
export interface SubscriptionView {
  tier: string;
  status: string;
  currentPeriodEnd: string | null;
  features: string[];
  catalog: { tier: string; label: string; priceCents: number; features: string[] }[];
}

export interface BobClient {
  readonly companyId: string;
  getSubscription(): Promise<Result<SubscriptionView, AppError>>;
  startCheckout(tier: PlanTier): Promise<Result<{ url: string }, AppError>>;
  getDiagnostic(): Promise<Result<DiagnosticResult, AppError>>;
  extractDocument(input: { contentBase64: string; mimeType: string }): Promise<Result<OcrExtraction, AppError>>;
  recordExpense(input: Omit<RecordExpenseInput, 'companyId'>): Promise<Result<{ id: string }, AppError>>;
  listExpenses(): Promise<Result<ExpenseProps[], AppError>>;
  listCustomers(): Promise<Result<CustomerListItem[], AppError>>;
  getCashflow(input: { scenario: Scenario; horizon: Horizon }): Promise<Result<CashflowProjection, AppError>>;
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>): Promise<Result<CreateQuoteOutput, AppError>>;
  sendQuote(quoteId: string): Promise<Result<{ number: string }, AppError>>;
  signQuote(input: { quoteId: string; signerName: string }): Promise<Result<{ status: string }, AppError>>;
  generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>>;
  issueInvoice(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>>;
  registerPayment(input: { invoiceId: string; amount: number; method: PaymentMethod }): Promise<Result<{ status: string }, AppError>>;
  getQuote(id: string): Promise<Result<QuoteView, AppError>>;
  listQuotes(): Promise<Result<QuoteView[], AppError>>;
  getInvoice(id: string): Promise<Result<InvoiceView, AppError>>;
  listInvoices(): Promise<Result<InvoiceView[], AppError>>;
}
