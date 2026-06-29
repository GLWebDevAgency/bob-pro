import {
  makeOcrExtraction,
  ok,
  err,
  appDomain,
  DemoOcrAdapter,
  type OcrPort,
  type OcrExtractInput,
  type OcrExtraction,
  type OcrExtractionDraft,
  type Result,
  type AppError,
} from '@bob/core';
import { hasClaudeKey, isDemoMode } from '../config/env';

export const OCR_PORT = Symbol('OCR_PORT');

const SYSTEM_PROMPT =
  "Tu es un extracteur de factures/tickets fournisseurs FRANÇAIS. Réponds UNIQUEMENT par un objet JSON valide (sans markdown, sans texte autour). " +
  'Montants en CENTIMES entiers. Mets null si une valeur est absente/illisible. ' +
  'categoryGuess parmi: fournitures|materiel|carburant|repas|sous_traitance|autre. confidence entre 0 et 1.';

const SCHEMA_HINT =
  '{"supplierName":string|null,"supplierSiren":string|null,"documentDate":"YYYY-MM-DD"|null,"totalTtcCents":int|null,"totalHtCents":int|null,"vatCents":int|null,"vatRatePctApplied":number|null,"currency":"EUR","categoryGuess":"...","confidence":number,"rawText":string}';

/** Adapter OCR réel via la vision Claude (Anthropic). Clé jamais sur le device. */
export class ClaudeVisionOcrAdapter implements OcrPort {
  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-opus-4-8',
  ) {}

  async extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>> {
    const block =
      input.mimeType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.contentBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: input.contentBase64 } };
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [block, { type: 'text', text: `Extrais les champs au format JSON: ${SCHEMA_HINT}` }] }],
        }),
      });
      if (!res.ok) return err({ kind: 'dependency', port: 'ocr', cause: `HTTP ${res.status}` });
      const data = (await res.json()) as { content?: { text?: string }[] };
      const text = data.content?.[0]?.text ?? '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return err({ kind: 'dependency', port: 'ocr', cause: 'Réponse OCR non-JSON.' });
      const parsed = JSON.parse(text.slice(start, end + 1)) as OcrExtractionDraft;
      const norm = makeOcrExtraction(parsed);
      if (!norm.ok) return err(appDomain(norm.error));
      return ok(norm.value);
    } catch (e) {
      return err({ kind: 'dependency', port: 'ocr', cause: e instanceof Error ? e.message : 'ocr' });
    }
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: this.apiKey.length > 0 };
  }
}

/** Bascule : vision Claude en prod si clé présente, sinon démo déterministe (parité hors-ligne). */
export const ocrProvider = {
  provide: OCR_PORT,
  useFactory: (): OcrPort => {
    if (!isDemoMode() && hasClaudeKey()) return new ClaudeVisionOcrAdapter(process.env.ANTHROPIC_API_KEY as string);
    return new DemoOcrAdapter();
  },
};
