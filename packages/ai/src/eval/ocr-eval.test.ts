import { describe, expect, it } from 'vitest';
import { OCR_GOLDEN_CASES } from './ocr-golden';
import { runOcrEval, scoreOcrCase, type OcrEvalOutcome } from './ocr-eval';

const PERFECT: Record<string, OcrEvalOutcome> = Object.fromEntries(
  OCR_GOLDEN_CASES.map((c) => [
    c.name,
    c.expected.rejected
      ? ({ kind: 'rejected' } as const)
      : ({
          kind: 'extracted',
          value: {
            supplierName: c.expected.supplierName ?? 'X',
            documentDate: c.expected.documentDate ?? '2026-01-01',
            totalTtcCents: c.expected.totalTtcCents ?? 0,
            vatCents: c.expected.vatCents ?? null,
            categoryGuess: c.expected.categoryGuess ?? 'autre',
            confidence: 0.9,
          },
        } as const),
  ]),
);

describe('banc d’évaluation OCR (#13) — scoreur pur', () => {
  it('un moteur parfait obtient un passRate de 1 et 100 % par champ', async () => {
    const report = await runOcrEval(OCR_GOLDEN_CASES, async (c) => PERFECT[c.name]!);
    expect(report.passRate).toBe(1);
    expect(report.accuracy.totalTtc).toBe(1);
    expect(report.accuracy.rejection).toBe(1);
  });

  it('note champ par champ : montant faux = échec du cas, pas des autres champs', () => {
    const scores = scoreOcrCase(
      { supplierName: 'Cedeo', documentDate: '2026-06-20', totalTtcCents: 34200 },
      {
        kind: 'extracted',
        value: {
          supplierName: 'CEDEO France SAS',
          documentDate: '2026-06-20',
          totalTtcCents: 34300,
          vatCents: null,
          categoryGuess: 'materiel',
          confidence: 0.8,
        },
      },
    );
    expect(scores.supplier).toBe(true); // tolérant aux suffixes juridiques
    expect(scores.date).toBe(true);
    expect(scores.totalTtc).toBe(false);
  });

  it('un rejet attendu (devise USD) ne passe QUE si le moteur rejette', () => {
    expect(scoreOcrCase({ rejected: true }, { kind: 'rejected' }).rejection).toBe(true);
    expect(
      scoreOcrCase(
        { rejected: true },
        {
          kind: 'extracted',
          value: { supplierName: 'GitHub', documentDate: '2026-06-30', totalTtcCents: 4800, vatCents: null, categoryGuess: 'autre', confidence: 0.9 },
        },
      ).rejection,
    ).toBe(false);
  });

  it('une extraction attendue mais rejetée compte faux sur tous les champs attendus', () => {
    const scores = scoreOcrCase(
      { supplierName: 'Cedeo', totalTtcCents: 34200 },
      { kind: 'rejected', reason: 'x' },
    );
    expect(scores.supplier).toBe(false);
    expect(scores.totalTtc).toBe(false);
  });

  it('le golden set couvre les cas clés (10 cas, 2 métiers, 1 rejet devise, 1 TVA null)', () => {
    expect(OCR_GOLDEN_CASES.length).toBeGreaterThanOrEqual(9);
    expect(OCR_GOLDEN_CASES.some((c) => c.expected.rejected)).toBe(true);
    expect(OCR_GOLDEN_CASES.some((c) => c.expected.vatCents === null)).toBe(true);
    expect(new Set(OCR_GOLDEN_CASES.map((c) => c.trade?.label)).size).toBeGreaterThanOrEqual(2);
  });
});
