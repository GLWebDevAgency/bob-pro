import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type DateOnly, type Instant, isValidDateOnly } from '../../shared-kernel/time';
import { DOCUMENT_DISPLAY_NAME_MAX_LENGTH } from './document';
import {
  makeDocumentDestinationSuggestion,
  type DocumentDestinationContext,
  type DocumentDestinationSuggestion,
  type DocumentDestinationSuggestionDraft,
} from './document-destination';
import { type DocumentFolderSystemKey } from './document-folder';

/** Taxonomie documentaire transverse. Elle ne déclenche jamais, à elle seule, une écriture comptable. */
export const DOCUMENT_ANALYSIS_TYPES = [
  'supplier_invoice',
  'receipt',
  'bank_statement',
  'insurance_certificate',
  'tax_or_social_document',
  'contract',
  'company_record',
  'chantier_photo',
  'accounting_document',
  'other',
] as const;

export type DocumentAnalysisType = (typeof DOCUMENT_ANALYSIS_TYPES)[number];

export const DOCUMENT_TEXT_FACT_KEYS = [
  'issuer_name',
  'recipient_name',
  'supplier_name',
  'customer_name',
  'company_name',
  'document_number',
  'contract_number',
  'policy_number',
  'bank_name',
  'account_reference',
  'iban_masked',
  'siren',
  'siret',
  'fiscal_period',
  'subject',
  'chantier_name',
] as const;

export const DOCUMENT_DATE_FACT_KEYS = [
  'document_date',
  'due_date',
  'period_start',
  'period_end',
  'coverage_start',
  'coverage_end',
  'expiry_date',
] as const;

export const DOCUMENT_MONEY_FACT_KEYS = [
  'total_ht',
  'vat_amount',
  'total_ttc',
  'amount_due',
  'account_balance',
  'tax_amount',
] as const;

export const DOCUMENT_PERCENTAGE_FACT_KEYS = ['vat_rate'] as const;

export type DocumentTextFactKey = (typeof DOCUMENT_TEXT_FACT_KEYS)[number];
export type DocumentDateFactKey = (typeof DOCUMENT_DATE_FACT_KEYS)[number];
export type DocumentMoneyFactKey = (typeof DOCUMENT_MONEY_FACT_KEYS)[number];
export type DocumentPercentageFactKey = (typeof DOCUMENT_PERCENTAGE_FACT_KEYS)[number];
export type DocumentFactKey =
  | DocumentTextFactKey
  | DocumentDateFactKey
  | DocumentMoneyFactKey
  | DocumentPercentageFactKey;

export type DocumentFactSource = 'document_text' | 'document_visual' | 'derived';

export interface DocumentEvidenceBox {
  /** Coordonnées normalisées dans la page, de 0 à 1. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentEvidence {
  /** Numérotation humaine, à partir de 1. */
  page: number;
  /** Extrait minimisé et expurgé des IBAN complets. */
  excerpt: string | null;
  boundingBox: DocumentEvidenceBox | null;
}

export interface DocumentFactProvenance {
  source: DocumentFactSource;
  evidence: readonly DocumentEvidence[];
  /** Clés sources obligatoires pour un fait dérivé. */
  derivedFrom: readonly DocumentFactKey[];
  /** Règle déterministe appliquée ; jamais une nouvelle affirmation libre du modèle. */
  rule: string | null;
}

interface DocumentFactBase {
  key: DocumentFactKey;
  confidence: number;
  provenance: DocumentFactProvenance;
}

export interface DocumentTextFact extends DocumentFactBase {
  key: DocumentTextFactKey;
  valueType: 'text';
  value: string;
}

export interface DocumentDateFact extends DocumentFactBase {
  key: DocumentDateFactKey;
  valueType: 'date';
  value: DateOnly;
}

export interface DocumentMoneyValue {
  /** Unité mineure de la devise (centimes pour EUR), sans conversion implicite. */
  amountMinor: number;
  currency: string;
}

export interface DocumentMoneyFact extends DocumentFactBase {
  key: DocumentMoneyFactKey;
  valueType: 'money';
  value: DocumentMoneyValue;
}

export interface DocumentPercentageFact extends DocumentFactBase {
  key: DocumentPercentageFactKey;
  valueType: 'percentage';
  value: number;
}

export type DocumentFact = DocumentTextFact | DocumentDateFact | DocumentMoneyFact | DocumentPercentageFact;

/** Forme non fiable produite par un adapter vision/OCR avant validation du domaine. */
export interface DocumentEvidenceDraft {
  page?: number | null;
  excerpt?: string | null;
  boundingBox?: { x?: number | null; y?: number | null; width?: number | null; height?: number | null } | null;
}

/** Forme non fiable produite par un adapter vision/OCR avant validation du domaine. */
export interface DocumentFactDraft {
  key?: string | null;
  valueType?: string | null;
  value?: unknown;
  confidence?: number | null;
  provenance?: {
    source?: string | null;
    evidence?: readonly DocumentEvidenceDraft[] | null;
    derivedFrom?: readonly string[] | null;
    rule?: string | null;
  } | null;
}

/** Forme non fiable produite par un adapter vision/OCR avant validation du domaine. */
export interface DocumentAnalysisDraft {
  type?: string | null;
  typeConfidence?: number | null;
  summary?: string | null;
  facts?: readonly DocumentFactDraft[] | null;
  suggestedTags?: readonly unknown[] | null;
  /** Nom sans extension. La valeur est toujours réassainie par le domaine. */
  suggestedFilename?: string | null;
  /** Libellé professionnel proposé (« Facture Leroy Merlin — 184,90 € »), réassaini par le domaine. */
  suggestedDisplayName?: string | null;
  /** Destination proposée (chantier OU dossier système) — validée contre le contexte tenant. */
  suggestedDestination?: DocumentDestinationSuggestionDraft | null;
  warnings?: readonly unknown[] | null;
}

export interface DocumentAnalysis {
  documentId: string;
  documentVersion: number;
  sourceSha256: string;
  type: DocumentAnalysisType;
  typeConfidence: number;
  summary: string;
  facts: readonly DocumentFact[];
  suggestedTags: readonly string[];
  /** Nom canonique sans extension. */
  suggestedFilename: string;
  /** Libellé d'affichage professionnel, jamais vide (fallback humanisé du nom canonique). */
  suggestedDisplayName: string;
  /** Suggestion déterministe ; null signifie qu'une décision humaine est nécessaire. */
  suggestedSystemFolder: DocumentFolderSystemKey | null;
  /**
   * Destination validée (chantier du contexte OU dossier système) — null : décision humaine.
   * Un document hors chantier (frais généraux, Kbis…) est un résultat de première classe.
   */
  suggestedDestination: DocumentDestinationSuggestion | null;
  warnings: readonly string[];
  requiresHumanReview: boolean;
  analyzerVersion: string;
  analyzedAt: Instant;
}

export interface MakeDocumentAnalysisContext {
  documentId: string;
  documentVersion: number;
  sourceSha256: string;
  originalFilename: string;
  analyzerVersion: string;
  analyzedAt: Instant;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const MAX_FACTS = 32;
const MAX_EVIDENCE_PER_FACT = 4;

const textFactKeys = new Set<string>(DOCUMENT_TEXT_FACT_KEYS);
const dateFactKeys = new Set<string>(DOCUMENT_DATE_FACT_KEYS);
const moneyFactKeys = new Set<string>(DOCUMENT_MONEY_FACT_KEYS);
const percentageFactKeys = new Set<string>(DOCUMENT_PERCENTAGE_FACT_KEYS);
const allFactKeys = new Set<string>([
  ...DOCUMENT_TEXT_FACT_KEYS,
  ...DOCUMENT_DATE_FACT_KEYS,
  ...DOCUMENT_MONEY_FACT_KEYS,
  ...DOCUMENT_PERCENTAGE_FACT_KEYS,
]);

function cleanText(value: string, maxLength: number): string {
  const withoutControls = [...redactIban(value)]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('');
  return withoutControls
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** Minimise l'exposition d'un IBAN complet dans les résumés et preuves persistables. */
function redactIban(value: string): string {
  return value.replace(/\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,30}\b/gi, (candidate) => {
    const compact = candidate.replace(/[\s-]/g, '').toUpperCase();
    if (compact.length < 15 || compact.length > 34) return candidate;
    return `${compact.slice(0, 4)}••••${compact.slice(-4)}`;
  });
}

function kebab(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeFilename(suggested: string | null | undefined, original: string, type: DocumentAnalysisType): string {
  const candidate = (suggested ?? '').split(/[\\/]/).pop() ?? '';
  const originalBase = original.split(/[\\/]/).pop() ?? '';
  const withoutExtension = candidate.replace(/\.[a-z0-9]{1,10}$/i, '');
  const originalWithoutExtension = originalBase.replace(/\.[a-z0-9]{1,10}$/i, '');
  const normalized = kebab(withoutExtension).slice(0, 96).replace(/-+$/g, '');
  if (normalized.length >= 3) return normalized;
  const originalNormalized = kebab(originalWithoutExtension).slice(0, 96).replace(/-+$/g, '');
  if (originalNormalized.length >= 3) return originalNormalized;
  return `document-${type.replace(/_/g, '-')}`;
}

function normalizeTags(raw: readonly unknown[] | null | undefined, type: DocumentAnalysisType): string[] {
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value !== 'string') continue;
      const tag = kebab(value);
      if (tag.length < 2 || tag.length > 32) continue;
      seen.add(tag);
      if (seen.size >= 8) break;
    }
  }
  if (seen.size === 0) seen.add(type.replace(/_/g, '-'));
  return [...seen];
}

function normalizeWarnings(raw: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const warnings: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const warning = cleanText(value, 240);
    if (!warning || warnings.includes(warning)) continue;
    warnings.push(warning);
    if (warnings.length >= 8) break;
  }
  return warnings;
}

function confidence(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeBox(raw: DocumentEvidenceDraft['boundingBox']): DocumentEvidenceBox | null {
  if (!raw) return null;
  const values = [raw.x, raw.y, raw.width, raw.height];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const [x, y, width, height] = values as [number, number, number, number];
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x > 1 || y > 1 || width > 1 || height > 1) return null;
  if (x + width > 1.000_001 || y + height > 1.000_001) return null;
  return { x, y, width, height };
}

function normalizeEvidence(raw: readonly DocumentEvidenceDraft[] | null | undefined): DocumentEvidence[] {
  if (!Array.isArray(raw)) return [];
  const evidence: DocumentEvidence[] = [];
  for (const item of raw) {
    if (!item || !Number.isSafeInteger(item.page) || (item.page as number) < 1 || (item.page as number) > 10_000) continue;
    const excerpt = typeof item.excerpt === 'string' ? cleanText(item.excerpt, 180) : '';
    const boundingBox = normalizeBox(item.boundingBox);
    if (!excerpt && boundingBox === null) continue;
    evidence.push({ page: item.page as number, excerpt: excerpt || null, boundingBox });
    if (evidence.length >= MAX_EVIDENCE_PER_FACT) break;
  }
  return evidence;
}

function isDocumentFactKey(value: string): value is DocumentFactKey {
  return allFactKeys.has(value);
}

function normalizeProvenance(
  draft: DocumentFactDraft,
): { provenance: DocumentFactProvenance; groundedConfidenceCap: number } | null {
  const source = draft.provenance?.source;
  if (source !== 'document_text' && source !== 'document_visual' && source !== 'derived') return null;
  if (source === 'derived') {
    const derivedFrom = [...new Set((draft.provenance?.derivedFrom ?? []).filter(isDocumentFactKey))];
    const rule = cleanText(draft.provenance?.rule ?? '', 120);
    if (derivedFrom.length === 0 || !rule) return null;
    return {
      provenance: { source, evidence: [], derivedFrom, rule },
      groundedConfidenceCap: 1,
    };
  }

  const evidence = normalizeEvidence(draft.provenance?.evidence);
  const hasGrounding = evidence.some((item) =>
    source === 'document_text' ? item.excerpt !== null : item.excerpt !== null || item.boundingBox !== null,
  );
  return {
    provenance: { source, evidence, derivedFrom: [], rule: null },
    // Un fait sans preuve localisable peut être montré comme hypothèse, jamais comme certitude.
    groundedConfidenceCap: hasGrounding ? 1 : 0.4,
  };
}

function normalizeTextFactValue(key: DocumentTextFactKey, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let normalized = cleanText(value, key === 'subject' ? 500 : 240);
  if (!normalized) return null;
  if (key === 'siren') {
    normalized = normalized.replace(/\D/g, '');
    if (!/^\d{9}$/.test(normalized)) return null;
  }
  if (key === 'siret') {
    normalized = normalized.replace(/\D/g, '');
    if (!/^\d{14}$/.test(normalized)) return null;
  }
  if (key === 'iban_masked') normalized = redactIban(normalized);
  return normalized;
}

function normalizeFact(draft: DocumentFactDraft): DocumentFact | null {
  const key = draft.key;
  if (typeof key !== 'string' || !isDocumentFactKey(key)) return null;
  const provenanceResult = normalizeProvenance(draft);
  if (!provenanceResult) return null;
  const factConfidence = Math.min(confidence(draft.confidence), provenanceResult.groundedConfidenceCap);
  const base = { key, confidence: factConfidence, provenance: provenanceResult.provenance };

  if (textFactKeys.has(key) && draft.valueType === 'text') {
    const value = normalizeTextFactValue(key as DocumentTextFactKey, draft.value);
    return value === null ? null : { ...base, key: key as DocumentTextFactKey, valueType: 'text', value };
  }
  if (dateFactKeys.has(key) && draft.valueType === 'date' && typeof draft.value === 'string' && isValidDateOnly(draft.value)) {
    return { ...base, key: key as DocumentDateFactKey, valueType: 'date', value: draft.value };
  }
  if (moneyFactKeys.has(key) && draft.valueType === 'money' && typeof draft.value === 'object' && draft.value !== null) {
    const amountMinor = Reflect.get(draft.value, 'amountMinor');
    const currencyRaw = Reflect.get(draft.value, 'currency');
    const currency = typeof currencyRaw === 'string' ? currencyRaw.trim().toUpperCase() : '';
    if (!Number.isSafeInteger(amountMinor) || Math.abs(amountMinor as number) > 100_000_000_000_000 || !ISO_CURRENCY.test(currency)) {
      return null;
    }
    return {
      ...base,
      key: key as DocumentMoneyFactKey,
      valueType: 'money',
      value: { amountMinor: amountMinor as number, currency },
    };
  }
  if (
    percentageFactKeys.has(key) &&
    draft.valueType === 'percentage' &&
    typeof draft.value === 'number' &&
    Number.isFinite(draft.value) &&
    draft.value >= 0 &&
    draft.value <= 100
  ) {
    return { ...base, key: key as DocumentPercentageFactKey, valueType: 'percentage', value: draft.value };
  }
  return null;
}

function putHighestConfidence(target: Map<DocumentFactKey, DocumentFact>, fact: DocumentFact): void {
  const current = target.get(fact.key);
  if (!current || fact.confidence > current.confidence) target.set(fact.key, fact);
}

function normalizeFacts(raw: readonly DocumentFactDraft[] | null | undefined): DocumentFact[] {
  if (!Array.isArray(raw)) return [];
  const direct = new Map<DocumentFactKey, DocumentFact>();
  const derivedDrafts: DocumentFactDraft[] = [];
  for (const draft of raw.slice(0, MAX_FACTS * 2)) {
    if (draft.provenance?.source === 'derived') {
      derivedDrafts.push(draft);
      continue;
    }
    const fact = normalizeFact(draft);
    if (fact) putHighestConfidence(direct, fact);
  }

  for (const draft of derivedDrafts) {
    const fact = normalizeFact(draft);
    if (!fact) continue;
    const sourceFacts = fact.provenance.derivedFrom.map((key) => direct.get(key)).filter((value): value is DocumentFact => value !== undefined);
    if (sourceFacts.length !== fact.provenance.derivedFrom.length) continue;
    const sourceCap = Math.min(...sourceFacts.map((source) => source.confidence));
    putHighestConfidence(direct, { ...fact, confidence: Math.min(fact.confidence, sourceCap) } as DocumentFact);
  }
  return [...direct.values()].slice(0, MAX_FACTS);
}

/**
 * Libellé d'affichage : proposition du modèle assainie, sinon humanisation déterministe
 * du nom canonique (kebab → espaces, initiale en capitale). Jamais vide.
 */
function normalizeSuggestedDisplayName(suggested: string | null | undefined, canonicalFilename: string): string {
  const cleaned = cleanText(suggested ?? '', DOCUMENT_DISPLAY_NAME_MAX_LENGTH);
  if (cleaned.length >= 3) return cleaned;
  const humanized = canonicalFilename.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

/**
 * Fallback déterministe de destination : le dossier système dérivé du type
 * (`suggestedSystemFolderFor`), repassé par la validation de contexte. Null = décision humaine.
 */
export function fallbackDocumentDestinationFor(
  type: DocumentAnalysisType,
  contexte?: DocumentDestinationContext,
): DocumentDestinationSuggestion | null {
  const systemKey = suggestedSystemFolderFor(type);
  if (systemKey === null) return null;
  return makeDocumentDestinationSuggestion({ kind: 'system_folder', systemKey }, contexte ?? { chantiers: [] });
}

/** Le dossier système est une politique déterministe du produit, jamais un identifiant inventé par le modèle. */
export function suggestedSystemFolderFor(type: DocumentAnalysisType): DocumentFolderSystemKey | null {
  switch (type) {
    case 'supplier_invoice':
    case 'receipt':
      return 'purchases';
    case 'bank_statement':
      return 'bank';
    case 'insurance_certificate':
      return 'insurance';
    case 'tax_or_social_document':
      return 'tax_social';
    case 'chantier_photo':
      return 'projects';
    case 'accounting_document':
      return 'accounting';
    case 'contract':
    case 'company_record':
    case 'other':
      return null;
  }
}

/**
 * Valide et normalise une analyse IA non fiable.
 *
 * Ce value object ne contient volontairement ni écriture, ni dépense, ni commande : l'analyse
 * explique et propose un rangement, tandis que toute mutation reste un use case séparé et confirmé.
 *
 * `destinationContext` (optionnel — compat ascendante) : chantiers/dossiers réels du tenant.
 * Absent, toute suggestion de chantier est rejetée et la destination retombe sur le dossier
 * système déterministe du type.
 */
export function makeDocumentAnalysis(
  draft: DocumentAnalysisDraft,
  context: MakeDocumentAnalysisContext,
  destinationContext?: DocumentDestinationContext,
): DomainResult<DocumentAnalysis> {
  if (!context.documentId.trim()) return err({ code: 'VALIDATION', field: 'documentId', message: 'Id document requis.' });
  if (!Number.isSafeInteger(context.documentVersion) || context.documentVersion <= 0) {
    return err({ code: 'VALIDATION', field: 'documentVersion', message: 'Version document invalide.' });
  }
  if (!SHA256.test(context.sourceSha256)) {
    return err({ code: 'VALIDATION', field: 'sourceSha256', message: 'Empreinte source invalide.' });
  }
  const analyzerVersion = cleanText(context.analyzerVersion, 120);
  if (!analyzerVersion) return err({ code: 'VALIDATION', field: 'analyzerVersion', message: 'Version analyseur requise.' });
  if (!context.analyzedAt.trim() || Number.isNaN(Date.parse(context.analyzedAt))) {
    return err({ code: 'VALIDATION', field: 'analyzedAt', message: "Date d'analyse invalide." });
  }
  if (!DOCUMENT_ANALYSIS_TYPES.includes(draft.type as DocumentAnalysisType)) {
    return err({ code: 'VALIDATION', field: 'type', message: 'Type de document analysé inconnu.' });
  }
  const type = draft.type as DocumentAnalysisType;
  const summary = cleanText(draft.summary ?? '', 800);
  if (!summary) return err({ code: 'VALIDATION', field: 'summary', message: 'Résumé du document requis.' });

  const facts = normalizeFacts(draft.facts);
  const warnings = normalizeWarnings(draft.warnings);
  const typeConfidence = confidence(draft.typeConfidence);
  const suggestedSystemFolder = suggestedSystemFolderFor(type);
  const suggestedFilename = normalizeFilename(draft.suggestedFilename, context.originalFilename, type);
  // Destination : proposition du modèle validée contre le contexte tenant (anti-hallucination),
  // sinon fallback déterministe par type. Null = décision humaine, jamais une devinette.
  const suggestedDestination =
    makeDocumentDestinationSuggestion(draft.suggestedDestination, destinationContext ?? { chantiers: [] }) ??
    fallbackDocumentDestinationFor(type, destinationContext);
  const requiresHumanReview =
    type === 'other' ||
    typeConfidence < 0.75 ||
    suggestedSystemFolder === null ||
    facts.length === 0 ||
    facts.some((fact) => fact.confidence < 0.5) ||
    warnings.length > 0;

  return ok({
    documentId: context.documentId,
    documentVersion: context.documentVersion,
    sourceSha256: context.sourceSha256,
    type,
    typeConfidence,
    summary,
    facts,
    suggestedTags: normalizeTags(draft.suggestedTags, type),
    suggestedFilename,
    suggestedDisplayName: normalizeSuggestedDisplayName(draft.suggestedDisplayName, suggestedFilename),
    suggestedSystemFolder,
    suggestedDestination,
    warnings,
    requiresHumanReview,
    analyzerVersion,
    analyzedAt: context.analyzedAt,
  });
}
