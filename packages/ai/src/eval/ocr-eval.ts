import { type OcrGoldenCase, type OcrGoldenExpected } from './ocr-golden';

/**
 * #13 (excellence OCR) — scoreur PAR CHAMP, pur et déterministe.
 * Le moteur évalué est injecté (extractFromMarkdown d'un adapter, réel ou mocké) :
 * le banc mesure prompt × modèle × garde-fous, champ par champ.
 */

/** Projection structurelle de l'extraction évaluée (compatible OcrExtraction @bob/core). */
export interface OcrEvalExtraction {
  supplierName: string;
  documentDate: string;
  totalTtcCents: number;
  vatCents: number | null;
  categoryGuess: string;
  confidence: number;
}

export type OcrEvalOutcome =
  | { kind: 'extracted'; value: OcrEvalExtraction }
  | { kind: 'rejected'; reason?: string };

export interface OcrFieldScores {
  supplier?: boolean;
  date?: boolean;
  totalTtc?: boolean;
  vat?: boolean;
  category?: boolean;
  rejection?: boolean;
}

export interface OcrCaseResult {
  name: string;
  scores: OcrFieldScores;
  /** Tous les champs attendus sont corrects. */
  pass: boolean;
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Fournisseur : tolérant aux suffixes juridiques (« SAS », « France ») — inclusion mutuelle. */
function supplierMatches(expected: string, actual: string): boolean {
  const e = normalizeName(expected);
  const a = normalizeName(actual);
  return e.length > 0 && a.length > 0 && (a.includes(e) || e.includes(a));
}

export function scoreOcrCase(expected: OcrGoldenExpected, outcome: OcrEvalOutcome): OcrFieldScores {
  if (expected.rejected === true) return { rejection: outcome.kind === 'rejected' };
  if (outcome.kind === 'rejected') {
    // Extraction attendue mais rejetée : tous les champs attendus comptent faux.
    const scores: OcrFieldScores = {};
    if (expected.supplierName !== undefined) scores.supplier = false;
    if (expected.documentDate !== undefined) scores.date = false;
    if (expected.totalTtcCents !== undefined) scores.totalTtc = false;
    if (expected.vatCents !== undefined) scores.vat = false;
    if (expected.categoryGuess !== undefined) scores.category = false;
    return scores;
  }
  const v = outcome.value;
  const scores: OcrFieldScores = {};
  if (expected.supplierName !== undefined) scores.supplier = supplierMatches(expected.supplierName, v.supplierName);
  if (expected.documentDate !== undefined) scores.date = v.documentDate === expected.documentDate;
  if (expected.totalTtcCents !== undefined) scores.totalTtc = v.totalTtcCents === expected.totalTtcCents;
  if (expected.vatCents !== undefined) scores.vat = v.vatCents === expected.vatCents;
  if (expected.categoryGuess !== undefined) scores.category = v.categoryGuess === expected.categoryGuess;
  return scores;
}

export interface OcrEvalReport {
  results: readonly OcrCaseResult[];
  /** Précision par champ ∈ [0,1] (sur les cas où le champ était attendu). */
  accuracy: Partial<Record<keyof OcrFieldScores, number>>;
  /** Cas entièrement corrects / total. */
  passRate: number;
}

export async function runOcrEval(
  cases: readonly OcrGoldenCase[],
  extract: (c: OcrGoldenCase) => Promise<OcrEvalOutcome>,
): Promise<OcrEvalReport> {
  const results: OcrCaseResult[] = [];
  for (const goldenCase of cases) {
    const outcome = await extract(goldenCase);
    const scores = scoreOcrCase(goldenCase.expected, outcome);
    const values = Object.values(scores);
    results.push({ name: goldenCase.name, scores, pass: values.length > 0 && values.every(Boolean) });
  }
  const accuracy: Partial<Record<keyof OcrFieldScores, number>> = {};
  for (const field of ['supplier', 'date', 'totalTtc', 'vat', 'category', 'rejection'] as const) {
    const scored = results.map((r) => r.scores[field]).filter((v): v is boolean => v !== undefined);
    if (scored.length > 0) accuracy[field] = scored.filter(Boolean).length / scored.length;
  }
  return {
    results,
    accuracy,
    passRate: results.length === 0 ? 0 : results.filter((r) => r.pass).length / results.length,
  };
}
