import {
  isAllowedAgentNavigationRoute,
  type AgentRun,
  type JournalEntry,
  type PendingAction,
} from '@bob/ai';
import { isCustomPrestationId, parseCustomPrestation } from '@bob/core';
import type {
  Result,
  AppError,
  CreateQuoteInput,
  CreateQuoteOutput,
  IssueInvoiceInput,
  UpdateQuoteLineInput,
  RemoveQuoteLineInput,
  CustomerListItem,
  CashflowProjection,
  Scenario,
  Horizon,
  PaymentMethod,
  PlanTier,
  DiagnosticResult,
  DiagnosticAssessmentView,
  DiagnosticAssessmentWriteRequest,
  FiscalDeadline,
  OcrExtraction,
  ExpenseProps,
  RecordExpenseInput,
  TradeConfig,
  Trade,
  VatRegime,
  ChantierListItem,
  ChantierNoteProps,
  WorksiteMediaItem,
  CreateChantierInput,
  CompanyProps,
  CompanyBillingSettings,
  CompanyBillingSettingsPatch,
  CustomerPortfolio,
  CompanyLookupResult,
  VatCheckResult,
  AddressSuggestion,
  DocumentView,
  DocumentDownloadUrl,
  DocumentFolderView,
  DeleteDocumentFolderStrategy,
  DocumentAnalysis,
  FiscalProfileView,
  SearchSalesDocumentsResult,
  SuggestSalesDocumentsResult,
  CatalogueItemView,
  CatalogueItemWriteInput,
  CatalogueDeletionView,
  QualifiedBankBalanceSnapshot,
} from '@bob/core';
import type {
  BobClient,
  QuoteView,
  InvoiceView,
  PaymentView,
  SubscriptionView,
  SubscriptionBillingInvoiceView,
  ValueDigestView,
  TrialReportView,
  RegisterPaymentClientInput,
  RegisterPaymentClientOutput,
  RecordExpensePaymentClientInput,
  RecordExpensePaymentClientOutput,
  RegularizeExpensePaymentClientInput,
  RegularizeExpensePaymentClientOutput,
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
  SuggestExpenseDefaultsInput,
  ExpenseDefaultsView,
  FacturXImportReview,
  FacturXImportDecision,
  FacturXImportOutcome,
  ListDocumentsClientInput,
  UploadDocumentClientInput,
  VoiceConfig,
  VoiceSynthesisResult,
  RealtimeVoiceConfig,
  RealtimeVoiceCall,
  RealtimeVoiceCallInput,
  RealtimeVoiceContextUpdate,
  RealtimeVoiceControlAcknowledgement,
  RealtimeVoiceControlReference,
  RealtimeVoiceSpeechCancellationInput,
  RealtimeVoiceSpeechCancellationReason,
  RealtimeVoiceSpeechDeliveryAcknowledgement,
  RealtimeVoiceSpeechDeliveryInput,
  RealtimeVoiceSpeechFeed,
  RealtimeVoiceSpeechFeedInput,
  RealtimeVoiceSpeechMimeType,
  AccountingPreviewLine,
  InvoiceAccountingPreview,
  PaymentAccountingPreview,
  AccountingEntryView,
  ExportFecMetadata,
  ExportFecClientInput,
  ExportFecClientOutput,
  ClassifyDocumentClientInput,
  CreateDocumentIntakeClientInput,
  ListDocumentFoldersClientInput,
  DocumentFolderPageView,
  DocumentFolderDeletionPlanView,
  DocumentFolderDeletionExecutionView,
  RecordDocumentExpenseClientInput,
  RecordDocumentExpenseClientOutput,
  AskBobClientInput,
  CreateCustomerClientInput,
  UpdateCustomerClientInput,
  SearchSalesDocumentsClientInput,
  QuoteDraftSlotView,
  SaveQuoteDraftClientInput,
} from './client';
import {
  decodeDocumentAnalysisForDocument,
  decodeDocumentExpenseCreationForContext,
  decodeDocumentDownloadUrl,
  decodeDocumentFolderDeletionExecution,
  decodeDocumentFolderDeletionPlanForFolder,
  decodeDocumentFolderPageForContext,
  decodeDocumentFolderViewForContext,
  decodeDocumentMoveForContext,
  decodeDocumentViewForContext,
  decodeDocumentViewsForCompany,
} from './document-codecs';
import { decodeExpenseCreation } from './expense-idempotency';
import { decodeQuoteCreation } from './quote-idempotency';
import {
  decodeQuoteDraftDeletion,
  decodeQuoteDraftEnvelope,
  decodeQuoteDraftSlot,
  type QuoteDraftEnvelopeWire,
} from './quote-draft-codec';

export interface HttpBobClientOptions {
  baseUrl: string;
  companyId: string;
  getToken?: () => Promise<string | null>;
}

const DOCUMENT_READ_TIMEOUT_MS = 20_000;
const DOCUMENT_MUTATION_TIMEOUT_MS = 20_000;
const DOCUMENT_UPLOAD_TIMEOUT_MS = 45_000;
const DOCUMENT_ANALYSIS_TIMEOUT_MS = 75_000;
const TEXT_EXPORT_TIMEOUT_MS = 45_000;
const QUOTE_CREATION_TIMEOUT_MS = 20_000;
// Supérieur au budget serveur maximal (8,5 s) avec marge réseau/décodage, sans attente infinie.
const REALTIME_BOOTSTRAP_TIMEOUT_MS = 12_000;
const REALTIME_CONTROL_ACK_TIMEOUT_MS = 4_000;
const REALTIME_SPEECH_REQUEST_TIMEOUT_MS = 5_000;
const REALTIME_SPEECH_RESPONSE_MAX_BYTES = 16 * 1024;
const REALTIME_SPEECH_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const REALTIME_SPEECH_MIN_AUDIO_BYTES = 256;
const REALTIME_SPEECH_MIN_DURATION_MS = 100;
const REALTIME_SPEECH_MAX_DURATION_MS = 45_000;
const REALTIME_SPEECH_MAX_SEQUENCE = 2_147_483_647;
const REALTIME_SPEECH_MAX_WAIT_MS = 2_500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const MISTRAL_REALTIME_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COMPANY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const REALTIME_SPEECH_MIME_TYPES = new Set<RealtimeVoiceSpeechMimeType>([
  'audio/mpeg',
  'audio/wav',
]);
const REALTIME_SPEECH_CANCELLATION_REASONS = new Set<RealtimeVoiceSpeechCancellationReason>([
  'barge_in',
  'user_cancel',
  'context_changed',
  'session_end',
  'superseded',
  'playback_error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSecureApiBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('API base URL invalide.');
  }
  const loopback =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (
    (url.protocol !== 'https:' && !loopback) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error('API base URL non sûre : HTTPS requis hors développement local.');
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function decodePushRegistrationResponse(value: unknown): { status: 'bound' | 'superseded' } | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status']) ||
    (value.status !== 'bound' && value.status !== 'superseded')
  )
    return null;
  return { status: value.status };
}

function decodePushRevocationResponse(value: unknown): { accepted: true } | null {
  if (!isRecord(value) || !hasExactKeys(value, ['accepted']) || value.accepted !== true)
    return null;
  return { accepted: true };
}

const COMPANY_BILLING_SETTINGS_FIELDS = [
  'companyId',
  'revision',
  'showRibOnInvoices',
  'showInsuranceOnInvoices',
  'pdfAccentColor',
  'defaultQuoteValidityDays',
  'defaultDepositPercent',
  'defaultInvoicePaymentTermsDays',
  'createdAt',
  'updatedAt',
] as const;

function decodeCompanyBillingSettings(value: unknown): CompanyBillingSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, COMPANY_BILLING_SETTINGS_FIELDS)) return null;
  if (
    typeof value.companyId !== 'string' ||
    value.companyId.length === 0 ||
    !isBoundedInteger(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
    typeof value.showRibOnInvoices !== 'boolean' ||
    typeof value.showInsuranceOnInvoices !== 'boolean' ||
    !['navy', 'green', 'purple', 'orange'].includes(String(value.pdfAccentColor)) ||
    !isBoundedInteger(value.defaultQuoteValidityDays, 1, 365) ||
    !isBoundedInteger(value.defaultDepositPercent, 0, 100) ||
    (value.defaultInvoicePaymentTermsDays !== null &&
      !isBoundedInteger(value.defaultInvoicePaymentTermsDays, 1, 60)) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalIsoTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    return null;
  }
  return value as unknown as CompanyBillingSettings;
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

const CUSTOMER_LIST_ITEM_FIELDS = [
  'id',
  'name',
  'type',
  'address',
  'contactName',
  'score',
  'scoreBand',
  'scoreStatus',
  'grossReceivableCents',
  'issuedCreditCents',
  'outstandingCents',
  'customerCreditCents',
  'siren',
  'avgDelayDays',
  'paidOnTimeRatio',
  'paymentHistoryStatus',
  'settledInvoiceCount',
  'email',
  'phone',
] as const;

function isCustomerAddress(value: unknown): value is { line1: string; zip: string; city: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['line1', 'zip', 'city']) &&
    typeof value.line1 === 'string' &&
    typeof value.zip === 'string' &&
    typeof value.city === 'string'
  );
}

function decodeCustomerListItem(value: unknown): CustomerListItem | null {
  if (!isRecord(value) || !hasExactKeys(value, CUSTOMER_LIST_ITEM_FIELDS)) return null;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    (value.type !== 'b2c' && value.type !== 'b2b' && value.type !== 'b2g') ||
    !isCustomerAddress(value.address) ||
    (value.contactName !== null && typeof value.contactName !== 'string') ||
    value.score !== null ||
    value.scoreBand !== null ||
    value.scoreStatus !== 'model_not_ratified' ||
    !isBoundedInteger(value.grossReceivableCents, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.issuedCreditCents, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.outstandingCents, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.customerCreditCents, 0, Number.MAX_SAFE_INTEGER) ||
    (value.siren !== null && typeof value.siren !== 'string') ||
    (value.avgDelayDays !== null &&
      !isBoundedInteger(value.avgDelayDays, 0, Number.MAX_SAFE_INTEGER)) ||
    (value.paidOnTimeRatio !== null &&
      (typeof value.paidOnTimeRatio !== 'number' ||
        !Number.isFinite(value.paidOnTimeRatio) ||
        value.paidOnTimeRatio < 0 ||
        value.paidOnTimeRatio > 1)) ||
    (value.paymentHistoryStatus !== 'known' &&
      value.paymentHistoryStatus !== 'insufficient_history' &&
      value.paymentHistoryStatus !== 'incomplete') ||
    !isBoundedInteger(value.settledInvoiceCount, 0, Number.MAX_SAFE_INTEGER) ||
    (value.email !== null && typeof value.email !== 'string') ||
    (value.phone !== null && typeof value.phone !== 'string')
  )
    return null;

  const net = value.grossReceivableCents - value.issuedCreditCents;
  if (
    value.outstandingCents !== Math.max(0, net) ||
    value.customerCreditCents !== Math.max(0, -net) ||
    (value.paymentHistoryStatus === 'known'
      ? value.avgDelayDays === null ||
        value.paidOnTimeRatio === null ||
        value.settledInvoiceCount < 3
      : value.avgDelayDays !== null || value.paidOnTimeRatio !== null)
  )
    return null;

  return value as unknown as CustomerListItem;
}

function decodeCustomerList(value: unknown): CustomerListItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: CustomerListItem[] = [];
  for (const candidate of value) {
    const item = decodeCustomerListItem(candidate);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/** Allowlist réseau explicite (création ET édition — même forme, cf. CustomersController) : un
 * objet élargi à l'exécution ne fait jamais fuiter un champ non prévu vers l'API. */
function customerClientBody(
  input: CreateCustomerClientInput | UpdateCustomerClientInput,
): CreateCustomerClientInput {
  return {
    type: input.type,
    name: input.name,
    address: { ...input.address },
    ...(input.siren !== undefined ? { siren: input.siren } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
    ...(input.paymentTermsLabel !== undefined
      ? { paymentTermsLabel: input.paymentTermsLabel }
      : {}),
    ...(input.isInternational !== undefined ? { isInternational: input.isInternational } : {}),
    ...(input.isSubcontractingBtp !== undefined
      ? { isSubcontractingBtp: input.isSubcontractingBtp }
      : {}),
  };
}

function decodeCatalogueItem(value: unknown): CatalogueItemView | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'label',
      'category',
      'unit',
      'unitPriceHT',
      'vatRate',
      'revision',
      'createdAt',
      'updatedAt',
    ]) ||
    !isBoundedInteger(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalIsoTimestamp(value.updatedAt)
  )
    return null;
  const item = parseCustomPrestation({
    id: value.id,
    label: value.label,
    category: value.category,
    unit: value.unit,
    unitPriceHT: value.unitPriceHT,
    vatRate: value.vatRate,
  });
  return item === null
    ? null
    : {
        ...item,
        revision: value.revision,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      };
}

function decodeCatalogueItems(value: unknown): readonly CatalogueItemView[] | null {
  if (!Array.isArray(value)) return null;
  const items: CatalogueItemView[] = [];
  for (const candidate of value) {
    const item = decodeCatalogueItem(candidate);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function decodeCatalogueDeletion(value: unknown): CatalogueDeletionView | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'deleted']) ||
    !isCustomPrestationId(value.id) ||
    value.deleted !== true
  )
    return null;
  return { id: value.id, deleted: true };
}

const ACCOUNTING_PREVIEW_LINE_FIELDS = ['account', 'label', 'debitCents', 'creditCents'] as const;

function decodeAccountingPreviewLine(value: unknown): AccountingPreviewLine | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ACCOUNTING_PREVIEW_LINE_FIELDS) ||
    typeof value.account !== 'string' ||
    value.account.trim() !== value.account ||
    value.account.length === 0 ||
    typeof value.label !== 'string' ||
    value.label.trim() !== value.label ||
    value.label.length === 0 ||
    !isBoundedInteger(value.debitCents, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.creditCents, 0, Number.MAX_SAFE_INTEGER) ||
    value.debitCents > 0 === value.creditCents > 0
  )
    return null;
  return {
    account: value.account,
    label: value.label,
    debitCents: value.debitCents,
    creditCents: value.creditCents,
  };
}

function decodeAccountingPreviewLines(value: unknown): AccountingPreviewLine[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lines: AccountingPreviewLine[] = [];
  for (const candidate of value) {
    const line = decodeAccountingPreviewLine(candidate);
    if (line === null) return null;
    lines.push(line);
  }
  return lines;
}

function sumAccountingSide(
  lines: readonly AccountingPreviewLine[],
  side: 'debitCents' | 'creditCents',
): number | null {
  let total = 0;
  for (const line of lines) {
    if (total > Number.MAX_SAFE_INTEGER - line[side]) return null;
    total += line[side];
  }
  return total;
}

function isCanonicalDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function isNonEmptyCanonicalString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function decodeInvoiceAccountingPreview(
  value: unknown,
  expectedInvoiceId: string,
): InvoiceAccountingPreview | null {
  if (!isRecord(value) || value.invoiceId !== expectedInvoiceId) return null;
  if (value.available === false) {
    if (
      !hasExactKeys(value, ['invoiceId', 'available', 'reason']) ||
      !isNonEmptyCanonicalString(value.reason)
    )
      return null;
    return { invoiceId: expectedInvoiceId, available: false, reason: value.reason };
  }
  if (
    value.available !== true ||
    !hasExactKeys(value, [
      'invoiceId',
      'available',
      'entryId',
      'reference',
      'entryDate',
      'label',
      'totalDebitCents',
      'totalCreditCents',
      'lines',
    ]) ||
    !isNonEmptyCanonicalString(value.entryId) ||
    !isNonEmptyCanonicalString(value.reference) ||
    !isCanonicalDateOnly(value.entryDate) ||
    !isNonEmptyCanonicalString(value.label) ||
    !isBoundedInteger(value.totalDebitCents, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.totalCreditCents, 1, Number.MAX_SAFE_INTEGER)
  )
    return null;
  const lines = decodeAccountingPreviewLines(value.lines);
  if (lines === null) return null;
  const totalDebitCents = sumAccountingSide(lines, 'debitCents');
  const totalCreditCents = sumAccountingSide(lines, 'creditCents');
  if (
    totalDebitCents === null ||
    totalCreditCents === null ||
    totalDebitCents !== value.totalDebitCents ||
    totalCreditCents !== value.totalCreditCents ||
    totalDebitCents !== totalCreditCents
  )
    return null;
  return {
    invoiceId: expectedInvoiceId,
    available: true,
    entryId: value.entryId,
    reference: value.reference,
    entryDate: value.entryDate,
    label: value.label,
    totalDebitCents,
    totalCreditCents,
    lines,
  };
}

function decodePaymentAccountingPreview(
  value: unknown,
  expected: { invoiceId: string; amountCents: number; method: PaymentMethod },
): PaymentAccountingPreview | null {
  if (!isRecord(value) || value.invoiceId !== expected.invoiceId) return null;
  if (value.available === false) {
    if (
      !hasExactKeys(value, ['invoiceId', 'available', 'reason']) ||
      !isNonEmptyCanonicalString(value.reason)
    )
      return null;
    return { invoiceId: expected.invoiceId, available: false, reason: value.reason };
  }
  if (
    value.available !== true ||
    !hasExactKeys(value, [
      'invoiceId',
      'available',
      'reference',
      'amountCents',
      'remainingCents',
      'method',
      'totalDebitCents',
      'totalCreditCents',
      'lines',
    ]) ||
    value.amountCents !== expected.amountCents ||
    value.method !== expected.method ||
    !isNonEmptyCanonicalString(value.reference) ||
    !isBoundedInteger(value.amountCents, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.remainingCents, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.totalDebitCents, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.totalCreditCents, 1, Number.MAX_SAFE_INTEGER)
  )
    return null;
  const lines = decodeAccountingPreviewLines(value.lines);
  if (lines === null) return null;
  const totalDebitCents = sumAccountingSide(lines, 'debitCents');
  const totalCreditCents = sumAccountingSide(lines, 'creditCents');
  if (
    totalDebitCents === null ||
    totalCreditCents === null ||
    totalDebitCents !== value.totalDebitCents ||
    totalCreditCents !== value.totalCreditCents ||
    totalDebitCents !== totalCreditCents ||
    totalDebitCents !== expected.amountCents
  )
    return null;
  return {
    invoiceId: expected.invoiceId,
    available: true,
    reference: value.reference,
    amountCents: value.amountCents,
    remainingCents: value.remainingCents,
    method: expected.method,
    totalDebitCents,
    totalCreditCents,
    lines,
  };
}

function isMistralRealtimeWebsocketUrl(
  value: unknown,
  expectedApiBaseUrl: string,
): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    const api = new URL(expectedApiBaseUrl);
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/v1/voice/realtime/mistral'
    )
      return false;
    const sameAuthority = url.hostname === api.hostname && url.port === api.port;
    if (!sameAuthority) return false;
    if (api.protocol === 'https:') return url.protocol === 'wss:';
    const loopback =
      api.protocol === 'http:' &&
      (api.hostname === 'localhost' || api.hostname === '127.0.0.1' || api.hostname === '[::1]');
    return loopback && url.protocol === 'ws:';
  } catch {
    return false;
  }
}

function isRealtimeSpeechAudioUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function decodeRealtimeVoiceControlReference(value: unknown): RealtimeVoiceControlReference | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['turnId', 'acknowledgementId', 'contextRevision', 'contextDigest']) ||
    typeof value.turnId !== 'string' ||
    !UUID_PATTERN.test(value.turnId) ||
    typeof value.acknowledgementId !== 'string' ||
    !UUID_PATTERN.test(value.acknowledgementId) ||
    !isBoundedInteger(value.contextRevision, 1, 2_147_483_647) ||
    typeof value.contextDigest !== 'string' ||
    !SHA_256_PATTERN.test(value.contextDigest)
  )
    return null;
  return {
    turnId: value.turnId,
    acknowledgementId: value.acknowledgementId,
    contextRevision: value.contextRevision,
    contextDigest: value.contextDigest,
  };
}

function decodeRealtimeVoiceSpeechBinding(value: Record<string, unknown>): {
  artifactId: string;
  turnId: string;
  sequence: number;
  contextRevision: number;
  contextDigest: string;
} | null {
  if (
    typeof value.artifactId !== 'string' ||
    !UUID_PATTERN.test(value.artifactId) ||
    typeof value.turnId !== 'string' ||
    !UUID_PATTERN.test(value.turnId) ||
    !isBoundedInteger(value.sequence, 1, REALTIME_SPEECH_MAX_SEQUENCE) ||
    !isBoundedInteger(value.contextRevision, 1, 2_147_483_647) ||
    typeof value.contextDigest !== 'string' ||
    !SHA_256_PATTERN.test(value.contextDigest)
  )
    return null;
  return {
    artifactId: value.artifactId,
    turnId: value.turnId,
    sequence: value.sequence,
    contextRevision: value.contextRevision,
    contextDigest: value.contextDigest,
  };
}

function decodeRealtimeVoiceSpeechFeed(
  status: number,
  value: unknown,
): RealtimeVoiceSpeechFeed | null {
  if (status === 204) return value === undefined ? { status: 'none' } : null;
  if (!isRecord(value)) return null;
  const binding = decodeRealtimeVoiceSpeechBinding(value);
  if (!binding) return null;
  if (
    status === 202 &&
    value.status === 'rendering' &&
    hasExactKeys(value, [
      'status',
      'artifactId',
      'turnId',
      'sequence',
      'contextRevision',
      'contextDigest',
    ])
  )
    return { status: 'rendering', ...binding };
  if (
    status === 200 &&
    hasExactKeys(value, [
      'artifactId',
      'turnId',
      'audioUrl',
      'audioSha256',
      'mimeType',
      'byteSize',
      'durationMs',
      'sequence',
      'contextRevision',
      'contextDigest',
    ]) &&
    isRealtimeSpeechAudioUrl(value.audioUrl) &&
    typeof value.audioSha256 === 'string' &&
    SHA_256_PATTERN.test(value.audioSha256) &&
    typeof value.mimeType === 'string' &&
    REALTIME_SPEECH_MIME_TYPES.has(value.mimeType as RealtimeVoiceSpeechMimeType) &&
    isBoundedInteger(
      value.byteSize,
      REALTIME_SPEECH_MIN_AUDIO_BYTES,
      REALTIME_SPEECH_MAX_AUDIO_BYTES,
    ) &&
    isBoundedInteger(
      value.durationMs,
      REALTIME_SPEECH_MIN_DURATION_MS,
      REALTIME_SPEECH_MAX_DURATION_MS,
    )
  ) {
    return {
      status: 'ready',
      ...binding,
      audioUrl: value.audioUrl,
      audioSha256: value.audioSha256,
      mimeType: value.mimeType as RealtimeVoiceSpeechMimeType,
      byteSize: value.byteSize,
      durationMs: value.durationMs,
    };
  }
  if (
    status === 410 &&
    value.status === 'terminal' &&
    (value.reason === 'cancelled' ||
      value.reason === 'failed' ||
      value.reason === 'expired' ||
      value.reason === 'delivered') &&
    hasExactKeys(value, [
      'status',
      'artifactId',
      'turnId',
      'sequence',
      'reason',
      'contextRevision',
      'contextDigest',
    ])
  )
    return { status: 'terminal', ...binding, reason: value.reason };
  return null;
}

function decodeRealtimeVoiceSpeechDelivery(
  status: number,
  value: unknown,
  expectedTurnId: string,
): RealtimeVoiceSpeechDeliveryAcknowledgement | null {
  if (status !== 200) return null;
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  if (hasExactKeys(value, [])) return {};
  if (!hasExactKeys(value, ['controlReference'])) return null;
  const controlReference = decodeRealtimeVoiceControlReference(value.controlReference);
  return controlReference?.turnId === expectedTurnId ? { controlReference } : null;
}

function isBoundedString(value: unknown, maxLength = 1_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function decodeHttpAppError(value: unknown): AppError | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const error = value.error;
  if (
    error.kind === 'not_found' &&
    hasExactKeys(error, ['kind', 'entity', 'id']) &&
    isBoundedString(error.entity, 120) &&
    isBoundedString(error.id, 200)
  )
    return { kind: 'not_found', entity: error.entity, id: error.id };
  if (
    error.kind === 'conflict' &&
    hasExactKeys(error, ['kind', 'entity', 'reason']) &&
    isBoundedString(error.entity, 120) &&
    isBoundedString(error.reason)
  )
    return { kind: 'conflict', entity: error.entity, reason: error.reason };
  if (
    error.kind === 'forbidden' &&
    hasExactKeys(error, ['kind', 'reason']) &&
    isBoundedString(error.reason)
  )
    return { kind: 'forbidden', reason: error.reason };
  if (
    error.kind === 'rate_limited' &&
    hasExactKeys(error, ['kind', 'reason', 'retryAfterSeconds']) &&
    isBoundedString(error.reason) &&
    isBoundedInteger(error.retryAfterSeconds, 0, 86_400)
  ) {
    return {
      kind: 'rate_limited',
      reason: error.reason,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (
    error.kind === 'unavailable' &&
    (hasExactKeys(error, ['kind', 'service']) ||
      hasExactKeys(error, ['kind', 'service', 'retryAfterSeconds'])) &&
    isBoundedString(error.service, 120) &&
    (error.retryAfterSeconds === undefined || isBoundedInteger(error.retryAfterSeconds, 0, 86_400))
  ) {
    return {
      kind: 'unavailable',
      service: error.service,
      ...(typeof error.retryAfterSeconds === 'number'
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
  if (
    error.kind === 'dependency' &&
    hasExactKeys(error, ['kind', 'port', 'cause']) &&
    isBoundedString(error.port, 120) &&
    isBoundedString(error.cause)
  )
    return { kind: 'dependency', port: error.port, cause: error.cause };
  if (
    error.kind === 'validation' &&
    hasExactKeys(error, ['kind', 'issues']) &&
    Array.isArray(error.issues) &&
    error.issues.length > 0 &&
    error.issues.length <= 20
  ) {
    const issues = error.issues.map((issue) => {
      if (
        !isRecord(issue) ||
        !hasExactKeys(issue, ['field', 'message']) ||
        !isBoundedString(issue.field, 160) ||
        !isBoundedString(issue.message)
      )
        return null;
      return { field: issue.field, message: issue.message };
    });
    if (issues.every((issue): issue is { field: string; message: string } => issue !== null)) {
      return { kind: 'validation', issues };
    }
  }
  return null;
}

async function readBoundedJsonBody(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new Error('Corps HTTP Bob Live trop volumineux.');
    }
  }

  let raw: string;
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let byteLength = 0;
    let text = '';
    try {
      let reading = true;
      while (reading) {
        const chunk = await reader.read();
        if (chunk.done) {
          reading = false;
          continue;
        }
        byteLength += chunk.value.byteLength;
        if (byteLength > maxBytes) {
          await reader.cancel();
          throw new Error('Corps HTTP Bob Live trop volumineux.');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      raw = text + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else {
    raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > maxBytes) {
      throw new Error('Corps HTTP Bob Live trop volumineux.');
    }
  }

  if (raw.length === 0) return undefined;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const mediaType = contentType.split(';', 1)[0]?.trim();
  if (mediaType !== 'application/json') {
    throw new Error('Type de réponse HTTP Bob Live invalide.');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('JSON Bob Live invalide.');
  }
}

function invalidRealtimeSpeechInput<T>(
  field: string,
  message: string,
): Promise<Result<T, AppError>> {
  return Promise.resolve({
    ok: false,
    error: { kind: 'validation', issues: [{ field, message }] },
  });
}

function decodeRealtimeVoiceConfig(value: unknown): RealtimeVoiceConfig | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.available !== 'boolean' ||
    (value.transport !== 'webrtc' && value.transport !== 'mistral-pcm') ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    value.model.length > 100 ||
    (value.voice !== 'marin' && value.voice !== 'cedar') ||
    typeof value.configVersion !== 'string' ||
    !/^bob-live-[a-z0-9-]{1,80}$/.test(value.configVersion) ||
    value.requiresDevelopmentBuild !== true ||
    typeof value.maxSessionSeconds !== 'number' ||
    !Number.isInteger(value.maxSessionSeconds) ||
    value.maxSessionSeconds < 60 ||
    value.maxSessionSeconds > 900 ||
    value.speechDelivery !== 'audited-signed-url-v1' ||
    (value.availabilityReason !== undefined &&
      value.availabilityReason !== 'disabled' &&
      value.availabilityReason !== 'not_entitled' &&
      value.availabilityReason !== 'entitlement_unavailable')
  )
    return null;
  const availabilityReason =
    value.availabilityReason === 'disabled' ||
    value.availabilityReason === 'not_entitled' ||
    value.availabilityReason === 'entitlement_unavailable'
      ? value.availabilityReason
      : null;
  return {
    available: value.available,
    ...(availabilityReason === null ? {} : { availabilityReason }),
    transport: value.transport,
    model: value.model,
    voice: value.voice,
    configVersion: value.configVersion,
    requiresDevelopmentBuild: true,
    maxSessionSeconds: value.maxSessionSeconds,
    speechDelivery: 'audited-signed-url-v1',
  };
}

function decodeRealtimeSpeechSourcePolicy(
  value: unknown,
  expectedCompanyId: string,
  expectedSessionHandle: string,
): import('./client').RealtimeVoiceSpeechSourcePolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, ['mode', 'allowedOrigin', 'allowedPathPrefix'])) {
    return null;
  }
  if (
    value.mode !== 'signed-url-v1' ||
    typeof value.allowedOrigin !== 'string' ||
    typeof value.allowedPathPrefix !== 'string' ||
    value.allowedOrigin.length > 2_048 ||
    value.allowedPathPrefix.length > 2_048
  )
    return null;
  let origin: URL;
  let fullPrefix: URL;
  try {
    origin = new URL(value.allowedOrigin);
    fullPrefix = new URL(value.allowedPathPrefix, value.allowedOrigin);
  } catch {
    return null;
  }
  const loopback =
    origin.protocol === 'http:' &&
    (origin.hostname === 'localhost' ||
      origin.hostname === '127.0.0.1' ||
      origin.hostname === '[::1]');
  if (
    (origin.protocol !== 'https:' && !loopback) ||
    origin.origin !== value.allowedOrigin ||
    origin.pathname !== '/' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    fullPrefix.origin !== value.allowedOrigin ||
    fullPrefix.pathname !== value.allowedPathPrefix ||
    fullPrefix.search !== '' ||
    fullPrefix.hash !== '' ||
    !value.allowedPathPrefix.startsWith('/') ||
    !value.allowedPathPrefix.endsWith('/') ||
    value.allowedPathPrefix.includes('%')
  )
    return null;
  const segments = value.allowedPathPrefix.split('/');
  if (segments[0] !== '' || segments.at(-1) !== '') return null;
  const body = segments.slice(1, -1);
  if (body.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(segment))) return null;
  const tail = body.slice(-9);
  if (
    tail.length !== 9 ||
    tail[0] !== 'storage' ||
    tail[1] !== 'v1' ||
    tail[2] !== 'object' ||
    tail[3] !== 'sign' ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(tail[4] ?? '') ||
    tail[5] !== 'companies' ||
    tail[6] !== expectedCompanyId ||
    tail[7] !== 'bob-live' ||
    tail[8] !== expectedSessionHandle
  )
    return null;
  return {
    mode: 'signed-url-v1',
    allowedOrigin: value.allowedOrigin,
    allowedPathPrefix: value.allowedPathPrefix,
  };
}

function decodeRealtimeVoiceCall(
  value: unknown,
  expectedCompanyId: string,
  expectedApiBaseUrl: string,
): RealtimeVoiceCall | null {
  if (!isRecord(value)) return null;
  const commonKeys = [
    'transport',
    'sessionHandle',
    'hardExpiresAt',
    'model',
    'voice',
    'configVersion',
    'maxSessionSeconds',
    'speechSourcePolicy',
  ] as const;
  if (
    typeof value.sessionHandle !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.sessionHandle,
    ) ||
    !isCanonicalIsoTimestamp(value.hardExpiresAt) ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    value.model.length > 100 ||
    (value.voice !== 'marin' && value.voice !== 'cedar') ||
    typeof value.configVersion !== 'string' ||
    !/^bob-live-[a-z0-9-]{1,80}$/.test(value.configVersion) ||
    typeof value.maxSessionSeconds !== 'number' ||
    !Number.isInteger(value.maxSessionSeconds) ||
    value.maxSessionSeconds < 60 ||
    value.maxSessionSeconds > 900
  )
    return null;

  const speechSourcePolicy = decodeRealtimeSpeechSourcePolicy(
    value.speechSourcePolicy,
    expectedCompanyId,
    value.sessionHandle,
  );
  if (!speechSourcePolicy) return null;

  const common = {
    sessionHandle: value.sessionHandle,
    hardExpiresAt: value.hardExpiresAt,
    model: value.model,
    voice: value.voice,
    configVersion: value.configVersion,
    maxSessionSeconds: value.maxSessionSeconds,
    speechSourcePolicy,
  } as const;

  if (value.transport === 'webrtc') {
    if (
      !hasExactKeys(value, [...commonKeys, 'answerSdp']) ||
      typeof value.answerSdp !== 'string' ||
      value.answerSdp.length < 16 ||
      value.answerSdp.length > 256 * 1024 ||
      !value.answerSdp.startsWith('v=0')
    )
      return null;
    return { transport: 'webrtc', answerSdp: value.answerSdp, ...common };
  }

  if (value.transport === 'mistral-pcm') {
    if (
      !hasExactKeys(value, [
        ...commonKeys,
        'websocketUrl',
        'companyId',
        'ticket',
        'protocol',
        'ticketExpiresAt',
        'maxAudioBytes',
        'contextRevision',
        'contextDigest',
      ]) ||
      !isMistralRealtimeWebsocketUrl(value.websocketUrl, expectedApiBaseUrl) ||
      typeof value.companyId !== 'string' ||
      !COMPANY_ID_PATTERN.test(value.companyId) ||
      value.companyId !== expectedCompanyId ||
      typeof value.ticket !== 'string' ||
      !MISTRAL_REALTIME_TICKET_PATTERN.test(value.ticket) ||
      value.protocol !== 'bob.mistral-pcm.v1' ||
      !isCanonicalIsoTimestamp(value.ticketExpiresAt) ||
      Date.parse(value.ticketExpiresAt) > Date.parse(value.hardExpiresAt) ||
      !isBoundedInteger(value.maxAudioBytes, 32_000, 28_800_000) ||
      value.maxAudioBytes % 2 !== 0 ||
      !isBoundedInteger(value.contextRevision, 1, 2_147_483_647) ||
      typeof value.contextDigest !== 'string' ||
      !SHA_256_PATTERN.test(value.contextDigest)
    )
      return null;
    return {
      transport: 'mistral-pcm',
      websocketUrl: value.websocketUrl,
      companyId: value.companyId,
      ticket: value.ticket,
      protocol: value.protocol,
      ticketExpiresAt: value.ticketExpiresAt,
      maxAudioBytes: value.maxAudioBytes,
      contextRevision: value.contextRevision,
      contextDigest: value.contextDigest,
      ...common,
    };
  }
  return null;
}

function decodeRealtimeVoiceControlAcknowledgement(
  value: unknown,
): RealtimeVoiceControlAcknowledgement | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    'turnId',
    'acknowledgementId',
    'kind',
    'contextRevision',
    'contextDigest',
    'navigate',
    'proposalId',
    'proposalExpiresAt',
  ]);
  const required = ['turnId', 'acknowledgementId', 'kind', 'contextRevision', 'contextDigest'];
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.turnId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.turnId,
    ) ||
    typeof value.acknowledgementId !== 'string' ||
    !UUID_PATTERN.test(value.acknowledgementId) ||
    (value.kind !== 'answer' && value.kind !== 'proposed' && value.kind !== 'done') ||
    !Number.isSafeInteger(value.contextRevision) ||
    (value.contextRevision as number) < 1 ||
    (value.contextRevision as number) > 2_147_483_647 ||
    typeof value.contextDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contextDigest) ||
    (value.navigate !== undefined && !isAllowedAgentNavigationRoute(value.navigate)) ||
    (value.proposalId !== undefined &&
      (typeof value.proposalId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.proposalId,
        ))) ||
    (value.proposalExpiresAt !== undefined &&
      (typeof value.proposalExpiresAt !== 'string' ||
        value.proposalExpiresAt.length > 40 ||
        !Number.isFinite(Date.parse(value.proposalExpiresAt)) ||
        value.proposalId === undefined))
  )
    return null;
  return {
    turnId: value.turnId,
    acknowledgementId: value.acknowledgementId,
    kind: value.kind,
    contextRevision: value.contextRevision as number,
    contextDigest: value.contextDigest,
    ...(typeof value.navigate === 'string' ? { navigate: value.navigate } : {}),
    ...(typeof value.proposalId === 'string' ? { proposalId: value.proposalId } : {}),
    ...(typeof value.proposalExpiresAt === 'string'
      ? { proposalExpiresAt: value.proposalExpiresAt }
      : {}),
  };
}

/**
 * Implémentation HTTP de BobClient : parle au backend NestJS.
 * Brancher le backend = `new BobClientProvider client={new HttpBobClient(...)}` — aucun écran touché.
 */
export class HttpBobClient implements BobClient {
  readonly companyId: string;

  constructor(private readonly opts: HttpBobClientOptions) {
    assertSecureApiBaseUrl(opts.baseUrl);
    this.companyId = opts.companyId;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    decode?: (value: unknown) => T | null,
    timeoutMs?: number,
    externalSignal?: AbortSignal,
  ): Promise<Result<T, AppError>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort: (() => void) | undefined;
    try {
      if (externalSignal?.aborted) throw new Error('Requête annulée.');
      const controller =
        timeoutMs === undefined && externalSignal === undefined ? null : new AbortController();
      const externalDeadline =
        externalSignal === undefined
          ? null
          : new Promise<never>((_resolve, reject) => {
              const abort = (): void => {
                controller?.abort();
                reject(new Error('Requête annulée.'));
              };
              externalSignal.addEventListener('abort', abort, { once: true });
              removeExternalAbort = () => externalSignal.removeEventListener('abort', abort);
            });
      const deadline =
        timeoutMs === undefined
          ? null
          : new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                controller?.abort();
                reject(new Error(`Délai réseau dépassé après ${timeoutMs} ms.`));
              }, timeoutMs);
            });
      const withinDeadline = <V>(operation: Promise<V>): Promise<V> => {
        const boundaries = [operation];
        if (deadline) boundaries.push(deadline);
        if (externalDeadline) boundaries.push(externalDeadline);
        return boundaries.length === 1 ? operation : Promise.race(boundaries);
      };
      // Le budget couvre aussi la récupération du jeton : une auth locale bloquée ne doit pas
      // laisser l'interface attendre indéfiniment avant même que `fetch` puisse être annulé.
      const token = await withinDeadline(
        this.opts.getToken ? this.opts.getToken() : Promise.resolve(null),
      );
      if (externalSignal?.aborted) throw new Error('Requête annulée.');
      const init: RequestInit = {
        method,
        // Un 307/308 ne doit jamais rejouer token/secret de binding vers une autre origine.
        redirect: 'error',
        ...(controller ? { signal: controller.signal } : {}),
        headers: {
          'content-type': 'application/json',
          ...headers,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const requestUrl = `${this.opts.baseUrl}${path}`;
      const res = await withinDeadline(fetch(requestUrl, init));
      if (
        typeof res.url === 'string' &&
        res.url !== '' &&
        new URL(res.url).origin !== new URL(requestUrl).origin
      ) {
        throw new Error('Redirection API cross-origin refusée.');
      }
      const data: unknown = await withinDeadline(res.json());
      if (!res.ok) {
        const error: AppError =
          data && typeof data === 'object' && 'error' in data
            ? (data as { error: AppError }).error
            : { kind: 'dependency', port: 'api', cause: `HTTP ${res.status}` };
        return { ok: false, error };
      }
      if (decode) {
        const decoded = decode(data);
        if (decoded === null) {
          return {
            ok: false,
            error: {
              kind: 'dependency',
              port: 'api-contract',
              cause: `Réponse API invalide pour ${method} ${path}.`,
            },
          };
        }
        return { ok: true, value: decoded };
      }
      return { ok: true, value: data as T };
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'api',
          cause: e instanceof Error ? e.message : 'réseau',
        },
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeExternalAbort?.();
    }
  }

  /**
   * Requête dédiée au feed acoustique : elle préserve les états HTTP 204/410, borne réellement
   * le corps et propage l'annulation jusque dans la lecture du stream. Le helper générique `req`
   * suppose à l'inverse un JSON 2xx et ne peut donc pas porter ce protocole.
   */
  private async reqRealtimeSpeech<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    decode: (status: number, value: unknown) => T | null,
    signal?: AbortSignal,
  ): Promise<Result<T, AppError>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw new Error('Requête annulée.');
      const controller = new AbortController();
      const externalDeadline =
        signal === undefined
          ? null
          : new Promise<never>((_resolve, reject) => {
              const abort = (): void => {
                controller.abort();
                reject(new Error('Requête annulée.'));
              };
              signal.addEventListener('abort', abort, { once: true });
              removeExternalAbort = () => signal.removeEventListener('abort', abort);
            });
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Délai réseau dépassé après ${REALTIME_SPEECH_REQUEST_TIMEOUT_MS} ms.`));
        }, REALTIME_SPEECH_REQUEST_TIMEOUT_MS);
      });
      const withinDeadline = <V>(operation: Promise<V>): Promise<V> =>
        Promise.race([operation, deadline, ...(externalDeadline ? [externalDeadline] : [])]);
      const token = await withinDeadline(
        this.opts.getToken ? this.opts.getToken() : Promise.resolve(null),
      );
      if (signal?.aborted) throw new Error('Requête annulée.');
      const init: RequestInit = {
        method,
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: {
          accept: 'application/json',
          'cache-control': 'no-store',
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      const response = await withinDeadline(fetch(`${this.opts.baseUrl}${path}`, init));
      const data = await withinDeadline(
        readBoundedJsonBody(response, REALTIME_SPEECH_RESPONSE_MAX_BYTES),
      );
      const decoded = decode(response.status, data);
      if (decoded !== null) return { ok: true, value: decoded };
      if (!response.ok) {
        return {
          ok: false,
          error: decodeHttpAppError(data) ?? {
            kind: 'dependency',
            port: 'api',
            cause: `HTTP ${response.status}`,
          },
        };
      }
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'api-contract',
          cause: `Réponse API invalide pour ${method} ${path}.`,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'api',
          cause: error instanceof Error ? error.message : 'réseau',
        },
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeExternalAbort?.();
    }
  }

  private async reqText(
    path: string,
    timeoutMs = TEXT_EXPORT_TIMEOUT_MS,
  ): Promise<Result<{ content: string; headers: Headers; contentType: string | null }, AppError>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Délai réseau dépassé après ${timeoutMs} ms.`));
        }, timeoutMs);
      });
      const withinDeadline = <V>(operation: Promise<V>): Promise<V> =>
        Promise.race([operation, deadline]);
      const token = this.opts.getToken ? await withinDeadline(this.opts.getToken()) : null;
      const res = await withinDeadline(
        fetch(`${this.opts.baseUrl}${path}`, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        }),
      );
      const contentType = res.headers.get('content-type');
      const content = await withinDeadline(res.text());
      if (!res.ok) {
        try {
          const data = JSON.parse(content) as unknown;
          const error: AppError =
            data && typeof data === 'object' && 'error' in data
              ? (data as { error: AppError }).error
              : { kind: 'dependency', port: 'api', cause: `HTTP ${res.status}` };
          return { ok: false, error };
        } catch {
          return {
            ok: false,
            error: { kind: 'dependency', port: 'api', cause: `HTTP ${res.status}` },
          };
        }
      }
      return { ok: true, value: { content, headers: res.headers, contentType } };
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'dependency',
          port: 'api',
          cause: e instanceof Error ? e.message : 'réseau',
        },
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  getSubscription() {
    return this.req<SubscriptionView>('GET', '/subscription');
  }
  listSubscriptionInvoices() {
    return this.req<SubscriptionBillingInvoiceView[]>('GET', '/subscription/invoices');
  }
  getFiscalProfile() {
    return this.req<FiscalProfileView>('GET', '/fiscal-profile');
  }
  updateFiscalProfileField(field: string, value: unknown) {
    return this.req<FiscalProfileView>('PATCH', `/fiscal-profile/${encodeURIComponent(field)}`, {
      value,
    });
  }
  latestValueDigest() {
    return this.req<ValueDigestView>('GET', '/engagement/digest/latest');
  }
  /** Pilier 2 : bilan de fin d'essai — agrégats du digest CUMULÉS sur la période d'essai. */
  trialReport() {
    return this.req<TrialReportView>('GET', '/engagement/trial-report');
  }
  /** Pilier 2 : value_digest_opened — l'utilisateur a OUVERT le détail du digest (tap carte). */
  recordValueDigestOpened(highlightKind: 'money' | 'time' | 'volume') {
    return this.req<{ recorded: boolean }>('POST', '/engagement/digest/opened', { highlightKind });
  }
  startCheckout(tier: PlanTier) {
    return this.req<{ url: string }>('POST', '/subscription/checkout', { tier });
  }
  billingPortal() {
    return this.req<{ url: string }>('POST', '/subscription/portal');
  }
  closeAccount(input: { confirmationText: string; reason?: string }) {
    return this.req<{ closedAt: string }>('DELETE', '/account', input);
  }
  invoicePaymentLink(invoiceId: string) {
    return this.req<{ url: string }>('POST', `/invoices/${invoiceId}/payment-link`);
  }
  getDiagnostic() {
    return this.req<DiagnosticResult>('GET', '/diagnostic');
  }
  getDiagnosticAssessment() {
    return this.req<DiagnosticAssessmentView>('GET', '/diagnostic/assessment');
  }
  saveDiagnosticAssessment(input: DiagnosticAssessmentWriteRequest) {
    return this.req<DiagnosticAssessmentView>('PUT', '/diagnostic/assessment', input);
  }
  /** C-EXP5b : échéancier fiscal du tenant, servi par le serveur (deriveFiscalCalendar). */
  getFiscalCalendar() {
    return this.req<FiscalDeadline[]>('GET', '/fiscal-calendar');
  }
  getProfile() {
    return this.req<TradeConfig>('GET', '/profile');
  }
  /** PONT-SERVEUR v1 : la fiche société du tenant (CompanyProps complet) — l'identité connectée lit la BDD. */
  getCompanyMe() {
    return this.req<CompanyProps>('GET', '/company/me');
  }
  updateCompanyProfile(input: {
    trade: Trade;
    vatRegime: VatRegime;
    customerPortfolio?: CustomerPortfolio;
  }) {
    return this.req<CompanyProps>('PATCH', '/company/profile', input);
  }
  updateCompanyBilling(input: { iban?: string | null; bic?: string | null }) {
    return this.req<CompanyProps>('PATCH', '/company/billing', input);
  }
  getCompanyBillingSettings() {
    return this.req<CompanyBillingSettings>(
      'GET',
      '/company/billing-settings',
      undefined,
      undefined,
      decodeCompanyBillingSettings,
    );
  }
  updateCompanyBillingSettings(input: {
    expectedRevision: number;
    patch: CompanyBillingSettingsPatch;
  }) {
    return this.req<CompanyBillingSettings>(
      'PATCH',
      '/company/billing-settings',
      {
        expectedRevision: input.expectedRevision,
        ...input.patch,
      },
      undefined,
      decodeCompanyBillingSettings,
    );
  }
  lookupCompany(siret: string) {
    return this.req<CompanyLookupResult>(
      'GET',
      `/company/lookup?siret=${encodeURIComponent(siret)}`,
    );
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
  realtimeVoiceConfig() {
    return this.req<RealtimeVoiceConfig>(
      'GET',
      '/voice/realtime/config',
      undefined,
      undefined,
      decodeRealtimeVoiceConfig,
      REALTIME_BOOTSTRAP_TIMEOUT_MS,
    );
  }
  createRealtimeVoiceCall(input: RealtimeVoiceCallInput, signal?: AbortSignal) {
    const body =
      input.transport === 'mistral-pcm'
        ? {
            context: input.context,
            ...(input.sessionHandle === undefined ? {} : { sessionHandle: input.sessionHandle }),
          }
        : {
            sdp: input.sdp,
            ...(input.sessionHandle === undefined ? {} : { sessionHandle: input.sessionHandle }),
          };
    return this.req<RealtimeVoiceCall>(
      'POST',
      '/voice/realtime/calls',
      body,
      undefined,
      (value) => decodeRealtimeVoiceCall(value, this.companyId, this.opts.baseUrl),
      REALTIME_BOOTSTRAP_TIMEOUT_MS,
      signal,
    );
  }
  hangupRealtimeVoiceCall(sessionHandle: string, signal?: AbortSignal) {
    return this.req<{ ended: true }>(
      'DELETE',
      `/voice/realtime/calls/${encodeURIComponent(sessionHandle)}`,
      undefined,
      undefined,
      (value) => (isRecord(value) && value.ended === true ? { ended: true } : null),
      REALTIME_BOOTSTRAP_TIMEOUT_MS,
      signal,
    );
  }
  updateRealtimeVoiceContext(
    sessionHandle: string,
    input: RealtimeVoiceContextUpdate,
    signal?: AbortSignal,
  ) {
    return this.req<{ revision: number; contextDigest: string }>(
      'PUT',
      `/voice/realtime/calls/${encodeURIComponent(sessionHandle)}/context`,
      input,
      undefined,
      (value) =>
        isRecord(value) &&
        Number.isSafeInteger(value.revision) &&
        (value.revision as number) >= 1 &&
        typeof value.contextDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(value.contextDigest)
          ? { revision: value.revision as number, contextDigest: value.contextDigest }
          : null,
      REALTIME_BOOTSTRAP_TIMEOUT_MS,
      signal,
    );
  }
  acknowledgeRealtimeVoiceControl(
    sessionHandle: string,
    input: RealtimeVoiceControlReference,
    signal?: AbortSignal,
  ) {
    if (!UUID_PATTERN.test(sessionHandle)) {
      return invalidRealtimeSpeechInput<RealtimeVoiceControlAcknowledgement>(
        'sessionHandle',
        'Le handle de session Bob Live doit être un UUID.',
      );
    }
    const reference = decodeRealtimeVoiceControlReference(input);
    if (!reference) {
      return invalidRealtimeSpeechInput<RealtimeVoiceControlAcknowledgement>(
        'controlReference',
        'La référence de contrôle Bob Live doit être liée à un acquittement audio valide.',
      );
    }
    return this.req<RealtimeVoiceControlAcknowledgement>(
      'POST',
      `/voice/realtime/calls/${encodeURIComponent(sessionHandle)}/control-acknowledgements`,
      reference,
      undefined,
      decodeRealtimeVoiceControlAcknowledgement,
      REALTIME_CONTROL_ACK_TIMEOUT_MS,
      signal,
    );
  }
  getNextRealtimeVoiceSpeech(
    sessionHandle: string,
    input: RealtimeVoiceSpeechFeedInput,
    signal?: AbortSignal,
  ) {
    if (!UUID_PATTERN.test(sessionHandle)) {
      return invalidRealtimeSpeechInput<RealtimeVoiceSpeechFeed>(
        'sessionHandle',
        'Le handle de session Bob Live doit être un UUID.',
      );
    }
    if (
      !isRecord(input) ||
      !isBoundedInteger(input.afterSequence, 0, REALTIME_SPEECH_MAX_SEQUENCE)
    ) {
      return invalidRealtimeSpeechInput<RealtimeVoiceSpeechFeed>(
        'afterSequence',
        'La séquence Bob Live doit être un entier compris entre 0 et 2147483647.',
      );
    }
    const waitMs = input.waitMs ?? REALTIME_SPEECH_MAX_WAIT_MS;
    if (!isBoundedInteger(waitMs, 0, REALTIME_SPEECH_MAX_WAIT_MS)) {
      return invalidRealtimeSpeechInput<RealtimeVoiceSpeechFeed>(
        'waitMs',
        'Le long-poll Bob Live doit être compris entre 0 et 2500 ms.',
      );
    }
    const query = new URLSearchParams({
      afterSequence: String(input.afterSequence),
      waitMs: String(waitMs),
    });
    return this.reqRealtimeSpeech<RealtimeVoiceSpeechFeed>(
      'GET',
      `/voice/realtime/calls/${encodeURIComponent(sessionHandle)}/speech?${query.toString()}`,
      undefined,
      decodeRealtimeVoiceSpeechFeed,
      signal,
    );
  }
  acknowledgeRealtimeVoiceSpeechDelivery(
    sessionHandle: string,
    turnId: string,
    artifactId: string,
    input: RealtimeVoiceSpeechDeliveryInput,
    signal?: AbortSignal,
  ) {
    if (!UUID_PATTERN.test(sessionHandle)) {
      return invalidRealtimeSpeechInput<RealtimeVoiceSpeechDeliveryAcknowledgement>(
        'sessionHandle',
        'Le handle de session Bob Live doit être un UUID.',
      );
    }
    if (!UUID_PATTERN.test(turnId)) {
      return invalidRealtimeSpeechInput<RealtimeVoiceSpeechDeliveryAcknowledgement>(
        'turnId',
        'Le tour Bob Live doit être un UUID.',
      );
    }
    if (!UUID_PATTERN.test(artifactId)) {
      return invalidRealtimeSpeechInput<RealtimeVoiceSpeechDeliveryAcknowledgement>(
        'artifactId',
        'L’artefact vocal Bob Live doit être un UUID.',
      );
    }
    if (
      !isRecord(input) ||
      typeof input.deliveryId !== 'string' ||
      !UUID_PATTERN.test(input.deliveryId)
    ) {
      return invalidRealtimeSpeechInput<RealtimeVoiceSpeechDeliveryAcknowledgement>(
        'deliveryId',
        'L’identifiant de livraison Bob Live doit être un UUID.',
      );
    }
    if (typeof input.audioSha256 !== 'string' || !SHA_256_PATTERN.test(input.audioSha256)) {
      return invalidRealtimeSpeechInput<RealtimeVoiceSpeechDeliveryAcknowledgement>(
        'audioSha256',
        'L’empreinte audio Bob Live doit être un SHA-256 hexadécimal canonique.',
      );
    }
    return this.reqRealtimeSpeech<RealtimeVoiceSpeechDeliveryAcknowledgement>(
      'POST',
      `/voice/realtime/calls/${encodeURIComponent(sessionHandle)}/turns/${encodeURIComponent(turnId)}/speech/${encodeURIComponent(artifactId)}/deliveries`,
      { deliveryId: input.deliveryId, audioSha256: input.audioSha256 },
      (status, value) => decodeRealtimeVoiceSpeechDelivery(status, value, turnId),
      signal,
    );
  }
  async cancelRealtimeVoiceSpeech(
    sessionHandle: string,
    turnId: string,
    artifactId: string,
    input: RealtimeVoiceSpeechCancellationInput,
    signal?: AbortSignal,
  ): Promise<Result<void, AppError>> {
    if (!UUID_PATTERN.test(sessionHandle)) {
      return invalidRealtimeSpeechInput<void>(
        'sessionHandle',
        'Le handle de session Bob Live doit être un UUID.',
      );
    }
    if (!UUID_PATTERN.test(turnId)) {
      return invalidRealtimeSpeechInput<void>('turnId', 'Le tour Bob Live doit être un UUID.');
    }
    if (!UUID_PATTERN.test(artifactId)) {
      return invalidRealtimeSpeechInput<void>(
        'artifactId',
        'L’artefact vocal Bob Live doit être un UUID.',
      );
    }
    if (
      !isRecord(input) ||
      typeof input.cancellationId !== 'string' ||
      !UUID_PATTERN.test(input.cancellationId)
    ) {
      return invalidRealtimeSpeechInput<void>(
        'cancellationId',
        'L’identifiant d’annulation Bob Live doit être un UUID.',
      );
    }
    if (
      typeof input.reason !== 'string' ||
      !REALTIME_SPEECH_CANCELLATION_REASONS.has(
        input.reason as RealtimeVoiceSpeechCancellationReason,
      )
    ) {
      return invalidRealtimeSpeechInput<void>(
        'reason',
        'Le motif d’annulation Bob Live n’appartient pas à l’allowlist.',
      );
    }
    const result = await this.reqRealtimeSpeech<true>(
      'POST',
      `/voice/realtime/calls/${encodeURIComponent(sessionHandle)}/turns/${encodeURIComponent(turnId)}/speech/${encodeURIComponent(artifactId)}/cancellations`,
      { cancellationId: input.cancellationId, reason: input.reason },
      (status, value) => (status === 204 && value === undefined ? true : null),
      signal,
    );
    return result.ok ? { ok: true, value: undefined } : result;
  }
  listDocuments(input: ListDocumentsClientInput = {}) {
    const params = new URLSearchParams();
    if (input.kind !== undefined) params.set('kind', input.kind);
    if (input.linkedEntityType !== undefined)
      params.set('linkedEntityType', input.linkedEntityType);
    if (input.linkedEntityId !== undefined) params.set('linkedEntityId', input.linkedEntityId);
    if (input.folderId !== undefined) params.set('folderId', input.folderId ?? 'null');
    if (input.includeDeleted !== undefined)
      params.set('includeDeleted', String(input.includeDeleted));
    const qs = params.toString();
    return this.req<DocumentView[]>(
      'GET',
      `/documents${qs ? `?${qs}` : ''}`,
      undefined,
      undefined,
      (value) => decodeDocumentViewsForCompany(value, this.companyId),
      DOCUMENT_READ_TIMEOUT_MS,
    );
  }
  getDocument(documentId: string) {
    return this.req<DocumentView>(
      'GET',
      `/documents/${encodeURIComponent(documentId)}`,
      undefined,
      undefined,
      (value) => decodeDocumentViewForContext(value, { companyId: this.companyId, documentId }),
      DOCUMENT_READ_TIMEOUT_MS,
    );
  }
  uploadDocument(input: UploadDocumentClientInput) {
    return this.req<DocumentView>(
      'POST',
      '/documents/upload',
      input,
      undefined,
      (value) =>
        decodeDocumentViewForContext(value, {
          companyId: this.companyId,
          ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
        }),
      DOCUMENT_UPLOAD_TIMEOUT_MS,
    );
  }
  createDocumentIntake(input: CreateDocumentIntakeClientInput) {
    return this.req<DocumentView>(
      'POST',
      '/documents/intakes',
      input,
      undefined,
      (value) => decodeDocumentViewForContext(value, { companyId: this.companyId }),
      DOCUMENT_UPLOAD_TIMEOUT_MS,
    );
  }
  listDocumentFolders(input: ListDocumentFoldersClientInput = {}) {
    const params = new URLSearchParams();
    if (input.parentId !== undefined) params.set('parentId', input.parentId ?? 'root');
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.cursor) params.set('cursor', input.cursor);
    const query = params.toString();
    return this.req<DocumentFolderPageView>(
      'GET',
      `/document-folders${query ? `?${query}` : ''}`,
      undefined,
      undefined,
      (value) =>
        decodeDocumentFolderPageForContext(value, {
          companyId: this.companyId,
          parentId: input.parentId ?? null,
        }),
      DOCUMENT_READ_TIMEOUT_MS,
    );
  }
  getDocumentFolder(folderId: string) {
    return this.req<DocumentFolderView>(
      'GET',
      `/document-folders/${encodeURIComponent(folderId)}`,
      undefined,
      undefined,
      (value) =>
        decodeDocumentFolderViewForContext(value, {
          companyId: this.companyId,
          folderId,
        }),
      DOCUMENT_READ_TIMEOUT_MS,
    );
  }
  createDocumentFolder(input: { name: string; parentId?: string | null }) {
    return this.req<DocumentFolderView>(
      'POST',
      '/document-folders',
      input,
      undefined,
      (value) =>
        decodeDocumentFolderViewForContext(value, {
          companyId: this.companyId,
          parentId: input.parentId ?? null,
        }),
      DOCUMENT_MUTATION_TIMEOUT_MS,
    );
  }
  updateDocumentFolder(input: {
    folderId: string;
    expectedRevision: number;
    name?: string;
    parentId?: string | null;
  }) {
    const { folderId, ...body } = input;
    return this.req<DocumentFolderView>(
      'PATCH',
      `/document-folders/${encodeURIComponent(folderId)}`,
      body,
      undefined,
      (value) =>
        decodeDocumentFolderViewForContext(value, {
          companyId: this.companyId,
          folderId,
          allowedRevisions: [input.expectedRevision, input.expectedRevision + 1],
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        }),
      DOCUMENT_MUTATION_TIMEOUT_MS,
    );
  }
  previewDocumentFolderDeletion(folderId: string) {
    return this.req<DocumentFolderDeletionPlanView>(
      'POST',
      `/document-folders/${encodeURIComponent(folderId)}/deletion-plans`,
      undefined,
      undefined,
      (value) => decodeDocumentFolderDeletionPlanForFolder(value, folderId),
      DOCUMENT_MUTATION_TIMEOUT_MS,
    );
  }
  executeDocumentFolderDeletion(input: { planId: string; strategy: DeleteDocumentFolderStrategy }) {
    return this.req<DocumentFolderDeletionExecutionView>(
      'POST',
      `/document-folder-deletion-plans/${encodeURIComponent(input.planId)}/executions`,
      { strategy: input.strategy },
      undefined,
      decodeDocumentFolderDeletionExecution,
      DOCUMENT_MUTATION_TIMEOUT_MS,
    );
  }
  moveDocumentToFolder(input: {
    documentId: string;
    folderId: string | null;
    expectedRevision: number;
  }) {
    const { documentId, ...body } = input;
    return this.req<{ documentId: string; folderId: string | null; revision: number }>(
      'PUT',
      `/documents/${encodeURIComponent(documentId)}/folder`,
      body,
      undefined,
      (value) => decodeDocumentMoveForContext(value, input),
      DOCUMENT_MUTATION_TIMEOUT_MS,
    );
  }
  analyzeDocument(documentId: string) {
    return this.req<DocumentAnalysis>(
      'POST',
      `/documents/${encodeURIComponent(documentId)}/analysis`,
      undefined,
      undefined,
      (value) => decodeDocumentAnalysisForDocument(value, documentId),
      DOCUMENT_ANALYSIS_TIMEOUT_MS,
    );
  }
  classifyDocument(input: ClassifyDocumentClientInput) {
    const { documentId, ...body } = input;
    return this.req<DocumentView>(
      'POST',
      `/documents/${encodeURIComponent(documentId)}/classify`,
      body,
      undefined,
      (value) =>
        decodeDocumentViewForContext(value, {
          companyId: this.companyId,
          documentId,
          linkedEntityType: input.linkedEntityType,
          linkedEntityId: input.linkedEntityId,
          allowedRevisions: [input.expectedRevision, input.expectedRevision + 1],
        }),
      DOCUMENT_MUTATION_TIMEOUT_MS,
    );
  }
  recordDocumentExpense(input: RecordDocumentExpenseClientInput) {
    const expense = {
      supplierName: input.expense.supplierName,
      documentDate: input.expense.documentDate,
      totalTtcCents: input.expense.totalTtcCents,
      category: input.expense.category,
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
      // Ticket déjà réglé : date + moyen uniquement — la preuve reste l'original, côté serveur.
      ...(input.expense.payment !== undefined
        ? {
            payment: input.expense.payment
              ? { paidOn: input.expense.payment.paidOn, method: input.expense.payment.method }
              : null,
          }
        : {}),
    };
    return this.req<RecordDocumentExpenseClientOutput>(
      'PUT',
      `/documents/${encodeURIComponent(input.documentId)}/expense`,
      {
        expectedRevision: input.expectedRevision,
        targetFolderId: input.targetFolderId,
        expense,
      },
      undefined,
      (value) =>
        decodeDocumentExpenseCreationForContext(value, {
          companyId: this.companyId,
          documentId: input.documentId,
          targetFolderId: input.targetFolderId,
          expectedRevision: input.expectedRevision,
        }),
      // Transaction DB courte. Une coupure libère l'UI ; la même commande est ensuite rejouée
      // grâce au registre SHA, sans présumer si le serveur avait déjà commité.
      15_000,
    );
  }
  documentDownloadUrl(documentId: string, ttlSeconds?: number) {
    const qs = ttlSeconds !== undefined ? `?ttl=${encodeURIComponent(String(ttlSeconds))}` : '';
    return this.req<DocumentDownloadUrl>(
      'GET',
      `/documents/${encodeURIComponent(documentId)}/download-url${qs}`,
      undefined,
      undefined,
      decodeDocumentDownloadUrl,
      DOCUMENT_READ_TIMEOUT_MS,
    );
  }
  extractDocument(input: { contentBase64: string; mimeType: string }) {
    return this.req<OcrExtraction>(
      'POST',
      '/documents/ocr',
      input,
      undefined,
      undefined,
      DOCUMENT_ANALYSIS_TIMEOUT_MS,
    );
  }
  suggestExpenseDefaults(input: SuggestExpenseDefaultsInput) {
    return this.req<ExpenseDefaultsView>('POST', '/expenses/defaults', input);
  }
  recordExpense(input: Omit<RecordExpenseInput, 'companyId'>) {
    const body: Omit<RecordExpenseInput, 'companyId'> = {
      supplierName: input.supplierName,
      documentDate: input.documentDate,
      totalTtcCents: input.totalTtcCents,
      category: input.category,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.supplierSiren !== undefined ? { supplierSiren: input.supplierSiren } : {}),
      ...(input.totalHtCents !== undefined ? { totalHtCents: input.totalHtCents } : {}),
      ...(input.vatCents !== undefined ? { vatCents: input.vatCents } : {}),
      ...(input.vatRatePct !== undefined ? { vatRatePct: input.vatRatePct } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.supplierInvoiceNumber !== undefined
        ? { supplierInvoiceNumber: input.supplierInvoiceNumber }
        : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    };
    return this.req<{ id: string }>('POST', '/expenses', body, undefined, decodeExpenseCreation);
  }
  /** C-EXP6b ① : contrôle de réception (destinataire, EN 16931, doublon) + brouillon expert. */
  importFacturXExpense(input: { xml: string }) {
    return this.req<FacturXImportReview>('POST', '/expenses/import-facturx', input);
  }
  /** C-EXP6b ② : décision AFNOR explicite — approve (Expense + écritures E1 + XML archivé)
   * ou refuse (motif obligatoire, 210/213). Le XML est resoumis : serveur sans état. */
  confirmFacturXExpense(input: { xml: string; decision: FacturXImportDecision }) {
    return this.req<FacturXImportOutcome>('POST', '/expenses/import-facturx/confirm', input);
  }
  /** Preuve explicite d'un règlement fournisseur déjà réalisé ; aucun rail bancaire. */
  payExpense(input: RecordExpensePaymentClientInput) {
    const { expenseId, ...evidence } = input;
    return this.req<RecordExpensePaymentClientOutput>(
      'POST',
      `/expenses/${expenseId}/pay`,
      evidence,
    );
  }
  /** Régularise une dépense historique payée sans preuve : même preuve explicite, écriture 401/512-530. */
  regularizeExpensePayment(input: RegularizeExpensePaymentClientInput) {
    const { expenseId, ...evidence } = input;
    return this.req<RegularizeExpensePaymentClientOutput>(
      'POST',
      `/expenses/${expenseId}/regularize-payment`,
      evidence,
    );
  }
  listExpenses() {
    return this.req<ExpenseProps[]>('GET', '/expenses');
  }
  listCatalogueItems() {
    return this.req<readonly CatalogueItemView[]>(
      'GET',
      '/catalogue/prestations',
      undefined,
      undefined,
      decodeCatalogueItems,
    );
  }
  createCatalogueItem(input: CatalogueItemWriteInput) {
    return this.req<CatalogueItemView>(
      'POST',
      '/catalogue/prestations',
      input,
      undefined,
      decodeCatalogueItem,
    );
  }
  updateCatalogueItem(input: {
    itemId: string;
    expectedRevision: number;
    item: CatalogueItemWriteInput;
  }) {
    return this.req<CatalogueItemView>(
      'PATCH',
      `/catalogue/prestations/${encodeURIComponent(input.itemId)}`,
      { ...input.item, expectedRevision: input.expectedRevision },
      undefined,
      decodeCatalogueItem,
    );
  }
  deleteCatalogueItem(input: { itemId: string; expectedRevision: number }) {
    return this.req<CatalogueDeletionView>(
      'DELETE',
      `/catalogue/prestations/${encodeURIComponent(input.itemId)}`,
      { expectedRevision: input.expectedRevision },
      undefined,
      decodeCatalogueDeletion,
    );
  }
  createChantier(input: Omit<CreateChantierInput, 'companyId'>) {
    return this.req<{ id: string }>('POST', '/chantiers', input);
  }
  listChantiers() {
    return this.req<ChantierListItem[]>('GET', '/chantiers');
  }
  listChantierNotes(chantierId: string) {
    return this.req<ChantierNoteProps[]>(
      'GET',
      `/chantiers/${encodeURIComponent(chantierId)}/notes`,
    );
  }
  addChantierNote(chantierId: string, input: { text: string }) {
    return this.req<{ id: string }>(
      'POST',
      `/chantiers/${encodeURIComponent(chantierId)}/notes`,
      input,
    );
  }
  listWorksitePhotos(chantierId: string) {
    return this.req<WorksiteMediaItem[]>(
      'GET',
      `/chantiers/${encodeURIComponent(chantierId)}/photos`,
    );
  }
  uploadWorksitePhoto(
    chantierId: string,
    input: { contentBase64: string; mimeType: string; filename: string },
  ) {
    return this.req<WorksiteMediaItem>(
      'POST',
      `/chantiers/${encodeURIComponent(chantierId)}/photos`,
      input,
    );
  }
  worksitePhotoViewUrl(photoId: string) {
    return this.req<{ url: string; expiresInSeconds: number }>(
      'GET',
      `/chantiers/photos/${encodeURIComponent(photoId)}/view-url`,
    );
  }
  deleteWorksitePhoto(photoId: string) {
    return this.req<void>('DELETE', `/chantiers/photos/${encodeURIComponent(photoId)}`);
  }
  listCustomers() {
    return this.req<CustomerListItem[]>(
      'GET',
      '/customers',
      undefined,
      undefined,
      decodeCustomerList,
    );
  }
  createCustomer(input: CreateCustomerClientInput) {
    return this.req<{ id: string }>('POST', '/customers', customerClientBody(input));
  }
  /** Édition post-création (C13/C40 TODO partagé) — même allowlist que la création. */
  updateCustomer(id: string, input: UpdateCustomerClientInput) {
    return this.req<{ id: string }>(
      'PATCH',
      `/customers/${encodeURIComponent(id)}`,
      customerClientBody(input),
    );
  }
  // —— Assistant Bob (C40 ⑧) : l'agent tourne CÔTÉ SERVEUR — journal company-scoped, autonomie clampée ——
  askBob(input: AskBobClientInput) {
    // Frontière explicite : un objet élargi à l'exécution ne doit jamais faire fuiter un callback
    // UI (`onPhase`) ou une future option non auditée dans le DTO réseau.
    const body: AskBobClientInput = {
      message: input.message,
      ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
      ...(input.history !== undefined ? { history: input.history } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    };
    return this.req<AgentRun>('POST', '/ai/ask', body);
  }
  previewBobProposal(proposalId: string) {
    return this.req<PendingAction>('GET', `/ai/proposals/${encodeURIComponent(proposalId)}`);
  }
  confirmBob(pending: PendingAction) {
    // La confirmation HTTP référence exclusivement la proposition persistée côté serveur.
    // tool/args/label restent utiles à l'aperçu UI, mais ne retraversent jamais la frontière.
    // TRANSITION version-skew : un serveur déployé AVANT les propositions opaques ne fournit
    // pas de proposalId — on lui renvoie alors l'ancien contrat (PendingAction complet) au
    // lieu d'un { proposalId: undefined } qui casserait toute confirmation.
    const body = pending.proposalId !== undefined ? { proposalId: pending.proposalId } : pending;
    return this.req<AgentRun>('POST', '/ai/confirm', body);
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
  getLatestBankBalance() {
    return this.req<QualifiedBankBalanceSnapshot>('GET', '/bank-balance');
  }
  recordManualBankBalance(input: { amountCents: number; observedAt: string }) {
    return this.req<QualifiedBankBalanceSnapshot>('POST', '/bank-balance/manual', input);
  }
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>) {
    const body: Omit<CreateQuoteInput, 'companyId'> = {
      customerId: input.customerId,
      lines: input.lines.map((line) => ({
        label: line.label,
        category: line.category,
        qty: line.qty,
        ...(line.unit !== undefined ? { unit: line.unit } : {}),
        unitPriceHT: line.unitPriceHT,
        vatRate: line.vatRate,
      })),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.depositPct !== undefined ? { depositPct: input.depositPct } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(input.context !== undefined
        ? {
            context: {
              ...(input.context.housingOlderThan2y !== undefined
                ? { housingOlderThan2y: input.context.housingOlderThan2y }
                : {}),
              ...(input.context.energyRenovation !== undefined
                ? { energyRenovation: input.context.energyRenovation }
                : {}),
            },
          }
        : {}),
    };
    return this.req<CreateQuoteOutput>(
      'POST',
      '/quotes',
      body,
      undefined,
      decodeQuoteCreation,
      QUOTE_CREATION_TIMEOUT_MS,
    );
  }
  async getQuoteDraft(): Promise<Result<QuoteDraftSlotView | null, AppError>> {
    const result = await this.req<QuoteDraftEnvelopeWire>(
      'GET',
      '/quote-drafts/current',
      undefined,
      { 'cache-control': 'no-store', pragma: 'no-cache' },
      decodeQuoteDraftEnvelope,
    );
    return result.ok ? { ok: true, value: result.value.slot } : result;
  }
  saveQuoteDraft(input: SaveQuoteDraftClientInput) {
    return this.req<QuoteDraftSlotView>(
      'PUT',
      '/quote-drafts/current',
      {
        expectedRevision: input.expectedRevision,
        payload: input.payload,
      },
      { 'cache-control': 'no-store' },
      decodeQuoteDraftSlot,
    );
  }
  deleteQuoteDraft(expectedRevision: number) {
    return this.req<{ deleted: true }>(
      'DELETE',
      '/quote-drafts/current',
      { expectedRevision },
      { 'cache-control': 'no-store' },
      decodeQuoteDraftDeletion,
    );
  }
  sendQuote(quoteId: string) {
    return this.req<SendQuoteOutput>('POST', `/quotes/${quoteId}/send`);
  }
  /** P0 R4 : préparer le lien ≠ envoyer un e-mail — cette route ne déclenche AUCUN sortant. */
  createQuoteSignatureLink(quoteId: string) {
    return this.req<CreateQuoteSignatureLinkOutput>(
      'POST',
      `/quotes/${encodeURIComponent(quoteId)}/signature-link`,
    );
  }
  /** Lien public de VISUALISATION — même doctrine SANS AUCUN sortant. */
  createQuoteViewLink(quoteId: string) {
    return this.req<CreateDocumentViewLinkOutput>(
      'POST',
      `/quotes/${encodeURIComponent(quoteId)}/view-link`,
    );
  }
  signQuote(input: { quoteId: string; signerName: string; proofDataUrl?: string }) {
    return this.req<{ status: string }>('POST', `/quotes/${input.quoteId}/sign`, {
      signerName: input.signerName,
      ...(input.proofDataUrl !== undefined ? { proofDataUrl: input.proofDataUrl } : {}),
    });
  }
  refuseQuote(quoteId: string) {
    return this.req<{ status: string }>('POST', `/quotes/${quoteId}/refuse`);
  }
  generateInvoice(input: { quoteId: string; mode: 'deposit' | 'final' }) {
    return this.req<{ invoiceId: string }>('POST', `/quotes/${input.quoteId}/invoice`, {
      mode: input.mode,
    });
  }
  updateQuoteLine(input: UpdateQuoteLineInput) {
    return this.req<{ status: string }>(
      'PATCH',
      `/quotes/${encodeURIComponent(input.quoteId)}/lines/${encodeURIComponent(input.lineId)}`,
      input.patch,
    );
  }
  removeQuoteLine(input: RemoveQuoteLineInput) {
    return this.req<{ status: string }>(
      'DELETE',
      `/quotes/${encodeURIComponent(input.quoteId)}/lines/${encodeURIComponent(input.lineId)}`,
    );
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
  deleteDraftInvoice(invoiceId: string) {
    return this.req<{ deleted: true }>(
      'DELETE',
      `/invoices/${encodeURIComponent(invoiceId)}/draft`,
    );
  }
  /** Lien public de VISUALISATION — même doctrine SANS AUCUN sortant que createQuoteViewLink. */
  createInvoiceViewLink(invoiceId: string) {
    return this.req<CreateDocumentViewLinkOutput>(
      'POST',
      `/invoices/${encodeURIComponent(invoiceId)}/view-link`,
    );
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
  previewUnreadNotifications() {
    return this.req<NotificationUnreadPreview>('GET', '/notifications/unread-preview');
  }
  markNotificationsReadThrough(input: NotificationReadThroughInput) {
    return this.req<NotificationReadThroughOutput>('POST', '/notifications/read-through', input);
  }
  registerDevice(input: RegisterDeviceClientInput) {
    return this.req<{ status: 'bound' | 'superseded' }>(
      'POST',
      '/devices',
      input,
      undefined,
      decodePushRegistrationResponse,
      12_000,
    );
  }
  unregisterDevice(input: UnregisterDeviceClientInput) {
    return this.req<{ unregistered: true }>(
      'DELETE',
      '/devices',
      input,
      undefined,
      undefined,
      10_000,
    );
  }
  revokeDeviceBinding(input: RevokeDeviceBindingClientInput) {
    return this.req<{ accepted: true }>(
      'POST',
      '/devices/revocations',
      input,
      undefined,
      decodePushRevocationResponse,
      10_000,
    );
  }
  replayPushRevocation(input: RevokeDeviceBindingClientInput) {
    return this.req<{ accepted: true }>(
      'POST',
      '/public/push-revocations',
      input,
      undefined,
      decodePushRevocationResponse,
      10_000,
    );
  }
  registerPayment(input: RegisterPaymentClientInput) {
    const body = {
      amount: input.amount,
      method: input.method,
      idempotencyKey: input.idempotencyKey ?? undefined,
    };
    const headers = input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : undefined;
    return this.req<RegisterPaymentClientOutput>(
      'POST',
      `/invoices/${input.invoiceId}/pay`,
      body,
      headers,
    );
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
    return this.req<InvoiceAccountingPreview>(
      'GET',
      `/invoices/${invoiceId}/accounting-preview`,
      undefined,
      undefined,
      (value) => decodeInvoiceAccountingPreview(value, invoiceId),
    );
  }
  paymentAccountingPreview(input: {
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
  }) {
    const qs = new URLSearchParams({
      amount: String(input.amountCents),
      method: input.method,
    }).toString();
    return this.req<PaymentAccountingPreview>(
      'GET',
      `/invoices/${input.invoiceId}/payment-accounting-preview?${qs}`,
      undefined,
      undefined,
      (value) => decodePaymentAccountingPreview(value, input),
    );
  }
  listInvoices() {
    return this.req<InvoiceView[]>('GET', '/invoices');
  }
  searchSalesDocuments(input: SearchSalesDocumentsClientInput) {
    const params = new URLSearchParams();
    if (input.query) params.set('q', input.query);
    params.set('type', input.scope ?? 'all');
    if (input.from !== undefined) params.set('from', input.from);
    if (input.to !== undefined) params.set('to', input.to);
    if (input.customerId !== undefined) params.set('customerId', input.customerId);
    if (input.status !== undefined) params.set('status', input.status);
    if (input.cursor !== undefined) params.set('cursor', input.cursor);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    return this.req<SearchSalesDocumentsResult>('GET', `/documents/search?${params.toString()}`);
  }
  suggestSalesDocuments(query: string) {
    const qs = new URLSearchParams({ q: query }).toString();
    return this.req<SuggestSalesDocumentsResult>('GET', `/documents/suggest?${qs}`);
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
