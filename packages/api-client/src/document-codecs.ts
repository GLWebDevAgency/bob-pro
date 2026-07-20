import {
  DOCUMENT_ANALYSIS_TYPES,
  DOCUMENT_DISPLAY_NAME_MAX_LENGTH,
  DOCUMENT_FOLDER_SYSTEM_KEYS,
  makeDocumentAnalysis,
  makeDocumentDestinationSuggestion,
  normalizeDocumentFolderName,
  validateDocumentFolderName,
  type DocumentAnalysis,
  type DocumentAnalysisDraft,
  type DocumentAnalysisType,
  type DocumentDestinationContext,
  type DocumentDestinationSuggestion,
  type DocumentDownloadUrl,
  type DocumentFolderSystemKey,
  type DocumentFolderView,
  type DocumentView,
} from '@bob/core';
import type {
  DocumentAnalysisSummaryView,
  DocumentExtractionSummaryView,
  DocumentFolderDeletionExecutionView,
  DocumentFolderDeletionPlanView,
  DocumentFolderPageView,
  DocumentListItemView,
  RecordDocumentExpenseClientOutput,
} from './client';

type JsonObject = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const DOCUMENT_KINDS = new Set(['invoice_pdf', 'quote_pdf', 'facturx_xml', 'expense_receipt', 'signed_quote', 'other']);
const DOCUMENT_ORIGINS = new Set(['generated', 'uploaded', 'ocr']);
const DOCUMENT_STATUSES = new Set(['active', 'deleted']);
const DOCUMENT_LINKS = new Set(['invoice', 'quote', 'expense', 'chantier', 'company']);
const FOLDER_SYSTEM_KEYS = new Set<string>(DOCUMENT_FOLDER_SYSTEM_KEYS);

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown, maxLength = 512): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) return null;
  return value;
}

function nullableString(value: unknown, maxLength = 512): string | null | undefined {
  return value === null ? null : string(value, maxLength) ?? undefined;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function naturalInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function nullableDateOnly(value: unknown): string | null | undefined {
  return value === null ? null : dateOnly(value) ?? undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const candidate = object(value);
  if (candidate) {
    return `{${Object.keys(candidate)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(candidate[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Fallback déterministe du libellé d'affichage (miroir de defaultDocumentDisplayName du domaine). */
function displayNameFromFilename(filename: string): string {
  return filename.slice(0, DOCUMENT_DISPLAY_NAME_MAX_LENGTH).trim() || 'Document';
}

export function decodeDocumentView(value: unknown): DocumentView | null {
  const candidate = object(value);
  if (!candidate) return null;

  const id = string(candidate.id, 200);
  const companyId = string(candidate.companyId, 200);
  const filename = string(candidate.filename, 255);
  const mimeType = string(candidate.mimeType, 160);
  const storageKey = string(candidate.storageKey, 2_048);
  const folderId = nullableString(candidate.folderId, 200);
  const linkedEntityId = nullableString(candidate.linkedEntityId, 200);
  const documentDate = nullableDateOnly(candidate.documentDate);
  const issuedAt = nullableDateOnly(candidate.issuedAt);
  const createdBy = nullableString(candidate.createdBy, 200);
  const createdAt = instant(candidate.createdAt);
  const retentionUntil = dateOnly(candidate.retentionUntil);
  const revision = positiveInteger(candidate.revision);
  const version = positiveInteger(candidate.version);
  const byteSize = positiveInteger(candidate.byteSize);
  // Tolérance : champ absent/null (serveur historique) ⇒ fallback filename ; présent mais
  // hors contrat ⇒ rejet strict, comme les autres champs.
  const displayName =
    candidate.displayName === undefined || candidate.displayName === null
      ? filename !== null
        ? displayNameFromFilename(filename)
        : null
      : string(candidate.displayName, DOCUMENT_DISPLAY_NAME_MAX_LENGTH);
  // Compat ascendante : champ absent/null (serveur historique) ⇒ null « jamais validé »,
  // JAMAIS un crash ; présent mais hors contrat ⇒ rejet strict, comme les autres champs.
  const reviewedAt =
    candidate.reviewedAt === undefined || candidate.reviewedAt === null
      ? null
      : instant(candidate.reviewedAt) ?? undefined;

  if (
    !id
    || !companyId
    || !filename
    || !displayName
    || !mimeType
    || !storageKey
    || folderId === undefined
    || linkedEntityId === undefined
    || documentDate === undefined
    || issuedAt === undefined
    || createdBy === undefined
    || !createdAt
    || !retentionUntil
    || !revision
    || !version
    || !byteSize
    || reviewedAt === undefined
    || !DOCUMENT_KINDS.has(String(candidate.kind))
    || !DOCUMENT_ORIGINS.has(String(candidate.origin))
    || !DOCUMENT_STATUSES.has(String(candidate.status))
    || typeof candidate.sha256 !== 'string'
    || !SHA256.test(candidate.sha256)
    || !storageKey.startsWith(`companies/${companyId}/documents/${id}/`)
  ) return null;

  const linkedEntityType = candidate.linkedEntityType;
  if (
    (linkedEntityType === null) !== (linkedEntityId === null)
    || (linkedEntityType !== null && !DOCUMENT_LINKS.has(String(linkedEntityType)))
  ) return null;

  if (!Array.isArray(candidate.tags) || candidate.tags.length > 16) return null;
  const tags: string[] = [];
  for (const rawTag of candidate.tags) {
    const tag = string(rawTag, 32);
    if (!tag || tag.length < 2 || tag !== tag.toLowerCase() || tags.includes(tag)) return null;
    tags.push(tag);
  }

  return {
    id,
    companyId,
    kind: candidate.kind as DocumentView['kind'],
    origin: candidate.origin as DocumentView['origin'],
    status: candidate.status as DocumentView['status'],
    filename,
    displayName,
    mimeType,
    byteSize,
    sha256: candidate.sha256,
    storageKey,
    folderId,
    revision,
    version,
    linkedEntityType: linkedEntityType as DocumentView['linkedEntityType'],
    linkedEntityId,
    documentDate,
    issuedAt,
    createdAt,
    createdBy,
    retentionUntil,
    tags,
    reviewedAt,
  };
}

export function decodeDocumentViews(value: unknown): DocumentView[] | null {
  if (!Array.isArray(value) || value.length > 5_000) return null;
  const documents: DocumentView[] = [];
  for (const item of value) {
    const document = decodeDocumentView(item);
    if (!document) return null;
    documents.push(document);
  }
  return documents;
}

const ANALYSIS_TYPES = new Set<string>(DOCUMENT_ANALYSIS_TYPES);

/**
 * Liste bornée de chaînes propres (tags/warnings du résumé). Défensif par CHAMP : une forme
 * hors contrat (non-tableau, entrée non-string, trop longue) est ignorée — jamais un crash,
 * jamais un rejet du résumé entier (compat ascendante avec les serveurs sans ces champs).
 */
function boundedStringList(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const item = string(entry, maxLength);
    if (!item || items.includes(item)) continue;
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

/** Résumé d'analyse d'un item de liste. Défensif : toute forme hors contrat ⇒ null. */
export function decodeDocumentAnalysisSummary(value: unknown): DocumentAnalysisSummaryView | null {
  const candidate = object(value);
  if (!candidate) return null;
  const suggestedDisplayName = string(candidate.suggestedDisplayName, 120);
  if (
    typeof candidate.type !== 'string'
    || !ANALYSIS_TYPES.has(candidate.type)
    || typeof candidate.typeConfidence !== 'number'
    || !Number.isFinite(candidate.typeConfidence)
    || candidate.typeConfidence < 0
    || candidate.typeConfidence > 1
    || !suggestedDisplayName
    || typeof candidate.requiresHumanReview !== 'boolean'
  ) return null;
  return {
    type: candidate.type as DocumentAnalysisType,
    typeConfidence: candidate.typeConfidence,
    suggestedDisplayName,
    suggestedDestination:
      candidate.suggestedDestination === null || candidate.suggestedDestination === undefined
        ? null
        : decodeDocumentDestinationSuggestion(candidate.suggestedDestination),
    requiresHumanReview: candidate.requiresHumanReview,
    // Carte « exactement celle du scan » : résumé/tags/warnings persistés (bornes du domaine —
    // summary ≤ 800, ≤ 8 tags de ≤ 32, ≤ 8 warnings de ≤ 240). Champ absent ⇒ null/[] (compat
    // ascendante avec les serveurs antérieurs), jamais un crash ni une valeur inventée.
    summary: string(candidate.summary, 800),
    suggestedTags: boundedStringList(candidate.suggestedTags, 8, 32),
    warnings: boundedStringList(candidate.warnings, 8, 240),
  };
}

/** Chips Montant/TVA/Date d'un item de liste. Défensif : sans total TTC entier ⇒ null. */
export function decodeDocumentExtractionSummary(value: unknown): DocumentExtractionSummaryView | null {
  const candidate = object(value);
  if (!candidate) return null;
  if (!Number.isSafeInteger(candidate.totalTtcCents)) return null;
  const supplierName = candidate.supplierName === null || candidate.supplierName === undefined
    ? null
    : string(candidate.supplierName, 240);
  const vatCents = candidate.vatCents === null || candidate.vatCents === undefined
    ? null
    : Number.isSafeInteger(candidate.vatCents) ? candidate.vatCents as number : null;
  const documentDate = candidate.documentDate === null || candidate.documentDate === undefined
    ? null
    : dateOnly(candidate.documentDate);
  return {
    supplierName,
    totalTtcCents: candidate.totalTtcCents as number,
    vatCents,
    documentDate,
  };
}

/**
 * Item enrichi de GET /documents : la vue document reste STRICTE (id, tenant, empreintes) ;
 * les résumés d'analyse sont TOLÉRANTS — absents ou hors contrat ⇒ null (« pas encore
 * analysé »), jamais un crash de liste ni une valeur inventée.
 */
export function decodeDocumentListItem(value: unknown): DocumentListItemView | null {
  const document = decodeDocumentView(value);
  if (!document) return null;
  const candidate = object(value);
  return {
    ...document,
    analysis: decodeDocumentAnalysisSummary(candidate?.analysis),
    extraction: decodeDocumentExtractionSummary(candidate?.extraction),
  };
}

/**
 * Item enrichi lié au tenant/à la ressource demandés (GET /documents/:id) : la vue document
 * reste STRICTE, les résumés d'analyse restent TOLÉRANTS (absents/hors contrat ⇒ null).
 */
export function decodeDocumentListItemForContext(
  value: unknown,
  context: DocumentViewDecodeContext,
): DocumentListItemView | null {
  const document = decodeDocumentViewForContext(value, context);
  if (!document) return null;
  const candidate = object(value);
  return {
    ...document,
    analysis: decodeDocumentAnalysisSummary(candidate?.analysis),
    extraction: decodeDocumentExtractionSummary(candidate?.extraction),
  };
}

export function decodeDocumentListItemsForCompany(
  value: unknown,
  companyId: string,
): DocumentListItemView[] | null {
  if (!Array.isArray(value) || value.length > 5_000) return null;
  const items: DocumentListItemView[] = [];
  for (const item of value) {
    const decoded = decodeDocumentListItem(item);
    if (!decoded || decoded.companyId !== companyId) return null;
    items.push(decoded);
  }
  return items;
}

/** Projection canonique analyse → résumé de liste (même règle que le serveur — parité local/http). */
export function documentAnalysisSummaryView(analysis: DocumentAnalysis): DocumentAnalysisSummaryView {
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

function analysisFactEurCents(analysis: DocumentAnalysis, key: 'total_ttc' | 'vat_amount'): number | null {
  const fact = analysis.facts.find(
    (candidate) => candidate.key === key && candidate.valueType === 'money',
  );
  return fact?.valueType === 'money' && fact.value.currency === 'EUR' ? fact.value.amountMinor : null;
}

/**
 * Projection canonique analyse → chips (même règle que le serveur — parité local/http) :
 * sans total TTC prouvé en EUR, aucune chip n'est fabriquée.
 */
export function documentExtractionSummaryView(analysis: DocumentAnalysis): DocumentExtractionSummaryView | null {
  const totalTtcCents = analysisFactEurCents(analysis, 'total_ttc');
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
    vatCents: analysisFactEurCents(analysis, 'vat_amount'),
    documentDate: dateFact?.valueType === 'date' ? dateFact.value : null,
  };
}

export function decodeDocumentDownloadUrl(value: unknown): DocumentDownloadUrl | null {
  const candidate = object(value);
  if (!candidate) return null;
  const url = string(candidate.url, 8_192);
  const filename = string(candidate.filename, 255);
  const mimeType = string(candidate.mimeType, 160);
  const byteSize = positiveInteger(candidate.byteSize);
  const expiresInSeconds = positiveInteger(candidate.expiresInSeconds);
  if (
    !url
    || !filename
    || !mimeType
    || !byteSize
    || !expiresInSeconds
    || expiresInSeconds < 60
    || expiresInSeconds > 3_600
    || typeof candidate.sha256 !== 'string'
    || !SHA256.test(candidate.sha256)
  ) return null;
  try {
    if (new URL(url).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { url, filename, mimeType, byteSize, expiresInSeconds, sha256: candidate.sha256 };
}

export function decodeDocumentFolderView(value: unknown): DocumentFolderView | null {
  const candidate = object(value);
  if (!candidate) return null;
  const id = string(candidate.id, 200);
  const companyId = string(candidate.companyId, 200);
  const parentId = nullableString(candidate.parentId, 200);
  const name = string(candidate.name, 80);
  const normalizedName = string(candidate.normalizedName, 160);
  const systemKey = candidate.systemKey === null
    ? null
    : FOLDER_SYSTEM_KEYS.has(String(candidate.systemKey))
      ? candidate.systemKey as DocumentFolderSystemKey
      : undefined;
  const revision = positiveInteger(candidate.revision);
  const createdAt = instant(candidate.createdAt);
  const updatedAt = instant(candidate.updatedAt);
  const deletedAt = candidate.deletedAt === null ? null : instant(candidate.deletedAt) ?? undefined;
  const validatedName = validateDocumentFolderName(candidate.name);

  if (
    !id
    || !companyId
    || parentId === undefined
    || parentId === id
    || !name
    || !normalizedName
    || systemKey === undefined
    || !revision
    || !createdAt
    || !updatedAt
    || deletedAt === undefined
    || !validatedName.ok
    || validatedName.value.name !== name
    || normalizeDocumentFolderName(name) !== normalizedName
    || (candidate.status !== 'active' && candidate.status !== 'deleted')
    || (candidate.status === 'active' && deletedAt !== null)
    || (candidate.status === 'deleted' && deletedAt === null)
  ) return null;

  return {
    id,
    companyId,
    parentId,
    name,
    normalizedName,
    systemKey,
    status: candidate.status,
    revision,
    createdAt,
    updatedAt,
    deletedAt,
  };
}

export function decodeDocumentFolderPage(value: unknown): DocumentFolderPageView | null {
  const candidate = object(value);
  if (!candidate || !Array.isArray(candidate.items) || candidate.items.length > 100) return null;
  const nextCursor = nullableString(candidate.nextCursor, 200);
  if (nextCursor === undefined) return null;
  const items: DocumentFolderView[] = [];
  for (const item of candidate.items) {
    const folder = decodeDocumentFolderView(item);
    if (!folder) return null;
    items.push(folder);
  }
  return { items, nextCursor };
}

function decodePlanFolder(value: unknown): DocumentFolderDeletionPlanView['folder'] | null {
  const candidate = object(value);
  if (!candidate) return null;
  const id = string(candidate.id, 200);
  const parentId = nullableString(candidate.parentId, 200);
  const name = string(candidate.name, 80);
  const systemKey = candidate.systemKey === null
    ? null
    : FOLDER_SYSTEM_KEYS.has(String(candidate.systemKey))
      ? candidate.systemKey as DocumentFolderSystemKey
      : undefined;
  if (!id || parentId === undefined || parentId === id || !name || systemKey === undefined) return null;
  return { id, parentId, name, systemKey };
}

export function decodeDocumentFolderDeletionPlan(value: unknown): DocumentFolderDeletionPlanView | null {
  const candidate = object(value);
  if (!candidate) return null;
  const planId = string(candidate.planId, 200);
  const expiresAt = instant(candidate.expiresAt);
  const folder = decodePlanFolder(candidate.folder);
  const directChildCount = naturalInteger(candidate.directChildCount);
  const descendantFolderCount = naturalInteger(candidate.descendantFolderCount);
  const directDocumentCount = naturalInteger(candidate.directDocumentCount);
  const documentCount = naturalInteger(candidate.documentCount);
  if (
    !planId
    || !expiresAt
    || !folder
    || directChildCount === null
    || descendantFolderCount === null
    || directDocumentCount === null
    || documentCount === null
    || typeof candidate.canDeleteEmpty !== 'boolean'
    || directChildCount > descendantFolderCount
    || directDocumentCount > documentCount
    || (candidate.canDeleteEmpty && (descendantFolderCount !== 0 || documentCount !== 0))
  ) return null;
  return {
    planId,
    expiresAt,
    folder,
    directChildCount,
    descendantFolderCount,
    directDocumentCount,
    documentCount,
    canDeleteEmpty: candidate.canDeleteEmpty,
  };
}

export function decodeDocumentFolderDeletionExecution(value: unknown): DocumentFolderDeletionExecutionView | null {
  const candidate = object(value);
  if (!candidate) return null;
  const folderId = string(candidate.folderId, 200);
  const transferredDocuments = naturalInteger(candidate.transferredDocuments);
  const transferredChildren = naturalInteger(candidate.transferredChildren);
  return folderId && transferredDocuments !== null && transferredChildren !== null
    ? { folderId, transferredDocuments, transferredChildren }
    : null;
}

export function decodeDocumentMove(value: unknown): { documentId: string; folderId: string | null; revision: number } | null {
  const candidate = object(value);
  if (!candidate) return null;
  const documentId = string(candidate.documentId, 200);
  const folderId = nullableString(candidate.folderId, 200);
  const revision = positiveInteger(candidate.revision);
  return documentId && folderId !== undefined && revision ? { documentId, folderId, revision } : null;
}

/**
 * Reconstruit le contexte de validation de destination À PARTIR de la valeur reçue.
 *
 * Le client ne connaît pas la liste des chantiers du tenant au moment du décodage :
 * l'anti-hallucination a déjà eu lieu CÔTÉ SERVEUR (AnalyzeDocument + makeDocumentAnalysis).
 * La seule exigence ici est le déterminisme du round-trip — une suggestion chantier se revalide
 * contre elle-même, un null explicite est reproduit en interdisant le fallback par type.
 * Même logique côté API dans apps/api/src/persistence/document-analyses.ts.
 */
function destinationRevalidationContext(candidate: JsonObject): DocumentDestinationContext | undefined {
  if (!('suggestedDestination' in candidate)) return undefined; // serveur historique : fallback déterministe
  const destination = candidate.suggestedDestination;
  if (destination === null) return { chantiers: [], systemKeys: [] };
  const raw = object(destination);
  if (raw && raw.kind === 'chantier' && typeof raw.chantierId === 'string' && typeof raw.label === 'string') {
    return { chantiers: [{ id: raw.chantierId, nom: raw.label }] };
  }
  return { chantiers: [] };
}

/**
 * Décode une destination suggérée isolée (résumé de liste). Défensif : toute forme hors
 * contrat ⇒ null (jamais de crash) ; le label d'un dossier système est re-dérivé du produit.
 */
export function decodeDocumentDestinationSuggestion(value: unknown): DocumentDestinationSuggestion | null {
  const raw = object(value);
  if (!raw) return null;
  const motif = typeof raw.motif === 'string' ? raw.motif : null;
  if (raw.kind === 'chantier') {
    if (typeof raw.chantierId !== 'string' || typeof raw.label !== 'string') return null;
    return makeDocumentDestinationSuggestion(
      { kind: 'chantier', chantierId: raw.chantierId, motif },
      { chantiers: [{ id: raw.chantierId, nom: raw.label }] },
    );
  }
  if (raw.kind === 'system_folder') {
    return makeDocumentDestinationSuggestion(
      { kind: 'system_folder', systemKey: typeof raw.systemKey === 'string' ? raw.systemKey : null, motif },
      { chantiers: [] },
    );
  }
  return null;
}

export function decodeDocumentAnalysis(value: unknown): DocumentAnalysis | null {
  const candidate = object(value);
  if (!candidate) return null;
  const documentId = string(candidate.documentId, 200);
  const documentVersion = positiveInteger(candidate.documentVersion);
  const sourceSha256 = typeof candidate.sourceSha256 === 'string' && SHA256.test(candidate.sourceSha256)
    ? candidate.sourceSha256
    : null;
  const analyzerVersion = string(candidate.analyzerVersion, 120);
  const analyzedAt = instant(candidate.analyzedAt);
  if (
    !documentId
    || !documentVersion
    || !sourceSha256
    || !analyzerVersion
    || !analyzedAt
    || !Array.isArray(candidate.facts)
    || !Array.isArray(candidate.suggestedTags)
    || !Array.isArray(candidate.warnings)
    || typeof candidate.type !== 'string'
    || typeof candidate.typeConfidence !== 'number'
    || typeof candidate.summary !== 'string'
    || typeof candidate.suggestedFilename !== 'string'
    || typeof candidate.requiresHumanReview !== 'boolean'
  ) return null;

  const parsed = makeDocumentAnalysis(
    {
      type: candidate.type,
      typeConfidence: candidate.typeConfidence,
      summary: candidate.summary,
      facts: candidate.facts as Exclude<DocumentAnalysisDraft['facts'], null | undefined>,
      suggestedTags: candidate.suggestedTags,
      suggestedFilename: candidate.suggestedFilename,
      suggestedDisplayName:
        typeof candidate.suggestedDisplayName === 'string' ? candidate.suggestedDisplayName : null,
      suggestedDestination: (candidate.suggestedDestination ?? null) as NonNullable<
        DocumentAnalysisDraft['suggestedDestination']
      > | null,
      warnings: candidate.warnings,
    },
    {
      documentId,
      documentVersion,
      sourceSha256,
      originalFilename: `${String(candidate.suggestedFilename ?? 'document')}.bin`,
      analyzerVersion,
      analyzedAt,
    },
    destinationRevalidationContext(candidate),
  );
  if (!parsed.ok) return null;

  const exposedCandidate = {
    documentId: candidate.documentId,
    documentVersion: candidate.documentVersion,
    sourceSha256: candidate.sourceSha256,
    type: candidate.type,
    typeConfidence: candidate.typeConfidence,
    summary: candidate.summary,
    facts: candidate.facts,
    suggestedTags: candidate.suggestedTags,
    suggestedFilename: candidate.suggestedFilename,
    // Tolérance serveur historique : champs absents ⇒ comparés à la normalisation du domaine
    // (fallback déterministe), jamais un rejet ni un crash.
    suggestedDisplayName:
      'suggestedDisplayName' in candidate
        ? candidate.suggestedDisplayName
        : parsed.value.suggestedDisplayName,
    suggestedSystemFolder: candidate.suggestedSystemFolder,
    suggestedDestination:
      'suggestedDestination' in candidate
        ? candidate.suggestedDestination
        : parsed.value.suggestedDestination,
    warnings: candidate.warnings,
    requiresHumanReview: candidate.requiresHumanReview,
    analyzerVersion: candidate.analyzerVersion,
    analyzedAt: candidate.analyzedAt,
  };
  return stableJson(exposedCandidate) === stableJson(parsed.value) ? parsed.value : null;
}

export interface DocumentViewDecodeContext {
  readonly companyId: string;
  readonly documentId?: string;
  readonly folderId?: string | null;
  readonly linkedEntityType?: DocumentView['linkedEntityType'];
  readonly linkedEntityId?: string | null;
  readonly allowedRevisions?: readonly number[];
}

/** Lie une vue valide au tenant et à la ressource effectivement demandés. */
export function decodeDocumentViewForContext(
  value: unknown,
  context: DocumentViewDecodeContext,
): DocumentView | null {
  const document = decodeDocumentView(value);
  if (
    !document
    || document.companyId !== context.companyId
    || (context.documentId !== undefined && document.id !== context.documentId)
    || (context.folderId !== undefined && document.folderId !== context.folderId)
    || (context.linkedEntityType !== undefined && document.linkedEntityType !== context.linkedEntityType)
    || (context.linkedEntityId !== undefined && document.linkedEntityId !== context.linkedEntityId)
    || (context.allowedRevisions !== undefined && !context.allowedRevisions.includes(document.revision))
  ) return null;
  return document;
}

/**
 * Décode la réponse du geste atomique document → dépense et lie toutes les identités
 * à la requête. Une réponse 2xx provenant d'un autre tenant, d'un autre original ou
 * d'une autre dépense est donc traitée comme une rupture de contrat.
 */
export function decodeDocumentExpenseCreationForContext(
  value: unknown,
  context: {
    readonly companyId: string;
    readonly documentId: string;
    readonly targetFolderId: string;
    readonly expectedRevision: number;
  },
): RecordDocumentExpenseClientOutput | null {
  const candidate = object(value);
  if (!candidate) return null;
  const expenseId = string(candidate.expenseId, 200);
  if (!expenseId) return null;
  const document = decodeDocumentViewForContext(candidate.document, {
    companyId: context.companyId,
    documentId: context.documentId,
    folderId: context.targetFolderId,
    linkedEntityType: 'expense',
    linkedEntityId: expenseId,
    // Même dossier : classify+validation N→N+2. Nouveau dossier : move+validation N→N+2 puis
    // classify N+2→N+3. Le nom intelligent (suggestedDisplayName appliqué au record) peut
    // ajouter +1. Un replay peut aussi recevoir une révision intermédiaire ou la courante N.
    allowedRevisions: [
      context.expectedRevision,
      context.expectedRevision + 1,
      context.expectedRevision + 2,
      context.expectedRevision + 3,
      context.expectedRevision + 4,
    ],
  });
  return document ? { expenseId, document } : null;
}

export function decodeDocumentViewsForCompany(value: unknown, companyId: string): DocumentView[] | null {
  const documents = decodeDocumentViews(value);
  if (!documents || documents.some((document) => document.companyId !== companyId)) return null;
  return documents;
}

export interface DocumentFolderViewDecodeContext {
  readonly companyId: string;
  readonly folderId?: string;
  readonly parentId?: string | null;
  readonly allowedRevisions?: readonly number[];
}

/** Lie une vue dossier valide au tenant, à l'id et à l'état attendus par l'appel. */
export function decodeDocumentFolderViewForContext(
  value: unknown,
  context: DocumentFolderViewDecodeContext,
): DocumentFolderView | null {
  const folder = decodeDocumentFolderView(value);
  if (
    !folder
    || folder.companyId !== context.companyId
    || (context.folderId !== undefined && folder.id !== context.folderId)
    || (context.parentId !== undefined && folder.parentId !== context.parentId)
    || (context.allowedRevisions !== undefined && !context.allowedRevisions.includes(folder.revision))
  ) return null;
  return folder;
}

export function decodeDocumentFolderPageForContext(
  value: unknown,
  context: { readonly companyId: string; readonly parentId: string | null },
): DocumentFolderPageView | null {
  const page = decodeDocumentFolderPage(value);
  if (
    !page
    || page.items.some(
      (folder) => folder.companyId !== context.companyId || folder.parentId !== context.parentId,
    )
  ) return null;
  return page;
}

export function decodeDocumentFolderDeletionPlanForFolder(
  value: unknown,
  folderId: string,
): DocumentFolderDeletionPlanView | null {
  const plan = decodeDocumentFolderDeletionPlan(value);
  return plan?.folder.id === folderId ? plan : null;
}

export function decodeDocumentFolderDeletionExecutionForFolder(
  value: unknown,
  folderId: string,
): DocumentFolderDeletionExecutionView | null {
  const execution = decodeDocumentFolderDeletionExecution(value);
  return execution?.folderId === folderId ? execution : null;
}

export function decodeDocumentMoveForContext(
  value: unknown,
  context: {
    readonly documentId: string;
    readonly folderId: string | null;
    readonly expectedRevision: number;
  },
): { documentId: string; folderId: string | null; revision: number } | null {
  const moved = decodeDocumentMove(value);
  if (
    !moved
    || moved.documentId !== context.documentId
    || moved.folderId !== context.folderId
    // N : no-op idempotent · N+1 : déplacement OU validation seule (ranger vers le dossier
    // courant pose reviewedAt) · N+2 : déplacement + validation (rangement vaut confirmation).
    || (moved.revision !== context.expectedRevision
      && moved.revision !== context.expectedRevision + 1
      && moved.revision !== context.expectedRevision + 2)
  ) return null;
  return moved;
}

export function decodeDocumentAnalysisForDocument(value: unknown, documentId: string): DocumentAnalysis | null {
  const analysis = decodeDocumentAnalysis(value);
  return analysis?.documentId === documentId ? analysis : null;
}
