import type { ValueEvent } from '@bob/core';
import {
  BobAgent,
  ModelRouter,
  pendingToInvocations,
  type BobActions,
  type AgentRun,
  type AgentAutonomy,
  type PendingAction,
  type JournalEntry,
  type PayableInvoice,
  type SendableQuote,
  type IssuableInvoice,
  type InvoiceableQuote,
  type AgentDocument,
} from '@bob/ai';
import { InMemoryJournalStore } from '@bob/ai/testing';
import {
  buildValueDigest,
  CreateQuote,
  SendQuote,
  SignQuote,
  CreateQuoteSignatureLink,
  CreateDocumentViewLink,
  sha256Hex,
  RefuseQuote,
  CreateCreditNote,
  GenerateInvoiceFromQuote,
  UpdateQuoteLine,
  RemoveQuoteLine,
  DeleteDraftInvoice,
  IssueInvoice,
  RegisterPayment,
  RecordExpensePayment,
  RegularizeLegacyExpensePayment,
  RecordExpenseAccountingEntries,
  RecordIssuedInvoiceAccountingEntry,
  RecordPaymentAccountingEntry,
  ListAccountingEntries,
  ExportFec,
  PreviewPaymentAccountingEntry,
  ListCustomers,
  GetCashflow,
  SystemClock,
  PLAN_CATALOG,
  ADDON_CATALOG,
  planEntitlements,
  resolveAutonomyEntitlement,
  runDiagnostic,
  deriveFiscalCalendar,
  deriveVatPosition,
  deriveAgedBalance,
  deriveTrialBalance,
  deriveIncomeStatement,
  deriveBalanceSheet,
  deriveBusinessReview,
  deriveClosingReview,
  resolveTradeConfig,
  buildDocumentStorageKey,
  DEFAULT_DOCUMENT_FOLDERS,
  normalizeDocumentFolderName,
  validateDocumentFolderName,
  validateDocumentDisplayName,
  DOCUMENT_DISPLAY_NAME_MAX_LENGTH,
  makeDocumentAnalysis,
  buildInvoiceAccountingPreviewEntry,
  createFrenchOperationalChartOfAccounts,
  ExtractDocument,
  RecordExpense,
  importFacturXExpense as runFacturXReceptionControls,
  withSupplierCategory,
  facturXDraftToRecordExpenseInput,
  expenseDuplicateKey,
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
  GetFiscalProfile,
  UpdateFiscalProfileField,
  parseFiscalProfileFieldPatch,
  type FiscalProfile,
  type FiscalProfileRepository,
  type FiscalProfileView,
  SearchAddress,
  CloseAccount,
  type SubscriptionRepository,
  type SubscriptionRecord,
  Company,
  Customer,
  UpdateCustomer,
  deriveRelancePlan,
  ok,
  err,
  appUnavailable,
  appNotFound,
  appForbidden,
  appDomain,
  appConflict,
  parseQuoteDraftPayload,
  QUOTE_DRAFT_PAYLOAD_VERSION,
  type ClockPort,
  type IdGeneratorPort,
  type CreateQuoteInput,
  type IssueInvoiceInput,
  type UpdateQuoteLineInput,
  type RemoveQuoteLineInput,
  type Quote,
  type Invoice,
  type Result,
  type AppError,
  type Scenario,
  type Horizon,
  type PaymentMethod,
  type CashflowProjection,
  type QualifiedBankBalanceSnapshot,
  type CustomerListItem,
  type CreateQuoteOutput,
  type DiagnosticResult,
  type DiagnosticAssessmentView,
  type DiagnosticAssessmentWriteRequest,
  type FiscalDeadline,
  type OcrExtraction,
  type ExpenseProps,
  type RecordExpenseInput,
  type PlanTier,
  type TradeConfig,
  type Trade,
  type VatRegime,
  type ChantierListItem,
  type ChantierNoteProps,
  type WorksiteMediaItem,
  type CreateChantierInput,
  type CompanyProps,
  type CompanyBillingSettings,
  type CompanyBillingSettingsPatch,
  type CustomerPortfolio,
  type CompanyLookupResult,
  type VatCheckResult,
  type AddressSuggestion,
  type DocumentView,
  Document,
  type DocumentRepository,
  type DocumentDownloadUrl,
  type DocumentFolderView,
  type DeleteDocumentFolderStrategy,
  type DocumentAnalysis,
  searchSalesDocumentsInMemory,
  suggestSalesDocumentsInMemory,
  type SalesDocumentSearchPiece,
  type SearchSalesDocumentsResult,
  type SuggestSalesDocumentsResult,
  type Totals,
  type CatalogueItemWriteInput,
  type CatalogueItemView,
  type CatalogueDeletionView,
} from '@bob/core';
import {
  CASH_SNAPSHOT,
  DemoOcrAdapter,
  seedCompany,
  seedCustomers,
  seedExpenses,
  seedVaultDocuments,
} from '@bob/core/testing';
import {
  InMemoryCompanyRepository,
  InMemoryCustomerRepository,
  InMemoryQuoteRepository,
  InMemoryInvoiceRepository,
  InMemoryPaymentRepository,
  InMemoryPublicAccessTokenRepository,
  InMemoryExpenseRepository,
  InMemoryCatalogueRepository,
  InMemoryChantierRepository,
  InMemoryChantierNoteRepository,
  InMemoryWorksiteMediaStorage,
  InMemoryDocumentStorage,
  InMemoryAccountingEntryRepository,
  InMemoryChartOfAccountsRepository,
} from './in-memory/repositories';
import { DemoCompanyLookupAdapter } from './in-memory/company-lookup';
import { DemoVatAdapter, DemoAddressAdapter } from './in-memory/enrichment';
import {
  InMemorySequenceCounter,
  CounterIdGenerator,
  FixtureCashflowSnapshot,
} from './in-memory/services';
import type {
  BobClient,
  QuoteView,
  InvoiceView,
  PaymentView,
  RecordExpensePaymentClientInput,
  RecordExpensePaymentClientOutput,
  RegularizeExpensePaymentClientInput,
  RegularizeExpensePaymentClientOutput,
  SubscriptionView,
  SendQuoteOutput,
  CreateQuoteSignatureLinkOutput,
  CreateDocumentViewLinkOutput,
  SendRelanceClientOutput,
  NotificationView,
  NotificationUnreadPreview,
  NotificationReadThroughInput,
  NotificationReadThroughOutput,
  RegisterDeviceClientInput,
  RevokeDeviceBindingClientInput,
  UnregisterDeviceClientInput,
  ListDocumentsClientInput,
  DocumentListItemView,
  RenameDocumentClientInput,
  UploadDocumentClientInput,
  CreateDocumentIntakeClientInput,
  ListDocumentFoldersClientInput,
  DocumentFolderPageView,
  DocumentFolderDeletionPlanView,
  DocumentFolderDeletionExecutionView,
  VoiceConfig,
  VoiceSynthesisResult,
  RealtimeVoiceConfig,
  RealtimeVoiceCall,
  RealtimeVoiceCallInput,
  RealtimeVoiceContextUpdate,
  RealtimeVoiceControlAcknowledgement,
  RealtimeVoiceControlReference,
  RealtimeVoiceSpeechCancellationInput,
  RealtimeVoiceSpeechDeliveryAcknowledgement,
  RealtimeVoiceSpeechDeliveryInput,
  RealtimeVoiceSpeechFeed,
  RealtimeVoiceSpeechFeedInput,
  SuggestExpenseDefaultsInput,
  ExpenseDefaultsView,
  FacturXImportReview,
  FacturXImportControl,
  FacturXImportDecision,
  FacturXImportOutcome,
  InvoiceAccountingPreview,
  PaymentAccountingPreview,
  AccountingEntryView,
  ClassifyDocumentClientInput,
  RecordDocumentExpenseClientInput,
  RecordDocumentExpenseClientOutput,
  AskBobClientInput,
  CreateCustomerClientInput,
  UpdateCustomerClientInput,
  SearchSalesDocumentsClientInput,
  ValueDigestView,
  TrialReportView,
  QuoteDraftSlotView,
  SaveQuoteDraftClientInput,
} from './client';
import { documentAnalysisSummaryView, documentExtractionSummaryView } from './document-codecs';
import { localExpenseCreationFingerprint, portableSha256Bytes } from './expense-idempotency';
import { cloneQuoteCreation, localQuoteCreationFingerprint } from './quote-idempotency';

export interface LocalBobClientOptions {
  clock?: ClockPort;
  /** Générateur d'ids injectable (tests déterministes — ex. journal d'agent rejouable). */
  ids?: IdGeneratorPort;
}

interface LocalDocumentFolderDeletionPlan {
  id: string;
  companyId: string;
  folderId: string;
  expectedRevision: number;
  snapshot: {
    folders: { id: string; parentId: string | null; revision: number }[];
    documents: { id: string; folderId: string | null; revision: number }[];
  };
  expiresAt: string;
  consumed: boolean;
}

const DOCUMENT_BINARY_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_BASE64_MAX_CHARS = Math.ceil(DOCUMENT_BINARY_MAX_BYTES / 3) * 4;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
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

type Base64DocumentDecode =
  | { ok: true; bytes: Uint8Array; contentBase64: string }
  | { ok: false; reason: 'invalid' | 'empty' | 'too_large' };

function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset] ?? 0;
    const hasB = offset + 1 < bytes.length;
    const hasC = offset + 2 < bytes.length;
    const b = bytes[offset + 1] ?? 0;
    const c = bytes[offset + 2] ?? 0;
    result += BASE64_ALPHABET[a >>> 2];
    result += BASE64_ALPHABET[((a & 0x03) << 4) | (b >>> 4)];
    result += hasB ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >>> 6)] : '=';
    result += hasC ? BASE64_ALPHABET[c & 0x3f] : '=';
  }
  return result;
}

function decodeBase64Document(contentBase64: unknown): Base64DocumentDecode {
  if (typeof contentBase64 !== 'string') return { ok: false, reason: 'invalid' };
  const raw = contentBase64.includes(',')
    ? contentBase64.slice(contentBase64.indexOf(',') + 1)
    : contentBase64;
  const normalized = raw.replace(/\s/g, '');
  if (!normalized) return { ok: false, reason: 'empty' };
  if (normalized.length > DOCUMENT_BASE64_MAX_CHARS + 2) return { ok: false, reason: 'too_large' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    return { ok: false, reason: 'invalid' };
  }
  const firstPadding = normalized.indexOf('=');
  if (firstPadding >= 0 && normalized.length % 4 !== 0) return { ok: false, reason: 'invalid' };
  const unpadded = firstPadding >= 0 ? normalized.slice(0, firstPadding) : normalized;
  const padded = `${unpadded}${'='.repeat((4 - (unpadded.length % 4)) % 4)}`;
  const padding = padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((padded.length / 4) * 3 - padding);
  let cursor = 0;
  for (let offset = 0; offset < padded.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(padded[offset]!);
    const b = BASE64_ALPHABET.indexOf(padded[offset + 1]!);
    const c = padded[offset + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(padded[offset + 2]!);
    const d = padded[offset + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(padded[offset + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) return { ok: false, reason: 'invalid' };
    const word = (a << 18) | (b << 12) | (c << 6) | d;
    if (cursor < bytes.length) bytes[cursor++] = (word >>> 16) & 0xff;
    if (cursor < bytes.length) bytes[cursor++] = (word >>> 8) & 0xff;
    if (cursor < bytes.length) bytes[cursor++] = word & 0xff;
  }
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > DOCUMENT_BINARY_MAX_BYTES) return { ok: false, reason: 'too_large' };
  return { ok: true, bytes, contentBase64: bytesToBase64(bytes) };
}

function utf8BytesLocal(value: string): Uint8Array {
  const encoded: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0xfffd;
    if (point <= 0x7f) encoded.push(point);
    else if (point <= 0x7ff) encoded.push(0xc0 | (point >>> 6), 0x80 | (point & 0x3f));
    else if (point <= 0xffff) {
      encoded.push(0xe0 | (point >>> 12), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      encoded.push(
        0xf0 | (point >>> 18),
        0x80 | ((point >>> 12) & 0x3f),
        0x80 | ((point >>> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return Uint8Array.from(encoded);
}

function asciiPrefix(bytes: Uint8Array, length: number, offset = 0): string {
  let value = '';
  for (let index = offset; index < Math.min(bytes.length, offset + length); index += 1) {
    value += String.fromCharCode(bytes[index]!);
  }
  return value;
}

function documentSignatureMatches(mimeType: string, bytes: Uint8Array): boolean {
  const isPdf = asciiPrefix(bytes, 5) === '%PDF-';
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng =
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
  const isWebp = asciiPrefix(bytes, 4) === 'RIFF' && asciiPrefix(bytes, 4, 8) === 'WEBP';
  const heifBrand = asciiPrefix(bytes, 4, 8);
  const isHeif =
    asciiPrefix(bytes, 4, 4) === 'ftyp' &&
    new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']).has(heifBrand);
  const xmlHead = asciiPrefix(bytes, Math.min(bytes.length, 512))
    .replace(/^\u00ef\u00bb\u00bf/, '')
    .trimStart();
  return (
    (mimeType === 'application/pdf' && isPdf) ||
    (mimeType === 'image/jpeg' && isJpeg) ||
    (mimeType === 'image/png' && isPng) ||
    (mimeType === 'image/webp' && isWebp) ||
    ((mimeType === 'image/heic' || mimeType === 'image/heif') && isHeif) ||
    ((mimeType === 'application/xml' || mimeType === 'text/xml') && xmlHead.startsWith('<'))
  );
}

function cloneDocumentView(document: DocumentView): DocumentView {
  return { ...document, tags: [...document.tags] };
}

/** Libellé d'affichage par défaut dérivé du filename (miroir du domaine — jamais vide). */
function localDefaultDisplayName(filename: string): string {
  return filename.replace(/\s+/g, ' ').trim().slice(0, DOCUMENT_DISPLAY_NAME_MAX_LENGTH).trim() || 'Document';
}

const LOCAL_DEMO_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/RSiiivcPPP/2Q==';
const LOCAL_DEMO_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCA+PiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDAgPj4Kc3RyZWFtCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDIxOSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDUgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjI2OAolJUVPRgo=';

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

/** Horloge décalée de n jours dans le passé — le seed démo a un HISTORIQUE (facture échue
 *  issue d'un vrai flow antidaté, jamais un statut fabriqué à la main). */
function clockDaysAgo(days: number): ClockPort {
  const shiftMs = days * 86_400_000;
  return {
    now: () => new Date(Date.now() - shiftMs).toISOString(),
    today: () => new Date(Date.now() - shiftMs).toISOString().slice(0, 10),
  };
}

// —— Assistant local (C40 ⑧, parité serveur) ——————————————————————————————————
const PAYABLE_STATUSES = new Set(['issued', 'partially_paid', 'late']);
const SENDABLE_QUOTE_STATUSES = new Set(['draft', 'sent', 'viewed']);

/** Clamp d'autonomie identique au serveur (apps/api ai/autonomy-entitlements) : jamais au-delà de l'offre. */
const AUTONOMY_RANK: Record<AgentAutonomy, number> = {
  confirm_all: 0,
  confirm_outbound: 1,
  auto: 2,
};
function clampAutonomy(
  requested: AgentAutonomy | undefined,
  entitlement: AgentAutonomy,
): AgentAutonomy {
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
  private readonly catalogue = new InMemoryCatalogueRepository();
  private readonly expenseCreationRequests = new Map<
    string,
    { payloadHash: string; expenseId: string }
  >();
  private expenseCreationTail: Promise<void> = Promise.resolve();
  private readonly quoteCreationRequests = new Map<
    string,
    { payloadHash: string; output: CreateQuoteOutput }
  >();
  private quoteCreationTail: Promise<void> = Promise.resolve();
  private quoteDraftSlot: QuoteDraftSlotView | null = null;
  private readonly chantiers = new InMemoryChantierRepository();
  private readonly chantierNotes = new InMemoryChantierNoteRepository();
  private readonly worksiteMedia = new InMemoryWorksiteMediaStorage();
  private readonly worksitePhotoBytes = new InMemoryDocumentStorage();
  private readonly accountingEntries = new InMemoryAccountingEntryRepository();
  private readonly chartOfAccounts = new InMemoryChartOfAccountsRepository();
  private readonly documents: DocumentView[] = [];
  /** Adaptateur strictement réservé au client de test : restitue l'agrégat attendu par le core. */
  private readonly paymentProofDocuments: Pick<DocumentRepository, 'findById'> = {
    findById: async (companyId, documentId) => {
      const view = this.documents.find(
        (candidate) => candidate.companyId === companyId && candidate.id === documentId,
      );
      if (!view) return null;
      return Document.rehydrate({
        id: view.id,
        companyId: view.companyId,
        kind: view.kind,
        origin: view.origin,
        status: view.status,
        filename: view.filename,
        mimeType: view.mimeType,
        byteSize: view.byteSize,
        sha256: view.sha256,
        storageKey: view.storageKey,
        folderId: view.folderId,
        revision: view.revision,
        linkedEntityType: view.linkedEntityType,
        linkedEntityId: view.linkedEntityId,
        documentDate: view.documentDate,
        issuedAt: view.issuedAt,
        createdAt: view.createdAt,
        createdBy: view.createdBy,
        retentionUntil: view.retentionUntil,
        deletedAt: view.status === 'deleted' ? view.createdAt : null,
        versions: [
          {
            id: `${view.id}:v${view.version}`,
            documentId: view.id,
            version: view.version,
            storageKey: view.storageKey,
            sha256: view.sha256,
            mimeType: view.mimeType,
            byteSize: view.byteSize,
            createdAt: view.createdAt,
            reason: 'Adaptateur LocalBobClient',
          },
        ],
        tags: [...view.tags],
      });
    },
  };
  private readonly documentContents = new Map<
    string,
    { contentBase64: string; mimeType: string }
  >();
  private readonly documentIntakes = new Map<
    string,
    { documentId: string; sha256: string; mimeType: string }
  >();
  /** Cache local des analyses (parité du cache persistant serveur) — clé documentId, liée version+sha à la lecture. */
  private readonly documentAnalyses = new Map<string, DocumentAnalysis>();
  private readonly documentFolders: DocumentFolderView[] = [];
  private readonly documentFolderDeletionPlans = new Map<string, LocalDocumentFolderDeletionPlan>();
  private documentSeq = 0;
  // Fil de notifications local (C25, adaptateur démo) — alimenté par sendRelance, lu/non-lu en mémoire.
  private readonly notifications: NotificationView[] = [];
  private readonly relanceDedupe = new Map<string, string>();
  private notificationSeq = 0;
  private readonly pushDevices = new Map<
    string,
    {
      installationId: string;
      bindingId: string;
      bindingGeneration: number;
    }
  >();
  private readonly pushInstallations = new Map<
    string,
    {
      bindingId: string | null;
      maxGeneration: number;
      revocationSecret: string;
      expoPushToken: string | null;
    }
  >();
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
  // BOB EXPERT FISCAL (Phase 1A) : mêmes use cases @bob/core que le serveur, adaptateur en mémoire.
  private readonly fiscalProfiles = new Map<string, FiscalProfile>();
  private readonly fiscalProfileRepository: FiscalProfileRepository = {
    findByCompanyId: async (companyId) => this.fiscalProfiles.get(companyId) ?? null,
    save: async (profile) => {
      this.fiscalProfiles.set(profile.companyId, profile);
    },
  };
  // Démo hors-ligne : AUCUNE ligne d'abonnement n'existe jamais (getSubscription renvoie
  // toujours l'early-access statique — cf. plus bas). Ce repo n'existe que pour satisfaire le
  // port CloseAccount ; findByCompanyId reste vide, il n'y a donc jamais rien à annuler ici.
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly subscriptionRepository: SubscriptionRepository = {
    findByCompanyId: async (companyId) => this.subscriptions.get(companyId) ?? null,
    startEarlyAccess: async (input) => {
      const existing = this.subscriptions.get(input.companyId);
      if (existing) return existing;
      const record: SubscriptionRecord = {
        id: input.id,
        companyId: input.companyId,
        plan: input.plan,
        status: 'active',
        trialEndsAt: null,
        currentPeriodEnd: null,
        store: 'none',
        storeRef: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.subscriptions.set(input.companyId, record);
      return record;
    },
    startTrial: async (input) => {
      const existing = this.subscriptions.get(input.companyId);
      if (existing) return existing;
      const record: SubscriptionRecord = {
        id: input.id,
        companyId: input.companyId,
        plan: input.plan,
        status: 'trialing',
        trialEndsAt: input.trialEndsAt,
        currentPeriodEnd: null,
        store: null,
        storeRef: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.subscriptions.set(input.companyId, record);
      return record;
    },
    save: async (record) => {
      this.subscriptions.set(record.companyId, record);
      return record;
    },
  };
  private readonly clock: ClockPort;
  private readonly snapshots: FixtureCashflowSnapshot;
  // Assistant local (C40 ⑧) : journal append-only en mémoire + agent @bob/ai instancié à la demande.
  private readonly journal = new InMemoryJournalStore();
  private agent: BobAgent | null = null;
  private billingSettings: CompanyBillingSettings;

  constructor(opts?: LocalBobClientOptions) {
    const company = seedCompany();
    this.companyId = company.id;
    const settingsCreatedAt = new Date().toISOString();
    this.billingSettings = {
      companyId: company.id,
      revision: 1,
      showRibOnInvoices: false,
      showInsuranceOnInvoices: true,
      pdfAccentColor: 'navy',
      defaultQuoteValidityDays: 30,
      defaultDepositPercent: 30,
      defaultInvoicePaymentTermsDays: 30,
      createdAt: settingsCreatedAt,
      updatedAt: settingsCreatedAt,
    };
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
    for (const expense of seedExpenses(this.companyId, this.clock.today()))
      void this.expenses.save(expense);
    this.documents.push(
      ...seedVaultDocuments(this.companyId, this.clock.now(), this.clock.today()),
    );
    for (const document of this.documents) {
      const contentBase64 =
        document.mimeType === 'application/pdf' ? LOCAL_DEMO_PDF_BASE64 : LOCAL_DEMO_JPEG_BASE64;
      const decoded = decodeBase64Document(contentBase64);
      if (!decoded.ok) throw new Error(`Fixture document locale invalide: ${document.id}`);
      document.byteSize = decoded.bytes.length;
      document.sha256 = portableSha256Bytes(decoded.bytes);
      document.storageKey = buildDocumentStorageKey({
        companyId: document.companyId,
        documentId: document.id,
        version: document.version,
        sha256: document.sha256,
        filename: document.filename,
        mimeType: document.mimeType,
      });
      this.documentContents.set(document.id, {
        contentBase64: decoded.contentBase64,
        mimeType: document.mimeType,
      });
    }
    this.documentFolders.push(
      ...DEFAULT_DOCUMENT_FOLDERS.map((folder) => ({
        id: `local-folder-${folder.systemKey}`,
        companyId: this.companyId,
        parentId: null,
        name: folder.name,
        normalizedName: normalizeDocumentFolderName(folder.name),
        systemKey: folder.systemKey,
        status: 'active' as const,
        revision: 1,
        createdAt: this.clock.now(),
        updatedAt: this.clock.now(),
        deletedAt: null,
      })),
    );
    for (const document of this.documents) {
      if (document.origin === 'ocr' && document.linkedEntityType === null) continue;
      const systemKey =
        document.linkedEntityType === 'chantier'
          ? 'projects'
          : document.linkedEntityType === 'expense' || document.kind === 'expense_receipt'
            ? 'purchases'
            : ['invoice_pdf', 'quote_pdf', 'facturx_xml', 'signed_quote'].includes(document.kind)
              ? 'accounting'
              : null;
      document.folderId = systemKey ? `local-folder-${systemKey}` : null;
    }
    // Facturation de démo (C16) : mêmes FLOWS que l'utilisateur — devis signé avec acompte
    // (test d'or 488,40), facture d'acompte émise puis ENCAISSÉE → le briefing du jour
    // propose la facture finale (proto), la pièce montre suivi payé + frise + mentions figées.
    // Puis cycle achats : les dépenses seedées postent leurs écritures (journal AC + BQ),
    // exactement comme recordExpense le fait pour l'utilisateur — le grand-livre démo est complet.
    this.ready = this.seedBillingDemo()
      .then(() => this.seedExpenseAccountingDemo())
      .catch(() => undefined);
  }

  /** Barrière du seed asynchrone : les lectures billing attendent la démo posée. */
  private ready: Promise<void> = Promise.resolve();

  /** Sérialise les créations locales : même garantie mono-gagnant que l'index PostgreSQL. */
  private async withExpenseCreationLock<T>(fn: () => Promise<T>): Promise<T> {
    const predecessor = this.expenseCreationTail;
    let release: () => void = () => undefined;
    this.expenseCreationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Même mono-gagnant local pour POST /quotes et pour un rejeu après réponse perdue. */
  private async withQuoteCreationLock<T>(fn: () => Promise<T>): Promise<T> {
    const predecessor = this.quoteCreationTail;
    let release: () => void = () => undefined;
    this.quoteCreationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Écritures du cycle achats pour les dépenses seedées (même use case que recordExpense). */
  private async seedExpenseAccountingDemo(): Promise<void> {
    const postEntries = new RecordExpenseAccountingEntries({
      expenses: this.expenses,
      entries: this.accountingEntries,
      charts: this.chartOfAccounts,
    });
    for (const expense of await this.expenses.listByCompany(this.companyId)) {
      await postEntries.execute({ expenseId: expense.id });
    }
  }

  private async seedBillingDemo(): Promise<void> {
    // Le seed n'emprunte QUE les variantes *Internal : les méthodes publiques attendent
    // this.ready (= cette promesse) — les appeler ici serait un interblocage.

    // ── Facture ÉCHUE réelle (A2-C10) : le MÊME flow, exécuté « il y a 45 jours » (horloge
    // décalée) — la mairie n'a pas payé son mandat administratif. Le briefing propose la
    // relance ET l'encaissement direct ; 1 850,00 € TTC = l'encours fixture de cust-sevres
    // (la facture MATÉRIALISE le chiffre du proto, elle ne le double pas). Semée en premier :
    // la numérotation reste chronologique et sans trou (F-2026-0001 = la plus ancienne).
    const past = clockDaysAgo(45);
    const sevres = await this.createQuoteInternal(
      {
        customerId: 'cust-sevres',
        lines: [
          {
            label: 'Remplacement chauffe-eau — bâtiment mairie',
            category: 'labor',
            qty: 1,
            unitPriceHT: 154167,
            vatRate: 20,
          },
        ],
      },
      past,
    );
    if (sevres.ok) {
      const sevresQuoteId = sevres.value.quoteId;
      await this.sendQuoteInternal(sevresQuoteId, past);
      await this.signQuoteInternal(
        { quoteId: sevresQuoteId, signerName: 'Mairie de Sèvres' },
        past,
      );
      const sevresInvoice = await this.generateInvoiceInternal({
        quoteId: sevresQuoteId,
        mode: 'final',
      });
      if (sevresInvoice.ok)
        await this.issueInvoiceInternal({ invoiceId: sevresInvoice.value.invoiceId }, past);
    }

    // ── Chantier Martin (C16) : devis signé avec acompte (test d'or 488,40), acompte émis
    // puis ENCAISSÉ → le briefing propose la facture finale.
    const created = await this.createQuoteInternal({
      customerId: 'cust-martin',
      depositPct: 30,
      lines: [
        {
          label: 'Pose pompe à chaleur — main-d’œuvre',
          category: 'labor',
          qty: 1,
          unitPriceHT: 98000,
          vatRate: 20,
        },
        {
          label: 'Fournitures hydrauliques',
          category: 'supply',
          qty: 1,
          unitPriceHT: 37667,
          vatRate: 20,
        },
      ],
    });
    if (!created.ok) return;
    const quoteId = created.value.quoteId;
    await this.sendQuoteInternal(quoteId);
    await this.signQuoteInternal({ quoteId, signerName: 'SARL Martin Rénovation' });
    const generated = await this.generateInvoiceInternal({ quoteId, mode: 'deposit' });
    if (!generated.ok) return;
    await this.issueInvoiceInternal({ invoiceId: generated.value.invoiceId });
    // L'acompte est encaissé — plafonné netToPay (488,40 €), comme la doctrine l'exige.
    await this.registerPaymentInternal({
      invoiceId: generated.value.invoiceId,
      amount: 48840,
      method: 'card',
    });

    // ── Devis EN ATTENTE de réponse : matérialise le « devis 1 480 € » du proto (hors
    // total dû — les devis ne sont jamais du dû, doctrine standings) + un second envoyé.
    // Deux cibles réelles pour la question structurée ASK-1 (« quel devis ? ») — le mode
    // démo exerce TOUT le registre (doctrine C14), y compris l'ambiguïté.
    const durandQuote = await this.createQuoteInternal({
      customerId: 'cust-durand',
      lines: [
        {
          label: 'Rénovation salle de bain — phase 2',
          category: 'labor',
          qty: 1,
          unitPriceHT: 123333,
          vatRate: 20,
        },
      ],
    });
    if (durandQuote.ok) await this.sendQuoteInternal(durandQuote.value.quoteId);
    const sevresMaintenance = await this.createQuoteInternal({
      customerId: 'cust-sevres',
      lines: [
        {
          label: 'Entretien annuel chaudières — bâtiments municipaux',
          category: 'labor',
          qty: 1,
          unitPriceHT: 62500,
          vatRate: 20,
        },
      ],
    });
    if (sevresMaintenance.ok) await this.sendQuoteInternal(sevresMaintenance.value.quoteId);

    // ── Devis SIGNÉ avec acompte prévu, PAS ENCORE FACTURÉ (ASK-2) : la vraie décision
    // « acompte ou solde ? » devient exerçable en démo — Bob pose la question au lieu de
    // trancher en silence. Boulangerie Lefèvre : rénovation du fournil, acompte 40 %.
    const lefevre = await this.createQuoteInternal({
      customerId: 'cust-lefevre',
      depositPct: 40,
      lines: [
        {
          label: 'Rénovation plomberie du fournil',
          category: 'labor',
          qty: 1,
          unitPriceHT: 210000,
          vatRate: 10,
        },
        {
          label: 'Fournitures cuivre et raccords',
          category: 'supply',
          qty: 1,
          unitPriceHT: 65000,
          vatRate: 10,
        },
      ],
    });
    if (lefevre.ok) {
      await this.sendQuoteInternal(lefevre.value.quoteId);
      await this.signQuoteInternal({
        quoteId: lefevre.value.quoteId,
        signerName: 'Boulangerie Lefèvre',
      });
    }
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
      issuedAt: i.issuedAt,
      paid: i.paid,
    };
  }

  /** Digest démo : calculé sur les DONNÉES LOCALES réelles (paiements/factures du seed et de la
   *  session) via buildValueDigest — même moteur que le serveur. Fenêtre = 7 jours glissants
   *  (la sémantique semaine-ISO-Paris vit côté serveur ; l'écart est assumé pour la démo).
   *  Attribution conservatrice : AUCUN overdue_recovered en local (pas d'historique de relances
   *  livré fiable — jamais un recouvrement inventé). */
  async latestValueDigest(): Promise<Result<ValueDigestView, AppError>> {
    const now = Date.now();
    const periodStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = new Date(now).toISOString();
    const payments = await this.payments.listByCompany(this.companyId);
    const invoices = await this.invoices.listByCompany(this.companyId);
    const events: ValueEvent[] = [
      ...payments.map((payment) => ({
        kind: 'payment_collected' as const,
        at: payment.receivedAt,
        amountCents: payment.amount,
      })),
      ...invoices
        .filter((invoice) => invoice.issuedAt !== null && invoice.status !== 'cancelled')
        .map((invoice) => ({ kind: 'document_created' as const, at: invoice.issuedAt as string })),
    ];
    const digest = buildValueDigest({ periodStart, periodEnd, events });
    return ok({ digest, periodStart, periodEnd, isoWeek: periodStart.slice(0, 10) });
  }

  /** Démo hors-ligne : AUCUN essai (early-access, aligné getSubscription) — trial null, la
   *  carte bilan ne se rend pas. Jamais un essai fantôme inventé pour la démo. */
  async trialReport(): Promise<Result<TrialReportView, AppError>> {
    return ok({ digest: null, periodStart: null, periodEnd: null, trial: null });
  }

  /** Démo hors-ligne : aucune analytics locale (adapter Noop structurel) — ack immédiat. */
  async recordValueDigestOpened(): Promise<Result<{ recorded: boolean }, AppError>> {
    return ok({ recorded: true });
  }

  async getSubscription(): Promise<Result<SubscriptionView, AppError>> {
    return ok({
      tier: 'business',
      status: 'active',
      // C26b — early-access aligné sur le serveur : aucun billing, 0 € facturé (même vérité que le seed).
      earlyAccess: true,
      priceCents: 0,
      store: 'none',
      billingAvailable: false,
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

  async listSubscriptionInvoices(): Promise<Result<[], AppError>> {
    return ok([]);
  }

  async startCheckout(tier: PlanTier): Promise<Result<{ url: string }, AppError>> {
    // Démo hors-ligne : pas de passerelle de paiement, on renvoie une URL de démonstration.
    return ok({ url: `https://demo.bobpro.fr/abo/${tier}` });
  }

  async billingPortal(): Promise<Result<{ url: string }, AppError>> {
    return ok({ url: 'https://demo.bobpro.fr/portail' });
  }

  /**
   * DELETE /account (démo hors-ligne, Apple 5.1.1(v)) — MÊME use case @bob/core que le serveur
   * (CloseAccount) : closedAt posé, liens de signature publics révoqués. Aucune identité
   * Supabase à supprimer en local (pas de session réelle) — le signOut() mobile fait le reste.
   */
  async closeAccount(input: {
    confirmationText: string;
    reason?: string;
  }): Promise<Result<{ closedAt: string }, AppError>> {
    const r = await new CloseAccount({
      companies: this.companies,
      subscriptions: this.subscriptionRepository,
      publicAccessTokens: this.publicAccessTokens,
    }).execute({
      companyId: this.companyId,
      confirmationText: input.confirmationText,
      reason: input.reason?.trim() || null,
      now: this.clock.now(),
    });
    if (!r.ok) return r;
    return ok({ closedAt: r.value.closedAt });
  }

  async invoicePaymentLink(invoiceId: string): Promise<Result<{ url: string }, AppError>> {
    return ok({ url: `https://demo.bobpro.fr/pay/${invoiceId}` });
  }

  async getProfile(): Promise<Result<TradeConfig, AppError>> {
    return ok(resolveTradeConfig(seedCompany().trade, 'business'));
  }

  /** GET /fiscal-profile (BOB EXPERT FISCAL, Phase 1A) — MÊME use case @bob/core que le serveur :
   *  dérivé par hypothèses depuis la fiche société du seed si absent, puis persisté en mémoire. */
  async getFiscalProfile(): Promise<Result<FiscalProfileView, AppError>> {
    const company = seedCompany();
    return new GetFiscalProfile({ fiscalProfiles: this.fiscalProfileRepository }).execute({
      company: { id: this.companyId, legalForm: company.legalForm, trade: company.trade },
      now: this.clock.now(),
    });
  }

  /** PATCH /fiscal-profile/:field (démo) — mêmes règles de validation/invariants que le serveur. */
  async updateFiscalProfileField(
    field: string,
    value: unknown,
  ): Promise<Result<FiscalProfileView, AppError>> {
    const parsed = parseFiscalProfileFieldPatch(field, value);
    if (!parsed.ok) return parsed;
    const company = seedCompany();
    return new UpdateFiscalProfileField({ fiscalProfiles: this.fiscalProfileRepository }).execute({
      company: { id: this.companyId, legalForm: company.legalForm, trade: company.trade },
      patch: parsed.value,
      now: this.clock.now(),
      source: 'user_form',
    });
  }

  /** GET /company/me (adaptateur de test) — relit le repository, jamais une nouvelle fixture. */
  async getCompanyMe(): Promise<Result<CompanyProps, AppError>> {
    const company = await this.companies.findById(this.companyId);
    return company === null ? err(appNotFound('company', this.companyId)) : ok(company.toProps());
  }

  async updateCompanyProfile(input: {
    trade: Trade;
    vatRegime: VatRegime;
    customerPortfolio?: CustomerPortfolio;
  }): Promise<Result<CompanyProps, AppError>> {
    const current = await this.companies.findById(this.companyId);
    if (current === null) return err(appNotFound('company', this.companyId));
    const updated = Company.of({ ...current.toProps(), ...input });
    if (!updated.ok) return err(appDomain(updated.error));
    await this.companies.save(updated.value);
    return ok(updated.value.toProps());
  }

  /** Adaptateur local (démo) — mêmes règles que le serveur (PATCH /company/billing). */
  async updateCompanyBilling(input: {
    iban?: string | null;
    bic?: string | null;
  }): Promise<Result<CompanyProps, AppError>> {
    const current = await this.companies.findById(this.companyId);
    if (current === null) return err(appNotFound('company', this.companyId));
    const props = current.toProps();
    const { iban: currentIban, bic: currentBic, ...requiredProps } = props;
    const updated = Company.of({
      ...requiredProps,
      ...(input.iban === undefined
        ? currentIban === undefined
          ? {}
          : { iban: currentIban }
        : input.iban === null
          ? {}
          : { iban: input.iban }),
      ...(input.bic === undefined
        ? currentBic === undefined
          ? {}
          : { bic: currentBic }
        : input.bic === null
          ? {}
          : { bic: input.bic }),
    });
    if (!updated.ok) return err(appDomain(updated.error));
    await this.companies.save(updated.value);
    return ok(updated.value.toProps());
  }

  async getCompanyBillingSettings(): Promise<Result<CompanyBillingSettings, AppError>> {
    return ok({ ...this.billingSettings });
  }

  async updateCompanyBillingSettings(input: {
    expectedRevision: number;
    patch: CompanyBillingSettingsPatch;
  }): Promise<Result<CompanyBillingSettings, AppError>> {
    if (input.expectedRevision !== this.billingSettings.revision) {
      return err(appConflict('company_billing_settings', 'stale_revision'));
    }
    this.billingSettings = {
      ...this.billingSettings,
      ...input.patch,
      revision: this.billingSettings.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    return ok({ ...this.billingSettings });
  }

  /** C-EXP5b (adaptateur démo) : MÊMES règles que le serveur — deriveFiscalCalendar sur la fiche
   * société du seed, fenêtre 90 j, fiscalYearEnd/périodicité URSSAF inconnus comme en prod
   * (le use case émet ces échéances en 'assumed', honnête). */
  async getFiscalCalendar(): Promise<Result<FiscalDeadline[], AppError>> {
    const company = seedCompany();
    return ok(
      deriveFiscalCalendar({
        company: {
          legalForm: company.legalForm,
          vatRegime: company.vatRegime,
          dateCreation: company.dateCreation ?? null,
        },
        asOf: this.clock.today(),
        horizonDays: 90,
        fiscalYearEnd: null,
        urssafPeriodicity: null,
      }),
    );
  }

  async lookupCompany(siret: string): Promise<Result<CompanyLookupResult, AppError>> {
    return new AutofillCompanyFromSiret({ lookup: this.companyLookup }).execute({ siret });
  }

  /** C24b (adaptateur démo) : pas de provisioning Supabase hors-ligne — met à jour la société
   * seedée et renvoie SON id (parité de contrat avec le serveur : l'id vient TOUJOURS du serveur). */
  async registerCompany(
    input: Omit<CompanyProps, 'id'>,
  ): Promise<Result<{ companyId: string }, AppError>> {
    const r = Company.of({ id: this.companyId, ...input });
    if (!r.ok) return err(appDomain(r.error));
    await this.companies.save(r.value);
    return ok({ companyId: this.companyId });
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

  async synthesizeSpeech(_input: {
    text: string;
  }): Promise<Result<VoiceSynthesisResult, AppError>> {
    return ok({ audioBase64: null, mimeType: null, model: 'native' });
  }

  async voiceConfig(): Promise<Result<VoiceConfig, AppError>> {
    return ok({ cloudAvailable: false, ttsCloudAvailable: false });
  }

  async realtimeVoiceConfig(): Promise<Result<RealtimeVoiceConfig, AppError>> {
    return ok({
      available: false,
      availabilityReason: 'disabled',
      transport: 'webrtc',
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      configVersion: 'bob-live-webrtc-v1',
      requiresDevelopmentBuild: true,
      maxSessionSeconds: 900,
      speechDelivery: 'audited-signed-url-v1',
    });
  }

  async createRealtimeVoiceCall(
    _input: RealtimeVoiceCallInput,
    _signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceCall, AppError>> {
    return { ok: false, error: appForbidden('Bob Live nécessite le backend sécurisé.') };
  }

  async hangupRealtimeVoiceCall(
    _sessionHandle: string,
    _signal?: AbortSignal,
  ): Promise<Result<{ ended: true }, AppError>> {
    return ok({ ended: true });
  }

  async updateRealtimeVoiceContext(
    _sessionHandle: string,
    _input: RealtimeVoiceContextUpdate,
    _signal?: AbortSignal,
  ): Promise<Result<{ revision: number; contextDigest: string }, AppError>> {
    return { ok: false, error: appForbidden('Bob Live nécessite le backend sécurisé.') };
  }

  async acknowledgeRealtimeVoiceControl(
    _sessionHandle: string,
    _input: RealtimeVoiceControlReference,
    _signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceControlAcknowledgement, AppError>> {
    return {
      ok: false,
      error: appForbidden('Les contrôles Bob Live exigent l’autorité du backend.'),
    };
  }

  async getNextRealtimeVoiceSpeech(
    _sessionHandle: string,
    _input: RealtimeVoiceSpeechFeedInput,
    _signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceSpeechFeed, AppError>> {
    return {
      ok: false,
      error: appForbidden('La voix auditée Bob Live exige le backend sécurisé.'),
    };
  }

  async acknowledgeRealtimeVoiceSpeechDelivery(
    _sessionHandle: string,
    _turnId: string,
    _artifactId: string,
    _input: RealtimeVoiceSpeechDeliveryInput,
    _signal?: AbortSignal,
  ): Promise<Result<RealtimeVoiceSpeechDeliveryAcknowledgement, AppError>> {
    return {
      ok: false,
      error: appForbidden('La livraison vocale Bob Live exige le backend sécurisé.'),
    };
  }

  async cancelRealtimeVoiceSpeech(
    _sessionHandle: string,
    _turnId: string,
    _artifactId: string,
    _input: RealtimeVoiceSpeechCancellationInput,
    _signal?: AbortSignal,
  ): Promise<Result<void, AppError>> {
    return {
      ok: false,
      error: appForbidden('L’annulation vocale Bob Live exige le backend sécurisé.'),
    };
  }

  async listDocuments(
    input: ListDocumentsClientInput = {},
  ): Promise<Result<DocumentListItemView[], AppError>> {
    return ok(
      this.documents
        .filter((d) => input.includeDeleted === true || d.status === 'active')
        .filter((d) => (input.kind !== undefined ? d.kind === input.kind : true))
        .filter((d) =>
          input.linkedEntityType !== undefined
            ? d.linkedEntityType === input.linkedEntityType
            : true,
        )
        .filter((d) =>
          input.linkedEntityId !== undefined ? d.linkedEntityId === input.linkedEntityId : true,
        )
        .filter((d) => (input.folderId !== undefined ? d.folderId === input.folderId : true))
        .map((document) => {
          // Parité serveur : résumés issus du SEUL cache local d'analyses (peuplé par
          // analyzeDocument), liés à la version courante de l'original — jamais inventés.
          const cached = this.documentAnalyses.get(document.id);
          const analysis =
            cached && cached.documentVersion === document.version && cached.sourceSha256 === document.sha256
              ? cached
              : null;
          return {
            ...cloneDocumentView(document),
            analysis: analysis ? documentAnalysisSummaryView(analysis) : null,
            extraction: analysis ? documentExtractionSummaryView(analysis) : null,
          };
        }),
    );
  }

  /** PUT /documents/:id/name (parité serveur RenameDocument) : libellé validé par le domaine, révision optimiste. */
  async renameDocument(input: RenameDocumentClientInput): Promise<Result<DocumentView, AppError>> {
    const documentIndex = this.documents.findIndex(
      (candidate) => candidate.id === input.documentId && candidate.status === 'active',
    );
    const document = this.documents[documentIndex];
    if (!document) return err(appNotFound('document', input.documentId));
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision document invalide.' }],
      });
    }
    if (document.revision !== input.expectedRevision) {
      return err(appConflict('document', 'Le document a été modifié. Recharge avant de renommer.'));
    }
    const validated = validateDocumentDisplayName(input.displayName);
    if (!validated.ok) {
      return err({
        kind: 'validation',
        issues: [{ field: 'displayName', message: validated.error.code === 'VALIDATION' ? validated.error.message : 'Nom d’affichage invalide.' }],
      });
    }
    if (document.displayName === validated.value) return ok(cloneDocumentView(document));
    const renamed: DocumentView = {
      ...document,
      displayName: validated.value,
      revision: document.revision + 1,
      tags: [...document.tags],
    };
    this.documents[documentIndex] = renamed;
    return ok(cloneDocumentView(renamed));
  }

  async getDocument(documentId: string): Promise<Result<DocumentView, AppError>> {
    const document = this.documents.find(
      (candidate) => candidate.id === documentId && candidate.status === 'active',
    );
    return document ? ok(cloneDocumentView(document)) : err(appNotFound('document', documentId));
  }

  async uploadDocument(input: UploadDocumentClientInput): Promise<Result<DocumentView, AppError>> {
    const decoded = decodeBase64Document(input.contentBase64);
    if (!decoded.ok) {
      const message =
        decoded.reason === 'too_large'
          ? 'Document trop volumineux (10 Mo maximum).'
          : decoded.reason === 'empty'
            ? 'Document vide.'
            : 'Base64 invalide.';
      return err({ kind: 'validation', issues: [{ field: 'contentBase64', message }] });
    }
    const filename =
      typeof input.filename === 'string' ? input.filename.replace(/\s+/g, ' ').trim() : '';
    const mimeType =
      typeof input.mimeType === 'string'
        ? input.mimeType.split(';', 1)[0]!.trim().toLowerCase()
        : '';
    const unsafeFilename =
      filename.includes('/') ||
      filename.includes('\\') ||
      [...filename].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 0x1f || point === 0x7f;
      });
    const issues: { field: string; message: string }[] = [];
    if (!filename || filename.length > 180 || unsafeFilename) {
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
    } else if (!documentSignatureMatches(mimeType, decoded.bytes)) {
      issues.push({
        field: 'mimeType',
        message: 'Le contenu du fichier ne correspond pas au format annoncé.',
      });
    }
    if (issues.length > 0) return err({ kind: 'validation', issues });
    const byteSize = decoded.bytes.length;
    this.documentSeq += 1;
    const id = `local-document-${this.documentSeq}`;
    const sha256 = portableSha256Bytes(decoded.bytes);
    const storageKey = buildDocumentStorageKey({
      companyId: this.companyId,
      documentId: id,
      version: 1,
      sha256,
      filename,
      mimeType,
    });
    const today = this.clock.today();
    const documentDate = input.documentDate ?? null;
    const view: DocumentView = {
      id,
      companyId: this.companyId,
      kind: input.kind ?? 'other',
      origin: 'uploaded',
      status: 'active',
      filename,
      displayName: localDefaultDisplayName(filename),
      mimeType,
      byteSize,
      sha256,
      storageKey,
      folderId: input.folderId ?? null,
      revision: 1,
      version: 1,
      linkedEntityType: input.linkedEntityType ?? null,
      linkedEntityId: input.linkedEntityId ?? null,
      documentDate,
      issuedAt: null,
      createdAt: this.clock.now(),
      createdBy: 'local',
      retentionUntil: addYears(documentDate ?? today, 10),
      tags: [
        ...new Set(
          (input.tags ?? [])
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length >= 2 && t.length <= 32),
        ),
      ].slice(0, 16),
    };
    this.documents.unshift(view);
    this.documentContents.set(id, { contentBase64: decoded.contentBase64, mimeType });
    return ok(cloneDocumentView(view));
  }

  async createDocumentIntake(
    input: CreateDocumentIntakeClientInput,
  ): Promise<Result<DocumentView, AppError>> {
    const key = input.idempotencyKey.trim();
    if (key.length < 8 || key.length > 160) {
      return err({
        kind: 'validation',
        issues: [{ field: 'idempotencyKey', message: 'Clé d’idempotence invalide.' }],
      });
    }
    const decoded = decodeBase64Document(input.contentBase64);
    if (!decoded.ok) {
      const message =
        decoded.reason === 'too_large'
          ? 'Document trop volumineux (10 Mo maximum).'
          : decoded.reason === 'empty'
            ? 'Document vide.'
            : 'Base64 invalide.';
      return err({ kind: 'validation', issues: [{ field: 'contentBase64', message }] });
    }
    const mimeType =
      typeof input.mimeType === 'string'
        ? input.mimeType.split(';', 1)[0]!.trim().toLowerCase()
        : '';
    const sha256 = portableSha256Bytes(decoded.bytes);
    const previous = this.documentIntakes.get(key);
    if (previous) {
      if (previous.sha256 !== sha256 || previous.mimeType !== mimeType) {
        return err({
          kind: 'conflict',
          entity: 'document_intake',
          reason: 'idempotency_key_reused',
        });
      }
      const existing = this.documents.find((document) => document.id === previous.documentId);
      return existing
        ? ok(cloneDocumentView(existing))
        : err(appNotFound('document', previous.documentId));
    }
    const archived = await this.uploadDocument({
      contentBase64: input.contentBase64,
      mimeType: input.mimeType,
      filename: input.filename,
      kind: 'other',
      folderId: null,
    });
    if (!archived.ok) return archived;
    const archivedIndex = this.documents.findIndex((document) => document.id === archived.value.id);
    if (archivedIndex < 0) return err(appNotFound('document', archived.value.id));
    const archivedDocument = this.documents[archivedIndex]!;
    const intakeDocument: DocumentView = {
      ...archivedDocument,
      origin: 'ocr',
      tags: [...archivedDocument.tags],
    };
    this.documents[archivedIndex] = intakeDocument;
    this.documentIntakes.set(key, {
      documentId: intakeDocument.id,
      sha256,
      mimeType,
    });
    return ok(cloneDocumentView(intakeDocument));
  }

  async listDocumentFolders(
    input: ListDocumentFoldersClientInput = {},
  ): Promise<Result<DocumentFolderPageView, AppError>> {
    const parentId = input.parentId ?? null;
    const limit = input.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return err({
        kind: 'validation',
        issues: [{ field: 'limit', message: 'Pagination invalide.' }],
      });
    }
    const sorted = this.documentFolders
      .filter((folder) => folder.status === 'active' && folder.parentId === parentId)
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName) || a.id.localeCompare(b.id));
    const start = input.cursor
      ? Math.max(0, sorted.findIndex((folder) => folder.id === input.cursor) + 1)
      : 0;
    const page = sorted.slice(start, start + limit + 1);
    const items = page.slice(0, limit).map((folder) => ({ ...folder }));
    return ok({ items, nextCursor: page.length > limit ? (items.at(-1)?.id ?? null) : null });
  }

  async getDocumentFolder(folderId: string): Promise<Result<DocumentFolderView, AppError>> {
    const folder = this.documentFolders.find(
      (candidate) => candidate.id === folderId && candidate.status === 'active',
    );
    return folder ? ok({ ...folder }) : err(appNotFound('document_folder', folderId));
  }

  async createDocumentFolder(input: {
    name: string;
    parentId?: string | null;
  }): Promise<Result<DocumentFolderView, AppError>> {
    const validatedName = validateDocumentFolderName(input.name);
    if (!validatedName.ok) {
      return err({
        kind: 'validation',
        issues: [{ field: 'name', message: 'Nom de dossier invalide.' }],
      });
    }
    const { name, normalizedName } = validatedName.value;
    const parentId = input.parentId ?? null;
    if (
      parentId &&
      !this.documentFolders.some((folder) => folder.id === parentId && folder.status === 'active')
    ) {
      return err(appNotFound('document_folder', parentId));
    }
    if (
      this.documentFolders.some(
        (folder) =>
          folder.status === 'active' &&
          folder.parentId === parentId &&
          folder.normalizedName === normalizedName,
      )
    ) {
      return err(
        appConflict('document_folder', 'Un dossier de même nom existe déjà à cet emplacement.'),
      );
    }
    const now = this.clock.now();
    const folder: DocumentFolderView = {
      id: this.ids.newId(),
      companyId: this.companyId,
      parentId,
      name,
      normalizedName,
      systemKey: null,
      status: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.documentFolders.push(folder);
    return ok({ ...folder });
  }

  async updateDocumentFolder(input: {
    folderId: string;
    expectedRevision: number;
    name?: string;
    parentId?: string | null;
  }): Promise<Result<DocumentFolderView, AppError>> {
    const folder = this.documentFolders.find(
      (candidate) => candidate.id === input.folderId && candidate.status === 'active',
    );
    if (!folder) return err(appNotFound('document_folder', input.folderId));
    if (folder.revision !== input.expectedRevision)
      return err(appConflict('document_folder', 'Le dossier a été modifié.'));
    const changes = Number(input.name !== undefined) + Number(input.parentId !== undefined);
    if (changes !== 1) {
      return err({
        kind: 'validation',
        issues: [{ field: 'input', message: 'Une seule modification à la fois.' }],
      });
    }
    if (input.name !== undefined) {
      const validatedName = validateDocumentFolderName(input.name);
      if (!validatedName.ok) {
        return err({
          kind: 'validation',
          issues: [{ field: 'name', message: 'Nom de dossier invalide.' }],
        });
      }
      const { name, normalizedName } = validatedName.value;
      const duplicate = this.documentFolders.some(
        (candidate) =>
          candidate.id !== folder.id &&
          candidate.status === 'active' &&
          candidate.parentId === folder.parentId &&
          candidate.normalizedName === normalizedName,
      );
      if (duplicate)
        return err(appConflict('document_folder', 'Un dossier de même nom existe déjà.'));
      folder.name = name;
      folder.normalizedName = normalizedName;
    } else {
      const parentId = input.parentId ?? null;
      if (parentId === folder.id) {
        return err({
          kind: 'validation',
          issues: [{ field: 'parentId', message: 'Cycle de dossiers interdit.' }],
        });
      }
      let cursor = parentId;
      let depth = 1;
      while (cursor) {
        if (cursor === folder.id) {
          return err({
            kind: 'validation',
            issues: [{ field: 'parentId', message: 'Cycle de dossiers interdit.' }],
          });
        }
        const parent = this.documentFolders.find(
          (candidate) => candidate.id === cursor && candidate.status === 'active',
        );
        if (!parent) return err(appNotFound('document_folder', cursor));
        cursor = parent.parentId;
        depth += 1;
        if (depth > 8) {
          return err({
            kind: 'validation',
            issues: [{ field: 'parentId', message: 'Profondeur maximale atteinte.' }],
          });
        }
      }
      folder.parentId = parentId;
    }
    folder.revision += 1;
    folder.updatedAt = this.clock.now();
    return ok({ ...folder });
  }

  async previewDocumentFolderDeletion(
    folderId: string,
  ): Promise<Result<DocumentFolderDeletionPlanView, AppError>> {
    const folder = this.documentFolders.find(
      (candidate) => candidate.id === folderId && candidate.status === 'active',
    );
    if (!folder) return err(appNotFound('document_folder', folderId));
    if (folder.systemKey !== null) {
      return err(appForbidden('Les dossiers système peuvent être renommés, mais pas supprimés.'));
    }
    const subtree: DocumentFolderView[] = [];
    const pending = [folder.id];
    while (pending.length > 0) {
      const currentId = pending.shift()!;
      const current = this.documentFolders.find(
        (candidate) => candidate.id === currentId && candidate.status === 'active',
      );
      if (!current) continue;
      subtree.push(current);
      pending.push(
        ...this.documentFolders
          .filter((candidate) => candidate.status === 'active' && candidate.parentId === current.id)
          .map((candidate) => candidate.id),
      );
    }
    const folderIds = new Set(subtree.map((candidate) => candidate.id));
    const documents = this.documents.filter(
      (document) =>
        document.status === 'active' &&
        document.folderId !== null &&
        folderIds.has(document.folderId),
    );
    const planId = `folder-delete-${this.ids.newId()}`;
    const expiresAt = new Date(Date.parse(this.clock.now()) + 5 * 60_000).toISOString();
    this.documentFolderDeletionPlans.set(planId, {
      id: planId,
      companyId: this.companyId,
      folderId: folder.id,
      expectedRevision: folder.revision,
      snapshot: {
        folders: subtree
          .map((candidate) => ({
            id: candidate.id,
            parentId: candidate.parentId,
            revision: candidate.revision,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        documents: documents
          .map((document) => ({
            id: document.id,
            folderId: document.folderId,
            revision: document.revision,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      },
      expiresAt,
      consumed: false,
    });
    const directChildren = subtree.filter((candidate) => candidate.parentId === folder.id);
    const directDocuments = documents.filter((document) => document.folderId === folder.id);
    return ok({
      planId,
      expiresAt,
      folder: {
        id: folder.id,
        parentId: folder.parentId,
        name: folder.name,
        systemKey: folder.systemKey,
      },
      directChildCount: directChildren.length,
      descendantFolderCount: Math.max(0, subtree.length - 1),
      directDocumentCount: directDocuments.length,
      documentCount: documents.length,
      canDeleteEmpty: subtree.length === 1 && documents.length === 0,
    });
  }

  async executeDocumentFolderDeletion(input: {
    planId: string;
    strategy: DeleteDocumentFolderStrategy;
  }): Promise<Result<DocumentFolderDeletionExecutionView, AppError>> {
    const plan = this.documentFolderDeletionPlans.get(input.planId);
    if (
      !plan ||
      plan.companyId !== this.companyId ||
      plan.consumed ||
      Date.parse(plan.expiresAt) <= Date.parse(this.clock.now())
    ) {
      return err(
        appConflict(
          'document_folder_deletion_plan',
          'Cette confirmation a expiré ou a déjà été utilisée.',
        ),
      );
    }
    plan.consumed = true;
    const folder = this.documentFolders.find(
      (candidate) => candidate.id === plan.folderId && candidate.status === 'active',
    );
    if (!folder || folder.systemKey !== null || folder.revision !== plan.expectedRevision) {
      return err(appConflict('document_folder', 'Le dossier a changé. Recrée un aperçu.'));
    }
    const currentSubtree: DocumentFolderView[] = [];
    const pendingFolderIds = [folder.id];
    const visitedFolderIds = new Set<string>();
    while (pendingFolderIds.length > 0) {
      const currentId = pendingFolderIds.shift()!;
      if (visitedFolderIds.has(currentId)) continue;
      visitedFolderIds.add(currentId);
      const current = this.documentFolders.find(
        (candidate) => candidate.id === currentId && candidate.status === 'active',
      );
      if (!current) continue;
      currentSubtree.push(current);
      pendingFolderIds.push(
        ...this.documentFolders
          .filter((candidate) => candidate.status === 'active' && candidate.parentId === current.id)
          .map((candidate) => candidate.id),
      );
    }
    const currentFolderIds = new Set(currentSubtree.map((candidate) => candidate.id));
    const snapshotNow = {
      folders: currentSubtree
        .map((candidate) => ({
          id: candidate.id,
          parentId: candidate.parentId,
          revision: candidate.revision,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      documents: this.documents
        .filter(
          (document) =>
            document.status === 'active' &&
            document.folderId !== null &&
            currentFolderIds.has(document.folderId),
        )
        .map((document) => ({
          id: document.id,
          folderId: document.folderId,
          revision: document.revision,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
    if (JSON.stringify(snapshotNow) !== JSON.stringify(plan.snapshot)) {
      return err(
        appConflict('document_folder', 'Le contenu du dossier a changé. Recrée un aperçu.'),
      );
    }
    const directChildren = this.documentFolders.filter(
      (candidate) => candidate.status === 'active' && candidate.parentId === folder.id,
    );
    const directDocuments = this.documents.filter(
      (document) => document.status === 'active' && document.folderId === folder.id,
    );
    if (input.strategy.kind === 'empty') {
      if (directChildren.length > 0 || directDocuments.length > 0) {
        return err(
          appConflict('document_folder', 'Le dossier n’est pas vide. Choisis un transfert.'),
        );
      }
    } else {
      const targetFolderId = input.strategy.targetFolderId;
      const target = this.documentFolders.find(
        (candidate) => candidate.id === targetFolderId && candidate.status === 'active',
      );
      if (!target) return err(appNotFound('document_folder', targetFolderId));
      if (target.revision !== input.strategy.targetExpectedRevision) {
        return err(appConflict('document_folder', 'Le dossier de destination a changé.'));
      }
      if (plan.snapshot.folders.some((candidate) => candidate.id === target.id)) {
        return err({
          kind: 'validation',
          issues: [{ field: 'targetFolderId', message: 'Destination invalide.' }],
        });
      }
      const targetChildNames = new Set(
        this.documentFolders
          .filter((candidate) => candidate.status === 'active' && candidate.parentId === target.id)
          .map((candidate) => candidate.normalizedName),
      );
      if (directChildren.some((child) => targetChildNames.has(child.normalizedName))) {
        return err(
          appConflict('document_folder', 'Un sous-dossier de même nom existe dans la destination.'),
        );
      }
      for (const child of directChildren) {
        child.parentId = target.id;
        child.revision += 1;
        child.updatedAt = this.clock.now();
      }
      for (const document of directDocuments) {
        document.folderId = target.id;
        document.revision += 1;
      }
    }
    folder.status = 'deleted';
    folder.deletedAt = this.clock.now();
    folder.updatedAt = this.clock.now();
    folder.revision += 1;
    return ok({
      folderId: folder.id,
      transferredDocuments: input.strategy.kind === 'transfer' ? directDocuments.length : 0,
      transferredChildren: input.strategy.kind === 'transfer' ? directChildren.length : 0,
    });
  }

  async moveDocumentToFolder(input: {
    documentId: string;
    folderId: string | null;
    expectedRevision: number;
  }): Promise<Result<{ documentId: string; folderId: string | null; revision: number }, AppError>> {
    const documentIndex = this.documents.findIndex(
      (candidate) => candidate.id === input.documentId && candidate.status === 'active',
    );
    const document = this.documents[documentIndex];
    if (!document) return err(appNotFound('document', input.documentId));
    if (document.revision !== input.expectedRevision)
      return err(appConflict('document', 'Le document a été modifié.'));
    if (
      input.folderId !== null &&
      !this.documentFolders.some(
        (folder) => folder.id === input.folderId && folder.status === 'active',
      )
    ) {
      return err(appNotFound('document_folder', input.folderId));
    }
    if (document.folderId !== input.folderId) {
      const moved: DocumentView = {
        ...document,
        folderId: input.folderId,
        revision: document.revision + 1,
        tags: [...document.tags],
      };
      this.documents[documentIndex] = moved;
      return ok({ documentId: moved.id, folderId: moved.folderId, revision: moved.revision });
    }
    return ok({
      documentId: document.id,
      folderId: document.folderId,
      revision: document.revision,
    });
  }

  async analyzeDocument(documentId: string): Promise<Result<DocumentAnalysis, AppError>> {
    const document = this.documents.find(
      (candidate) => candidate.id === documentId && candidate.status === 'active',
    );
    if (!document) return err(appNotFound('document', documentId));
    const content = this.documentContents.get(documentId);
    const lower = document.filename.toLowerCase();
    const purchaseLike = /facture|ticket|recu|reçu/.test(lower);
    let draft: Parameters<typeof makeDocumentAnalysis>[0];
    if (purchaseLike && content) {
      const extracted = await this.ocr.extractDocument({
        contentBase64: content.contentBase64,
        mimeType: content.mimeType,
      });
      if (extracted.ok) {
        const evidence = [
          { page: 1, excerpt: extracted.value.rawText.slice(0, 160), boundingBox: null },
        ];
        draft = {
          type: /ticket|recu|reçu/.test(lower) ? 'receipt' : 'supplier_invoice',
          typeConfidence: extracted.value.confidence,
          summary: `Pièce d’achat de ${extracted.value.supplierName}, datée du ${extracted.value.documentDate}.`,
          facts: [
            {
              key: 'supplier_name',
              valueType: 'text',
              value: extracted.value.supplierName,
              confidence: extracted.value.confidence,
              provenance: { source: 'document_text', evidence, derivedFrom: [], rule: null },
            },
            {
              key: 'document_date',
              valueType: 'date',
              value: extracted.value.documentDate,
              confidence: extracted.value.confidence,
              provenance: { source: 'document_text', evidence, derivedFrom: [], rule: null },
            },
            {
              key: 'total_ttc',
              valueType: 'money',
              value: {
                amountMinor: extracted.value.totalTtcCents,
                currency: extracted.value.currency,
              },
              confidence: extracted.value.confidence,
              provenance: { source: 'document_text', evidence, derivedFrom: [], rule: null },
            },
            ...(extracted.value.vatCents !== null
              ? [
                  {
                    key: 'vat_amount' as const,
                    valueType: 'money' as const,
                    value: {
                      amountMinor: extracted.value.vatCents,
                      currency: extracted.value.currency,
                    },
                    confidence: extracted.value.confidence,
                    provenance: {
                      source: 'document_text' as const,
                      evidence,
                      derivedFrom: [],
                      rule: null,
                    },
                  },
                ]
              : []),
          ],
          suggestedTags: extracted.value.suggestedTags,
          suggestedFilename: extracted.value.suggestedFilename,
          warnings:
            extracted.value.confidence < 0.75 ? ['Certains champs doivent être confirmés.'] : [],
        };
      } else {
        draft = {
          type: 'other',
          typeConfidence: 0.2,
          summary: 'Bob a conservé le document, mais sa nature reste à confirmer.',
          facts: [],
          suggestedTags: ['a-classer'],
          suggestedFilename: document.filename,
          warnings: ['Analyse locale incomplète.'],
        };
      }
    } else {
      draft = {
        type: 'other',
        typeConfidence: 0.3,
        summary: 'Bob a conservé le document. Confirme sa nature et son dossier de destination.',
        facts: [],
        suggestedTags: ['a-classer'],
        suggestedFilename: document.filename,
        warnings: ['Mode local : classification manuelle recommandée.'],
      };
    }
    const analysis = makeDocumentAnalysis(draft, {
      documentId,
      documentVersion: document.version,
      sourceSha256: document.sha256,
      originalFilename: document.filename,
      analyzerVersion: 'bob-document-intelligence-2026-07-18.1:local',
      analyzedAt: this.clock.now(),
    });
    if (!analysis.ok) return err(appDomain(analysis.error));
    // Parité du cache persistant serveur : la liste des documents peut ensuite embarquer le
    // résumé sans relancer d'analyse.
    this.documentAnalyses.set(documentId, analysis.value);
    return ok(analysis.value);
  }

  async classifyDocument(
    input: ClassifyDocumentClientInput,
  ): Promise<Result<DocumentView, AppError>> {
    const documentIndex = this.documents.findIndex(
      (d) => d.id === input.documentId && d.status === 'active',
    );
    const document = this.documents[documentIndex];
    if (!document) return err(appNotFound('document', input.documentId));
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision document invalide.' }],
      });
    }
    if (document.revision !== input.expectedRevision) {
      return err(
        appConflict(
          'document',
          'Le document a été modifié. Recharge avant de confirmer le rattachement.',
        ),
      );
    }
    if (typeof input.linkedEntityId !== 'string' || !input.linkedEntityId.trim())
      return err({
        kind: 'validation',
        issues: [{ field: 'linkedEntityId', message: 'Rattachement métier incomplet.' }],
      });
    const classified: DocumentView = {
      ...document,
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId.trim(),
      revision: document.revision + 1,
      tags: [...document.tags],
    };
    this.documents[documentIndex] = classified;
    return ok(cloneDocumentView(classified));
  }

  async documentDownloadUrl(
    documentId: string,
    ttlSeconds = 300,
  ): Promise<Result<DocumentDownloadUrl, AppError>> {
    const document = this.documents.find((d) => d.id === documentId && d.status === 'active');
    if (!document) return err(appNotFound('document', documentId));
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3_600) {
      return err({
        kind: 'validation',
        issues: [{ field: 'ttlSeconds', message: 'Durée du lien invalide.' }],
      });
    }
    const content = this.documentContents.get(documentId);
    if (!content) {
      return err({ kind: 'dependency', port: 'document-storage', cause: 'Original local absent.' });
    }
    return ok({
      url: `data:${content.mimeType};base64,${content.contentBase64}`,
      expiresInSeconds: ttlSeconds,
      filename: document.filename,
      mimeType: document.mimeType,
      byteSize: document.byteSize,
      sha256: document.sha256,
    });
  }

  async getDiagnostic(): Promise<Result<DiagnosticResult, AppError>> {
    await this.ready;
    const company = seedCompany();
    const types = [...new Set(seedCustomers().map((c) => c.type))];
    const today = this.clock.today();
    // E6 : recettes ENCAISSÉES de l'année civile — la surveillance des seuils de
    // franchise 293 B lit du RÉEL (paiements datés), jamais un statut décoratif.
    const year = today.slice(0, 4);
    const payments = await this.payments.listByCompany(this.companyId);
    const annualEncaissedCents = payments
      .filter((p) => p.receivedAt.slice(0, 4) === year)
      .reduce((sum, p) => sum + p.amount, 0);
    return ok(
      runDiagnostic({
        country: 'FR',
        trade: company.trade,
        vatRegime: company.vatRegime,
        customerTypes: types,
        hasDecennale: company.hasValidDecennale(today),
        asOf: today,
        annualEncaissedCents,
      }),
    );
  }

  /**
   * Le diagnostic persistant exige PostgreSQL, RLS et une empreinte serveur. L'adaptateur local
   * de test échoue donc explicitement au lieu d'inventer un résultat ou une révision en mémoire.
   */
  async getDiagnosticAssessment(): Promise<Result<DiagnosticAssessmentView, AppError>> {
    return err(appUnavailable('diagnostic-assessment-persistence'));
  }

  async saveDiagnosticAssessment(
    _input: DiagnosticAssessmentWriteRequest,
  ): Promise<Result<DiagnosticAssessmentView, AppError>> {
    return err(appUnavailable('diagnostic-assessment-persistence'));
  }

  async extractDocument(input: {
    contentBase64: string;
    mimeType: string;
  }): Promise<Result<OcrExtraction, AppError>> {
    return new ExtractDocument({ ocr: this.ocr }).execute(input);
  }

  async suggestExpenseDefaults(
    input: SuggestExpenseDefaultsInput,
  ): Promise<Result<ExpenseDefaultsView, AppError>> {
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
    return new ListCustomers({
      customers: this.customers,
      invoices: this.invoices,
      payments: this.payments,
    }).execute({ companyId: this.companyId });
  }

  /** Crée une fiche client — même chemin que POST /customers côté serveur (Customer.of + save). */
  async createCustomer(
    input: CreateCustomerClientInput,
  ): Promise<Result<{ id: string }, AppError>> {
    const id = this.ids.newId();
    const r = Customer.of({ id, companyId: this.companyId, ...input });
    if (!r.ok) return err(appDomain(r.error));
    await this.customers.save(r.value);
    return ok({ id });
  }

  /** Édition post-création — même chemin que PATCH /customers/:id côté serveur. */
  async updateCustomer(
    id: string,
    input: UpdateCustomerClientInput,
  ): Promise<Result<{ id: string }, AppError>> {
    return new UpdateCustomer({ customers: this.customers }).execute({
      id,
      companyId: this.companyId,
      ...input,
    });
  }

  async getCashflow(input: {
    scenario: Scenario;
    horizon: Horizon;
  }): Promise<Result<CashflowProjection, AppError>> {
    // Position TVA RÉELLE (chantier 2) : les factures alimentent deriveVatPosition — le
    // vatDue de la fixture ne sert plus que de repli sans repo. Barrière : le seed d'abord.
    await this.ready;
    return new GetCashflow({
      snapshots: this.snapshots,
      expenses: this.expenses,
      invoices: this.invoices,
      clock: this.clock,
    }).execute({
      companyId: this.companyId,
      ...input,
    });
  }

  async getLatestBankBalance(): Promise<Result<QualifiedBankBalanceSnapshot, AppError>> {
    return err(appUnavailable('bank-balance-testing-adapter'));
  }

  async recordManualBankBalance(): Promise<Result<QualifiedBankBalanceSnapshot, AppError>> {
    return err(appUnavailable('bank-balance-testing-adapter'));
  }

  private async recordExpenseWithinLock(
    input: Omit<RecordExpenseInput, 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>> {
    const fingerprint = localExpenseCreationFingerprint(this.companyId, input);
    if (fingerprint === 'invalid') {
      return err({
        kind: 'validation',
        issues: [
          {
            field: 'idempotencyKey',
            message: "Clé d'idempotence invalide (1 à 200 caractères imprimables).",
          },
        ],
      });
    }

    if (fingerprint) {
      const published = this.expenseCreationRequests.get(fingerprint.keyHash);
      if (published) {
        if (published.payloadHash !== fingerprint.payloadHash) {
          return err(
            appConflict(
              'expense_creation',
              "Cette clé d'idempotence a déjà été utilisée pour une autre dépense.",
            ),
          );
        }
        const expense = await this.expenses.findById(published.expenseId);
        return expense && expense.companyId === this.companyId
          ? ok({ id: expense.id })
          : err({
              kind: 'dependency',
              port: 'expense-creation-idempotency',
              cause: 'La création publiée ne référence plus une dépense lisible.',
            });
      }
    }

    const expenseSnapshot = this.expenses.snapshot();
    const accountingSnapshot = this.accountingEntries.snapshot();
    try {
      const recorded = await new RecordExpense({
        expenses: this.expenses,
        ids: this.ids,
        clock: this.clock,
      }).execute({
        ...input,
        // L'identité de l'adaptateur local gagne aussi sur un objet runtime élargi.
        companyId: this.companyId,
      });
      if (!recorded.ok) return recorded;
      // Expense + journal AC forment une unité atomique locale. Un échec comptable restaure
      // les deux snapshots avant de rendre l'erreur, comme le rollback PostgreSQL.
      const accounting = await new RecordExpenseAccountingEntries({
        expenses: this.expenses,
        entries: this.accountingEntries,
        charts: this.chartOfAccounts,
      }).execute({ expenseId: recorded.value.id });
      if (!accounting.ok) {
        this.expenses.restore(expenseSnapshot);
        this.accountingEntries.restore(accountingSnapshot);
        return accounting;
      }
      if (fingerprint) {
        this.expenseCreationRequests.set(fingerprint.keyHash, {
          payloadHash: fingerprint.payloadHash,
          expenseId: recorded.value.id,
        });
      }
      return recorded;
    } catch (cause) {
      this.expenses.restore(expenseSnapshot);
      this.accountingEntries.restore(accountingSnapshot);
      throw cause;
    }
  }

  async recordExpense(
    input: Omit<RecordExpenseInput, 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>> {
    await this.ready;
    return this.withExpenseCreationLock(() => this.recordExpenseWithinLock(input));
  }

  async recordDocumentExpense(
    input: RecordDocumentExpenseClientInput,
  ): Promise<Result<RecordDocumentExpenseClientOutput, AppError>> {
    await this.ready;
    return this.withExpenseCreationLock(async () => {
      const documentIndex = this.documents.findIndex(
        (candidate) => candidate.id === input.documentId && candidate.status === 'active',
      );
      const document = this.documents[documentIndex];
      if (!document) return err(appNotFound('document', input.documentId));
      const targetFolder = this.documentFolders.find(
        (folder) => folder.id === input.targetFolderId && folder.status === 'active',
      );
      if (!targetFolder) return err(appNotFound('document_folder', input.targetFolderId));

      // DTO local volontairement reconstruit : des champs runtime surnuméraires ne peuvent
      // jamais injecter companyId, source ou une clé d'idempotence choisie par l'appelant.
      const expenseInput: Omit<RecordExpenseInput, 'companyId'> = {
        supplierName: input.expense.supplierName,
        documentDate: input.expense.documentDate,
        totalTtcCents: input.expense.totalTtcCents,
        category: input.expense.category,
        idempotencyKey: `mobile:document-expense:v1:${document.sha256}`,
        source: 'ocr',
        ...(input.expense.supplierSiren !== undefined
          ? { supplierSiren: input.expense.supplierSiren }
          : {}),
        ...(input.expense.totalHtCents !== undefined
          ? { totalHtCents: input.expense.totalHtCents }
          : {}),
        ...(input.expense.vatCents !== undefined ? { vatCents: input.expense.vatCents } : {}),
        ...(input.expense.vatRatePct !== undefined ? { vatRatePct: input.expense.vatRatePct } : {}),
        ...(input.expense.supplierInvoiceNumber !== undefined
          ? { supplierInvoiceNumber: input.expense.supplierInvoiceNumber }
          : {}),
        ...(input.expense.dueAt !== undefined ? { dueAt: input.expense.dueAt } : {}),
        // Miroir de l'autorité serveur : ticket déjà réglé → la dépense naît payée et
        // l'original archivé DEVIENT la preuve du règlement (jamais une pièce du client).
        ...(input.expense.payment
          ? {
              payment: {
                paidOn: input.expense.payment.paidOn,
                method: input.expense.payment.method,
                reference: null,
                proofDocumentId: document.id,
              },
            }
          : {}),
      };
      const fingerprint = localExpenseCreationFingerprint(this.companyId, expenseInput);
      if (!fingerprint || fingerprint === 'invalid') {
        return err({
          kind: 'dependency',
          port: 'document-expense-idempotency',
          cause: "L'identité stable de l'original n'a pas pu être calculée.",
        });
      }

      // Réponse perdue : l'état déjà lié gagne sur la révision devenue obsolète, mais uniquement
      // si le registre, la dépense, le dossier et le payload prouvent qu'il s'agit du même geste.
      if (document.linkedEntityType !== null || document.linkedEntityId !== null) {
        if (
          document.linkedEntityType !== 'expense' ||
          document.linkedEntityId === null ||
          document.folderId !== targetFolder.id
        ) {
          return err(
            appConflict('document', 'Ce document est déjà rattaché à une autre destination.'),
          );
        }
        const published = this.expenseCreationRequests.get(fingerprint.keyHash);
        if (
          !published ||
          published.payloadHash !== fingerprint.payloadHash ||
          published.expenseId !== document.linkedEntityId
        ) {
          return err(
            appConflict('expense_creation', 'La reprise ne correspond pas à la dépense déjà liée.'),
          );
        }
        const existingExpense = await this.expenses.findById(published.expenseId);
        return existingExpense && existingExpense.companyId === this.companyId
          ? ok({ expenseId: existingExpense.id, document: cloneDocumentView(document) })
          : err({
              kind: 'dependency',
              port: 'document-expense-idempotency',
              cause: 'Le document lié ne référence plus une dépense lisible.',
            });
      }

      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        return err({
          kind: 'validation',
          issues: [{ field: 'expectedRevision', message: 'Révision document invalide.' }],
        });
      }
      if (document.revision !== input.expectedRevision) {
        return err(
          appConflict('document', 'Le document a été modifié. Recharge avant de confirmer.'),
        );
      }

      const expenseSnapshot = this.expenses.snapshot();
      const accountingSnapshot = this.accountingEntries.snapshot();
      const requestSnapshot = new Map(
        [...this.expenseCreationRequests].map(([key, value]) => [key, { ...value }]),
      );
      const documentsSnapshot = this.documents.map(cloneDocumentView);
      const restore = (): void => {
        this.expenses.restore(expenseSnapshot);
        this.accountingEntries.restore(accountingSnapshot);
        this.expenseCreationRequests.clear();
        for (const [key, value] of requestSnapshot) {
          this.expenseCreationRequests.set(key, { ...value });
        }
        this.documents.splice(
          0,
          this.documents.length,
          ...documentsSnapshot.map(cloneDocumentView),
        );
      };

      try {
        const recorded = await this.recordExpenseWithinLock(expenseInput);
        if (!recorded.ok) {
          restore();
          return recorded;
        }
        const movedRevision =
          document.folderId === targetFolder.id ? document.revision : document.revision + 1;
        const linked: DocumentView = {
          ...document,
          folderId: targetFolder.id,
          linkedEntityType: 'expense',
          linkedEntityId: recorded.value.id,
          revision: movedRevision + 1,
          tags: [...document.tags],
        };
        this.documents[documentIndex] = linked;
        return ok({ expenseId: recorded.value.id, document: cloneDocumentView(linked) });
      } catch (cause) {
        restore();
        throw cause;
      }
    });
  }

  // ——— Réception e-facture (C-EXP6b, adaptateur démo) — MÊMES contrôles/décision que le serveur ———

  /** Contrôles bloquants (use case PUR @bob/core) + mémoire fournisseur locale (dernière
   * dépense validée du même fournisseur, parité suggestExpenseDefaults). */
  private async facturXReviewLocal(xml: string): Promise<Result<FacturXImportReview, AppError>> {
    const company = seedCompany();
    const expenses = await this.expenses.listByCompany(this.companyId);
    const existingInvoiceKeys = expenses
      .map((e) => expenseDuplicateKey(e.toProps()))
      .filter((k): k is string => k !== null);
    const imported = runFacturXReceptionControls({
      xml,
      mySiren: company.siren,
      existingInvoiceKeys,
    });
    if (!imported.ok) {
      // Erreur de contrôle typée aplatie comme à la frontière HTTP : field = facturx.<code>.
      return err({
        kind: 'validation',
        issues: [{ field: `facturx.${imported.error.code}`, message: imported.error.message }],
      });
    }
    const supplierKey = normalizeSupplierNameLocal(imported.value.supplierName);
    const known = expenses
      .map((e) => e.toProps())
      .filter((e) => normalizeSupplierNameLocal(e.supplierName) === supplierKey)
      .at(-1);
    const draft = withSupplierCategory(imported.value, known ? known.category : null);
    const controls: FacturXImportControl[] = ['destinataire', 'coherence_en16931', 'doublon'];
    return ok({ draft, controls });
  }

  /** C-EXP6b ① : contrôle de réception + brouillon — RIEN n'est enregistré (décision à l'appelant). */
  async importFacturXExpense(input: {
    xml: string;
  }): Promise<Result<FacturXImportReview, AppError>> {
    await this.ready;
    return this.facturXReviewLocal(input.xml);
  }

  /** C-EXP6b ② : décision AFNOR explicite. `approve` rejoue les contrôles puis passe par
   * recordExpense (écritures E1 automatiques — autoliquidation : ZÉRO 44566) et archive le XML
   * au coffre local (kind facturx_xml, lié à l'Expense). `refuse` exige un motif (machine
   * InboundEinvoice) et reste possible sur une pièce qui échoue aux contrôles (geste attendu). */
  async confirmFacturXExpense(input: {
    xml: string;
    decision: FacturXImportDecision;
  }): Promise<Result<FacturXImportOutcome, AppError>> {
    await this.ready;
    if (input.decision.action === 'refuse') {
      const parsed = parseFacturXBasic(input.xml);
      const invoiceKey = parsed.ok
        ? `${parsed.value.seller.legalId ?? parsed.value.seller.name}|${parsed.value.number}`
        : 'facture-illisible';
      const inbound = InboundEinvoice.receive(this.ids.newId(), invoiceKey);
      if (!inbound.ok) return err(appDomain(inbound.error));
      const refused = inbound.value.refuse(this.clock.now(), {
        afnorStatus: input.decision.afnorStatus,
        reason: input.decision.reason,
      });
      if (!refused.ok) return err(appDomain(refused.error));
      const refusal = inbound.value.refusal;
      if (!refusal)
        return err({ kind: 'dependency', port: 'einvoice-inbound', cause: 'refus sans trace' });
      return ok({
        status: 'refused',
        afnorStatus: refusal.afnorStatus,
        reason: refusal.reason,
        invoiceKey,
      });
    }
    if (input.decision.action !== 'approve') {
      return err({
        kind: 'validation',
        issues: [{ field: 'decision.action', message: 'Décision inconnue (approve ou refuse).' }],
      });
    }
    const review = await this.facturXReviewLocal(input.xml);
    if (!review.ok) return review;
    const draft = review.value.draft;
    const inbound = InboundEinvoice.receive(this.ids.newId(), draft.duplicateKey);
    if (!inbound.ok) return err(appDomain(inbound.error));
    const approved = inbound.value.approve(this.clock.now());
    if (!approved.ok) return err(appDomain(approved.error));
    // MÊME chemin que toute dépense : RecordExpense + écritures du cycle achats (E1).
    const recorded = await this.recordExpense(
      facturXDraftToRecordExpenseInput(
        draft,
        input.decision.category !== undefined ? { category: input.decision.category } : {},
      ),
    );
    if (!recorded.ok) return recorded;
    // Archive du XML APPROUVÉ au coffre local (kind facturx_xml), lié à l'Expense créée.
    const xmlBytes = utf8BytesLocal(input.xml);
    if (xmlBytes.length === 0 || xmlBytes.length > DOCUMENT_BINARY_MAX_BYTES) {
      return err({
        kind: 'validation',
        issues: [
          {
            field: 'xml',
            message: xmlBytes.length === 0 ? 'Document XML vide.' : 'Document XML trop volumineux.',
          },
        ],
      });
    }
    this.documentSeq += 1;
    const id = `local-document-${this.documentSeq}`;
    const sha256 = portableSha256Bytes(xmlBytes);
    const filename = `facture-fournisseur-${draft.supplierInvoiceNumber.replace(/[^A-Za-z0-9._-]+/g, '-')}.xml`;
    const view: DocumentView = {
      id,
      companyId: this.companyId,
      kind: 'facturx_xml',
      origin: 'uploaded',
      status: 'active',
      filename,
      displayName: localDefaultDisplayName(filename),
      mimeType: 'application/xml',
      byteSize: xmlBytes.length,
      sha256,
      storageKey: buildDocumentStorageKey({
        companyId: this.companyId,
        documentId: id,
        version: 1,
        sha256,
        filename,
        mimeType: 'application/xml',
      }),
      folderId: null,
      revision: 1,
      version: 1,
      linkedEntityType: 'expense',
      linkedEntityId: recorded.value.id,
      documentDate: draft.documentDate,
      issuedAt: null,
      createdAt: this.clock.now(),
      createdBy: 'local',
      retentionUntil: addYears(draft.documentDate, 10),
      tags: [],
    };
    this.documents.unshift(view);
    this.documentContents.set(id, {
      contentBase64: bytesToBase64(xmlBytes),
      mimeType: 'application/xml',
    });
    return ok({ status: 'approved', expenseId: recorded.value.id, xmlDocumentId: id });
  }

  /** Adaptateur de test : même preuve explicite et même use case que le serveur. */
  async payExpense(
    input: RecordExpensePaymentClientInput,
  ): Promise<Result<RecordExpensePaymentClientOutput, AppError>> {
    await this.ready;
    return new RecordExpensePayment({
      expenses: this.expenses,
      entries: this.accountingEntries,
      clock: this.clock,
      charts: this.chartOfAccounts,
      documents: this.paymentProofDocuments,
    }).execute({ ...input, companyId: this.companyId });
  }

  /** Régularisation d'une ligne historique payée sans preuve — même use case que le serveur. */
  async regularizeExpensePayment(
    input: RegularizeExpensePaymentClientInput,
  ): Promise<Result<RegularizeExpensePaymentClientOutput, AppError>> {
    await this.ready;
    return new RegularizeLegacyExpensePayment({
      expenses: this.expenses,
      entries: this.accountingEntries,
      clock: this.clock,
      charts: this.chartOfAccounts,
      documents: this.paymentProofDocuments,
    }).execute({ ...input, companyId: this.companyId });
  }

  async listExpenses(): Promise<Result<ExpenseProps[], AppError>> {
    await this.ready;
    const list = await this.expenses.listByCompany(this.companyId);
    return ok(list.map((e) => e.toProps()));
  }

  async listCatalogueItems(): Promise<Result<readonly CatalogueItemView[], AppError>> {
    return new ListCatalogueItems({ catalogue: this.catalogue }).execute({
      companyId: this.companyId,
    });
  }

  async createCatalogueItem(
    input: CatalogueItemWriteInput,
  ): Promise<Result<CatalogueItemView, AppError>> {
    return new CreateCatalogueItem({
      catalogue: this.catalogue,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId, item: input });
  }

  async updateCatalogueItem(input: {
    itemId: string;
    expectedRevision: number;
    item: CatalogueItemWriteInput;
  }): Promise<Result<CatalogueItemView, AppError>> {
    return new UpdateCatalogueItem({ catalogue: this.catalogue, clock: this.clock }).execute({
      companyId: this.companyId,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      item: input.item,
    });
  }

  async deleteCatalogueItem(input: {
    itemId: string;
    expectedRevision: number;
  }): Promise<Result<CatalogueDeletionView, AppError>> {
    return new DeleteCatalogueItem({ catalogue: this.catalogue }).execute({
      companyId: this.companyId,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
    });
  }

  async createChantier(
    input: Omit<CreateChantierInput, 'companyId'>,
  ): Promise<Result<{ id: string }, AppError>> {
    return new CreateChantier({
      chantiers: this.chantiers,
      customers: this.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId, ...input });
  }

  async listChantiers(): Promise<Result<ChantierListItem[], AppError>> {
    const [list, noteCounts, photoCounts] = await Promise.all([
      this.chantiers.listByCompany(this.companyId),
      this.chantierNotes.countByCompany(this.companyId),
      this.worksiteMedia.countByCompany(this.companyId),
    ]);
    return ok(
      list.map((c) => ({
        ...c.toProps(),
        noteCount: noteCounts.get(c.id) ?? 0,
        photoCount: photoCounts.get(c.id) ?? 0,
      })),
    );
  }

  async listChantierNotes(chantierId: string): Promise<Result<ChantierNoteProps[], AppError>> {
    const list = await this.chantierNotes.listByChantier(this.companyId, chantierId);
    return ok(list.map((n) => n.toProps()));
  }

  async addChantierNote(
    chantierId: string,
    input: { text: string },
  ): Promise<Result<{ id: string }, AppError>> {
    const company = await this.companies.findById(this.companyId);
    return new AddChantierNote({
      chantiers: this.chantiers,
      notes: this.chantierNotes,
      ids: this.ids,
      clock: this.clock,
    }).execute({
      companyId: this.companyId,
      chantierId,
      text: input.text,
      authorLabel: company?.name ?? 'Bob Pro',
    });
  }

  async listWorksitePhotos(chantierId: string): Promise<Result<WorksiteMediaItem[], AppError>> {
    return ok(await this.worksiteMedia.listByChantier(this.companyId, chantierId));
  }

  async uploadWorksitePhoto(
    chantierId: string,
    input: { contentBase64: string; mimeType: string; filename: string },
  ): Promise<Result<WorksiteMediaItem, AppError>> {
    return new UploadWorksitePhoto({
      chantiers: this.chantiers,
      media: this.worksiteMedia,
      storage: this.worksitePhotoBytes,
      ids: this.ids,
      clock: this.clock,
    }).execute({
      companyId: this.companyId,
      chantierId,
      bytes: new Uint8Array(Buffer.from(input.contentBase64, 'base64')),
      contentType: input.mimeType,
      filename: input.filename,
    });
  }

  async worksitePhotoViewUrl(
    photoId: string,
  ): Promise<Result<{ url: string; expiresInSeconds: number }, AppError>> {
    const item = await this.worksiteMedia.findById(this.companyId, photoId);
    if (!item) return err(appNotFound('worksite_photo', photoId));
    const url = await this.worksitePhotoBytes.getSignedUrl(this.companyId, item.storageKey, 300);
    return ok({ url, expiresInSeconds: 300 });
  }

  async deleteWorksitePhoto(photoId: string): Promise<Result<void, AppError>> {
    return new DeleteWorksitePhoto({
      media: this.worksiteMedia,
      storage: this.worksitePhotoBytes,
    }).execute({ companyId: this.companyId, id: photoId });
  }

  // Écritures billing : barrière this.ready (le seed démo doit être ENTIÈREMENT posé avant
  // toute écriture utilisateur — sinon la numérotation sans-trou se mélange, cf. tests).
  // Les variantes *Internal (sans barrière, clock injectable) servent le seed lui-même.

  async createQuote(
    input: Omit<CreateQuoteInput, 'companyId'>,
  ): Promise<Result<CreateQuoteOutput, AppError>> {
    await this.ready;
    return this.withQuoteCreationLock(async () => {
      const fingerprint = localQuoteCreationFingerprint(this.companyId, input);
      if (fingerprint === 'invalid') {
        return err({
          kind: 'validation',
          issues: [
            {
              field: 'idempotencyKey',
              message: "Clé d'idempotence invalide (1 à 200 caractères imprimables).",
            },
          ],
        });
      }
      if (fingerprint) {
        const published = this.quoteCreationRequests.get(fingerprint.keyHash);
        if (published) {
          if (published.payloadHash !== fingerprint.payloadHash) {
            return err(
              appConflict(
                'quote_creation',
                "Cette clé d'idempotence a déjà été utilisée pour un autre devis.",
              ),
            );
          }
          const quote = await this.quotes.findById(published.output.quoteId);
          return quote && quote.companyId === this.companyId
            ? ok(cloneQuoteCreation(published.output))
            : err({
                kind: 'dependency',
                port: 'quote-creation-idempotency',
                cause: 'La création publiée ne référence plus un devis lisible.',
              });
        }
      }

      const quoteSnapshot = this.quotes.snapshot();
      try {
        const created = await this.createQuoteInternal(input);
        if (!created.ok) return created;
        if (fingerprint) {
          this.quoteCreationRequests.set(fingerprint.keyHash, {
            payloadHash: fingerprint.payloadHash,
            output: cloneQuoteCreation(created.value),
          });
        }
        return { ok: true, value: cloneQuoteCreation(created.value) };
      } catch (cause) {
        this.quotes.restore(quoteSnapshot);
        throw cause;
      }
    });
  }

  private createQuoteInternal(
    input: Omit<CreateQuoteInput, 'companyId'>,
    clock: ClockPort = this.clock,
  ): Promise<Result<CreateQuoteOutput, AppError>> {
    return new CreateQuote({
      quotes: this.quotes,
      companies: this.companies,
      customers: this.customers,
      ids: this.ids,
      clock,
    }).execute({ ...input, companyId: this.companyId });
  }

  async getQuoteDraft(): Promise<Result<QuoteDraftSlotView | null, AppError>> {
    if (this.quoteDraftSlot === null) return ok(null);
    const payload = parseQuoteDraftPayload(this.quoteDraftSlot.payload);
    if (!payload.ok) {
      return err({
        kind: 'dependency',
        port: 'local-quote-draft',
        cause: 'Brouillon local corrompu.',
      });
    }
    return ok({ ...this.quoteDraftSlot, payload: payload.value });
  }

  async saveQuoteDraft(
    input: SaveQuoteDraftClientInput,
  ): Promise<Result<QuoteDraftSlotView, AppError>> {
    const payload = parseQuoteDraftPayload(input.payload);
    if (!payload.ok) {
      return err({
        kind: 'validation',
        issues: [{ field: 'payload', message: `Brouillon invalide (${payload.error.code}).` }],
      });
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision invalide.' }],
      });
    }
    const current = this.quoteDraftSlot;
    if (
      (current === null && input.expectedRevision !== 0) ||
      (current !== null && current.revision !== input.expectedRevision)
    ) {
      return err(appConflict('quote_draft_slot', 'stale_revision'));
    }
    const now = this.clock.now();
    this.quoteDraftSlot = {
      revision: current === null ? 1 : current.revision + 1,
      payloadVersion: QUOTE_DRAFT_PAYLOAD_VERSION,
      payload: payload.value,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    return ok({ ...this.quoteDraftSlot, payload: payload.value });
  }

  async deleteQuoteDraft(expectedRevision: number): Promise<Result<{ deleted: true }, AppError>> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision invalide.' }],
      });
    }
    if (this.quoteDraftSlot === null) return err(appNotFound('quote_draft_slot', 'current'));
    if (this.quoteDraftSlot.revision !== expectedRevision) {
      return err(appConflict('quote_draft_slot', 'stale_revision'));
    }
    this.quoteDraftSlot = null;
    return ok({ deleted: true });
  }

  async sendQuote(quoteId: string): Promise<Result<SendQuoteOutput, AppError>> {
    await this.ready;
    return this.sendQuoteInternal(quoteId);
  }

  private async sendQuoteInternal(
    quoteId: string,
    clock: ClockPort = this.clock,
  ): Promise<Result<SendQuoteOutput, AppError>> {
    const result = await new SendQuote({
      quotes: this.quotes,
      counters: this.counters,
      uow: this.uow,
      clock,
    }).execute({
      quoteId,
    });
    // L'adapter local ne contacte aucun tiers : ne jamais afficher un faux « email envoyé ».
    return result.ok ? { ok: true, value: { ...result.value, deliveryStatus: 'skipped' } } : result;
  }

  /** P0 R4 — parité avec l'API : préparer le lien ne déclenche AUCUN sortant (l'adaptateur
   * local n'a de toute façon aucun canal e-mail). Même use case core, même rotation de jeton.
   * L'URL imite la construction serveur (base démo) : en mode local elle n'est résoluble par
   * personne d'autre que ce device — c'est un adaptateur de démo, pas un vrai lien public. */
  async createQuoteSignatureLink(
    quoteId: string,
  ): Promise<Result<CreateQuoteSignatureLinkOutput, AppError>> {
    await this.ready;
    const link = await new CreateQuoteSignatureLink({
      quotes: this.quotes,
      publicAccessTokens: this.publicAccessTokens,
      clock: this.clock,
    }).execute({ quoteId });
    if (!link.ok) return link;
    return {
      ok: true,
      value: {
        signatureUrl: `https://demo.bobpro.fr/sign/${encodeURIComponent(link.value.token)}`,
        expiresAt: link.value.expiresAt,
      },
    };
  }

  /** Lien public de VISUALISATION — même doctrine SANS AUCUN sortant que createQuoteSignatureLink
   * (adaptateur de démo : l'URL n'est résoluble par personne d'autre que ce device). */
  async createQuoteViewLink(
    quoteId: string,
  ): Promise<Result<CreateDocumentViewLinkOutput, AppError>> {
    await this.ready;
    const link = await new CreateDocumentViewLink({
      quotes: this.quotes,
      invoices: this.invoices,
      publicAccessTokens: this.publicAccessTokens,
      clock: this.clock,
    }).execute({ kind: 'quote', id: quoteId });
    if (!link.ok) return link;
    return {
      ok: true,
      value: {
        viewUrl: `https://demo.bobpro.fr/view/${encodeURIComponent(link.value.token)}`,
        expiresAt: link.value.expiresAt,
      },
    };
  }

  /** Lien public de VISUALISATION (facture) — même doctrine que createQuoteViewLink. */
  async createInvoiceViewLink(
    invoiceId: string,
  ): Promise<Result<CreateDocumentViewLinkOutput, AppError>> {
    await this.ready;
    const link = await new CreateDocumentViewLink({
      quotes: this.quotes,
      invoices: this.invoices,
      publicAccessTokens: this.publicAccessTokens,
      clock: this.clock,
    }).execute({ kind: 'invoice', id: invoiceId });
    if (!link.ok) return link;
    return {
      ok: true,
      value: {
        viewUrl: `https://demo.bobpro.fr/view/${encodeURIComponent(link.value.token)}`,
        expiresAt: link.value.expiresAt,
      },
    };
  }

  async signQuote(input: {
    quoteId: string;
    signerName: string;
    proofDataUrl?: string;
  }): Promise<Result<{ status: string }, AppError>> {
    await this.ready;
    return this.signQuoteInternal(input);
  }

  private signQuoteInternal(
    input: { quoteId: string; signerName: string; proofDataUrl?: string },
    clock: ClockPort = this.clock,
  ): Promise<Result<{ status: string }, AppError>> {
    // R4 : même règle que l'API — le tracé est haché (sha256Hex, pur TS : tourne on-device),
    // jamais stocké tel quel ; absent = preuve absente, jamais fabriquée.
    return new SignQuote({
      quotes: this.quotes,
      publicAccessTokens: this.publicAccessTokens,
      uow: this.uow,
      clock,
    }).execute({
      quoteId: input.quoteId,
      signerName: input.signerName,
      ...(input.proofDataUrl ? { proofSha256: sha256Hex(input.proofDataUrl) } : {}),
    });
  }

  async refuseQuote(quoteId: string): Promise<Result<{ status: string }, AppError>> {
    await this.ready;
    return new RefuseQuote({
      quotes: this.quotes,
      publicAccessTokens: this.publicAccessTokens,
      uow: this.uow,
      clock: this.clock,
    }).execute({ quoteId });
  }

  async generateInvoice(input: {
    quoteId: string;
    mode: 'deposit' | 'final';
  }): Promise<Result<{ invoiceId: string }, AppError>> {
    await this.ready;
    return this.generateInvoiceInternal(input);
  }

  private generateInvoiceInternal(input: {
    quoteId: string;
    mode: 'deposit' | 'final';
  }): Promise<Result<{ invoiceId: string }, AppError>> {
    return new GenerateInvoiceFromQuote({
      quotes: this.quotes,
      invoices: this.invoices,
      ids: this.ids,
    }).execute(input);
  }

  /** R6 : édition d'une ligne de devis BROUILLON — même use case core que l'API (parité d'actions). */
  async updateQuoteLine(
    input: UpdateQuoteLineInput,
  ): Promise<Result<{ status: string }, AppError>> {
    await this.ready;
    return new UpdateQuoteLine({ quotes: this.quotes, uow: this.uow }).execute(input);
  }

  /** R6 : suppression d'une ligne de devis BROUILLON — même use case core que l'API. */
  async removeQuoteLine(
    input: RemoveQuoteLineInput,
  ): Promise<Result<{ status: string }, AppError>> {
    await this.ready;
    return new RemoveQuoteLine({ quotes: this.quotes, uow: this.uow }).execute(input);
  }

  async issueInvoice(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>> {
    await this.ready;
    return this.issueInvoiceInternal(input);
  }

  /** R6 : suppression définitive d'une facture BROUILLON — même use case core que l'API. */
  async deleteDraftInvoice(invoiceId: string): Promise<Result<{ deleted: true }, AppError>> {
    await this.ready;
    return new DeleteDraftInvoice({ invoices: this.invoices, uow: this.uow }).execute({
      invoiceId,
    });
  }

  /** A6 : avoir TOTAL (brouillon) — s'émet ensuite par issueInvoice (numéro A-, écriture inverse). */
  async createCreditNote(input: {
    invoiceId: string;
  }): Promise<Result<{ creditNoteId: string }, AppError>> {
    await this.ready;
    return new CreateCreditNote({ invoices: this.invoices, ids: this.ids }).execute(input);
  }

  private async issueInvoiceInternal(
    input: IssueInvoiceInput,
    clock: ClockPort = this.clock,
  ): Promise<Result<{ number: string }, AppError>> {
    const paymentTermsDays = this.billingSettings.defaultInvoicePaymentTermsDays;
    if (input.terms === undefined && paymentTermsDays === null) {
      return err({
        kind: 'validation',
        issues: [
          {
            field: 'paymentTerms',
            message: 'Choisissez vos conditions de paiement avant d’émettre cette facture.',
          },
        ],
      });
    }
    const issued = await new IssueInvoice({
      invoices: this.invoices,
      companies: this.companies,
      customers: this.customers,
      counters: this.counters,
      uow: this.uow,
      clock,
    }).execute(
      input.terms !== undefined
        ? input
        : {
            invoiceId: input.invoiceId,
            terms: {
              days: paymentTermsDays as number,
              endOfMonth: false,
              label: `Paiement à ${paymentTermsDays as number} jours`,
            },
          },
    );
    if (!issued.ok) return issued;
    const accounting = await new RecordIssuedInvoiceAccountingEntry({
      invoices: this.invoices,
      entries: this.accountingEntries,
      charts: this.chartOfAccounts,
    }).execute({ invoiceId: input.invoiceId });
    if (!accounting.ok) return accounting;
    return issued;
  }

  /** C25 ② (adaptateur DÉMO) : mêmes règles que le serveur (plan @bob/core, dédup quotidienne,
   * refus honnête), mais l'« envoi » alimente le fil local au lieu du mailer — le mode démo
   * journalise, il ne contacte jamais un tiers. */
  async sendRelance(invoiceId: string): Promise<Result<SendRelanceClientOutput, AppError>> {
    const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
    if (!inv.ok) return inv;
    if (!cust.ok) return cust;
    const plan = deriveRelancePlan({
      invoices: inv.value,
      customers: cust.value,
      today: this.clock.today(),
    });
    const entry = plan.find((e) => e.invoiceId === invoiceId);
    if (!entry) {
      return err({
        kind: 'validation',
        issues: [
          {
            field: 'invoiceId',
            message: 'Facture non relançable — réglée, annulée ou pas encore échue.',
          },
        ],
      });
    }
    const dedupeKey = `${invoiceId}:${this.clock.today()}`;
    const existing = this.relanceDedupe.get(dedupeKey);
    if (existing) return ok({ jobId: existing, status: 'done', tone: entry.tone });
    const item: NotificationView = {
      id: `notif-${(this.notificationSeq += 1)}`,
      kind: 'invoice-relance',
      title: entry.message.subject,
      body: null, // sémantique serveur : le payload est purgé après livraison (hygiène PII)
      channel: 'email',
      status: 'done',
      route: `/facture/${entry.invoiceId}`,
      readAt: null,
      createdAt: this.clock.now(),
    };
    this.notifications.unshift(item);
    this.relanceDedupe.set(dedupeKey, item.id);
    return ok({ jobId: item.id, status: 'done', tone: entry.tone });
  }

  async listNotifications(): Promise<Result<NotificationView[], AppError>> {
    return ok(this.notifications.map((n) => ({ ...n })));
  }

  async markNotificationRead(id: string): Promise<Result<NotificationView, AppError>> {
    const item = this.notifications.find((n) => n.id === id);
    if (!item) return err(appNotFound('notification', id));
    item.readAt ??= this.clock.now(); // idempotent : première lecture conservée
    return ok({ ...item });
  }

  async previewUnreadNotifications(): Promise<Result<NotificationUnreadPreview, AppError>> {
    // L'adaptateur local n'a pas d'horloge DB : +1 ms fournit une borne exclusive qui inclut
    // les notifications créées au tick courant de l'horloge déterministe.
    const observedAt = this.clock.now();
    const throughCreatedAt = new Date(Date.parse(observedAt) + 1).toISOString();
    const unreadCount = this.notifications.filter(
      (item) => item.readAt === null && item.createdAt < throughCreatedAt,
    ).length;
    return ok({ unreadCount, throughCreatedAt });
  }

  async markNotificationsReadThrough(
    input: NotificationReadThroughInput,
  ): Promise<Result<NotificationReadThroughOutput, AppError>> {
    const cutoffMs = Date.parse(input.throughCreatedAt);
    const readAt = this.clock.now();
    if (
      !Number.isFinite(cutoffMs) ||
      new Date(cutoffMs).toISOString() !== input.throughCreatedAt ||
      cutoffMs > Date.parse(readAt) + 1
    ) {
      return err({
        kind: 'validation',
        issues: [
          {
            field: 'throughCreatedAt',
            message: 'Cutoff serveur invalide. Demandez un nouvel aperçu.',
          },
        ],
      });
    }
    let updatedCount = 0;
    for (const item of this.notifications) {
      if (item.readAt !== null || item.createdAt >= input.throughCreatedAt) continue;
      item.readAt = readAt;
      updatedCount += 1;
    }
    return ok({ updatedCount, readAt });
  }

  async registerDevice(
    input: RegisterDeviceClientInput,
  ): Promise<Result<{ status: 'bound' | 'superseded' }, AppError>> {
    const fence = this.pushInstallations.get(input.installationId);
    const idempotent =
      fence?.maxGeneration === input.bindingGeneration &&
      fence.bindingId === input.bindingId &&
      fence.revocationSecret === input.revocationSecret &&
      fence.expoPushToken === input.expoPushToken;
    if (
      fence &&
      (fence.revocationSecret !== input.revocationSecret ||
        input.bindingGeneration < fence.maxGeneration ||
        (input.bindingGeneration === fence.maxGeneration && !idempotent))
    )
      return ok({ status: 'superseded' });
    this.pushInstallations.set(input.installationId, {
      bindingId: input.bindingId,
      maxGeneration: input.bindingGeneration,
      revocationSecret: input.revocationSecret,
      expoPushToken: input.expoPushToken,
    });
    for (const [token, device] of this.pushDevices) {
      if (device.installationId === input.installationId || token === input.expoPushToken) {
        if (token === input.expoPushToken && device.installationId !== input.installationId) {
          const displaced = this.pushInstallations.get(device.installationId);
          if (displaced?.bindingId === device.bindingId) {
            this.pushInstallations.set(device.installationId, {
              ...displaced,
              bindingId: null,
              expoPushToken: null,
            });
          }
        }
        this.pushDevices.delete(token);
      }
    }
    this.pushDevices.set(input.expoPushToken, {
      installationId: input.installationId,
      bindingId: input.bindingId,
      bindingGeneration: input.bindingGeneration,
    });
    return ok({ status: 'bound' });
  }

  async unregisterDevice(
    _input: UnregisterDeviceClientInput,
  ): Promise<Result<{ unregistered: true }, AppError>> {
    // Endpoint legacy : les bindings v2 ne sont jamais supprimés par token seul.
    return ok({ unregistered: true });
  }

  async revokeDeviceBinding(
    input: RevokeDeviceBindingClientInput,
  ): Promise<Result<{ accepted: true }, AppError>> {
    return this.revokeLocalPushBinding(input, true);
  }

  async replayPushRevocation(
    input: RevokeDeviceBindingClientInput,
  ): Promise<Result<{ accepted: true }, AppError>> {
    return this.revokeLocalPushBinding(input, false);
  }

  private revokeLocalPushBinding(
    input: RevokeDeviceBindingClientInput,
    canCreateFence: boolean,
  ): Result<{ accepted: true }, AppError> {
    const fence = this.pushInstallations.get(input.installationId);
    if (!fence) {
      if (canCreateFence) {
        this.pushInstallations.set(input.installationId, {
          bindingId: null,
          maxGeneration: input.throughGeneration,
          revocationSecret: input.revocationSecret,
          expoPushToken: null,
        });
      }
      return ok({ accepted: true });
    }
    if (fence.revocationSecret !== input.revocationSecret) return ok({ accepted: true });
    if (fence.maxGeneration <= input.throughGeneration) {
      this.pushInstallations.set(input.installationId, {
        ...fence,
        bindingId: null,
        maxGeneration: input.throughGeneration,
        expoPushToken: null,
      });
    }
    // Parité PostgreSQL : une ancienne ligne orpheline <= N reste révocable même si le parent
    // a déjà avancé au-delà de N.
    for (const [token, device] of this.pushDevices) {
      if (
        device.installationId === input.installationId &&
        device.bindingGeneration <= input.throughGeneration
      )
        this.pushDevices.delete(token);
    }
    return ok({ accepted: true });
  }

  async registerPayment(input: {
    invoiceId: string;
    amount: number;
    method: PaymentMethod;
    idempotencyKey?: string | null;
  }) {
    await this.ready;
    return this.registerPaymentInternal(input);
  }

  /** E3 : encaissements datés du tenant — CA encaissé annuel (293 B), lettrage futur. */
  async listPayments(): Promise<Result<PaymentView[], AppError>> {
    await this.ready;
    const list = await this.payments.listByCompany(this.companyId);
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

  private async registerPaymentInternal(input: {
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

  async invoiceAccountingPreview(
    invoiceId: string,
  ): Promise<Result<InvoiceAccountingPreview, AppError>> {
    await this.ready;
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

  async paymentAccountingPreview(input: {
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
  }): Promise<Result<PaymentAccountingPreview, AppError>> {
    return new PreviewPaymentAccountingEntry({
      invoices: this.invoices,
      clock: this.clock,
    }).execute({
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

  /** B9 — pendant local (démo/offline) de GET /documents/search : même fonction pure core que le
   * mode démo serveur (InMemorySalesDocumentSearchRepository, apps/api) — un devis n'a pas de
   * date métier en mémoire (contrairement à Invoice.issuedAt), donc `date: null`, exclu de toute
   * plage de dates active plutôt que deviné (voir search-sales-documents.ts). */
  async searchSalesDocuments(
    input: SearchSalesDocumentsClientInput,
  ): Promise<Result<SearchSalesDocumentsResult, AppError>> {
    await this.ready;
    const [quotes, invoices, customers] = await Promise.all([
      this.quotes.listByCompany(this.companyId),
      this.invoices.listByCompany(this.companyId),
      this.customers.listByCompany(this.companyId),
    ]);
    const toPiece = (
      totals: Totals,
      extra: {
        id: string;
        number: string | null;
        customerId: string;
        status: string;
        date: string | null;
        lines: readonly { label: string }[];
      },
    ): SalesDocumentSearchPiece => ({ ...extra, totals });
    const quotePieces = quotes.map((q) =>
      toPiece(q.totals(), {
        id: q.id,
        number: q.number,
        customerId: q.customerId,
        status: q.status,
        date: null,
        lines: q.lines.map((l) => ({ label: l.label })),
      }),
    );
    const invoicePieces = invoices.map((i) =>
      toPiece(i.totals(), {
        id: i.id,
        number: i.number,
        customerId: i.customerId,
        status: i.status,
        date: i.issuedAt,
        lines: i.lines.map((l) => ({ label: l.label })),
      }),
    );
    return ok(
      searchSalesDocumentsInMemory({
        ...input,
        scope: input.scope ?? 'all',
        customers: customers.map((c) => ({ id: c.id, name: c.name })),
        quotes: quotePieces,
        invoices: invoicePieces,
      }),
    );
  }

  async suggestSalesDocuments(
    query: string,
  ): Promise<Result<SuggestSalesDocumentsResult, AppError>> {
    await this.ready;
    const [quotes, invoices, customers] = await Promise.all([
      this.quotes.listByCompany(this.companyId),
      this.invoices.listByCompany(this.companyId),
      this.customers.listByCompany(this.companyId),
    ]);
    return ok(
      suggestSalesDocumentsInMemory({
        query,
        customers: customers.map((c) => ({ id: c.id, name: c.name })),
        quotes: quotes.map((q) => ({
          id: q.id,
          number: q.number,
          customerId: q.customerId,
          status: q.status,
          date: null,
          totals: q.totals(),
          lines: q.lines.map((l) => ({ label: l.label })),
        })),
        invoices: invoices.map((i) => ({
          id: i.id,
          number: i.number,
          customerId: i.customerId,
          status: i.status,
          date: i.issuedAt,
          totals: i.totals(),
          lines: i.lines.map((l) => ({ label: l.label })),
        })),
      }),
    );
  }

  async listAccountingEntries(): Promise<Result<AccountingEntryView[], AppError>> {
    await this.ready;
    return new ListAccountingEntries({ entries: this.accountingEntries }).execute({
      companyId: this.companyId,
    });
  }

  async exportFec(input: { from: string; to: string }) {
    await this.ready;
    return new ExportFec({
      companies: this.companies,
      entries: this.accountingEntries,
      charts: this.chartOfAccounts,
      // E7 — FEC PROBANT : lettrage 411 (factures soldées + encaissements, DateLet =
      // dernier règlement) et comptes auxiliaires clients/fournisseurs, dérivés du vivant.
      auxiliary: {
        get: async (companyId) => {
          const [invoices, payments, customers, expenses] = await Promise.all([
            this.invoices.listByCompany(companyId),
            this.payments.listByCompany(companyId),
            this.customers.listByCompany(companyId),
            this.expenses.listByCompany(companyId),
          ]);
          return {
            invoices: invoices.map((i) => ({
              id: i.id,
              status: i.status,
              customerId: i.customerId,
            })),
            payments: payments.map((p) => ({
              id: p.id,
              invoiceId: p.invoiceId,
              receivedAt: p.receivedAt,
            })),
            customers: customers.map((c) => ({ id: c.id, name: c.name })),
            expenses: expenses.map((e) => ({ id: e.id, supplierName: e.supplierName })),
          };
        },
      },
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
      // BOB-1 : l'expert-comptable de poche — MÊMES use cases purs que les écrans (parité).
      getVatPosition: async () => {
        await this.ready;
        const [invoices, expenses] = await Promise.all([
          this.invoices.listByCompany(this.companyId),
          this.expenses.listByCompany(this.companyId),
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
        await this.ready;
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        if (!cust.ok) return cust;
        return ok(
          deriveAgedBalance({
            invoices: inv.value,
            customers: cust.value,
            today: this.clock.today(),
          }),
        );
      },
      getTrialBalance: async () => {
        await this.ready;
        const list = await this.accountingEntries.listByCompany(this.companyId);
        return ok(deriveTrialBalance(list.map((e) => ({ lines: e.lines }))));
      },
      getIncomeStatement: async () => {
        await this.ready;
        const list = await this.accountingEntries.listByCompany(this.companyId);
        return ok(deriveIncomeStatement(list.map((e) => ({ lines: e.lines }))));
      },
      getBalanceSheet: async () => {
        await this.ready;
        const list = await this.accountingEntries.listByCompany(this.companyId);
        return ok(deriveBalanceSheet(list.map((e) => ({ lines: e.lines }))));
      },
      // BA-3 : revue de pilotage — MÊME deriveBusinessReview que l'écran Pilotage (parité).
      getBusinessReview: async () => {
        await this.ready;
        const [entries, payments, invoices, customers, expenses] = await Promise.all([
          this.accountingEntries.listByCompany(this.companyId),
          this.payments.listByCompany(this.companyId),
          this.invoices.listByCompany(this.companyId),
          this.customers.listByCompany(this.companyId),
          this.expenses.listByCompany(this.companyId),
        ]);
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
            customers: customers.map((c) => ({ id: c.id, name: c.name })),
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
            vatRegime: seedCompany().vatRegime,
            today: this.clock.today(),
          }),
        );
      },
      // DOSSIER-2 : verdict de la revue de clôture — MÊME deriveClosingReview et MÊME
      // composition que l'écran Clôture (période = exercice à date, yearEnd = décembre,
      // justificatifs = factures engagées vs PDF liés au coffre).
      getClosingReview: async () => {
        await this.ready;
        const [entries, invoices] = await Promise.all([
          this.accountingEntries.listByCompany(this.companyId),
          this.invoices.listByCompany(this.companyId),
        ]);
        const today = this.clock.today();
        const engaged = invoices.filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
        const withPdf = new Set(
          this.documents
            .filter((d) => d.kind === 'invoice_pdf' && d.linkedEntityId)
            .map((d) => d.linkedEntityId),
        );
        const provided = engaged.filter((i) => withPdf.has(i.id)).length;
        return ok(
          deriveClosingReview({
            entries: entries.map((e) => ({ entryDate: e.entryDate, lines: e.lines })),
            period: { from: `${today.slice(0, 4)}-01-01`, to: today },
            justificatifs: { expected: engaged.length, provided },
            yearEnd: today.slice(5, 7) === '12',
          }),
        );
      },
      listUnpaidExpenses: async () => {
        await this.ready;
        const list = await this.expenses.listByCompany(this.companyId);
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
      recordExpensePayment: async (input) => {
        const r = await this.payExpense(input);
        if (!r.ok) return r;
        return ok(r.value);
      },
      // C25 ① : brouillon CIBLABLE, dérivé du plan de relances réel (@bob/core — ton par
      // ancienneté, reste dû netToPay − paid). Fini le « plus gros encours, J+7 inventé ».
      draftRelance: async (input) => {
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        if (!cust.ok) return cust;
        const plan = deriveRelancePlan({
          invoices: inv.value,
          customers: cust.value,
          today: this.clock.today(),
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
      // ASK-2 : devis signés facturables — un devis sort de la liste dès que sa FINALE existe ;
      // l'acompte déjà émis est signalé (depositInvoiced) pour que la finale devienne l'évidence.
      listInvoiceableQuotes: async (): Promise<Result<InvoiceableQuote[], AppError>> => {
        await this.ready;
        const [quotes, invoices, customers] = await Promise.all([
          this.quotes.listByCompany(this.companyId),
          this.invoices.listByCompany(this.companyId),
          this.customers.listByCompany(this.companyId),
        ]);
        const names = new Map(customers.map((c) => [c.id, c.name]));
        return ok(
          quotes
            .filter((q) => q.status === 'signed')
            .filter(
              (q) =>
                !invoices.some(
                  (i) => i.parentQuoteId === q.id && i.kind === 'final' && i.status !== 'cancelled',
                ),
            )
            .map((q) => ({
              id: q.id,
              number: q.number,
              customerName: names.get(q.customerId) ?? '',
              totalTtcCents: q.totals().ttc,
              depositPct: q.depositPct,
              depositInvoiced: invoices.some(
                (i) => i.parentQuoteId === q.id && i.kind === 'deposit' && i.status !== 'cancelled',
              ),
            })),
        );
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
      // C-EXP5b : lecture du calendrier fiscal — même use case que getFiscalCalendar (parité humain↔Bob).
      listFiscalDeadlines: async () => this.getFiscalCalendar(),
      // Le client local ne possède aucune autorité d'abonnement persistée : il échoue fermé.
      getSubscriptionStatus: async () => err(appUnavailable('subscription')),
      registerPayment: async (input) =>
        this.registerPayment({
          invoiceId: input.invoiceId,
          amount: input.amountCents,
          method: 'transfer',
          idempotencyKey:
            input.idempotencyKey ??
            `local-bob:payment:${input.invoiceId}:${input.amountCents}:transfer`,
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
        this.generateInvoice({ quoteId: input.quoteId, mode: input.mode }),
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
        // Une fiche porte uniquement l'identité ; les métriques viennent des pièces persistées.
        this.createCustomer({
          name: input.name,
          type: input.type,
          address: { line1: '', zip: '', city: '' },
        }),
      // C25 ② : outil envoyer_relance — même chemin que le bouton « Relancer » de l'écran
      // Notifications (sendRelance) ; en démo, l'envoi alimente le fil local (jamais un tiers).
      sendRelance: async (input) => {
        const r = await this.sendRelance(input.invoiceId);
        if (!r.ok) return r;
        return ok({
          jobId: r.value.jobId,
          status: r.value.status,
          ...(r.value.tone !== undefined ? { tone: r.value.tone } : {}),
        });
      },
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
    return this.bobAgent().ask(input.message, {
      autonomy,
      ...(input.history !== undefined ? { history: input.history } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
  }

  /** Aperçu local depuis le journal dry-run. Le mode démo n'a pas de multi-utilisateur, mais
   * conserve le même contrat opaque et ne reconstruit jamais les args depuis le langage. */
  async previewBobProposal(proposalId: string): Promise<Result<PendingAction, AppError>> {
    const entries = await this.journal.load(proposalId);
    const planned = entries.filter((entry) => entry.phase === 'planned');
    if (planned.length === 0) return err(appNotFound('agent_proposal', 'redacted'));
    const items = planned.map((entry) => ({
      tool: entry.tool,
      args: { ...entry.args },
      label: entry.label,
    }));
    const first = items[0]!;
    return ok({
      ...first,
      proposalId,
      ...(items.length > 1 ? { batch: items } : {}),
    });
  }

  /** POST /ai/confirm local : exécution JOURNALISÉE (append-only) — mêmes sémantiques que le serveur. */
  async confirmBob(pending: PendingAction): Promise<Result<AgentRun, AppError>> {
    const record = await this.bobAgent().runJournaled(pendingToInvocations(pending), {
      autonomy: this.autonomyEntitlement(),
    });
    const blocked = record.outcomes.find((o) => o.status === 'denied' || o.status === 'failed');
    if (blocked) {
      if (blocked.status === 'denied')
        return err(appForbidden(blocked.reason ?? 'Action refusée par la policy.'));
      return err({
        kind: 'dependency',
        port: 'agent-runtime',
        cause: blocked.reason ?? 'agent execution failed',
      });
    }
    const isBatch = pending.batch !== undefined && pending.batch.length > 0;
    return ok({
      kind: 'done',
      intent: 'encaisser',
      model: 'agent-runtime',
      plan: record.outcomes.map((o) => o.label),
      card: {
        title: 'Fait ✓',
        body: isBatch
          ? record.outcomes.map((o) => `✓ ${o.label}`).join('\n')
          : `${pending.label} — c’est noté.`,
      },
    });
  }

  /** GET /ai/runs/:runId/journal local : entrées d'audit du run (journal mémoire append-only). */
  async getRunJournal(runId: string): Promise<Result<JournalEntry[], AppError>> {
    return ok(await this.journal.load(runId));
  }
}
