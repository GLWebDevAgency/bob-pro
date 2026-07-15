import type { AgentContext, AgentRun, AskOptions, JournalEntry, PendingAction } from '@bob/ai';
import type { ValueDigest,
  Result,
  AppError,
  CreateQuoteInput,
  CreateQuoteOutput,
  IssueInvoiceInput,
  UpdateQuoteLineInput,
  RemoveQuoteLineInput,
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
  FacturXExpenseDraft,
  AfnorInboundRefusalStatus,
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
  DocumentFolderView,
  DeleteDocumentFolderStrategy,
  DocumentAnalysis,
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
  /** État honnête du canal email au retour HTTP : le worker peut encore être en attente. */
  deliveryStatus: 'queued' | 'sent' | 'skipped';
  /** R4 : URL publique sign-web prête à partager (même lien que celui envoyé par e-mail) —
   * absente si la génération du jeton a échoué côté serveur (le devis reste envoyé/vu :
   * ce n'est jamais bloquant, seul le partage manuel du lien devient indisponible). */
  signatureUrl?: string;
}

/**
 * P0 R4 : « Envoyer le lien » ne doit RIEN envoyer — lien de signature préparé/roté SANS e-mail
 * ni outbox (POST /quotes/:id/signature-link, commande distincte de sendQuote). Annuler le
 * partage côté client = rien n'est parti ; l'ancien lien est révoqué par la rotation.
 */
export interface CreateQuoteSignatureLinkOutput {
  /** URL publique sign-web prête à partager — construite CÔTÉ SERVEUR (source unique). */
  signatureUrl: string;
  expiresAt: string;
}

export interface ListDocumentsClientInput {
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType;
  linkedEntityId?: string;
  folderId?: string | null;
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
  folderId?: string | null;
  /** Tags de classement/recherche (#11) — proposés par l'OCR, confirmés à l'enregistrement. */
  tags?: string[];
}

export interface CreateDocumentIntakeClientInput {
  contentBase64: string;
  mimeType: string;
  filename: string;
  idempotencyKey: string;
}

export interface ListDocumentFoldersClientInput {
  parentId?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface DocumentFolderPageView {
  items: DocumentFolderView[];
  nextCursor: string | null;
}

export interface DocumentFolderDeletionPlanView {
  planId: string;
  expiresAt: string;
  folder: Pick<DocumentFolderView, 'id' | 'parentId' | 'name' | 'systemKey'>;
  directChildCount: number;
  descendantFolderCount: number;
  directDocumentCount: number;
  documentCount: number;
  canDeleteEmpty: boolean;
}

export interface DocumentFolderDeletionExecutionView {
  folderId: string;
  transferredDocuments: number;
  transferredChildren: number;
}

export interface ClassifyDocumentClientInput {
  documentId: string;
  linkedEntityType: DocumentLinkedEntityType;
  linkedEntityId: string;
  expectedRevision: number;
}

/**
 * Données comptables confirmées par l'utilisateur après lecture de l'original.
 * L'identité tenant, la source OCR et la clé d'idempotence restent exclusivement
 * sous le contrôle du serveur.
 */
export type DocumentExpenseDraft = Omit<
  RecordExpenseInput,
  'companyId' | 'idempotencyKey' | 'source'
>;

export interface RecordDocumentExpenseClientInput {
  documentId: string;
  expectedRevision: number;
  targetFolderId: string;
  expense: DocumentExpenseDraft;
}

export interface RecordDocumentExpenseClientOutput {
  expenseId: string;
  document: DocumentView;
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

export interface RealtimeVoiceConfig {
  available: boolean;
  availabilityReason?: 'disabled' | 'not_entitled' | 'entitlement_unavailable';
  transport: 'webrtc' | 'mistral-pcm';
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  requiresDevelopmentBuild: true;
  maxSessionSeconds: number;
  speechDelivery: 'audited-signed-url-v1';
}

export interface RealtimeVoiceSpeechSourcePolicy {
  mode: 'signed-url-v1';
  allowedOrigin: string;
  allowedPathPrefix: string;
}

interface RealtimeVoiceCallCommon {
  sessionHandle: string;
  hardExpiresAt: string;
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  maxSessionSeconds: number;
  speechSourcePolicy: RealtimeVoiceSpeechSourcePolicy;
}

export interface RealtimeVoiceWebRtcCall extends RealtimeVoiceCallCommon {
  transport: 'webrtc';
  answerSdp: string;
}

export interface RealtimeVoiceMistralPcmCall extends RealtimeVoiceCallCommon {
  transport: 'mistral-pcm';
  websocketUrl: string;
  companyId: string;
  ticket: string;
  protocol: 'bob.mistral-pcm.v1';
  ticketExpiresAt: string;
  maxAudioBytes: number;
  contextRevision: number;
  contextDigest: string;
}

export type RealtimeVoiceCall = RealtimeVoiceWebRtcCall | RealtimeVoiceMistralPcmCall;

export interface RealtimeVoiceContextUpdate {
  version: 1;
  revision: number;
  context: AgentContext;
}

export type RealtimeVoiceCallInput =
  | { transport?: 'webrtc'; sdp: string; sessionHandle?: string }
  | { transport: 'mistral-pcm'; context: RealtimeVoiceContextUpdate; sessionHandle?: string };

export interface RealtimeVoiceControlReference {
  turnId: string;
  /** Preuve opaque de livraison audio, générée par le mobile et liée durablement à l’artefact. */
  acknowledgementId: string;
  contextRevision: number;
  contextDigest: string;
}

/** Contrôle approuvé une seule fois par le sideband serveur, sans nonce ni identifiant provider. */
export interface RealtimeVoiceControlAcknowledgement extends RealtimeVoiceControlReference {
  kind: 'answer' | 'proposed' | 'done';
  navigate?: string;
  proposalId?: string;
  proposalExpiresAt?: string;
}

export type RealtimeVoiceSpeechMimeType =
  | 'audio/mpeg'
  | 'audio/wav';

interface RealtimeVoiceSpeechBinding {
  artifactId: string;
  turnId: string;
  sequence: number;
  contextRevision: number;
  contextDigest: string;
}

/** État monotone du feed acoustique autoritatif. Aucun de ces champs ne vient du datachannel. */
export type RealtimeVoiceSpeechFeed =
  | { status: 'none' }
  | ({ status: 'rendering' } & RealtimeVoiceSpeechBinding)
  | ({
    status: 'ready';
    audioUrl: string;
    audioSha256: string;
    mimeType: RealtimeVoiceSpeechMimeType;
    byteSize: number;
    durationMs: number;
  } & RealtimeVoiceSpeechBinding)
  | ({
    status: 'terminal';
    reason: 'cancelled' | 'failed' | 'expired' | 'delivered';
  } & RealtimeVoiceSpeechBinding);

export interface RealtimeVoiceSpeechFeedInput {
  /** `0` demande le premier segment ; les appels suivants réutilisent la dernière séquence vue. */
  afterSequence: number;
  /** Long-poll serveur borné. `0` force une lecture immédiate. */
  waitMs?: number;
}

export interface RealtimeVoiceSpeechDeliveryInput {
  deliveryId: string;
  audioSha256: string;
}

export interface RealtimeVoiceSpeechDeliveryAcknowledgement {
  controlReference?: RealtimeVoiceControlReference;
}

export type RealtimeVoiceSpeechCancellationReason =
  | 'barge_in'
  | 'user_cancel'
  | 'context_changed'
  | 'session_end'
  | 'superseded'
  | 'playback_error';

export interface RealtimeVoiceSpeechCancellationInput {
  cancellationId: string;
  reason: RealtimeVoiceSpeechCancellationReason;
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

// ——— Réception e-facture (C-EXP6b) — DTO serveur constaté (ExpensesController) ———

/** Contrôles bloquants du poste de réception, dans l'ordre où ils ont été passés. */
export type FacturXImportControl = 'destinataire' | 'coherence_en16931' | 'doublon';

/** POST /expenses/import-facturx : contrôles + brouillon expert — RIEN n'est enregistré. */
export interface FacturXImportReview {
  draft: FacturXExpenseDraft;
  controls: FacturXImportControl[];
}

/** La DÉCISION appartient à l'appelant (humain ou Bob — jamais implicite) : approbation
 *  (catégorie confirmable) ou refus AFNOR 210/213 avec motif OBLIGATOIRE. */
export type FacturXImportDecision =
  | { action: 'approve'; category?: ExpenseCategory }
  | { action: 'refuse'; afnorStatus: AfnorInboundRefusalStatus; reason: string };

export type FacturXImportOutcome =
  | { status: 'approved'; expenseId: string; xmlDocumentId: string | null }
  | { status: 'refused'; afnorStatus: AfnorInboundRefusalStatus; reason: string; invoiceKey: string };

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
 * POST /ai/ask — sous-ensemble sérialisable d'AskOptions.
 * Le callback UI `onPhase` reste volontairement hors transport ; ajouter une option agentique
 * ne l'expose donc pas implicitement sur le réseau.
 */
export type AskBobClientInput = Readonly<{ message: string }> &
  Pick<AskOptions, 'autonomy' | 'history' | 'tone' | 'context'>;

/** POST /customers — DTO serveur constaté (CustomersController) : CustomerProps sans id/companyId. */
export type CreateCustomerClientInput = Omit<CustomerProps, 'id' | 'companyId'>;

/** Envoi RÉEL d'une relance ciblée (C25 ② — endpoint POST /invoices/:id/relance, DTO serveur
 * constaté : { jobId, status, tone }). Le serveur choisit le ton via le plan @bob/core
 * (deriveRelancePlan ; automatique déduplié par palier, manuel par jour) et livre email + miroir
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

/** Aperçu serveur non paginé qui fige la portée d'un « tout marquer comme lu ». */
export interface NotificationUnreadPreview {
  unreadCount: number;
  throughCreatedAt: string;
}

export interface NotificationReadThroughInput {
  /** Valeur opaque temporelle renvoyée par previewUnreadNotifications, à rejouer sans la modifier. */
  throughCreatedAt: string;
}

export interface NotificationReadThroughOutput {
  updatedCount: number;
  readAt: string;
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

/** Vue du digest de valeur hebdo — GET /engagement/digest/latest (pilier 2). */
export interface ValueDigestView {
  digest: ValueDigest | null;
  periodStart: string;
  periodEnd: string;
  isoWeek: string;
}

/**
 * Bilan de fin d'essai — GET /engagement/trial-report (pilier 2). Les MÊMES agrégats que le
 * digest hebdo (buildValueDigest serveur), CUMULÉS sur la période d'essai. trial null = le
 * tenant n'a pas d'essai (early-access, pré-migration) — la carte mobile ne se rend pas.
 */
export interface TrialReportView {
  digest: ValueDigest | null;
  periodStart: string | null;
  periodEnd: string | null;
  trial: {
    plan: PlanTier;
    endsAt: string;
    phase: 'active' | 'ending_soon' | 'expired';
    daysLeft: number;
  } | null;
}

export interface SubscriptionView extends SubscriptionInfo {
  /** Accès anticipé RÉEL : aucun billing n'existe — l'écran Compte affiche l'état early-access honnête. */
  earlyAccess: boolean;
  /** Prix réellement facturé au tenant (centimes/mois) — 0 pendant l'accès anticipé. */
  priceCents: number;
  /** Essai inversé (pilier 2) — présents quand le serveur est DB-backed ; absents = pas d'essai. */
  trialEndsAt?: string | null;
  trialPhase?: 'active' | 'ending_soon' | 'expired' | null;
  trialDaysLeft?: number | null;
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
  /** Digest de valeur de la semaine écoulée (pilier 2) — calculé SERVEUR, null = sans substance. */
  latestValueDigest(): Promise<Result<ValueDigestView, AppError>>;
  /** Bilan de fin d'essai (pilier 2) : agrégats du digest CUMULÉS sur l'essai — trial null = pas d'essai.
   * OPTIONNELLE (précédent getCompanyMe) : les fakes/transports existants restent assignables. */
  trialReport?(): Promise<Result<TrialReportView, AppError>>;
  /** value_digest_opened (pilier 2) : l'utilisateur a OUVERT le détail du digest (tap carte).
   * Fire-and-forget côté écran — une analytics perdue ne casse jamais un geste. OPTIONNELLE. */
  recordValueDigestOpened?(
    highlightKind: 'money' | 'time' | 'volume',
  ): Promise<Result<{ recorded: boolean }, AppError>>;
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
  /** GET /company/me (PONT-SERVEUR v1) : la fiche société RÉELLE du tenant (CompanyProps complet)
   * — l'identité en mode connecté (useIdentity) lit ENFIN la raison sociale/ligne légale de la BDD
   * au lieu de masquer la ligne (TODO tracé apps/mobile/src/data/identity.ts depuis C24).
   * OPTIONNELLE le temps d'une session : LocalBobClient est en WIP session B — TODO(session B) :
   * implémenter getCompanyMe() dans LocalBobClient (renvoyer la company du seed, `seedCompany().toProps()`),
   * puis rendre la méthode obligatoire ici. Les écrans traitent l'absence comme « pas encore
   * disponible », jamais un nom inventé. */
  getCompanyMe?(): Promise<Result<CompanyProps, AppError>>;
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
  realtimeVoiceConfig(): Promise<Result<RealtimeVoiceConfig, AppError>>;
  createRealtimeVoiceCall(
    input: RealtimeVoiceCallInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceCall, AppError>>;
  hangupRealtimeVoiceCall(
    sessionHandle: string,
    signal?: AbortSignal,
  ): Promise<Result<{ ended: true }, AppError>>;
  /** Publie un snapshot écran monotone, lié au handle opaque courant et revalidé côté serveur. */
  updateRealtimeVoiceContext(
    sessionHandle: string,
    input: RealtimeVoiceContextUpdate,
    signal?: AbortSignal,
  ): Promise<Result<{ revision: number; contextDigest: string }, AppError>>;
  acknowledgeRealtimeVoiceControl(
    sessionHandle: string,
    input: RealtimeVoiceControlReference,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceControlAcknowledgement, AppError>>;
  /** Feed acoustique durable ; les statuts HTTP 204/410 deviennent des états métier explicites. */
  getNextRealtimeVoiceSpeech(
    sessionHandle: string,
    input: RealtimeVoiceSpeechFeedInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceSpeechFeed, AppError>>;
  acknowledgeRealtimeVoiceSpeechDelivery(
    sessionHandle: string,
    turnId: string,
    artifactId: string,
    input: RealtimeVoiceSpeechDeliveryInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceSpeechDeliveryAcknowledgement, AppError>>;
  cancelRealtimeVoiceSpeech(
    sessionHandle: string,
    turnId: string,
    artifactId: string,
    input: RealtimeVoiceSpeechCancellationInput,
    signal?: AbortSignal,
  ): Promise<Result<void, AppError>>;
  listDocuments(input?: ListDocumentsClientInput): Promise<Result<DocumentView[], AppError>>;
  getDocument(documentId: string): Promise<Result<DocumentView, AppError>>;
  uploadDocument(input: UploadDocumentClientInput): Promise<Result<DocumentView, AppError>>;
  /** Archive l'original avant toute analyse ; idempotent sur `idempotencyKey`. */
  createDocumentIntake(input: CreateDocumentIntakeClientInput): Promise<Result<DocumentView, AppError>>;
  listDocumentFolders(input?: ListDocumentFoldersClientInput): Promise<Result<DocumentFolderPageView, AppError>>;
  getDocumentFolder(folderId: string): Promise<Result<DocumentFolderView, AppError>>;
  createDocumentFolder(input: { name: string; parentId?: string | null }): Promise<Result<DocumentFolderView, AppError>>;
  updateDocumentFolder(input: {
    folderId: string;
    expectedRevision: number;
    name?: string;
    parentId?: string | null;
  }): Promise<Result<DocumentFolderView, AppError>>;
  previewDocumentFolderDeletion(folderId: string): Promise<Result<DocumentFolderDeletionPlanView, AppError>>;
  executeDocumentFolderDeletion(input: {
    planId: string;
    strategy: DeleteDocumentFolderStrategy;
  }): Promise<Result<DocumentFolderDeletionExecutionView, AppError>>;
  moveDocumentToFolder(input: {
    documentId: string;
    folderId: string | null;
    expectedRevision: number;
  }): Promise<Result<{ documentId: string; folderId: string | null; revision: number }, AppError>>;
  analyzeDocument(documentId: string): Promise<Result<DocumentAnalysis, AppError>>;
  documentDownloadUrl(documentId: string, ttlSeconds?: number): Promise<Result<DocumentDownloadUrl, AppError>>;
  /** Confirme le classement proposé après OCR (A1-C14) — même use case pour l'UI et Bob. */
  classifyDocument(input: ClassifyDocumentClientInput): Promise<Result<DocumentView, AppError>>;
  /**
   * Confirme en une seule commande la dépense OCR, son écriture et le rattachement de l'original.
   * Un retry après réponse perdue restitue le même état sans créer de doublon.
   */
  recordDocumentExpense(
    input: RecordDocumentExpenseClientInput,
  ): Promise<Result<RecordDocumentExpenseClientOutput, AppError>>;
  extractDocument(input: { contentBase64: string; mimeType: string }): Promise<Result<OcrExtraction, AppError>>;
  suggestExpenseDefaults(input: SuggestExpenseDefaultsInput): Promise<Result<ExpenseDefaultsView, AppError>>;
  recordExpense(input: Omit<RecordExpenseInput, 'companyId'>): Promise<Result<{ id: string }, AppError>>;
  /** C-EXP6b ① — POST /expenses/import-facturx : CONTRÔLE DE RÉCEPTION d'une e-facture
   * (destinataire = mon SIREN, cohérence EN 16931 rejouée, doublon exact) + brouillon expert
   * (multi-taux au centime, autoliquidation NON déductible, BT-9 → dueAt, mémoire fournisseur).
   * API en DEUX temps (review puis confirm) plutôt qu'une méthode unique : la DÉCISION reste
   * un geste EXPLICITE de l'appelant après lecture des contrôles — jamais un import qui décide
   * tout seul — et le serveur reste SANS ÉTAT (le XML est resoumis à la confirmation, les
   * contrôles y sont rejoués : pas de brouillon caché, doublon re-vérifié au moment T). */
  importFacturXExpense(input: { xml: string }): Promise<Result<FacturXImportReview, AppError>>;
  /** C-EXP6b ② — POST /expenses/import-facturx/confirm : la décision AFNOR. `approve` →
   * RecordExpense (écritures 6xx/44566/401 automatiques, zéro 44566 en autoliquidation) + XML
   * archivé au coffre lié à l'Expense ; `refuse` → motif OBLIGATOIRE (210 refusée / 213 rejetée),
   * accepté MÊME sur une pièce qui échoue aux contrôles (c'est précisément le geste attendu). */
  confirmFacturXExpense(input: { xml: string; decision: FacturXImportDecision }): Promise<Result<FacturXImportOutcome, AppError>>;
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
  /** Recharge une proposition opaque pour afficher son diff. Le serveur vérifie tenant,
   * propriétaire et expiration ; le payload reste non autoritatif pour la confirmation. */
  previewBobProposal(proposalId: string): Promise<Result<PendingAction, AppError>>;
  /** POST /ai/confirm : exécute l'action proposée (PendingAction) via le runtime JOURNALISÉ. */
  confirmBob(pending: PendingAction): Promise<Result<AgentRun, AppError>>;
  /** GET /ai/runs/:runId/journal : entrées d'audit append-only d'un run (company-scoped côté serveur).
   * NB : les DTO AgentRun de ask/confirm n'exposent pas (encore) le runId — voir rapport C40. */
  getRunJournal(runId: string): Promise<Result<JournalEntry[], AppError>>;
  getCashflow(input: { scenario: Scenario; horizon: Horizon }): Promise<Result<CashflowProjection, AppError>>;
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>): Promise<Result<CreateQuoteOutput, AppError>>;
  sendQuote(quoteId: string): Promise<Result<SendQuoteOutput, AppError>>;
  /** P0 R4 : prépare/rotate le lien de signature SANS AUCUN effet sortant (jamais d'e-mail). */
  createQuoteSignatureLink(quoteId: string): Promise<Result<CreateQuoteSignatureLinkOutput, AppError>>;
  /** R4 : `proofDataUrl` = tracé du pad (dataURL) — le SERVEUR calcule le SHA-256 de preuve ;
   * le dataURL n'est jamais persisté tel quel. Absent = signature sans capture (preuve absente,
   * jamais fabriquée). */
  signQuote(input: { quoteId: string; signerName: string; proofDataUrl?: string }): Promise<Result<{ status: string }, AppError>>;
  refuseQuote(quoteId: string): Promise<Result<{ status: string }, AppError>>;
  generateInvoice(input: { quoteId: string; mode: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>>;
  /** R6 : édition d'une ligne de devis BROUILLON (PATCH /quotes/:id/lines/:lineId) — draft only,
   * un devis signé est un contrat (l'agrégat garde assertDraft). */
  updateQuoteLine(input: UpdateQuoteLineInput): Promise<Result<{ status: string }, AppError>>;
  /** R6 : suppression d'une ligne de devis BROUILLON (DELETE /quotes/:id/lines/:lineId). */
  removeQuoteLine(input: RemoveQuoteLineInput): Promise<Result<{ status: string }, AppError>>;
  /** A6 : avoir TOTAL (brouillon) d'une facture émise — même use case pour l'UI et Bob. */
  createCreditNote(input: { invoiceId: string }): Promise<Result<{ creditNoteId: string }, AppError>>;
  issueInvoice(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>>;
  /** R6 : suppression définitive d'une facture BROUILLON (DELETE /invoices/:id/draft) — erreur
   * détectée après génération depuis un devis ; garde stricte status==='draft'. */
  deleteDraftInvoice(invoiceId: string): Promise<Result<{ deleted: true }, AppError>>;
  /** C25 ② : envoi RÉEL d'une relance ciblée — POST /invoices/:id/relance (ton du plan @bob/core,
   * confirmation côté UI/agent avant l'appel : action sortante vers un tiers). */
  sendRelance(invoiceId: string): Promise<Result<SendRelanceClientOutput, AppError>>;
  // —— Fil de notifications + push (C25) — endpoints /notifications et /devices ——
  /** GET /notifications : le fil du tenant (serveur = source de vérité ; Local = dérivé démo). */
  listNotifications(): Promise<Result<NotificationView[], AppError>>;
  /** POST /notifications/:id/read : marque lue (idempotent, persisté côté serveur). */
  markNotificationRead(id: string): Promise<Result<NotificationView, AppError>>;
  /** GET /notifications/unread-preview : nombre non paginé + cutoff serveur. */
  previewUnreadNotifications(): Promise<Result<NotificationUnreadPreview, AppError>>;
  /** POST /notifications/read-through : marque atomiquement la portée figée par l'aperçu. */
  markNotificationsReadThrough(
    input: NotificationReadThroughInput,
  ): Promise<Result<NotificationReadThroughOutput, AppError>>;
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
