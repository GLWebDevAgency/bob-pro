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
  ExpenseCategory,
  RecordExpenseInput,
  TradeConfig,
  ChantierProps,
  CreateChantierInput,
  CompanyLookupResult,
  VatCheckResult,
  AddressSuggestion,
  DocumentKind,
  DocumentLinkedEntityType,
  DocumentView,
  DocumentDownloadUrl,
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
  parentQuoteId: string | null;
  totals: Totals;
  mentions: string[];
  dueAt: string | null;
  paid: number;
}

export interface RegisterPaymentClientInput {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  idempotencyKey?: string | null;
}

export interface RegisterPaymentClientOutput {
  status: string;
  paymentId: string;
}

export interface SendQuoteOutput {
  number: string;
  signatureToken?: string;
  signatureTokenExpiresAt?: string;
}

export interface ListDocumentsClientInput {
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType;
  linkedEntityId?: string;
  includeDeleted?: boolean;
}

export interface UploadDocumentClientInput {
  contentBase64: string;
  mimeType: string;
  filename: string;
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType | null;
  linkedEntityId?: string | null;
  documentDate?: string | null;
}

export interface VoiceConfig {
  cloudAvailable: boolean;
  ttsCloudAvailable?: boolean;
}

export interface VoiceSynthesisResult {
  audioBase64: string | null;
  mimeType: string | null;
  model: string;
}

export interface AccountingPreviewLine {
  account: string;
  label: string;
  debitCents: number;
  creditCents: number;
}

export interface InvoiceAccountingPreview {
  invoiceId: string;
  available: boolean;
  reason: string | null;
  entryId: string | null;
  reference: string | null;
  entryDate: string | null;
  label: string | null;
  totalDebitCents: number;
  totalCreditCents: number;
  lines: AccountingPreviewLine[];
}

export interface PaymentAccountingPreview {
  invoiceId: string;
  available: boolean;
  reason: string | null;
  reference: string | null;
  amountCents: number;
  remainingCents: number;
  method: PaymentMethod;
  totalDebitCents: number;
  totalCreditCents: number;
  lines: AccountingPreviewLine[];
}

export interface AccountingEntryView {
  id: string;
  companyId: string;
  journal: string;
  sourceType: string;
  sourceId: string;
  entryDate: string;
  reference: string;
  label: string;
  lines: AccountingPreviewLine[];
}

export interface ExportFecClientInput {
  from: string;
  to: string;
}

export interface SuggestExpenseDefaultsInput {
  supplierName: string;
  supplierSiren?: string | null;
  vatRatePctApplied?: number | null;
  categoryGuess: ExpenseCategory;
}

export interface ExpenseDefaultsView {
  supplierName: string;
  supplierSiren: string | null;
  category: ExpenseCategory;
  vatRatePct: number | null;
  source: 'memory' | 'ocr';
}

export interface ExportFecClientOutput {
  filename: string;
  mimeType: string;
  content: string;
  descriptionFilename: string;
  descriptionContent: string;
  entryCount: number;
  rowCount: number;
  warnings: string[];
}

export interface ExportFecMetadata {
  filename: string;
  descriptionFilename: string;
  entryCount: number;
  rowCount: number;
  warnings: string[];
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
  ai?: { capability: string; defaultAutonomy: string; monthlyActions: number | null };
  autonomyEntitlement?: string;
  limits?: { documentStorageGb: number; includedCompanies: number; includedTeamSeats: number };
  addOns?: string[];
  addOnCatalog?: {
    addOn: string;
    kind: string;
    label: string;
    priceCents: number;
    tagline: string;
    minTier: string;
    grants: string[];
    autonomy?: string;
  }[];
  catalog: {
    tier: string;
    label: string;
    priceCents: number;
    annualMonthlyCents: number;
    tagline: string;
    features: string[];
    ai?: { capability: string; defaultAutonomy: string; monthlyActions: number | null };
    limits?: { documentStorageGb: number; includedCompanies: number; includedTeamSeats: number };
  }[];
}

export interface BobClient {
  readonly companyId: string;
  getSubscription(): Promise<Result<SubscriptionView, AppError>>;
  startCheckout(tier: PlanTier): Promise<Result<{ url: string }, AppError>>;
  billingPortal(): Promise<Result<{ url: string }, AppError>>;
  invoicePaymentLink(invoiceId: string): Promise<Result<{ url: string }, AppError>>;
  getDiagnostic(): Promise<Result<DiagnosticResult, AppError>>;
  getProfile(): Promise<Result<TradeConfig, AppError>>;
  lookupCompany(siret: string): Promise<Result<CompanyLookupResult, AppError>>;
  checkVat(vatNumber: string): Promise<Result<VatCheckResult, AppError>>;
  searchAddress(query: string): Promise<Result<AddressSuggestion[], AppError>>;
  transcribe(input: { audioBase64: string; mimeType: string }): Promise<Result<{ text: string }, AppError>>;
  synthesizeSpeech(input: { text: string }): Promise<Result<VoiceSynthesisResult, AppError>>;
  voiceConfig(): Promise<Result<VoiceConfig, AppError>>;
  listDocuments(input?: ListDocumentsClientInput): Promise<Result<DocumentView[], AppError>>;
  uploadDocument(input: UploadDocumentClientInput): Promise<Result<DocumentView, AppError>>;
  documentDownloadUrl(documentId: string, ttlSeconds?: number): Promise<Result<DocumentDownloadUrl, AppError>>;
  extractDocument(input: { contentBase64: string; mimeType: string }): Promise<Result<OcrExtraction, AppError>>;
  suggestExpenseDefaults(input: SuggestExpenseDefaultsInput): Promise<Result<ExpenseDefaultsView, AppError>>;
  recordExpense(input: Omit<RecordExpenseInput, 'companyId'>): Promise<Result<{ id: string }, AppError>>;
  listExpenses(): Promise<Result<ExpenseProps[], AppError>>;
  createChantier(input: Omit<CreateChantierInput, 'companyId'>): Promise<Result<{ id: string }, AppError>>;
  listChantiers(): Promise<Result<ChantierProps[], AppError>>;
  listCustomers(): Promise<Result<CustomerListItem[], AppError>>;
  getCashflow(input: { scenario: Scenario; horizon: Horizon }): Promise<Result<CashflowProjection, AppError>>;
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>): Promise<Result<CreateQuoteOutput, AppError>>;
  sendQuote(quoteId: string): Promise<Result<SendQuoteOutput, AppError>>;
  signQuote(input: { quoteId: string; signerName: string }): Promise<Result<{ status: string }, AppError>>;
  refuseQuote(quoteId: string): Promise<Result<{ status: string }, AppError>>;
  generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>>;
  issueInvoice(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>>;
  registerPayment(input: RegisterPaymentClientInput): Promise<Result<RegisterPaymentClientOutput, AppError>>;
  getQuote(id: string): Promise<Result<QuoteView, AppError>>;
  listQuotes(): Promise<Result<QuoteView[], AppError>>;
  getInvoice(id: string): Promise<Result<InvoiceView, AppError>>;
  invoiceAccountingPreview(invoiceId: string): Promise<Result<InvoiceAccountingPreview, AppError>>;
  paymentAccountingPreview(input: {
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
  }): Promise<Result<PaymentAccountingPreview, AppError>>;
  listInvoices(): Promise<Result<InvoiceView[], AppError>>;
  listAccountingEntries(): Promise<Result<AccountingEntryView[], AppError>>;
  exportFec(input: ExportFecClientInput): Promise<Result<ExportFecClientOutput, AppError>>;
}
