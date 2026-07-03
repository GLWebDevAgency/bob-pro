import { describe, expect, it } from 'vitest';
import { OCR_GOLDEN_CASES, runOcrEval, type OcrEvalOutcome } from '@bob/ai';
import { MistralOcrAdapter } from './ocr';

/**
 * #13 (excellence) — BANC D'ÉVALUATION LIVE : mesure la précision par champ du couple
 * prompt × modèle Mistral sur le golden set. Gaté par env (appels API réels, payants) :
 *   OCR_EVAL=1 MISTRAL_API_KEY=… npx vitest run src/ocr/ocr-eval.live.test.ts
 * Les seuils sont le CONTRAT de qualité : s'ils cassent après un changement de prompt
 * ou de modèle, on ne merge pas.
 */
const LIVE = process.env.OCR_EVAL === '1' && !!process.env.MISTRAL_API_KEY;

describe.skipIf(!LIVE)('éval OCR live — Mistral (golden set annoté)', () => {
  it(
    'précision par champ ≥ seuils (TTC 0.8 · fournisseur 0.8 · rejet devise 1.0 · pass 0.6)',
    async () => {
      const adapter = new MistralOcrAdapter(process.env.MISTRAL_API_KEY as string);
      const report = await runOcrEval(OCR_GOLDEN_CASES, async (c): Promise<OcrEvalOutcome> => {
        const r = await adapter.extractFromMarkdown(c.markdown, {
          contentBase64: '',
          mimeType: 'image/jpeg',
          ...(c.trade ? { trade: c.trade } : {}),
        });
        if (!r.ok) return { kind: 'rejected', reason: JSON.stringify(r.error) };
        return { kind: 'extracted', value: r.value };
      });

      // Rapport lisible dans la sortie du test — la base des décisions de catalogue.
      console.info('\n── Éval OCR Mistral ──');
      for (const result of report.results) console.info(`${result.pass ? '✓' : '✗'} ${result.name}`, result.scores);
      console.info('accuracy:', report.accuracy, 'passRate:', report.passRate);

      expect(report.accuracy.totalTtc ?? 0).toBeGreaterThanOrEqual(0.8);
      expect(report.accuracy.supplier ?? 0).toBeGreaterThanOrEqual(0.8);
      expect(report.accuracy.rejection ?? 0).toBe(1);
      expect(report.passRate).toBeGreaterThanOrEqual(0.6);
    },
    240_000,
  );
});
