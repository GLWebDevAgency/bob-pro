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
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Valide et normalise une extraction OCR brute. Tolérant au bruit (SIREN/champs optionnels). */
export function makeOcrExtraction(draft: OcrExtractionDraft): DomainResult<OcrExtraction> {
  const supplierName = (draft.supplierName ?? '').trim();
  if (!supplierName)
    return err({ code: 'VALIDATION', field: 'supplierName', message: 'Nom du fournisseur introuvable.' });

  const dateRaw = (draft.documentDate ?? '').trim();
  if (!isValidDateOnly(dateRaw))
    return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date du document introuvable ou invalide.' });

  if (!isInt(draft.totalTtcCents) || (draft.totalTtcCents as number) < 0)
    return err({ code: 'VALIDATION', field: 'totalTtcCents', message: 'Montant TTC introuvable (centimes entiers requis).' });

  // SIREN : on garde s'il est valide (Luhn), sinon on le laisse tomber sans échouer l'extraction.
  let supplierSiren: string | null = null;
  if (draft.supplierSiren) {
    const s = Siren.of(String(draft.supplierSiren));
    if (s.ok) supplierSiren = s.value.value;
  }

  const totalHtCents = isInt(draft.totalHtCents) ? (draft.totalHtCents as number) : null;
  const vatCents = isInt(draft.vatCents) ? (draft.vatCents as number) : null;
  const vatRatePctApplied = isFiniteNum(draft.vatRatePctApplied) ? (draft.vatRatePctApplied as number) : null;
  const currency = (draft.currency ?? 'EUR').trim().toUpperCase() || 'EUR';
  const categoryGuess: ExpenseCategoryGuess = CATEGORIES.includes(draft.categoryGuess as ExpenseCategoryGuess)
    ? (draft.categoryGuess as ExpenseCategoryGuess)
    : 'autre';
  const confidence = isFiniteNum(draft.confidence) ? clamp01(draft.confidence as number) : 0.5;
  const rawText = (draft.rawText ?? '').toString();

  return ok({
    supplierName,
    supplierSiren,
    documentDate: dateRaw,
    totalTtcCents: draft.totalTtcCents as number,
    totalHtCents,
    vatCents,
    vatRatePctApplied,
    currency,
    categoryGuess,
    confidence,
    rawText,
  });
}
