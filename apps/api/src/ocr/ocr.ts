import {
  makeOcrExtraction,
  ok,
  err,
  appDomain,
  appUnavailable,
  SystemClock,
  type OcrPort,
  type OcrExtractInput,
  type OcrExtraction,
  type OcrExtractionDraft,
  type Result,
  type AppError,
} from '@bob/core';
import { buildSystemPrompt, type PromptContext } from '@bob/ai';
import { hasClaudeKey, hasMistralKey } from '../config/env';

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
          },
        }
      : {}),
    today,
  };
  return `${buildSystemPrompt('ocr.extract', ctx)}\nSchéma exact: ${SCHEMA_HINT}`;
}

/**
 * #1 (excellence) — CONTRAT STRUCTUREL : le schéma n'est plus seulement « prié » dans le
 * prompt, il est IMPOSÉ par l'API (json_schema strict chez Mistral, tool use forcé chez
 * Claude). makeOcrExtraction reste le contrat exécutoire final (défense en profondeur).
 */
const OCR_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'supplierName',
    'supplierSiren',
    'documentDate',
    'totalTtcCents',
    'totalHtCents',
    'vatCents',
    'vatRatePctApplied',
    'currency',
    'categoryGuess',
    'confidence',
    'rawText',
    'suggestedTags',
    'suggestedFilename',
    'kind',
    'paymentMethodSeen',
    'dueDate',
  ],
  properties: {
    supplierName: { type: ['string', 'null'] },
    supplierSiren: { type: ['string', 'null'] },
    documentDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    totalTtcCents: { type: ['integer', 'null'] },
    totalHtCents: { type: ['integer', 'null'] },
    vatCents: { type: ['integer', 'null'] },
    vatRatePctApplied: { type: ['number', 'null'] },
    currency: { type: 'string' },
    categoryGuess: {
      type: 'string',
      enum: ['fournitures', 'materiel', 'carburant', 'repas', 'sous_traitance', 'autre'],
    },
    confidence: { type: 'number' },
    rawText: { type: 'string' },
    suggestedTags: { type: 'array', items: { type: 'string' } },
    suggestedFilename: { type: ['string', 'null'] },
    // Discriminant payé/à payer (bug ticket Leroy Merlin) : un ticket EST une preuve de
    // paiement ; null = le modèle avoue ne pas savoir, l'écran de validation demandera.
    kind: { type: ['string', 'null'], enum: ['ticket_caisse', 'facture_fournisseur', null] },
    paymentMethodSeen: { type: ['string', 'null'], enum: ['card', 'cash', null] },
    dueDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
  },
} as const;

const SCHEMA_HINT =
  '{"supplierName":string|null,"supplierSiren":string|null,"documentDate":"YYYY-MM-DD"|null,' +
  '"totalTtcCents":int|null,"totalHtCents":int|null,"vatCents":int|null,"vatRatePctApplied":number|null,' +
  '"currency":"code ISO 4217 reel (EUR, USD...)","categoryGuess":"...","confidence":number,"rawText":string,' +
  '"suggestedTags":[string],"suggestedFilename":string|null,' +
  '"kind":"ticket_caisse"|"facture_fournisseur"|null,"paymentMethodSeen":"card"|"cash"|null,' +
  '"dueDate":"YYYY-MM-DD"|null}';

function guardInput(input: OcrExtractInput): AppError | null {
  if (!ACCEPTED_MIME.includes(input.mimeType))
    return {
      kind: 'validation',
      issues: [{ field: 'mimeType', message: `Type non supporté : ${input.mimeType}` }],
    };
  if (input.contentBase64.length > MAX_BASE64_LENGTH)
    return {
      kind: 'validation',
      issues: [{ field: 'contentBase64', message: 'Document trop volumineux (10 Mo max).' }],
    };
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

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_BACKOFF_MS = 400;

/** #7 (excellence) : un seul retry sur erreur transitoire (429/5xx, réseau) — jamais sur 4xx métier. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    const first = await fetchWithTimeout(url, init);
    if (!RETRYABLE_STATUS.has(first.status)) return first;
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    return await fetchWithTimeout(url, init);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    return await fetchWithTimeout(url, init);
  }
}

/** Extrait le premier objet JSON d'une réponse de modèle (tolère les fences markdown). */
function parseModelJson(raw: string): OcrExtractionDraft | null {
  const cleaned = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
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
      const ocrRes = await fetchWithRetry('https://api.mistral.ai/v1/ocr', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.ocrModel, document, include_image_base64: false }),
      });
      if (!ocrRes.ok)
        return err({ kind: 'dependency', port: 'ocr', cause: `mistral-ocr HTTP ${ocrRes.status}` });
      const ocrData = (await ocrRes.json()) as { pages?: { markdown?: string }[] };
      const pages = (ocrData.pages ?? []).map((p) => p.markdown ?? '');
      const markdown = pages.join('\n\n').trim();
      if (!markdown)
        return err({
          kind: 'dependency',
          port: 'ocr',
          cause: 'mistral-ocr : document illisible (aucun texte).',
        });

      // #4 (excellence) : plusieurs pièces dans un même document → extraction fausse garantie.
      // Heuristique prudente : ≥ 2 pages portant chacune un EN-TÊTE de pièce distinct.
      const pieceHeaders = pages.filter((page) =>
        /facture\s*(n°|no|num|#)|ticket\s+de\s+caisse|re[çc]u\s*(n°|no|#)/i.test(page),
      ).length;
      if (pages.length > 1 && pieceHeaders >= 2)
        return err({
          kind: 'validation',
          issues: [
            {
              field: 'contentBase64',
              message: 'Plusieurs pièces détectées dans le document — scanne-les une par une.',
            },
          ],
        });

      return this.extractFromMarkdown(markdown, input);
    } catch (e) {
      return err({
        kind: 'dependency',
        port: 'ocr',
        cause: e instanceof Error ? e.message : 'ocr',
      });
    }
  }

  /**
   * Étape 2 seule (extraction structurée sur un markdown OCR) — publique pour le banc
   * d'évaluation (#13) : on évalue le prompt/modèle sur un jeu de pièces annotées sans
   * refaire l'étape OCR image.
   */
  async extractFromMarkdown(
    markdown: string,
    input: OcrExtractInput,
  ): Promise<Result<OcrExtraction, AppError>> {
    try {
      const body = (format: unknown): string =>
        JSON.stringify({
          model: this.extractModel,
          temperature: 0,
          response_format: format,
          messages: [
            { role: 'system', content: ocrSystemPrompt(input, this.clock.today()) },
            {
              role: 'user',
              content: `Pièce fournisseur (OCR markdown) :\n\n${markdown.slice(0, 24_000)}`,
            },
          ],
        });
      // #1 : schéma IMPOSÉ (json_schema strict) ; si l'API le refuse (400), repli json_object.
      let chatRes = await fetchWithRetry('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: body({
          type: 'json_schema',
          json_schema: { name: 'ocr_extraction', strict: true, schema: OCR_JSON_SCHEMA },
        }),
      });
      if (chatRes.status === 400) {
        chatRes = await fetchWithRetry('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: body({ type: 'json_object' }),
        });
      }
      if (!chatRes.ok)
        return err({
          kind: 'dependency',
          port: 'ocr',
          cause: `mistral-extract HTTP ${chatRes.status}`,
        });
      const chatData = (await chatRes.json()) as { choices?: { message?: { content?: string } }[] };
      const draft = parseModelJson(chatData.choices?.[0]?.message?.content ?? '');
      if (!draft)
        return err({
          kind: 'dependency',
          port: 'ocr',
          cause: 'mistral-extract : réponse non-JSON.',
        });
      // Le rawText de référence = le markdown OCR (fidèle), pas la paraphrase du modèle —
      // c'est lui qui alimente la vérification de provenance (#2) côté domaine.
      const norm = makeOcrExtraction(
        { ...draft, rawText: markdown },
        { today: this.clock.today() },
      );
      if (!norm.ok) return err(appDomain(norm.error));
      return ok(norm.value);
    } catch (e) {
      return err({
        kind: 'dependency',
        port: 'ocr',
        cause: e instanceof Error ? e.message : 'ocr',
      });
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
        ? {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: input.contentBase64 },
          }
        : {
            type: 'image',
            source: { type: 'base64', media_type: input.mimeType, data: input.contentBase64 },
          };
    try {
      const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: ocrSystemPrompt(input, this.clock.today()),
          // #1 (excellence) : le schéma est IMPOSÉ par tool use forcé — plus de parsing texte.
          tools: [
            {
              name: 'ocr_extraction',
              description: 'Restitue les champs extraits de la pièce fournisseur.',
              input_schema: OCR_JSON_SCHEMA,
            },
          ],
          tool_choice: { type: 'tool', name: 'ocr_extraction' },
          messages: [
            {
              role: 'user',
              content: [block, { type: 'text', text: 'Extrais les champs du document.' }],
            },
          ],
        }),
      });
      if (!res.ok)
        return err({ kind: 'dependency', port: 'ocr', cause: `claude-vision HTTP ${res.status}` });
      const data = (await res.json()) as {
        content?: { type?: string; text?: string; name?: string; input?: unknown }[];
        stop_reason?: string;
      };
      if (data.stop_reason === 'max_tokens')
        return err({
          kind: 'dependency',
          port: 'ocr',
          cause: 'Réponse OCR tronquée (max_tokens).',
        });
      const toolBlock = data.content?.find(
        (c) => c.type === 'tool_use' && c.name === 'ocr_extraction',
      );
      const draft = (toolBlock?.input ?? null) as OcrExtractionDraft | null;
      if (!draft || typeof draft !== 'object')
        return err({
          kind: 'dependency',
          port: 'ocr',
          cause: 'claude-vision : réponse hors contrat (tool_use absent).',
        });
      const norm = makeOcrExtraction(draft, { today: this.clock.today() });
      if (!norm.ok) return err(appDomain(norm.error));
      return ok(norm.value);
    } catch (e) {
      return err({
        kind: 'dependency',
        port: 'ocr',
        cause: e instanceof Error ? e.message : 'ocr',
      });
    }
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: this.apiKey.length > 0 };
  }
}

export interface NamedOcrEngine {
  readonly name: string;
  readonly port: OcrPort;
}

/** Événement d'observabilité par tentative moteur (#8) — loggé structuré côté provider. */
export interface OcrAttemptEvent {
  engine: string;
  ok: boolean;
  ms: number;
  error?: string;
  skipped?: 'breaker_open';
}

/** #7 — disjoncteur par moteur : 3 échecs consécutifs → ouvert 60 s (puis demi-ouvert). */
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;

class EngineBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(private readonly now: () => number) {}

  canPass(): boolean {
    if (this.openedAt === null) return true;
    if (this.now() - this.openedAt >= BREAKER_OPEN_MS) return true; // demi-ouvert : on retente
    return false;
  }

  record(ok: boolean): void {
    if (ok) {
      this.failures = 0;
      this.openedAt = null;
      return;
    }
    this.failures += 1;
    if (this.failures >= BREAKER_THRESHOLD) this.openedAt = this.now();
  }
}

/**
 * Chaîne de repli OCR : essaie chaque moteur dans l'ordre, premier résultat VALIDE gagne
 * (chaque moteur repasse déjà par les garde-fous du domaine). Une erreur de validation du
 * payload est définitive — inutile de réessayer ailleurs. Un moteur en panne répétée est
 * disjoncté 60 s (#7) ; chaque tentative est observable (#8).
 * Ordre voulu (directive) : Mistral OCR → Claude Vision → (Gemini, GLM, DeepSeek : slots
 * prêts — ajouter un adapter implémentant OcrPort quand la clé existe).
 */
export class FallbackOcrChain implements OcrPort {
  private readonly breakers: EngineBreaker[];

  constructor(
    private readonly engines: readonly NamedOcrEngine[],
    private readonly observer?: (event: OcrAttemptEvent) => void,
    now: () => number = () => Date.now(),
  ) {
    if (engines.length === 0) throw new Error('FallbackOcrChain : au moins un moteur requis.');
    this.breakers = engines.map(() => new EngineBreaker(now));
  }

  async extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>> {
    let lastError: AppError = {
      kind: 'dependency',
      port: 'ocr',
      cause: 'Aucun moteur OCR disponible.',
    };
    for (let i = 0; i < this.engines.length; i++) {
      const { name, port } = this.engines[i]!;
      const breaker = this.breakers[i]!;
      if (!breaker.canPass()) {
        this.observer?.({ engine: name, ok: false, ms: 0, skipped: 'breaker_open' });
        continue;
      }
      const startedAt = Date.now();
      const r = await port.extractDocument(input);
      const ms = Date.now() - startedAt;
      if (r.ok) {
        breaker.record(true);
        this.observer?.({ engine: name, ok: true, ms });
        return r;
      }
      if (r.error.kind === 'validation') {
        // Payload invalide ou multi-pièces : définitif, et ce n'est PAS une panne moteur.
        this.observer?.({ engine: name, ok: false, ms, error: 'validation' });
        return r;
      }
      breaker.record(false);
      this.observer?.({
        engine: name,
        ok: false,
        ms,
        error: 'cause' in r.error ? String(r.error.cause) : r.error.kind,
      });
      lastError = r.error;
    }
    return err(lastError);
  }

  async health(): Promise<{ healthy: boolean }> {
    for (const { port } of this.engines) {
      const h = await port.health();
      if (h.healthy) return { healthy: true };
    }
    return { healthy: false };
  }
}

/** Frontière live explicite : l'absence de moteur OCR est une capacité indisponible, jamais
 * une permission d'inventer les champs d'une pièce via l'adapter de démonstration. */
export class UnavailableOcrAdapter implements OcrPort {
  extractDocument(): Promise<Result<OcrExtraction, AppError>> {
    return Promise.resolve(err(appUnavailable('ocr')));
  }

  health(): Promise<{ healthy: boolean }> {
    return Promise.resolve({ healthy: false });
  }
}

/**
 * Chaîne OCR de production : Mistral en priorité et Claude Vision en repli.
 * Sans clé live, la capacité est indisponible ; le serveur ne fabrique jamais d'extraction.
 */
export function buildOcrAdapter(): OcrPort {
  const engines: NamedOcrEngine[] = [];
  if (hasMistralKey())
    engines.push({
      name: 'mistral-ocr',
      port: new MistralOcrAdapter(process.env.MISTRAL_API_KEY as string),
    });
  if (hasClaudeKey())
    engines.push({
      name: 'claude-vision',
      port: new ClaudeVisionOcrAdapter(process.env.ANTHROPIC_API_KEY as string),
    });
  if (engines.length === 0) return new UnavailableOcrAdapter();
  // #8 : chaque tentative moteur part en log structuré (moteur, latence, issue).
  return new FallbackOcrChain(engines, (event) =>
    console.info(JSON.stringify({ evt: 'ocr.engine', ...event })),
  );
}

export const ocrProvider = {
  provide: OCR_PORT,
  useFactory: buildOcrAdapter,
};
