import {
  makeOcrExtraction,
  ok,
  err,
  appDomain,
  DemoOcrAdapter,
  SystemClock,
  type OcrPort,
  type OcrExtractInput,
  type OcrExtraction,
  type OcrExtractionDraft,
  type Result,
  type AppError,
} from '@bob/core';
import { buildSystemPrompt, type PromptContext } from '@bob/ai';
import { hasClaudeKey, hasMistralKey, isDemoMode } from '../config/env';

export const OCR_PORT = Symbol('OCR_PORT');

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
/** Plafond payload (base64) : ~10 Mo décodés — garde-fou avant tout appel modèle. */
const MAX_BASE64_LENGTH = 14_000_000;
const TIMEOUT_MS = 25_000;

/**
 * Prompt « expert-comptable » (A2/A3-C14) : base figée + contexte métier typé via le
 * constructeur de prompts @bob/ai (buildSystemPrompt) — personnalisé par l'activité,
 * jamais par du texte libre. Les garde-fous du domaine revalident toute sortie.
 */
function ocrSystemPrompt(input: OcrExtractInput, today: string): string {
  const ctx: PromptContext = {
    ...(input.trade
      ? {
          trade: {
            label: input.trade.label,
            customerWord: input.trade.customerWord,
            projectWord: input.trade.projectWord,
            ...(input.trade.defaultVatRatePct !== undefined
              ? { defaultVatRatePct: input.trade.defaultVatRatePct }
              : {}),
          },
        }
      : {}),
    today,
  };
  return `${buildSystemPrompt('ocr.extract', ctx)}\nSchéma exact: ${SCHEMA_HINT}`;
}

const SCHEMA_HINT =
  '{"supplierName":string|null,"supplierSiren":string|null,"documentDate":"YYYY-MM-DD"|null,' +
  '"totalTtcCents":int|null,"totalHtCents":int|null,"vatCents":int|null,"vatRatePctApplied":number|null,' +
  '"currency":"EUR","categoryGuess":"...","confidence":number,"rawText":string,' +
  '"suggestedTags":[string],"suggestedFilename":string|null}';

function guardInput(input: OcrExtractInput): AppError | null {
  if (!ACCEPTED_MIME.includes(input.mimeType))
    return { kind: 'validation', issues: [{ field: 'mimeType', message: `Type non supporté : ${input.mimeType}` }] };
  if (input.contentBase64.length > MAX_BASE64_LENGTH)
    return { kind: 'validation', issues: [{ field: 'contentBase64', message: 'Document trop volumineux (10 Mo max).' }] };
  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Extrait le premier objet JSON d'une réponse de modèle (tolère les fences markdown). */
function parseModelJson(raw: string): OcrExtractionDraft | null {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as OcrExtractionDraft;
  } catch {
    return null;
  }
}

/**
 * Adapter OCR Mistral (PRIORITÉ — directive humaine 2026-07-03) :
 * 1. `mistral-ocr-latest` (modèle OCR DÉDIÉ, ≠ chat/vision) : document → markdown fidèle ;
 * 2. extraction structurée sur ce markdown (petit modèle, température 0, json_object).
 * La sortie repasse par makeOcrExtraction (garde-fous domaine : dates bornées, plafond,
 * cohérence HT+TVA=TTC, taux français, tags/nom de fichier assainis).
 */
export class MistralOcrAdapter implements OcrPort {
  constructor(
    private readonly apiKey: string,
    private readonly ocrModel = process.env.MISTRAL_OCR_MODEL ?? 'mistral-ocr-latest',
    private readonly extractModel = process.env.MISTRAL_OCR_EXTRACT_MODEL ?? 'mistral-small-latest',
    private readonly clock = new SystemClock(),
  ) {}

  async extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>> {
    const invalid = guardInput(input);
    if (invalid) return err(invalid);
    try {
      // 1) OCR dédié : le document devient du markdown fidèle (tableaux, montants, en-têtes).
      const dataUri = `data:${input.mimeType};base64,${input.contentBase64}`;
      const document =
        input.mimeType === 'application/pdf'
          ? { type: 'document_url', document_url: dataUri }
          : { type: 'image_url', image_url: dataUri };
      const ocrRes = await fetchWithTimeout('https://api.mistral.ai/v1/ocr', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.ocrModel, document, include_image_base64: false }),
      });
      if (!ocrRes.ok) return err({ kind: 'dependency', port: 'ocr', cause: `mistral-ocr HTTP ${ocrRes.status}` });
      const ocrData = (await ocrRes.json()) as { pages?: { markdown?: string }[] };
      const markdown = (ocrData.pages ?? [])
        .map((p) => p.markdown ?? '')
        .join('\n\n')
        .trim();
      if (!markdown) return err({ kind: 'dependency', port: 'ocr', cause: 'mistral-ocr : document illisible (aucun texte).' });

      // 2) Extraction structurée par l'expert-comptable (température 0, JSON strict).
      const chatRes = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.extractModel,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: ocrSystemPrompt(input, this.clock.today()) },
            { role: 'user', content: `Pièce fournisseur (OCR markdown) :\n\n${markdown.slice(0, 24_000)}` },
          ],
        }),
      });
      if (!chatRes.ok) return err({ kind: 'dependency', port: 'ocr', cause: `mistral-extract HTTP ${chatRes.status}` });
      const chatData = (await chatRes.json()) as { choices?: { message?: { content?: string } }[] };
      const draft = parseModelJson(chatData.choices?.[0]?.message?.content ?? '');
      if (!draft) return err({ kind: 'dependency', port: 'ocr', cause: 'mistral-extract : réponse non-JSON.' });
      // Le rawText de référence = le markdown OCR (fidèle), pas la paraphrase du modèle.
      const norm = makeOcrExtraction({ ...draft, rawText: markdown }, { today: this.clock.today() });
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

/** Adapter OCR vision Claude (repli). Clé jamais sur le device. */
export class ClaudeVisionOcrAdapter implements OcrPort {
  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-opus-4-8',
    private readonly clock = new SystemClock(),
  ) {}

  async extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>> {
    const invalid = guardInput(input);
    if (invalid) return err(invalid);
    const block =
      input.mimeType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.contentBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: input.contentBase64 } };
    try {
      const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: ocrSystemPrompt(input, this.clock.today()),
          messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extrais les champs du document au format JSON demandé.' }] }],
        }),
      });
      if (!res.ok) return err({ kind: 'dependency', port: 'ocr', cause: `claude-vision HTTP ${res.status}` });
      const data = (await res.json()) as { content?: { type?: string; text?: string }[]; stop_reason?: string };
      if (data.stop_reason === 'max_tokens')
        return err({ kind: 'dependency', port: 'ocr', cause: 'Réponse OCR tronquée (max_tokens).' });
      const textBlock = data.content?.find((c) => c.type === 'text') ?? data.content?.[0];
      const draft = parseModelJson(textBlock?.text ?? '');
      if (!draft) return err({ kind: 'dependency', port: 'ocr', cause: 'claude-vision : réponse non-JSON.' });
      const norm = makeOcrExtraction(draft, { today: this.clock.today() });
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

/**
 * Chaîne de repli OCR : essaie chaque moteur dans l'ordre, premier résultat VALIDE gagne
 * (chaque moteur repasse déjà par les garde-fous du domaine). Une erreur de validation du
 * payload (MIME/taille) est définitive — inutile de réessayer ailleurs.
 * Ordre voulu (directive) : Mistral OCR → Claude Vision → (Gemini, GLM, DeepSeek : slots
 * prêts — ajouter un adapter implémentant OcrPort quand la clé existe).
 */
export class FallbackOcrChain implements OcrPort {
  constructor(private readonly engines: readonly OcrPort[]) {
    if (engines.length === 0) throw new Error('FallbackOcrChain : au moins un moteur requis.');
  }

  async extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>> {
    let lastError: AppError = { kind: 'dependency', port: 'ocr', cause: 'Aucun moteur OCR disponible.' };
    for (const engine of this.engines) {
      const r = await engine.extractDocument(input);
      if (r.ok) return r;
      if (r.error.kind === 'validation') return r; // payload invalide : définitif
      lastError = r.error;
    }
    return err(lastError);
  }

  async health(): Promise<{ healthy: boolean }> {
    for (const engine of this.engines) {
      const h = await engine.health();
      if (h.healthy) return { healthy: true };
    }
    return { healthy: false };
  }
}

/**
 * Bascule : démo déterministe en DEMO_MODE ; sinon chaîne LLM réelle, MISTRAL EN PRIORITÉ
 * (clé présente — directive humaine 2026-07-03), Claude Vision en repli ; sans aucune clé,
 * la démo garde l'app fonctionnelle (parité hors-ligne).
 */
export const ocrProvider = {
  provide: OCR_PORT,
  useFactory: (): OcrPort => {
    if (isDemoMode()) return new DemoOcrAdapter(new SystemClock());
    const engines: OcrPort[] = [];
    if (hasMistralKey()) engines.push(new MistralOcrAdapter(process.env.MISTRAL_API_KEY as string));
    if (hasClaudeKey()) engines.push(new ClaudeVisionOcrAdapter(process.env.ANTHROPIC_API_KEY as string));
    if (engines.length === 0) return new DemoOcrAdapter(new SystemClock());
    return new FallbackOcrChain(engines);
  },
};
