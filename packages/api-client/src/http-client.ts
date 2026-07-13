import type { AgentRun, JournalEntry, PendingAction } from '@bob/ai';
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
  FiscalDeadline,
  OcrExtraction,
  ExpenseProps,
  RecordExpenseInput,
  TradeConfig,
  ChantierProps,
  CreateChantierInput,
  CompanyProps,
  CompanyLookupResult,
  VatCheckResult,
  AddressSuggestion,
  DocumentView,
  DocumentDownloadUrl,
  DocumentFolderView,
  DeleteDocumentFolderStrategy,
  DocumentAnalysis,
} from '@bob/core';
import type {
  BobClient,
  QuoteView,
  InvoiceView,
  PaymentView,
  SubscriptionView,
  RegisterPaymentClientInput,
  RegisterPaymentClientOutput,
  SendQuoteOutput,
  SendRelanceClientOutput,
  NotificationView,
  NotificationUnreadPreview,
  NotificationReadThroughInput,
  NotificationReadThroughOutput,
  RegisterDeviceClientInput,
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
// Supérieur au budget serveur maximal (8,5 s) avec marge réseau/décodage, sans attente infinie.
const REALTIME_BOOTSTRAP_TIMEOUT_MS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeRealtimeVoiceConfig(value: unknown): RealtimeVoiceConfig | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.available !== 'boolean'
    || value.transport !== 'webrtc'
    || typeof value.model !== 'string'
    || value.model.length === 0
    || value.model.length > 100
    || (value.voice !== 'marin' && value.voice !== 'cedar')
    || typeof value.configVersion !== 'string'
    || !/^bob-live-[a-z0-9-]{1,80}$/.test(value.configVersion)
    || value.requiresDevelopmentBuild !== true
    || typeof value.maxSessionSeconds !== 'number'
    || !Number.isInteger(value.maxSessionSeconds)
    || value.maxSessionSeconds < 60
    || value.maxSessionSeconds > 900
  ) return null;
  return {
    available: value.available,
    transport: 'webrtc',
    model: value.model,
    voice: value.voice,
    configVersion: value.configVersion,
    requiresDevelopmentBuild: true,
    maxSessionSeconds: value.maxSessionSeconds,
  };
}

function decodeRealtimeVoiceCall(value: unknown): RealtimeVoiceCall | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set(['transport', 'answerSdp', 'model', 'voice', 'configVersion', 'maxSessionSeconds']);
  if (
    Object.keys(value).length !== allowedKeys.size
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    ||
    value.transport !== 'webrtc'
    || typeof value.answerSdp !== 'string'
    || value.answerSdp.length < 16
    || value.answerSdp.length > 256 * 1024
    || !value.answerSdp.startsWith('v=0')
    || typeof value.model !== 'string'
    || value.model.length === 0
    || value.model.length > 100
    || (value.voice !== 'marin' && value.voice !== 'cedar')
    || typeof value.configVersion !== 'string'
    || !/^bob-live-[a-z0-9-]{1,80}$/.test(value.configVersion)
    || typeof value.maxSessionSeconds !== 'number'
    || !Number.isInteger(value.maxSessionSeconds)
    || value.maxSessionSeconds < 60
    || value.maxSessionSeconds > 900
  ) return null;
  return {
    transport: 'webrtc',
    answerSdp: value.answerSdp,
    model: value.model,
    voice: value.voice,
    configVersion: value.configVersion,
    maxSessionSeconds: value.maxSessionSeconds,
  };
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
    decode?: (value: unknown) => T | null,
    timeoutMs?: number,
  ): Promise<Result<T, AppError>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = timeoutMs === undefined ? null : new AbortController();
      const deadline = timeoutMs === undefined
        ? null
        : new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller?.abort();
              reject(new Error(`Délai réseau dépassé après ${timeoutMs} ms.`));
            }, timeoutMs);
          });
      const withinDeadline = <V>(operation: Promise<V>): Promise<V> =>
        deadline ? Promise.race([operation, deadline]) : operation;
      // Le budget couvre aussi la récupération du jeton : une auth locale bloquée ne doit pas
      // laisser l'interface attendre indéfiniment avant même que `fetch` puisse être annulé.
      const token = this.opts.getToken
        ? await withinDeadline(this.opts.getToken())
        : null;
      const init: RequestInit = {
        method,
        ...(controller ? { signal: controller.signal } : {}),
        headers: {
          'content-type': 'application/json',
          'x-company-id': this.companyId,
          ...headers,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await withinDeadline(fetch(`${this.opts.baseUrl}${path}`, init));
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
      return { ok: false, error: { kind: 'dependency', port: 'api', cause: e instanceof Error ? e.message : 'réseau' } };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
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
      const token = this.opts.getToken
        ? await withinDeadline(this.opts.getToken())
        : null;
      const res = await withinDeadline(fetch(`${this.opts.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'x-company-id': this.companyId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }));
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
          return { ok: false, error: { kind: 'dependency', port: 'api', cause: `HTTP ${res.status}` } };
        }
      }
      return { ok: true, value: { content, headers: res.headers, contentType } };
    } catch (e) {
      return { ok: false, error: { kind: 'dependency', port: 'api', cause: e instanceof Error ? e.message : 'réseau' } };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
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
  lookupCompany(siret: string) {
    return this.req<CompanyLookupResult>('GET', `/company/lookup?siret=${encodeURIComponent(siret)}`);
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
  createRealtimeVoiceCall(input: { sdp: string }) {
    return this.req<RealtimeVoiceCall>(
      'POST',
      '/voice/realtime/calls',
      input,
      undefined,
      decodeRealtimeVoiceCall,
      REALTIME_BOOTSTRAP_TIMEOUT_MS,
    );
  }
  listDocuments(input: ListDocumentsClientInput = {}) {
    const params = new URLSearchParams();
    if (input.kind !== undefined) params.set('kind', input.kind);
    if (input.linkedEntityType !== undefined) params.set('linkedEntityType', input.linkedEntityType);
    if (input.linkedEntityId !== undefined) params.set('linkedEntityId', input.linkedEntityId);
    if (input.folderId !== undefined) params.set('folderId', input.folderId ?? 'null');
    if (input.includeDeleted !== undefined) params.set('includeDeleted', String(input.includeDeleted));
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
      (value) => decodeDocumentViewForContext(value, {
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
      (value) => decodeDocumentFolderPageForContext(value, {
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
      (value) => decodeDocumentFolderViewForContext(value, {
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
      (value) => decodeDocumentFolderViewForContext(value, {
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
      (value) => decodeDocumentFolderViewForContext(value, {
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
  executeDocumentFolderDeletion(input: {
    planId: string;
    strategy: DeleteDocumentFolderStrategy;
  }) {
    return this.req<DocumentFolderDeletionExecutionView>(
      'POST',
      `/document-folder-deletion-plans/${encodeURIComponent(input.planId)}/executions`,
      { strategy: input.strategy },
      undefined,
      decodeDocumentFolderDeletionExecution,
      DOCUMENT_MUTATION_TIMEOUT_MS,
    );
  }
  moveDocumentToFolder(input: { documentId: string; folderId: string | null; expectedRevision: number }) {
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
      (value) => decodeDocumentViewForContext(value, {
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
      ...(input.expense.vatRatePct !== undefined
        ? { vatRatePct: input.expense.vatRatePct }
        : {}),
      ...(input.expense.supplierInvoiceNumber !== undefined
        ? { supplierInvoiceNumber: input.expense.supplierInvoiceNumber }
        : {}),
      ...(input.expense.dueAt !== undefined ? { dueAt: input.expense.dueAt } : {}),
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
      (value) => decodeDocumentExpenseCreationForContext(value, {
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
  /** E4 — endpoint serveur à poser (suivi CLAIMS) : règlement d'une dépense fournisseur. */
  payExpense(input: { expenseId: string }) {
    return this.req<{ status: string }>('POST', `/expenses/${input.expenseId}/pay`);
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
  createCustomer(input: CreateCustomerClientInput) {
    return this.req<{ id: string }>('POST', '/customers', input);
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
    return this.req<{ id: string }>('POST', '/devices', input);
  }
  registerPayment(input: RegisterPaymentClientInput) {
    const body = { amount: input.amount, method: input.method, idempotencyKey: input.idempotencyKey ?? undefined };
    const headers = input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : undefined;
    return this.req<RegisterPaymentClientOutput>('POST', `/invoices/${input.invoiceId}/pay`, body, headers);
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
    return this.req<InvoiceAccountingPreview>('GET', `/invoices/${invoiceId}/accounting-preview`);
  }
  paymentAccountingPreview(input: { invoiceId: string; amountCents: number; method: PaymentMethod }) {
    const qs = new URLSearchParams({ amount: String(input.amountCents), method: input.method }).toString();
    return this.req<PaymentAccountingPreview>('GET', `/invoices/${input.invoiceId}/payment-accounting-preview?${qs}`);
  }
  listInvoices() {
    return this.req<InvoiceView[]>('GET', '/invoices');
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
