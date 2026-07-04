import type { AgentAutonomy, AgentRun, JournalEntry, PendingAction } from '@bob/ai';
import type {
  Result,
  AppError,
  CreateQuoteInput,
  CreateQuoteOutput,
  IssueInvoiceInput,
  CustomerListItem,
  CustomerProps,
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
  FiscalDeadline,
  OcrExtraction,
  ExpenseProps,
  ExpenseCategory,
  RecordExpenseInput,
  TradeConfig,
  ChantierProps,
  CreateChantierInput,
  CompanyProps,
  CompanyLookupResult,
  VatCheckResult,
  AddressSuggestion,
  DocumentKind,
  DocumentLinkedEntityType,
  DocumentView,
  DocumentDownloadUrl,
  SubscriptionInfo,
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
  /** Lignes de la pièce (C16 — l'entité domaine les porte depuis toujours). */
  lines: QuoteLine[];
  /** Acompte déjà facturé, déduit du net à payer d'une finale (0 = aucun) — A2-C16. */
  depositDeductionCents: number;
  /** Facture d'acompte déduite (nav croisée). */
  depositInvoiceId: string | null;
  /** Date d'émission (E3 — socle dates : CA 12 mois, balance âgée, seuils 293 B).
   *  Nullable ET optionnelle : une API amont pas encore à jour la laisse absente. */
  issuedAt?: string | null;
}

/** Encaissement daté (E3) — la matière du CA encaissé annuel et du lettrage à venir. */
export interface PaymentView {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  receivedAt: string;
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
  /** Tags de classement/recherche (#11) — proposés par l'OCR, confirmés à l'enregistrement. */
  tags?: string[];
}

export interface ClassifyDocumentClientInput {
  documentId: string;
  linkedEntityType: DocumentLinkedEntityType;
  linkedEntityId: string;
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

/** POST /ai/ask — DTO serveur constaté (AiController) : { message, autonomy? } -> AgentRun. */
export interface AskBobClientInput {
  message: string;
  /** Autonomie DEMANDÉE — le serveur la clampe par l'offre (autonomyEntitlement) ; le local aussi. */
  autonomy?: AgentAutonomy;
}

/** POST /customers — DTO serveur constaté (CustomersController) : CustomerProps sans id/companyId. */
export type CreateCustomerClientInput = Omit<CustomerProps, 'id' | 'companyId'>;

/** Envoi RÉEL d'une relance ciblée (C25 ② — endpoint POST /invoices/:id/relance, DTO serveur
 * constaté : { jobId, status, tone }). Le serveur choisit le ton via le plan @bob/core
 * (deriveRelancePlan, dédup quotidienne `invoice:{id}:relance:{today}`) et livre email + miroir
 * push. La mise en demeure passe par CE geste uniquement (le cron ne l'envoie jamais seul). */
export interface SendRelanceClientOutput {
  jobId: string;
  /** done | pending | failed (échec = job en retry côté serveur, cause loggée). */
  status: string;
  /** Ton effectivement envoyé (cordial | neutre | ferme | miseendemeure). */
  tone?: string;
}

/** GET /notifications — fil réel du tenant : ce que les JOBS serveur ont produit (relances
 * envoyées/en retry, liens de signature), avec état lu/non-lu PERSISTÉ. */
export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  /** Corps disponible tant que non livré (purgé ensuite côté serveur — hygiène PII). */
  body: string | null;
  channel: string;
  status: string;
  /** Deep link mobile (ex. /facture/inv-1) — null si aucune cible. */
  route: string | null;
  readAt: string | null;
  createdAt: string;
}

/** POST /devices — enregistrement du token push Expo du device (idempotent par tenant/token). */
export interface RegisterDeviceClientInput {
  expoPushToken: string;
  platform?: 'ios' | 'android' | 'web';
}

/**
 * Façade data consommée par l'app mobile (via TanStack Query).
 * Deux implémentations : LocalBobClient (fixtures, hors-ligne — V1) et, plus tard, HttpBobClient (NestJS).
 * L'UI ne connaît que cette interface : brancher le backend = changer d'implémentation, sans toucher aux écrans.
 */
/**
 * GET /subscription (C26b) — abonnement RÉEL du tenant. Étend SubscriptionInfo (@bob/core,
 * défini par C26 dans derive-account-view — le type fait foi, pas de doublon) : tout
 * SubscriptionView EST un SubscriptionInfo, l'écran Compte le passe tel quel à deriveAccountView.
 */
export interface SubscriptionView extends SubscriptionInfo {
  /** Accès anticipé RÉEL : aucun billing n'existe — l'écran Compte affiche l'état early-access honnête. */
  earlyAccess: boolean;
  /** Prix réellement facturé au tenant (centimes/mois) — 0 pendant l'accès anticipé. */
  priceCents: number;
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
  /** GET /subscription (C26b) : abonnement réel du tenant (SubscriptionView ⊂ SubscriptionInfo @bob/core).
   * En early-access le serveur renvoie earlyAccess: true, priceCents: 0 — l'écran Compte en dérive
   * l'état honnête. Local (démo) : early-access aligné sur le seed. */
  getSubscription(): Promise<Result<SubscriptionView, AppError>>;
  startCheckout(tier: PlanTier): Promise<Result<{ url: string }, AppError>>;
  billingPortal(): Promise<Result<{ url: string }, AppError>>;
  invoicePaymentLink(invoiceId: string): Promise<Result<{ url: string }, AppError>>;
  getDiagnostic(): Promise<Result<DiagnosticResult, AppError>>;
  /** GET /fiscal-calendar (C-EXP5b) : échéances fiscales à venir (fenêtre 90 j) dérivées de la
   * fiche société par deriveFiscalCalendar (@bob/core). fiscalYearEnd / périodicité URSSAF pas
   * encore capturés côté serveur : les échéances concernées arrivent en confidence 'assumed'
   * (hypothèse honnête à confirmer) ; amountHint toujours null en v1 (aucun montant inventé). */
  getFiscalCalendar(): Promise<Result<FiscalDeadline[], AppError>>;
  getProfile(): Promise<Result<TradeConfig, AppError>>;
  lookupCompany(siret: string): Promise<Result<CompanyLookupResult, AppError>>;
  /** POST /onboarding/company (C24b) : crée la société du compte (provisioning tenant à
   * l'inscription — id décidé PAR LE SERVEUR, jamais fourni par le client) ou met à jour
   * SA société quand le tenant existe déjà. Local (démo) : la société seedée. */
  registerCompany(input: Omit<CompanyProps, 'id'>): Promise<Result<{ companyId: string }, AppError>>;
  checkVat(vatNumber: string): Promise<Result<VatCheckResult, AppError>>;
  searchAddress(query: string): Promise<Result<AddressSuggestion[], AppError>>;
  transcribe(input: { audioBase64: string; mimeType: string }): Promise<Result<{ text: string }, AppError>>;
  synthesizeSpeech(input: { text: string }): Promise<Result<VoiceSynthesisResult, AppError>>;
  voiceConfig(): Promise<Result<VoiceConfig, AppError>>;
  listDocuments(input?: ListDocumentsClientInput): Promise<Result<DocumentView[], AppError>>;
  uploadDocument(input: UploadDocumentClientInput): Promise<Result<DocumentView, AppError>>;
  documentDownloadUrl(documentId: string, ttlSeconds?: number): Promise<Result<DocumentDownloadUrl, AppError>>;
  /** Confirme le classement proposé après OCR (A1-C14) — même use case pour l'UI et Bob. */
  classifyDocument(input: ClassifyDocumentClientInput): Promise<Result<DocumentView, AppError>>;
  extractDocument(input: { contentBase64: string; mimeType: string }): Promise<Result<OcrExtraction, AppError>>;
  suggestExpenseDefaults(input: SuggestExpenseDefaultsInput): Promise<Result<ExpenseDefaultsView, AppError>>;
  recordExpense(input: Omit<RecordExpenseInput, 'companyId'>): Promise<Result<{ id: string }, AppError>>;
  /** E4 : règle une dépense (to_pay→paid + décaissement 401/512) — même use case que Bob. */
  payExpense(input: { expenseId: string }): Promise<Result<{ status: string }, AppError>>;
  listExpenses(): Promise<Result<ExpenseProps[], AppError>>;
  createChantier(input: Omit<CreateChantierInput, 'companyId'>): Promise<Result<{ id: string }, AppError>>;
  listChantiers(): Promise<Result<ChantierProps[], AppError>>;
  listCustomers(): Promise<Result<CustomerListItem[], AppError>>;
  /** Crée une fiche client — même use case pour l'UI (C12) et l'outil agent creer_client (C40). */
  createCustomer(input: CreateCustomerClientInput): Promise<Result<{ id: string }, AppError>>;
  // —— Assistant Bob (C40, TODO ⑧ « journal on-device ») — endpoints /ai existants ——
  /** POST /ai/ask : en HTTP l'agent tourne CÔTÉ SERVEUR (autonomie clampée par l'offre, journal
   * append-only company-scoped) ; l'adaptateur local exécute l'agent @bob/ai on-device (mode dev). */
  askBob(input: AskBobClientInput): Promise<Result<AgentRun, AppError>>;
  /** POST /ai/confirm : exécute l'action proposée (PendingAction) via le runtime JOURNALISÉ. */
  confirmBob(pending: PendingAction): Promise<Result<AgentRun, AppError>>;
  /** GET /ai/runs/:runId/journal : entrées d'audit append-only d'un run (company-scoped côté serveur).
   * NB : les DTO AgentRun de ask/confirm n'exposent pas (encore) le runId — voir rapport C40. */
  getRunJournal(runId: string): Promise<Result<JournalEntry[], AppError>>;
  getCashflow(input: { scenario: Scenario; horizon: Horizon }): Promise<Result<CashflowProjection, AppError>>;
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>): Promise<Result<CreateQuoteOutput, AppError>>;
  sendQuote(quoteId: string): Promise<Result<SendQuoteOutput, AppError>>;
  signQuote(input: { quoteId: string; signerName: string }): Promise<Result<{ status: string }, AppError>>;
  refuseQuote(quoteId: string): Promise<Result<{ status: string }, AppError>>;
  generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>>;
  /** A6 : avoir TOTAL (brouillon) d'une facture émise — même use case pour l'UI et Bob. */
  createCreditNote(input: { invoiceId: string }): Promise<Result<{ creditNoteId: string }, AppError>>;
  issueInvoice(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>>;
  /** C25 ② : envoi RÉEL d'une relance ciblée — POST /invoices/:id/relance (ton du plan @bob/core,
   * confirmation côté UI/agent avant l'appel : action sortante vers un tiers). */
  sendRelance(invoiceId: string): Promise<Result<SendRelanceClientOutput, AppError>>;
  // —— Fil de notifications + push (C25) — endpoints /notifications et /devices ——
  /** GET /notifications : le fil du tenant (serveur = source de vérité ; Local = dérivé démo). */
  listNotifications(): Promise<Result<NotificationView[], AppError>>;
  /** POST /notifications/:id/read : marque lue (idempotent, persisté côté serveur). */
  markNotificationRead(id: string): Promise<Result<NotificationView, AppError>>;
  /** POST /devices : enregistre le token push Expo du device (idempotent par tenant/token). */
  registerDevice(input: RegisterDeviceClientInput): Promise<Result<{ id: string }, AppError>>;
  registerPayment(input: RegisterPaymentClientInput): Promise<Result<RegisterPaymentClientOutput, AppError>>;
  /** E3 : encaissements datés du tenant — CA encaissé annuel (seuils 293 B), lettrage futur. */
  listPayments(): Promise<Result<PaymentView[], AppError>>;
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
