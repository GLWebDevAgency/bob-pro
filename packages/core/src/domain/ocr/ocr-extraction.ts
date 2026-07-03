import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly, isValidDateOnly } from '../../shared-kernel/time';
import { Siren } from '../../shared-kernel/identifiers';

/** Catégorie de dépense devinée par l'OCR (mappable plus tard sur une dépense comptable). */
export type ExpenseCategoryGuess =
  | 'fournitures'
  | 'materiel'
  | 'carburant'
  | 'repas'
  | 'sous_traitance'
  | 'autre';

const CATEGORIES: readonly ExpenseCategoryGuess[] = [
  'fournitures',
  'materiel',
  'carburant',
  'repas',
  'sous_traitance',
  'autre',
];

/** Résultat structuré et validé d'une extraction OCR. Montants en CENTIMES (entiers). */
export interface OcrExtraction {
  supplierName: string;
  supplierSiren: string | null; // validé Luhn quand présent, sinon null
  documentDate: DateOnly; // "YYYY-MM-DD"
  totalTtcCents: number;
  totalHtCents: number | null;
  vatCents: number | null;
  vatRatePctApplied: number | null;
  currency: string; // ISO 4217
  categoryGuess: ExpenseCategoryGuess;
  confidence: number; // 0..1
  rawText: string;
  /** Tags de classement/recherche proposés par le modèle — normalisés (kebab), ≤ 8. */
  suggestedTags: string[];
  /** Nom de fichier canonique « expert-comptable » (sans extension) : AAAA-MM-JJ_fournisseur_MONTANTeur. */
  suggestedFilename: string;
}

/** Forme brute (non fiable) renvoyée par un adapter avant normalisation. */
export interface OcrExtractionDraft {
  supplierName?: string | null;
  supplierSiren?: string | null;
  documentDate?: string | null;
  totalTtcCents?: number | null;
  totalHtCents?: number | null;
  vatCents?: number | null;
  vatRatePctApplied?: number | null;
  currency?: string | null;
  categoryGuess?: string | null;
  confidence?: number | null;
  rawText?: string | null;
  suggestedTags?: unknown;
  suggestedFilename?: string | null;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Taux de TVA français plausibles — tout autre taux renvoyé par un LLM est écarté. */
const PLAUSIBLE_VAT_RATES = [0, 2.1, 5.5, 10, 20] as const;
/** Plafond anti-hallucination : 1 000 000,00 € — au-delà, l'extraction est rejetée. */
const MAX_TTC_CENTS = 100_000_000;
/** Tolérance d'arrondi (centimes) pour la cohérence HT + TVA = TTC. */
const ARITHMETIC_TOLERANCE_CENTS = 2;

/** kebab-case sûr (minuscules, accents retirés, séparateurs → tirets) — tags & noms de fichier. */
function kebab(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Normalise les tags proposés par le modèle : kebab, 2..24 caractères, dédupliqués, ≤ 8. */
export function normalizeSuggestedTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const tag = kebab(value);
    if (tag.length < 2 || tag.length > 24) continue;
    seen.add(tag);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

/** Nom de fichier canonique « expert-comptable » (sans extension) : AAAA-MM-JJ_fournisseur_MONTANTeur. */
export function canonicalReceiptFilename(input: {
  documentDate: DateOnly;
  supplierName: string;
  totalTtcCents: number;
}): string {
  const euros = Math.trunc(input.totalTtcCents / 100);
  const cents = String(input.totalTtcCents % 100).padStart(2, '0');
  return `${input.documentDate}_${kebab(input.supplierName) || 'fournisseur'}_${euros}.${cents}eur`;
}

/**
 * Valide et normalise une extraction OCR brute. Tolérant au bruit (SIREN/champs optionnels),
 * INTRANSIGEANT sur la vraisemblance (garde-fous LLM, A2-C14) : date bornée (2000 → demain),
 * plafond de montant, cohérence HT + TVA = TTC (sinon dégradation, jamais de confiance aveugle),
 * taux de TVA français plausibles, tags/nom de fichier assainis.
 */
export function makeOcrExtraction(
  draft: OcrExtractionDraft,
  opts?: { today?: DateOnly },
): DomainResult<OcrExtraction> {
  const supplierName = (draft.supplierName ?? '').trim();
  if (!supplierName)
    return err({ code: 'VALIDATION', field: 'supplierName', message: 'Nom du fournisseur introuvable.' });

  const dateRaw = (draft.documentDate ?? '').trim();
  if (!isValidDateOnly(dateRaw))
    return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date du document introuvable ou invalide.' });

  if (dateRaw < '2000-01-01')
    return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date du document invraisemblable.' });
  if (opts?.today !== undefined) {
    // Tolérance d'un jour (fuseaux) — une pièce datée après demain est une hallucination.
    const tomorrow = new Date(Date.parse(`${opts.today}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (dateRaw > tomorrow)
      return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date du document dans le futur.' });
  }

  if (!isInt(draft.totalTtcCents) || (draft.totalTtcCents as number) < 0)
    return err({ code: 'VALIDATION', field: 'totalTtcCents', message: 'Montant TTC introuvable (centimes entiers requis).' });
  if ((draft.totalTtcCents as number) > MAX_TTC_CENTS)
    return err({ code: 'VALIDATION', field: 'totalTtcCents', message: 'Montant TTC invraisemblable.' });

  // SIREN : on garde s'il est valide (Luhn), sinon on le laisse tomber sans échouer l'extraction.
  let supplierSiren: string | null = null;
  if (draft.supplierSiren) {
    const s = Siren.of(String(draft.supplierSiren));
    if (s.ok) supplierSiren = s.value.value;
  }

  const totalTtcCents = draft.totalTtcCents as number;
  let totalHtCents = isInt(draft.totalHtCents) && (draft.totalHtCents as number) >= 0 ? (draft.totalHtCents as number) : null;
  let vatCents = isInt(draft.vatCents) && (draft.vatCents as number) >= 0 ? (draft.vatCents as number) : null;
  let vatRatePctApplied = isFiniteNum(draft.vatRatePctApplied) ? (draft.vatRatePctApplied as number) : null;
  let confidence = isFiniteNum(draft.confidence) ? clamp01(draft.confidence as number) : 0.5;

  // Garde-fous LLM (A2-C14) — on dégrade proprement plutôt que de faire confiance :
  // TVA > TTC, ou HT + TVA ≠ TTC (à l'arrondi près) → les détails tombent, la confiance chute.
  if (vatCents !== null && vatCents > totalTtcCents) {
    totalHtCents = null;
    vatCents = null;
    vatRatePctApplied = null;
    confidence = Math.min(confidence, 0.5);
  } else if (
    totalHtCents !== null &&
    vatCents !== null &&
    Math.abs(totalHtCents + vatCents - totalTtcCents) > ARITHMETIC_TOLERANCE_CENTS
  ) {
    totalHtCents = null;
    vatCents = null;
    vatRatePctApplied = null;
    confidence = Math.min(confidence, 0.6);
  }
  // Taux hors barème français → écarté (le montant de TVA, lui, reste s'il est cohérent).
  if (vatRatePctApplied !== null && !PLAUSIBLE_VAT_RATES.some((rate) => rate === vatRatePctApplied)) {
    vatRatePctApplied = null;
  }

  const currency = (draft.currency ?? 'EUR').trim().toUpperCase() || 'EUR';
  const categoryGuess: ExpenseCategoryGuess = CATEGORIES.includes(draft.categoryGuess as ExpenseCategoryGuess)
    ? (draft.categoryGuess as ExpenseCategoryGuess)
    : 'autre';
  const rawText = (draft.rawText ?? '').toString();

  const suggestedTags = normalizeSuggestedTags(draft.suggestedTags);
  if (suggestedTags.length === 0) {
    // Toujours des tags utiles : catégorie + fournisseur (l'expert-comptable ne rend pas copie blanche).
    suggestedTags.push(...normalizeSuggestedTags([categoryGuess, supplierName]));
  }
  const filenameDraft = kebab((draft.suggestedFilename ?? '').replace(/\.[a-z0-9]+$/i, ''));
  const suggestedFilename =
    filenameDraft.length >= 8 && filenameDraft.length <= 80
      ? filenameDraft
      : canonicalReceiptFilename({ documentDate: dateRaw, supplierName, totalTtcCents });

  return ok({
    supplierName,
    supplierSiren,
    documentDate: dateRaw,
    totalTtcCents,
    totalHtCents,
    vatCents,
    vatRatePctApplied,
    currency,
    categoryGuess,
    confidence,
    rawText,
    suggestedTags,
    suggestedFilename,
  });
}
