import type {
  AgentContext,
  AgentRun,
  AskOptions,
  JournalEntry,
  MistralConversationSessionEndReason,
  PendingAction,
} from '@bob/ai';
import type {
  ValueDigest,
  Result,
  AppError,
  CreateQuoteInput,
  CreateQuoteOutput,
  DuplicateQuoteOutput,
  EquipmentHistoryEntry,
  EquipmentPatch,
  EquipmentProps,
  RetireEquipmentOutput,
  MaintenanceContractProps,
  MaintenanceContractPatch,
  ContractLineInput,
  ContractPeriod,
  ContractLifecycleFacts,
  AnnualBillingDue,
  RenewalAlert,
  PrepareAnnualInvoiceDraftOutput,
  UpdateInvoiceServicePeriodOutput,
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
  DiagnosticAssessmentView,
  DiagnosticAssessmentWriteRequest,
  FiscalDeadline,
  OcrExtraction,
  ExpenseProps,
  ExpenseCategory,
  RecordExpenseInput,
  ExpensePaymentEvidenceInput,
  FacturXExpenseDraft,
  AfnorInboundRefusalStatus,
  TradeConfig,
  Trade,
  VatRegime,
  ChantierListItem,
  ChantierNoteProps,
  WorksiteMediaItem,
  CreateChantierInput,
  CompanyProps,
  CompanyRegistrationInput,
  CompanyBillingSettings,
  CompanyBillingSettingsPatch,
  CustomerPortfolio,
  CompanyLookupResult,
  VatCheckResult,
  AddressSuggestion,
  DateOnly,
  DocumentKind,
  DocumentLinkedEntityType,
  DocumentView,
  DocumentDownloadUrl,
  DocumentFolderView,
  DeleteDocumentFolderStrategy,
  DocumentAnalysis,
  DocumentAnalysisType,
  DocumentDestinationSuggestion,
  SubscriptionInfo,
  FiscalProfileView,
  SearchSalesDocumentsInput,
  SearchSalesDocumentsResult,
  SuggestSalesDocumentsInput,
  SuggestSalesDocumentsResult,
  CatalogueItemView,
  CatalogueItemWriteInput,
  CatalogueDeletionView,
  QualifiedBankBalanceWithPosition,
  QuoteDraftPayloadV1,
  QuoteAgentMissionResumeView,
  QuoteAgentMissionResumeViewV2,
  PurchaseOrderRef,
  PurchaseOrderRefInput,
  PurchaseOrderMutationView,
  CreditNoteSourceSnapshot,
  Discount,
  LineInput,
  SituationAmountInput,
  InvoiceTransmissionStatus,
  TransmissionGuide,
  CustomerContactConfirmationStatus,
  CustomerContactPhase,
  CustomerContactSensitiveField,
  JarvisAdmissionKind,
  JarvisRunStatus,
  RealtimeVoiceClientTerminationDiagnostic as CoreRealtimeVoiceClientTerminationDiagnostic,
} from '@bob/core';
import type {
  RealtimeAgentMissionProtocolVersion,
  RealtimeAgentMissionSession,
} from './agent-mission-session';

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
  /** B8 : bon de commande client (numéro d'engagement grands comptes) — null si aucun.
   *  Optionnel (compat ascendante des producteurs existants) ; le codec HTTP le normalise
   *  TOUJOURS (absent ⇒ null), le client local le fournit depuis l'agrégat. */
  purchaseOrder?: PurchaseOrderRef | null;
  /** Révision optimiste des mutations de bon de commande — absent ⇒ 1 (normalisé par le codec). */
  revision?: number;
  /** Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°) : intervention urgente sollicitée
   *  par le client B2C, posée à la CRÉATION du devis. Optionnel (compat serveurs antérieurs) :
   *  absent ⇒ traité comme null par les écrans — jamais une urgence inventée. */
  urgentRepair?: { requestedAt: string } | null;
  /** PR-05 — date d'établissement RÉELLE (DateOnly), ancre des relances devis J+15/J+30.
   *  Nullable ET optionnelle (fail-closed) : absente (serveur antérieur) ou null (devis legacy
   *  sans date) ⇒ jamais relancé. */
  issuedAt?: string | null;
  /** PR-08 — site/chantier de rattachement de la pièce. Nullable ET optionnel (fail-closed) :
   *  absent (serveur antérieur) ⇒ jamais compté sur un site ; null = pièce hors site. */
  chantierId?: string | null;
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
  /** B8 : bon de commande (repris du devis à la dérivation, figé à l'émission) — null si aucun.
   *  Même doctrine défensive que QuoteView.purchaseOrder (absent ⇒ null via codec). */
  purchaseOrder?: PurchaseOrderRef | null;
  /** Révision optimiste des mutations de bon de commande — absent ⇒ 1 (normalisé par le codec). */
  revision?: number;
  /** E3 : identité FIGÉE de la facture annulée par cet AVOIR (CreditNoteSourceSnapshot du
   *  domaine) — nav croisée inverse avoir → facture d'origine. Optionnel (compat ascendante des
   *  serveurs antérieurs) ; le codec HTTP normalise TOUJOURS (absent ⇒ null, présent difforme ⇒
   *  échec fermé), le client local le fournit depuis l'agrégat. Null = pièce ordinaire. */
  creditNoteSource?: CreditNoteSourceSnapshot | null;
  /** B2 : n° d'ordre de la situation sur son devis — absent ⇒ null (codec), null hors situation. */
  situationOrder?: number | null;
  /** B2 : part de la déduction de la finale provenant des situations émises — absent ⇒ 0. */
  situationDeductionCents?: number;
  /** B3 : remise globale de la pièce — absent ⇒ null (codec défensif, jamais inventée). */
  globalDiscount?: Discount | null;
  /** B5 : taux de retenue de garantie (loi 71-584) — absent ⇒ null. */
  retenueGarantiePct?: number | null;
  /** B1/A3bis : intervention urgente tracée à la composition (facture directe B2C) — absent ⇒ null. */
  urgentRepair?: { requestedAt: string } | null;
  /** Suivi MANUEL de transmission (canal de facturation) — absent ⇒ null. */
  transmission?: InvoiceTransmissionStatus | null;
  /** Guide de transmission dérivé du canal du client — UNIQUEMENT sur GET /invoices/:id d'une
   *  pièce émise (absent des listes) ; absent difforme ⇒ retiré (jamais un guide corrompu). */
  transmissionGuide?: TransmissionGuide;
  /** PR-02 — livraison EMAIL constatée par l'outbox serveur (premier job `invoice-delivery`
   *  réussi). Instant ISO = partie ; null = aucune livraison constatée ; ABSENT = information
   *  non transportée (serveur antérieur) — fail-closed : jamais « pas envoyée » affirmé. */
  emailDeliveredAt?: string | null;
  /** PR-08 — site/chantier de rattachement de la pièce. Nullable ET optionnel (fail-closed) :
   *  absent (serveur antérieur) ⇒ jamais compté sur un site ; null = pièce hors site. */
  chantierId?: string | null;
  /** PR-12b — contrat de maintenance facturé (brouillon annuel). Nullable ET optionnel
   *  (fail-closed) : absent ⇒ jamais compté comme pièce de contrat ; null = hors contrat. */
  maintenanceContractId?: string | null;
  /** PR-12b/A7 — période de service portée par la pièce (bornes humaines, fin inclusive) —
   *  AUTORITÉ de la garde d'émission d'une facture de contrat. Absent ⇒ non renseignée. */
  servicePeriod?: { start: string; end: string | null } | null;
}

/** PR-09 — contact multiple d'un client (miroir de CustomerContactProps @bob/core). */
export interface CustomerContactView {
  id: string;
  companyId: string;
  customerId: string;
  /** Rôle LIBRE (« Compta », « Valideur BC »…) — jamais une taxonomie codée. */
  label: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  revision?: number;
}

/** PR-09 — corps d'écriture d'un contact (création ET édition : remplacement complet). */
export interface CustomerContactWriteInput {
  label: string;
  name: string;
  email?: string | null;
  phone?: string | null;
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

/** Preuve d'un règlement fournisseur déjà réalisé hors de Bob. */
export interface RecordExpensePaymentClientInput extends ExpensePaymentEvidenceInput {
  readonly expenseId: string;
}

export interface RecordExpensePaymentClientOutput {
  readonly status: 'paid';
  readonly alreadyRecorded: boolean;
  readonly paymentEntryId: string;
}

/** Régularisation d'une dépense HISTORIQUE payée sans preuve (même preuve explicite qu'un règlement). */
export interface RegularizeExpensePaymentClientInput extends ExpensePaymentEvidenceInput {
  readonly expenseId: string;
}

export interface RegularizeExpensePaymentClientOutput {
  readonly status: 'paid';
  readonly alreadyRegularized: boolean;
  readonly paymentEntryId: string;
}

// ——— B8 : bon de commande grands comptes (numéro d'engagement) ———

/** PUT /quotes/:id/purchase-order — la référence complète + la révision optimiste observée. */
export interface AttachQuotePurchaseOrderClientInput {
  quoteId: string;
  purchaseOrder: PurchaseOrderRefInput;
  expectedRevision: number;
}

/** DELETE /quotes/:id/purchase-order — seule la révision optimiste voyage. */
export interface DetachQuotePurchaseOrderClientInput {
  quoteId: string;
  expectedRevision: number;
}

/** §6.5 — PUT /invoices/:id/service-period : période d'une facture de CONTRAT, brouillon
 * uniquement (figée à l'émission par la garde + le trigger SQL). Bornes HUMAINES inclusives. */
export interface UpdateInvoiceServicePeriodClientInput {
  invoiceId: string;
  expectedRevision: number;
  servicePeriod: { start: string; end: string };
}

/** PUT /invoices/:id/purchase-order — facture BROUILLON uniquement (figé à l'émission). */
export interface AttachInvoicePurchaseOrderClientInput {
  invoiceId: string;
  purchaseOrder: PurchaseOrderRefInput;
  expectedRevision: number;
}

/** DELETE /invoices/:id/purchase-order. */
export interface DetachInvoicePurchaseOrderClientInput {
  invoiceId: string;
  expectedRevision: number;
}

export type { PurchaseOrderRef, PurchaseOrderRefInput, PurchaseOrderMutationView };
export type {
  Discount,
  LineInput,
  SituationAmountInput,
  InvoiceTransmissionStatus,
  TransmissionGuide,
};

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

/**
 * Lien public de VISUALISATION (devis OU facture, sans signature) — canal d'envoi universel :
 * la pièce se partage par SMS/WhatsApp, le client la consulte et télécharge le PDF depuis son
 * téléphone, sans jamais exiger son e-mail. Même doctrine SANS AUCUN sortant que
 * CreateQuoteSignatureLinkOutput (POST :id/view-link ne fait que préparer/rotate le lien).
 */
export interface CreateDocumentViewLinkOutput {
  /** URL publique sign-web (route /view/:token) prête à partager — construite CÔTÉ SERVEUR. */
  viewUrl: string;
  expiresAt: string;
}

/** Vue réseau du slot courant : les identités tenant/propriétaire restent exclusivement serveur. */
export interface QuoteDraftSlotView {
  readonly revision: number;
  readonly payloadVersion: QuoteDraftPayloadV1['version'];
  readonly payload: QuoteDraftPayloadV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveQuoteDraftClientInput {
  readonly expectedRevision: number;
  readonly payload: QuoteDraftPayloadV1;
}

export interface ListDocumentsClientInput {
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType;
  linkedEntityId?: string;
  folderId?: string | null;
  includeDeleted?: boolean;
}

/**
 * Résumé d'analyse embarqué par GET /documents — issu du SEUL cache persistant serveur
 * (jamais d'appel LLM à la lecture). `null` = pas encore analysé pour cette version de
 * l'original ; l'écran ne re-poste plus /analysis en boucle sur la liste.
 */
export interface DocumentAnalysisSummaryView {
  type: DocumentAnalysisType;
  typeConfidence: number;
  /** Libellé professionnel (« Facture Leroy Merlin — 184,90 € »), jamais vide. */
  suggestedDisplayName: string;
  /** Destination validée côté serveur (chantier réel OU dossier système) — null : décision humaine. */
  suggestedDestination: DocumentDestinationSuggestion | null;
  requiresHumanReview: boolean;
  /** Résumé de Bob (carte du scan) — null : serveur antérieur au champ (compat ascendante). */
  summary: string | null;
  /** Chips #tags de la carte — [] : absent du payload (compat ascendante), jamais inventées. */
  suggestedTags: readonly string[];
  /** Avertissements qui justifient `requiresHumanReview` — [] : absent du payload. */
  warnings: readonly string[];
}

/** Chips Montant/TVA/Date de l'écran Documents, projetées depuis les faits PROUVÉS de l'analyse. */
export interface DocumentExtractionSummaryView {
  supplierName: string | null;
  totalTtcCents: number;
  vatCents: number | null;
  documentDate: DateOnly | null;
}

/** Item de GET /documents : la vue document + les résumés persistés (structurellement assignable à VaultDocumentData @bob/core). */
export type DocumentListItemView = DocumentView & {
  analysis: DocumentAnalysisSummaryView | null;
  extraction: DocumentExtractionSummaryView | null;
};

export interface RenameDocumentClientInput {
  documentId: string;
  /** Nouveau libellé d'affichage — le filename d'archive reste immuable. */
  displayName: string;
  expectedRevision: number;
}

/** POST /documents/:id/acknowledge — « c'est bon, je valide » : seule la révision optimiste
 * voyage ; reviewedAt est posé par le serveur (latch — la première validation fait foi). */
export interface AcknowledgeDocumentClientInput {
  documentId: string;
  expectedRevision: number;
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
 * sous le contrôle du serveur. `payment` (ticket déjà réglé) se limite à date + moyen :
 * la preuve du règlement est l'original scanné lui-même, imposée côté serveur.
 */
export type DocumentExpenseDraft = Omit<
  RecordExpenseInput,
  'companyId' | 'idempotencyKey' | 'source' | 'payment'
> & {
  payment?: { paidOn: string; method: PaymentMethod } | null;
};

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

/** PUT /expenses/:id/chantier — imputation chantier d'une dépense (rentabilité par chantier).
 * `chantierId` string = imputer ; null EXPLICITE = délier (geste légitime, même route).
 * Le serveur PROUVE le chantier dans le tenant avant toute écriture (anti-IDOR fail-closed). */
export interface AssignExpenseChantierClientInput {
  expenseId: string;
  chantierId: string | null;
}

export interface AssignExpenseChantierClientOutput {
  /** Imputation effective après la commande (null = dépense hors chantier). */
  chantierId: string | null;
  /** false = la commande n'a rien changé (retry / imputation déjà en place) — aucune écriture. */
  changed: boolean;
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

/** Transparence du journal de qualité staging. Strictement absent hors sujet autorisé. */
export interface RealtimeVoiceDiagnosticTraceDisclosure {
  readonly enabled: true;
  readonly retentionDays: 30;
  readonly purpose: 'staging_quality';
}

interface RealtimeVoiceConfigCommon {
  available: boolean;
  availabilityReason?: 'disabled' | 'not_entitled' | 'entitlement_unavailable';
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  requiresDevelopmentBuild: true;
  maxSessionSeconds: number;
  diagnosticTrace?: RealtimeVoiceDiagnosticTraceDisclosure;
}

export interface RealtimeVoiceNativeWebRtcConfig extends RealtimeVoiceConfigCommon {
  transport: 'webrtc';
  speechDelivery: 'openai-native-webrtc-v1';
}

export interface RealtimeVoiceAuditedWebRtcConfig extends RealtimeVoiceConfigCommon {
  transport: 'webrtc';
  speechDelivery: 'audited-signed-url-v1';
}

export interface RealtimeVoiceMistralConfig extends RealtimeVoiceConfigCommon {
  transport: 'mistral-pcm';
  speechDelivery: 'audited-signed-url-v1';
  /**
   * Contrat PCM annoncé par le serveur. Absent pour compatibilité avec un serveur Mistral
   * antérieur à la négociation v2 ; le mobile traite alors Mistral en v1.
   */
  protocol?: 'bob.mistral-pcm.v1' | 'bob.mistral-pcm.v2';
}

export type RealtimeVoiceConfig =
  RealtimeVoiceNativeWebRtcConfig | RealtimeVoiceAuditedWebRtcConfig | RealtimeVoiceMistralConfig;

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
  diagnosticTrace?: RealtimeVoiceDiagnosticTraceDisclosure;
  /**
   * Capability volatile liée à cette session Realtime.
   *
   * - propriété absente : client historique, négociation omise ;
   * - `null` : V1 demandée mais fermée par le flag serveur ;
   * - handle opaque : V1 acceptée, secret inaccessible et non sérialisable.
   */
  agentMissionSession?: RealtimeAgentMissionSession | null;
}

interface RealtimeVoiceAuditedCallCommon extends RealtimeVoiceCallCommon {
  speechDelivery: 'audited-signed-url-v1';
  speechSourcePolicy: RealtimeVoiceSpeechSourcePolicy;
}

export interface RealtimeVoiceNativeWebRtcCall extends RealtimeVoiceCallCommon {
  transport: 'webrtc';
  speechDelivery: 'openai-native-webrtc-v1';
  answerSdp: string;
}

export interface RealtimeVoiceAuditedWebRtcCall extends RealtimeVoiceAuditedCallCommon {
  transport: 'webrtc';
  answerSdp: string;
}

export type RealtimeVoiceWebRtcCall =
  RealtimeVoiceNativeWebRtcCall | RealtimeVoiceAuditedWebRtcCall;

export interface RealtimeVoiceMistralPcmCall extends RealtimeVoiceAuditedCallCommon {
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

export interface RealtimeVoiceMistralConversationCall extends RealtimeVoiceAuditedCallCommon {
  transport: 'mistral-pcm';
  websocketUrl: string;
  companyId: string;
  ticket: string;
  protocol: 'bob.mistral-pcm.v2';
  ticketExpiresAt: string;
  maxMissionAudioBytes: number;
  contextRevision: number;
  contextDigest: string;
  routeMode: 'push_to_talk';
  fullDuplexCertified: false;
}

export type RealtimeVoiceCall =
  RealtimeVoiceWebRtcCall | RealtimeVoiceMistralPcmCall | RealtimeVoiceMistralConversationCall;

/** Preuve locale minimale permettant de reprendre une mission Mistral v2 sans nouvelle admission. */
export interface RealtimeVoiceResumeTicketInput {
  /** Dernier epoch de connexion effectivement appliqué par le mobile. */
  readonly missionConnectionEpoch: number;
  /** Première séquence serveur dont les effets ne sont pas encore appliqués localement. */
  readonly nextServerSequence: number;
}

export interface RealtimeVoiceIssuedResumeTicket {
  readonly status: 'issued';
  readonly websocketUrl: string;
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly ticket: string;
  readonly protocol: 'bob.mistral-pcm.v2';
  readonly scope: 'terminal_replay';
  readonly ticketExpiresAt: string;
  readonly expectedMissionConnectionEpoch: number;
  readonly clientAcceptedMissionConnectionEpoch: number;
  readonly resumeNextServerSequence: number;
}

/** Preuve serveur complète qu'une mission Mistral v2 est définitivement terminée. */
export interface RealtimeVoiceTerminalCompleteReceipt {
  readonly status: 'terminal_complete';
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly protocol: 'bob.mistral-pcm.v2';
  readonly missionConnectionEpoch: number;
  readonly nextServerSequence: number;
  readonly reason: MistralConversationSessionEndReason;
  readonly closedAt: string;
}

export type RealtimeVoiceResumeTicketResult =
  RealtimeVoiceIssuedResumeTicket | RealtimeVoiceTerminalCompleteReceipt;

/** Capacité initiale gardée uniquement en mémoire jusqu'à `session.ready`. */
export interface RealtimeVoiceBootstrapReconciliationInput {
  readonly protocol: 'bob.mistral-pcm.v2';
  readonly bootstrapTicket: string;
  /** Tentative monotone : une capability consommée impose la tentative suivante. */
  readonly attempt: number;
}

export interface RealtimeVoiceIssuedBootstrapReconciliation {
  readonly status: 'issued';
  readonly websocketUrl: string;
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly ticket: string;
  readonly protocol: 'bob.mistral-pcm.v2';
  readonly scope: 'live_takeover' | 'terminal_replay';
  readonly ticketExpiresAt: string;
  readonly expectedMissionConnectionEpoch: number;
  readonly clientAcceptedMissionConnectionEpoch: 0;
  readonly resumeNextServerSequence: 0;
}

export type RealtimeVoiceBootstrapReconciliationResult =
  | RealtimeVoiceIssuedBootstrapReconciliation
  | { readonly status: 'retry_initial' }
  | { readonly status: 'attempt_consumed' };

export interface RealtimeVoiceContextUpdate {
  version: 1;
  revision: number;
  context: AgentContext;
}

/** Contrat redacted transporté avec le hangup ; la source canonique vit dans @bob/core. */
export type RealtimeVoiceClientTerminationDiagnostic = CoreRealtimeVoiceClientTerminationDiagnostic;

export type RealtimeVoiceCallInput = (
  | {
      transport?: 'webrtc';
      sdp: string;
      configVersion: string;
      speechDelivery: 'openai-native-webrtc-v1' | 'audited-signed-url-v1';
      sessionHandle?: string;
      agentMissionProtocolVersion?: RealtimeAgentMissionProtocolVersion | null;
    }
  | {
      transport: 'mistral-pcm';
      protocol?: 'bob.mistral-pcm.v1';
      context: RealtimeVoiceContextUpdate;
      configVersion: string;
      speechDelivery: 'audited-signed-url-v1';
      sessionHandle?: string;
      agentMissionProtocolVersion?: RealtimeAgentMissionProtocolVersion | null;
    }
  | {
      transport: 'mistral-pcm';
      protocol: 'bob.mistral-pcm.v2';
      context: RealtimeVoiceContextUpdate;
      configVersion: string;
      speechDelivery: 'audited-signed-url-v1';
      sessionHandle?: string;
      agentMissionProtocolVersion?: RealtimeAgentMissionProtocolVersion | null;
    }
) & {
  /**
   * Propriétaire unique de la compensation après création du handle. `client` reste le défaut
   * rétrocompatible ; `transport` n'est valide que si l'appelant connaît le sessionHandle et
   * garantit son propre hangup idempotent sur chaque sortie du bootstrap.
   */
  readonly bootstrapTerminationOwner?: 'client' | 'transport';
};

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

export type RealtimeVoiceSpeechMimeType = 'audio/mpeg' | 'audio/wav';

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

export type RealtimeVoiceNativeSpeechPendingBargeInSlo =
  | { readonly status: 'complete'; readonly durationsMs: readonly number[] }
  | { readonly status: 'overflowed' };

/** Mesures transport locales bornées ; elles ne contiennent ni texte ni identifiant provider. */
export interface RealtimeVoiceNativeSpeechSlo {
  readonly speechStoppedEventToFirstInboundRtpMs: number;
  readonly pendingBargeIn?: RealtimeVoiceNativeSpeechPendingBargeInSlo;
}

/**
 * Observation disponible avec le transport WebRTC V1. Elle atteste seulement que le mobile a
 * observé du RTP distant puis le signal de drainage du fournisseur. Ce proxy n'est PAS une preuve
 * de fin de DAC, d'audibilité humaine ni de lecture acoustique complète.
 */
export interface RealtimeVoiceNativeSpeechLocalObservation {
  readonly formatVersion: 1;
  readonly kind: 'webrtc_remote_rtp_observed_provider_drained_v1';
}

export interface RealtimeVoiceNativeSpeechDeliveryInput {
  readonly acknowledgementId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly slo: RealtimeVoiceNativeSpeechSlo;
  readonly localObservation: RealtimeVoiceNativeSpeechLocalObservation;
}

/** Reçu Bob durable, sans metadata fournisseur et sans capacité de contrôle implicite. */
export interface RealtimeVoiceNativeSpeechDeliveryAcknowledgement {
  readonly deliveryId: string;
  readonly turnId: string;
  readonly acknowledgementId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly idempotent: boolean;
}

export type RealtimeVoiceSpeechCancellationReason =
  'barge_in' | 'user_cancel' | 'context_changed' | 'session_end' | 'superseded' | 'playback_error';

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

export type InvoiceAccountingPreview =
  | {
      invoiceId: string;
      available: false;
      reason: string;
    }
  | {
      invoiceId: string;
      available: true;
      entryId: string;
      reference: string;
      entryDate: string;
      label: string;
      totalDebitCents: number;
      totalCreditCents: number;
      lines: AccountingPreviewLine[];
    };

export type PaymentAccountingPreview =
  | {
      invoiceId: string;
      available: false;
      reason: string;
    }
  | {
      invoiceId: string;
      available: true;
      reference: string;
      amountCents: number;
      remainingCents: number;
      method: PaymentMethod;
      totalDebitCents: number;
      totalCreditCents: number;
      lines: AccountingPreviewLine[];
    };

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
  | {
      status: 'refused';
      afnorStatus: AfnorInboundRefusalStatus;
      reason: string;
      invoiceKey: string;
    };

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

/** POST /customers — identité/coordonnées uniquement. Les métriques sont toujours dérivées côté serveur. */
export type CreateCustomerClientInput = Omit<CustomerProps, 'id' | 'companyId'>;
export type UpdateCustomerClientInput = Omit<CustomerProps, 'id' | 'companyId'>;

/** PR-01 « Encaisser » — envoi EMAIL réel d'une facture ÉMISE (POST /invoices/:id/send).
 * `recipientEmail` absent = e-mail de la fiche client (refus actionnable si aucun). */
export interface SendInvoiceClientInput {
  invoiceId: string;
  recipientEmail?: string;
}

export interface SendInvoiceClientOutput {
  number: string;
  recipient: string;
  /** `sent` = clé déjà livrée (dédup d'un retry) ; `queued` = job durable en outbox. */
  deliveryStatus: 'queued' | 'sent';
  jobId: string;
}

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

/** POST /devices — lie atomiquement ce token au tenant/utilisateur courant. */
export interface RegisterDeviceClientInput {
  expoPushToken: string;
  platform?: 'ios' | 'android';
  installationId: string;
  bindingId: string;
  bindingGeneration: number;
  /** Secret 256-bit SecureStore transmis uniquement en body TLS ; le serveur seul le hash. */
  revocationSecret: string;
}

export interface RevokeDeviceBindingClientInput {
  installationId: string;
  /** Révoque de façon compacte toute génération serveur <= ce high-water mark. */
  throughGeneration: number;
  revocationSecret: string;
}

/** DELETE /devices — révocation idempotente avant déconnexion, sans token dans l'URL. */
export interface UnregisterDeviceClientInput {
  expoPushToken: string;
}

/**
 * Façade data consommée par l'app mobile (via TanStack Query).
 * Le runtime mobile utilise exclusivement HttpBobClient (NestJS + PostgreSQL/RLS). Les doubles
 * mémoire ne sont accessibles que depuis l'entrypoint explicite `@bob/api-client/testing`.
 * L'UI ne connaît que cette interface, mais une release ne peut pas substituer sa source de vérité.
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

export interface SubscriptionBillingInvoiceView {
  stripeInvoiceId: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  currency: 'eur';
  number: string | null;
  totalCents: number;
  issuedAt: string;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

/** PR-11 — création d'équipement côté client (le site est porté par la route). */
export interface CreateEquipmentClientInput {
  label: string;
  kind?: string | null;
  brand?: string | null;
  serialNumber?: string | null;
  location?: string | null;
  installedAt?: string | null;
  warrantyUntil?: string | null;
  notes?: string | null;
}

/** PR-11 — fiche + historique DÉRIVÉ (mêmes entrées que deriveEquipmentHistory). */
export interface EquipmentHistoryView {
  equipment: EquipmentProps;
  entries: EquipmentHistoryEntry[];
}

/** PR-12b — vue contrat de maintenance servie par le serveur : agrégat + FAITS DÉRIVÉS
 * (période arithmétique, couverture par factures réelles, alerte de renouvellement). L'écran
 * CONSTATE ces faits, il ne les réinterprète jamais (écrans §3.1). */
export interface MaintenanceContractClientView {
  contract: MaintenanceContractProps;
  customerName: string | null;
  chantierNom: string | null;
  annualTotals: Totals;
  currentPeriod: ContractPeriod | null;
  currentPeriodCoveredBy: { by: 'invoice' | 'import'; number: string | null } | null;
  lifecycle: ContractLifecycleFacts;
  billingDue: AnnualBillingDue | null;
  renewalAlert: RenewalAlert | null;
}

/** PR-12b — corps de création d'un contrat (le wizard convertit la saisie INCLUSIVE de
 * « déjà facturé jusqu'au » en borne EXCLUSIVE importCoveredUntil AVANT l'appel — erratum 4). */
export interface CreateContractClientInput {
  customerId: string;
  label: string;
  chantierId?: string | null;
  anniversaryDate: string;
  noticeDays?: number;
  visitsPerYear?: number;
  tacitRenewal?: boolean;
  importCoveredUntil?: string | null;
  notes?: string | null;
  lines?: readonly ContractLineInput[];
  equipmentIds?: readonly string[];
}

export interface UpdateContractClientInput {
  expectedRevision: number;
  patch?: MaintenanceContractPatch;
  lines?: readonly ContractLineInput[];
  equipmentIds?: readonly string[];
}

/**
 * PR-16 §3.2/§4.5 — réglages de fiche de passage d'une société. `effectiveReportTitle` porte
 * TOUJOURS une identité imprimable (défaut produit « Fiche de passage » quand rien n'est posé) ;
 * `revision` vaut 0 tant qu'aucun réglage n'existe — c'est la révision à renvoyer en écriture.
 */
export interface InterventionSettingsView {
  companyId: string;
  reportTitle: string | null;
  effectiveReportTitle: string;
  checklistTemplates: Record<string, string[]>;
  revision: number;
}

/** Écriture partielle : champ absent = inchangé ; `reportTitle: null` = retour au défaut. */
export interface InterventionSettingsWriteInput {
  reportTitle?: string | null;
  checklistTemplates?: Record<string, string[]>;
  expectedRevision?: number;
}

export interface ConfirmedConversationTimeZoneView {
  readonly timeZone: string;
  readonly confirmedAt: string;
  readonly requiresSessionRefresh: true;
}

// ---------------------------------------------------------------------------
// Jarvis — callers réels du canal tactile (spec §5.2/§5.4/§7.1, lot U1-d)
// ---------------------------------------------------------------------------

/**
 * Projection wire d'un `JarvisRun` (§5.1). Le `state` durable ne porte que des digests et n'est
 * JAMAIS exposé : tout ce que l'écran montre vient de la projection serveur ci-dessous.
 */
export interface JarvisRunView {
  readonly runId: string;
  readonly kind: JarvisAdmissionKind;
  readonly definitionVersion: number;
  readonly status: JarvisRunStatus;
  readonly revision: number;
  readonly nextWakeAt: string | null;
  readonly terminalAt: string | null;
}

/**
 * Un champ proposé, déjà TRADUIT côté serveur : `label` est la formulation humaine (montrée ET
 * vocalisable, §7.0 règles 2-3), jamais du jargon reconstruit par le mobile. `before` vaut null en
 * création. `sensitiveField` marque les champs dont la mutation entre présentation et confirmation
 * INVALIDE la proposition (§9.1) — l'écran l'explique au point de décision.
 */
export interface CustomerContactPresentedFieldV1 {
  readonly field: string;
  readonly label: string;
  readonly before: string | null;
  readonly after: string;
  readonly sensitiveField: CustomerContactSensitiveField | null;
}

/**
 * Projection serveur d'un run `customer_contact@1` — recomposée depuis le payload store PII scellé
 * par `fieldsDigest`. La recomposition revérifie ce digest : au moindre écart, le serveur rend
 * `presentation: null` (fail-closed, greffe G4) et l'écran n'offre AUCUNE confirmation.
 */
export interface CustomerContactPresentationV1 {
  readonly schema: 'bob.jarvis-run.customer-contact-presentation';
  readonly version: 1;
  readonly phase: CustomerContactPhase;
  readonly intent: 'create' | 'update';
  readonly targetCustomerId: string | null;
  /** U1-f §4 — nom de la fiche visée, composé SERVEUR. `null` si introuvable ou imprésentable. */
  readonly targetLabel: string | null;
  readonly proposal: {
    readonly proposalId: string;
    readonly proposalHash: string;
    readonly fieldsDigest: string;
    readonly fields: readonly CustomerContactPresentedFieldV1[];
  } | null;
  readonly confirmation: {
    readonly confirmationId: string;
    readonly status: CustomerContactConfirmationStatus;
    readonly expiresAt: string;
    readonly presentedAt: string | null;
  } | null;
  /**
   * U1-h — la revue de doublons telle que Bob l'a ÉNONCÉE. `ordinal` est le rang prononcé, et il
   * ne se renumérote jamais : un rang dont le nom ne se résout plus garde sa place avec
   * `label: null`. Aucun `customerId` de candidat n'est transmis — `choiceId` suffit à désigner.
   */
  readonly duplicateReview: {
    readonly reviewId: string;
    readonly choices: readonly {
      readonly ordinal: number;
      readonly choiceId: string;
      readonly label: string | null;
    }[];
  } | null;
  /**
   * U1-h — comment le run s'est terminé. `existing_selected` n'affirme AUCUNE écriture : l'artisan
   * a retenu une fiche qui existait déjà, rien n'a été créé.
   */
  readonly completion:
    | { readonly kind: 'recorded' }
    | { readonly kind: 'existing_selected'; readonly label: string | null }
    | null;
}

/**
 * Sous-ensemble des commandes `customer_contact@1` qu'un HUMAIN peut émettre depuis un appareil.
 * Les `revalidated*` du `confirm` domaine sont absents À DESSEIN : l'admission relit la cible
 * elle-même juste avant de consommer la confirmation (§7.1) — un client ne revalide jamais son
 * propre geste. `occurredAt` et `canonicalInputDigest` sont également calculés serveur (G7),
 * stables par retry.
 */
export type JarvisRunCommandV1 =
  | {
      readonly type: 'record_presentation_ack';
      readonly confirmationId: string;
      readonly ack: 'screen_ack';
    }
  | { readonly type: 'confirm'; readonly confirmationId: string; readonly proposalHash: string }
  | { readonly type: 'reject_proposal'; readonly confirmationId: string }
  | { readonly type: 'cancel_run'; readonly reason: 'user_cancelled' | 'manual_handoff' }
  /**
   * U1-h — l'issue de la revue de doublons, au doigt. C'est un CHOIX STRUCTURÉ (§8 point 4) et non
   * une confirmation d'effet : ni reçu de présentation ni step-up ne sont dus. `use_existing`
   * n'écrit RIEN — il achève le run sur une fiche qui existait déjà.
   */
  | {
      readonly type: 'choose_duplicate_resolution';
      readonly reviewId: string;
      readonly decision:
        | { readonly kind: 'continue_create' }
        | { readonly kind: 'use_existing'; readonly choiceId: string };
    };

/**
 * Enveloppe utilisateur du canal tactile. Le `commandId` est un UUID v4 généré UNE fois côté
 * client avant le premier essai et conservé jusqu'au reçu (§5.4) ; l'autorité (`authenticated_
 * principal`, greffe G1) est dérivée SERVEUR du bearer — jamais transportée par le client.
 */
export interface JarvisSubmitCommandClientInput {
  readonly runId: string;
  readonly kind: JarvisAdmissionKind;
  readonly definitionVersion: number;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly command: JarvisRunCommandV1;
}

/** Reçu d'admission (§5.2) : `replayed` = même commandId, zéro écriture, le reçu original. */
export interface JarvisCommandReceiptView {
  readonly outcome: 'admitted' | 'replayed';
  readonly run: JarvisRunView;
  readonly presentation: CustomerContactPresentationV1 | null;
  readonly eventSequence: number;
}

/** Lecture stateless §5.2 : zéro verrou, zéro écriture, aucune réponse persistée. */
export interface JarvisRunSnapshotView {
  readonly run: JarvisRunView;
  readonly presentation: CustomerContactPresentationV1 | null;
}

/**
 * Découverte du run courant (lot U1-e §1) — miroir de la reprise `QuoteAgentMissionResumeView` :
 * soit il y a un run NON TERMINAL à reprendre, soit il n'y en a pas. L'union interdit l'état
 * bâtard « pas de run mais une présentation » : un écran ne peut donc pas afficher une carte
 * orpheline. Sans cette lecture, l'appareil ne connaît AUCUN `runId` (la voix ne renvoie que la
 * parole) et la carte de confirmation reste invisible.
 */
export type JarvisCurrentRunView =
  | { readonly run: null; readonly presentation: null }
  | {
      readonly run: JarvisRunView;
      readonly presentation: CustomerContactPresentationV1 | null;
    };

/**
 * Ouverture d'un run de MODIFICATION depuis l'écran (lot U1-e §1). Le client n'apporte que ce
 * qu'il possède : son `commandId` (UUID v4 §5.4, mémoïsé jusqu'au reçu — c'est lui qui rend le
 * rejeu zéro-write possible) et l'identité de la fiche visée. La RÉVISION de la cible est absente
 * PAR CONSTRUCTION : aucune projection client ne la porte, donc le client ne peut que l'inventer
 * — le serveur relit la cible lui-même (§7.1/§8). `runId`, `kind`, `actionId` et `expectedRevision`
 * sont également des faits serveur : la route est dédiée à `customer_contact@1`.
 */
export interface JarvisOpenRunClientInput {
  readonly commandId: string;
  readonly intent: {
    readonly mode: 'update';
    readonly target: { readonly customerId: string };
  };
}

export interface BobClient {
  readonly companyId: string;
  /**
   * Reprise froide JWT+RLS. Cette lecture ne crée aucune capability et ne débloque jamais une
   * mutation ; seul `mission:null` autorise le flow manuel après un redémarrage.
   */
  getCurrentQuoteAgentMissionResume(
    signal?: AbortSignal,
  ): Promise<Result<QuoteAgentMissionResumeView, AppError>>;
  /**
   * Contrat M2-A explicite. Aucun appelant publié ne l'utilise avant M2-A-3 ; l'en-tête V2
   * interdit tout rabaissement silencieux vers la reprise V1.
   */
  getCurrentQuoteAgentMissionResumeV2(
    signal?: AbortSignal,
  ): Promise<Result<QuoteAgentMissionResumeViewV2, AppError>>;
  /** GET /subscription (C26b) : abonnement réel du tenant (SubscriptionView ⊂ SubscriptionInfo @bob/core).
   * En early-access le serveur renvoie earlyAccess: true, priceCents: 0 — l'écran Compte en dérive
   * l'état honnête. */
  getSubscription(): Promise<Result<SubscriptionView, AppError>>;
  /** Factures d'abonnement réellement persistées après réconciliation d'un webhook Stripe. */
  listSubscriptionInvoices(): Promise<Result<SubscriptionBillingInvoiceView[], AppError>>;
  /** GET /fiscal-profile (BOB EXPERT FISCAL, Phase 1A) : profil fiscal du tenant — dérivé par
   *  hypothèses depuis la forme juridique si absent, chaque champ portant son statut
   *  (source_fiable/confirme_utilisateur/hypothese/manquant, @bob/core FiscalDatum). */
  getFiscalProfile(): Promise<Result<FiscalProfileView, AppError>>;
  /** PATCH /fiscal-profile/:field : confirme UN champ (statut → confirme_utilisateur). Rejette
   *  (AppError 'domain'/FISCAL_PROFILE_INCONSISTENT) si la mise à jour rend le profil incohérent. */
  updateFiscalProfileField(
    field: string,
    value: unknown,
  ): Promise<Result<FiscalProfileView, AppError>>;
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
  /**
   * DELETE /account (Apple 5.1.1(v)) — clôture DÉFINITIVE du compte courant. JAMAIS un cascade
   * delete : marque la company clôturée (accès révoqué), annule l'abonnement, révoque les liens
   * de signature publics + les push tokens, PUIS supprime le user Supabase Auth (identité
   * personnelle — email/téléphone/prénom, jamais stockée en Postgres). `confirmationText` DOIT
   * égaler exactement le nom de l'entreprise (anti-tap accidentel, revalidé serveur) — un texte
   * erroné renvoie une AppError 'validation', la company reste ouverte. AUCUNE parité vocale :
   * la destruction de compte ne s'invoque jamais par la voix.
   */
  closeAccount(input: {
    confirmationText: string;
    reason?: string;
  }): Promise<Result<{ closedAt: string }, AppError>>;
  /** Confirme la préférence conversationnelle signée ; le mobile rafraîchit ensuite son JWT. */
  confirmConversationTimeZone(
    timeZone: string,
  ): Promise<Result<ConfirmedConversationTimeZoneView, AppError>>;
  invoicePaymentLink(invoiceId: string): Promise<Result<{ url: string }, AppError>>;
  getDiagnostic(): Promise<Result<DiagnosticResult, AppError>>;
  /** Résultat terminé persistant. `never_run`/`stale` ne contiennent jamais un faux score. */
  getDiagnosticAssessment(): Promise<Result<DiagnosticAssessmentView, AppError>>;
  /** Le client n'envoie aucun score : seulement réponses + preuves de concurrence. */
  saveDiagnosticAssessment(
    input: DiagnosticAssessmentWriteRequest,
  ): Promise<Result<DiagnosticAssessmentView, AppError>>;
  /** GET /fiscal-calendar (C-EXP5b) : échéances fiscales à venir (fenêtre 90 j) dérivées de la
   * fiche société par deriveFiscalCalendar (@bob/core). fiscalYearEnd / périodicité URSSAF pas
   * encore capturés côté serveur : les échéances concernées arrivent en confidence 'assumed'
   * (hypothèse honnête à confirmer) ; amountHint toujours null en v1 (aucun montant inventé). */
  getFiscalCalendar(): Promise<Result<FiscalDeadline[], AppError>>;
  getProfile(): Promise<Result<TradeConfig, AppError>>;
  /** GET /company/me : fiche société persistée du tenant authentifié. Obligatoire pour toute
   * implémentation du client afin qu'aucun écran ne puisse interpréter une méthode absente comme
   * une société vide ou un état hors-ligne. */
  getCompanyMe(): Promise<Result<CompanyProps, AppError>>;
  updateCompanyProfile(input: {
    trade: Trade;
    vatRegime: VatRegime;
    customerPortfolio?: CustomerPortfolio;
  }): Promise<Result<CompanyProps, AppError>>;
  /** PATCH /company/billing (Réglages facturation §RIB) : iban/bic, partiel — champ omis =
   * inchangé, `null` = effacé. Seul endroit qui les écrit après l'onboarding. */
  updateCompanyBilling(input: {
    iban?: string | null;
    bic?: string | null;
  }): Promise<Result<CompanyProps, AppError>>;
  /** PATCH /company/legal (Réglages entreprise §Identité légale) : capital social en CENTIMES
   * (A6, art. R123-238 c. com. — sociétés uniquement, le domaine rejette EI/micro) et médiateur
   * de la consommation (A2, art. L612-1/L616-1 c. conso). MÊME sémantique partielle que
   * /company/billing : champ omis = inchangé, `null` = effacé explicitement.
   * Porte AUSSI les deux données qu'exige `Company.assertCanIssue()` — n° d'immatriculation
   * RCS/RM (art. R123-237 c. com.) et adresse du siège : sans elles, aucune facture ne peut
   * être émise, et c'est le SEUL endpoint qui les écrit après l'onboarding. */
  updateCompanyLegal(input: {
    capitalSocialCents?: number | null;
    mediateurConso?: { nom: string; coordonnees: string } | null;
    email?: string | null;
    phone?: string | null;
    rcsOrRm?: string | null;
    /** Numéro attribué et confirmé ; le client ne le calcule jamais depuis le SIREN. */
    tvaIntracom?: string | null;
    /** Objet COMPLET (jamais un patch par sous-champ : une adresse partielle est incohérente). */
    address?: { line1: string; zip: string; city: string };
  }): Promise<Result<CompanyProps, AppError>>;
  /** Réglages PostgreSQL du tenant. Aucune valeur de repli n'est autorisée côté client. */
  getCompanyBillingSettings(): Promise<Result<CompanyBillingSettings, AppError>>;
  updateCompanyBillingSettings(input: {
    expectedRevision: number;
    patch: CompanyBillingSettingsPatch;
  }): Promise<Result<CompanyBillingSettings, AppError>>;
  lookupCompany(siret: string): Promise<Result<CompanyLookupResult, AppError>>;
  /** POST /onboarding/company (C24b) : crée la société du compte ou répare les dépendances
   * d'un provisioning incomplet. L'id et le cycle de vie restent exclusivement serveur ; un
   * retry ne modifie jamais l'identité légale déjà persistée. */
  registerCompany(
    input: CompanyRegistrationInput,
  ): Promise<Result<{ companyId: string }, AppError>>;
  checkVat(vatNumber: string): Promise<Result<VatCheckResult, AppError>>;
  searchAddress(query: string): Promise<Result<AddressSuggestion[], AppError>>;
  transcribe(input: {
    audioBase64: string;
    mimeType: string;
  }): Promise<Result<{ text: string }, AppError>>;
  synthesizeSpeech(input: { text: string }): Promise<Result<VoiceSynthesisResult, AppError>>;
  voiceConfig(): Promise<Result<VoiceConfig, AppError>>;
  realtimeVoiceConfig(): Promise<Result<RealtimeVoiceConfig, AppError>>;
  createRealtimeVoiceCall(
    input: RealtimeVoiceCallInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceCall, AppError>>;
  /**
   * Demande une capability one-shot pour rejouer exclusivement le terminal Mistral v2.
   * `terminal_complete` est la seule preuve autorisant le mobile à supprimer son checkpoint.
   */
  requestRealtimeVoiceResumeTicket(
    sessionHandle: string,
    input: RealtimeVoiceResumeTicketInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceResumeTicketResult, AppError>>;
  /**
   * Répare uniquement un bootstrap v2 commité dont la réponse WSS a été perdue.
   * Cette méthode ne persiste jamais le ticket initial ni la capability retournée.
   */
  reconcileRealtimeVoiceBootstrap(
    sessionHandle: string,
    input: RealtimeVoiceBootstrapReconciliationInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceBootstrapReconciliationResult, AppError>>;
  hangupRealtimeVoiceCall(
    sessionHandle: string,
    signal?: AbortSignal,
    diagnostic?: RealtimeVoiceClientTerminationDiagnostic,
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
  /**
   * Acquitte une restitution OpenAI native uniquement après l'observation locale V1. Cette
   * observation reste un proxy RTP+drainage et ne doit jamais être présentée comme preuve DAC.
   */
  acknowledgeRealtimeVoiceNativeSpeechDelivery(
    sessionHandle: string,
    turnId: string,
    deliveryId: string,
    input: RealtimeVoiceNativeSpeechDeliveryInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceNativeSpeechDeliveryAcknowledgement, AppError>>;
  cancelRealtimeVoiceSpeech(
    sessionHandle: string,
    turnId: string,
    artifactId: string,
    input: RealtimeVoiceSpeechCancellationInput,
    signal?: AbortSignal,
  ): Promise<Result<void, AppError>>;
  listDocuments(
    input?: ListDocumentsClientInput,
  ): Promise<Result<DocumentListItemView[], AppError>>;
  /** GET /documents/:id — MÊME shape enrichi que la liste (analysis/extraction depuis le cache
   * persistant serveur, jamais de LLM à la lecture) ; `analysis: null` = pas encore analysé. */
  getDocument(documentId: string): Promise<Result<DocumentListItemView, AppError>>;
  /** POST /documents/:id/acknowledge — pose la confirmation humaine (reviewedAt) SANS déplacer
   * ni lier ; idempotent (latch), même use case pour l'UI et pour Bob (parité voix). */
  acknowledgeDocument(
    input: AcknowledgeDocumentClientInput,
  ): Promise<Result<DocumentView, AppError>>;
  /** PUT /documents/:id/name — renomme le libellé d'affichage (RenameDocument @bob/core, parité humain↔Bob). */
  renameDocument(input: RenameDocumentClientInput): Promise<Result<DocumentView, AppError>>;
  uploadDocument(input: UploadDocumentClientInput): Promise<Result<DocumentView, AppError>>;
  /** Archive l'original avant toute analyse ; idempotent sur `idempotencyKey`. */
  createDocumentIntake(
    input: CreateDocumentIntakeClientInput,
  ): Promise<Result<DocumentView, AppError>>;
  listDocumentFolders(
    input?: ListDocumentFoldersClientInput,
  ): Promise<Result<DocumentFolderPageView, AppError>>;
  getDocumentFolder(folderId: string): Promise<Result<DocumentFolderView, AppError>>;
  createDocumentFolder(input: {
    name: string;
    parentId?: string | null;
  }): Promise<Result<DocumentFolderView, AppError>>;
  updateDocumentFolder(input: {
    folderId: string;
    expectedRevision: number;
    name?: string;
    parentId?: string | null;
  }): Promise<Result<DocumentFolderView, AppError>>;
  previewDocumentFolderDeletion(
    folderId: string,
  ): Promise<Result<DocumentFolderDeletionPlanView, AppError>>;
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
  documentDownloadUrl(
    documentId: string,
    ttlSeconds?: number,
  ): Promise<Result<DocumentDownloadUrl, AppError>>;
  /** Confirme le classement proposé après OCR (A1-C14) — même use case pour l'UI et Bob. */
  classifyDocument(input: ClassifyDocumentClientInput): Promise<Result<DocumentView, AppError>>;
  /**
   * Confirme en une seule commande la dépense OCR, son écriture et le rattachement de l'original.
   * Un retry après réponse perdue restitue le même état sans créer de doublon.
   */
  recordDocumentExpense(
    input: RecordDocumentExpenseClientInput,
  ): Promise<Result<RecordDocumentExpenseClientOutput, AppError>>;
  extractDocument(input: {
    contentBase64: string;
    mimeType: string;
  }): Promise<Result<OcrExtraction, AppError>>;
  suggestExpenseDefaults(
    input: SuggestExpenseDefaultsInput,
  ): Promise<Result<ExpenseDefaultsView, AppError>>;
  recordExpense(
    input: Omit<RecordExpenseInput, 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>>;
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
  confirmFacturXExpense(input: {
    xml: string;
    decision: FacturXImportDecision;
  }): Promise<Result<FacturXImportOutcome, AppError>>;
  /** Enregistre un règlement déjà réalisé, avec preuve explicite — même use case que Bob. */
  payExpense(
    input: RecordExpensePaymentClientInput,
  ): Promise<Result<RecordExpensePaymentClientOutput, AppError>>;
  /** Régularise une dépense HISTORIQUE « payée sans preuve » (migration lane preuves) : valide la
   * preuve comme payExpense, pose l'écriture 401/512-530 manquante et sort la ligne de l'état
   * legacy — POST /expenses/:id/regularize-payment (RegularizeLegacyExpensePayment @bob/core). */
  regularizeExpensePayment(
    input: RegularizeExpensePaymentClientInput,
  ): Promise<Result<RegularizeExpensePaymentClientOutput, AppError>>;
  listExpenses(): Promise<Result<ExpenseProps[], AppError>>;
  /** Impute une dépense à un chantier — ou la délie ({ chantierId: null } explicite). MÊME use
   * case AssignExpenseToChantier (@bob/core) que Bob (parité d'actions), idempotent au retry. */
  assignExpenseChantier(
    input: AssignExpenseChantierClientInput,
  ): Promise<Result<AssignExpenseChantierClientOutput, AppError>>;
  listCatalogueItems(): Promise<Result<readonly CatalogueItemView[], AppError>>;
  createCatalogueItem(input: CatalogueItemWriteInput): Promise<Result<CatalogueItemView, AppError>>;
  updateCatalogueItem(input: {
    itemId: string;
    expectedRevision: number;
    item: CatalogueItemWriteInput;
  }): Promise<Result<CatalogueItemView, AppError>>;
  deleteCatalogueItem(input: {
    itemId: string;
    expectedRevision: number;
  }): Promise<Result<CatalogueDeletionView, AppError>>;
  createChantier(
    input: Omit<CreateChantierInput, 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>>;
  listChantiers(): Promise<Result<ChantierListItem[], AppError>>;
  // ── Journal + photos de chantier (fiche chantier, extension V1) ──
  listChantierNotes(chantierId: string): Promise<Result<ChantierNoteProps[], AppError>>;
  /** PR-11 (additif) — `equipmentId` tague la note sur un équipement DU MÊME site (prouvé
   * serveur, fail-closed) ; absent = note du site, comportement historique inchangé. */
  addChantierNote(
    chantierId: string,
    input: { text: string; equipmentId?: string | null },
  ): Promise<Result<{ id: string }, AppError>>;
  listWorksitePhotos(chantierId: string): Promise<Result<WorksiteMediaItem[], AppError>>;
  uploadWorksitePhoto(
    chantierId: string,
    input: {
      contentBase64: string;
      mimeType: string;
      filename: string;
      equipmentId?: string | null;
    },
  ): Promise<Result<WorksiteMediaItem, AppError>>;
  // ── PR-11 — parc d'équipements d'un site (Bloc A) : MÊMES use cases que la voix.
  // OPTIONNELLES (compat transports existants) — HttpBobClient et LocalBobClient les
  // implémentent tous les deux (parité stricte). ──
  listChantierEquipments?(chantierId: string): Promise<Result<EquipmentProps[], AppError>>;
  createEquipment?(
    chantierId: string,
    input: CreateEquipmentClientInput,
  ): Promise<Result<{ id: string }, AppError>>;
  updateEquipment?(
    equipmentId: string,
    input: { expectedRevision: number; patch: EquipmentPatch },
  ): Promise<Result<EquipmentProps, AppError>>;
  retireEquipment?(
    equipmentId: string,
    input: { expectedRevision: number },
  ): Promise<Result<RetireEquipmentOutput, AppError>>;
  reactivateEquipment?(
    equipmentId: string,
    input: { expectedRevision: number },
  ): Promise<Result<EquipmentProps, AppError>>;
  getEquipmentHistory?(equipmentId: string): Promise<Result<EquipmentHistoryView, AppError>>;
  // ── PR-16 §3.2/§4.5 — réglages de fiche de passage PARAMÉTRABLES (titre du PDF, templates
  // de checklist par `kind`) : MÊME use case que la voix. OPTIONNELLES (compat transports
  // existants) — HttpBobClient et LocalBobClient les implémentent tous les deux. ──
  getInterventionSettings?(): Promise<Result<InterventionSettingsView, AppError>>;
  updateInterventionSettings?(
    input: InterventionSettingsWriteInput,
  ): Promise<Result<InterventionSettingsView, AppError>>;
  /** [Revue A12] — réponse au refus actionnable « site clôturé — rouvre-le » (idempotent). */
  reopenChantier?(chantierId: string): Promise<Result<{ changed: boolean }, AppError>>;
  // ── PR-12b/12c — contrats de maintenance (Bloc B) : MÊMES use cases que la voix.
  // OPTIONNELLES (compat transports existants) — le mobile passe par le transport HTTP
  // (runtime exclusivement distant, conception §3.6). ──
  listMaintenanceContracts?(): Promise<Result<MaintenanceContractClientView[], AppError>>;
  getMaintenanceContract?(
    contractId: string,
  ): Promise<Result<MaintenanceContractClientView, AppError>>;
  createMaintenanceContract?(
    input: CreateContractClientInput,
  ): Promise<Result<{ id: string }, AppError>>;
  updateMaintenanceContract?(
    contractId: string,
    input: UpdateContractClientInput,
  ): Promise<Result<MaintenanceContractProps, AppError>>;
  activateMaintenanceContract?(
    contractId: string,
    input: { expectedRevision: number },
  ): Promise<Result<MaintenanceContractProps, AppError>>;
  terminateMaintenanceContract?(
    contractId: string,
    input: { expectedRevision: number; note: string; effectiveDate?: string | null },
  ): Promise<Result<MaintenanceContractProps, AppError>>;
  deleteDraftMaintenanceContract?(
    contractId: string,
    input: { expectedRevision: number },
  ): Promise<Result<{ deleted: true }, AppError>>;
  /** §2.6 — brouillon annuel en un tap (jamais émis, jamais envoyé seul). */
  prepareContractAnnualInvoice?(
    contractId: string,
  ): Promise<Result<PrepareAnnualInvoiceDraftOutput, AppError>>;
  /** §6.5 — période de service d'une facture de CONTRAT : « éditable en brouillon, figée à
   * l'émission » (le remède indiqué par la garde d'émission). Bornes HUMAINES inclusives. */
  updateInvoiceServicePeriod?(
    input: UpdateInvoiceServicePeriodClientInput,
  ): Promise<Result<UpdateInvoiceServicePeriodOutput, AppError>>;
  /** [Amélioration 4] — couverture contractuelle dite AVANT la confirmation de retrait. */
  equipmentContractCoverage?(
    equipmentId: string,
  ): Promise<Result<{ activeContractLabels: string[] }, AppError>>;
  worksitePhotoViewUrl(
    photoId: string,
  ): Promise<Result<{ url: string; expiresInSeconds: number }, AppError>>;
  deleteWorksitePhoto(photoId: string): Promise<Result<void, AppError>>;
  /**
   * ERRATUM 6 — retrait TRACÉ d'une photo (« 1 photo n'a pas pu être jointe ») : geste
   * canonique de la file FIFO offline, porté par un POST — un corps de DELETE peut être
   * dépouillé par un proxy et la note serait perdue en silence.
   */
  removeWorksitePhoto?(
    photoId: string,
    input: { resolutionNote: string },
  ): Promise<Result<void, AppError>>;
  listCustomers(): Promise<Result<CustomerListItem[], AppError>>;
  /** Crée une fiche client — même use case pour l'UI (C12) et l'outil agent creer_client (C40). */
  createCustomer(input: CreateCustomerClientInput): Promise<Result<{ id: string }, AppError>>;
  /** Édition post-création (C13/C40 TODO partagé) — remplacement complet revalidé, mêmes champs
   * que la création (SIREN, adresse, contact… complétés depuis la fiche). */
  updateCustomer(
    id: string,
    input: UpdateCustomerClientInput,
  ): Promise<Result<{ id: string }, AppError>>;
  // ── PR-09 — contacts multiples du client (label libre) : MÊMES use cases que la fiche.
  // OPTIONNELLES (compat transports existants) — HttpBobClient et LocalBobClient les
  // implémentent tous les deux (parité stricte). ──
  listCustomerContacts?(customerId: string): Promise<Result<CustomerContactView[], AppError>>;
  createCustomerContact?(
    customerId: string,
    input: CustomerContactWriteInput,
  ): Promise<Result<CustomerContactView, AppError>>;
  updateCustomerContact?(
    customerId: string,
    contactId: string,
    input: CustomerContactWriteInput,
  ): Promise<Result<CustomerContactView, AppError>>;
  deleteCustomerContact?(
    customerId: string,
    contactId: string,
  ): Promise<Result<{ deleted: true }, AppError>>;
  // —— Assistant Bob : autorité serveur unique, journal tenant-scoped ——
  /** POST /ai/ask : l'agent tourne CÔTÉ SERVEUR (autonomie clampée par l'offre, journal
   * append-only company-scoped). Le binaire mobile ne possède aucun cerveau de repli local. */
  askBob(input: AskBobClientInput): Promise<Result<AgentRun, AppError>>;
  /** Recharge une proposition opaque pour afficher son diff. Le serveur vérifie tenant,
   * propriétaire et expiration ; le payload reste non autoritatif pour la confirmation. */
  previewBobProposal(proposalId: string): Promise<Result<PendingAction, AppError>>;
  /** POST /ai/confirm : exécute l'action proposée (PendingAction) via le runtime JOURNALISÉ. */
  confirmBob(pending: PendingAction): Promise<Result<AgentRun, AppError>>;
  /** GET /ai/runs/:runId/journal : entrées d'audit append-only d'un run (company-scoped côté serveur).
   * NB : les DTO AgentRun de ask/confirm n'exposent pas (encore) le runId — voir rapport C40. */
  getRunJournal(runId: string): Promise<Result<JournalEntry[], AppError>>;
  getCashflow(input: {
    scenario: Scenario;
    horizon: Horizon;
  }): Promise<Result<CashflowProjection, AppError>>;
  /** Preuve bancaire qualifiée + `position` (ajout ADDITIF) : le solde CONSTATÉ daté et la
   *  position ESTIMÉE qui y ajoute les mouvements postérieurs. `position: null` = projection des
   *  mouvements indisponible → n'afficher que le constaté, jamais un estimé partiel. */
  getLatestBankBalance(): Promise<Result<QualifiedBankBalanceWithPosition, AppError>>;
  recordManualBankBalance(input: {
    amountCents: number;
    observedAt: string;
  }): Promise<Result<QualifiedBankBalanceWithPosition, AppError>>;
  createQuote(
    input: Omit<CreateQuoteInput, 'companyId'>,
  ): Promise<Result<CreateQuoteOutput, AppError>>;
  /** PR-14 « Refaire ce devis » — POST /quotes/:id/duplicate : NOUVEAU brouillon repassant
   * INTÉGRALEMENT par CreateQuote côté serveur (TVA re-suggérée au régime du jour ; signature,
   * urgence, n°, validité JAMAIS copiés). OPTIONNELLE (compat transports existants) —
   * les deux transports du repo l'implémentent (parité stricte). */
  duplicateQuote?(
    quoteId: string,
    input?: {
      context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
      standardRateForReducedLines?: boolean;
      idempotencyKey?: string | null;
    },
  ): Promise<Result<DuplicateQuoteOutput, AppError>>;
  /** Slot BDD du brouillon courant, isolé côté serveur par companyId + userId du JWT. */
  getQuoteDraft(): Promise<Result<QuoteDraftSlotView | null, AppError>>;
  /** expectedRevision=0 crée ; toute reprise ultérieure exige la révision exacte observée. */
  saveQuoteDraft(input: SaveQuoteDraftClientInput): Promise<Result<QuoteDraftSlotView, AppError>>;
  /** Suppression CAS : un écran périmé ne peut jamais effacer une reprise plus récente. */
  deleteQuoteDraft(expectedRevision: number): Promise<Result<{ deleted: true }, AppError>>;
  sendQuote(quoteId: string): Promise<Result<SendQuoteOutput, AppError>>;
  /** P0 R4 : prépare/rotate le lien de signature SANS AUCUN effet sortant (jamais d'e-mail). */
  createQuoteSignatureLink(
    quoteId: string,
  ): Promise<Result<CreateQuoteSignatureLinkOutput, AppError>>;
  /** Lien public de VISUALISATION d'un devis (POST /quotes/:id/view-link) — SANS AUCUN effet
   * sortant, tout statut sauf brouillon. */
  createQuoteViewLink(quoteId: string): Promise<Result<CreateDocumentViewLinkOutput, AppError>>;
  /** R4 : `proofDataUrl` = tracé du pad (dataURL) — le SERVEUR calcule le SHA-256 de preuve ;
   * le dataURL n'est jamais persisté tel quel. Absent = signature sans capture (preuve absente,
   * jamais fabriquée).
   * A3 : `earlyExecutionRequested` = case « exécution immédiate des travaux » cochée par le
   * client PARTICULIER au moment de signer (art. L221-25 c. conso) — tracée et horodatée
   * serveur, ignorée pour un professionnel ; elle lève le gel de rétractation de la finale. */
  signQuote(input: {
    quoteId: string;
    signerName: string;
    proofDataUrl?: string;
    earlyExecutionRequested?: boolean;
  }): Promise<Result<{ status: string }, AppError>>;
  refuseQuote(quoteId: string): Promise<Result<{ status: string }, AppError>>;
  /** Embargo L221-10 — DÉFAUT légal du flow « encaisser » pendant la fenêtre : l'encaissement
   * est PROGRAMMÉ au premier jour autorisé (J+7) ; le message de règlement part SEUL à
   * l'échéance (outbox serveur planifiée, un job par devis). OPTIONNELLE (compat transports
   * existants) — le client HTTP et le client local de démo l'implémentent tous les deux
   * (parité stricte). */
  scheduleEmbargoPayment?(
    quoteId: string,
  ): Promise<
    Result<{ scheduledFor: string; availableFrom: string; jobId: string; status: string }, AppError>
  >;
  generateInvoice(input: {
    quoteId: string;
    mode: 'deposit' | 'final' | 'situation';
    /** B2 — REQUIS avec le mode situation (interdit sinon, garde serveur) : avancement en % du
     *  marché ({ percent }) ou montant HT en centimes ({ amountHtCents }) — les situations se
     *  stipulent en HT, la TVA en découle par taux. Chaque appel en mode situation crée une
     *  NOUVELLE situation (n° d'ordre suivant — pas d'idempotence par nature). */
    situation?: SituationAmountInput;
    /** Override RESPONSABILISÉ de l'embargo L221-10 — `true` strict UNIQUEMENT, après la
     *  feuille de confirmation dédiée (risque concret reformulé) ; le serveur journalise
     *  payment.embargo_overridden avant de produire la pièce. Jamais implicite. */
    embargoOverride?: boolean;
  }): Promise<Result<{ invoiceId: string }, AppError>>;
  /** B1 : facture DIRECTE sans devis signé (POST /invoices — brouillon composé librement :
   * dépannage urgent B2C qualifié A3bis obligatoire fail-closed, régie TJM × jours, syndic/B2B).
   * L'émission passe ensuite par issueInvoice (aucun chemin parallèle). OPTIONNELLE (compat
   * transports existants) — le client HTTP et le client local de démo l'implémentent tous
   * les deux (parité stricte). */
  composeStandaloneInvoice?(input: {
    customerId: string;
    lines: LineInput[];
    /** B3 — remise globale (% du HT net de lignes, ou montant HT en centimes). */
    globalDiscount?: Discount | null;
    context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
    /** A3bis — booléen STRICT : seul `true` porte la qualification d'urgence (client B2C). */
    urgentOnSiteRepair?: boolean;
    /** PR-08 — site de rattachement (picker) ; absent/null = pièce hors site (anti-IDOR serveur). */
    chantierId?: string | null;
  }): Promise<Result<{ invoiceId: string; totals: Totals }, AppError>>;
  /** Suivi MANUEL de transmission d'une pièce ÉMISE (PATCH /invoices/:id/transmission) : dates
   * de dépôt/acceptation DÉCLARÉES (champ absent = inchangé, null = effacé). OPTIONNELLE (compat
   * transports existants) — le client HTTP et le client local de démo l'implémentent tous
   * les deux (parité stricte). */
  recordInvoiceTransmission?(input: {
    invoiceId: string;
    depositedAt?: string | null;
    acceptedAt?: string | null;
  }): Promise<Result<{ transmission: InvoiceTransmissionStatus | null }, AppError>>;
  /** R6 : édition d'une ligne de devis BROUILLON (PATCH /quotes/:id/lines/:lineId) — draft only,
   * un devis signé est un contrat (l'agrégat garde assertDraft). */
  updateQuoteLine(input: UpdateQuoteLineInput): Promise<Result<{ status: string }, AppError>>;
  /** R6 : suppression d'une ligne de devis BROUILLON (DELETE /quotes/:id/lines/:lineId). */
  removeQuoteLine(input: RemoveQuoteLineInput): Promise<Result<{ status: string }, AppError>>;
  // ——— B8 : bon de commande grands comptes (numéro d'engagement, parité humain↔Bob) ———
  // OPTIONNELLES (précédent trialReport) : les fakes/transports existants restent assignables ;
  // HttpBobClient et LocalBobClient les implémentent TOUS LES DEUX (parité stricte).
  /** PUT /quotes/:id/purchase-order — saisi UNE FOIS sur le devis, repris sur la facture dérivée. */
  attachQuotePurchaseOrder?(
    input: AttachQuotePurchaseOrderClientInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>>;
  /** DELETE /quotes/:id/purchase-order — retrait explicite (devis non facturé uniquement). */
  detachQuotePurchaseOrder?(
    input: DetachQuotePurchaseOrderClientInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>>;
  /** PUT /invoices/:id/purchase-order — facture BROUILLON uniquement (figé à l'émission). */
  attachInvoicePurchaseOrder?(
    input: AttachInvoicePurchaseOrderClientInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>>;
  /** DELETE /invoices/:id/purchase-order — retrait explicite (facture brouillon uniquement). */
  detachInvoicePurchaseOrder?(
    input: DetachInvoicePurchaseOrderClientInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>>;
  /** A6 : avoir TOTAL (brouillon) d'une facture émise — même use case pour l'UI et Bob. */
  createCreditNote(input: {
    invoiceId: string;
  }): Promise<Result<{ creditNoteId: string }, AppError>>;
  issueInvoice(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>>;
  /** R6 : suppression définitive d'une facture BROUILLON (DELETE /invoices/:id/draft) — erreur
   * détectée après génération depuis un devis ; garde stricte status==='draft'. */
  deleteDraftInvoice(invoiceId: string): Promise<Result<{ deleted: true }, AppError>>;
  /** Lien public de VISUALISATION d'une facture (POST /invoices/:id/view-link) — SANS AUCUN
   * effet sortant, facture ÉMISE uniquement (jamais un brouillon). */
  createInvoiceViewLink(invoiceId: string): Promise<Result<CreateDocumentViewLinkOutput, AppError>>;
  /** PR-01 « Encaisser » : envoi EMAIL réel de la facture ÉMISE (POST /invoices/:id/send) —
   * geste explicite confirmé, lien public + PDF archivé joint, expéditeur perçu = la société.
   * OPTIONNELLE (compat transports existants) — le client HTTP et le client local de démo
   * l'implémentent tous les deux (parité stricte). */
  sendInvoice?(input: SendInvoiceClientInput): Promise<Result<SendInvoiceClientOutput, AppError>>;
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
  /** POST /devices : rebind global atomique vers le principal courant. */
  registerDevice(
    input: RegisterDeviceClientInput,
  ): Promise<Result<{ status: 'bound' | 'superseded' }, AppError>>;
  /** DELETE /devices : retire le binding du tenant courant avant la fin de session. */
  unregisterDevice(
    input: UnregisterDeviceClientInput,
  ): Promise<Result<{ unregistered: true }, AppError>>;
  /** Fence authentifiée écrite avant signOut, même si le POST d'inscription est encore en vol. */
  revokeDeviceBinding(
    input: RevokeDeviceBindingClientInput,
  ): Promise<Result<{ accepted: true }, AppError>>;
  /** Replay public one-way d'une tombstone après destruction du JWT. */
  replayPushRevocation(
    input: RevokeDeviceBindingClientInput,
  ): Promise<Result<{ accepted: true }, AppError>>;
  registerPayment(
    input: RegisterPaymentClientInput,
  ): Promise<Result<RegisterPaymentClientOutput, AppError>>;
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
  /** B9 — GET /documents/search : « retrouve les devis de Mairie de Sèvres du mois dernier ».
   * Nommé "SalesDocuments" (et non "Documents") pour ne jamais se confondre avec le coffre GED
   * (listDocuments/DocumentView, un domaine différent malgré le même préfixe d'URL /documents). */
  searchSalesDocuments(
    input: SearchSalesDocumentsClientInput,
  ): Promise<Result<SearchSalesDocumentsResult, AppError>>;
  /** B9 — GET /documents/suggest : autocomplétion typée {kind, value, count}, LIMIT 8. */
  suggestSalesDocuments(query: string): Promise<Result<SuggestSalesDocumentsResult, AppError>>;
  /**
   * POST /jarvis/runs/:runId/commands (lot U1-d) — le canal TACTILE d'un run Jarvis : une
   * enveloppe utilisateur entre, un reçu d'admission sort. Le tap vit SANS lease Realtime (§14,
   * greffe G1) : un run parké après la mort de la session vocale se reprend à l'écran.
   * Un rejeu du MÊME `commandId` rend le reçu original (`outcome: 'replayed'`, zéro écriture) ;
   * tout refus fermé de l'admission (révision périmée, conflit, capability, action fermée…)
   * remonte en `AppError` — l'écran refait alors une lecture autoritative, jamais une supposition.
   * OPTIONNELLE (précédent `trialReport?`) : les transports qui n'ouvrent pas Jarvis restent
   * assignables et l'appelant échoue fermé lorsqu'elle est absente.
   */
  jarvisSubmitCommand?(
    input: JarvisSubmitCommandClientInput,
    signal?: AbortSignal,
  ): Promise<Result<JarvisCommandReceiptView, AppError>>;
  /**
   * GET /jarvis/runs/:runId (lot U1-d) — lecture stateless §5.2 : le run projeté + la présentation
   * serveur des champs proposés. `presentation: null` = le digest des champs ne se revérifie pas
   * (greffe G4) : rien n'est confirmable. OPTIONNELLE, même doctrine que `jarvisSubmitCommand`.
   */
  jarvisGetRun?(
    runId: string,
    signal?: AbortSignal,
  ): Promise<Result<JarvisRunSnapshotView, AppError>>;
  /**
   * GET /jarvis/runs/current (lot U1-e §1) — la DÉCOUVERTE : le run non terminal de l'owner, ou
   * `{ run: null }`. C'est l'unique porte d'entrée d'un appareil qui n'a rien dérivé ; elle est
   * owner-scopée et stateless (zéro verrou, zéro écriture) comme `jarvisGetRun`.
   * OPTIONNELLE, même doctrine que `jarvisSubmitCommand`.
   */
  jarvisCurrentRun?(signal?: AbortSignal): Promise<Result<JarvisCurrentRunView, AppError>>;
  /**
   * POST /jarvis/runs (lot U1-e §1) — ouverture d'un run `customer_contact@1` de MODIFICATION
   * depuis l'écran. Route DÉDIÉE : le canal de commandes continue de refuser toute révision de
   * seed. Rejouer le MÊME `commandId` retombe sur le MÊME run et rend le reçu original
   * (`outcome: 'replayed'`, zéro écriture) — jamais un second run fantôme.
   * OPTIONNELLE, même doctrine que `jarvisSubmitCommand`.
   */
  jarvisOpenRun?(
    input: JarvisOpenRunClientInput,
    signal?: AbortSignal,
  ): Promise<Result<JarvisCommandReceiptView, AppError>>;
}

/** Entrée client de searchSalesDocuments : identique au contrat core, `scope` par défaut "all"
 * si omis (les appelants mobile n'ont pas toujours un toggle devis/factures actif). */
export type SearchSalesDocumentsClientInput = Omit<SearchSalesDocumentsInput, 'scope'> & {
  scope?: SearchSalesDocumentsInput['scope'];
};
export type {
  SearchSalesDocumentsInput,
  SearchSalesDocumentsResult,
  SuggestSalesDocumentsInput,
  SuggestSalesDocumentsResult,
};
