import { createHash } from 'node:crypto';
import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import {
  SendQuote,
  SignQuote,
  RefuseQuote,
  ExpireQuote,
  GenerateInvoiceFromQuote,
  UpdateQuoteLine,
  RemoveQuoteLine,
  DeleteDraftInvoice,
  IssueInvoice,
  CreateCreditNote,
  RegisterPayment,
  RecordExpensePayment,
  RegularizeLegacyExpensePayment,
  AssignExpenseToChantier,
  validateCompanyBillingSettingsPatch,
  RecordIssuedInvoiceAccountingEntry,
  RecordPaymentAccountingEntry,
  ListAccountingEntries,
  ExportFec,
  PreviewPaymentAccountingEntry,
  ListCustomers,
  GetCashflow,
  GetLatestQualifiedBankBalance,
  CreateBankBalanceSnapshot,
  BANK_BALANCE_FRESHNESS_POLICY_V1,
  deriveKnownReceivables,
  SystemClock,
  parisDateOnly,
  deriveRelancePlan,
  ok,
  err,
  appConflict,
  appNotFound,
  appForbidden,
  appUnavailable,
  appDomain,
  Company,
  Customer,
  UpdateCustomer,
  Subscription,
  PLAN_CATALOG,
  ADDON_CATALOG,
  planEntitlements,
  tierAtLeast,
  startReverseTrial,
  GetSubscriptionStatus,
  resolveAutonomyEntitlement,
  type SubscriptionStatusView,
  CloseAccount,
  GetFiscalProfile,
  UpdateFiscalProfileField,
  parseFiscalProfileFieldPatch,
  companyVatRegimeFromFiscal,
  type FiscalProfileDerivationInput,
  type FiscalProfileView,
  deriveOwnerPayGuidance,
  runDiagnostic,
  deriveFiscalCalendar,
  deriveVatPosition,
  deriveAgedBalance,
  deriveBusinessReview,
  formatEUR,
  resolveTradeConfig,
  facturXDataFromInvoice,
  buildFacturXBasicXml,
  ExtractDocument,
  importFacturXExpense as runFacturXReceptionControls,
  withSupplierCategory,
  facturXDraftToRecordExpenseInput,
  expenseDuplicateKey,
  facturXInvoiceDuplicateKey,
  parseFacturXBasic,
  InboundEinvoice,
  ListCatalogueItems,
  CreateCatalogueItem,
  UpdateCatalogueItem,
  DeleteCatalogueItem,
  CreateChantier,
  AddChantierNote,
  UploadWorksitePhoto,
  DeleteWorksitePhoto,
  AutofillCompanyFromSiret,
  ValidateVatNumber,
  SearchAddress,
  CreateQuoteSignatureToken,
  CreateQuoteSignatureLink,
  ResolveQuoteSignatureToken,
  CreateDocumentViewLink,
  ResolveDocumentViewToken,
  type ResolvedDocumentViewGrant,
  sha256Hex,
  StoreDocument,
  ListDocuments,
  ClassifyDocument,
  AcknowledgeDocument,
  validateDocumentDisplayName,
  CreateDocumentFolder,
  ListDocumentFolders,
  RenameDocumentFolder,
  MoveDocumentFolder,
  MoveDocumentToFolder,
  PreviewDeleteDocumentFolder,
  DeleteDocumentFolder,
  DEFAULT_DOCUMENT_FOLDERS,
  AnalyzeDocument,
  RenameDocument,
  AttachPurchaseOrderToQuote,
  AttachPurchaseOrderToInvoice,
  DetachPurchaseOrder,
  ListInvoiceableQuotes,
  type PurchaseOrderRef,
  type PurchaseOrderRefInput,
  type PurchaseOrderMutationView,
  DOCUMENT_INTELLIGENCE_MAX_BYTES,
  documentToView,
  GetDocumentDownloadUrl,
  buildDocumentStorageKey,
  buildInvoiceAccountingPreviewEntry,
  buildMentions,
  // A3 — rétractation 14 jours B2C : textes réglementaires (avis R221-3, formulaire R221-1),
  // libellé exact de la case d'exécution anticipée (L221-25) — source unique servie au PDF et
  // à la page sign-web, jamais réécrite côté front.
  retractationNoticeLines,
  retractationFormLines,
  RETRACTATION_EARLY_EXECUTION_LABEL,
  // Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°) : mention datée du devis + bloc
  // rétractation ADAPTÉ (exception limitée au strict nécessaire, formulaire conservé).
  urgentRepairQuoteMention,
  urgentRepairRetractationLines,
  type EmbargoOverrideAuditPort,
  // Embargo L221-10 : défaut légal = encaissement PROGRAMMÉ à J+7 (outbox planifiée) — le
  // dérivé domaine décide de la fenêtre, le message client vient de la même source unique.
  offPremisesPaymentEmbargo,
  offPremisesEmbargoLiftedClientLines,
  // A3 — fonctionnalité de rétractation EN LIGNE (art. L221-21 dernier al. et D221-5 c. conso,
  // en vigueur depuis le 19/06/2026) : libellés réglementaires, disponibilité, exercice.
  RETRACTATION_WITHDRAW_FUNCTION_LABEL,
  RETRACTATION_CONFIRM_FUNCTION_LABEL,
  onlineRetractationAvailability,
  deriveRetractation,
  // Gel de la FINALE pendant le délai de rétractation (L221-18/L221-25) : l'encaissement
  // programmé d'un devis SANS acompte vise la finale — sa date honore AUSSI ce gel.
  retractationFreeze,
  ExerciseRetractation,
  type ExerciseRetractationOutput,
  ResolveQuoteRetractationToken,
  type SignQuoteOutput,
  type RetractationProfessional,
  type Result,
  type AppError,
  type CreateQuoteInput,
  type Scenario,
  type Horizon,
  type CashflowProjection,
  type QualifiedBankBalanceSnapshot,
  type PaymentMethod,
  type Quote,
  type Invoice,
  type Expense,
  type ClockPort,
  type QuoteLine,
  type UpdateQuoteLineInput,
  type Totals,
  type TodayInvoiceData,
  type PlanTier,
  type PaymentGatewayPort,
  type PdfRendererPort,
  type DocumentStoragePort,
  type InvoicePdfData,
  type QuotePdfData,
  type CompanyProps,
  type CompanyRegistrationInput,
  type CompanyBillingSettings,
  type CompanyBillingSettingsPatch,
  type CustomerPortfolio,
  type CustomerProps,
  type DiagnosticResult,
  type FiscalDeadline,
  type TradeConfig,
  type Trade,
  type VatRegime,
  type OcrExtractInput,
  type ChantierListItem,
  type ChantierNoteProps,
  type CreateChantierInput,
  type WorksiteMediaItem,
  type CatalogueItemWriteInput,
  type CompanyLookupPort,
  type CompanyLookupResult,
  type VatValidationPort,
  type VatCheckResult,
  type AddressAutocompletePort,
  type AddressSuggestion,
  type OcrExtraction,
  type ExpenseCategory,
  type OcrPort,
  type RecordExpenseInput,
  type RecordExpensePaymentDeclaration,
  type ExpenseProps,
  type ExpensePaymentEvidenceInput,
  type FacturXExpenseDraft,
  type AfnorInboundRefusalStatus,
  type DocumentKind,
  type DocumentLinkedEntityType,
  type DocumentOrigin,
  type DocumentView,
  type DocumentDownloadUrl,
  type DocumentFolderView,
  type DocumentFolderSystemKey,
  type DeleteDocumentFolderStrategy,
  type DocumentAnalysis,
  type DocumentAnalysisType,
  type DocumentClassificationContext,
  type DocumentDestinationSuggestion,
  type DateOnly,
  type DocumentIntelligencePort,
  type DocumentLinkTargetPort,
  isValidDateOnly,
  type SearchSalesDocumentsInput,
  type SearchSalesDocumentsResult,
  type SuggestSalesDocumentsInput,
  type SuggestSalesDocumentsResult,
} from '@bob/core';
import {
  BobAgent,
  ModelRouter,
  parseAgentAskPayload,
  type BobActions,
  type SendRelanceActionInput,
  type AgentAskPayload,
  type AgentRun,
  type AgentAutonomy,
  type BatchItem,
  type PendingAction,
  type JournalEntry,
  type ContextEntitySummary,
  type ReadContextEntityInput,
  type RuntimeInvocation,
  purchaseOrderLinkedRun,
  redactPII,
  accountingJournalLabel,
  chantierStatusLabel,
  customerTypeLabel,
  documentKindLabel,
  documentStatusLabel,
  expenseCategoryLabel,
  expenseStatusLabel,
  frDateLabel,
  invoiceKindLabel,
  invoiceStatusLabel,
  quoteStatusLabel,
} from '@bob/ai';
import type { TtsResult } from '@bob/ai';
import { UuidGenerator } from './id-generator';
import { RechercheEntreprisesAdapter } from './adapters/recherche-entreprises.adapter';
import { ViesVatAdapter } from './adapters/vies-vat.adapter';
import { BanAddressAdapter } from './adapters/ban-address.adapter';
import type { Persistence } from './persistence/persistence';
import { PERSISTENCE } from './persistence/persistence-token';
import { CompanyScopedJournalStore } from './persistence/agent-journal';
import { Metrics } from './observability/metrics';
import { AppLogger, getPrincipal, requireTenant } from './observability/logger';
import { SUPABASE_ADMIN, type SupabaseAdminPort } from './auth/supabase-admin';
import { PAYMENT_GATEWAY } from './payments/payment-gateway';
import { StripeBillingService } from './payments/stripe-billing.service';
import { PDF_RENDERER } from './documents/pdf-renderer';
import { DOCUMENT_STORAGE, UnavailableDocumentStorage, documentSha256 } from './documents/storage';
import {
  generatedInvoiceDocumentId,
  generatedInvoiceDocumentVersionId,
  generatedQuoteDocumentId,
  generatedQuoteDocumentVersionId,
} from './documents/generated-document-ids';
import { OCR_PORT } from './ocr/ocr';
import {
  DOCUMENT_INTELLIGENCE_PORT,
  UnavailableDocumentIntelligence,
} from './documents/document-intelligence';
import {
  DocumentFolderDeletionPlanService,
  type DocumentFolderDeletionPlanPreviewView,
} from './documents/document-folder-deletion-plan';
import { hasClaudeKey, hasGlmKey, hasDeepseekKey, hasMistralKey, hasOpenaiKey } from './config/env';
import { buildLlmForProvider, buildSttCloud, buildTtsCloud } from './ai/providers';
import { clampAgentAutonomy } from './ai/autonomy-entitlements';
import { NotificationDeliveryService } from './jobs/notification-delivery.service';
// Clé de déduplication du job « encaissement programmé » (embargo L221-10) — source unique
// partagée entre la programmation, l'annulation à la rétractation et la garde de livraison.
import { embargoScheduledPaymentDedupeKey } from './persistence/notification-jobs';
// Import circulaire assumé (RelanceService ↔ BackendService) : résolu par forwardRef des deux
// côtés — l'action Bob envoyer_relance délègue au MÊME service que POST /invoices/:id/relance.
import { RelanceService } from './jobs/relance.service';
import { notificationRoute } from './notifications/notification-route';
import { remainingInvoiceBalanceCents } from './billing/invoice-balance';
import { ExpenseCreationCoordinator } from './expenses/expense-creation-coordinator';
import { RepositoryDocumentLinkTargets } from './documents/document-link-targets';
import { QuoteCreationCoordinator } from './quotes/quote-creation-coordinator';

export interface QuoteView {
  id: string;
  companyId: string;
  customerId: string;
  status: string;
  number: string | null;
  depositPct: number | null;
  lines: QuoteLine[];
  totals: Totals;
  validUntil: string | null;
  signed: boolean;
  /** B8 : bon de commande client (numéro d'engagement) — null si aucun. */
  purchaseOrder: PurchaseOrderRef | null;
  /** Révision optimiste des mutations de bon de commande (>= 1). */
  revision: number;
  /** Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°) — null si jamais sollicitée. */
  urgentRepair: { requestedAt: string } | null;
}

export interface InvoiceView {
  id: string;
  companyId: string;
  customerId: string;
  kind: string;
  status: string;
  number: string | null;
  parentQuoteId: string | null;
  totals: Totals;
  mentions: string[];
  dueAt: string | null;
  paid: number;
  /** Lignes de la pièce (C16). */
  lines: QuoteLine[];
  depositDeductionCents: number;
  depositInvoiceId: string | null;
  /** B8 : bon de commande (repris du devis à la dérivation, figé à l'émission) — null si aucun. */
  purchaseOrder: PurchaseOrderRef | null;
  /** Révision optimiste des mutations de bon de commande (>= 1). */
  revision: number;
  /** E3 : identité FIGÉE de la facture annulée par cet AVOIR (snapshot du domaine) — nav
   * croisée inverse avoir → facture d'origine. Null = pièce ordinaire. */
  creditNoteSource: { invoiceId: string; kind: string; number: string; issuedAt: string } | null;
}

/** Encaissement daté du tenant (E3 — PONT-SERVEUR v1) : miroir du PaymentView du client. */
export interface PaymentView {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  receivedAt: string;
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

export interface ExpenseDefaultsView {
  supplierName: string;
  supplierSiren: string | null;
  category: ExpenseCategory;
  vatRatePct: number | null;
  source: 'memory' | 'ocr';
}

// ——— Réception e-facture (C-EXP6b) — DTO miroir du BobClient (comme ExpenseDefaultsView) ———

/** Contrôles bloquants du poste de réception, dans l'ordre où ils sont passés. */
export type FacturXImportControl = 'destinataire' | 'coherence_en16931' | 'doublon';

/** POST /expenses/import-facturx : contrôles + brouillon — RIEN n'est enregistré à ce stade. */
export interface FacturXImportReview {
  draft: FacturXExpenseDraft;
  controls: FacturXImportControl[];
}

/** La DÉCISION reste à l'appelant (humain ou Bob) : approbation (catégorie confirmable)
 *  ou refus AFNOR 210/213 avec motif OBLIGATOIRE (InboundEinvoice l'impose). */
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

/** Vue publique d'un devis pour la page de signature client à distance (lien tokenisé). */
export interface SignatureView {
  number: string;
  companyName: string;
  customerName: string;
  status: string;
  signed: boolean;
  expired: boolean;
  validUntil: string | null;
  lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
  totals: Totals;
  /** A1 — mentions légales du devis (buildMentions kind 'quote'), IDENTIQUES au PDF : la page
   *  de signature affiche le même bloc que la pièce que le client s'engage à accepter. */
  mentions: string[];
  /**
   * A3 — information rétractation 14 jours du CONSOMMATEUR, affichée AVANT signature (art.
   * L221-18 s. c. conso ; sanction : délai porté à 12 mois, art. L221-20). Tout devis B2C signé
   * via l'app est à distance (remote_link) ou hors établissement (onsite_draw) : présomption
   * d'applicabilité. `noticeLines` = avis d'information type (annexe art. R221-3) ;
   * `earlyExecutionLabel` = libellé EXACT de la case optionnelle « exécution immédiate »
   * (renonciation L221-25) — la page l'affiche tel quel, ne le réécrit jamais.
   * Null = client professionnel (b2b/b2g) : aucun droit de rétractation, rien d'affiché.
   */
  retractation: { noticeLines: string[]; earlyExecutionLabel: string } | null;
}

interface ResolvedSignatureGrant {
  grantId: string;
  companyId: string;
  quoteId: string;
}

/** Vue publique d'une pièce (devis OU facture) pour la page de VISUALISATION (lien tokenisé,
 *  scope document_view) — lecture seule, jamais de capacité de signature/paiement. */
export type DocumentPublicView =
  | {
      kind: 'quote';
      number: string;
      companyName: string;
      customerName: string;
      status: string;
      signed: boolean;
      validUntil: string | null;
      lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
      totals: Totals;
    }
  | {
      kind: 'invoice';
      number: string;
      companyName: string;
      customerName: string;
      status: string;
      issuedAt: string | null;
      dueAt: string | null;
      paid: number;
      lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
      totals: Totals;
      mentions: string[];
    };

/** Empreinte d'un original archivé — vérifiée octet à octet avant tout service (fail-closed). */
type ArchivedPdfDescriptor = {
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
};

type AuthorizedPublicDocumentPdf =
  | { kind: 'quote'; data: QuotePdfData }
  | {
      kind: 'invoice';
      companyId: string;
      invoiceId: string;
      number: string;
      archive: ArchivedPdfDescriptor;
    }
  /** A8 — devis SIGNÉ : le contrat est servi depuis son original archivé à la signature,
   *  jamais re-rendu (art. L213-1 c. conso ; valeur probante art. 1366-1367 c. civ.). */
  | {
      kind: 'signed_quote';
      companyId: string;
      quoteId: string;
      number: string;
      archive: ArchivedPdfDescriptor;
    };

const EXPENSE_CATEGORIES = new Set<ExpenseCategory>([
  'fournitures',
  'materiel',
  'carburant',
  'repas',
  'sous_traitance',
  'autre',
]);

function notificationMutationCount(result: unknown): number | null {
  if (typeof result !== 'object' || result === null) return null;
  const value = (result as { updatedCount?: unknown }).updatedCount;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

class RollbackAppError extends Error {
  constructor(readonly appError: AppError) {
    super('rollback-app-error');
  }
}

export interface UploadDocumentInput {
  contentBase64: string;
  mimeType: string;
  filename: string;
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType | null;
  linkedEntityId?: string | null;
  documentDate?: string | null;
  folderId?: string | null;
  /** Tags de classement/recherche (#11). */
  tags?: string[];
}

export interface ListDocumentsInput {
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType;
  linkedEntityId?: string;
  folderId?: string | null;
  includeDeleted?: boolean;
}

/** Résumé d'analyse embarqué dans GET /documents — issu du SEUL cache persistant (aucun LLM à la lecture). */
export interface DocumentAnalysisSummaryView {
  type: DocumentAnalysisType;
  typeConfidence: number;
  suggestedDisplayName: string;
  suggestedDestination: DocumentDestinationSuggestion | null;
  requiresHumanReview: boolean;
  /** Résumé de Bob — la carte du détail doit être EXACTEMENT la carte du scan. */
  summary: string;
  suggestedTags: readonly string[];
  /** Avertissements qui justifient `requiresHumanReview` — jamais un badge orange inexpliqué. */
  warnings: readonly string[];
}

/** Chips de l'écran Documents (montant/TVA/date), projetées depuis les faits prouvés de l'analyse. */
export interface DocumentExtractionSummaryView {
  supplierName: string | null;
  totalTtcCents: number;
  vatCents: number | null;
  documentDate: DateOnly | null;
}

/**
 * Item de GET /documents : la vue document + le résumé d'analyse persisté. `analysis: null`
 * signifie « pas encore analysé pour cette version de l'original » — jamais une valeur inventée.
 */
export type DocumentListItemView = DocumentView & {
  analysis: DocumentAnalysisSummaryView | null;
  extraction: DocumentExtractionSummaryView | null;
};

function documentAnalysisSummary(analysis: DocumentAnalysis): DocumentAnalysisSummaryView {
  return {
    type: analysis.type,
    typeConfidence: analysis.typeConfidence,
    suggestedDisplayName: analysis.suggestedDisplayName,
    suggestedDestination: analysis.suggestedDestination,
    requiresHumanReview: analysis.requiresHumanReview,
    summary: analysis.summary,
    suggestedTags: analysis.suggestedTags,
    warnings: analysis.warnings,
  };
}

/** Montant d'un fait money en centimes — EUR uniquement (jamais de conversion implicite). */
function factEurCents(analysis: DocumentAnalysis, key: 'total_ttc' | 'vat_amount'): number | null {
  const fact = analysis.facts.find(
    (candidate) => candidate.key === key && candidate.valueType === 'money',
  );
  return fact?.valueType === 'money' && fact.value.currency === 'EUR' ? fact.value.amountMinor : null;
}

/**
 * Chips de liste dérivées des faits PROUVÉS de l'analyse. Sans total TTC lisible, aucune chip
 * n'est fabriquée (null) : l'écran retombe sur l'état « à confirmer », jamais sur un montant inventé.
 */
function documentExtractionSummary(analysis: DocumentAnalysis): DocumentExtractionSummaryView | null {
  const totalTtcCents = factEurCents(analysis, 'total_ttc');
  if (totalTtcCents === null) return null;
  const supplierFact = analysis.facts.find(
    (candidate) => candidate.key === 'supplier_name' && candidate.valueType === 'text',
  );
  const dateFact = analysis.facts.find(
    (candidate) => candidate.key === 'document_date' && candidate.valueType === 'date',
  );
  return {
    supplierName: supplierFact?.valueType === 'text' ? supplierFact.value : null,
    totalTtcCents,
    vatCents: factEurCents(analysis, 'vat_amount'),
    documentDate: dateFact?.valueType === 'date' ? dateFact.value : null,
  };
}

export interface CreateDocumentIntakeInput {
  contentBase64: string;
  mimeType: string;
  filename: string;
  /** Stable pendant les retries réseau ; le serveur refuse toute réutilisation avec d'autres octets. */
  idempotencyKey: string;
}

export interface RecordDocumentExpenseInput {
  documentId: string;
  expectedRevision: number;
  targetFolderId: string;
  /** Le règlement déclaré (ticket déjà payé) se limite à date + moyen : la PREUVE
   *  (proofDocumentId) reste sous autorité serveur — c'est le scan archivé lui-même. */
  expense: Omit<RecordExpenseInput, 'companyId' | 'idempotencyKey' | 'source' | 'payment'> & {
    payment?: Pick<RecordExpensePaymentDeclaration, 'paidOn' | 'method'> | null;
  };
}

export interface RecordDocumentExpenseOutput {
  expenseId: string;
  document: DocumentView;
}

const DOCUMENT_BINARY_MAX_BYTES = DOCUMENT_INTELLIGENCE_MAX_BYTES;
const DOCUMENT_BASE64_MAX_CHARS = Math.ceil(DOCUMENT_BINARY_MAX_BYTES / 3) * 4;
const DOCUMENT_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'application/xml',
  'text/xml',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

function decodeBase64Document(contentBase64: unknown): Result<Uint8Array, AppError> {
  if (typeof contentBase64 !== 'string') {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'contentBase64', message: 'Base64 invalide.' }],
      },
    };
  }
  const raw = contentBase64.includes(',')
    ? contentBase64.slice(contentBase64.indexOf(',') + 1)
    : contentBase64;
  const normalized = raw.replace(/\s/g, '');
  if (!normalized || !BASE64_PAYLOAD.test(normalized)) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'contentBase64', message: 'Base64 invalide.' }],
      },
    };
  }
  if (normalized.length > DOCUMENT_BASE64_MAX_CHARS) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'contentBase64', message: 'Document trop volumineux (10 Mo maximum).' }],
      },
    };
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'contentBase64', message: 'Document vide.' }],
      },
    };
  }
  if (bytes.byteLength > DOCUMENT_BINARY_MAX_BYTES) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'contentBase64', message: 'Document trop volumineux (10 Mo maximum).' }],
      },
    };
  }
  return ok(bytes);
}

function validateUploadedDocument(input: {
  filename: unknown;
  mimeType: unknown;
  bytes: Uint8Array;
}): Result<{ filename: string; mimeType: string }, AppError> {
  const filename =
    typeof input.filename === 'string' ? input.filename.replace(/\s+/g, ' ').trim() : '';
  const mimeType =
    typeof input.mimeType === 'string' ? input.mimeType.split(';', 1)[0]!.trim().toLowerCase() : '';
  const issues: { field: string; message: string }[] = [];
  const hasUnsafeFilenameCharacter =
    filename.includes('/') ||
    filename.includes('\\') ||
    [...filename].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
  if (!filename || filename.length > 180 || hasUnsafeFilenameCharacter) {
    issues.push({
      field: 'filename',
      message: 'Nom de fichier invalide (180 caractères maximum).',
    });
  }
  if (!DOCUMENT_UPLOAD_MIME_TYPES.has(mimeType)) {
    issues.push({
      field: 'mimeType',
      message: 'Format non pris en charge. Utilise PDF, XML, JPEG, PNG, WebP ou HEIC.',
    });
  }
  const bytes = input.bytes;
  const isPdf =
    bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng =
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
  const isWebp =
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
  const heifBrand = bytes.length >= 12 ? Buffer.from(bytes.subarray(8, 12)).toString('ascii') : '';
  const isHeif =
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(4, 8)).toString('ascii') === 'ftyp' &&
    new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']).has(heifBrand);
  const xmlHead = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 512)))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  const signatureMatches =
    (mimeType === 'application/pdf' && isPdf) ||
    (mimeType === 'image/jpeg' && isJpeg) ||
    (mimeType === 'image/png' && isPng) ||
    (mimeType === 'image/webp' && isWebp) ||
    ((mimeType === 'image/heic' || mimeType === 'image/heif') && isHeif) ||
    ((mimeType === 'application/xml' || mimeType === 'text/xml') && xmlHead.startsWith('<'));
  if (DOCUMENT_UPLOAD_MIME_TYPES.has(mimeType) && !signatureMatches) {
    issues.push({
      field: 'mimeType',
      message: 'Le contenu du fichier ne correspond pas au format annoncé.',
    });
  }
  return issues.length > 0
    ? { ok: false, error: { kind: 'validation', issues } }
    : ok({ filename, mimeType });
}

function appErrorSummary(error: AppError): string {
  if (error.kind === 'domain')
    return `${error.error.code}:${'field' in error.error ? error.error.field : ''}`;
  if (error.kind === 'not_found') return `not_found:${error.entity}:${error.id}`;
  if (error.kind === 'forbidden') return `forbidden:${error.reason}`;
  if (error.kind === 'validation')
    return `validation:${error.issues.map((i) => `${i.field}:${i.message}`).join(';')}`;
  if (error.kind === 'conflict') return `conflict:${error.entity}:${error.reason}`;
  if (error.kind === 'rate_limited')
    return `rate_limited:${error.reason}:${error.retryAfterSeconds}`;
  if (error.kind === 'unavailable') return `unavailable:${error.service}`;
  return `dependency:${error.port}:${error.cause}`;
}

const DOCUMENT_ANALYSIS_TYPE_LABEL: Readonly<Record<DocumentAnalysis['type'], string>> = {
  supplier_invoice: 'Facture fournisseur',
  receipt: 'Ticket ou reçu',
  bank_statement: 'Relevé bancaire',
  insurance_certificate: 'Attestation d’assurance',
  tax_or_social_document: 'Document fiscal ou social',
  contract: 'Contrat',
  company_record: 'Document de société',
  chantier_photo: 'Photo de chantier',
  accounting_document: 'Document comptable',
  other: 'Document à préciser',
};

const DOCUMENT_ANALYSIS_FOLDER_LABEL: Readonly<Record<DocumentFolderSystemKey, string>> = {
  projects: 'Chantiers',
  purchases: 'Achats',
  insurance: 'Assurances',
  tax_social: 'Fiscal et social',
  bank: 'Banque',
  accounting: 'Comptable',
};

const DOCUMENT_ANALYSIS_FACT_LABEL: Readonly<
  Record<DocumentAnalysis['facts'][number]['key'], string>
> = {
  issuer_name: 'Émetteur',
  recipient_name: 'Destinataire',
  supplier_name: 'Fournisseur',
  customer_name: 'Client',
  company_name: 'Société',
  document_number: 'Numéro',
  contract_number: 'Contrat',
  policy_number: 'Police',
  bank_name: 'Banque',
  account_reference: 'Compte',
  iban_masked: 'IBAN masqué',
  siren: 'SIREN',
  siret: 'SIRET',
  fiscal_period: 'Période fiscale',
  subject: 'Objet',
  chantier_name: 'Chantier',
  document_date: 'Date',
  due_date: 'Échéance',
  period_start: 'Début de période',
  period_end: 'Fin de période',
  coverage_start: 'Début de couverture',
  coverage_end: 'Fin de couverture',
  expiry_date: 'Expiration',
  total_ht: 'Total HT',
  vat_amount: 'TVA',
  total_ttc: 'Total TTC',
  amount_due: 'Montant dû',
  account_balance: 'Solde',
  tax_amount: 'Impôt ou cotisation',
  vat_rate: 'Taux de TVA',
};

function documentAnalysisFactValue(fact: DocumentAnalysis['facts'][number]): string {
  if (fact.valueType === 'money') {
    return fact.value.currency === 'EUR'
      ? formatEUR(fact.value.amountMinor)
      : `${(fact.value.amountMinor / 100).toFixed(2)} ${fact.value.currency}`;
  }
  if (fact.valueType === 'percentage') return `${fact.value} %`;
  if (fact.valueType === 'date') return frDateLabel(fact.value);
  return fact.value;
}

const AGENT_PROPOSAL_TTL_MS = 10 * 60 * 1_000;
const AGENT_PROPOSAL_ID = /^[A-Za-z0-9_-]{8,160}$/;
const AGENT_PROPOSAL_OWNER_TOOL = '__proposal_owner__';

interface OwnedAgentProposal {
  readonly proposalId: string;
  readonly planned: readonly JournalEntry[];
  readonly expiresAt: string;
}
// Fermé par défaut : n'ajouter un outil qu'après câblage serveur ET test agent → outbox.
// · envoyer_devis — sendQuote enfile dans l'outbox NotificationDelivery (worker idempotent).
// · envoyer_relance — l'adapter agent serveur (buildBobActions.sendRelance) délègue au MÊME
//   RelanceService.sendRelanceForInvoice que POST /invoices/:id/relance : enqueue transactionnel
//   (dedupeKey quotidienne) puis livraison par le worker — aucun réseau tiers dans la transaction.
//   Couvert par le test /ai/ask → /ai/confirm de pont-serveur.test.ts.
const AGENT_OUTBOX_SAFE_TOOLS = new Set(['envoyer_devis', 'envoyer_relance']);
const VOICE_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
const VOICE_AUDIO_MAX_BASE64_CHARS = Math.ceil(VOICE_AUDIO_MAX_BYTES / 3) * 4;
const VOICE_AUDIO_MIME_TYPES = new Set([
  'audio/m4a',
  'audio/mp4',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
]);
const BASE64_PAYLOAD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function addMinutesIso(instant: string, minutes: number): string {
  const d = new Date(instant);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

function nextArchiveRetryAt(now: string, attempts: number): string {
  const delayMinutes = Math.min(60, Math.max(1, 2 ** attempts));
  return addMinutesIso(now, delayMinutes);
}

/** Origine durcie de sign-web, commune à toutes les routes publiques tokenisées (signature ET
 *  visualisation) : HTTPS live canonique, jamais localhost/demo, jamais de credentials/query/hash
 *  embarqués dans l'URL de base. */
function signWebOrigin(purpose: string): URL {
  const configured = process.env.SIGN_WEB_BASE_URL?.trim();
  if (!configured) throw new Error(`SIGN_WEB_BASE_URL est requis pour créer ${purpose}.`);
  const base = new URL(configured);
  if (
    base.protocol !== 'https:' ||
    base.hostname === 'localhost' ||
    base.hostname === '127.0.0.1' ||
    base.hostname === 'demo.bobpro.fr' ||
    base.username !== '' ||
    base.password !== '' ||
    base.search !== '' ||
    base.hash !== ''
  ) {
    throw new Error('SIGN_WEB_BASE_URL doit être une origine HTTPS live canonique.');
  }
  return base;
}

function signWebPublicUrl(segment: string, token: string): string {
  const base = signWebOrigin(
    segment === 'sign' ? 'un lien de signature' : 'un lien de consultation',
  );
  return new URL(
    `${segment}/${encodeURIComponent(token)}`,
    base.toString().endsWith('/') ? base : `${base}/`,
  ).toString();
}

function publicSignatureUrl(token: string): string {
  return signWebPublicUrl('sign', token);
}

/** Même origine durcie que `publicSignatureUrl` (sign-web) — route de VISUALISATION distincte
 *  (`/view/:token`, sans capacité de signature). */
function publicDocumentViewUrl(token: string): string {
  return signWebPublicUrl('view', token);
}

/** A3 — URL publique de la FONCTIONNALITÉ DE RÉTRACTATION en ligne (`/retract/:token`,
 *  art. L221-21 dernier al. c. conso) — même origine durcie que la signature. */
function publicRetractationUrl(token: string): string {
  return signWebPublicUrl('retract', token);
}

function paymentReturnUrl(path: string): string {
  const configured = process.env.PAYMENT_RETURN_BASE_URL?.trim();
  if (!configured) throw new Error('PAYMENT_RETURN_BASE_URL est requis pour le paiement live.');
  const base = configured.endsWith('/') ? configured : `${configured}/`;
  const url = new URL(path.replace(/^\//u, ''), base);
  if (url.protocol !== 'https:' || url.hostname === 'demo.bobpro.fr') {
    throw new Error('PAYMENT_RETURN_BASE_URL doit cibler une origine HTTPS live.');
  }
  return url.toString();
}

function notificationDedupeHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Le calendrier ne reçoit une clôture comme certaine que lorsqu'elle vient d'une source fiable
 * ou d'une confirmation du propriétaire. Une hypothèse persistée reste une hypothèse : la
 * convertir en « 12-31 » ferait perdre sa provenance et présenterait une date supposée comme un
 * fait. `null` confirmé signifie explicitement exercice civil.
 */
function confirmedFiscalYearEnd(profile: FiscalProfileView): string | null {
  const datum = profile.fiscalYearEnd;
  if (datum.status !== 'source_fiable' && datum.status !== 'confirme_utilisateur') return null;
  if (datum.value === null) return '12-31';
  return `${String(datum.value.month).padStart(2, '0')}-${String(datum.value.day).padStart(2, '0')}`;
}

/** Version historique conservée pour reprendre les scans dont la réponse Expense s'est perdue. */
function documentExpenseCreationKey(documentSha256: string): string {
  return `mobile:document-expense:v1:${documentSha256}`;
}

/** Options d'exécution non sérialisables : réservées aux transports serveur de confiance. */
export interface AgentExecutionOptions {
  readonly signal?: AbortSignal;
}

/**
 * Autorité serveur : wire les use cases du domaine sur le bundle Persistence injecté.
 * Le runtime de production est Prisma/PostgreSQL et échoue fermé si une dépendance manque.
 */
@Injectable()
export class BackendService {
  private readonly ids = new UuidGenerator();
  private readonly clock: ClockPort = new SystemClock();
  // Recherche d'entreprise par SIRET (API publique gratuite) — autofill onboarding/client.
  private readonly companyLookup: CompanyLookupPort = new RechercheEntreprisesAdapter();
  // Validation TVA (VIES) + autocomplétion d'adresse (BAN) — APIs publiques gratuites.
  private readonly vat: VatValidationPort = new ViesVatAdapter();
  private readonly addresses: AddressAutocompletePort = new BanAddressAdapter();
  // Les routes vocales historiques suivent le même profil mono-fournisseur que Bob Live.
  private readonly stt = buildSttCloud();
  private readonly tts = buildTtsCloud();

  /**
   * Tenant courant : companyId du Principal posé par le guard. Principal absent ou sans tenant =
   * bug d'ordonnancement — le
   * guard répond 403 PROVISIONING_REQUIRED avant : on échoue explicitement (C24b, zéro repli).
   */
  private companyId(): string {
    return requireTenant();
  }

  /**
   * Jour calendaire MÉTIER (Europe/Paris) — SOURCE UNIQUE des bornes « aujourd'hui » françaises
   * de ce service (retards, échéances fiscales, validité de devis, mois URSSAF…). Jamais
   * `clock.today()` (UTC brut, en retard d'1-2 h sur Paris juste après minuit local) pour une
   * comparaison calendrier : même décision que GetCashflow (@bob/core, « Audit correction 3 »).
   * Les horodatages techniques (leases, tokens, audits) restent sur `clock.now()`/`today()`.
   */
  private businessToday(): string {
    return parisDateOnly(this.clock.now());
  }

  /**
   * Autorité unique des capacités payantes, alignée sur GetSubscriptionStatus (@bob/core) :
   * une ligne `subscriptions` fait foi. Les tenants historiques ont un accès anticipé réellement
   * persisté par migration (`store='none'`). Une ligne absente est une incohérence de provisioning,
   * jamais l'autorisation de fabriquer un abonnement Business en mémoire.
   * Un essai expiré est ramené au palier gratuit pour l'enforcement, sans modifier silencieusement
   * la ligne (l'atterrissage persistant reste la responsabilité du workflow d'abonnement).
   */
  private async subscriptionFor(companyId: string): Promise<Result<Subscription, AppError>> {
    // Sous FORCE RLS, une lecture hors transaction tenant (routes @WithoutTenantPersistenceTransaction)
    // masque la ligne et fabrique un faux « subscription-record » 503 — runWithTenant est réentrant.
    const record = await this.p.runWithTenant(companyId, () =>
      this.p.subscriptions.findByCompanyId(companyId),
    );
    if (record === null) return err(appUnavailable('subscription-record'));

    const trialExpired =
      record.status === 'trialing' &&
      record.trialEndsAt !== null &&
      Date.parse(record.trialEndsAt) <= Date.parse(this.clock.now());
    const started = Subscription.start({
      id: record.id,
      companyId: record.companyId,
      tier: trialExpired ? 'free' : record.plan,
      status: trialExpired ? 'active' : record.status,
      ...(record.currentPeriodEnd === null ? {} : { currentPeriodEnd: record.currentPeriodEnd }),
    });
    if (!started.ok) return err(appDomain(started.error));
    return ok(started.value);
  }

  /**
   * Preuve tenant-scoped des cibles polymorphes du coffre. runWithTenant est obligatoire ici :
   * upload/intake désactivent volontairement la transaction HTTP pendant l'I/O objet.
   */
  private documentLinkTargets(): DocumentLinkTargetPort {
    const targets = new RepositoryDocumentLinkTargets({
      company: this.p.companies,
      invoice: this.p.invoices,
      quote: this.p.quotes,
      expense: this.p.expenses,
      chantier: this.p.chantiers,
    });
    return {
      exists: (input) => this.p.runWithTenant(input.companyId, () => targets.exists(input)),
    };
  }

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(OCR_PORT) private readonly ocr: OcrPort,
    @Inject(SUPABASE_ADMIN) private readonly supabaseAdmin: SupabaseAdminPort,
    private readonly notificationDelivery: NotificationDeliveryService,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    @Inject(DOCUMENT_INTELLIGENCE_PORT)
    private readonly documentIntelligence: DocumentIntelligencePort = new UnavailableDocumentIntelligence(),
    @Inject(DOCUMENT_STORAGE)
    private readonly documentStorage: DocumentStoragePort = new UnavailableDocumentStorage(),
    @Optional()
    private readonly stripeBilling: StripeBillingService | null = null,
    // M2 — action hôte envoyer_relance : MÊME service (et mêmes gardes « facture relançable /
    // email client ») que POST /invoices/:id/relance. forwardRef : RelanceService injecte déjà
    // BackendService (entitlement auto_dunning) — cycle DI assumé et résolu des deux côtés.
    // Optionnel : un harness sans relances n'expose simplement pas l'action (l'outil vocal
    // n'apparaît pas au registre — jamais un stub silencieux).
    @Optional()
    @Inject(forwardRef(() => RelanceService))
    private readonly relances: RelanceService | null = null,
  ) {}

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
      purchaseOrder: q.purchaseOrder ? { ...q.purchaseOrder } : null,
      revision: q.revision,
      // Exception dépannage urgent : les clients affichent le LegalHint adapté (pas d'embargo).
      urgentRepair: q.urgentRepair ? { ...q.urgentRepair } : null,
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
      lines: i.lines.map((l) => ({ ...l })),
      depositDeductionCents: i.depositDeductionCents,
      depositInvoiceId: i.depositInvoiceId,
      purchaseOrder: i.purchaseOrder ? { ...i.purchaseOrder } : null,
      revision: i.revision,
      // E3 : le getter du domaine clone déjà le snapshot ; null = pièce ordinaire.
      creditNoteSource: i.creditNoteSource,
    };
  }

  listCustomers() {
    return new ListCustomers({
      customers: this.p.customers,
      invoices: this.p.invoices,
      payments: this.p.payments,
    }).execute({
      companyId: this.companyId(),
    });
  }
  /**
   * Sonde de readiness (/health/ready) : exerce la persistance SANS tenant — aucun Principal
   * n'est posé sur /health (guard pass-through) et aucune persistance de secours n'existe.
   * Le tenant sonde n'existe pas : seul l'aller-retour persistance compte (RLS → liste vide).
   */
  async readiness(): Promise<Result<{ customers: number }, AppError>> {
    const list = await this.p.customers.listByCompany('readiness-probe');
    return ok({ customers: list.length });
  }
  latestQualifiedBankBalance(): Promise<Result<QualifiedBankBalanceSnapshot, AppError>> {
    return new GetLatestQualifiedBankBalance({
      balances: this.p.bankBalances,
      clock: this.clock,
      freshnessPolicy: BANK_BALANCE_FRESHNESS_POLICY_V1,
    }).execute({ companyId: this.companyId() });
  }

  async recordManualBankBalance(input: {
    amountCents: number;
    observedAt: string;
  }): Promise<Result<QualifiedBankBalanceSnapshot, AppError>> {
    const created = await new CreateBankBalanceSnapshot({
      balances: this.p.bankBalances,
      clock: this.clock,
    }).execute({
      id: this.ids.newId(),
      companyId: this.companyId(),
      amountCents: input.amountCents,
      currency: 'EUR',
      source: 'manual_confirmed',
      reconciliationStatus: 'unreconciled',
      observedAt: input.observedAt,
    });
    if (!created.ok) return created;
    return this.latestQualifiedBankBalance();
  }

  async getCashflow(
    scenario: Scenario,
    horizon: Horizon,
  ): Promise<Result<CashflowProjection, AppError>> {
    const companyId = this.companyId();
    const balance = await new GetLatestQualifiedBankBalance({
      balances: this.p.bankBalances,
      clock: this.clock,
      freshnessPolicy: BANK_BALANCE_FRESHNESS_POLICY_V1,
    }).execute({ companyId });

    const invoices = await this.p.invoices.listByCompany(companyId);
    let bankBalanceCents: number;
    let bankingSource: 'qualified_snapshot' | 'none';
    if (balance.ok) {
      bankBalanceCents = balance.value.amountCents;
      bankingSource = 'qualified_snapshot';
    } else if (balance.error.kind === 'not_found') {
      // Tenant VIERGE (aucune observation bancaire ET aucun document financier) : état NORMAL,
      // pas une panne — projection vide honnête à zéro marquée `bankingSource: 'none'` (contrat
      // CashflowProjection @bob/core). Bob vocal, lui, continue de refuser d'annoncer un montant
      // sur cet état (garde `bankingSource === 'none'` des actions computePayout/ownerPay).
      const expenses = await this.p.expenses.listByCompany(companyId);
      if (invoices.length > 0 || expenses.length > 0) {
        // Dès qu'un document financier existe, une projection posée sur un zéro inventé serait
        // un mensonge : fail-closed inchangé, le client déclenche la confirmation du solde.
        return err(appUnavailable('cashflow-banking-source'));
      }
      bankBalanceCents = 0;
      bankingSource = 'none';
    } else {
      // Observation périmée/qualification : fail-closed inchangé (bank-balance-stale & co) —
      // une vieille vérité n'est pas une vérité, le mobile déclenche la confirmation du solde.
      return balance;
    }

    const receivables = deriveKnownReceivables({
      companyId,
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        companyId: invoice.companyId,
        kind: invoice.kind,
        status: invoice.status,
        netToPayCents: invoice.totals().netToPay,
        paidCents: invoice.paid,
      })),
    });
    if (!receivables.ok) return err(appUnavailable('cashflow-financial-data'));

    const snapshots = {
      get: async (requestedCompanyId: string) => {
        if (requestedCompanyId !== companyId) throw new Error('CASHFLOW_TENANT_SCOPE_MISMATCH');
        return {
          bankBalance: bankBalanceCents,
          receivables: receivables.value.receivablesCents,
          // Un excédent d'avoirs est une dette connue envers les clients, pas un encours négatif.
          charges: receivables.value.customerCreditCents,
        };
      },
    };
    const projected = await new GetCashflow({
      snapshots,
      expenses: this.p.expenses,
      invoices: this.p.invoices,
      clock: this.clock,
    }).execute({ companyId, scenario, horizon });
    if (!projected.ok) return projected;
    return ok({ ...projected.value, bankingSource });
  }
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>) {
    return new QuoteCreationCoordinator({
      persistence: this.p,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId(), quote: input });
  }
  async sendQuote(quoteId: string): Promise<
    Result<
      {
        number: string;
        signatureToken?: string;
        signatureTokenExpiresAt?: string;
        /** R4 : URL publique sign-web PRÊTE À PARTAGER (même construction que le lien envoyé par
         *  e-mail, `publicSignatureUrl` ci-dessous) — le client mobile n'a jamais à connaître
         *  SIGN_WEB_BASE_URL ni à reconstruire le chemin lui-même. */
        signatureUrl?: string;
        deliveryStatus: 'queued' | 'sent' | 'skipped';
      },
      AppError
    >
  > {
    const quote = await this.ownedQuote(quoteId);
    if (!quote) return { ok: false as const, error: appNotFound('quote', quoteId) };
    const parties = await this.requiredDocumentParties(quote.companyId, quote.customerId);
    if (!parties.ok) return parties;
    const sent = await new SendQuote({
      companies: this.p.companies,
      quotes: this.p.quotes,
      counters: this.p.counters,
      uow: this.p,
      clock: this.clock,
    }).execute({
      quoteId,
    });
    if (!sent.ok) return sent;
    const token = await new CreateQuoteSignatureToken({
      companies: this.p.companies,
      quotes: this.p.quotes,
      publicAccessTokens: this.p.publicAccessTokens,
      uow: this.p,
      clock: this.clock,
    }).execute({ quoteId });
    if (token.ok) {
      this.logger.audit('quote.signature_token_created', {
        quoteId,
        expiresAt: token.value.expiresAt,
      });
      const deliveryStatus = await this.enqueueQuoteForSignature({
        quote,
        number: sent.value.number,
        token: token.value.token,
        companyName: parties.value.company.name,
        customerName: parties.value.customer.name,
        customerEmail: parties.value.customer.toProps().email ?? null,
      });
      return ok({
        ...sent.value,
        signatureToken: token.value.token,
        signatureTokenExpiresAt: token.value.expiresAt,
        signatureUrl: publicSignatureUrl(token.value.token),
        deliveryStatus,
      });
    }
    return ok({ ...sent.value, deliveryStatus: 'skipped' as const });
  }

  private async enqueueQuoteForSignature(input: {
    quote: Quote;
    number: string;
    token: string;
    companyName: string;
    customerName: string;
    customerEmail: string | null;
  }): Promise<'queued' | 'sent' | 'skipped'> {
    const { quote, number, token, companyName, customerName, customerEmail: email } = input;
    if (!email) {
      this.logger.audit('quote.email_skipped', {
        quoteId: quote.id,
        reason: 'customer_email_missing',
      });
      return 'skipped';
    }
    const job = await this.notificationDelivery.enqueue({
      companyId: quote.companyId,
      kind: 'quote-signature',
      dedupeKey: `quote:${quote.id}:signature-token:${notificationDedupeHash(token)}`,
      notification: {
        channel: 'email',
        to: email,
        subject: `Devis ${number} à signer`,
        body: [
          `Bonjour ${customerName},`,
          '',
          `${companyName} vous a envoyé le devis ${number}.`,
          'Vous pouvez le consulter et le signer ici :',
          publicSignatureUrl(token),
          '',
          'Ce lien est personnel. Si vous avez une question, répondez directement à votre prestataire.',
        ].join('\n'),
      },
    });
    if (job.status === 'done') return 'sent';
    // Outbox stricte : aucun réseau tiers dans la transaction HTTP. Le cron/worker ne voit
    // le job qu'après commit ; ses retries portent l'idempotencyKey persistée par enqueue().
    this.logger.audit('quote.email_queued', {
      quoteId: quote.id,
      number,
      to: email,
      jobId: job.id,
    });
    return 'queued';
  }
  /**
   * R4 — signature sur place (authentifiée). Le tracé du pad arrive en `proofDataUrl` : le
   * serveur en calcule le SHA-256 (preuve d'intégrité) et NE STOCKE PAS le dataURL lui-même
   * (V1 : hash + méta ; l'archivage de l'image est l'évolution suivante). SignQuote révoque
   * aussi, dans la même transaction, tous les liens publics actifs du devis.
   */
  async signQuote(input: {
    quoteId: string;
    signerName: string;
    proofDataUrl?: string;
    /** A3 — case « exécution immédiate des travaux » cochée par le client B2C (art. L221-25
     *  c. conso) au moment de signer sur place : tracée et horodatée dans la signature par
     *  SignQuote (ignorée pour un professionnel — aucun droit de rétractation à renoncer). */
    earlyExecutionRequested?: boolean;
  }) {
    if (!(await this.ownedQuote(input.quoteId)))
      return { ok: false as const, error: appNotFound('quote', input.quoteId) };
    let r: Result<SignQuoteOutput, AppError>;
    try {
      r = await this.p.runInTransaction(async () => {
        const signed = await new SignQuote({
          companies: this.p.companies,
          // A3 — le type du client (b2c) décide si la demande d'exécution anticipée est tracée.
          customers: this.p.customers,
          quotes: this.p.quotes,
          publicAccessTokens: this.p.publicAccessTokens,
          uow: this.p,
          clock: this.clock,
        }).execute({
          quoteId: input.quoteId,
          signerName: input.signerName,
          ...(input.proofDataUrl ? { proofSha256: sha256Hex(input.proofDataUrl) } : {}),
          ...(input.earlyExecutionRequested ? { earlyExecutionRequested: true } : {}),
        });
        if (!signed.ok) return signed;
        try {
          // A8 — outbox DANS la même transaction que la signature : un devis ne peut jamais
          // être signé-commité sans ordre durable d'archivage de son original (le contrat,
          // art. L213-1 c. conso ≥ 120 € B2C ; valeur probante art. 1366-1367 c. civ.) —
          // même doctrine que l'émission de facture (enqueueInvoiceArchive).
          await this.enqueueSignedQuoteArchive(this.companyId(), input.quoteId);
        } catch (error) {
          throw new RollbackAppError({
            kind: 'dependency',
            port: 'document-archive-outbox',
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        return signed;
      });
    } catch (e) {
      if (e instanceof RollbackAppError) return { ok: false as const, error: e.appError };
      throw e;
    }
    if (!r.ok) return r;
    // Jamais le nom du signataire ni le tracé dans les logs — corrélation technique seulement.
    this.logger.audit('quote.signed_onsite', {
      quoteId: input.quoteId,
      withProof: Boolean(input.proofDataUrl),
      // A3 — trace de l'ouverture de la fonctionnalité de rétractation (L221-21), sans jeton.
      retractationFunction: r.value.retractation !== null,
    });
    // Rendu + stockage APRÈS le commit de la signature (pattern factures : snapshot BDD sous
    // transaction, I/O d'archive hors transaction) ; le job outbox garantit le retry.
    await this.runDocumentArchiveJobs({ limit: 5 });
    // A3 — le jeton brut devient une URL sign-web : l'artisan la montre/transmet au client
    // (la fonctionnalité doit rester accessible pendant TOUT le délai — D221-5).
    return ok({
      status: r.value.status,
      retractation: r.value.retractation
        ? {
            url: publicRetractationUrl(r.value.retractation.token),
            expiresAt: r.value.retractation.expiresAt,
          }
        : null,
    });
  }

  /**
   * P0 R4 — « Envoyer le lien » ne doit RIEN envoyer : prépare/rotate le lien public de
   * signature SANS e-mail ni outbox (commande distincte de sendQuote). Annuler le partage
   * côté mobile = rien n'est parti ; l'ancien lien est révoqué par la rotation.
   */
  async createQuoteSignatureLink(
    quoteId: string,
  ): Promise<Result<{ signatureUrl: string; expiresAt: string }, AppError>> {
    if (!(await this.ownedQuote(quoteId)))
      return { ok: false as const, error: appNotFound('quote', quoteId) };
    const link = await new CreateQuoteSignatureLink({
      companies: this.p.companies,
      quotes: this.p.quotes,
      publicAccessTokens: this.p.publicAccessTokens,
      uow: this.p,
      clock: this.clock,
    }).execute({ quoteId });
    if (!link.ok) return link;
    this.logger.audit('quote.signature_link_created', { quoteId, expiresAt: link.value.expiresAt });
    return ok({
      signatureUrl: publicSignatureUrl(link.value.token),
      expiresAt: link.value.expiresAt,
    });
  }

  /**
   * Lien public de VISUALISATION (devis) — canal d'envoi universel, sans e-mail requis : la
   * pièce se partage par SMS/WhatsApp, le client la consulte et télécharge le PDF depuis son
   * téléphone. Même doctrine P0 R4 que createQuoteSignatureLink : AUCUN sortant, rotation à
   * chaque appel. Tout statut sauf brouillon (sent/viewed/signed/refused/expired) — une
   * consultation n'est jamais un engagement, contrairement à la signature.
   */
  async createQuoteViewLink(
    quoteId: string,
  ): Promise<Result<{ viewUrl: string; expiresAt: string }, AppError>> {
    if (!(await this.ownedQuote(quoteId)))
      return { ok: false as const, error: appNotFound('quote', quoteId) };
    const link = await new CreateDocumentViewLink({
      companies: this.p.companies,
      quotes: this.p.quotes,
      invoices: this.p.invoices,
      publicAccessTokens: this.p.publicAccessTokens,
      uow: this.p,
      clock: this.clock,
    }).execute({ kind: 'quote', id: quoteId });
    if (!link.ok) return link;
    this.logger.audit('quote.view_link_created', { quoteId, expiresAt: link.value.expiresAt });
    return ok({
      viewUrl: publicDocumentViewUrl(link.value.token),
      expiresAt: link.value.expiresAt,
    });
  }

  /**
   * Lien public de VISUALISATION (facture) — même doctrine que createQuoteViewLink. Guard :
   * facture ÉMISE uniquement (jamais un brouillon), appliqué par CreateDocumentViewLink.
   */
  async createInvoiceViewLink(
    invoiceId: string,
  ): Promise<Result<{ viewUrl: string; expiresAt: string }, AppError>> {
    if (!(await this.ownedInvoice(invoiceId)))
      return { ok: false as const, error: appNotFound('invoice', invoiceId) };
    const link = await new CreateDocumentViewLink({
      companies: this.p.companies,
      quotes: this.p.quotes,
      invoices: this.p.invoices,
      publicAccessTokens: this.p.publicAccessTokens,
      uow: this.p,
      clock: this.clock,
    }).execute({ kind: 'invoice', id: invoiceId });
    if (!link.ok) return link;
    this.logger.audit('invoice.view_link_created', { invoiceId, expiresAt: link.value.expiresAt });
    return ok({
      viewUrl: publicDocumentViewUrl(link.value.token),
      expiresAt: link.value.expiresAt,
    });
  }
  async refuseQuote(quoteId: string) {
    if (!(await this.ownedQuote(quoteId)))
      return { ok: false as const, error: appNotFound('quote', quoteId) };
    const r = await new RefuseQuote({
      quotes: this.p.quotes,
      publicAccessTokens: this.p.publicAccessTokens,
      uow: this.p,
      clock: this.clock,
    }).execute({ quoteId });
    if (r.ok) this.logger.audit('quote.refused', { quoteId, status: r.value.status });
    return r;
  }
  async generateInvoice(input: {
    quoteId: string;
    mode: 'deposit' | 'final';
    /** Override RESPONSABILISÉ de l'embargo L221-10 — flag EXPLICITE `true` uniquement (jamais
     *  implicite) : le serveur refuse toujours par défaut ; l'override est journalisé
     *  (payment.embargo_overridden) AVANT de produire la pièce, sinon l'action échoue. */
    embargoOverride?: boolean;
  }) {
    if (!(await this.ownedQuote(input.quoteId)))
      return { ok: false as const, error: appNotFound('quote', input.quoteId) };
    return new GenerateInvoiceFromQuote({
      quotes: this.p.quotes,
      invoices: this.p.invoices,
      // A3 — gel de rétractation : le use case relit le client (b2c ?) et compare le délai
      // L221-18 à l'horloge injectée avant d'autoriser la facture FINALE.
      customers: this.p.customers,
      ids: this.ids,
      clock: this.clock,
      audit: this.embargoOverrideAudit(),
    }).execute({
      quoteId: input.quoteId,
      mode: input.mode,
      // Jamais implicite : seul `true` strict traverse (tout autre payload est ignoré).
      embargoOverride: input.embargoOverride === true,
    });
  }

  /**
   * DÉFAUT LÉGAL du flow « encaisser » pendant l'embargo L221-10 : le MESSAGE au client est
   * PROGRAMMÉ au premier jour où le paiement peut légalement être demandé — job outbox durable
   * (`notBefore`, dédupé par devis), livré SEUL à l'échéance. HONNÊTETÉS structurelles :
   *  • le message n'embarque AUCUN lien de paiement (il n'existe pas encore) — il annonce que
   *    l'entreprise le transmet séparément, et l'artisan est notifié le jour même (push miroir
   *    + fil C25 à la livraison) pour l'envoyer ;
   *  • la PIÈCE visée dépend du devis : acompte si depositPct, sinon la FINALE — laquelle reste
   *    GELÉE pendant le délai de rétractation de 14 jours (L221-18, sauf exécution anticipée
   *    L221-25) : la date programmée honore ALORS le gel (max embargo/gel), jamais une promesse
   *    datée impossible à tenir ni un libellé « acompte » faux (sans acompte, netToPay = TTC) ;
   *  • le job est ANNULABLE (rétractation du client → annulation transactionnelle) et REVALIDÉ
   *    à la livraison (worker NotificationDelivery, garde par kind).
   * L'artisan garde l'alternative responsabilisée (`generateInvoice` + `embargoOverride: true`).
   */
  async scheduleEmbargoPayment(quoteId: string): Promise<
    Result<
      { scheduledFor: string; availableFrom: string; jobId: string; status: string },
      AppError
    >
  > {
    const quote = await this.ownedQuote(quoteId);
    if (!quote) return { ok: false as const, error: appNotFound('quote', quoteId) };
    const customer = await this.p.customers.findById(quote.customerId);
    if (!customer || customer.companyId !== quote.companyId)
      return { ok: false as const, error: appNotFound('customer', quote.customerId) };
    if (quote.retractedAt !== null) {
      return err<AppError>({
        kind: 'validation',
        issues: [
          { field: 'quoteId', message: 'Devis rétracté : plus aucun encaissement à programmer.' },
        ],
      });
    }
    const embargo = offPremisesPaymentEmbargo(
      { customerType: customer.type, signature: quote.signature, urgentRepair: quote.urgentRepair },
      this.clock.now(),
    );
    if (!embargo.active) {
      return err<AppError>({
        kind: 'validation',
        issues: [
          {
            field: 'quoteId',
            message:
              'Aucun embargo de paiement en cours sur ce devis — encaisse directement, rien à programmer.',
          },
        ],
      });
    }
    const email = customer.toProps().email ?? null;
    if (!email) {
      return err<AppError>({
        kind: 'validation',
        issues: [
          {
            field: 'customer.email',
            message:
              'Email du client manquant — complète sa fiche pour programmer l’envoi du lien de paiement.',
          },
        ],
      });
    }
    const company = await this.p.companies.findById(quote.companyId);
    if (!company) return { ok: false as const, error: appNotFound('company', quote.companyId) };
    const totals = quote.totals();
    // Pièce visée par l'invite : acompte si le devis signé en prévoit un, sinon la FINALE.
    const piece: 'deposit' | 'final' = quote.depositPct !== null ? 'deposit' : 'final';
    // Sans acompte, la pièce encaissable est la FINALE — gelée pendant le délai de rétractation
    // (L221-18, sauf demande expresse d'exécution anticipée L221-25) : la date programmée est
    // le PREMIER jour où la pièce est réellement exigible (max embargo / gel), jamais avant.
    let scheduledFor = embargo.expiresAt;
    let availableFrom = embargo.availableFrom;
    if (piece === 'final') {
      const freeze = retractationFreeze(
        deriveRetractation({ customerType: customer.type, signature: quote.signature }),
        this.clock.now(),
      );
      if (freeze.active && freeze.expiresAt > scheduledFor) {
        scheduledFor = freeze.expiresAt;
        availableFrom = freeze.availableFrom;
      }
    }
    const body = offPremisesEmbargoLiftedClientLines({
      companyName: company.name,
      quoteNumber: quote.number ?? quoteId,
      amountLabel: formatEUR(totals.netToPay),
      availableFrom,
      piece,
    }).join('\n\n');
    const job = await this.notificationDelivery.enqueue({
      companyId: quote.companyId,
      kind: 'embargo-scheduled-payment',
      // Un seul encaissement programmé par devis — rejouer la programmation est idempotent.
      // Clé PARTAGÉE avec l'annulation (rétractation) et la garde de livraison du worker.
      dedupeKey: embargoScheduledPaymentDedupeKey(quoteId),
      notification: {
        channel: 'email',
        to: email,
        subject: `Votre devis ${quote.number ?? ''} — règlement possible depuis le ${availableFrom.split('-').reverse().join('/')}`.trim(),
        body,
      },
      // Le job ne devient DÛ qu'au premier jour réellement exigible : il part seul à l'échéance.
      notBefore: scheduledFor,
    });
    this.logger.audit('payment.embargo_scheduled', {
      quoteId,
      piece,
      scheduledFor,
      availableFrom,
      jobId: job.id,
    });
    return ok({
      scheduledFor,
      availableFrom,
      jobId: job.id,
      status: job.status,
    });
  }

  /** Journal de l'override L221-10 (port core) — événement dédié, horodaté, structuré. */
  private embargoOverrideAudit(): EmbargoOverrideAuditPort {
    return {
      embargoOverridden: async (event) => {
        this.logger.audit('payment.embargo_overridden', {
          quoteId: event.quoteId,
          companyId: event.companyId,
          invoiceKind: event.invoiceKind,
          embargoExpiresAt: event.embargoExpiresAt,
          occurredAt: event.occurredAt,
        });
      },
    };
  }
  /** R6 : édition d'une ligne de devis BROUILLON (Quote.updateLine garde assertDraft). */
  async updateQuoteLine(input: {
    quoteId: string;
    lineId: string;
    patch: UpdateQuoteLineInput['patch'];
  }) {
    if (!(await this.ownedQuote(input.quoteId)))
      return { ok: false as const, error: appNotFound('quote', input.quoteId) };
    const r = await new UpdateQuoteLine({ quotes: this.p.quotes, uow: this.p }).execute(input);
    if (r.ok)
      this.logger.audit('quote.line_updated', { quoteId: input.quoteId, lineId: input.lineId });
    return r;
  }
  /** R6 : suppression d'une ligne de devis BROUILLON (Quote.removeLine garde assertDraft). */
  async removeQuoteLine(input: { quoteId: string; lineId: string }) {
    if (!(await this.ownedQuote(input.quoteId)))
      return { ok: false as const, error: appNotFound('quote', input.quoteId) };
    const r = await new RemoveQuoteLine({ quotes: this.p.quotes, uow: this.p }).execute(input);
    if (r.ok)
      this.logger.audit('quote.line_removed', { quoteId: input.quoteId, lineId: input.lineId });
    return r;
  }
  /** R6 : suppression définitive d'une facture BROUILLON (erreur détectée après génération). */
  async deleteDraftInvoice(invoiceId: string) {
    if (!(await this.ownedInvoice(invoiceId)))
      return { ok: false as const, error: appNotFound('invoice', invoiceId) };
    const r = await new DeleteDraftInvoice({ invoices: this.p.invoices, uow: this.p }).execute({
      invoiceId,
    });
    if (r.ok) this.logger.audit('invoice.draft_deleted', { invoiceId });
    return r;
  }

  // ——— B8 : bon de commande grands comptes (numéro d'engagement) ————————————————————————
  /**
   * Anti-IDOR applicatif : un `documentId` fourni doit désigner un document ACTIF du tenant
   * courant — sinon erreur de validation (la FK composite (companyId, documentId) reste la
   * ceinture de sécurité en base). `null`/absent = pas de document archivé, toujours accepté.
   */
  private async assertPurchaseOrderDocumentOwned(
    documentId: string | null | undefined,
  ): Promise<Result<void, AppError>> {
    if (documentId === null || documentId === undefined) return ok(undefined);
    const document = await this.p.documents.findById(this.companyId(), documentId);
    if (!document || document.status !== 'active') {
      return err<AppError>({
        kind: 'validation',
        issues: [{ field: 'documentId', message: 'Document de bon de commande introuvable.' }],
      });
    }
    return ok(undefined);
  }

  /**
   * PUT /quotes/:id/purchase-order — attache (ou remplace) le bon de commande d'un devis NON
   * FACTURÉ. Use case core (parité humain↔Bob), tenant-scoped, révision optimiste ; le CAS
   * final en base est garanti par le verrou de ligne (lockById) dans la transaction tenant.
   */
  async attachQuotePurchaseOrder(input: {
    quoteId: string;
    purchaseOrder: PurchaseOrderRefInput;
    expectedRevision: number;
  }): Promise<Result<PurchaseOrderMutationView, AppError>> {
    const documentOwned = await this.assertPurchaseOrderDocumentOwned(input.purchaseOrder.documentId);
    if (!documentOwned.ok) return documentOwned;
    const r = await new AttachPurchaseOrderToQuote({
      quotes: { findById: (id) => this.p.quotes.lockById(id), save: (q) => this.p.quotes.save(q) },
      invoices: this.p.invoices,
      clock: this.clock,
    }).execute({ companyId: this.companyId(), ...input });
    if (r.ok)
      this.logger.audit('quote.purchase_order_attached', {
        quoteId: input.quoteId,
        number: r.value.purchaseOrder?.number ?? null,
        revision: r.value.revision,
      });
    return r;
  }

  /** DELETE /quotes/:id/purchase-order — retrait EXPLICITE (devis non facturé uniquement). */
  async detachQuotePurchaseOrder(input: {
    quoteId: string;
    expectedRevision: number;
  }): Promise<Result<PurchaseOrderMutationView, AppError>> {
    const r = await new DetachPurchaseOrder({
      quotes: { findById: (id) => this.p.quotes.lockById(id), save: (q) => this.p.quotes.save(q) },
      invoices: this.p.invoices,
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      target: { type: 'quote', quoteId: input.quoteId },
      expectedRevision: input.expectedRevision,
    });
    if (r.ok)
      this.logger.audit('quote.purchase_order_detached', {
        quoteId: input.quoteId,
        revision: r.value.revision,
      });
    return r;
  }

  /** PUT /invoices/:id/purchase-order — facture BROUILLON uniquement (jamais après émission). */
  async attachInvoicePurchaseOrder(input: {
    invoiceId: string;
    purchaseOrder: PurchaseOrderRefInput;
    expectedRevision: number;
  }): Promise<Result<PurchaseOrderMutationView, AppError>> {
    const documentOwned = await this.assertPurchaseOrderDocumentOwned(input.purchaseOrder.documentId);
    if (!documentOwned.ok) return documentOwned;
    const r = await new AttachPurchaseOrderToInvoice({
      invoices: {
        findById: (id) => this.p.invoices.lockById(id),
        save: (i) => this.p.invoices.save(i),
      },
      clock: this.clock,
    }).execute({ companyId: this.companyId(), ...input });
    if (r.ok)
      this.logger.audit('invoice.purchase_order_attached', {
        invoiceId: input.invoiceId,
        number: r.value.purchaseOrder?.number ?? null,
        revision: r.value.revision,
      });
    return r;
  }

  /** DELETE /invoices/:id/purchase-order — retrait EXPLICITE (facture brouillon uniquement). */
  async detachInvoicePurchaseOrder(input: {
    invoiceId: string;
    expectedRevision: number;
  }): Promise<Result<PurchaseOrderMutationView, AppError>> {
    const r = await new DetachPurchaseOrder({
      quotes: this.p.quotes,
      invoices: {
        findById: (id) => this.p.invoices.lockById(id),
        save: (i) => this.p.invoices.save(i),
        listByCompany: (companyId) => this.p.invoices.listByCompany(companyId),
      },
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      target: { type: 'invoice', invoiceId: input.invoiceId },
      expectedRevision: input.expectedRevision,
    });
    if (r.ok)
      this.logger.audit('invoice.purchase_order_detached', {
        invoiceId: input.invoiceId,
        revision: r.value.revision,
      });
    return r;
  }

  async issueInvoice(input: {
    invoiceId: string;
    /** A7 — date/période de la prestation si distincte de l'émission (art. 242 nonies A CGI). */
    servicePeriod?: { start: string; end: string | null };
    /** A7 — adresse de chantier/livraison si distincte de la facturation. */
    deliveryAddress?: string;
    /** Override RESPONSABILISÉ de l'embargo L221-10 — `true` strict uniquement, journalisé. */
    embargoOverride?: boolean;
  }) {
    // Locator IDOR uniquement : aucune décision d'émission ne repose sur ce snapshot hors fence.
    const locator = await this.ownedInvoice(input.invoiceId);
    if (!locator) return { ok: false as const, error: appNotFound('invoice', input.invoiceId) };
    let r: Result<{ number: string }, AppError>;
    try {
      r = await this.p.runInTransaction(async () => {
        // Ordre global impératif : Company SHARE -> réglages -> Invoice UPDATE -> compteur.
        // CloseAccount prend Company UPDATE : aucune condition de paiement n'est donc lue, puis
        // utilisée, à cheval sur une clôture. Le use case reprend ensuite ce même verrou de façon
        // réentrante avant de figer le document et d'allouer son numéro légal.
        const company = await this.p.companies.lockForShareById(locator.companyId);
        let settings: CompanyBillingSettings | null | undefined;
        if (!company || company.isClosed()) {
          settings = undefined;
        } else {
          // Relire après le fence préserve le retry : si une émission concurrente a gagné depuis
          // le locator, le numéro existant est rendu sans dépendre d'un réglage supprimé/modifié.
          const currentInvoice = await this.p.invoices.findById(input.invoiceId);
          settings =
            currentInvoice !== null &&
            currentInvoice.companyId === company.id &&
            currentInvoice.number === null
              ? await this.p.billingSettings.findByCompanyId(company.id)
              : undefined;
        }
        const paymentTermsDays = settings?.defaultInvoicePaymentTermsDays;
        // A7 : les données d'émission (période de prestation, adresse de chantier) suivent
        // TOUJOURS — elles sont validées puis figées par le domaine (Invoice.issue).
        const emissionData = {
          ...(input.servicePeriod === undefined ? {} : { servicePeriod: input.servicePeriod }),
          ...(input.deliveryAddress === undefined ? {} : { deliveryAddress: input.deliveryAddress }),
        };
        const issueInput: {
          invoiceId: string;
          terms?: { days: number; endOfMonth: boolean; label: string };
          servicePeriod?: { start: string; end: string | null };
          deliveryAddress?: string;
          embargoOverride?: boolean;
        } =
          paymentTermsDays === null || paymentTermsDays === undefined
            ? { invoiceId: input.invoiceId, ...emissionData }
            : {
                invoiceId: input.invoiceId,
                ...emissionData,
                terms: {
                  days: paymentTermsDays,
                  endOfMonth: false,
                  label: `Paiement à ${paymentTermsDays} jours`,
                },
              };
        // Jamais implicite : seul `true` strict traverse jusqu'au use case (qui journalise).
        if (input.embargoOverride === true) issueInput.embargoOverride = true;

        const issued = await new IssueInvoice({
          invoices: this.p.invoices,
          companies: this.p.companies,
          customers: this.p.customers,
          // A3 — revérification du gel/embargo à l'émission pour les pièces dérivées d'un devis.
          quotes: this.p.quotes,
          counters: this.p.counters,
          uow: this.p,
          clock: this.clock,
          audit: this.embargoOverrideAudit(),
        }).execute(issueInput);
        if (!issued.ok) {
          const missingTerms =
            issueInput.terms === undefined &&
            issued.error.kind === 'validation' &&
            issued.error.issues.some((issue) => issue.field === 'paymentTerms');
          if (missingTerms && settings === null) {
            return err(appUnavailable('company-billing-settings'));
          }
          if (missingTerms && settings !== undefined) {
            return err<AppError>({
              kind: 'validation',
              issues: [
                {
                  field: 'paymentTerms',
                  message: 'Choisissez vos conditions de paiement avant d’émettre cette facture.',
                },
              ],
            });
          }
          return issued;
        }
        const accounting = await new RecordIssuedInvoiceAccountingEntry({
          invoices: this.p.invoices,
          entries: this.p.accountingEntries,
          charts: this.p.chartOfAccounts,
        }).execute(input);
        if (!accounting.ok) throw new RollbackAppError(accounting.error);
        this.logger.audit('accounting.invoice_posted', {
          invoiceId: input.invoiceId,
          entryId: accounting.value.id,
          created: accounting.value.created,
        });
        try {
          // Outbox DANS la même transaction que le numéro légal et l'écriture comptable : une
          // facture ne peut jamais être commitée sans ordre durable d'archivage de son original.
          await this.enqueueInvoiceArchive(input.invoiceId);
        } catch (error) {
          throw new RollbackAppError({
            kind: 'dependency',
            port: 'document-archive-outbox',
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        return issued;
      });
    } catch (e) {
      if (e instanceof RollbackAppError) return { ok: false as const, error: e.appError };
      throw e;
    }
    if (r.ok) {
      this.logger.audit('invoice.issued', { invoiceId: input.invoiceId, number: r.value.number });
      await this.runDocumentArchiveJobs({ limit: 5 });
    }
    return r;
  }
  async registerPayment(input: {
    invoiceId: string;
    amount: number;
    method: PaymentMethod;
    idempotencyKey?: string | null;
  }) {
    if (!(await this.ownedInvoice(input.invoiceId)))
      return { ok: false as const, error: appNotFound('invoice', input.invoiceId) };
    let accountingAlreadyChecked = false;
    const postPaymentAccounting = async (paymentId: string) => {
      const accounting = await new RecordPaymentAccountingEntry({
        invoices: this.p.invoices,
        payments: this.p.payments,
        entries: this.p.accountingEntries,
        charts: this.p.chartOfAccounts,
      }).execute({ companyId: this.companyId(), paymentId });
      if (accounting.ok) {
        accountingAlreadyChecked = true;
        if (accounting.value.created)
          this.logger.audit('accounting.payment_posted', {
            invoiceId: input.invoiceId,
            paymentId,
            entryId: accounting.value.id,
            created: accounting.value.created,
          });
      }
      return accounting;
    };
    const r = await new RegisterPayment({
      invoices: this.p.invoices,
      payments: this.p.payments,
      uow: this.p,
      ids: this.ids,
      clock: this.clock,
      afterPaymentRecorded: ({ paymentId }) => postPaymentAccounting(paymentId),
    }).execute(input);
    if (r.ok && !accountingAlreadyChecked) {
      const accounting = await postPaymentAccounting(r.value.paymentId);
      if (!accounting.ok) return { ok: false as const, error: accounting.error };
    }
    if (r.ok)
      this.logger.audit('payment.registered', {
        invoiceId: input.invoiceId,
        paymentId: r.value.paymentId,
        amount: input.amount,
        status: r.value.status,
      });
    return r;
  }
  // ——— Garde multi-tenant : un accès par id n'est valide que si l'agrégat appartient au tenant courant.
  // On renvoie null (=> not_found) plutôt qu'une erreur d'autorisation, pour ne pas divulguer l'existence.
  private async ownedQuote(id: string): Promise<Quote | null> {
    const q = await this.p.quotes.findById(id);
    return q && q.companyId === this.companyId() ? q : null;
  }
  private async ownedInvoice(id: string): Promise<Invoice | null> {
    const i = await this.p.invoices.findById(id);
    return i && i.companyId === this.companyId() ? i : null;
  }
  private async ownedExpense(id: string): Promise<Expense | null> {
    const e = await this.p.expenses.findById(id);
    return e && e.companyId === this.companyId() ? e : null;
  }

  async getQuote(id: string): Promise<Result<QuoteView, AppError>> {
    const q = await this.ownedQuote(id);
    if (!q) return { ok: false, error: appNotFound('quote', id) };
    return ok(this.mapQuote(q));
  }
  async listQuotes(): Promise<Result<QuoteView[], AppError>> {
    const list = await this.p.quotes.listByCompany(this.companyId());
    return ok(list.map((q) => this.mapQuote(q)));
  }
  async getInvoice(id: string): Promise<Result<InvoiceView, AppError>> {
    const i = await this.ownedInvoice(id);
    if (!i) return { ok: false, error: appNotFound('invoice', id) };
    return ok(this.mapInvoice(i));
  }

  async invoiceAccountingPreview(
    invoiceId: string,
  ): Promise<Result<InvoiceAccountingPreview, AppError>> {
    const invoice = await this.ownedInvoice(invoiceId);
    if (!invoice) return { ok: false, error: appNotFound('invoice', invoiceId) };
    const chart = await this.p.chartOfAccounts.findByCompany(invoice.companyId);
    const entry = buildInvoiceAccountingPreviewEntry({
      entryId: `preview-invoice-${invoice.id}`,
      invoice,
      // Aperçu daté du jour MÉTIER Paris : cohérent avec la date d'émission réelle (IssueInvoice).
      entryDate: this.businessToday(),
      reference: invoice.number ?? 'a-emettre',
      ...(chart ? { chart } : {}),
    });
    if (!entry.ok) {
      const detail =
        'message' in entry.error && typeof entry.error.message === 'string'
          ? entry.error.message.trim()
          : '';
      return ok({
        invoiceId,
        available: false,
        reason: detail || 'Aperçu comptable indisponible.',
      });
    }
    const props = entry.value.toProps();
    return ok({
      invoiceId,
      available: true,
      entryId: props.id,
      reference: props.reference,
      entryDate: props.entryDate,
      label: props.label,
      totalDebitCents: entry.value.totalDebitCents,
      totalCreditCents: entry.value.totalCreditCents,
      lines: props.lines,
    });
  }

  paymentAccountingPreview(input: {
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
  }) {
    return new PreviewPaymentAccountingEntry({
      invoices: this.p.invoices,
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
      method: input.method,
    });
  }

  async listInvoices(): Promise<Result<InvoiceView[], AppError>> {
    const list = await this.p.invoices.listByCompany(this.companyId());
    return ok(list.map((i) => this.mapInvoice(i)));
  }

  /** B9 — GET /documents/search : « retrouve les devis de Mairie de Sèvres du mois dernier ».
   * Validation de FORME uniquement (dates/scope) — le tri/filtre/ranking métier vit dans le port
   * (pertinence pg_trgm côté Postgres, cf. sales-document-search.repository.ts). */
  async searchSalesDocuments(
    input: SearchSalesDocumentsInput,
  ): Promise<Result<SearchSalesDocumentsResult, AppError>> {
    const issues: { field: string; message: string }[] = [];
    if (input.from !== undefined && !isValidDateOnly(input.from))
      issues.push({ field: 'from', message: 'Date de début invalide.' });
    if (input.to !== undefined && !isValidDateOnly(input.to))
      issues.push({ field: 'to', message: 'Date de fin invalide.' });
    if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
      issues.push({ field: 'to', message: 'La date de fin doit suivre la date de début.' });
    }
    if (issues.length > 0) return { ok: false, error: { kind: 'validation', issues } };
    const result = await this.p.salesDocumentSearch.search({
      ...input,
      companyId: this.companyId(),
    });
    return ok(result);
  }

  /** B9 — GET /documents/suggest : autocomplétion typée (client/numéro/libellé), LIMIT 8. */
  async suggestSalesDocuments(
    input: SuggestSalesDocumentsInput,
  ): Promise<Result<SuggestSalesDocumentsResult, AppError>> {
    const result = await this.p.salesDocumentSearch.suggest({
      ...input,
      companyId: this.companyId(),
    });
    return ok(result);
  }

  /** A6 (PONT-SERVEUR v1) : avoir TOTAL (brouillon) d'une facture émise — MÊME use case
   * CreateCreditNote (@bob/core) que toutes les surfaces ; l'avoir s'émet ensuite par issueInvoice
   * (numéro A- sans trou via CounterKey 'credit', écriture comptable inverse). */
  async createCreditNote(input: {
    invoiceId: string;
  }): Promise<Result<{ creditNoteId: string }, AppError>> {
    if (!(await this.ownedInvoice(input.invoiceId)))
      return { ok: false as const, error: appNotFound('invoice', input.invoiceId) };
    const r = await new CreateCreditNote({ invoices: this.p.invoices, ids: this.ids }).execute(
      input,
    );
    if (r.ok)
      this.logger.audit('invoice.credit_note_created', {
        invoiceId: input.invoiceId,
        creditNoteId: r.value.creditNoteId,
      });
    return r;
  }

  /** E3 (PONT-SERVEUR v1) : encaissements datés du tenant — socle du CA encaissé annuel (293 B),
   * de la balance âgée et de la prescription. */
  async listPayments(): Promise<Result<PaymentView[], AppError>> {
    const list = await this.p.payments.listByCompany(this.companyId());
    return ok(
      list.map((p) => ({
        id: p.id,
        invoiceId: p.invoiceId,
        amountCents: p.amount,
        method: p.method,
        receivedAt: p.receivedAt,
      })),
    );
  }

  async listAccountingEntries() {
    const subscription = await this.subscriptionFor(this.companyId());
    if (!subscription.ok) return subscription;
    if (!subscription.value.can('accounting_foundation')) {
      return Promise.resolve({
        ok: false as const,
        error: appForbidden("Le journal comptable est inclus à partir de l'offre Solo."),
      });
    }
    return new ListAccountingEntries({ entries: this.p.accountingEntries }).execute({
      companyId: this.companyId(),
    });
  }

  /**
   * Export FEC — pré-compta avancée (`accounting_operations`, Pro+), pattern ai_assistant.
   * Doctrine pilier 2 : la conformité de BASE (émettre une facture, exporter ses documents)
   * n'est JAMAIS bloquée ; seul le fichier probant FEC/clôture cabinet est gated. Les trois
   * routes /accounting/fec, /fec-description et /fec-metadata passent ici : un seul point
   * d'enforcement. En early-access (subscriptionFor = business pour tous), personne n'est refusé.
   */
  async exportFec(input: { from: string; to: string }) {
    const subscription = await this.subscriptionFor(this.companyId());
    if (!subscription.ok) return subscription;
    if (!subscription.value.can('accounting_operations'))
      return {
        ok: false as const,
        error: appForbidden("L'export comptable FEC est inclus à partir de l'offre Pro."),
      };
    return new ExportFec({
      companies: this.p.companies,
      entries: this.p.accountingEntries,
      charts: this.p.chartOfAccounts,
    }).execute({ companyId: this.companyId(), from: input.from, to: input.to });
  }

  private async resolveSignatureGrant(
    token: string,
  ): Promise<Result<ResolvedSignatureGrant, AppError>> {
    const resolved = await new ResolveQuoteSignatureToken({
      publicAccessTokens: this.p.publicAccessTokens,
      clock: this.clock,
    }).execute({ token });
    return resolved;
  }

  private async requiredDocumentParties(
    companyId: string,
    customerId: string,
  ): Promise<Result<{ company: Company; customer: Customer }, AppError>> {
    const [company, customer] = await Promise.all([
      this.p.companies.findById(companyId),
      this.p.customers.findById(customerId),
    ]);
    if (!company || !customer || customer.companyId !== companyId) {
      return err(appUnavailable('document-parties'));
    }
    return ok({ company, customer });
  }

  private async publicDocumentParties(
    company: Company,
    customerId: string,
  ): Promise<{ companyName: string; customerName: string } | null> {
    const customer = await this.p.customers.findById(customerId);
    if (!customer || customer.companyId !== company.id) return null;
    return { companyName: company.name, customerName: customer.name };
  }

  // ——— Signature client à distance (public, par lien tokenisé) ———
  /** Vue publique d'un devis par token opaque. */
  async publicQuoteForSignature(token: string): Promise<Result<SignatureView, AppError>> {
    const locator = await this.resolveSignatureGrant(token);
    if (!locator.ok) return locator;
    return this.p.runWithTenant(locator.value.companyId, async () => {
      const company = await this.p.companies.lockForShareById(locator.value.companyId);
      if (!company || company.isClosed()) {
        return err(appNotFound('public-signature-token', 'redacted'));
      }
      const q = await this.p.quotes.lockForShareById(locator.value.quoteId);
      if (!q || q.companyId !== company.id || q.number === null) {
        return err(appNotFound('public-signature-token', 'redacted'));
      }
      // Le locator hors transaction ne donne AUCUNE autorisation. Le grant exact est verrouillé
      // après company puis quote, dans la même transaction que la lecture et markUsed.
      const at = this.clock.now();
      const grant = await this.p.publicAccessTokens.lockActive(token, at);
      if (
        !grant ||
        grant.id !== locator.value.grantId ||
        grant.companyId !== company.id ||
        grant.resourceType !== 'quote' ||
        grant.resourceId !== q.id ||
        grant.scope !== 'quote_signature'
      ) {
        return err(appNotFound('public-signature-token', 'redacted'));
      }
      // A1 : l'agrégat client COMPLET est requis (pas seulement son nom) — les mentions
      // dépendent du type de client (médiateur B2C, SIREN B2B/B2G, pénalités pro).
      const customer = await this.p.customers.findById(q.customerId);
      if (!customer || customer.companyId !== company.id) {
        return err(appNotFound('public-signature-token', 'redacted'));
      }
      await this.p.publicAccessTokens.markUsed(grant.id, at);
      return ok({
        number: q.number,
        companyName: company.name,
        customerName: customer.name,
        status: q.status,
        signed: q.signature !== null,
        // Validité = calendrier FRANÇAIS : borne au jour métier Paris (cf. businessToday()).
        expired: q.validUntil !== null && q.validUntil < this.businessToday(),
        validUntil: q.validUntil,
        lines: q.lines.map((l) => ({
          label: l.label,
          qty: l.qty,
          unitPriceHT: l.unitPriceHT,
          vatRate: l.vatRate,
        })),
        totals: q.totals(),
        // A1 — le MÊME bloc mentions que le PDF du devis (source unique : quoteMentions).
        mentions: this.quoteMentions(q, company, customer),
        // A3 — information rétractation AVANT signature + libellé exact de la case L221-25 :
        // uniquement pour un CONSOMMATEUR (b2c) — un professionnel n'a pas ce droit.
        retractation:
          customer.type === 'b2c'
            ? {
                // A3 — l'avis servi à la page de signature mentionne aussi la fonctionnalité
                // en ligne (L221-5, 7°) : le client la voit AVANT de conclure. Même source
                // unique que le PDF (bloc urgent en tête quand l'exception est tracée).
                noticeLines: this.quoteRetractationBlock(q, company).noticeLines,
                earlyExecutionLabel: RETRACTATION_EARLY_EXECUTION_LABEL,
              }
            : null,
      });
    });
  }

  async publicSignQuote(
    token: string,
    signerName: string,
    proofDataUrl?: string,
    /** A3 — case « exécution immédiate des travaux » cochée par le client B2C sur la page
     *  sign-web AVANT de signer (art. L221-25 c. conso) : tracée et horodatée serveur dans la
     *  signature par SignQuote — jamais déduite, ignorée pour un professionnel. */
    earlyExecutionRequested?: boolean,
  ): Promise<
    Result<
      {
        status: string;
        /** A3 — fonctionnalité de rétractation en ligne (L221-21) ouverte à la signature d'un
         *  devis B2C : URL personnelle du client, valable toute la durée du délai. Null = pro. */
        retractation: { url: string; expiresAt: string } | null;
      },
      AppError
    >
  > {
    // Résolution initiale HORS transaction : elle ne sert qu'à connaître le tenant (runWithTenant)
    // et à refuser tôt un jeton mort. L'autorisation qui compte est revalidée sous les verrous
    // company → quote → grant ci-dessous ; SignQuote la revalide encore en défense en profondeur.
    const locator = await this.resolveSignatureGrant(token);
    if (!locator.ok) return locator;
    let signedResult: Result<SignQuoteOutput, AppError>;
    try {
      signedResult = await this.p.runWithTenant(locator.value.companyId, async () => {
        const company = await this.p.companies.lockForShareById(locator.value.companyId);
        if (!company || company.isClosed()) {
          return err(appNotFound('public-signature-token', 'redacted'));
        }
        const q = await this.p.quotes.lockById(locator.value.quoteId);
        if (!q || q.companyId !== company.id) {
          return err(appNotFound('public-signature-token', 'redacted'));
        }
        const grant = await this.p.publicAccessTokens.lockActive(token, this.clock.now());
        if (
          !grant ||
          grant.id !== locator.value.grantId ||
          grant.companyId !== company.id ||
          grant.resourceType !== 'quote' ||
          grant.resourceId !== q.id ||
          grant.scope !== 'quote_signature'
        ) {
          return err(appNotFound('public-signature-token', 'redacted'));
        }
        if (q.validUntil !== null && q.validUntil < this.businessToday()) {
          const expired = await new ExpireQuote({
            quotes: this.p.quotes,
            publicAccessTokens: this.p.publicAccessTokens,
            uow: this.p,
            clock: this.clock,
          }).execute({ quoteId: q.id });
          if (expired.ok)
            this.logger.audit('quote.expired', {
              quoteId: q.id,
              status: expired.value.status,
            });
          return { ok: false, error: appForbidden('Devis expiré : signature impossible.') };
        }
        // method = 'remote_link', TOUJOURS : le serveur ne fabrique jamais un tracé qu'il n'a pas
        // reçu (P0). Si la page sign-web capture un jour un tracé, son hash devient la preuve —
        // sans tracé, la signature reste honnêtement « lien distant, sans capture ».
        const r = await this.p.runInTransaction(async () => {
          const signed = await new SignQuote({
            companies: this.p.companies,
            // A3 — le type du client (b2c) décide si la demande d'exécution anticipée est tracée.
            customers: this.p.customers,
            quotes: this.p.quotes,
            publicAccessTokens: this.p.publicAccessTokens,
            uow: this.p,
            clock: this.clock,
          }).execute({
            quoteId: q.id,
            signerName,
            remoteGrant: { token, grantId: grant.id },
            ...(proofDataUrl ? { proofSha256: sha256Hex(proofDataUrl) } : {}),
            ...(earlyExecutionRequested ? { earlyExecutionRequested: true } : {}),
          });
          if (!signed.ok) return signed;
          try {
            // A8 — outbox DANS la même transaction que la signature (cf. signQuote) : jamais de
            // contrat signé commité sans ordre durable d'archivage de son original.
            await this.enqueueSignedQuoteArchive(company.id, q.id);
          } catch (error) {
            throw new RollbackAppError({
              kind: 'dependency',
              port: 'document-archive-outbox',
              cause: error instanceof Error ? error.message : String(error),
            });
          }
          return signed;
        });
        if (!r.ok) {
          // Seule la saisie explicite du signataire reste une 422 utile. Toute invalidation de la
          // capacité ou de la pièce demeure indistinguable d'un token inconnu (anti-énumération).
          if (
            r.error.kind === 'domain' &&
            r.error.error.code === 'VALIDATION' &&
            r.error.error.field === 'signerName'
          ) {
            return r;
          }
          return err(appNotFound('public-signature-token', 'redacted'));
        }
        // La révocation de TOUS les grants actifs du devis a eu lieu DANS la transaction de
        // signature (SignQuote) — plus aucun effet token post-commit à rejouer ici.
        // Le journal technique corrèle l'événement sans dupliquer le nom du signataire dans
        // les logs. La future preuve probante appartiendra au stockage métier chiffré, pas à
        // l'observabilité générale.
        this.logger.audit('quote.public_signed', { quoteId: q.id });
        return r;
      });
    } catch (e) {
      if (e instanceof RollbackAppError) return { ok: false as const, error: e.appError };
      throw e;
    }
    // A8 — rendu + stockage de l'original APRÈS le commit de la transaction tenant (I/O
    // d'archive hors transaction de signature — pattern factures) ; retry par le worker sinon.
    if (!signedResult.ok) return signedResult;
    await this.runDocumentArchiveJobs({ companyId: locator.value.companyId, limit: 5 });
    // A3 — la page de signature affiche au consommateur l'URL de sa fonctionnalité de
    // rétractation (L221-21) juste après la conclusion — la révocation des jetons de
    // signature ne le prive plus de toute interface pendant le délai.
    return ok({
      status: signedResult.value.status,
      retractation: signedResult.value.retractation
        ? {
            url: publicRetractationUrl(signedResult.value.retractation.token),
            expiresAt: signedResult.value.retractation.expiresAt,
          }
        : null,
    });
  }

  // ——— Fonctionnalité de rétractation en ligne (public, par lien tokenisé, scope quote_retractation) ———

  private async resolveRetractationGrant(
    token: string,
  ): Promise<Result<{ grantId: string; companyId: string; quoteId: string }, AppError>> {
    return new ResolveQuoteRetractationToken({
      publicAccessTokens: this.p.publicAccessTokens,
      clock: this.clock,
    }).execute({ token });
  }

  /**
   * A3 — vue publique de la fonctionnalité de rétractation (art. L221-21 dernier al. et D221-5
   * c. conso) : identifiée « Renoncer au contrat ici », accessible SANS FRAIS pendant toute la
   * durée du délai. La page présente le contrat (devis signé), le bouton réglementaire, la
   * déclaration pré-remplissable (nom + courriel de réception de l'accusé) et le bouton
   * « Confirmer la rétractation ». Même doctrine anti-énumération que la signature.
   */
  async publicRetractationView(token: string): Promise<
    Result<
      {
        withdrawLabel: string;
        confirmLabel: string;
        companyName: string;
        customerName: string;
        quoteNumber: string;
        signedAt: string;
        available: boolean;
        alreadyRetracted: boolean;
        expiresAt: string | null;
        /** Pré-remplissage honnête de la déclaration (D221-5 : fournir OU CONFIRMER). */
        prefill: { declarantName: string; email: string | null };
      },
      AppError
    >
  > {
    const locator = await this.resolveRetractationGrant(token);
    if (!locator.ok) return locator;
    return this.p.runWithTenant(locator.value.companyId, async () => {
      const company = await this.p.companies.lockForShareById(locator.value.companyId);
      if (!company || company.isClosed()) {
        return err(appNotFound('public-retractation-token', 'redacted'));
      }
      const q = await this.p.quotes.lockForShareById(locator.value.quoteId);
      if (!q || q.companyId !== company.id || q.signature === null || q.number === null) {
        return err(appNotFound('public-retractation-token', 'redacted'));
      }
      const at = this.clock.now();
      const grant = await this.p.publicAccessTokens.lockActive(token, at);
      if (
        !grant ||
        grant.id !== locator.value.grantId ||
        grant.companyId !== company.id ||
        grant.resourceType !== 'quote' ||
        grant.resourceId !== q.id ||
        grant.scope !== 'quote_retractation'
      ) {
        return err(appNotFound('public-retractation-token', 'redacted'));
      }
      const customer = await this.p.customers.findById(q.customerId);
      if (!customer || customer.companyId !== company.id) {
        return err(appNotFound('public-retractation-token', 'redacted'));
      }
      await this.p.publicAccessTokens.markUsed(grant.id, at);
      const availability = onlineRetractationAvailability(
        deriveRetractation({ customerType: customer.type, signature: q.signature }),
        q.retractedAt !== null,
        at,
      );
      return ok({
        withdrawLabel: RETRACTATION_WITHDRAW_FUNCTION_LABEL,
        confirmLabel: RETRACTATION_CONFIRM_FUNCTION_LABEL,
        companyName: company.name,
        customerName: customer.name,
        quoteNumber: q.number,
        signedAt: q.signature.signedAt,
        available: availability.available,
        alreadyRetracted: q.retractedAt !== null,
        expiresAt: availability.available ? availability.expiresAt : null,
        prefill: {
          declarantName: q.signature.signerName,
          email: customer.email ?? null,
        },
      });
    });
  }

  /**
   * A3 — EXERCICE de la rétractation via la fonctionnalité (D221-5) : enregistre le fait dans
   * la transaction qui verrouille le devis (ExerciseRetractation, @bob/core), puis remet
   * l'accusé de réception sur SUPPORT DURABLE : réponse structurée (affichée et imprimable) +
   * courriel outbox à l'adresse CHOISIE par le consommateur dans sa déclaration (D221-5, IV).
   */
  async publicExerciseRetractation(
    token: string,
    input: { declarantName: string; acknowledgmentEmail: string },
  ): Promise<
    Result<
      { retractedAt: string; acknowledgmentLines: string[]; acknowledgmentEmail: string },
      AppError
    >
  > {
    const locator = await this.resolveRetractationGrant(token);
    if (!locator.ok) return locator;
    let exercised: Result<ExerciseRetractationOutput, AppError>;
    try {
      exercised = await this.p.runWithTenant(locator.value.companyId, async () =>
        this.p.runInTransaction(async () => {
          const result = await new ExerciseRetractation({
            companies: this.p.companies,
            customers: this.p.customers,
            quotes: this.p.quotes,
            publicAccessTokens: this.p.publicAccessTokens,
            uow: this.p,
            clock: this.clock,
          }).execute({
            quoteId: locator.value.quoteId,
            grant: { token, grantId: locator.value.grantId },
            declarantName: input.declarantName,
            acknowledgmentEmail: input.acknowledgmentEmail,
          });
          if (!result.ok) return result;
          // Accusé de réception sur SUPPORT DURABLE (D221-5, IV) — outbox DANS la même
          // transaction que l'enregistrement de la rétractation (même doctrine que l'ordre
          // d'archivage à la signature) : jamais de rétractation commitée sans ordre durable
          // d'envoi de son accusé. Le courriel part à l'adresse fournie par le consommateur.
          try {
            await this.notificationDelivery.enqueue({
              companyId: locator.value.companyId,
              kind: 'retractation-acknowledgment',
              dedupeKey: `quote:${locator.value.quoteId}:retractation-acknowledgment`,
              notification: {
                channel: 'email',
                to: result.value.acknowledgmentEmail,
                subject: `Accusé de réception de votre rétractation — devis ${result.value.quoteNumber}`,
                body: result.value.acknowledgmentLines.join('\n'),
              },
            });
          } catch (error) {
            throw new RollbackAppError({
              kind: 'dependency',
              port: 'notification-outbox',
              cause: error instanceof Error ? error.message : String(error),
            });
          }
          // ANNULATION de l'encaissement programmé (embargo L221-10, job J+7) DANS la même
          // transaction que la rétractation : un consommateur rétracté ne doit JAMAIS recevoir
          // l'invite de paiement planifiée (L221-25 : rien n'est dû — elle contredirait
          // l'accusé D221-5 ci-dessus). Idempotent : false si aucun job actif. Le worker porte
          // en plus une garde de livraison (revalidation par kind) en défense en profondeur.
          try {
            const cancelled = await this.p.notificationJobs.cancelByDedupeKey(
              locator.value.companyId,
              'embargo-scheduled-payment',
              embargoScheduledPaymentDedupeKey(locator.value.quoteId),
              this.clock.now(),
            );
            if (cancelled) {
              this.logger.audit('payment.embargo_schedule_cancelled', {
                quoteId: locator.value.quoteId,
                companyId: locator.value.companyId,
                reason: 'quote-retracted',
              });
            }
          } catch (error) {
            throw new RollbackAppError({
              kind: 'dependency',
              port: 'notification-outbox',
              cause: error instanceof Error ? error.message : String(error),
            });
          }
          return result;
        }),
      );
    } catch (e) {
      if (e instanceof RollbackAppError) return { ok: false as const, error: e.appError };
      throw e;
    }
    if (!exercised.ok) {
      // Anti-énumération : seules les erreurs de SAISIE/d'état du formulaire restent
      // parlantes ; toute invalidation de capacité redevient un « introuvable » indistinct.
      if (
        exercised.error.kind === 'domain' &&
        exercised.error.error.code === 'VALIDATION' &&
        (exercised.error.error.field === 'declarantName' ||
          exercised.error.error.field === 'acknowledgmentEmail' ||
          exercised.error.error.field === 'retractation')
      ) {
        return exercised;
      }
      return err(appNotFound('public-retractation-token', 'redacted'));
    }
    // Tentative d'envoi immédiate APRÈS commit (le worker outbox garantit le retry sinon).
    await this.runNotificationJobs({ companyId: locator.value.companyId, limit: 5 });
    this.logger.audit('quote.retracted_online', {
      quoteId: locator.value.quoteId,
      companyId: locator.value.companyId,
    });
    return ok({
      retractedAt: exercised.value.retractedAt,
      acknowledgmentLines: exercised.value.acknowledgmentLines,
      acknowledgmentEmail: exercised.value.acknowledgmentEmail,
    });
  }

  private async resolveDocumentViewGrant(
    token: string,
  ): Promise<Result<ResolvedDocumentViewGrant, AppError>> {
    return new ResolveDocumentViewToken({
      publicAccessTokens: this.p.publicAccessTokens,
      clock: this.clock,
    }).execute({ token });
  }

  // ——— Consultation client à distance (public, par lien tokenisé, scope document_view) ———
  /** Vue publique d'une pièce (devis OU facture) par token opaque — lecture seule. */
  async publicDocumentView(token: string): Promise<Result<DocumentPublicView, AppError>> {
    const locator = await this.resolveDocumentViewGrant(token);
    if (!locator.ok) return locator;
    return this.p.runWithTenant(locator.value.companyId, async () => {
      const company = await this.p.companies.lockForShareById(locator.value.companyId);
      if (!company || company.isClosed()) {
        return err(appNotFound('public-document-view-token', 'redacted'));
      }
      const document =
        locator.value.kind === 'quote'
          ? await this.p.quotes.lockForShareById(locator.value.documentId)
          : await this.p.invoices.lockForShareById(locator.value.documentId);
      if (!document || document.companyId !== company.id) {
        return err(appNotFound('public-document-view-token', 'redacted'));
      }
      const at = this.clock.now();
      const grant = await this.p.publicAccessTokens.lockActive(token, at);
      if (
        !grant ||
        grant.id !== locator.value.grantId ||
        grant.companyId !== company.id ||
        grant.resourceType !== locator.value.kind ||
        grant.resourceId !== locator.value.documentId ||
        grant.scope !== 'document_view'
      ) {
        return err(appNotFound('public-document-view-token', 'redacted'));
      }
      if (locator.value.kind === 'quote') {
        const q = document as Quote;
        if (q.companyId !== grant.companyId || q.number === null || q.status === 'draft')
          return err(appNotFound('public-document-view-token', 'redacted'));
        const parties = await this.publicDocumentParties(company, q.customerId);
        if (!parties) return err(appNotFound('public-document-view-token', 'redacted'));
        await this.p.publicAccessTokens.markUsed(grant.id, at);
        return ok<DocumentPublicView>({
          kind: 'quote',
          number: q.number,
          companyName: parties.companyName,
          customerName: parties.customerName,
          status: q.status,
          signed: q.signature !== null,
          validUntil: q.validUntil,
          lines: q.lines.map((l) => ({
            label: l.label,
            qty: l.qty,
            unitPriceHT: l.unitPriceHT,
            vatRate: l.vatRate,
          })),
          totals: q.totals(),
        });
      }
      const inv = document as Invoice;
      if (inv.companyId !== grant.companyId || inv.number === null || inv.issuedAt === null)
        return err(appNotFound('public-document-view-token', 'redacted'));
      const parties = await this.publicDocumentParties(company, inv.customerId);
      if (!parties) return err(appNotFound('public-document-view-token', 'redacted'));
      await this.p.publicAccessTokens.markUsed(grant.id, at);
      return ok<DocumentPublicView>({
        kind: 'invoice',
        number: inv.number,
        companyName: parties.companyName,
        customerName: parties.customerName,
        status: inv.status,
        issuedAt: inv.issuedAt,
        dueAt: inv.dueAt,
        paid: inv.paid,
        lines: inv.lines.map((l) => ({
          label: l.label,
          qty: l.qty,
          unitPriceHT: l.unitPriceHT,
          vatRate: l.vatRate,
        })),
        totals: inv.totals(),
        mentions: [...inv.mentions],
      });
    });
  }

  /** PDF de la pièce consultée par lien public (même token que publicDocumentView). */
  async publicDocumentPdf(token: string): Promise<Result<Uint8Array, AppError>> {
    const locator = await this.resolveDocumentViewGrant(token);
    if (!locator.ok) return locator;
    const authorized = await this.p.runWithTenant<Result<AuthorizedPublicDocumentPdf, AppError>>(
      locator.value.companyId,
      async () => {
        const company = await this.p.companies.lockForShareById(locator.value.companyId);
        if (!company || company.isClosed()) {
          return err(appNotFound('public-document-view-token', 'redacted'));
        }
        const document =
          locator.value.kind === 'quote'
            ? await this.p.quotes.lockForShareById(locator.value.documentId)
            : await this.p.invoices.lockForShareById(locator.value.documentId);
        if (!document || document.companyId !== company.id) {
          return err(appNotFound('public-document-view-token', 'redacted'));
        }
        const at = this.clock.now();
        const grant = await this.p.publicAccessTokens.lockActive(token, at);
        if (
          !grant ||
          grant.id !== locator.value.grantId ||
          grant.companyId !== company.id ||
          grant.resourceType !== locator.value.kind ||
          grant.resourceId !== locator.value.documentId ||
          grant.scope !== 'document_view'
        ) {
          return err(appNotFound('public-document-view-token', 'redacted'));
        }
        if (locator.value.kind === 'quote') {
          const q = document as Quote;
          if (q.number === null || q.status === 'draft') {
            return err(appNotFound('public-document-view-token', 'redacted'));
          }
          const customer = await this.p.customers.findById(q.customerId);
          if (!customer || customer.companyId !== company.id) {
            return err(appNotFound('public-document-view-token', 'redacted'));
          }
          // A8 — devis SIGNÉ = contrat : servir UNIQUEMENT l'octet archivé au moment de la
          // signature (art. L213-1 c. conso ; valeur probante art. 1366-1367 c. civ.), jamais un
          // re-rendu depuis l'état courant. Le rendu dynamique reste réservé aux états non signés.
          if (q.signature !== null) {
            const documents = await this.p.documents.findByEntity(company.id, 'quote', q.id);
            const archivedCandidates = documents.filter(
              (candidate) => candidate.kind === 'signed_quote' && candidate.status === 'active',
            );
            // Plusieurs originaux actifs = archive ambiguë/corrompue : refus, jamais un choix
            // arbitraire (même doctrine que les factures émises).
            if (archivedCandidates.length > 1) return err(appUnavailable('signed-quote-archive'));
            if (archivedCandidates.length === 1) {
              const archive = archivedCandidates[0]!.toProps();
              await this.p.publicAccessTokens.markUsed(grant.id, at);
              return ok({
                kind: 'signed_quote',
                companyId: company.id,
                quoteId: q.id,
                number: q.number,
                archive: {
                  storageKey: archive.storageKey,
                  mimeType: archive.mimeType,
                  byteSize: archive.byteSize,
                  sha256: archive.sha256,
                },
              });
            }
            // Archive absente : si un ordre d'archivage existe (signature post-A8), la fenêtre
            // signature→job est une indisponibilité à réparer, jamais une autorisation de
            // régénérer. Sans aucun ordre (devis signé AVANT A8), le rendu dynamique reste le
            // seul service honnête — l'original d'époque n'existe pas et ne sera jamais
            // fabriqué rétroactivement.
            const archiveOrder = await this.p.documentArchiveJobs.findByPiece(
              company.id,
              q.id,
              'quote-signed',
            );
            if (archiveOrder !== null) return err(appUnavailable('signed-quote-archive'));
          }
          await this.p.publicAccessTokens.markUsed(grant.id, at);
          return ok({ kind: 'quote', data: this.quotePdfData(q, company, customer) });
        }
        const inv = document as Invoice;
        if (inv.number === null || inv.issuedAt === null) {
          return err(appNotFound('public-document-view-token', 'redacted'));
        }
        const documents = await this.p.documents.findByEntity(company.id, 'invoice', inv.id);
        const archivedCandidates = documents.filter(
          (candidate) => candidate.kind === 'invoice_pdf' && candidate.status === 'active',
        );
        if (archivedCandidates.length !== 1) return err(appUnavailable('invoice-archive'));
        const archive = archivedCandidates[0]!.toProps();
        await this.p.publicAccessTokens.markUsed(grant.id, at);
        return ok({
          kind: 'invoice',
          companyId: company.id,
          invoiceId: inv.id,
          number: inv.number,
          archive: {
            storageKey: archive.storageKey,
            mimeType: archive.mimeType,
            byteSize: archive.byteSize,
            sha256: archive.sha256,
          },
        });
      },
    );
    if (!authorized.ok) return authorized;
    // Le snapshot est complet : aucune nouvelle lecture BDD n'est faite après le commit.
    // Rendu et stockage objet peuvent être lents/réseau, sans retenir le verrou de clôture.
    if (authorized.value.kind === 'quote') {
      return ok(await this.pdf.renderQuote(authorized.value.data));
    }
    if (authorized.value.kind === 'signed_quote') {
      return this.loadArchivedSignedQuotePdfBytes(authorized.value);
    }
    return this.loadArchivedInvoicePdfBytes(authorized.value);
  }

  /**
   * Recharge une entité du contexte depuis les projections tenant-scoped. Le contexte UI
   * ne fournit que type/id : aucun montant ou statut venant du client n'est réutilisé.
   */
  private async readAgentContextEntity(
    input: ReadContextEntityInput,
  ): Promise<Result<ContextEntitySummary, AppError>> {
    const notFound = (): Result<ContextEntitySummary, AppError> => ({
      ok: false,
      error: appNotFound(input.type, input.id),
    });

    if (input.type === 'invoice') {
      const [invoices, customers] = await Promise.all([this.listInvoices(), this.listCustomers()]);
      if (!invoices.ok) return invoices;
      if (!customers.ok) return customers;
      const invoice = invoices.value.find((candidate) => candidate.id === input.id);
      if (!invoice) return notFound();
      const customer = customers.value.find((candidate) => candidate.id === invoice.customerId);
      return ok({
        type: input.type,
        id: invoice.id,
        label: invoice.number ? `Facture ${invoice.number}` : 'Facture brouillon',
        route: `/facture/${encodeURIComponent(invoice.id)}`,
        facts: [
          { label: 'Statut', value: invoiceStatusLabel(invoice.status) },
          { label: 'Type', value: invoiceKindLabel(invoice.kind) },
          ...(customer ? [{ label: 'Client', value: customer.name }] : []),
          { label: 'Total TTC', value: formatEUR(invoice.totals.ttc) },
          {
            label: 'Reste dû',
            value: formatEUR(Math.max(0, invoice.totals.netToPay - invoice.paid)),
          },
          ...(invoice.dueAt ? [{ label: 'Échéance', value: frDateLabel(invoice.dueAt) }] : []),
        ],
      });
    }

    if (input.type === 'quote') {
      const [quotes, customers] = await Promise.all([this.listQuotes(), this.listCustomers()]);
      if (!quotes.ok) return quotes;
      if (!customers.ok) return customers;
      const quote = quotes.value.find((candidate) => candidate.id === input.id);
      if (!quote) return notFound();
      const customer = customers.value.find((candidate) => candidate.id === quote.customerId);
      return ok({
        type: input.type,
        id: quote.id,
        label: quote.number ? `Devis ${quote.number}` : 'Devis brouillon',
        route: `/devis/${encodeURIComponent(quote.id)}`,
        facts: [
          { label: 'Statut', value: quoteStatusLabel(quote.status) },
          ...(customer ? [{ label: 'Client', value: customer.name }] : []),
          { label: 'Total TTC', value: formatEUR(quote.totals.ttc) },
          { label: 'Lignes', value: String(quote.lines.length) },
          ...(quote.depositPct !== null
            ? [{ label: 'Acompte', value: `${quote.depositPct} %` }]
            : []),
        ],
      });
    }

    if (input.type === 'invoice_line') {
      const invoices = await this.listInvoices();
      if (!invoices.ok) return invoices;
      const matches = invoices.value.flatMap((invoice) =>
        invoice.lines.filter((line) => line.id === input.id).map((line) => ({ invoice, line })),
      );
      if (matches.length !== 1) return notFound();
      const { invoice, line } = matches[0]!;
      const lineTotalHt = Math.round(line.qty * line.unitPriceHT);
      return ok({
        type: input.type,
        id: line.id,
        label: line.label,
        route: `/facture/${encodeURIComponent(invoice.id)}`,
        facts: [
          { label: 'Facture', value: invoice.number ?? 'Brouillon' },
          { label: 'Quantité', value: `${line.qty}${line.unit ? ` ${line.unit}` : ''}` },
          { label: 'Prix unitaire HT', value: formatEUR(line.unitPriceHT) },
          { label: 'Total HT', value: formatEUR(lineTotalHt) },
          { label: 'TVA', value: `${line.vatRate} %` },
        ],
      });
    }

    if (input.type === 'quote_line') {
      const quotes = await this.listQuotes();
      if (!quotes.ok) return quotes;
      const matches = quotes.value.flatMap((quote) =>
        quote.lines.filter((line) => line.id === input.id).map((line) => ({ quote, line })),
      );
      if (matches.length !== 1) return notFound();
      const { quote, line } = matches[0]!;
      const lineTotalHt = Math.round(line.qty * line.unitPriceHT);
      return ok({
        type: input.type,
        id: line.id,
        label: line.label,
        route: `/devis/${encodeURIComponent(quote.id)}`,
        facts: [
          { label: 'Devis', value: quote.number ?? 'Brouillon' },
          { label: 'Quantité', value: `${line.qty}${line.unit ? ` ${line.unit}` : ''}` },
          { label: 'Prix unitaire HT', value: formatEUR(line.unitPriceHT) },
          { label: 'Total HT', value: formatEUR(lineTotalHt) },
          { label: 'TVA', value: `${line.vatRate} %` },
        ],
      });
    }

    if (input.type === 'customer') {
      const customers = await this.listCustomers();
      if (!customers.ok) return customers;
      const customer = customers.value.find((candidate) => candidate.id === input.id);
      if (!customer) return notFound();
      return ok({
        type: input.type,
        id: customer.id,
        label: customer.name,
        route: `/client/${encodeURIComponent(customer.id)}`,
        facts: [
          { label: 'Type', value: customerTypeLabel(customer.type) },
          { label: 'Encours', value: formatEUR(customer.outstandingCents) },
          {
            label: 'Délai moyen',
            value:
              customer.avgDelayDays === null
                ? customer.paymentHistoryStatus === 'incomplete'
                  ? 'Indisponible — paiements non rapprochés'
                  : 'Indisponible — historique insuffisant'
                : `${customer.avgDelayDays} jours`,
          },
          { label: 'Score', value: 'Indisponible — modèle non ratifié' },
        ],
      });
    }

    if (input.type === 'expense') {
      const expenses = await this.listExpenses();
      if (!expenses.ok) return expenses;
      const expense = expenses.value.find((candidate) => candidate.id === input.id);
      if (!expense) return notFound();
      return ok({
        type: input.type,
        id: expense.id,
        label: expense.supplierName,
        facts: [
          { label: 'Statut', value: expenseStatusLabel(expense.status) },
          { label: 'Catégorie', value: expenseCategoryLabel(expense.category) },
          { label: 'Total TTC', value: formatEUR(expense.totalTtcCents) },
          { label: 'Date', value: frDateLabel(expense.documentDate) },
        ],
      });
    }

    if (input.type === 'document') {
      const documents = await this.listDocuments();
      if (!documents.ok) return documents;
      const document = documents.value.find((candidate) => candidate.id === input.id);
      if (!document) return notFound();
      let cachedAnalysis: DocumentAnalysis | null = null;
      try {
        const cached = await this.p.runWithTenant(this.companyId(), () =>
          this.p.documentAnalyses.findExact({
            companyId: this.companyId(),
            documentId: document.id,
            documentVersion: document.version,
            sourceSha256: document.sha256,
          }),
        );
        cachedAnalysis = cached?.analysis ?? null;
      } catch (cause) {
        return {
          ok: false,
          error: {
            kind: 'dependency',
            port: 'document-analysis-cache',
            cause: cause instanceof Error ? cause.message : 'cache illisible',
          },
        };
      }
      return ok({
        type: input.type,
        id: document.id,
        label: document.filename,
        route: `/documents/${encodeURIComponent(document.id)}`,
        facts: [
          { label: 'Type', value: documentKindLabel(document.kind) },
          { label: 'Statut', value: documentStatusLabel(document.status) },
          { label: 'Version', value: String(document.version) },
          ...(document.documentDate
            ? [{ label: 'Date', value: frDateLabel(document.documentDate) }]
            : []),
          ...(cachedAnalysis
            ? [
                {
                  label: 'Nature reconnue',
                  value: DOCUMENT_ANALYSIS_TYPE_LABEL[cachedAnalysis.type],
                },
                { label: 'Résumé de Bob', value: cachedAnalysis.summary },
                {
                  label: 'Confiance',
                  value: `${Math.round(cachedAnalysis.typeConfidence * 100)} %`,
                },
                {
                  label: 'Rangement suggéré',
                  value: cachedAnalysis.suggestedSystemFolder
                    ? (DOCUMENT_ANALYSIS_FOLDER_LABEL[cachedAnalysis.suggestedSystemFolder] ??
                      cachedAnalysis.suggestedSystemFolder)
                    : 'À choisir avec l’utilisateur',
                },
                ...cachedAnalysis.facts.slice(0, 3).map((fact) => ({
                  label: DOCUMENT_ANALYSIS_FACT_LABEL[fact.key],
                  value: documentAnalysisFactValue(fact),
                })),
                ...(cachedAnalysis.warnings.length > 0
                  ? [{ label: 'À vérifier', value: cachedAnalysis.warnings.join(' · ') }]
                  : []),
              ]
            : []),
        ],
      });
    }

    if (input.type === 'notification') {
      const notification = await this.p.notificationJobs.findById(this.companyId(), input.id);
      if (!notification) return notFound();
      const route = notificationRoute(notification);
      return ok({
        type: input.type,
        id: notification.id,
        label: notification.subject,
        ...(route !== null ? { route } : {}),
        state: { unread: notification.readAt === null },
        facts: [
          { label: 'Statut', value: notification.readAt !== null ? 'Lue' : 'Non lue' },
          { label: 'Reçue le', value: frDateLabel(notification.createdAt) },
          ...(notification.notification?.body
            ? [{ label: 'Contenu', value: notification.notification.body }]
            : []),
        ],
      });
    }

    if (input.type === 'accounting_entry') {
      const entry = await this.p.accountingEntries.findById(this.companyId(), input.id);
      if (!entry) return notFound();
      return ok({
        type: input.type,
        id: entry.id,
        label: `${entry.reference} — ${entry.label}`,
        facts: [
          { label: 'Journal', value: accountingJournalLabel(entry.journal) },
          { label: 'Date', value: frDateLabel(entry.entryDate) },
          { label: 'Débit', value: formatEUR(entry.totalDebitCents) },
          { label: 'Crédit', value: formatEUR(entry.totalCreditCents) },
          {
            label: 'Équilibre',
            value:
              entry.totalDebitCents === entry.totalCreditCents
                ? 'Écriture équilibrée'
                : 'Anomalie à vérifier',
          },
        ],
      });
    }

    if (input.type === 'chantier') {
      const chantiers = await this.listChantiers();
      if (!chantiers.ok) return chantiers;
      const chantier = chantiers.value.find((candidate) => candidate.id === input.id);
      if (!chantier) return notFound();
      return ok({
        type: input.type,
        id: chantier.id,
        label: chantier.name,
        facts: [
          { label: 'Statut', value: chantierStatusLabel(chantier.status) },
          { label: 'Ouvert le', value: frDateLabel(chantier.openedAt) },
          ...(chantier.address ? [{ label: 'Adresse', value: chantier.address }] : []),
        ],
      });
    }

    return notFound();
  }

  /** Surface d'actions de Bob (parité) — délègue aux mêmes use cases que l'UI manuelle. */
  private buildBobActions(): BobActions {
    return {
      readContextEntity: (input) => this.readAgentContextEntity(input),
      computePayout: async () => {
        const r = await this.getCashflow('realiste', 30);
        if (!r.ok) return r;
        // Vocal : sans AUCUNE observation bancaire (tenant vierge), Bob refuse d'annoncer un
        // montant — « 0 € mobilisable » serait un chiffre inventé tant que le solde n'est pas
        // confirmé (l'écran Argent, lui, montre l'état vide + la confirmation de solde).
        if (r.value.bankingSource === 'none') return err(appUnavailable('cashflow-banking-source'));
        return ok({ payoutCents: r.value.payout, availableCents: r.value.available });
      },
      // Phase 1C (SPEC_EXPERT_FISCAL §V2 pt. 1+6) : parité voix ↔ écrans — même moteur pur
      // (deriveOwnerPayGuidance @bob/core), même scénario/horizon (réaliste/30j) que computePayout
      // ci-dessus. periodeCA = CA encaissé du mois civil en cours (même simplification 1C que le
      // hook mobile useOwnerPayGuidance — pas la période URSSAF exacte, qui reste la carte Argent).
      getOwnerPayGuidance: async () => {
        const [profileResult, cashflowResult] = await Promise.all([
          this.getFiscalProfile(),
          this.getCashflow('realiste', 30),
        ]);
        if (!profileResult.ok) return profileResult;
        if (!cashflowResult.ok) return cashflowResult;
        // Même refus vocal que computePayout : jamais un conseil de versement sans solde observé.
        if (cashflowResult.value.bankingSource === 'none')
          return err(appUnavailable('cashflow-banking-source'));
        // Mois civil URSSAF = calendrier MÉTIER Paris (cohérent avec l'écran Argent).
        const today = this.businessToday();
        const month = today.slice(0, 7);
        const payments = await this.p.payments.listByCompany(this.companyId());
        const periodeCA = {
          encaissedCents: Math.max(
            0,
            payments
              .filter((p) => p.receivedAt.slice(0, 7) === month)
              .reduce((sum, p) => sum + p.amount, 0),
          ),
          year: Number(today.slice(0, 4)),
        };
        const guidance = deriveOwnerPayGuidance(
          profileResult.value,
          cashflowResult.value,
          periodeCA,
        );
        return ok({ guidance, payoutCents: cashflowResult.value.payout });
      },
      // C25 ① : brouillon CIBLABLE (invoiceId/customerId), dérivé du plan de relances réel
      // (@bob/core deriveRelancePlan) — même moteur que le cron et les surfaces mobiles.
      draftRelance: async (input) => {
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        if (!cust.ok) return cust;
        // La vue serveur type kind/status en string large : projection stricte vers le moteur core.
        const plan = deriveRelancePlan({
          invoices: inv.value.map((i) => ({
            id: i.id,
            customerId: i.customerId,
            kind: i.kind as TodayInvoiceData['kind'],
            status: i.status as TodayInvoiceData['status'],
            number: i.number,
            parentQuoteId: i.parentQuoteId,
            totals: i.totals,
            dueAt: i.dueAt,
            paid: i.paid,
          })),
          customers: cust.value,
          // Retards en jours = calendrier MÉTIER Paris (même moteur que le cron/les écrans).
          today: this.businessToday(),
        });
        const entry = input?.invoiceId
          ? plan.find((e) => e.invoiceId === input.invoiceId)
          : input?.customerId
            ? plan.find((e) => e.customerId === input.customerId)
            : plan[0]; // tri du plan : retard le plus long puis montant
        if (!entry) {
          return ok(
            input?.invoiceId || input?.customerId
              ? {
                  subject: 'Rien à relancer pour cette cible',
                  body: 'Aucun retard sur cette cible — facture réglée ou pas encore échue. Je ne relance pas pour rien.',
                }
              : {
                  subject: 'Rien à relancer',
                  body: 'Aucune facture en retard — tout est réglé ou dans les temps. 🎉',
                },
          );
        }
        return ok({ subject: entry.message.subject, body: entry.message.body });
      },
      listPayableInvoices: async () => {
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        if (!cust.ok) return cust;
        const names = new Map(cust.value.map((c) => [c.id, c.name]));
        const candidates = inv.value
          .filter(
            (i) => ['issued', 'partially_paid', 'late'].includes(i.status) && i.number !== null,
          )
          .filter((i) => remainingInvoiceBalanceCents(i) > 0);
        if (candidates.some((invoice) => !names.has(invoice.customerId))) {
          return err(appUnavailable('customer-reference'));
        }
        const payable = candidates.map((i) => ({
          id: i.id,
          number: i.number!,
          remainingCents: remainingInvoiceBalanceCents(i),
          customerName: names.get(i.customerId)!,
        }));
        return ok(payable);
      },
      listSendableQuotes: async () => {
        const [quotes, cust] = await Promise.all([this.listQuotes(), this.listCustomers()]);
        if (!quotes.ok) return quotes;
        if (!cust.ok) return cust;
        const names = new Map(cust.value.map((c) => [c.id, c.name]));
        const candidates = quotes.value.filter((q) =>
          ['draft', 'sent', 'viewed'].includes(q.status),
        );
        if (candidates.some((quote) => !names.has(quote.customerId))) {
          return err(appUnavailable('customer-reference'));
        }
        return ok(
          candidates.map((q) => ({
            id: q.id,
            number: q.number,
            customerName: names.get(q.customerId)!,
            totalTtcCents: q.totals.ttc,
            status: q.status,
          })),
        );
      },
      // S1 (LOT 5) + B8 : devis SIGNÉS facturables — matière de generer_facture (ASK-2). Un devis
      // sort de la liste dès que sa facture FINALE existe ; l'acompte déjà émis est signalé
      // (depositInvoiced) et le bon de commande (numéro d'engagement) est exposé AVANT émission.
      // SOURCE UNIQUE : use case core ListInvoiceableQuotes, le même que le client local —
      // parité stricte des trois implémentations, plus aucune dérivation inline.
      listInvoiceableQuotes: async () =>
        new ListInvoiceableQuotes({
          quotes: this.p.quotes,
          invoices: this.p.invoices,
          customers: this.p.customers,
          // A3 — le gel de rétractation (finalBlockedUntil) se calcule contre l'horloge injectée.
          clock: this.clock,
        }).execute({ companyId: this.companyId() }),
      listIssuableInvoices: async () => {
        const [invoices, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!invoices.ok) return invoices;
        if (!cust.ok) return cust;
        const names = new Map(cust.value.map((c) => [c.id, c.name]));
        const candidates = invoices.value.filter((i) => i.status === 'draft' && !i.number);
        if (candidates.some((invoice) => !names.has(invoice.customerId))) {
          return err(appUnavailable('customer-reference'));
        }
        return ok(
          candidates.map((i) => ({
            id: i.id,
            number: i.number,
            customerName: names.get(i.customerId)!,
            totalTtcCents: i.totals.ttc,
            status: i.status,
          })),
        );
      },
      listDocuments: async () => {
        const r = await this.listDocuments({ includeDeleted: false });
        if (!r.ok) return r;
        return ok(
          r.value.slice(0, 12).map((d) => {
            // Libellé intelligent (mêmes règles que smartDocumentTitle côté mobile) :
            // renommage humain > suggestion d'analyse persistée > displayName serveur.
            const display = d.displayName.replace(/\s+/g, ' ').trim();
            const suggested = (d.analysis?.suggestedDisplayName ?? '').replace(/\s+/g, ' ').trim();
            const smartName = display.length > 0 && display !== d.filename
              ? display
              : suggested.length > 0 ? suggested : (display.length > 0 ? display : d.filename);
            return {
              id: d.id,
              filename: d.filename,
              kind: d.kind,
              linkedEntityType: d.linkedEntityType,
              linkedEntityId: d.linkedEntityId,
              createdAt: d.createdAt,
              // Ciblage vocal du coffre (valider_document) : libellé + état de la file « À valider ».
              displayName: smartName,
              origin: d.origin,
              folderId: d.folderId,
              reviewedAt: d.reviewedAt,
            };
          }),
        );
      },
      // Parité « papa vocal » : « c'est bon, valide le ticket » — MÊME use case
      // AcknowledgeDocument que POST /documents/:id/acknowledge et le bouton « Confirmer »
      // de la file « À valider ». La révision courante est résolue ici (le geste vocal n'a
      // pas de vue optimiste) ; le latch du domaine garde l'idempotence de la validation.
      acknowledgeDocument: async (input) => {
        const current = await this.getDocument(input.documentId);
        if (!current.ok) return current;
        const r = await this.acknowledgeDocument({
          documentId: input.documentId,
          expectedRevision: current.value.revision,
        });
        if (!r.ok) return r;
        // Une validation sans reviewedAt posé serait une rupture du contrat du use case.
        return r.value.reviewedAt !== null
          ? ok({ documentId: input.documentId, reviewedAt: r.value.reviewedAt })
          : err(appUnavailable('document-acknowledge'));
      },
      // LOT 5 : destinations de classement RÉELLES — chantiers OUVERTS (module autorisé) +
      // dossiers racine actifs du coffre. MÊMES cibles que le contexte d'analyse documentaire
      // (documentClassificationContext) : rien d'autre n'est proposable, anti-hallucination.
      listFilingDestinations: async () => {
        const [chantiers, foldersPage] = await Promise.all([
          (async () =>
            (await this.chantiersAllowed())
              ? this.p.chantiers.listByCompany(this.companyId())
              : [])(),
          this.p.documentFolders.listChildren({
            companyId: this.companyId(),
            parentId: null,
            limit: 100,
          }),
        ]);
        return ok({
          chantiers: chantiers
            .map((chantier) => chantier.toProps())
            .filter((props) => props.status === 'open')
            .map((props) => ({ id: props.id, nom: props.name })),
          dossiers: foldersPage.items
            .filter((folder) => folder.status === 'active')
            .map((folder) => {
              const props = folder.toProps();
              return { id: props.id, nom: props.name, systemKey: props.systemKey ?? null };
            }),
        });
      },
      // LOT 5 : « range le ticket Aldi dans le chantier Durand » — MÊME séquence que le geste
      // « Classer là » mobile (use-apply-destination) : MoveDocumentToFolder + ClassifyDocument
      // (chantier) + nom intelligent (applyAnalysisSuggestedDisplayName, règle suggestedRenameFor :
      // un renommage humain n'est JAMAIS écrasé ; le renommage est cosmétique, jamais bloquant).
      fileDocument: async (input) => {
        const current = await this.getDocument(input.documentId);
        if (!current.ok) return current;
        let revision = current.value.revision;
        if (input.destination.kind === 'folder') {
          if (current.value.folderId !== input.destination.folderId) {
            const moved = await this.moveDocumentToFolder({
              documentId: input.documentId,
              folderId: input.destination.folderId,
              expectedRevision: revision,
            });
            if (!moved.ok) return moved;
            revision = moved.value.revision;
          }
        } else {
          // Destination chantier : rangement dans « Chantiers » UNIQUEMENT si l'original n'a
          // pas encore de dossier (jamais écraser un rangement humain) — même plan que le mobile
          // (planDestinationApplication), puis lien métier chantier.
          if (current.value.folderId === null) {
            const rootFolders = await this.p.documentFolders.listChildren({
              companyId: this.companyId(),
              parentId: null,
              limit: 100,
            });
            const projects = rootFolders.items.find(
              (folder) => folder.status === 'active' && folder.toProps().systemKey === 'projects',
            );
            if (projects) {
              const moved = await this.moveDocumentToFolder({
                documentId: input.documentId,
                folderId: projects.toProps().id,
                expectedRevision: revision,
              });
              if (!moved.ok) return moved;
              revision = moved.value.revision;
            }
          }
          const classified = await this.classifyDocument({
            documentId: input.documentId,
            linkedEntityType: 'chantier',
            linkedEntityId: input.destination.chantierId,
            expectedRevision: revision,
          });
          if (!classified.ok) return classified;
        }
        const fresh = await this.getDocument(input.documentId);
        if (!fresh.ok) return fresh;
        const renamed = await this.applyAnalysisSuggestedDisplayName(this.companyId(), fresh.value);
        const view = renamed ?? fresh.value;
        return ok({
          documentId: view.id,
          folderId: view.folderId,
          linkedEntityType: view.linkedEntityType,
          linkedEntityId: view.linkedEntityId,
          displayName: view.displayName,
        });
      },
      // LOT 5 : « renomme-le facture matériaux salle de bain » — MÊME use case RenameDocument
      // que PUT /documents/:id/name. Le nom dicté devient un renommage HUMAIN (displayName ≠
      // filename) : prioritaire, plus jamais écrasé par une suggestion d'analyse.
      renameDocument: async (input) => {
        const current = await this.getDocument(input.documentId);
        if (!current.ok) return current;
        const renamed = await this.renameDocument({
          documentId: input.documentId,
          displayName: input.displayName,
          expectedRevision: current.value.revision,
        });
        if (!renamed.ok) return renamed;
        return ok({ documentId: renamed.value.id, displayName: renamed.value.displayName });
      },
      // LOT 5 : « retrouve la facture du radiateur de mars » — MÊME recherche que
      // GET /documents/search (searchSalesDocuments, ranking Postgres/pg_trgm). Lecture pure.
      searchDocuments: async (input) => {
        const r = await this.searchSalesDocuments({
          query: input.query,
          scope: input.scope ?? 'all',
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          limit: 8,
        });
        if (!r.ok) return r;
        return ok({
          hits: r.value.hits.map((hit) => ({
            source: hit.source,
            id: hit.id,
            number: hit.number,
            customerName: hit.customerName,
            status: hit.status,
            date: hit.date,
            totalTtcCents: hit.totals.ttc,
            matchedLineLabel: hit.matchedLineLabel,
          })),
          totalCount: r.value.totalCount,
        });
      },
      // C-EXP5b : lecture du calendrier fiscal — même use case que GET /fiscal-calendar (parité humain↔Bob).
      listFiscalDeadlines: async () => this.getFiscalCalendar(),
      // Pilier 2 : « où en est mon abonnement / mon essai » — MÊME lecture GetSubscriptionStatus
      // que GET /subscription (parité humain↔Bob). Lecture seule : jamais d'achat vocal.
      getSubscriptionStatus: async () => this.subscriptionStatus(this.companyId()),
      // BOB-1 (PONT-SERVEUR v1) : l'expert-comptable de poche — MÊMES use cases purs que les
      // écrans (deriveVatPosition / deriveAgedBalance @bob/core).
      getVatPosition: async () => {
        const [invoices, expenses] = await Promise.all([
          this.p.invoices.listByCompany(this.companyId()),
          this.p.expenses.listByCompany(this.companyId()),
        ]);
        return ok(
          deriveVatPosition({
            invoices: invoices.map((i) => ({
              kind: i.kind,
              status: i.status,
              totals: i.totals(),
              paid: i.paid,
            })),
            expenses: expenses.map((e) => ({ vatCents: e.toProps().vatCents })),
          }),
        );
      },
      getAgedBalance: async () => {
        const [invoices, cust] = await Promise.all([
          this.p.invoices.listByCompany(this.companyId()),
          this.listCustomers(),
        ]);
        if (!cust.ok) return cust;
        return ok(
          deriveAgedBalance({
            invoices: invoices.map((i) => ({
              kind: i.kind,
              status: i.status,
              totals: i.totals(),
              paid: i.paid,
              dueAt: i.dueAt,
              customerId: i.customerId,
            })),
            customers: cust.value,
            // Tranches de retard = calendrier MÉTIER Paris (parité avec l'écran Clients).
            today: this.businessToday(),
          }),
        );
      },
      // BA-3 (audit 20260717, correction 5) : revue de pilotage vocale — MÊME use case pur
      // deriveBusinessReview @bob/core que l'écran Pilotage (pilotage.tsx)
      // (démo, getBusinessReview) : parité garantie, une seule vérité. Sources = persistance
      // réelle du tenant, même pattern que getVatPosition/getAgedBalance ci-dessus (accès
      // repository direct, aucun entitlement dédié à cette lecture — cohérent avec ces voisines).
      // Avant ce correctif, l'action était absente ici : bob-agent.ts:1330 retombait toujours sur
      // le fail-safe honnête (« je n'ai pas accès à la revue de pilotage sur cet appareil »).
      getBusinessReview: async () => {
        const [entries, payments, invoices, cust, expenses, company] = await Promise.all([
          this.p.accountingEntries.listByCompany(this.companyId()),
          this.p.payments.listByCompany(this.companyId()),
          this.p.invoices.listByCompany(this.companyId()),
          this.listCustomers(),
          this.p.expenses.listByCompany(this.companyId()),
          this.p.companies.findById(this.companyId()),
        ]);
        if (!cust.ok) return cust;
        if (company === null) return err(appUnavailable('company'));
        return ok(
          deriveBusinessReview({
            entries: entries.map((e) => ({
              entryDate: e.entryDate,
              sourceType: e.sourceType,
              lines: e.lines,
            })),
            payments: payments.map((p) => ({ amountCents: p.amount, receivedAt: p.receivedAt })),
            invoices: invoices.map((i) => ({
              kind: i.kind,
              status: i.status,
              totals: i.totals(),
              paid: i.paid,
              dueAt: i.dueAt,
              customerId: i.customerId,
            })),
            customers: cust.value,
            expenses: expenses.map((e) => {
              const p = e.toProps();
              return {
                category: p.category,
                totalTtcCents: p.totalTtcCents,
                vatCents: p.vatCents,
                documentDate: p.documentDate,
                status: p.status,
              };
            }),
            vatRegime: company.vatRegime,
            // Mois en cours « à date égale » = calendrier MÉTIER Paris (parité écran Pilotage).
            today: this.businessToday(),
          }),
        );
      },
      listUnpaidExpenses: async () => {
        const list = await this.p.expenses.listByCompany(this.companyId());
        return ok(
          list
            .filter((e) => e.status === 'to_pay')
            .map((e) => {
              const p = e.toProps();
              return {
                id: p.id,
                supplierName: p.supplierName,
                totalTtcCents: p.totalTtcCents,
                documentDate: p.documentDate,
              };
            }),
        );
      },
      // M3 — dépenses RÉCENTES (payées ou à payer) avec leur imputation chantier : la matière
      // du ciblage vocal de lier_depense_chantier. Bornées et triées côté hôte (plus récentes
      // d'abord) — lecture pure du tenant, jamais une dépense inventée.
      listRecentExpenses: async () => {
        const list = await this.p.expenses.listByCompany(this.companyId());
        return ok(
          list
            .map((e) => e.toProps())
            .sort((a, b) => b.documentDate.localeCompare(a.documentDate))
            .slice(0, 20)
            .map((p) => ({
              id: p.id,
              supplierName: p.supplierName,
              totalTtcCents: p.totalTtcCents,
              documentDate: p.documentDate,
              chantierId: p.chantierId ?? null,
            })),
        );
      },
      // M3 — outil vocal lier_depense_chantier : PURE délégation au MÊME chemin que
      // PUT /expenses/:id/chantier (assignExpenseChantier : use case AssignExpenseToChantier
      // @bob/core, transaction + verrou pessimiste, anti-IDOR fail-closed, audit). Le plancher
      // de confirmation vit dans le registre d'outils (@bob/ai) — l'hôte n'ajoute AUCUNE logique.
      assignExpenseChantier: async (input) => this.assignExpenseChantier(input),
      // M4 — dépense dictée : MÊME chemin transactionnel que POST /expenses (coordinateur E1 +
      // idempotence + apprentissage fournisseur + anti-IDOR chantier via RecordExpense @bob/core).
      // Source 'manual' (dictée = saisie), jamais un chemin parallèle ; un règlement déclaré fait
      // naître la dépense payée avec sa preuve (mêmes gardes domaine que l'écran).
      recordExpense: async (input) =>
        this.recordExpense({
          supplierName: input.supplierName,
          documentDate: input.documentDate ?? this.businessToday(),
          totalTtcCents: input.totalTtcCents,
          category: input.category,
          vatRatePct: input.vatRatePct ?? null,
          source: 'manual',
          ...(input.chantierId !== undefined ? { chantierId: input.chantierId } : {}),
          ...(input.payment
            ? {
                payment: {
                  paidOn: input.payment.paidOn,
                  method: input.payment.method,
                  reference: input.payment.reference ?? null,
                },
              }
            : {}),
        }),
      // Même snapshot/cutoff et même mutation atomique que l'écran Notifications. Le cutoff est
      // persisté dans la proposition opaque : une notification arrivée après ask() reste non lue.
      previewUnreadNotifications: async () =>
        ok(await this.p.notificationJobs.previewUnread(this.companyId(), this.clock.now())),
      markNotificationsReadThrough: async (input) => {
        const result = await this.p.notificationJobs.markReadThrough(
          this.companyId(),
          input.throughCreatedAt,
          this.clock.now(),
        );
        if (!result.cutoffAccepted) {
          return {
            ok: false,
            error: {
              kind: 'validation',
              issues: [
                {
                  field: 'throughCreatedAt',
                  message: 'Aperçu des notifications invalide. Demandez un nouvel aperçu.',
                },
              ],
            },
          };
        }
        return ok({ updatedCount: result.updatedCount, readAt: result.readAt });
      },
      // Enregistre uniquement un règlement fournisseur déjà effectué : date et moyen viennent de
      // la proposition confirmée ; Bob ne déclenche jamais de transfert bancaire sur ce chemin.
      recordExpensePayment: async (input) => {
        const r = await this.recordExpensePayment(input);
        if (!r.ok) return r;
        return ok(r.value);
      },
      registerPayment: async (input) =>
        this.registerPayment({
          invoiceId: input.invoiceId,
          amount: input.amountCents,
          method: 'transfer',
          idempotencyKey:
            input.idempotencyKey ?? `bob:payment:${input.invoiceId}:${input.amountCents}:transfer`,
        }),
      sendQuote: async (input) => this.sendQuote(input.quoteId),
      issueInvoice: async (input) =>
        this.issueInvoice({
          invoiceId: input.invoiceId,
          // Override L221-10 : `true` strict uniquement (le safetyFloor du registre impose la
          // confirmation dédiée ; le use case journalise payment.embargo_overridden).
          ...(input.embargoOverride === true ? { embargoOverride: true } : {}),
        }),
      // Embargo L221-10 — le DÉFAUT légal est exécutable À LA VOIX (parité avec le bouton
      // « Programmer l'encaissement ») : sans lui, seul le chemin RISQUÉ (override) serait
      // exécutable vocalement — l'inverse exact de la hiérarchie voulue.
      scheduleEmbargoPayment: async (input) => this.scheduleEmbargoPayment(input.quoteId),
      // M2 (C25 ②) — envoyer_relance : ENVOI RÉEL, MÊME service et mêmes gardes que le bouton
      // « Relancer » (POST /invoices/:id/relance → RelanceService.sendRelanceForInvoice) : ton
      // choisi par deriveRelancePlan (@bob/core), déduplication quotidienne, refus honnête si la
      // facture n'est pas relançable ou si l'email client manque. Sortant vers un tiers : le
      // plancher de confirmation vit dans le registre d'outils (@bob/ai).
      ...(this.relances
        ? {
            sendRelance: (input: SendRelanceActionInput) =>
              this.relances!.sendRelanceForInvoice(this.companyId(), input.invoiceId),
          }
        : {}),
      // S1 (LOT 5) : RESSUSCITE generer_facture_devis — l'outil était annoncé au LLM avec un
      // handler ASK-2 complet mais MORT en prod (action absente de l'hôte). Pur câblage vers le
      // MÊME use case GenerateInvoiceFromQuote que l'UI ; le safetyFloor fiscal du registre
      // s'active seul (confirmation même en 'auto').
      generateInvoice: async (input) => this.generateInvoice(input),
      // B8 — outil vocal lier_bon_commande : MÊME use case AttachPurchaseOrderToQuote que
      // PUT /quotes/:id/purchase-order (attachQuotePurchaseOrder : tenant-scoped, verrou de
      // ligne, audit). La révision courante est résolue ici — le geste vocal n'a pas de vue
      // optimiste, comme acknowledgeDocument. `invoiceable` (devis signé sans facture finale)
      // vient de ListInvoiceableQuotes : la MÊME vérité qui nourrit l'enchaînement
      // generer_facture côté agent — jamais une dérivation locale.
      attachPurchaseOrderToQuote: async (input) => {
        const quote = await this.p.quotes.findById(input.quoteId);
        if (!quote || quote.companyId !== this.companyId())
          return err(appNotFound('quote', input.quoteId));
        const attached = await this.attachQuotePurchaseOrder({
          quoteId: input.quoteId,
          purchaseOrder: { number: input.number },
          expectedRevision: quote.revision,
        });
        if (!attached.ok) return attached;
        const purchaseOrder = attached.value.purchaseOrder;
        // Un attachement sans référence posée serait une rupture du contrat du use case.
        if (purchaseOrder === null) return err(appUnavailable('quote-purchase-order'));
        const invoiceable = await new ListInvoiceableQuotes({
          quotes: this.p.quotes,
          invoices: this.p.invoices,
          customers: this.p.customers,
          // A3 — même horloge que le use case de génération (gel de rétractation cohérent).
          clock: this.clock,
        }).execute({ companyId: this.companyId() });
        return ok({
          quoteId: attached.value.targetId,
          quoteNumber: quote.number,
          revision: attached.value.revision,
          purchaseOrderNumber: purchaseOrder.number,
          invoiceable:
            invoiceable.ok && invoiceable.value.some((q) => q.id === attached.value.targetId),
        });
      },
      // creer_client (C40 TODO partagé) : fiche MINIMALE (nom + type), même use case createCustomer
      // que l'écran Clients — l'adresse (requise par le domaine) part vide, à compléter sur la fiche.
      createCustomer: async (input) =>
        this.createCustomer({
          name: input.name,
          type: input.type,
          address: { line1: '', zip: '', city: '' },
        }),
    };
  }

  private bobAgent() {
    const router = new ModelRouter({
      hasClaudeKey: hasClaudeKey(),
      hasGlmKey: hasGlmKey(),
      hasDeepseekKey: hasDeepseekKey(),
      hasMistralKey: hasMistralKey(),
      hasOpenaiKey: hasOpenaiKey(),
    });
    // Le fournisseur qui qualifie la demande (tool-calling) est choisi par le routeur.
    const provider = router.route('intent.detect').model;
    const llm = provider !== 'unavailable' ? buildLlmForProvider(provider) : undefined;
    return {
      provider,
      agent: new BobAgent({
        router,
        actions: this.buildBobActions(),
        llm,
        runtime: {
          clock: this.clock,
          ids: this.ids,
          store: new CompanyScopedJournalStore(this.p.agentJournal, this.companyId()),
        },
      }),
    };
  }

  async askBob(
    input: AgentAskPayload,
    execution?: AgentExecutionOptions,
  ): Promise<Result<AgentRun, AppError>>;
  async askBob(
    message: string,
    autonomy?: AgentAutonomy,
    execution?: AgentExecutionOptions,
  ): Promise<Result<AgentRun, AppError>>;
  async askBob(
    inputOrMessage: AgentAskPayload | string,
    legacyAutonomyOrExecution?: AgentAutonomy | AgentExecutionOptions,
    legacyExecution?: AgentExecutionOptions,
  ): Promise<Result<AgentRun, AppError>> {
    const legacyAutonomy =
      typeof legacyAutonomyOrExecution === 'string' ? legacyAutonomyOrExecution : undefined;
    const execution =
      typeof inputOrMessage === 'string'
        ? legacyExecution
        : typeof legacyAutonomyOrExecution === 'object'
          ? legacyAutonomyOrExecution
          : undefined;
    execution?.signal?.throwIfAborted();
    const parsed = parseAgentAskPayload(
      typeof inputOrMessage === 'string'
        ? {
            message: inputOrMessage,
            ...(legacyAutonomy !== undefined ? { autonomy: legacyAutonomy } : {}),
          }
        : inputOrMessage,
    );
    if (!parsed.ok) return parsed;
    const input = parsed.value;

    // L'assistant agentique est réservé aux offres avec IA (Solo+). Sans lui, l'app reste 100 % manuelle.
    const subscriptionResult = await this.subscriptionFor(this.companyId());
    if (!subscriptionResult.ok) return subscriptionResult;
    const subscription = subscriptionResult.value;
    if (!subscription.can('ai_assistant'))
      return {
        ok: false,
        error: appForbidden("L'assistant Bob est inclus à partir de l'offre Solo."),
      };
    // TODO(pilier2/monthlyActions) : LE point de branchement du quota IA — chantier compteur d'usage
    // séparé (SPEC_PILIER2_MONETISATION §9 + §Reste pt 4). Lire PLAN_CATALOG[subscription.tier].ai
    // .monthlyActions (null = fair use) et refuser AVANT d'appeler l'agent, avec les invariants
    // arrêtés : alerte à 80 %, JAMAIS de coupure mid-action (was_mid_action=false), la conformité
    // (facture légale, exports de documents) n'est jamais bloquée par un quota.
    const effectiveAutonomy = clampAgentAutonomy(
      input.autonomy,
      subscription.autonomyEntitlement(),
    );
    const start = Date.now();
    const bobRuntime = this.bobAgent();
    if (bobRuntime.provider === 'unavailable') {
      return err(appUnavailable('bob-llm'));
    }
    const agent = bobRuntime.agent;
    let r = await agent.ask(input.message, {
      autonomy: effectiveAutonomy,
      ...(input.history !== undefined ? { history: input.history } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(execution?.signal === undefined ? {} : { signal: execution.signal }),
    });
    execution?.signal?.throwIfAborted();

    // Une proposition HTTP devient une ressource serveur opaque. Le client conserve args/label
    // uniquement pour l'aperçu, mais /ai/confirm les ignore et recharge ce dry-run tenant-scoped.
    if (r.ok && r.value.kind === 'proposed' && r.value.pending) {
      try {
        execution?.signal?.throwIfAborted();
        const proposal = await agent.dryRun(
          r.value.pending.batch?.length
            ? r.value.pending.batch.map((item: BatchItem) => ({
                tool: item.tool,
                args: item.args,
                label: item.label,
              }))
            : [
                {
                  tool: r.value.pending.tool,
                  args: r.value.pending.args,
                  label: r.value.pending.label,
                },
              ],
          { autonomy: effectiveAutonomy },
        );
        execution?.signal?.throwIfAborted();
        const fullyPlanned =
          proposal.outcomes.length > 0 &&
          proposal.outcomes.every((outcome) => outcome.status === 'planned');
        if (!proposal.ok || !fullyPlanned) {
          return {
            ok: false,
            error: {
              kind: 'dependency',
              port: 'agent-proposal',
              cause: 'La proposition n’a pas pu être validée sans effet de bord.',
            },
          };
        }
        const principal = getPrincipal();
        if (!principal) {
          return {
            ok: false,
            error: appForbidden('Identité requise pour créer une proposition agent.'),
          };
        }
        execution?.signal?.throwIfAborted();
        // Lie l'intention opaque à l'utilisateur, pas seulement au tenant. Un collègue du même
        // cabinet ne peut donc pas consommer un proposalId obtenu par fuite ou copier-coller.
        await this.p.agentJournal.append(this.companyId(), {
          seq: proposal.entries.length + 1,
          runId: proposal.runId,
          at: this.clock.now(),
          phase: 'executed',
          tool: AGENT_PROPOSAL_OWNER_TOOL,
          label: 'Propriétaire de la proposition agent',
          args: { userId: principal.userId },
          mutating: false,
          outbound: false,
          compliance: 'high',
          resultDigest: 'owner-bound',
        });
        execution?.signal?.throwIfAborted();
        const expiresAt = new Date(
          Date.parse(proposal.startedAt) + AGENT_PROPOSAL_TTL_MS,
        ).toISOString();
        r = ok({
          ...r.value,
          pending: {
            ...r.value.pending,
            proposalId: proposal.runId,
            expiresAt,
          },
        });
      } catch (error) {
        execution?.signal?.throwIfAborted();
        return {
          ok: false,
          error: {
            kind: 'dependency',
            port: 'agent-proposal',
            cause: error instanceof Error ? error.message : 'proposal persistence failed',
          },
        };
      }
    }
    execution?.signal?.throwIfAborted();
    const ms = Date.now() - start;
    const intent = r.ok ? r.value.intent : 'error';
    const model = r.ok ? r.value.model : 'unavailable';
    const outcome = r.ok ? 'ok' : 'error';
    this.metrics.aiRequests.inc({ model, intent, outcome });
    this.metrics.aiDuration.observe({ model, intent }, ms / 1000);
    if (!r.ok && r.error.kind === 'dependency' && r.error.port === 'money-guard')
      this.metrics.aiGuardViolations.inc();
    this.logger.audit('ai.ask', {
      model,
      intent,
      outcome,
      ms,
      requestedAutonomy: input.autonomy ?? null,
      effectiveAutonomy,
      contextual: input.context !== undefined,
    });
    return r;
  }

  async agentJournal(runId: string): Promise<Result<JournalEntry[], AppError>> {
    const subscription = await this.subscriptionFor(this.companyId());
    if (!subscription.ok) return subscription;
    if (!subscription.value.can('ai_assistant'))
      return {
        ok: false,
        error: appForbidden("L'assistant Bob est inclus à partir de l'offre Solo."),
      };
    return ok(await this.p.agentJournal.load(this.companyId(), runId));
  }

  /** Autorité serveur du gating Bob Live. Le flag technique ne remplace jamais cet entitlement. */
  async realtimeVoiceEntitlement(): Promise<{ allowed: boolean; plan: PlanTier }> {
    const subscriptionResult = await this.subscriptionFor(this.companyId());
    if (!subscriptionResult.ok) throw new Error('subscription entitlement unavailable');
    const subscription = subscriptionResult.value;
    return {
      allowed: subscription.can('voice_live'),
      plan: subscription.tier,
    };
  }

  /**
   * Autorité serveur du gating des relances AUTOMATIQUES (`auto_dunning`, Pro+). Chemin job/cron :
   * companyId EXPLICITE (ScheduledTenantDirectory), même règle que subscriptionFor. Ne concerne
   * que le cron/batch : la relance MANUELLE validée par l'utilisateur (POST /invoices/:id/relance)
   * n'est pas une feature `auto_dunning` et reste ouverte à tous les paliers.
   */
  async autoDunningEntitlement(
    companyId: string,
  ): Promise<{ allowed: boolean; plan: PlanTier | null }> {
    const subscriptionResult = await this.subscriptionFor(companyId);
    if (!subscriptionResult.ok) return { allowed: false, plan: null };
    const subscription = subscriptionResult.value;
    return {
      // .can() = isActive() && planCanWithAddOns : un abonnement past_due/canceled ne déclenche
      // JAMAIS de relances automatiques (P1 review 14/07) — early-access reste active/business.
      allowed: subscription.can('auto_dunning'),
      plan: subscription.tier,
    };
  }

  voiceCloudAvailable(): boolean {
    return !!this.stt;
  }

  async voiceTtsCloudAvailable(): Promise<boolean> {
    const subscription = await this.subscriptionFor(this.companyId());
    return (
      subscription.ok &&
      subscription.value.isActive() &&
      !!this.tts &&
      tierAtLeast(subscription.value.tier, 'pro')
    );
  }

  async transcribe(input: {
    audioBase64: string;
    mimeType: string;
  }): Promise<Result<{ text: string }, AppError>> {
    const subscription = await this.subscriptionFor(this.companyId());
    if (!subscription.ok) return subscription;
    if (!subscription.value.can('ai_assistant'))
      return {
        ok: false,
        error: appForbidden("La dictée vocale est incluse à partir de l'offre Solo."),
      };
    const mimeType = input.mimeType.trim().toLowerCase().split(';', 1)[0] ?? '';
    if (!VOICE_AUDIO_MIME_TYPES.has(mimeType)) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'mimeType', message: 'Format audio non supporté.' }],
        },
      };
    }
    if (
      input.audioBase64.length === 0 ||
      input.audioBase64.length > VOICE_AUDIO_MAX_BASE64_CHARS ||
      !BASE64_PAYLOAD.test(input.audioBase64)
    ) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [
            { field: 'audioBase64', message: 'Audio manquant, invalide ou supérieur à 8 Mo.' },
          ],
        },
      };
    }
    const decodedBytes = Buffer.byteLength(input.audioBase64, 'base64');
    if (decodedBytes === 0 || decodedBytes > VOICE_AUDIO_MAX_BYTES) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [
            { field: 'audioBase64', message: 'Audio manquant, invalide ou supérieur à 8 Mo.' },
          ],
        },
      };
    }
    if (!this.stt)
      return {
        ok: false,
        error: appForbidden(
          'Dictée cloud non configurée pour le fournisseur vocal actif. Utilise la dictée native.',
        ),
      };
    try {
      const r = await this.stt.transcribe(input.audioBase64, mimeType);
      this.logger.audit('voice.transcribe', { model: r.model, chars: r.text.length });
      return ok({ text: r.text });
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'voice-stt',
          cause: e instanceof Error ? e.message : 'stt',
        },
      };
    }
  }

  async synthesizeSpeech(input: { text: string }): Promise<Result<TtsResult, AppError>> {
    const subscriptionResult = await this.subscriptionFor(this.companyId());
    if (!subscriptionResult.ok) return subscriptionResult;
    const subscription = subscriptionResult.value;
    if (!subscription.can('ai_assistant'))
      return {
        ok: false,
        error: appForbidden("La voix de Bob est incluse à partir de l'offre Solo."),
      };
    if (!tierAtLeast(subscription.tier, 'pro'))
      return {
        ok: false,
        error: appForbidden("La voix cloud premium est incluse à partir de l'offre Pro."),
      };
    if (!this.tts)
      return {
        ok: false,
        error: appForbidden(
          'Synthèse cloud non configurée pour le fournisseur vocal actif. Utilise la voix native.',
        ),
      };
    const text = input.text.trim();
    if (!text)
      return {
        ok: false,
        error: { kind: 'validation', issues: [{ field: 'text', message: 'Texte requis.' }] },
      };
    if (text.length > 1200)
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'text', message: 'Texte trop long pour la synthèse vocale.' }],
        },
      };
    try {
      const r = await this.tts.synthesize(text);
      this.logger.audit('voice.synthesize', {
        model: r.model,
        chars: text.length,
        cloudAudio: r.audioBase64 !== null,
      });
      return ok(r);
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'voice-tts',
          cause: e instanceof Error ? e.message : 'tts',
        },
      };
    }
  }

  private async loadOwnedAgentProposal(
    proposalIdInput: unknown,
  ): Promise<Result<OwnedAgentProposal, AppError>> {
    const proposalId = typeof proposalIdInput === 'string' ? proposalIdInput : '';
    if (!AGENT_PROPOSAL_ID.test(proposalId)) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'proposalId', message: 'Proposition serveur requise.' }],
        },
      };
    }
    try {
      const proposalEntries = await this.p.agentJournal.load(this.companyId(), proposalId);
      const planned = proposalEntries.filter((entry) => entry.phase === 'planned');
      const owner = proposalEntries.find((entry) => entry.tool === AGENT_PROPOSAL_OWNER_TOOL);
      const principalUserId = getPrincipal()?.userId;
      if (
        planned.length === 0 ||
        !owner ||
        typeof owner.args.userId !== 'string' ||
        typeof principalUserId !== 'string' ||
        owner.args.userId !== principalUserId
      ) {
        // Le même 404 opaque couvre absence, autre tenant et autre utilisateur.
        return { ok: false, error: appNotFound('agent_proposal', 'redacted') };
      }
      const proposedAt = Date.parse(planned[0]!.at);
      const now = Date.parse(this.clock.now());
      const proposalAge = now - proposedAt;
      if (
        !Number.isFinite(proposedAt) ||
        !Number.isFinite(now) ||
        proposalAge < 0 ||
        proposalAge > AGENT_PROPOSAL_TTL_MS
      ) {
        return {
          ok: false,
          error: {
            kind: 'validation',
            issues: [
              {
                field: 'proposalId',
                message: 'Cette proposition a expiré. Demandez un nouvel aperçu.',
              },
            ],
          },
        };
      }
      return ok({
        proposalId,
        planned,
        expiresAt: new Date(proposedAt + AGENT_PROPOSAL_TTL_MS).toISOString(),
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'agent-journal',
          cause: error instanceof Error ? error.message : 'proposal load failed',
        },
      };
    }
  }

  /** Aperçu owner-bound d'une proposition vocale/HTTP. Les args servent uniquement au diff ;
   * `/ai/confirm` les ignore toujours et recharge ce même journal opaque. */
  async previewBobProposal(input: {
    proposalId?: unknown;
  }): Promise<Result<PendingAction, AppError>> {
    const subscriptionResult = await this.subscriptionFor(this.companyId());
    if (!subscriptionResult.ok) return subscriptionResult;
    const subscription = subscriptionResult.value;
    if (!subscription.can('ai_assistant')) {
      return {
        ok: false,
        error: appForbidden("L'assistant Bob est inclus à partir de l'offre Solo."),
      };
    }
    const loaded = await this.loadOwnedAgentProposal(input.proposalId);
    if (!loaded.ok) return loaded;
    const items = loaded.value.planned.map((entry) => ({
      tool: entry.tool,
      args: { ...entry.args },
      label: entry.label,
    }));
    const first = items[0]!;
    this.logger.audit('ai.proposal.preview', { outcome: 'ok', actions: items.length });
    return ok({
      ...first,
      proposalId: loaded.value.proposalId,
      expiresAt: loaded.value.expiresAt,
      ...(items.length > 1 ? { batch: items } : {}),
    });
  }

  async confirmBob(input: { proposalId?: unknown }): Promise<Result<AgentRun, AppError>> {
    const subscriptionResult = await this.subscriptionFor(this.companyId());
    if (!subscriptionResult.ok) return subscriptionResult;
    const subscription = subscriptionResult.value;
    if (!subscription.can('ai_assistant'))
      return {
        ok: false,
        error: appForbidden("L'assistant Bob est inclus à partir de l'offre Solo."),
      };
    const proposalIdForAudit = typeof input.proposalId === 'string' ? input.proposalId : 'invalid';
    try {
      const companyId = this.companyId();
      const loaded = await this.loadOwnedAgentProposal(input.proposalId);
      if (!loaded.ok) return loaded;
      const { proposalId, planned } = loaded.value;

      // Autorisation fermée : un outil sortant n'est exécutable que si son adapter a été audité
      // outbox commitée + worker idempotent. Toute future capability outbound est bloquée par
      // défaut jusqu'à ajout explicite dans cette liste après tests de fault-injection.
      const unsafeOutbound = planned.find(
        (entry) => entry.outbound && !AGENT_OUTBOX_SAFE_TOOLS.has(entry.tool),
      );
      if (unsafeOutbound) {
        return {
          ok: false,
          error: appForbidden(
            "Cette action sortante n'est pas encore reliée à une outbox sécurisée. Termine-la à l'écran.",
          ),
        };
      }

      const confirmationRunId = `confirm:${proposalId}`;
      const claimed = await this.p.agentJournal.claim(companyId, {
        seq: 1,
        runId: confirmationRunId,
        at: this.clock.now(),
        phase: 'planned',
        tool: '__confirm_proposal__',
        label: 'Confirmation de proposition agent',
        args: { proposalId },
        mutating: false,
        outbound: false,
        compliance: 'high',
      });
      if (!claimed) {
        return {
          ok: false,
          error: {
            kind: 'validation',
            issues: [{ field: 'proposalId', message: 'Cette proposition a déjà été consommée.' }],
          },
        };
      }

      const invocations: RuntimeInvocation[] = planned.map((entry) => ({
        tool: entry.tool,
        args: entry.args,
        label: entry.label,
      }));
      const record = await this.bobAgent().agent.runJournaled(invocations, {
        autonomy: subscription.autonomyEntitlement(),
        runId: `execute:${proposalId}`,
      });
      const blocked = record.outcomes.find((o) => o.status === 'denied' || o.status === 'failed');
      this.logger.audit('ai.confirm', {
        tools: planned.map((entry) => entry.tool),
        proposalId,
        runId: record.runId,
        journalEntries: record.entries.length,
        outcome: blocked ? 'error' : 'ok',
      });
      if (blocked) {
        if (blocked.status === 'denied')
          return {
            ok: false,
            error: appForbidden(blocked.reason ?? 'Action refusée par la policy.'),
          };
        return {
          ok: false,
          error: {
            kind: 'dependency',
            port: 'agent-runtime',
            cause: blocked.reason ?? 'agent execution failed',
          },
        };
      }
      const isBatch = invocations.length > 1;
      const quoteOutcome = record.outcomes.find(
        (outcome) => outcome.tool === 'envoyer_devis' && outcome.status === 'executed',
      );
      const notificationReadOutcome = record.outcomes.find(
        (outcome) => outcome.tool === 'marquer_notifications_lues' && outcome.status === 'executed',
      );
      const purchaseOrderOutcome = record.outcomes.find(
        (outcome) => outcome.tool === 'lier_bon_commande' && outcome.status === 'executed',
      );
      const relanceOutcome = record.outcomes.find(
        (outcome) => outcome.tool === 'envoyer_relance' && outcome.status === 'executed',
      );
      const quoteDeliveryStatus = quoteOutcome?.result?.deliveryStatus;
      if (!isBatch && purchaseOrderOutcome) {
        // B8 — MÊME enchaînement que BobAgent.confirm : après le lien confirmé, la carte
        // propose la facture du devis (choices + spokenPrompt) depuis la projection publique
        // de l'outil — le chemin HTTP /ai/confirm rend le même parcours que le runtime local.
        return ok(
          purchaseOrderLinkedRun({
            intent: 'lier_bon_commande',
            model: 'agent-runtime',
            label: planned[0]!.label,
            output: purchaseOrderOutcome.result,
          }),
        );
      }
      if (!isBatch && notificationReadOutcome) {
        const count = notificationMutationCount(notificationReadOutcome.result);
        if (count === null) {
          return {
            ok: false,
            error: {
              kind: 'dependency',
              port: 'agent-runtime',
              cause: 'Résultat de mutation notifications invalide.',
            },
          };
        }
        return ok({
          kind: 'done',
          intent: 'marquer_notifications_lues',
          model: 'agent-runtime',
          plan: record.outcomes.map((outcome) => outcome.label),
          card: {
            title: 'Notifications à jour',
            body:
              count === 0
                ? 'Aucune notification supplémentaire n’était encore non lue au moment de la confirmation.'
                : `${count} notification${count > 1 ? 's ont' : ' a'} été marquée${count > 1 ? 's' : ''} comme lue${count > 1 ? 's' : ''}.`,
          },
        });
      }
      if (!isBatch && relanceOutcome) {
        // M2 — MÊME carte que BobAgent.confirm local (parité humain↔voix) : l'envoi confirmé
        // d'une relance mérite sa carte — l'e-mail part par l'outbox, sa livraison est visible
        // dans l'activité.
        return ok({
          kind: 'done',
          intent: 'relance',
          model: 'agent-runtime',
          plan: record.outcomes.map((outcome) => outcome.label),
          card: { title: 'Relance envoyée ✓', body: `${planned[0]!.label} — c’est parti.` },
        });
      }
      if (!isBatch && quoteDeliveryStatus === 'queued') {
        return ok({
          kind: 'done',
          intent: 'envoyer_devis',
          model: 'agent-runtime',
          plan: record.outcomes.map((outcome) => outcome.label),
          card: {
            title: 'Envoi programmé',
            body: 'Le devis est prêt. L’e-mail partira en arrière-plan et sa livraison sera visible dans l’activité.',
          },
        });
      }
      if (!isBatch && quoteDeliveryStatus === 'sent') {
        return ok({
          kind: 'done',
          intent: 'envoyer_devis',
          model: 'agent-runtime',
          plan: record.outcomes.map((outcome) => outcome.label),
          card: {
            title: 'Devis envoyé',
            body: 'L’e-mail a été pris en charge par le service d’envoi.',
          },
        });
      }
      if (!isBatch && quoteDeliveryStatus === 'skipped') {
        return ok({
          kind: 'done',
          intent: 'envoyer_devis',
          model: 'agent-runtime',
          plan: record.outcomes.map((outcome) => outcome.label),
          card: {
            title: 'Devis préparé',
            body: 'Le devis est passé au statut Envoyé, mais aucun e-mail n’a été programmé. Vérifiez l’adresse du client.',
          },
        });
      }
      if (isBatch) {
        const summaryLines: string[] = [];
        for (const outcome of record.outcomes) {
          const status = outcome.result?.deliveryStatus;
          if (outcome.tool === 'envoyer_devis' && status === 'queued') {
            summaryLines.push(`⏳ ${outcome.label} — envoi programmé`);
            continue;
          }
          if (outcome.tool === 'envoyer_devis' && status === 'sent') {
            summaryLines.push(`✓ ${outcome.label} — e-mail pris en charge`);
            continue;
          }
          if (outcome.tool === 'envoyer_devis' && status === 'skipped') {
            summaryLines.push(`⚠ ${outcome.label} — aucun e-mail programmé`);
            continue;
          }
          if (outcome.tool === 'marquer_notifications_lues') {
            const count = notificationMutationCount(outcome.result);
            if (count === null) {
              return {
                ok: false,
                error: {
                  kind: 'dependency',
                  port: 'agent-runtime',
                  cause: 'Résultat de mutation notifications invalide.',
                },
              };
            }
            summaryLines.push(
              count === 0
                ? '✓ Notifications déjà à jour au moment de l’exécution'
                : `✓ ${count} notification${count > 1 ? 's' : ''} marquée${count > 1 ? 's' : ''} comme lue${count > 1 ? 's' : ''}`,
            );
            continue;
          }
          summaryLines.push(`✓ ${outcome.label}`);
        }
        return ok({
          kind: 'done',
          intent: 'unknown',
          model: 'agent-runtime',
          plan: record.outcomes.map((outcome) => outcome.label),
          card: {
            title: 'Actions traitées',
            body: summaryLines.join('\n'),
          },
        });
      }
      return ok({
        kind: 'done',
        intent: 'unknown',
        model: 'agent-runtime',
        plan: record.outcomes.map((o) => o.label),
        card: {
          title: 'Fait ✓',
          body: `${planned[0]!.label} — c’est noté.`,
        },
      });
    } catch (e) {
      this.logger.audit('ai.confirm', {
        proposalId: proposalIdForAudit,
        outcome: 'error',
        journal: 'failed',
      });
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'agent-journal',
          cause: e instanceof Error ? e.message : 'journal append failed',
        },
      };
    }
  }

  // ——— Monétisation ———
  /**
   * Lecture d'autorité de l'abonnement du tenant — GetSubscriptionStatus (@bob/core) sur la
   * table `subscriptions` (pilier 2). L'accès anticipé historique est une ligne BDD explicite
   * (`business`, `active`, `store='none'`, sans période facturée). Partagée par
   * GET /subscription, le bilan de fin d'essai et l'affordance vocale « où en est mon essai ».
   */
  private subscriptionStatus(companyId: string): Promise<Result<SubscriptionStatusView, AppError>> {
    return new GetSubscriptionStatus({ subscriptions: this.p.subscriptions }).execute({
      companyId,
      now: this.clock.now(),
    });
  }

  /**
   * GET /subscription (C26b → pilier 2) — abonnement RÉEL du tenant courant, DB-backed
   * (guard : JWT + tenant requis). Palier EFFECTIF de l'essai inversé : pendant l'essai le
   * palier prêté (Pro), expiré → atterrissage doux sur Découverte (free, données conservées).
   */
  async getSubscription() {
    const status = await this.subscriptionStatus(this.companyId());
    if (!status.ok) return status;
    const s = status.value;
    const effectiveTier: PlanTier = s.trialPhase === 'expired' ? 'free' : s.plan;
    const earlyAccess =
      s.store === 'none' &&
      s.status === 'active' &&
      s.currentPeriodEnd === null &&
      s.storeRef === null;
    return ok({
      tier: effectiveTier,
      status: s.status,
      // Tenant sans ligne (pré-migration) : accès anticipé assumé côté client — l'écran
      // Compte dérive l'état « accès anticipé, 0 € », jamais un plan payant inventé.
      earlyAccess,
      store: s.store,
      billingAvailable: this.gateway.subscriptionBillingAvailable,
      // Rien n'est facturé pendant un essai NI en accès anticipé : seul un abonnement
      // ACTIF persisté porte le prix catalogue (source unique PLAN_CATALOG).
      priceCents:
        !earlyAccess && s.status === 'active' ? PLAN_CATALOG[effectiveTier].priceCents : 0,
      currentPeriodEnd: s.currentPeriodEnd,
      trialEndsAt: s.trialEndsAt,
      trialPhase: s.trialPhase,
      trialDaysLeft: s.trialDaysLeft,
      features: [...planEntitlements(effectiveTier)],
      ai: PLAN_CATALOG[effectiveTier].ai,
      // Add-ons pas encore persistés (aucune vente ouverte) : autonomie par défaut du palier.
      autonomyEntitlement: resolveAutonomyEntitlement(effectiveTier, []),
      limits: PLAN_CATALOG[effectiveTier].limits,
      addOns: [] as string[],
      addOnCatalog: Object.values(ADDON_CATALOG),
      catalog: Object.values(PLAN_CATALOG),
    });
  }

  async listSubscriptionInvoices() {
    // Accès anticipé (aucune variable Stripe posée → DisabledPaymentGateway) : la VÉRITÉ est
    // « aucune facture d'abonnement » — 200 liste vide, pas une panne. Aucun webhook ne peut
    // être vérifié dans ce mode, donc aucune facture n'a jamais pu être persistée. Le 503
    // reste réservé aux vraies pannes quand la facturation Stripe est ACTIVE.
    if (!this.gateway.subscriptionBillingAvailable) return ok([]);
    if (this.stripeBilling === null) return err(appUnavailable('stripe-billing'));
    try {
      const invoices = await this.stripeBilling.listSubscriptionInvoices(this.companyId());
      // Contrat public minimal : les identifiants fournisseur de la relation client/abonnement,
      // l'id du dernier webhook et les horodatages internes restent strictement côté serveur.
      return ok(
        invoices.map((invoice) => ({
          stripeInvoiceId: invoice.stripeInvoiceId,
          status: invoice.status,
          currency: invoice.currency,
          number: invoice.number,
          totalCents: invoice.totalCents,
          issuedAt: invoice.issuedAt,
          paidAt: invoice.paidAt,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl,
          invoicePdfUrl: invoice.invoicePdfUrl,
        })),
      );
    } catch (cause) {
      return err({
        kind: 'dependency' as const,
        port: 'stripe-billing-invoices',
        cause: cause instanceof Error ? cause.message : 'stripe billing invoices unavailable',
      });
    }
  }

  async getProfile(): Promise<Result<TradeConfig, AppError>> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return { ok: false, error: appNotFound('company', this.companyId()) };
    const subscription = await this.subscriptionFor(this.companyId());
    if (!subscription.ok) return subscription;
    return ok(
      resolveTradeConfig(company.trade, subscription.value.tier, subscription.value.addOns),
    );
  }

  // ——— Profil fiscal (BOB EXPERT FISCAL, Phase 1A — SPEC_EXPERT_FISCAL.md §V2) ———
  /**
   * GET /fiscal-profile — profil fiscal du tenant courant. Absent en base : dérivé par
   * hypothèses depuis la forme juridique (GetFiscalProfile @bob/core), persisté au passage.
   */
  async getFiscalProfile(): Promise<Result<FiscalProfileView, AppError>> {
    const companyId = this.companyId();
    const company = await this.p.companies.findById(companyId);
    if (!company) return { ok: false, error: appNotFound('company', companyId) };
    return new GetFiscalProfile({ fiscalProfiles: this.p.fiscalProfiles }).execute({
      company: this.fiscalDerivationInput(company),
      now: this.clock.now(),
    });
  }

  /**
   * Phase B fiscal : la dérivation initiale reçoit TOUTE la fiche société réelle — régime TVA
   * choisi à l'onboarding (→ 'confirme_utilisateur'), NAF/APE (affine la nature d'activité),
   * date de création (hypothèse ACRE), n° TVA intracom (corroboration). Champs optionnels du
   * contrat FiscalProfileDerivationInput : jamais une valeur inventée quand la fiche est muette.
   */
  private fiscalDerivationInput(company: Company): FiscalProfileDerivationInput {
    return {
      id: company.id,
      legalForm: company.legalForm,
      trade: company.trade,
      vatRegime: company.vatRegime,
      ...(company.apeCode === undefined ? {} : { nafApe: company.apeCode }),
      ...(company.dateCreation === undefined ? {} : { dateCreation: company.dateCreation }),
      ...(company.tvaIntracom === undefined ? {} : { tvaIntracom: company.tvaIntracom }),
    };
  }

  /**
   * PATCH /fiscal-profile/:field — un champ à la fois, statut forcé 'confirme_utilisateur',
   * invariants revalidés (UpdateFiscalProfileField @bob/core) — rejette avec l'erreur domaine
   * (422) si la mise à jour rend le profil incohérent ; rien n'est modifié dans ce cas.
   */
  async updateFiscalProfileField(
    field: string,
    value: unknown,
  ): Promise<Result<FiscalProfileView, AppError>> {
    const parsed = parseFiscalProfileFieldPatch(field, value);
    if (!parsed.ok) return parsed;
    const companyId = this.companyId();
    // Écriture profil + reflet éventuel sur la fiche société dans la MÊME transaction tenant
    // (réentrant sous l'intercepteur HTTP : ces deux écritures committent ou échouent ensemble).
    return this.p.runInTransaction(async (): Promise<Result<FiscalProfileView, AppError>> => {
      const company = await this.p.companies.findById(companyId);
      if (!company) return { ok: false, error: appNotFound('company', companyId) };
      const updated = await new UpdateFiscalProfileField({
        fiscalProfiles: this.p.fiscalProfiles,
      }).execute({
        company: this.fiscalDerivationInput(company),
        patch: parsed.value,
        now: this.clock.now(),
        source: 'user_form',
      });
      if (!updated.ok) return updated;
      // SYNC Phase B : Company.vatRegime pilote les échéances fiscales (deriveFiscalCalendar).
      // La confirmation/correction du régime TVA sur le profil est reflétée sur la fiche société
      // (conversion 'reel_simplifie' → 'reel_simpl') — une divergence durable entre les deux
      // champs serait le bug « états dupliqués ». Les AUTRES champs du profil n'y touchent pas.
      if (parsed.value.field === 'vatRegime') {
        const nextVatRegime = companyVatRegimeFromFiscal(parsed.value.value);
        if (company.vatRegime !== nextVatRegime) {
          const synced = Company.of({ ...company.toProps(), vatRegime: nextVatRegime });
          if (!synced.ok) return err(appDomain(synced.error));
          await this.p.companies.save(synced.value);
          this.logger.audit('company.vat_regime_synced_from_fiscal_profile', {
            companyId,
            vatRegime: nextVatRegime,
          });
        }
      }
      return updated;
    });
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

  // ——— Catalogue propriétaire (PostgreSQL/RLS en live, aucune suggestion tarifaire implicite) ———
  async listCatalogueItems() {
    return new ListCatalogueItems({ catalogue: this.p.catalogue }).execute({
      companyId: this.companyId(),
    });
  }

  async createCatalogueItem(item: CatalogueItemWriteInput) {
    const result = await new CreateCatalogueItem({
      catalogue: this.p.catalogue,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId(), item });
    if (result.ok) {
      this.logger.audit('catalogue.item_created', {
        companyId: this.companyId(),
        itemId: result.value.id,
        revision: result.value.revision,
      });
    }
    return result;
  }

  async updateCatalogueItem(input: {
    itemId: string;
    expectedRevision: number;
    item: CatalogueItemWriteInput;
  }) {
    const result = await new UpdateCatalogueItem({
      catalogue: this.p.catalogue,
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      item: input.item,
    });
    if (result.ok) {
      this.logger.audit('catalogue.item_updated', {
        companyId: this.companyId(),
        itemId: result.value.id,
        revision: result.value.revision,
      });
    }
    return result;
  }

  async deleteCatalogueItem(input: { itemId: string; expectedRevision: number }) {
    const result = await new DeleteCatalogueItem({ catalogue: this.p.catalogue }).execute({
      companyId: this.companyId(),
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
    });
    if (result.ok) {
      this.logger.audit('catalogue.item_deleted', {
        companyId: this.companyId(),
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
      });
    }
    return result;
  }

  // ——— Module Chantiers (vertical BTP, gated par métier × palier/add-on) ———
  private async chantiersAllowed(): Promise<boolean> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return false;
    const subscription = await this.subscriptionFor(this.companyId());
    if (!subscription.ok) return false;
    return resolveTradeConfig(
      company.trade,
      subscription.value.tier,
      subscription.value.addOns,
    ).modules.some((m) => m.key === 'chantiers' && m.active);
  }

  async createChantier(
    input: Omit<CreateChantierInput, 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>> {
    if (!(await this.chantiersAllowed()))
      return {
        ok: false,
        error: appForbidden(
          'Module Chantiers réservé aux métiers du bâtiment (offre Solo minimum, ou Pack BTP).',
        ),
      };
    const r = await new CreateChantier({
      chantiers: this.p.chantiers,
      customers: this.p.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId(), ...input });
    if (r.ok)
      this.logger.audit('chantier.created', { companyId: this.companyId(), id: r.value.id });
    return r;
  }

  /** Compteurs notes/photos par chantier (rangée de liste) : DEUX agrégats bulk (groupBy),
   * JAMAIS un listByChantier() par chantier — le coût reste constant quel que soit le nombre
   * de chantiers. */
  async listChantiers(): Promise<Result<ChantierListItem[], AppError>> {
    if (!(await this.chantiersAllowed()))
      return {
        ok: false,
        error: appForbidden(
          'Module Chantiers réservé aux métiers du bâtiment (offre Solo minimum, ou Pack BTP).',
        ),
      };
    const companyId = this.companyId();
    const [list, noteCounts, photoCounts] = await Promise.all([
      this.p.chantiers.listByCompany(companyId),
      this.p.chantierNotes.countByCompany(companyId),
      this.p.worksiteMedia.countByCompany(companyId),
    ]);
    return ok(
      list.map((c) => ({
        ...c.toProps(),
        noteCount: noteCounts.get(c.id) ?? 0,
        photoCount: photoCounts.get(c.id) ?? 0,
      })),
    );
  }

  /** Journal + photos (fiche chantier, extension V1) : gate module IDENTIQUE à createChantier —
   * pas de chemin parallèle possible pour contourner l'offre. */
  private async chantierMediaForbidden(): Promise<AppError | null> {
    if (await this.chantiersAllowed()) return null;
    return appForbidden(
      'Module Chantiers réservé aux métiers du bâtiment (offre Solo minimum, ou Pack BTP).',
    );
  }

  async addChantierNote(
    chantierId: string,
    input: { text: string },
  ): Promise<Result<{ id: string }, AppError>> {
    const forbidden = await this.chantierMediaForbidden();
    if (forbidden) return { ok: false, error: forbidden };
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return { ok: false, error: appNotFound('company', this.companyId()) };
    const r = await new AddChantierNote({
      chantiers: this.p.chantiers,
      notes: this.p.chantierNotes,
      ids: this.ids,
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      chantierId,
      text: input.text,
      // Attribution auto (produit mono-utilisateur aujourd'hui) — prêt pour un futur
      // multi-utilisateur (cabinet, salariés) sans migration ni changement de contrat.
      authorLabel: company.name,
    });
    if (r.ok) this.logger.audit('chantier.note.added', { companyId: this.companyId(), chantierId });
    return r;
  }

  async listChantierNotes(chantierId: string): Promise<Result<ChantierNoteProps[], AppError>> {
    const forbidden = await this.chantierMediaForbidden();
    if (forbidden) return { ok: false, error: forbidden };
    const list = await this.p.chantierNotes.listByChantier(this.companyId(), chantierId);
    return ok(list.map((n) => n.toProps()));
  }

  async uploadWorksitePhoto(
    chantierId: string,
    input: { contentBase64: string; mimeType: string; filename: string },
  ): Promise<Result<WorksiteMediaItem, AppError>> {
    const forbidden = await this.chantierMediaForbidden();
    if (forbidden) return { ok: false, error: forbidden };
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(input.contentBase64, 'base64'));
    } catch {
      return {
        ok: false,
        error: appDomain({
          code: 'VALIDATION',
          field: 'contentBase64',
          message: 'Photo illisible.',
        }),
      };
    }
    const r = await new UploadWorksitePhoto({
      chantiers: this.p.chantiers,
      media: this.p.worksiteMedia,
      storage: this.documentStorage,
      ids: this.ids,
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      chantierId,
      bytes,
      contentType: input.mimeType,
      filename: input.filename,
    });
    if (r.ok)
      this.logger.audit('chantier.photo.uploaded', {
        companyId: this.companyId(),
        chantierId,
        id: r.value.id,
      });
    return r;
  }

  async listWorksitePhotos(chantierId: string): Promise<Result<WorksiteMediaItem[], AppError>> {
    const forbidden = await this.chantierMediaForbidden();
    if (forbidden) return { ok: false, error: forbidden };
    return ok(await this.p.worksiteMedia.listByChantier(this.companyId(), chantierId));
  }

  async worksitePhotoViewUrl(
    photoId: string,
  ): Promise<Result<{ url: string; expiresInSeconds: number }, AppError>> {
    const forbidden = await this.chantierMediaForbidden();
    if (forbidden) return { ok: false, error: forbidden };
    const item = await this.p.worksiteMedia.findById(this.companyId(), photoId);
    if (!item) return { ok: false, error: appNotFound('worksite_photo', photoId) };
    const ttlSeconds = 300;
    const url = await this.documentStorage.getSignedUrl(
      this.companyId(),
      item.storageKey,
      ttlSeconds,
    );
    return ok({ url, expiresInSeconds: ttlSeconds });
  }

  async deleteWorksitePhoto(photoId: string): Promise<Result<void, AppError>> {
    const forbidden = await this.chantierMediaForbidden();
    if (forbidden) return { ok: false, error: forbidden };
    const r = await new DeleteWorksitePhoto({
      media: this.p.worksiteMedia,
      storage: this.documentStorage,
    }).execute({ companyId: this.companyId(), id: photoId });
    if (r.ok)
      this.logger.audit('chantier.photo.deleted', { companyId: this.companyId(), id: photoId });
    return r;
  }

  async getDiagnostic(): Promise<Result<DiagnosticResult, AppError>> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return { ok: false, error: appNotFound('company', this.companyId()) };
    const customers = await this.p.customers.listByCompany(this.companyId());
    const customerTypes = [...new Set(customers.map((c) => c.type))];
    // Année civile 293 B, validité décennale, asOf : calendrier MÉTIER Paris.
    const today = this.businessToday();
    // E6 (PONT-SERVEUR v1) : recettes ENCAISSÉES de l'année civile courante — la surveillance des
    // seuils de franchise 293 B lit du RÉEL (paiements datés du tenant), jamais un statut
    // décoratif. Les avoirs ne génèrent pas de paiement.
    const year = today.slice(0, 4);
    const payments = await this.p.payments.listByCompany(this.companyId());
    const annualEncaissedCents = payments
      .filter((p) => p.receivedAt.slice(0, 4) === year)
      .reduce((sum, p) => sum + p.amount, 0);
    return ok(
      runDiagnostic({
        country: 'FR',
        trade: company.trade,
        vatRegime: company.vatRegime,
        customerTypes,
        hasDecennale: company.hasValidDecennale(today),
        asOf: today,
        annualEncaissedCents,
      }),
    );
  }

  /** GET /company/me (PONT-SERVEUR v1) : la fiche société RÉELLE du tenant (CompanyProps complet)
   * — LE débloqueur de l'identité en mode connecté (useIdentity : raison sociale + ligne légale
   * lues en BDD, jamais un nom inventé — TODO tracé apps/mobile/src/data/identity.ts). */
  async getCompanyMe(): Promise<Result<CompanyProps, AppError>> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return { ok: false, error: appNotFound('company', this.companyId()) };
    return ok(company.toProps());
  }

  /** Réglages canoniques : absence = incohérence de provisioning, jamais un fallback client. */
  async getCompanyBillingSettings(): Promise<Result<CompanyBillingSettings, AppError>> {
    const companyId = this.companyId();
    const settings = await this.p.billingSettings.findByCompanyId(companyId);
    if (settings === null) return err(appUnavailable('company-billing-settings'));
    return ok(settings);
  }

  async updateCompanyBillingSettings(input: {
    expectedRevision: number;
    patch: CompanyBillingSettingsPatch;
  }): Promise<Result<CompanyBillingSettings, AppError>> {
    const validated = validateCompanyBillingSettingsPatch(input.patch);
    if (!validated.ok) return err(appDomain(validated.error));
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'expectedRevision', message: 'Révision invalide.' }],
        },
      };
    }
    const changesArchivedPdf =
      validated.value.showRibOnInvoices !== undefined ||
      validated.value.showInsuranceOnInvoices !== undefined ||
      validated.value.pdfAccentColor !== undefined;
    const companyId = this.companyId();
    const updated = await this.p.runInTransaction(async (): Promise<Result<CompanyBillingSettings, AppError>> => {
      // Ordre global anti-deadlock : Company FOR UPDATE avant settings, factures ou documents.
      const company = await this.p.companies.lockById(companyId);
      if (!company) return err(appNotFound('company', companyId));
      if (company.isClosed()) return err(appForbidden('Compte clôturé.'));
      if (changesArchivedPdf) {
        const archiveReady = await this.assertIssuedInvoiceArchivesComplete(companyId);
        if (!archiveReady.ok) return archiveReady;
      }
      const result = await this.p.billingSettings.update({
        companyId,
        expectedRevision: input.expectedRevision,
        patch: validated.value,
      });
      return result.status === 'revision_conflict'
        ? err(appConflict('company_billing_settings', 'stale_revision'))
        : ok(result.settings);
    });
    if (!updated.ok) return updated;
    this.logger.audit('company.billing_settings_updated', {
      companyId,
      revision: updated.value.revision,
      fields: Object.keys(validated.value).sort(),
    });
    return updated;
  }

  /** Profil d'exploitation explicitement confirmé par le propriétaire. */
  async updateCompanyProfile(input: {
    trade: Trade;
    vatRegime: VatRegime;
    customerPortfolio?: CustomerPortfolio;
  }): Promise<Result<CompanyProps, AppError>> {
    const companyId = this.companyId();
    const persisted = await this.p.runInTransaction(async (): Promise<Result<CompanyProps, AppError>> => {
      const current = await this.p.companies.lockById(companyId);
      if (!current) return err(appNotFound('company', companyId));
      if (current.isClosed()) return err(appForbidden('Compte clôturé.'));
      // A8 — le régime de TVA est relu au RENDU du devis (mention art. 293 B CGI via
      // buildMentions) : tant qu'un contrat signé n'a pas son original archivé, le changer
      // fabriquerait une archive différente du document signé par le client.
      const quoteArchiveReady = await this.assertSignedQuoteArchivesComplete(companyId);
      if (!quoteArchiveReady.ok) return quoteArchiveReady;
      const updated = Company.of({
        ...current.toProps(),
        trade: input.trade,
        vatRegime: input.vatRegime,
        ...(input.customerPortfolio === undefined
          ? {}
          : { customerPortfolio: input.customerPortfolio }),
      });
      if (!updated.ok) return err(appDomain(updated.error));
      await this.p.companies.save(updated.value);
      return ok(updated.value.toProps());
    });
    if (!persisted.ok) return persisted;
    this.logger.audit('company.profile_confirmed', {
      companyId,
      trade: input.trade,
      vatRegime: input.vatRegime,
      customerPortfolioChanged: input.customerPortfolio !== undefined,
    });
    return persisted;
  }

  /** Réglages facturation §Coordonnées bancaires (RIB) — écrit iban/bic (déjà persistés, jusqu'ici
   * jamais éditables après l'onboarding). Partiel : un champ `undefined` en entrée = inchangé,
   * `null` = effacé explicitement (jamais un iban/bic fantôme réinjecté par accident). */
  async updateCompanyBilling(input: {
    iban?: string | null;
    bic?: string | null;
  }): Promise<Result<CompanyProps, AppError>> {
    const companyId = this.companyId();
    const persisted = await this.p.runInTransaction(async (): Promise<Result<CompanyProps, AppError>> => {
      const current = await this.p.companies.lockById(companyId);
      if (!current) return err(appNotFound('company', companyId));
      if (current.isClosed()) return err(appForbidden('Compte clôturé.'));
      const archiveReady = await this.assertIssuedInvoiceArchivesComplete(companyId);
      if (!archiveReady.ok) return archiveReady;
      const props = current.toProps();
      const updated = Company.of({
        ...props,
        iban: input.iban === undefined ? props.iban : (input.iban ?? undefined),
        bic: input.bic === undefined ? props.bic : (input.bic ?? undefined),
      });
      if (!updated.ok) return err(appDomain(updated.error));
      await this.p.companies.save(updated.value);
      return ok(updated.value.toProps());
    });
    if (!persisted.ok) return persisted;
    this.logger.audit('company.billing_updated', {
      companyId,
      ibanChanged: input.iban !== undefined,
      bicChanged: input.bic !== undefined,
    });
    return persisted;
  }

  /**
   * PATCH /company/legal — Réglages entreprise §Identité légale : capital social (A6,
   * art. R123-238 c. com.) et médiateur de la consommation (A2, art. L612-1/L616-1 c. conso).
   * MÊME sémantique partielle que /company/billing : champ `undefined` = inchangé, `null` =
   * effacé explicitement. Ces valeurs s'impriment sur les pièces (bloc émetteur/mention B2C) :
   * même barrière d'archives que le RIB — les originaux déjà émis doivent être archivés avant
   * qu'une donnée relue au rendu puisse changer.
   */
  async updateCompanyLegal(input: {
    capitalSocialCents?: number | null;
    mediateurConso?: { nom: string; coordonnees: string } | null;
    /** A3 — coordonnées de l'ENTREPRISE exigées par les modèles de rétractation en vigueur
     *  (courriel : formulaire R221-1 + avis R221-3 ; téléphone : avis R221-3 — décret
     *  n° 2022-424). Même sémantique partielle : undefined = inchangé, null = effacé. */
    email?: string | null;
    phone?: string | null;
  }): Promise<Result<CompanyProps, AppError>> {
    const companyId = this.companyId();
    const persisted = await this.p.runInTransaction(async (): Promise<Result<CompanyProps, AppError>> => {
      const current = await this.p.companies.lockById(companyId);
      if (!current) return err(appNotFound('company', companyId));
      if (current.isClosed()) return err(appForbidden('Compte clôturé.'));
      const archiveReady = await this.assertIssuedInvoiceArchivesComplete(companyId);
      if (!archiveReady.ok) return archiveReady;
      // A8 — capital (A6) et médiateur (A2) s'impriment AUSSI sur le devis, relus au rendu
      // (quoteMentions) : un contrat signé dont l'original n'est pas encore archivé bloque.
      const quoteArchiveReady = await this.assertSignedQuoteArchivesComplete(companyId);
      if (!quoteArchiveReady.ok) return quoteArchiveReady;
      const props = current.toProps();
      const updated = Company.of({
        ...props,
        capitalSocialCents:
          input.capitalSocialCents === undefined
            ? props.capitalSocialCents
            : (input.capitalSocialCents ?? undefined),
        mediateurConso:
          input.mediateurConso === undefined
            ? props.mediateurConso
            : (input.mediateurConso ?? undefined),
        email: input.email === undefined ? props.email : (input.email ?? undefined),
        phone: input.phone === undefined ? props.phone : (input.phone ?? undefined),
      });
      if (!updated.ok) return err(appDomain(updated.error));
      await this.p.companies.save(updated.value);
      return ok(updated.value.toProps());
    });
    if (!persisted.ok) return persisted;
    this.logger.audit('company.legal_updated', {
      companyId,
      capitalChanged: input.capitalSocialCents !== undefined,
      mediateurChanged: input.mediateurConso !== undefined,
      emailChanged: input.email !== undefined,
      phoneChanged: input.phone !== undefined,
    });
    return persisted;
  }

  /** C-EXP5b : échéancier fiscal du tenant — MÊME use case pur (deriveFiscalCalendar @bob/core).
   * La clôture confirmée est relue depuis le profil fiscal PostgreSQL. Une hypothèse ou une
   * périodicité URSSAF encore absente reste `null` et produit uniquement des échéances marquées
   * `assumed` ; jamais un réglage local ou une date présentée comme certaine. */
  async getFiscalCalendar(): Promise<Result<FiscalDeadline[], AppError>> {
    const companyId = this.companyId();
    const company = await this.p.companies.findById(companyId);
    if (!company) return { ok: false, error: appNotFound('company', companyId) };
    const fiscalProfile = await this.getFiscalProfile();
    if (!fiscalProfile.ok) return fiscalProfile;
    return ok(
      deriveFiscalCalendar({
        company: {
          legalForm: company.legalForm,
          vatRegime: company.vatRegime,
          dateCreation: company.dateCreation ?? null,
        },
        // Échéancier fiscal FRANÇAIS : ancré sur le jour métier Paris.
        asOf: this.businessToday(),
        horizonDays: 90,
        fiscalYearEnd: confirmedFiscalYearEnd(fiscalProfile.value),
        urssafPeriodicity: null,
      }),
    );
  }

  startCheckout(tier: PlanTier) {
    if (!this.gateway.subscriptionBillingAvailable || this.stripeBilling === null) {
      throw new Error('SUBSCRIPTION_BILLING_UNAVAILABLE');
    }
    return this.stripeBilling.startSubscriptionCheckout({
      companyId: this.companyId(),
      tier,
      successUrl: paymentReturnUrl('/abonnement/succes'),
      cancelUrl: paymentReturnUrl('/abonnement/annule'),
    });
  }

  billingPortal() {
    if (!this.gateway.subscriptionBillingAvailable || this.stripeBilling === null) {
      throw new Error('SUBSCRIPTION_BILLING_UNAVAILABLE');
    }
    return this.stripeBilling.createBillingPortal(this.companyId(), paymentReturnUrl('/compte'));
  }

  /** Lien de paiement en ligne d'une facture — gated par l'offre (Pro+). */
  async invoicePaymentLink(invoiceId: string): Promise<Result<{ url: string }, AppError>> {
    const subscription = await this.subscriptionFor(this.companyId());
    if (!subscription.ok) return subscription;
    if (!subscription.value.can('online_payment')) {
      return {
        ok: false,
        error: appForbidden("Le paiement en ligne nécessite l'offre Pro ou Business."),
      };
    }
    const inv = await this.ownedInvoice(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    if (!this.gateway.subscriptionBillingAvailable || this.stripeBilling === null) {
      return err(appUnavailable('stripe-billing'));
    }
    const link = await this.stripeBilling.createInvoicePaymentLink({
      companyId: this.companyId(),
      invoiceId,
      label: `Facture ${inv.number ?? ''}`,
    });
    this.logger.audit('invoice.payment_link', { invoiceId, amountCents: inv.totals().netToPay });
    return ok(link);
  }

  /** Génère le PDF conforme d'une facture (mentions figées + totaux déterministes). */
  async invoicePdf(invoiceId: string): Promise<Result<Uint8Array, AppError>> {
    const inv = await this.ownedInvoice(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    return this.loadInvoicePdfBytes(inv);
  }

  /**
   * Corps commun à `invoicePdf` (authentifié, `ownedInvoice`) et `publicDocumentPdf` (public,
   * résolu via `runWithTenant`) — aucune des deux ne s'appuie sur `this.companyId()` ici, tout
   * transite par `inv.companyId` chargé par l'appelant selon SA propre frontière d'autorisation.
   */
  private async loadInvoicePdfBytes(inv: Invoice): Promise<Result<Uint8Array, AppError>> {
    // Une pièce émise est immuable : on sert uniquement l'octet archivé au moment de l'émission.
    // Une archive absente/corrompue est une indisponibilité à réparer, jamais une autorisation de
    // régénérer avec l'identité ou les réglages actuels de la société.
    if (inv.number !== null && inv.issuedAt !== null) {
      const documents = await this.p.documents.findByEntity(inv.companyId, 'invoice', inv.id);
      const archivedCandidates = documents.filter(
        (document) => document.kind === 'invoice_pdf' && document.status === 'active',
      );
      // Zéro ou plusieurs originaux actifs = archive ambiguë/corrompue. Ne jamais choisir le
      // premier résultat d'une requête dont l'ordre n'est pas un invariant métier.
      if (archivedCandidates.length !== 1) return err(appUnavailable('invoice-archive'));
      const archive = archivedCandidates[0]!.toProps();
      return this.loadArchivedInvoicePdfBytes({
        kind: 'invoice',
        companyId: inv.companyId,
        invoiceId: inv.id,
        number: inv.number,
        archive: {
          storageKey: archive.storageKey,
          mimeType: archive.mimeType,
          byteSize: archive.byteSize,
          sha256: archive.sha256,
        },
      });
    }
    const rendered = await this.renderInvoicePdf(inv);
    if (rendered.ok)
      this.logger.audit('invoice.pdf', {
        invoiceId: inv.id,
        number: inv.number ?? '(brouillon)',
        facturX: !!inv.number && !!inv.issuedAt,
      });
    return rendered;
  }

  /**
   * Charge un original archivé en vérifiant l'INTÉGRITÉ octet à octet (type MIME, taille,
   * SHA-256) contre les métadonnées du Document. Tout écart = indisponibilité à réparer,
   * jamais un service dégradé ni une régénération (fail-closed, commun factures et devis signés).
   */
  private async loadVerifiedArchivedPdfBytes(
    companyId: string,
    archive: ArchivedPdfDescriptor,
    unavailableService: 'invoice-archive' | 'signed-quote-archive',
  ): Promise<Result<Uint8Array, AppError>> {
    const stored = await this.documentStorage.get(companyId, archive.storageKey);
    if (
      stored === null ||
      stored.contentType !== 'application/pdf' ||
      archive.mimeType !== 'application/pdf' ||
      stored.bytes.byteLength !== archive.byteSize ||
      documentSha256(stored.bytes) !== archive.sha256
    ) {
      return err(appUnavailable(unavailableService));
    }
    return ok(stored.bytes);
  }

  private async loadArchivedInvoicePdfBytes(
    input: Extract<AuthorizedPublicDocumentPdf, { kind: 'invoice' }>,
  ): Promise<Result<Uint8Array, AppError>> {
    const bytes = await this.loadVerifiedArchivedPdfBytes(
      input.companyId,
      input.archive,
      'invoice-archive',
    );
    if (!bytes.ok) return bytes;
    this.logger.audit('invoice.pdf', {
      invoiceId: input.invoiceId,
      number: input.number,
      facturX: true,
      source: 'immutable_archive',
    });
    return bytes;
  }

  /** A8 — sert l'original du contrat signé (devis) archivé à la signature, après vérification
   *  d'intégrité ; le nom du signataire ne sort jamais dans les journaux techniques. */
  private async loadArchivedSignedQuotePdfBytes(
    input: Extract<AuthorizedPublicDocumentPdf, { kind: 'signed_quote' }>,
  ): Promise<Result<Uint8Array, AppError>> {
    const bytes = await this.loadVerifiedArchivedPdfBytes(
      input.companyId,
      input.archive,
      'signed-quote-archive',
    );
    if (!bytes.ok) return bytes;
    this.logger.audit('quote.pdf', {
      quoteId: input.quoteId,
      number: input.number,
      source: 'immutable_archive',
    });
    return bytes;
  }

  /**
   * Changer une donnée qui influe sur le PDF est interdit tant qu'une facture émise n'a pas son
   * original archivé. Cette barrière ferme la fenêtre émission→job et protège aussi les imports
   * legacy incomplets contre une régénération rétroactive.
   */
  private async assertIssuedInvoiceArchivesComplete(
    companyId: string,
  ): Promise<Result<void, AppError>> {
    const invoices = await this.p.invoices.listByCompany(companyId);
    for (const invoice of invoices) {
      if (invoice.number === null || invoice.issuedAt === null) continue;
      const documents = await this.p.documents.findByEntity(companyId, 'invoice', invoice.id);
      const archived = documents.some(
        (document) => document.kind === 'invoice_pdf' && document.status === 'active',
      );
      if (!archived) {
        return err(appConflict('company_billing_settings', 'issued_invoice_archive_missing'));
      }
    }
    return ok(undefined);
  }

  /**
   * A8 — même doctrine que assertIssuedInvoiceArchivesComplete, pour le CONTRAT : tant qu'un
   * ordre d'archivage de devis signé n'est pas abouti (fenêtre signature→job, job en échec),
   * aucune donnée relue au rendu du devis ne peut changer — sinon l'archive produite en retard
   * ne serait plus le document que le client a signé (art. 1366-1367 c. civ.). Les devis signés
   * AVANT A8 n'ont aucun ordre d'archivage : jamais rétro-générés (un rendu actuel ne serait
   * pas le contrat d'époque), donc hors barrière, honnêtement.
   */
  private async assertSignedQuoteArchivesComplete(
    companyId: string,
  ): Promise<Result<void, AppError>> {
    const incomplete = await this.p.documentArchiveJobs.countIncomplete(companyId, 'quote-signed');
    if (incomplete > 0) {
      return err(appConflict('company_billing_settings', 'signed_quote_archive_missing'));
    }
    return ok(undefined);
  }

  private async renderInvoicePdf(inv: Invoice): Promise<Result<Uint8Array, AppError>> {
    const company = await this.p.companies.findById(inv.companyId);
    const customer = await this.p.customers.findById(inv.customerId);
    if (!company || !customer || customer.companyId !== company.id)
      return { ok: false, error: appNotFound('company-or-customer', inv.id) };
    const billingSettings = await this.p.billingSettings.findByCompanyId(inv.companyId);
    if (billingSettings === null) return err(appUnavailable('company-billing-settings'));
    const addr = customer.toProps().address;
    const companyProps = company.toProps();
    const totals = inv.totals();
    const data: InvoicePdfData = {
      number: inv.number ?? '(brouillon)',
      companyName: company.name,
      companyAddress: `${company.address.line1}, ${company.address.zip} ${company.address.city}`,
      companyRcsOrRm: company.rcsOrRm ?? null,
      customerName: customer.name,
      customerAddress: `${addr.line1}, ${addr.zip} ${addr.city}`,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      kind: inv.kind,
      lines: inv.lines.map((l) => ({
        label: l.label,
        qty: l.qty,
        unitPriceHT: l.unitPriceHT,
        vatRate: l.vatRate,
      })),
      totals: { ht: totals.ht, vat: totals.vat, ttc: totals.ttc, netToPay: totals.netToPay },
      mentions: [...inv.mentions],
      // B8 : le numéro d'engagement du client (bon de commande) figure sur la pièce émise —
      // exigence de paiement grands comptes + Chorus Pro. Zone références de l'en-tête.
      purchaseOrder: inv.purchaseOrder
        ? { number: inv.purchaseOrder.number, receivedAt: inv.purchaseOrder.receivedAt }
        : null,
      // A5 : identité de la facture annulée (avoir total) — le renderer titre « Avoir » et
      // imprime la référence à la pièce initiale (242 nonies A CGI). Null = pièce ordinaire.
      // E3 : l'identité (invoiceId) fait partie de la projection figée.
      creditNoteSource: inv.creditNoteSource
        ? {
            invoiceId: inv.creditNoteSource.invoiceId,
            kind: inv.creditNoteSource.kind,
            number: inv.creditNoteSource.number,
            issuedAt: inv.creditNoteSource.issuedAt,
          }
        : null,
      // A7 : figés à l'émission par le domaine ; null HONNÊTE pour les factures émises avant
      // la migration (jamais rétro-remplis — le renderer n'imprime alors rien).
      servicePeriod: inv.servicePeriod,
      deliveryAddress: inv.deliveryAddress,
      billingPresentation: {
        accentColor: billingSettings.pdfAccentColor,
        rib:
          billingSettings.showRibOnInvoices && companyProps.iban
            ? {
                iban: companyProps.iban,
                bic: companyProps.bic ?? null,
              }
            : null,
        insurance:
          billingSettings.showInsuranceOnInvoices && company.decennale
            ? { ...company.decennale }
            : null,
      },
    };
    // Facture émise -> PDF hybride Factur-X (XML CII embarqué).
    let facturX: { xml: string } | undefined;
    if (inv.number && inv.issuedAt) {
      const buyer = customer.toProps();
      const fxData = facturXDataFromInvoice(inv, company, {
        name: customer.name,
        ...(buyer.siren ? { siren: buyer.siren } : {}),
        // A4 — faits fiscaux réels du preneur (jamais un défaut) : ils pilotent la catégorie AE
        // (autoliquidation sous-traitance BTP, art. 283, 2 nonies du CGI) dans le XML Factur-X.
        type: customer.type,
        isSubcontractingBtp: customer.isSubcontractingBtp,
        address: buyer.address,
      });
      facturX = { xml: buildFacturXBasicXml(fxData) };
    }
    const bytes = await this.pdf.renderInvoice(data, facturX);
    return ok(bytes);
  }

  /** Rend le PDF d'un devis — pas de RIB/assurance/Factur-X (ce n'est pas une pièce comptable).
   *  Un devis NON signé reste régénérable à la volée depuis son état courant (lien public de
   *  visualisation). A8 : dès la SIGNATURE, ce rendu est figé et archivé (le contrat,
   *  art. L213-1 c. conso) par archiveSignedQuoteDocumentsForCompany — toute consultation d'un
   *  devis signé sert ensuite l'original archivé, jamais un re-rendu. */
  private async renderQuotePdf(q: Quote): Promise<Result<Uint8Array, AppError>> {
    const company = await this.p.companies.findById(q.companyId);
    const customer = await this.p.customers.findById(q.customerId);
    if (!company || !customer || customer.companyId !== company.id)
      return { ok: false, error: appNotFound('company-or-customer', q.id) };
    const bytes = await this.pdf.renderQuote(this.quotePdfData(q, company, customer));
    return ok(bytes);
  }

  private quotePdfData(q: Quote, company: Company, customer: Customer): QuotePdfData {
    const addr = customer.toProps().address;
    const totals = q.totals();
    return {
      number: q.number ?? '(brouillon)',
      companyName: company.name,
      companyAddress: `${company.address.line1}, ${company.address.zip} ${company.address.city}`,
      companyRcsOrRm: company.rcsOrRm ?? null,
      customerName: customer.name,
      customerAddress: `${addr.line1}, ${addr.zip} ${addr.city}`,
      validUntil: q.validUntil,
      lines: q.lines.map((l) => ({
        label: l.label,
        qty: l.qty,
        unitPriceHT: l.unitPriceHT,
        vatRate: l.vatRate,
      })),
      totals: { ht: totals.ht, vat: totals.vat, ttc: totals.ttc, netToPay: totals.netToPay },
      depositPct: q.depositPct,
      signedBy: q.signature?.signerName ?? null,
      mentions: this.quoteMentions(q, company, customer),
      // A3 — devis B2C : bloc d'information rétractation (avis type R221-3) + FORMULAIRE
      // DÉTACHABLE (modèle type annexe R221-1, joint au contrat — art. L221-5/L221-9 c. conso).
      // Client professionnel : null, rien d'imprimé. A8 : figé dans l'original archivé à la
      // signature — jamais re-rendu ensuite.
      // Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°) : le bloc ADAPTÉ (exception
      // limitée au strict nécessaire) s'AJOUTE EN TÊTE de l'avis type COMPLET — jamais à sa
      // place : le droit RÉSIDUEL que le bloc affirme lui-même exige l'information complète
      // (modalités, effets L221-24, paiement proportionnel, fonctionnalité en ligne L221-5, 7° —
      // un devis urgent reste signable par lien). Substituer ferait perdre la présomption
      // R221-3 (délai porté à 12 mois, L221-20 ; amende L242-13 pour la fonctionnalité en
      // ligne). Le formulaire R221-1 RESTE joint dans tous les cas.
      retractation: customer.type === 'b2c' ? this.quoteRetractationBlock(q, company) : null,
    };
  }

  /**
   * A3 — avis d'information rétractation d'un devis B2C, SOURCE UNIQUE du PDF : avis type
   * R221-3 complété (fonctionnalité en ligne incluse, L221-5, 7°), PRÉCÉDÉ du bloc adapté
   * « intervention urgente » quand l'exception L221-10, al. 2 est tracée — ajouté, jamais
   * substitué (le droit résiduel garde son information complète).
   */
  private quoteRetractationBlock(
    q: Quote,
    company: Company,
  ): { noticeLines: string[]; formLines: string[] } {
    const notice = retractationNoticeLines(this.retractationProfessional(company), {
      onlineFunctionLocation: this.retractationOnlineFunctionLocation(),
    });
    return {
      noticeLines: q.urgentRepair
        ? [...urgentRepairRetractationLines(q.urgentRepair.requestedAt), ...notice]
        : notice,
      formLines: retractationFormLines(this.retractationProfessional(company)),
    };
  }

  /**
   * A3 — identité du professionnel insérée dans les textes réglementaires de rétractation.
   * Les modèles types EN VIGUEUR (décret n° 2022-424 du 25/03/2022) EXIGENT l'adresse
   * électronique (formulaire R221-1 et avis R221-3) et le téléphone (avis R221-3, instruction
   * (2)) — sans la réserve « lorsqu'ils sont disponibles », disparue en 2022. Les valeurs
   * viennent du profil ENTREPRISE (PATCH /company/legal) : insérées dès qu'elles sont saisies,
   * jamais fabriquées — l'incomplétude est mesurable via retractationContactGaps (@bob/core).
   */
  private retractationProfessional(company: Company): RetractationProfessional {
    return {
      name: company.name,
      addressLine: `${company.address.line1}, ${company.address.zip} ${company.address.city}`,
      email: company.email ?? null,
      phone: company.phone ?? null,
    };
  }

  /**
   * A3 — « explication appropriée » de l'emplacement de la fonctionnalité de rétractation en
   * ligne (avis type R221-3, instruction (3), décret n° 2026-3 : « insérer l'adresse internet
   * ou une autre explication appropriée ») : l'URL personnelle n'existe qu'à la signature
   * (jeton créé dans la transaction de signature, jamais persisté en clair) — l'avis imprimé
   * AVANT et AU moment de la signature décrit donc où elle est remise. Servie au PDF du devis
   * B2C et à la page sign-web (source unique).
   */
  private retractationOnlineFunctionLocation(): string {
    return (
      'le lien personnel de rétractation qui vous est remis à la signature du devis ' +
      '(affiché après signature et transmis avec votre exemplaire du contrat)'
    );
  }

  /**
   * A1/A2/A6 — mentions légales du devis, calculées AU RENDU depuis l'état courant via
   * buildMentions (@bob/core) : un devis NON signé n'est pas une pièce figée (régénérable à la
   * volée, cf. renderQuotePdf) — contrairement à la facture dont les mentions sont figées à
   * l'émission (issue-invoice.ts). Source UNIQUE pour le PDF du devis ET la page de signature.
   * A8 : à la signature, le rendu (mentions comprises) est capturé dans l'original archivé du
   * contrat ; c'est cet octet-là qui est servi ensuite, plus jamais ce calcul.
   */
  private quoteMentions(q: Quote, company: Company, customer: Customer): string[] {
    const mentions = buildMentions({
      company,
      customer,
      kind: 'quote',
      asOf: this.businessToday(),
      // P11 : les taux des lignes déclenchent la mention certifiée taux réduits (10 %/5,5 %).
      lineVatRates: q.lines.map((l) => l.vatRate),
      // A1 : date d'établissement dérivée à l'envoi (null = brouillon/legacy, mention omise).
      establishedOn: q.issuedAt,
      validUntil: q.validUntil,
    });
    // Exception dépannage urgent : la mention DATÉE « intervention urgente sollicitée par le
    // client le … » matérialise le fait légal sur le devis lui-même (L221-10, al. 2) — c'est
    // cette trace visible qui fonde l'absence d'embargo, jamais un état interne invisible.
    if (q.urgentRepair) mentions.push(urgentRepairQuoteMention(q.urgentRepair.requestedAt));
    return mentions;
  }

  /** XML Factur-X (CII BASIC) seul, pour transmission e-invoicing. Facture émise requise. */
  async invoiceFacturXXml(invoiceId: string): Promise<Result<string, AppError>> {
    const inv = await this.ownedInvoice(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    return this.buildInvoiceFacturXXml(inv);
  }

  private async buildInvoiceFacturXXml(inv: Invoice): Promise<Result<string, AppError>> {
    if (!inv.number || !inv.issuedAt)
      return { ok: false, error: appForbidden('Facture non émise : Factur-X indisponible.') };
    const company = await this.p.companies.findById(inv.companyId);
    const customer = await this.p.customers.findById(inv.customerId);
    if (!company || !customer)
      return { ok: false, error: appNotFound('company-or-customer', inv.id) };
    const buyer = customer.toProps();
    const fxData = facturXDataFromInvoice(inv, company, {
      name: customer.name,
      ...(buyer.siren ? { siren: buyer.siren } : {}),
      // A4 — faits fiscaux réels du preneur (jamais un défaut) : ils pilotent la catégorie AE
      // (autoliquidation sous-traitance BTP, art. 283, 2 nonies du CGI) dans le XML Factur-X.
      type: customer.type,
      isSubcontractingBtp: customer.isSubcontractingBtp,
      address: buyer.address,
    });
    return ok(buildFacturXBasicXml(fxData));
  }

  private async storeDocument(input: {
    id?: string;
    versionId?: string;
    companyId?: string;
    kind: DocumentKind;
    origin: DocumentOrigin;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    folderId?: string | null;
    linkedEntityType?: DocumentLinkedEntityType | null;
    linkedEntityId?: string | null;
    documentDate?: string | null;
    issuedAt?: string | null;
    reason?: string;
    tags?: string[];
  }): Promise<Result<DocumentView, AppError>> {
    const companyId = input.companyId ?? this.companyId();
    const id = input.id ?? this.ids.newId();
    const versionId = input.versionId ?? this.ids.newId();
    const sha256 = documentSha256(input.bytes);
    const storageKey = buildDocumentStorageKey({
      companyId,
      documentId: id,
      version: 1,
      sha256,
      filename: input.filename,
      mimeType: input.mimeType,
    });
    return new StoreDocument({
      documents: {
        save: (document) => this.p.runWithTenant(companyId, () => this.p.documents.save(document)),
      },
      folders: {
        findById: (scopedCompanyId, folderId) =>
          this.p.runWithTenant(scopedCompanyId, () =>
            this.p.documentFolders.findById(scopedCompanyId, folderId),
          ),
      },
      linkTargets: this.documentLinkTargets(),
      storage: this.documentStorage,
      clock: this.clock,
    }).execute({
      id,
      versionId,
      companyId,
      kind: input.kind,
      origin: input.origin,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: input.bytes,
      sha256,
      storageKey,
      folderId: input.folderId ?? null,
      linkedEntityType: input.linkedEntityType ?? null,
      linkedEntityId: input.linkedEntityId ?? null,
      documentDate: input.documentDate ?? null,
      issuedAt: input.issuedAt ?? null,
      createdBy: getPrincipal()?.userId ?? null,
      reason: input.reason ?? 'initial',
      tags: input.tags ?? [],
    });
  }

  private async provisionDefaultDocumentFolders(
    companyId: string,
  ): Promise<Result<void, AppError>> {
    const listed = await new ListDocumentFolders({ folders: this.p.documentFolders }).execute({
      companyId,
      parentId: null,
      limit: 100,
    });
    if (!listed.ok) return listed;
    const existing = new Set(listed.value.items.map((folder) => folder.systemKey).filter(Boolean));
    for (const spec of DEFAULT_DOCUMENT_FOLDERS) {
      if (existing.has(spec.systemKey)) continue;
      const created = await new CreateDocumentFolder({
        folders: this.p.documentFolders,
        ids: this.ids,
        clock: this.clock,
        uow: this.p,
      }).execute({ companyId, parentId: null, name: spec.name, systemKey: spec.systemKey });
      if (!created.ok) return created;
    }
    return ok(undefined);
  }

  private async enqueueInvoiceArchive(invoiceId: string): Promise<void> {
    const now = this.clock.now();
    await this.p.documentArchiveJobs.enqueue({
      id: this.ids.newId(),
      companyId: this.companyId(),
      pieceId: invoiceId,
      reason: 'invoice-issued',
      now,
    });
  }

  /** A8 — ordre durable d'archivage de l'original du devis signé (le contrat). À appeler DANS
   *  la transaction de signature ; `companyId` explicite car la signature publique n'a pas de
   *  principal authentifié. */
  private async enqueueSignedQuoteArchive(companyId: string, quoteId: string): Promise<void> {
    const now = this.clock.now();
    await this.p.documentArchiveJobs.enqueue({
      id: this.ids.newId(),
      companyId,
      pieceId: quoteId,
      reason: 'quote-signed',
      now,
    });
  }

  private async archiveIssuedInvoiceDocumentsForCompany(
    companyId: string,
    invoiceId: string,
  ): Promise<Result<{ created: number; skipped: number }, AppError>> {
    const inv = await this.p.invoices.findById(invoiceId);
    if (!inv || inv.companyId !== companyId)
      return { ok: false, error: appNotFound('invoice', invoiceId) };
    if (!inv.number || !inv.issuedAt)
      return { ok: false, error: appForbidden('Facture non émise : archivage impossible.') };
    let created = 0;
    let skipped = 0;
    try {
      const existing = await this.p.documents.findByEntity(companyId, 'invoice', invoiceId);
      const hasPdf = existing.some((d) => d.kind === 'invoice_pdf' && d.status === 'active');
      const hasFacturX = existing.some((d) => d.kind === 'facturx_xml' && d.status === 'active');

      if (!hasPdf) {
        const pdf = await this.renderInvoicePdf(inv);
        if (!pdf.ok) return pdf;
        const archived = await this.storeDocument({
          id: generatedInvoiceDocumentId(companyId, invoiceId, 'invoice_pdf'),
          versionId: generatedInvoiceDocumentVersionId(companyId, invoiceId, 'invoice_pdf'),
          companyId,
          kind: 'invoice_pdf',
          origin: 'generated',
          filename: `facture-${inv.number}.pdf`,
          mimeType: 'application/pdf',
          bytes: pdf.value,
          linkedEntityType: 'invoice',
          linkedEntityId: invoiceId,
          documentDate: inv.issuedAt,
          issuedAt: inv.issuedAt,
          reason: 'invoice-issued',
        });
        if (!archived.ok) return archived;
        created += 1;
      } else {
        skipped += 1;
      }

      if (!hasFacturX) {
        const xml = await this.buildInvoiceFacturXXml(inv);
        if (!xml.ok) return xml;
        const archived = await this.storeDocument({
          id: generatedInvoiceDocumentId(companyId, invoiceId, 'facturx_xml'),
          versionId: generatedInvoiceDocumentVersionId(companyId, invoiceId, 'facturx_xml'),
          companyId,
          kind: 'facturx_xml',
          origin: 'generated',
          filename: `factur-x-${inv.number}.xml`,
          mimeType: 'application/xml',
          bytes: Buffer.from(xml.value, 'utf-8'),
          linkedEntityType: 'invoice',
          linkedEntityId: invoiceId,
          documentDate: inv.issuedAt,
          issuedAt: inv.issuedAt,
          reason: 'invoice-issued',
        });
        if (!archived.ok) return archived;
        created += 1;
      } else {
        skipped += 1;
      }
      return ok({ created, skipped });
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'document-archive',
          cause: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  /**
   * A8 — fige l'original du CONTRAT (devis signé) : PDF rendu depuis l'état au moment de la
   * signature (mentions A1/A2/A6 comprises, cf. quotePdfData), SHA-256 et stockage par la MÊME
   * mécanique que les originaux de factures émises (storeDocument + coffre). Idempotent : id de
   * document déterministe par (tenant, devis) — un retry ne crée jamais un second original.
   * Conservation : 10 ans par défaut (StoreDocument), conforme à l'art. L213-1 code conso
   * (contrats électroniques B2C ≥ 120 €) ; valeur probante art. 1366-1367 code civil.
   */
  private async archiveSignedQuoteDocumentsForCompany(
    companyId: string,
    quoteId: string,
  ): Promise<Result<{ created: number; skipped: number }, AppError>> {
    const q = await this.p.quotes.findById(quoteId);
    if (!q || q.companyId !== companyId) return { ok: false, error: appNotFound('quote', quoteId) };
    if (q.signature === null)
      return { ok: false, error: appForbidden('Devis non signé : archivage impossible.') };
    try {
      const existing = await this.p.documents.findByEntity(companyId, 'quote', quoteId);
      const hasPdf = existing.some(
        (document) => document.kind === 'signed_quote' && document.status === 'active',
      );
      if (hasPdf) return ok({ created: 0, skipped: 1 });
      const pdf = await this.renderQuotePdf(q);
      if (!pdf.ok) return pdf;
      const archived = await this.storeDocument({
        id: generatedQuoteDocumentId(companyId, quoteId, 'signed_quote'),
        versionId: generatedQuoteDocumentVersionId(companyId, quoteId, 'signed_quote'),
        companyId,
        kind: 'signed_quote',
        origin: 'generated',
        filename: `devis-signe-${q.number ?? quoteId}.pdf`,
        mimeType: 'application/pdf',
        bytes: pdf.value,
        linkedEntityType: 'quote',
        linkedEntityId: quoteId,
        // Date du document = jour (calendrier français) de la signature — l'événement qui fige.
        documentDate: parisDateOnly(q.signature.signedAt),
        issuedAt: q.issuedAt,
        reason: 'quote-signed',
      });
      if (!archived.ok) return archived;
      return ok({ created: 1, skipped: 0 });
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'document-archive',
          cause: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  async runDocumentArchiveJobs(
    input: { companyId?: string; limit?: number } = {},
  ): Promise<Result<{ scanned: number; archived: number; failed: number }, AppError>> {
    const companyId = input.companyId ?? this.companyId();
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    return this.p.runWithTenant(companyId, async () => {
      const now = this.clock.now();
      const jobs = await this.p.documentArchiveJobs.listDue(companyId, now, limit);
      let archived = 0;
      let failed = 0;
      for (const job of jobs) {
        // Dispatch par motif : même outbox, même worker, deux pièces à figer (facture émise,
        // contrat signé) — jamais deux systèmes d'archivage parallèles.
        const result =
          job.reason === 'quote-signed'
            ? await this.archiveSignedQuoteDocumentsForCompany(companyId, job.pieceId)
            : await this.archiveIssuedInvoiceDocumentsForCompany(companyId, job.pieceId);
        if (result.ok) {
          await this.p.documentArchiveJobs.markDone(job.id, this.clock.now());
          archived += result.value.created;
          this.logger.audit('document.archive_job.done', {
            companyId,
            pieceId: job.pieceId,
            reason: job.reason,
            created: result.value.created,
            skipped: result.value.skipped,
          });
        } else {
          failed += 1;
          const failedAt = this.clock.now();
          await this.p.documentArchiveJobs.markFailed(
            job.id,
            failedAt,
            nextArchiveRetryAt(failedAt, job.attempts),
            appErrorSummary(result.error),
          );
          this.logger.warn(
            `Archivage ${job.reason === 'quote-signed' ? 'devis signé' : 'facture'} en retry: ${appErrorSummary(result.error)}`,
            'documents',
          );
        }
      }
      return ok({ scanned: jobs.length, archived, failed });
    });
  }

  async runNotificationJobs(
    input: { companyId?: string; limit?: number } = {},
  ): Promise<Result<{ scanned: number; sent: number; failed: number }, AppError>> {
    const companyId = input.companyId ?? this.companyId();
    const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
    try {
      return ok(await this.notificationDelivery.runForCompany(companyId, limit));
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'notification-jobs',
          cause: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  async listDocuments(
    input: ListDocumentsInput = {},
  ): Promise<Result<DocumentListItemView[], AppError>> {
    const documents = await new ListDocuments({ documents: this.p.documents }).execute({
      companyId: this.companyId(),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.linkedEntityType !== undefined ? { linkedEntityType: input.linkedEntityType } : {}),
      ...(input.linkedEntityId !== undefined ? { linkedEntityId: input.linkedEntityId } : {}),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      ...(input.includeDeleted !== undefined ? { includeDeleted: input.includeDeleted } : {}),
    });
    if (!documents.ok) return documents;

    // Enrichissement depuis le SEUL cache persistant, en UNE requête (jamais de LLM ni de N+1
    // à la lecture). Un cache indisponible dégrade en « pas encore analysé », jamais en erreur
    // de liste : le coffre reste consultable.
    let analysesByDocument = new Map<string, DocumentAnalysis>();
    try {
      const records = await this.p.documentAnalyses.findManyExact(
        this.companyId(),
        documents.value.map((document) => ({
          documentId: document.id,
          documentVersion: document.version,
          sourceSha256: document.sha256,
        })),
      );
      analysesByDocument = new Map(records.map((record) => [record.documentId, record.analysis]));
    } catch (cause) {
      this.logger.warn(
        `Enrichissement analyses du coffre indisponible: ${cause instanceof Error ? cause.message : String(cause)}`,
        'documents',
      );
    }
    return ok(
      documents.value.map((document) => {
        const analysis = analysesByDocument.get(document.id) ?? null;
        return {
          ...document,
          analysis: analysis ? documentAnalysisSummary(analysis) : null,
          extraction: analysis ? documentExtractionSummary(analysis) : null,
        };
      }),
    );
  }

  /**
   * PUT /documents/:id/name — renomme le libellé d'affichage (RenameDocument @bob/core, parité
   * humain↔Bob). Tenant-scopé par companyId + révision optimiste, comme les routes voisines.
   */
  async renameDocument(input: {
    documentId: string;
    displayName: string;
    expectedRevision: number;
  }): Promise<Result<DocumentView, AppError>> {
    const result = await new RenameDocument({ documents: this.p.documents }).execute({
      companyId: this.companyId(),
      documentId: input.documentId,
      displayName: input.displayName,
      expectedRevision: input.expectedRevision,
    });
    if (result.ok)
      this.logger.audit('document.renamed', {
        companyId: this.companyId(),
        documentId: input.documentId,
        revision: result.value.revision,
      });
    return result;
  }

  async listDocumentFolders(
    input: {
      parentId?: string | null;
      limit?: number;
      cursor?: string | null;
    } = {},
  ): Promise<Result<{ items: DocumentFolderView[]; nextCursor: string | null }, AppError>> {
    return new ListDocumentFolders({ folders: this.p.documentFolders }).execute({
      companyId: this.companyId(),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
  }

  async getDocumentFolder(folderId: string): Promise<Result<DocumentFolderView, AppError>> {
    const folder = await this.p.documentFolders.findById(this.companyId(), folderId);
    return folder && folder.status === 'active'
      ? ok(folder.toProps())
      : { ok: false, error: appNotFound('document_folder', folderId) };
  }

  async createDocumentFolder(input: {
    name: string;
    parentId?: string | null;
  }): Promise<Result<DocumentFolderView, AppError>> {
    const result = await new CreateDocumentFolder({
      folders: this.p.documentFolders,
      ids: this.ids,
      clock: this.clock,
      uow: this.p,
    }).execute({
      companyId: this.companyId(),
      name: input.name,
      parentId: input.parentId ?? null,
    });
    if (result.ok)
      this.logger.audit('document_folder.created', {
        companyId: this.companyId(),
        folderId: result.value.id,
      });
    return result;
  }

  async renameDocumentFolder(input: {
    folderId: string;
    name: string;
    expectedRevision: number;
  }): Promise<Result<DocumentFolderView, AppError>> {
    const result = await new RenameDocumentFolder({
      folders: this.p.documentFolders,
      clock: this.clock,
      uow: this.p,
    }).execute({ companyId: this.companyId(), ...input });
    if (result.ok)
      this.logger.audit('document_folder.renamed', {
        companyId: this.companyId(),
        folderId: input.folderId,
      });
    return result;
  }

  async moveDocumentFolder(input: {
    folderId: string;
    parentId: string | null;
    expectedRevision: number;
  }): Promise<Result<DocumentFolderView, AppError>> {
    const result = await new MoveDocumentFolder({
      folders: this.p.documentFolders,
      clock: this.clock,
      uow: this.p,
    }).execute({ companyId: this.companyId(), ...input });
    if (result.ok)
      this.logger.audit('document_folder.moved', {
        companyId: this.companyId(),
        folderId: input.folderId,
        parentId: input.parentId,
      });
    return result;
  }

  private documentFolderDeletionPlanService(): DocumentFolderDeletionPlanService {
    const store = this.p.documentFolderDeletionPlans;
    return new DocumentFolderDeletionPlanService({
      store: {
        insert: (plan) => this.p.runWithTenant(plan.companyId, () => store.insert(plan)),
        consume: (input) => this.p.runWithTenant(input.companyId, () => store.consume(input)),
        purgeExpired: (input) =>
          this.p.runWithTenant(input.companyId, () => store.purgeExpired(input)),
      },
      previewDeleteFolder: {
        execute: (input) =>
          this.p.runWithTenant(input.companyId, () =>
            new PreviewDeleteDocumentFolder({ folders: this.p.documentFolders }).execute(input),
          ),
      },
      deleteFolder: {
        // Transaction distincte de la consommation : le plan reste brûlé si le snapshot a
        // changé ou si la suppression échoue, et aucune confirmation ne peut être rejouée.
        execute: async (input) => {
          try {
            const value = await this.p.runWithTenant(input.companyId, async () => {
              const result = await new DeleteDocumentFolder({
                folders: this.p.documentFolders,
                clock: this.clock,
                uow: this.p,
              }).execute(input);
              // DeleteDocumentFolder peut s'exécuter dans la transaction tenant déjà ouverte.
              // Propager l'erreur comme exception est indispensable pour que Prisma annule aussi
              // les transferts effectués avant un éventuel conflit de révision tardif.
              if (!result.ok) throw new RollbackAppError(result.error);
              return result.value;
            });
            return ok(value);
          } catch (cause) {
            if (cause instanceof RollbackAppError) return { ok: false, error: cause.appError };
            throw cause;
          }
        },
      },
      clock: this.clock,
      ids: this.ids,
    });
  }

  async previewDocumentFolderDeletion(
    folderId: string,
  ): Promise<Result<DocumentFolderDeletionPlanPreviewView, AppError>> {
    const result = await this.documentFolderDeletionPlanService().preview({
      companyId: this.companyId(),
      folderId,
    });
    if (result.ok) {
      this.logger.audit('document_folder.deletion_previewed', {
        companyId: this.companyId(),
        folderId,
        planId: result.value.planId,
        documentCount: result.value.documentCount,
        descendantFolderCount: result.value.descendantFolderCount,
        expiresAt: result.value.expiresAt,
      });
    }
    return result;
  }

  async executeDocumentFolderDeletion(input: {
    planId: string;
    strategy: DeleteDocumentFolderStrategy;
  }): Promise<
    Result<
      { folderId: string; transferredDocuments: number; transferredChildren: number },
      AppError
    >
  > {
    const result = await this.documentFolderDeletionPlanService().consume({
      companyId: this.companyId(),
      planId: input.planId,
      strategy: input.strategy,
    });
    this.logger.audit(result.ok ? 'document_folder.deleted' : 'document_folder.deletion_rejected', {
      companyId: this.companyId(),
      planId: input.planId,
      strategy: input.strategy.kind,
      ...(result.ok
        ? {
            folderId: result.value.folderId,
            transferredDocuments: result.value.transferredDocuments,
            transferredChildren: result.value.transferredChildren,
          }
        : { errorKind: result.error.kind }),
    });
    return result;
  }

  async moveDocumentToFolder(input: {
    documentId: string;
    folderId: string | null;
    expectedRevision: number;
  }): Promise<Result<{ documentId: string; folderId: string | null; revision: number }, AppError>> {
    const result = await new MoveDocumentToFolder({
      folders: this.p.documentFolders,
      uow: this.p,
      // Ranger DANS un dossier vaut validation humaine (reviewedAt, latch) — le use case décide.
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      ...input,
    });
    if (result.ok)
      this.logger.audit('document.moved', { companyId: this.companyId(), ...result.value });
    return result;
  }

  async documentDownloadUrl(
    documentId: string,
    ttlSeconds?: number,
  ): Promise<Result<DocumentDownloadUrl, AppError>> {
    const companyId = this.companyId();
    return new GetDocumentDownloadUrl({
      documents: {
        findById: (scopedCompanyId, id) =>
          this.p.runWithTenant(scopedCompanyId, () =>
            this.p.documents.findById(scopedCompanyId, id),
          ),
      },
      storage: this.documentStorage,
    }).execute({
      companyId,
      documentId,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    });
  }

  /**
   * GET /documents/:id — MÊME shape enrichi que la liste (DocumentListItemView) : résumé
   * d'analyse + chips depuis le SEUL cache persistant, AUCUN appel LLM à la lecture. Un cache
   * indisponible dégrade en « pas encore analysé » (null), jamais en erreur de lecture.
   */
  async getDocument(documentId: string): Promise<Result<DocumentListItemView, AppError>> {
    const document = await this.p.documents.findById(this.companyId(), documentId);
    if (!document || document.status !== 'active') {
      return { ok: false, error: appNotFound('document', documentId) };
    }
    const view = documentToView(document);
    let analysis: DocumentAnalysis | null = null;
    try {
      const cached = await this.p.documentAnalyses.findExact({
        companyId: this.companyId(),
        documentId: view.id,
        documentVersion: view.version,
        sourceSha256: view.sha256,
      });
      analysis = cached?.analysis ?? null;
    } catch (cause) {
      this.logger.warn(
        `Enrichissement analyse du document indisponible: ${cause instanceof Error ? cause.message : String(cause)}`,
        'documents',
      );
    }
    return ok({
      ...view,
      analysis: analysis ? documentAnalysisSummary(analysis) : null,
      extraction: analysis ? documentExtractionSummary(analysis) : null,
    });
  }

  /**
   * POST /documents/:id/acknowledge — « c'est bon, je valide » : pose la confirmation humaine
   * (reviewedAt) SANS déplacer ni lier (AcknowledgeDocument @bob/core, parité humain↔Bob).
   * Tenant-scopé par companyId + révision optimiste, comme les routes documents voisines.
   */
  async acknowledgeDocument(input: {
    documentId: string;
    expectedRevision: number;
  }): Promise<Result<DocumentView, AppError>> {
    const result = await new AcknowledgeDocument({
      documents: this.p.documents,
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      documentId: input.documentId,
      expectedRevision: input.expectedRevision,
    });
    if (result.ok) {
      this.logger.audit('document.acknowledged', {
        companyId: this.companyId(),
        documentId: input.documentId,
        revision: result.value.revision,
        reviewedAt: result.value.reviewedAt,
      });
    }
    return result;
  }

  /**
   * Contexte de classement tenant-aware pour l'analyse documentaire : chantiers OUVERTS réels
   * (avec client éventuel) + dossiers racine du coffre. Ce sont les SEULES cibles que le modèle
   * peut suggérer — toute autre est rejetée par le domaine (anti-hallucination). Un échec de
   * lecture dégrade en contexte vide (l'analyse retombe sur les dossiers système), jamais en erreur.
   */
  private async documentClassificationContext(
    companyId: string,
  ): Promise<DocumentClassificationContext> {
    try {
      const [chantiers, customers, foldersPage] = await Promise.all([
        // chantiersAllowed() lit companies + subscriptions, deux tables FORCE RLS — or la route
        // POST /documents/:id/analysis désactive la transaction tenant ambiante
        // (@WithoutTenantPersistenceTransaction). HORS runWithTenant, ces lectures renvoient
        // null sans erreur sous FORCE RLS (rôle non-superuser) et le contexte chantiers serait
        // TOUJOURS vide en production : le gating DOIT donc s'évaluer DANS la portée tenant.
        this.p.runWithTenant(companyId, async () =>
          (await this.chantiersAllowed()) ? this.p.chantiers.listByCompany(companyId) : [],
        ),
        this.p.runWithTenant(companyId, () => this.p.customers.listByCompany(companyId)),
        this.p.runWithTenant(companyId, () =>
          this.p.documentFolders.listChildren({ companyId, parentId: null, limit: 100 }),
        ),
      ]);
      const customerNames = new Map(customers.map((customer) => [customer.id, customer.name]));
      return {
        chantiersOuverts: chantiers
          .map((chantier) => chantier.toProps())
          .filter((props) => props.status === 'open')
          .map((props) => ({
            id: props.id,
            nom: props.name,
            clientNom: props.customerId ? (customerNames.get(props.customerId) ?? null) : null,
          })),
        dossiers: foldersPage.items
          .filter((folder) => folder.status === 'active')
          .map((folder) => {
            const props = folder.toProps();
            return { id: props.id, nom: props.name, systemKey: props.systemKey ?? null };
          }),
      };
    } catch {
      return { chantiersOuverts: [], dossiers: [] };
    }
  }

  async analyzeStoredDocument(documentId: string): Promise<Result<DocumentAnalysis, AppError>> {
    const companyId = this.companyId();
    const startedAt = Date.now();
    let result: Result<DocumentAnalysis, AppError>;
    let cacheHit = false;
    let intelligenceInvoked = false;
    try {
      const document = await this.p.runWithTenant(companyId, () =>
        this.p.documents.findById(companyId, documentId),
      );
      if (!document) {
        result = { ok: false, error: appNotFound('document', documentId) };
      } else if (document.status !== 'active') {
        result = {
          ok: false,
          error: {
            kind: 'conflict',
            entity: 'document',
            reason: 'Un document supprimé ne peut pas être analysé.',
          },
        };
      } else {
        const props = document.toProps();
        const currentVersion = props.versions.reduce(
          (latest, version) => (version.version > latest.version ? version : latest),
          props.versions[0]!,
        );
        const cached = await this.p.runWithTenant(companyId, () =>
          this.p.documentAnalyses.findExact({
            companyId,
            documentId,
            documentVersion: currentVersion.version,
            sourceSha256: currentVersion.sha256,
          }),
        );
        if (cached) {
          cacheHit = true;
          result = ok(cached.analysis);
        } else {
          intelligenceInvoked = true;
          // Contexte tenant transmis au moteur puis utilisé par le domaine pour VALIDER la
          // destination suggérée : sans lui, aucune suggestion de chantier ne peut survivre.
          const classificationContext = await this.documentClassificationContext(companyId);
          result = await new AnalyzeDocument({
            documents: {
              findById: (scopedCompanyId, id) =>
                this.p.runWithTenant(scopedCompanyId, () =>
                  this.p.documents.findById(scopedCompanyId, id),
                ),
            },
            storage: this.documentStorage,
            intelligence: this.documentIntelligence,
            clock: this.clock,
          }).execute({ companyId, documentId, context: classificationContext });
          if (result.ok) {
            const analyzed = result.value;
            const winner = await this.p.runWithTenant(companyId, () =>
              this.p.documentAnalyses.putIfAbsent({
                companyId,
                documentId: analyzed.documentId,
                documentVersion: analyzed.documentVersion,
                sourceSha256: analyzed.sourceSha256,
                analyzerVersion: analyzed.analyzerVersion,
                analysis: analyzed,
                analyzedAt: analyzed.analyzedAt,
              }),
            );
            result = ok(winner.analysis);
          }
        }
      }
    } catch (cause) {
      result = {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'document-analysis-cache',
          cause: cause instanceof Error ? cause.message : 'cache indisponible',
        },
      };
    }
    if (intelligenceInvoked) {
      this.metrics.aiRequests.inc({
        model: result.ok ? result.value.analyzerVersion : 'document-intelligence',
        intent: 'document_analysis',
        outcome: result.ok ? 'ok' : result.error.kind,
      });
      this.metrics.aiDuration.observe(
        {
          model: result.ok ? result.value.analyzerVersion : 'document-intelligence',
          intent: 'document_analysis',
        },
        (Date.now() - startedAt) / 1000,
      );
    }
    if (result.ok) {
      this.logger.audit('document.analyzed', {
        companyId,
        documentId,
        documentVersion: result.value.documentVersion,
        analysisType: result.value.type,
        typeConfidence: result.value.typeConfidence,
        requiresHumanReview: result.value.requiresHumanReview,
        analyzerVersion: result.value.analyzerVersion,
        cacheHit,
      });
    }
    return result;
  }

  async uploadDocument(input: UploadDocumentInput): Promise<Result<DocumentView, AppError>> {
    const decoded = decodeBase64Document(input.contentBase64);
    if (!decoded.ok) return decoded;
    const validated = validateUploadedDocument({
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: decoded.value,
    });
    if (!validated.ok) return validated;
    const stored = await this.storeDocument({
      kind: input.kind ?? 'other',
      origin: 'uploaded',
      filename: validated.value.filename,
      mimeType: validated.value.mimeType,
      bytes: decoded.value,
      folderId: input.folderId ?? null,
      linkedEntityType: input.linkedEntityType ?? null,
      linkedEntityId: input.linkedEntityId ?? null,
      documentDate: input.documentDate ?? null,
      reason: 'upload',
      ...(input.tags ? { tags: input.tags } : {}),
    });
    if (stored.ok) {
      this.logger.audit('document.uploaded', {
        companyId: this.companyId(),
        documentId: stored.value.id,
        kind: stored.value.kind,
        byteSize: stored.value.byteSize,
      });
    }
    return stored;
  }

  /**
   * Intake original-first : l'archivage immuable réussit AVANT toute analyse ou écriture
   * comptable. Un retry avec la même clé est idempotent ; une clé rejouée avec un autre
   * fichier est rejetée explicitement.
   */
  async createDocumentIntake(
    input: CreateDocumentIntakeInput,
  ): Promise<Result<DocumentView, AppError>> {
    const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    if (key.length < 8 || key.length > 160) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'idempotencyKey', message: 'Clé d’idempotence invalide.' }],
        },
      };
    }
    const decoded = decodeBase64Document(input.contentBase64);
    if (!decoded.ok) return decoded;
    const validated = validateUploadedDocument({
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: decoded.value,
    });
    if (!validated.ok) return validated;
    const companyId = this.companyId();
    const fingerprint = createHash('sha256')
      .update(companyId)
      .update('\0')
      .update(key)
      .digest('hex');
    const id = `intake-${fingerprint.slice(0, 32)}`;
    const versionId = `intake-version-${fingerprint.slice(0, 32)}`;
    const sha256 = documentSha256(decoded.value);
    const existing = await this.p.runWithTenant(companyId, () =>
      this.p.documents.findById(companyId, id),
    );
    if (existing) {
      const props = existing.toProps();
      if (props.sha256 !== sha256 || props.mimeType !== validated.value.mimeType) {
        return {
          ok: false,
          error: { kind: 'conflict', entity: 'document_intake', reason: 'idempotency_key_reused' },
        };
      }
      return ok(documentToView(existing));
    }
    const stored = await this.storeDocument({
      id,
      versionId,
      companyId,
      kind: 'other',
      origin: 'ocr',
      filename: validated.value.filename,
      mimeType: validated.value.mimeType,
      bytes: decoded.value,
      folderId: null,
      linkedEntityType: null,
      linkedEntityId: null,
      reason: 'document-intake-original',
    });
    if (stored.ok) {
      this.logger.audit('document.intake.stored', {
        companyId,
        documentId: stored.value.id,
        byteSize: stored.value.byteSize,
        sha256: stored.value.sha256,
      });
      return stored;
    }
    // Deux retries strictement identiques peuvent observer « aucun document » ensemble, puis le
    // second perdre la création immuable de l'objet. On converge vers le premier résultat dès que
    // sa métadonnée est visible, au lieu de transformer une idempotence valide en erreur 5xx.
    if (stored.error.kind === 'dependency' && stored.error.port === 'document-storage') {
      for (const delayMs of [0, 20, 50, 100, 200]) {
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        const concurrent = await this.p.runWithTenant(companyId, () =>
          this.p.documents.findById(companyId, id),
        );
        if (!concurrent) continue;
        const props = concurrent.toProps();
        return props.sha256 === sha256 && props.mimeType === validated.value.mimeType
          ? ok(documentToView(concurrent))
          : {
              ok: false,
              error: {
                kind: 'conflict',
                entity: 'document_intake',
                reason: 'idempotency_key_reused',
              },
            };
      }
    }
    return stored;
  }

  async classifyDocument(input: {
    documentId: string;
    linkedEntityType: DocumentLinkedEntityType;
    linkedEntityId: string;
    expectedRevision: number;
  }): Promise<Result<DocumentView, AppError>> {
    const result = await new ClassifyDocument({
      documents: this.p.documents,
      linkTargets: this.documentLinkTargets(),
      // Un classement explicite vaut validation humaine (reviewedAt, latch) — géré par le use case.
      clock: this.clock,
    }).execute({
      companyId: this.companyId(),
      documentId: input.documentId,
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId,
      expectedRevision: input.expectedRevision,
    });
    if (result.ok) {
      this.logger.audit('document.classified', {
        companyId: this.companyId(),
        documentId: input.documentId,
        linkedEntityType: input.linkedEntityType,
        linkedEntityId: input.linkedEntityId,
      });
    }
    return result;
  }

  /** OCR d'un document fournisseur (base64) -> extraction structurée, scopée au tenant. */
  async extractDocument(input: {
    contentBase64: string;
    mimeType: string;
  }): Promise<Result<OcrExtraction, AppError>> {
    const issues: { field: string; message: string }[] = [];
    if (typeof input.contentBase64 !== 'string' || input.contentBase64.trim().length === 0) {
      issues.push({ field: 'contentBase64', message: 'Document vide.' });
    }
    if (typeof input.mimeType !== 'string' || input.mimeType.trim().length === 0) {
      issues.push({ field: 'mimeType', message: 'Type de document requis.' });
    }
    if (issues.length > 0) return { ok: false, error: { kind: 'validation', issues } };
    // A3-C14 : le prompt OCR est personnalisé par l'activité (TradeConfig) — données typées, pas de texte libre.
    const companyId = this.companyId();
    const company = await this.p.runWithTenant(companyId, () =>
      this.p.companies.findById(companyId),
    );
    // Même classe de bug RLS que le contexte de classement : POST /documents/ocr est
    // @WithoutTenantPersistenceTransaction, or subscriptions est FORCE RLS — la lecture doit
    // être tenant-scopée, sinon 503 subscription-record systématique en production.
    const subscription = await this.p.runWithTenant(companyId, () =>
      this.subscriptionFor(companyId),
    );
    if (!subscription.ok) return subscription;
    const trade = company
      ? ((): NonNullable<OcrExtractInput['trade']> => {
          const config = resolveTradeConfig(
            company.trade,
            subscription.value.tier,
            subscription.value.addOns,
          );
          return {
            label: config.label,
            customerWord: config.vocabulary.customer,
            projectWord: config.vocabulary.project,
          };
        })()
      : undefined;
    const startedAt = Date.now();
    const r = await new ExtractDocument({ ocr: this.ocr }).execute({
      ...input,
      ...(trade ? { trade } : {}),
    });
    if (!r.ok) return r;

    let value = r.value;
    // #6 (excellence) : SIREN Luhn-valide ≠ SIREN existant — confirmation annuaire, non bloquante.
    if (value.supplierSiren !== null && this.companyLookup.verifySiren) {
      const exists = await this.companyLookup.verifySiren(value.supplierSiren);
      if (exists === false) value = { ...value, supplierSiren: null };
    }
    // #9 (excellence) : le texte OCR peut contenir des PII (IBAN, tél, email) — rédigé avant
    // de quitter le serveur/partir en log. Le grounding (#2) a déjà eu lieu sur l'original.
    value = { ...value, rawText: redactPII(value.rawText) };

    // #8 (excellence) : audit exploitable — latence + signal de dégradation (garde-fous).
    this.logger.audit('document.ocr', {
      companyId,
      mimeType: input.mimeType,
      confidence: value.confidence,
      ms: Date.now() - startedAt,
      degraded: value.confidence <= 0.6,
    });
    return ok(value);
  }

  async suggestExpenseDefaults(input: {
    supplierName: string;
    supplierSiren?: string | null;
    vatRatePctApplied?: number | null;
    categoryGuess: ExpenseCategory;
  }): Promise<Result<ExpenseDefaultsView, AppError>> {
    const supplierName = input.supplierName.trim();
    if (!supplierName) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'supplierName', message: 'Fournisseur requis.' }],
        },
      };
    }
    if (!EXPENSE_CATEGORIES.has(input.categoryGuess)) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'categoryGuess', message: 'Catégorie inconnue.' }],
        },
      };
    }
    const profile = await this.p.supplierMemory.supplierProfile(this.companyId(), supplierName);
    if (profile) {
      return ok({
        supplierName: profile.displayName || supplierName,
        supplierSiren: input.supplierSiren ?? profile.siren,
        category: profile.category,
        vatRatePct: input.vatRatePctApplied ?? profile.vatRatePct,
        source: 'memory',
      });
    }
    return ok({
      supplierName,
      supplierSiren: input.supplierSiren ?? null,
      category: input.categoryGuess,
      vatRatePct: input.vatRatePctApplied ?? null,
      source: 'ocr',
    });
  }

  private expenseCreationCoordinator(): ExpenseCreationCoordinator {
    return new ExpenseCreationCoordinator({
      persistence: this.p,
      ids: this.ids,
      clock: this.clock,
      // Une dépense peut NAÎTRE imputée à un chantier (destination choisie au scan) : le core
      // exige alors la preuve tenant-scoped du chantier (anti-IDOR, fail-closed sans ce port).
      chantierTargets: this.documentLinkTargets(),
    });
  }

  /** Effets volontairement post-commit : ils ne doivent jamais survivre au rollback d'un lien document. */
  private async afterExpenseCreationCommitted(
    companyId: string,
    input: Omit<RecordExpenseInput, 'companyId'>,
    outcome: {
      expenseId: string;
      created: boolean;
      accounting: { purchaseEntryId: string; paymentEntryId: string | null; created: boolean };
    },
  ): Promise<void> {
    // Une reprise peut réparer une E1 manquante autour d'une Expense déjà publiée : cette
    // écriture nouvelle mérite sa trace, sans rejouer l'audit ni l'apprentissage de la dépense.
    if (outcome.accounting.created) {
      this.logger.audit('accounting.expense_posted', {
        expenseId: outcome.expenseId,
        purchaseEntryId: outcome.accounting.purchaseEntryId,
        paymentEntryId: outcome.accounting.paymentEntryId,
        created: true,
      });
    }
    if (!outcome.created) return;
    this.logger.audit('expense.recorded', {
      companyId,
      id: outcome.expenseId,
      ttc: input.totalTtcCents,
    });
    try {
      const profile = await this.p.runWithTenant(companyId, () =>
        this.p.supplierMemory.rememberSupplier(
          companyId,
          {
            name: input.supplierName,
            siren: input.supplierSiren ?? null,
            category: input.category,
            vatRatePct: input.vatRatePct ?? null,
          },
          this.clock.now(),
        ),
      );
      this.logger.audit('memory.supplier_learned', {
        companyId,
        supplierKey: profile.key,
        seen: profile.seen,
        sourceExpenseId: outcome.expenseId,
      });
    } catch (error) {
      this.logger.warn(
        `supplier memory update failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'BackendService',
      );
    }
  }

  async recordExpense(
    input: Omit<RecordExpenseInput, 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>> {
    const companyId = this.companyId();
    const coordinated = await this.expenseCreationCoordinator().execute({
      companyId,
      expense: input,
    });
    if (!coordinated.ok) return coordinated;
    await this.afterExpenseCreationCommitted(companyId, input, coordinated.value);
    return ok({ id: coordinated.value.expenseId });
  }

  /**
   * LOT 3 — nom intelligent au record : applique le suggestedDisplayName de l'analyse PERSISTÉE
   * en cache (aucun LLM ici) au moment où la dépense est créée, UNIQUEMENT si le libellé courant
   * vaut encore le filename d'archive (règle suggestedRenameFor côté serveur : un renommage
   * humain n'est JAMAIS écrasé). Cosmétique : tout échec dégrade en « pas de renommage »,
   * jamais en échec de la dépense. Retourne la vue renommée, ou null si rien n'a été appliqué.
   */
  private async applyAnalysisSuggestedDisplayName(
    companyId: string,
    view: DocumentView,
  ): Promise<DocumentView | null> {
    try {
      const cached = await this.p.documentAnalyses.findExact({
        companyId,
        documentId: view.id,
        documentVersion: view.version,
        sourceSha256: view.sha256,
      });
      const suggested = (cached?.analysis.suggestedDisplayName ?? '').replace(/\s+/g, ' ').trim();
      if (!suggested) return null;
      const current = view.displayName.replace(/\s+/g, ' ').trim();
      const original = view.filename.replace(/\s+/g, ' ').trim();
      // Renommage humain (displayName ≠ filename) : intouchable — même règle que le mobile.
      if (current.length > 0 && current !== original) return null;
      if (suggested === current) return null;
      const validated = validateDocumentDisplayName(suggested);
      if (!validated.ok) return null;
      const saved = await this.p.documents.rename({
        companyId,
        documentId: view.id,
        displayName: validated.value,
        expectedRevision: view.revision,
      });
      if (saved !== 'saved') return null;
      this.logger.audit('document.renamed', {
        companyId,
        documentId: view.id,
        revision: view.revision + 1,
        source: 'analysis-suggestion',
      });
      return { ...view, displayName: validated.value, revision: view.revision + 1 };
    } catch {
      return null;
    }
  }

  /**
   * Dernier geste du scan : la dépense, E1, le rangement et le lien métier commitent ensemble.
   * L'original est déjà archivé ; aucune I/O storage/IA n'entre dans cette transaction courte.
   */
  async recordDocumentExpense(
    input: RecordDocumentExpenseInput,
  ): Promise<Result<RecordDocumentExpenseOutput, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'expectedRevision', message: 'Révision document invalide.' }],
        },
      };
    }
    if (
      typeof input.targetFolderId !== 'string' ||
      input.targetFolderId.length === 0 ||
      input.targetFolderId.length > 200 ||
      input.targetFolderId !== input.targetFolderId.trim() ||
      [...input.targetFolderId].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'targetFolderId', message: 'Dossier de destination invalide.' }],
        },
      };
    }

    const companyId = this.companyId();
    const archived = await this.p.runWithTenant(companyId, () =>
      this.p.documents.findById(companyId, input.documentId),
    );
    if (!archived || archived.status !== 'active') {
      return { ok: false, error: appNotFound('document', input.documentId) };
    }
    const declaredPayment = input.expense.payment ?? null;
    const expense: Omit<RecordExpenseInput, 'companyId'> = {
      ...input.expense,
      // Ces deux champs restent sous autorité serveur, même pour un appel interne élargi.
      source: 'ocr',
      idempotencyKey: documentExpenseCreationKey(archived.sha256),
      // Ticket déjà payé : l'original archivé DEVIENT la preuve du règlement (chaîne
      // paymentEvidence) — jamais une pièce désignée par le client.
      payment: declaredPayment
        ? {
            paidOn: declaredPayment.paidOn,
            method: declaredPayment.method,
            reference: null,
            proofDocumentId: input.documentId,
          }
        : null,
    };

    const coordinated = await this.expenseCreationCoordinator().execute(
      { companyId, expense },
      async ({ expenseId }) => {
        const current = await this.p.documents.findById(companyId, input.documentId);
        if (!current || current.status !== 'active') {
          return { ok: false as const, error: appNotFound('document', input.documentId) };
        }
        const props = current.toProps();
        if (props.linkedEntityType !== null || props.linkedEntityId !== null) {
          if (props.linkedEntityType !== 'expense' || props.linkedEntityId !== expenseId) {
            return {
              ok: false as const,
              error: appConflict('document', 'Ce document est déjà rattaché à une autre entité.'),
            };
          }
          if (props.folderId !== input.targetFolderId) {
            return {
              ok: false as const,
              error: appConflict(
                'document',
                'Le document lié a changé de dossier depuis cette demande. Recharge avant de réessayer.',
              ),
            };
          }
          const replayFolder = await this.p.documentFolders.findById(
            companyId,
            input.targetFolderId,
          );
          return replayFolder?.status === 'active'
            ? ok(documentToView(current))
            : {
                ok: false as const,
                error: appConflict(
                  'document',
                  'Le dossier de destination de cette demande n’est plus actif.',
                ),
              };
        }
        if (current.revision !== input.expectedRevision) {
          return {
            ok: false as const,
            error: appConflict(
              'document',
              'Le document a été modifié. Recharge avant de créer la dépense.',
            ),
          };
        }

        let revision = current.revision;
        if (current.folderId !== input.targetFolderId) {
          const moved = await new MoveDocumentToFolder({
            folders: this.p.documentFolders,
            uow: this.p,
            clock: this.clock,
          }).execute({
            companyId,
            documentId: input.documentId,
            folderId: input.targetFolderId,
            expectedRevision: revision,
          });
          if (!moved.ok) return moved;
          revision = moved.value.revision;
        } else {
          const target = await this.p.documentFolders.findById(companyId, input.targetFolderId);
          if (!target || target.status !== 'active') {
            return {
              ok: false as const,
              error: appNotFound('document_folder', input.targetFolderId),
            };
          }
        }

        const classified = await new ClassifyDocument({
          documents: this.p.documents,
          linkTargets: this.documentLinkTargets(),
          clock: this.clock,
        }).execute({
          companyId,
          documentId: input.documentId,
          linkedEntityType: 'expense',
          linkedEntityId: expenseId,
          expectedRevision: revision,
        });
        if (!classified.ok) return classified;
        // LOT 3 — nom intelligent au record, DANS la même transaction que la dépense/E1/lien.
        const renamed = await this.applyAnalysisSuggestedDisplayName(companyId, classified.value);
        return ok(renamed ?? classified.value);
      },
    );
    if (!coordinated.ok) return coordinated;
    await this.afterExpenseCreationCommitted(companyId, expense, coordinated.value);
    this.logger.audit('document.expense_recorded', {
      companyId,
      documentId: input.documentId,
      expenseId: coordinated.value.expenseId,
      folderId: coordinated.value.followUp.folderId,
      revision: coordinated.value.followUp.revision,
      // Ticket déjà réglé : la dépense naît payée, le scan est sa preuve.
      paidOnCreation: declaredPayment !== null,
    });
    return ok({ expenseId: coordinated.value.expenseId, document: coordinated.value.followUp });
  }

  async listExpenses(): Promise<Result<ExpenseProps[], AppError>> {
    const list = await this.p.expenses.listByCompany(this.companyId());
    return ok(list.map((e) => e.toProps()));
  }

  /** Impute une dépense à un chantier — ou la délie (chantierId null EXPLICITE). MÊME use case
   * AssignExpenseToChantier (@bob/core) pour l'écran Dépenses et pour Bob (parité d'actions) :
   * tenant scoping strict (dépense d'un autre tenant = not_found), chantier PROUVÉ dans le
   * tenant via documentLinkTargets (anti-IDOR, fail-closed), idempotent (retry sans écriture).
   * Transaction : le verrou pessimiste lockById sérialise deux imputations concurrentes. */
  async assignExpenseChantier(input: {
    expenseId: string;
    chantierId: string | null;
  }): Promise<Result<{ chantierId: string | null; changed: boolean }, AppError>> {
    const companyId = this.companyId();
    let r: Result<{ chantierId: string | null; changed: boolean }, AppError>;
    try {
      r = await this.p.runInTransaction(async () => {
        const assigned = await new AssignExpenseToChantier({
          expenses: this.p.expenses,
          chantierTargets: this.documentLinkTargets(),
        }).execute({
          companyId,
          expenseId: input.expenseId,
          chantierId: input.chantierId,
        });
        if (!assigned.ok) throw new RollbackAppError(assigned.error);
        return assigned;
      });
    } catch (e) {
      if (e instanceof RollbackAppError) return { ok: false as const, error: e.appError };
      throw e;
    }
    if (r.ok) {
      this.logger.audit('expense.chantier_assigned', {
        companyId,
        expenseId: input.expenseId,
        chantierId: r.value.chantierId,
        changed: r.value.changed,
      });
    }
    return r;
  }

  /** Enregistre la preuve d'un règlement fournisseur déjà exécuté hors de Bob. Date et moyen sont
   * obligatoires ; la transition et l'écriture 401/512 ou 401/530 sont atomiques dans le tenant. */
  async recordExpensePayment(
    input: {
      expenseId: string;
    } & ExpensePaymentEvidenceInput,
  ): Promise<
    Result<
      {
        status: 'paid';
        alreadyRecorded: boolean;
        paymentEntryId: string;
      },
      AppError
    >
  > {
    if (!(await this.ownedExpense(input.expenseId)))
      return { ok: false as const, error: appNotFound('expense', input.expenseId) };
    let r: Result<
      {
        status: 'paid';
        alreadyRecorded: boolean;
        paymentEntryId: string;
      },
      AppError
    >;
    try {
      r = await this.p.runInTransaction(async () => {
        const paid = await new RecordExpensePayment({
          expenses: this.p.expenses,
          entries: this.p.accountingEntries,
          clock: this.clock,
          charts: this.p.chartOfAccounts,
          documents: this.p.documents,
        }).execute({ ...input, companyId: this.companyId() });
        if (!paid.ok) throw new RollbackAppError(paid.error);
        return paid;
      });
    } catch (e) {
      if (e instanceof RollbackAppError) return { ok: false as const, error: e.appError };
      throw e;
    }
    if (r.ok)
      this.logger.audit('expense.paid', {
        expenseId: input.expenseId,
        paidOn: input.paidOn,
        method: input.method,
        alreadyRecorded: r.value.alreadyRecorded,
        referenceProvided: Boolean(input.reference),
        proofDocumentProvided: Boolean(input.proofDocumentId),
      });
    return r;
  }

  /** Alias HTTP conservé pendant la migration des clients ; il exige désormais la preuve complète. */
  async payExpense(input: { expenseId: string } & ExpensePaymentEvidenceInput) {
    return this.recordExpensePayment(input);
  }

  /** Régularise une dépense HISTORIQUE « payée sans preuve » (paymentEvidenceLegacyUnverified) :
   * valide la preuve comme recordExpensePayment, pose l'écriture 401/512-530 manquante et sort la
   * ligne de l'état legacy — atomique dans le tenant, audit dédié expense.payment_regularized. */
  async regularizeExpensePayment(
    input: {
      expenseId: string;
    } & ExpensePaymentEvidenceInput,
  ): Promise<
    Result<
      {
        status: 'paid';
        alreadyRegularized: boolean;
        paymentEntryId: string;
      },
      AppError
    >
  > {
    if (!(await this.ownedExpense(input.expenseId)))
      return { ok: false as const, error: appNotFound('expense', input.expenseId) };
    let r: Result<
      {
        status: 'paid';
        alreadyRegularized: boolean;
        paymentEntryId: string;
      },
      AppError
    >;
    try {
      r = await this.p.runInTransaction(async () => {
        const regularized = await new RegularizeLegacyExpensePayment({
          expenses: this.p.expenses,
          entries: this.p.accountingEntries,
          clock: this.clock,
          charts: this.p.chartOfAccounts,
          documents: this.p.documents,
        }).execute({ ...input, companyId: this.companyId() });
        if (!regularized.ok) throw new RollbackAppError(regularized.error);
        return regularized;
      });
    } catch (e) {
      if (e instanceof RollbackAppError) return { ok: false as const, error: e.appError };
      throw e;
    }
    if (r.ok)
      this.logger.audit('expense.payment_regularized', {
        expenseId: input.expenseId,
        paidOn: input.paidOn,
        method: input.method,
        alreadyRegularized: r.value.alreadyRegularized,
        referenceProvided: Boolean(input.reference),
        proofDocumentProvided: Boolean(input.proofDocumentId),
      });
    return r;
  }

  // ——— Réception e-facture (C-EXP6b) : le CONTRÔLE DE RÉCEPTION d'un cabinet ———

  /** Erreur de contrôle typée (@bob/core) aplatie à la frontière HTTP : field = `facturx.<code>`,
   *  message riche (les 2 SIREN d'une mal-adressée, les violations EN 16931, la clé du doublon). */
  private facturXControlError(e: { code: string; message: string }): AppError {
    return { kind: 'validation', issues: [{ field: `facturx.${e.code}`, message: e.message }] };
  }

  /** Contrôles bloquants + brouillon : destinataire (SIREN acheteur = MA société), cohérence
   *  EN 16931 rejouée, doublon exact (SIREN fournisseur + n°) — puis mémoire fournisseur. */
  private async facturXReview(xml: string): Promise<Result<FacturXImportReview, AppError>> {
    const companyId = this.companyId();
    // Cette lecture possède sa racine RLS : la route de confirmation ne peut pas conserver une
    // transaction HTTP externe, car la création idempotente suivante doit posséder son rollback.
    return this.p.runWithTenant(companyId, async () => {
      const company = await this.p.companies.findById(companyId);
      if (!company) return { ok: false as const, error: appNotFound('company', companyId) };
      const expenses = await this.p.expenses.listByCompany(companyId);
      const existingInvoiceKeys = expenses
        .map((e) => expenseDuplicateKey(e.toProps()))
        .filter((k): k is string => k !== null);
      const imported = runFacturXReceptionControls({
        xml,
        mySiren: company.siren,
        existingInvoiceKeys,
      });
      if (!imported.ok)
        return { ok: false as const, error: this.facturXControlError(imported.error) };
      // Catégorie de charge proposée via la MÉMOIRE FOURNISSEUR (habitude validée > défaut d'import).
      const profile = await this.p.supplierMemory.supplierProfile(
        companyId,
        imported.value.supplierName,
      );
      const draft = withSupplierCategory(imported.value, profile ? profile.category : null);
      return ok({
        draft,
        controls: ['destinataire', 'coherence_en16931', 'doublon'] as FacturXImportControl[],
      });
    });
  }

  /** POST /expenses/import-facturx — contrôles + brouillon. RIEN n'est enregistré : la décision
   *  (approve/refuse AFNOR) appartient à l'appelant via confirmFacturXExpense. */
  async importFacturXExpense(input: {
    xml: string;
  }): Promise<Result<FacturXImportReview, AppError>> {
    const review = await this.facturXReview(input.xml);
    if (review.ok) {
      this.logger.audit('facturx.import_reviewed', {
        companyId: this.companyId(),
        supplierSiren: review.value.draft.supplierSiren,
        supplierInvoiceNumber: review.value.draft.supplierInvoiceNumber,
        totalTtcCents: review.value.draft.totalTtcCents,
        vatNonDeductible: review.value.draft.vatNonDeductible,
      });
    }
    return review;
  }

  /**
   * POST /expenses/import-facturx/confirm — la DÉCISION AFNOR entrante, explicite.
   *
   * APPROVE : contrôles REJOUÉS sur le XML soumis (serveur sans état — pas de brouillon caché,
   * le doublon est re-vérifié au moment T), puis RecordExpense en TRANSACTION TENANT (écritures
   * 6xx/44566/401 automatiques via E1 — l'autoliquidation arrive avec vatCents 0, donc ZÉRO
   * 44566), puis XML archivé au coffre (kind facturx_xml) lié à l'Expense créée.
   *
   * REFUSE : PAS de contrôles rejoués — refuser une facture mal adressée/incohérente est
   * précisément le geste attendu (proposition AFNOR 210/213). Motif OBLIGATOIRE : la machine
   * InboundEinvoice rejette un refus sans motif (facture contestée non refusée = réputée valable).
   */
  async confirmFacturXExpense(input: {
    xml: string;
    decision: FacturXImportDecision;
  }): Promise<Result<FacturXImportOutcome, AppError>> {
    if (input.decision.action === 'refuse') {
      // Clé métier de la pièce refusée : MÊME clé (SIREN dérivé BT-30/BT-31 + n° normalisé) que celle
      // d'une dépense enregistrée — pour la confronter aux dépenses déjà comptabilisées ci-dessous.
      const parsed = parseFacturXBasic(input.xml);
      const invoiceKey = parsed.ok ? facturXInvoiceDuplicateKey(parsed.value) : 'facture-illisible';
      // C-EXP-FIX1 (Bug 2 — CYCLE DE VIE FANTÔME) : l'InboundEinvoice n'étant pas persisté (v1),
      // l'Expense EST le registre de l'état « approuvée ». Refuser une facture DÉJÀ comptabilisée
      // (Expense + écritures posées) créerait une piste d'audit contradictoire (approuvée ET refusée,
      // AFNOR 210 loggé) → on rejette le refus. Une facture REFUSÉE, elle, ne crée PAS d'Expense et
      // reste ré-importable (un fournisseur peut corriger et renvoyer — c'est voulu).
      // TODO v2 : registre InboundEinvoice PERSISTANT (table + statuts AFNOR 200/210/212/213) pour
      // fermer le cycle de vie complet côté serveur — requis de toute façon pour P07 (connecteur
      // plateforme agréée). Le fix v1 clôt l'incohérence approuvée↔refusée via l'Expense sans sur-ingénierie.
      if (parsed.ok) {
        const companyId = this.companyId();
        const booked = await this.p.runWithTenant(companyId, () =>
          this.p.expenses.listByCompany(companyId),
        );
        if (booked.some((e) => expenseDuplicateKey(e.toProps()) === invoiceKey)) {
          return {
            ok: false as const,
            error: {
              kind: 'validation',
              issues: [
                {
                  field: 'facturx.decision',
                  message:
                    'Facture déjà approuvée et comptabilisée (une dépense et ses écritures existent) : elle ne peut plus être refusée. Contre-passez une écriture d’annulation si nécessaire.',
                },
              ],
            },
          };
        }
      }
      const inbound = InboundEinvoice.receive(this.ids.newId(), invoiceKey);
      if (!inbound.ok) return { ok: false as const, error: appDomain(inbound.error) };
      const refused = inbound.value.refuse(this.clock.now(), {
        afnorStatus: input.decision.afnorStatus,
        reason: input.decision.reason,
      });
      if (!refused.ok) return { ok: false as const, error: appDomain(refused.error) };
      const refusal = inbound.value.refusal;
      if (!refusal)
        return {
          ok: false as const,
          error: { kind: 'dependency', port: 'einvoice-inbound', cause: 'refus sans trace' },
        };
      this.logger.audit('facturx.import_refused', {
        companyId: this.companyId(),
        invoiceKey,
        afnorStatus: refusal.afnorStatus,
      });
      return ok({
        status: 'refused',
        afnorStatus: refusal.afnorStatus,
        reason: refusal.reason,
        invoiceKey,
      });
    }
    if (input.decision.action !== 'approve') {
      return {
        ok: false as const,
        error: {
          kind: 'validation',
          issues: [{ field: 'decision.action', message: 'Décision inconnue (approve ou refuse).' }],
        },
      };
    }
    if (input.decision.category !== undefined && !EXPENSE_CATEGORIES.has(input.decision.category)) {
      return {
        ok: false as const,
        error: {
          kind: 'validation',
          issues: [{ field: 'decision.category', message: 'Catégorie inconnue.' }],
        },
      };
    }
    const review = await this.facturXReview(input.xml);
    if (!review.ok) return review;
    const draft = review.value.draft;
    const inbound = InboundEinvoice.receive(this.ids.newId(), draft.duplicateKey);
    if (!inbound.ok) return { ok: false as const, error: appDomain(inbound.error) };
    const approved = inbound.value.approve(this.clock.now());
    if (!approved.ok) return { ok: false as const, error: appDomain(approved.error) };
    // MÊME chemin que toute dépense (parité humain↔Bob) : RecordExpense + écritures E1 en
    // transaction tenant + apprentissage mémoire fournisseur — rien de spécifique à dupliquer.
    const recorded = await this.recordExpense(
      facturXDraftToRecordExpenseInput(
        draft,
        input.decision.category !== undefined ? { category: input.decision.category } : {},
      ),
    );
    if (!recorded.ok) return recorded;
    // Archivage PROBANT du XML de la facture APPROUVÉE, lié à l'Expense créée (kind facturx_xml).
    let xmlDocumentId: string | null = null;
    const archived = await this.storeDocument({
      kind: 'facturx_xml',
      origin: 'uploaded',
      filename: `facture-fournisseur-${draft.supplierInvoiceNumber.replace(/[^A-Za-z0-9._-]+/g, '-')}.xml`,
      mimeType: 'application/xml',
      bytes: Buffer.from(input.xml, 'utf-8'),
      linkedEntityType: 'expense',
      linkedEntityId: recorded.value.id,
      documentDate: draft.documentDate,
      reason: 'facturx-import-approved',
    });
    if (archived.ok) {
      xmlDocumentId = archived.value.id;
    } else {
      // La dépense et ses écritures sont posées (transaction close) : on n'annule pas une
      // comptabilité valide pour un souci de coffre — trace explicite, ré-archivage manuel possible.
      this.logger.warn(
        `Archivage XML Factur-X impossible: ${appErrorSummary(archived.error)}`,
        'documents',
      );
    }
    this.logger.audit('facturx.import_approved', {
      companyId: this.companyId(),
      expenseId: recorded.value.id,
      supplierSiren: draft.supplierSiren,
      supplierInvoiceNumber: draft.supplierInvoiceNumber,
      vatCents: draft.vatNonDeductible ? 0 : draft.vatCents,
      vatNonDeductible: draft.vatNonDeductible,
      xmlDocumentId,
    });
    return ok({ status: 'approved', expenseId: recorded.value.id, xmlDocumentId });
  }

  // ——— Onboarding / multi-tenant ———
  /**
   * Crée la société du tenant courant ou répare un provisioning incomplet.
   *
   * C24b — deux chemins, JAMAIS d'id accepté du client (anti-rattachement à un tenant arbitraire) :
   * - Principal AVEC tenant : l'id JWT reste l'autorité ; une fiche existante n'est jamais écrasée.
   * - Principal SANS tenant (prod, compte neuf) : PROVISIONING — id DÉTERMINISTE
   *   `company-<userId>` (userId Supabase = UUID → conforme /^[A-Za-z0-9-]{1,64}$/ ; un retry
   *   cible la MÊME company), puis écrit app_metadata.company_id APRÈS le commit PostgreSQL.
   * Dans les deux cas, settings/abonnement/dossiers sont réparés atomiquement. Un retry avec un
   * autre payload conserve la première identité légale ; les changements passent par PATCH.
   */
  async registerCompany(
    input: CompanyRegistrationInput,
  ): Promise<Result<{ companyId: string }, AppError>> {
    const principal = getPrincipal();
    if (!principal) {
      // Bug d'ordonnancement : le guard pose TOUJOURS un principal sur cet endpoint (liste blanche).
      throw new Error(
        'registerCompany sans Principal — le guard doit authentifier avant ce point.',
      );
    }
    const assignsTenantMetadata = principal.companyId === null;
    const companyId = principal.companyId ?? `company-${principal.userId}`;
    // Le guard garantit normalement ces formats ; on re-vérifie avant toute utilisation en GUC RLS.
    if (principal.userId === '' || !/^[A-Za-z0-9-]{1,64}$/.test(companyId)) {
      throw new Error(
        `provisioning tenant : userId inattendu (« ${principal.userId} ») — id de company non dérivable.`,
      );
    }
    const candidate = Company.of({ ...input, id: companyId });
    if (!candidate.ok) return err(appDomain(candidate.error));

    let provisioned: { created: boolean; name: string };
    try {
      // runWithTenant ouvre le GUC RLS en prod ; runInTransaction donne aussi un vrai rollback au
      // harness mémoire. Les deux sont réentrants si l'interceptor a déjà ouvert la transaction.
      provisioned = await this.p.runWithTenant(companyId, () =>
        this.p.runInTransaction(async () => {
          const creation = await this.p.companies.createIfAbsentOpen(candidate.value);
          if (creation === 'identity_conflict') {
            throw new RollbackAppError(appConflict('company', 'identity_already_registered'));
          }
          // Verrou pris immédiatement après l'INSERT/ON CONFLICT : sérialise retry et clôture.
          const company = await this.p.companies.lockById(companyId);
          if (!company) throw new RollbackAppError(appUnavailable('company-provisioning'));
          if (company.isClosed()) throw new RollbackAppError(appForbidden('Compte clôturé.'));

          await this.p.billingSettings.ensureForCompany(companyId);
          const now = this.clock.now();
          if (this.gateway.subscriptionBillingAvailable) {
            const trial = startReverseTrial(now);
            await this.p.subscriptions.startTrial({
              id: `sub-${companyId}`,
              companyId,
              plan: trial.tier,
              trialEndsAt: trial.endsAt,
              now,
            });
          } else {
            // V1 privée : accès anticipé explicite en BDD, gratuit et sans échéance.
            await this.p.subscriptions.startEarlyAccess({
              id: `sub-${companyId}`,
              companyId,
              plan: 'business',
              now,
            });
          }
          const folders = await this.provisionDefaultDocumentFolders(companyId);
          // Un Result.err retourné depuis une transaction serait COMMITÉ : la sentinelle force le
          // rollback de Company + settings + abonnement + dossiers déjà créés.
          if (!folders.ok) throw new RollbackAppError(folders.error);
          return { created: creation === 'created', name: company.name };
        }),
      );
    } catch (error) {
      if (error instanceof RollbackAppError) return err(error.appError);
      throw error;
    }

    if (assignsTenantMetadata) {
      try {
        await this.supabaseAdmin.setUserCompanyId(principal.userId, companyId);
      } catch (e) {
        const cause = e instanceof Error ? e.message : 'supabase-admin';
        // PostgreSQL est volontairement déjà commité : le retry répare uniquement cette metadata.
        this.logger.error(
          `provisioning tenant ${companyId} : écriture app_metadata.company_id échouée (${cause}) — retry client possible, company idempotente`,
          undefined,
          'BackendService',
        );
        return err({ kind: 'dependency', port: 'supabase-admin', cause });
      }
    }
    this.logger.audit(provisioned.created ? 'company.provisioned' : 'company.provisioning_repaired', {
      companyId,
      userId: principal.userId,
      name: provisioned.name,
    });
    return ok({ companyId });
  }

  /**
   * DELETE /account (Apple 5.1.1(v)) — clôture DÉFINITIVE du compte courant. JAMAIS un cascade
   * delete : cf. CloseAccount (@bob/core) pour l'architecture (closedAt additif, pièces
   * comptables INTACTES — rétention légale 10 ans, Code de commerce). Orchestration en DEUX temps
   * volontairement SÉPARÉS de la transaction HTTP auto-ouverte par TenantPersistenceInterceptor
   * (le controller porte `@WithoutTenantPersistenceTransaction`, comme l'upload/intake documents) :
   *  1) DANS runWithTenant, tout-ou-rien Postgres : le use case core (closedAt, abonnement
   *     canceled, liens de signature publics révoqués) PUIS la purge des push tokens (Device,
   *     hors @bob/core — le port core ne connaît pas cette table).
   *  2) APRÈS COMMIT, hors transaction : suppression du user Supabase Auth. C'est LE point où
   *     l'identité PERSONNELLE (prénom, email, téléphone — user_metadata) disparaît réellement :
   *     Postgres n'en a jamais stocké la moindre trace (cf. commentaire CompanyProps.closedAt).
   *     Best-effort et loggé, jamais bloquant : un échec Supabase (réseau, 5xx transitoire) laisse
   *     le compte DÉJÀ clôturé côté Bob Pro (closedAt posé, tenant inaccessible derrière le guard) —
   *     la reprise est un retry de CET appel Supabase seul (deleteUser sur un user déjà supprimé
   *     répond 404, traité comme un succès idempotent), jamais un nouveau tour du use case.
   */
  async closeAccount(input: {
    confirmationText: string;
    reason?: string | null;
  }): Promise<Result<{ closedAt: string }, AppError>> {
    const principal = getPrincipal();
    if (!principal) {
      // Bug d'ordonnancement : le guard pose TOUJOURS un principal AVEC tenant sur cette route.
      throw new Error('closeAccount sans Principal — le guard doit authentifier avant ce point.');
    }
    const companyId = this.companyId();
    const now = this.clock.now();

    const closed = await this.p.runWithTenant(companyId, async () => {
      const useCase = new CloseAccount({
        companies: this.p.companies,
        subscriptions: this.p.subscriptions,
        publicAccessTokens: this.p.publicAccessTokens,
        uow: this.p,
      });
      const r = await useCase.execute({
        companyId,
        confirmationText: input.confirmationText,
        reason: input.reason ?? null,
        now,
      });
      if (!r.ok) return r;
      await this.p.devices.deleteAllForCompany(companyId);
      return r;
    });
    if (!closed.ok) return closed;

    this.logger.audit('account.closed', {
      companyId,
      userId: principal.userId,
      alreadyClosed: closed.value.alreadyClosed,
    });

    try {
      await this.supabaseAdmin.deleteUser(principal.userId);
    } catch (e) {
      const cause = e instanceof Error ? e.message : 'supabase-admin';
      this.logger.error(
        `clôture ${companyId} : suppression du user Supabase Auth échouée (${cause}) — compte DÉJÀ clôturé côté Bob Pro, retry manuel possible côté auth seul`,
        undefined,
        'BackendService',
      );
    }

    return ok({ closedAt: closed.value.closedAt });
  }

  async createCustomer(
    input: Omit<CustomerProps, 'id' | 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>> {
    const id = this.ids.newId();
    const r = Customer.of({ id, companyId: this.companyId(), ...input });
    if (!r.ok) return { ok: false, error: appDomain(r.error) };
    await this.p.customers.save(r.value);
    this.logger.audit('customer.created', { id, companyId: this.companyId() });
    return ok({ id });
  }

  /** Édition post-création (C13/C40 TODO partagé) — la fiche mobile permet de compléter/corriger
   * ce que la création MINIMALE (nom + type) n'a pas saisi. Remplacement complet revalidé par
   * Customer.of (mêmes invariants qu'à la création), scopé au tenant courant.
   * A8 — BARRIÈRE D'ARCHIVES : les données du client (nom, type, SIREN, adresse) sont relues au
   * RENDU des originaux (quotePdfData/renderInvoicePdf) par les jobs d'archivage — tant qu'un
   * ordre d'archivage (devis signé OU facture émise) n'est pas abouti, l'édition fabriquerait
   * une archive différente du document signé/émis (art. 1366-1367 c. civ.) : même doctrine que
   * updateCompanyProfile/updateCompanyLegal, appliquée aux éditions du CLIENT.
   * A3/A4 — la garde du TYPE (immuable dès qu'une pièce signée/émise existe) vit dans le use
   * case pur UpdateCustomer (@bob/core). */
  async updateCustomer(
    id: string,
    input: Omit<CustomerProps, 'id' | 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>> {
    const companyId = this.companyId();
    const r = await this.p.runInTransaction(async (): Promise<Result<{ id: string }, AppError>> => {
      // Ordre global anti-deadlock : Company FOR UPDATE avant toute autre ligne (même ordre que
      // updateCompanyProfile) — sérialise l'édition avec les signatures/émissions en cours.
      const company = await this.p.companies.lockById(companyId);
      if (!company) return err(appNotFound('company', companyId));
      if (company.isClosed()) return err(appForbidden('Compte clôturé.'));
      const quoteArchiveReady = await this.assertSignedQuoteArchivesComplete(companyId);
      if (!quoteArchiveReady.ok) return quoteArchiveReady;
      const invoiceArchiveReady = await this.assertIssuedInvoiceArchivesComplete(companyId);
      if (!invoiceArchiveReady.ok) return invoiceArchiveReady;
      return new UpdateCustomer({
        customers: this.p.customers,
        quotes: this.p.quotes,
        invoices: this.p.invoices,
      }).execute({
        id,
        companyId,
        ...input,
      });
    });
    if (r.ok) this.logger.audit('customer.updated', { id, companyId });
    return r;
  }
}
