import {
  type LlmPort,
  type LlmMessage,
  type LlmResult,
  type LlmCompletion,
  type LlmCompleteOptions,
  type LlmGenerateOptions,
  type LlmToolCall,
  type Provider,
  type SttPort,
  type SttResult,
  type TtsPort,
  type TtsResult,
} from '@bob/ai';
import {
  isValidLocalWhisperAuditToken,
  isLocalWhisperAuditHealthPayload,
  LOCAL_WHISPER_AUDIT_CONTRACT,
  parseLocalWhisperAuditBaseUrl,
  type LocalWhisperAuditEndpoints,
} from './local-whisper-audit-contract';

const TIMEOUT_MS = 12_000;
const VOICE_PROVIDER_TIMEOUT_MS = 20_000;
const MAX_STT_JSON_BYTES = 64 * 1024;
const MAX_STT_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_STT_BASE64_CHARS = Math.ceil(MAX_STT_AUDIO_BYTES * 4 / 3) + 4;
const MAX_STT_TEXT_CHARS = 16 * 1024;
const MAX_TTS_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_TTS_JSON_BYTES = Math.ceil(MAX_TTS_AUDIO_BYTES * 4 / 3) + 64 * 1024;
const MAX_TTS_STREAM_EVENT_BYTES = 512 * 1024;
const MAX_TTS_STREAM_AUDIO_CHUNK_BYTES = 256 * 1024;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const OPENAI_AUDIO_SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const OPENAI_REALTIME_TTS_MODEL = 'gpt-4o-mini-tts-2025-12-15';
const OPENAI_REALTIME_TTS_VOICE = 'marin';
const WAVE_STREAMING_LENGTH_SENTINEL = 0xffff_ffff;
const MAX_WAVE_CHUNKS = 64;
const OPENAI_REALTIME_TTS_INSTRUCTIONS = [
  'Parle en français de France avec une voix naturelle, chaleureuse et professionnelle,',
  'à un débit conversationnel. Articule clairement les montants, dates et références.',
  'Lis exactement le texte fourni sans rien ajouter ni omettre.',
].join(' ');
const MISTRAL_AUDIO_API_BASE_URL = 'https://api.mistral.ai/v1';

function boundedProviderSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(VOICE_PROVIDER_TIMEOUT_MS);
  return callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
}

/**
 * L'API Speech OpenAI diffuse le WAV et laisse actuellement les longueurs RIFF et `data` à
 * `0xffffffff`. Une fois le téléchargement borné terminé, les octets sont pourtant complets.
 *
 * On matérialise uniquement ces longueurs de conteneur. Le payload PCM n'est jamais réencodé ni
 * déplacé. Toutes les formes ambiguës restent refusées afin que le renderer et l'auditeur privé
 * reçoivent un WAV canonique à longueurs finies.
 */
function materializeOpenAiWaveLengths(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength < 44
    || bytes[0] !== 0x52
    || bytes[1] !== 0x49
    || bytes[2] !== 0x46
    || bytes[3] !== 0x46
    || bytes[8] !== 0x57
    || bytes[9] !== 0x41
    || bytes[10] !== 0x56
    || bytes[11] !== 0x45
  ) {
    throw new Error('voice_provider_invalid_audio');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expectedRiffSize = bytes.byteLength - 8;
  const declaredRiffSize = view.getUint32(4, true);
  if (
    declaredRiffSize !== expectedRiffSize
    && declaredRiffSize !== WAVE_STREAMING_LENGTH_SENTINEL
  ) {
    throw new Error('voice_provider_invalid_audio');
  }

  let offset = 12;
  let formatChunkSeen = false;
  let blockAlign: number | null = null;
  let dataChunkOffset: number | null = null;
  let materializedDataSize: number | null = null;
  let chunkCount = 0;
  while (offset + 8 <= bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > MAX_WAVE_CHUNKS) throw new Error('voice_provider_invalid_audio');
    const isFormat = bytes[offset] === 0x66
      && bytes[offset + 1] === 0x6d
      && bytes[offset + 2] === 0x74
      && bytes[offset + 3] === 0x20;
    const isData = bytes[offset] === 0x64
      && bytes[offset + 1] === 0x61
      && bytes[offset + 2] === 0x74
      && bytes[offset + 3] === 0x61;
    const declaredSize = view.getUint32(offset + 4, true);
    const contentStart = offset + 8;
    if (isFormat) {
      if (
        formatChunkSeen
        || declaredSize === WAVE_STREAMING_LENGTH_SENTINEL
        || declaredSize < 16
        || declaredSize > bytes.byteLength - contentStart
      ) {
        throw new Error('voice_provider_invalid_audio');
      }
      formatChunkSeen = true;
      blockAlign = view.getUint16(contentStart + 12, true);
      if (blockAlign < 1) throw new Error('voice_provider_invalid_audio');
    }
    if (isData) {
      if (!formatChunkSeen || dataChunkOffset !== null || blockAlign === null) {
        throw new Error('voice_provider_invalid_audio');
      }
      dataChunkOffset = offset;
    }
    if (declaredSize === WAVE_STREAMING_LENGTH_SENTINEL) {
      if (!isData) throw new Error('voice_provider_invalid_audio');
      const actualSize = bytes.byteLength - contentStart;
      // Une taille non alignée nécessiterait un octet de padding impossible à distinguer du
      // payload avec une longueur sentinelle. Le refuser est la seule décision fail-closed.
      if (
        actualSize <= 0
        || actualSize % 2 !== 0
        || blockAlign === null
        || actualSize % blockAlign !== 0
      ) {
        throw new Error('voice_provider_invalid_audio');
      }
      materializedDataSize = actualSize;
      offset = bytes.byteLength;
      break;
    }
    if (declaredSize > bytes.byteLength - contentStart) {
      throw new Error('voice_provider_invalid_audio');
    }
    const paddedEnd = contentStart + declaredSize + (declaredSize % 2);
    if (paddedEnd > bytes.byteLength) throw new Error('voice_provider_invalid_audio');
    if (
      isData
      && (
        declaredSize <= 0
        || blockAlign === null
        || declaredSize % blockAlign !== 0
        || paddedEnd !== bytes.byteLength
      )
    ) {
      // L'audio OpenAI qualifié ne possède aucun chunk après `data`. Accepter une queue
      // inconnue rendrait la matérialisation sentinelle ambiguë entre deux réponses.
      throw new Error('voice_provider_invalid_audio');
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.byteLength || !formatChunkSeen || dataChunkOffset === null) {
    throw new Error('voice_provider_invalid_audio');
  }

  if (materializedDataSize !== null) {
    view.setUint32(dataChunkOffset + 4, materializedDataSize, true);
  }
  if (declaredRiffSize === WAVE_STREAMING_LENGTH_SENTINEL) {
    view.setUint32(4, expectedRiffSize, true);
  }
  return bytes;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const announced = response.headers.get('content-length');
  if (announced !== null) {
    const length = Number(announced);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      await response.body?.cancel('voice-response-too-large').catch(() => undefined);
      throw new Error('voice_provider_response_too_large');
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onAbort = (): void => { void reader.cancel('voice-request-aborted').catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    let part = await reader.read();
    while (!part.done) {
      signal.throwIfAborted();
      length += part.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel('voice-response-too-large');
        throw new Error('voice_provider_response_too_large');
      }
      chunks.push(part.value);
      part = await reader.read();
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response, maxBytes, signal);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('voice_provider_invalid_json');
  }
}

async function fetchJson(url: string, init: RequestInit, callerSignal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function audioExtension(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg') || mimeType.includes('opus')) return 'ogg';
  if (mimeType.includes('mp4')) return 'mp4';
  return 'm4a';
}

function decodeCanonicalAudioBase64(audioBase64: string): Uint8Array {
  if (
    !audioBase64
    || audioBase64.length > MAX_STT_BASE64_CHARS
    || audioBase64.length % 4 !== 0
    || !CANONICAL_BASE64.test(audioBase64)
  ) {
    throw new Error('voice_provider_invalid_audio');
  }
  const bytes = Buffer.from(audioBase64, 'base64');
  if (bytes.byteLength > MAX_STT_AUDIO_BYTES || bytes.toString('base64') !== audioBase64) {
    throw new Error('voice_provider_invalid_audio');
  }
  return new Uint8Array(bytes);
}

function decodeCanonicalBase64Chunk(value: unknown): Uint8Array {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > Math.ceil(MAX_TTS_STREAM_AUDIO_CHUNK_BYTES * 4 / 3) + 4
    || value.length % 4 !== 0
    || !CANONICAL_BASE64.test(value)
  ) throw new Error('voice_provider_invalid_stream');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('voice_provider_invalid_stream');
  return new Uint8Array(bytes);
}

async function readMistralSpeechStream(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'text/event-stream' || !response.body) {
    await response.body?.cancel('voice-invalid-stream').catch(() => undefined);
    throw new Error('voice_provider_invalid_stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const audioChunks: Uint8Array[] = [];
  let audioBytes = 0;
  let buffered = '';
  let eventType: string | null = null;
  let eventData: string | null = null;
  let done = false;
  const onAbort = (): void => { void reader.cancel('voice-request-aborted').catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });

  const consumeEvent = (): void => {
    if (eventType === null && eventData === null) return;
    if (eventData === null || Buffer.byteLength(eventData, 'utf8') > MAX_TTS_STREAM_EVENT_BYTES) {
      throw new Error('voice_provider_invalid_stream');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(eventData) as unknown;
    } catch {
      throw new Error('voice_provider_invalid_stream');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('voice_provider_invalid_stream');
    }
    const payload = parsed as Record<string, unknown>;
    if (typeof payload.type !== 'string' || (eventType !== null && eventType !== payload.type)) {
      throw new Error('voice_provider_invalid_stream');
    }
    const type = payload.type;
    if (type === 'speech.audio.delta') {
      if (done || Object.keys(payload).some((key) => key !== 'type' && key !== 'audio_data')) {
        throw new Error('voice_provider_invalid_stream');
      }
      const chunk = decodeCanonicalBase64Chunk(payload.audio_data);
      audioBytes += chunk.byteLength;
      if (audioBytes > MAX_TTS_AUDIO_BYTES) throw new Error('voice_provider_response_too_large');
      audioChunks.push(chunk);
    } else if (type === 'speech.audio.done') {
      if (
        done
        || !payload.usage
        || typeof payload.usage !== 'object'
        || Array.isArray(payload.usage)
        || Object.keys(payload).some((key) => key !== 'type' && key !== 'usage')
      ) {
        throw new Error('voice_provider_invalid_stream');
      }
      done = true;
    } else {
      throw new Error('voice_provider_invalid_stream');
    }
    eventType = null;
    eventData = null;
  };

  const consumeLine = (lineWithOptionalCr: string): void => {
    const line = lineWithOptionalCr.endsWith('\r') ? lineWithOptionalCr.slice(0, -1) : lineWithOptionalCr;
    if (line === '') {
      consumeEvent();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event' && eventType === null && value.length <= 64) eventType = value;
    else if (field === 'data' && eventData === null) eventData = value;
    else throw new Error('voice_provider_invalid_stream');
  };

  try {
    signal.throwIfAborted();
    let part = await reader.read();
    while (!part.done) {
      signal.throwIfAborted();
      buffered += decoder.decode(part.value, { stream: true });
      if (Buffer.byteLength(buffered, 'utf8') > MAX_TTS_STREAM_EVENT_BYTES + 1_024) {
        throw new Error('voice_provider_invalid_stream');
      }
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        consumeLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
      part = await reader.read();
    }
    buffered += decoder.decode();
    if (buffered.length > 0) consumeLine(buffered);
    consumeEvent();
    signal.throwIfAborted();
    if (!done || audioBytes === 0) throw new Error('voice_provider_invalid_stream');
  } catch (error) {
    await reader.cancel('voice-invalid-stream').catch(() => undefined);
    throw error instanceof Error ? error : new Error('voice_provider_invalid_stream');
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const output = new Uint8Array(audioBytes);
  let offset = 0;
  for (const chunk of audioChunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Adapter générique pour toute API « OpenAI-compatible » (chat/completions + function calling) :
 * GLM (Zhipu), DeepSeek, OpenAI, Mistral. Diffèrent seulement par baseUrl + modèle + clé.
 */
export class OpenAiCompatibleLlmAdapter implements LlmPort {
  constructor(private readonly cfg: { id: string; baseUrl: string; apiKey: string; model: string }) {}
  get id(): string {
    return this.cfg.id;
  }

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const msgs = opts.system ? [{ role: 'system', content: opts.system }, ...messages] : messages;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: msgs,
      temperature: opts.temperature ?? 0,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = opts.toolChoice === 'required' ? 'required' : opts.toolChoice === 'none' ? 'none' : 'auto';
    }
    const data = (await fetchJson(
      `${this.cfg.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
      },
      opts.signal,
    )) as OpenAiResponse;
    const msg = data.choices?.[0]?.message;
    const toolCalls: LlmToolCall[] = (msg?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c) => ({ name: c.function.name, arguments: safeParseArgs(c.function.arguments) }));
    return { text: msg?.content ?? null, toolCalls, model: data.model ?? this.cfg.model };
  }

  async generate(messages: LlmMessage[], opts: LlmGenerateOptions = {}): Promise<LlmResult> {
    const r = await this.complete(messages, opts);
    return { text: r.text ?? '', model: r.model };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: !!this.cfg.apiKey };
  }
}

/** Adapter Anthropic (Claude) — Messages API avec tool_use. */
export class AnthropicLlmAdapter implements LlmPort {
  readonly id = 'claude';
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0,
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    };
    if (opts.system) body.system = opts.system;
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      if (opts.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else if (opts.toolChoice !== 'none') body.tool_choice = { type: 'auto' };
    }
    const data = (await fetchJson(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      },
      opts.signal,
    )) as AnthropicResponse;
    const blocks = data.content ?? [];
    const toolCalls: LlmToolCall[] = blocks
      .filter((b) => b.type === 'tool_use' && b.name)
      .map((b) => ({ name: b.name as string, arguments: (b.input as Record<string, unknown>) ?? {} }));
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('') || null;
    return { text, toolCalls, model: data.model ?? this.model };
  }

  async generate(messages: LlmMessage[], opts: LlmGenerateOptions = {}): Promise<LlmResult> {
    const r = await this.complete(messages, opts);
    return { text: r.text ?? '', model: r.model };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: !!this.apiKey };
  }
}

/** Construit l'adapter du fournisseur choisi par le routeur (clés + URLs/modèles configurables par env). */
export function buildLlmForProvider(provider: Provider): LlmPort | undefined {
  const env = process.env;
  switch (provider) {
    case 'claude':
      return env.ANTHROPIC_API_KEY
        ? new AnthropicLlmAdapter(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001')
        : undefined;
    case 'glm':
      return env.GLM_API_KEY
        ? new OpenAiCompatibleLlmAdapter({
            id: 'glm',
            baseUrl: env.GLM_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
            apiKey: env.GLM_API_KEY,
            model: env.GLM_MODEL ?? 'glm-4-flash',
          })
        : undefined;
    case 'deepseek':
      return env.DEEPSEEK_API_KEY
        ? new OpenAiCompatibleLlmAdapter({
            id: 'deepseek',
            baseUrl: env.DEEPSEEK_URL ?? 'https://api.deepseek.com',
            apiKey: env.DEEPSEEK_API_KEY,
            model: env.DEEPSEEK_MODEL ?? 'deepseek-chat',
          })
        : undefined;
    case 'mistral':
      return env.MISTRAL_API_KEY
        ? new OpenAiCompatibleLlmAdapter({
            id: 'mistral',
            baseUrl: env.MISTRAL_URL ?? 'https://api.mistral.ai/v1',
            apiKey: env.MISTRAL_API_KEY,
            model: env.MISTRAL_MODEL ?? 'mistral-small-latest',
          })
        : undefined;
    case 'openai':
      return env.OPENAI_API_KEY
        ? new OpenAiCompatibleLlmAdapter({
            id: 'openai',
            baseUrl: env.OPENAI_URL ?? 'https://api.openai.com/v1',
            apiKey: env.OPENAI_API_KEY,
            model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
          })
        : undefined;
  }
}

/** STT cloud via OpenAI Whisper (audio/transcriptions). Lève en cas d'échec (l'appelant gère). */
export class WhisperSttAdapter implements SttPort {
  readonly id: string = 'whisper';
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.WHISPER_MODEL ?? 'whisper-1',
    private readonly baseUrl = process.env.OPENAI_URL ?? 'https://api.openai.com/v1',
  ) {}

  async transcribe(
    audioBase64: string,
    mimeType: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SttResult> {
    const bytes = Buffer.from(audioBase64, 'base64');
    const ext = audioExtension(mimeType);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), `audio.${ext}`);
    form.append('model', this.model);
    form.append('language', 'fr');
    const signal = boundedProviderSignal(options.signal);
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await readBoundedJson(res, MAX_STT_JSON_BYTES, signal)) as { text?: string };
    return { text: (data.text ?? '').trim(), model: this.model };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: !!this.apiKey };
  }
}

/**
 * Variante qualifiée exclusivement pour l'audit acoustique Bob Live.
 * Contrairement au STT générique, son endpoint n'est pas redirigeable via OPENAI_URL : annoncer
 * `openai.com` tout en appelant une API compatible tierce détruirait la preuve d'indépendance.
 */
export class OpenAiRealtimeSpeechAuditSttAdapter extends WhisperSttAdapter {
  override readonly id = 'openai-realtime-audit-whisper';
  readonly auditTrustDomain = 'openai.com' as const;

  constructor(apiKey: string, model = 'gpt-4o-mini-transcribe') {
    super(apiKey, model, 'https://api.openai.com/v1');
  }
}

export interface LocalWhisperAuditDeploymentProbePort {
  proveDeploymentControls(
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly healthy: boolean }>;
}

/**
 * Auditeur Whisper auto-hébergé, compatible multipart OpenAI sans dépendre d'OpenAI.
 * L'URL et le jeton restent des paramètres serveur ; le domaine de confiance n'est
 * volontairement pas configurable afin d'éviter de déclarer deux fournisseurs corrélés
 * comme indépendants par simple variable d'environnement.
 */
export class LocalWhisperAuditSttAdapter implements SttPort {
  readonly id = 'local-whisper';
  readonly auditTrustDomain = 'bob.local-whisper' as const;
  private readonly endpoints: LocalWhisperAuditEndpoints;

  constructor(
    private readonly token: string,
    baseUrl: string,
    private readonly model =
      process.env.REALTIME_SPEECH_AUDIT_STT_MODEL ?? LOCAL_WHISPER_AUDIT_CONTRACT.model.id,
  ) {
    if (
      !isValidLocalWhisperAuditToken(token)
      || model !== LOCAL_WHISPER_AUDIT_CONTRACT.model.id
    ) {
      throw new Error('local_whisper_invalid_config');
    }
    this.endpoints = parseLocalWhisperAuditBaseUrl(baseUrl);
  }

  async transcribe(
    audioBase64: string,
    mimeType: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SttResult> {
    const canonicalMimeType = mimeType.trim().toLowerCase().split(';', 1)[0];
    if (canonicalMimeType !== 'audio/wav' && canonicalMimeType !== 'audio/x-wav') {
      throw new Error('voice_provider_invalid_audio');
    }
    const bytes = decodeCanonicalAudioBase64(audioBase64);
    const form = new FormData();
    const blobBytes = new Uint8Array(bytes);
    form.append(
      'file',
      new Blob([blobBytes], { type: 'audio/wav' }),
      'audit.wav',
    );
    form.append('model', this.model);
    form.append('language', 'fr');
    const signal = boundedProviderSignal(options.signal);
    const res = await fetch(this.endpoints.transcriptionUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}` },
      body: form,
      redirect: 'error',
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel('local-whisper-http-error').catch(() => undefined);
      throw new Error(`local_whisper_http_${res.status}`);
    }
    const responseMimeType = res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (responseMimeType !== 'application/json') {
      await res.body?.cancel('local-whisper-invalid-content-type').catch(() => undefined);
      throw new Error('local_whisper_invalid_response');
    }
    const data = await readBoundedJson(res, MAX_STT_JSON_BYTES, signal);
    const text = data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string'
      ? (data as { text: string }).text.trim()
      : '';
    if (
      !data
      || typeof data !== 'object'
      || text.length === 0
      || text.length > MAX_STT_TEXT_CHARS
    ) {
      throw new Error('local_whisper_invalid_response');
    }
    signal.throwIfAborted();
    return { text, model: this.model };
  }

  async health(): Promise<{ healthy: boolean }> {
    const signal = AbortSignal.timeout(LOCAL_WHISPER_AUDIT_CONTRACT.healthTimeoutMs);
    try {
      const response = await fetch(this.endpoints.healthUrl, {
        method: 'GET',
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel('local-whisper-health-error').catch(() => undefined);
        return { healthy: false };
      }
      const responseMimeType = response.headers.get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (responseMimeType !== 'application/json') {
        await response.body?.cancel('local-whisper-health-content-type').catch(() => undefined);
        return { healthy: false };
      }
      const payload = await readBoundedJson(
        response,
        LOCAL_WHISPER_AUDIT_CONTRACT.maxHealthResponseBytes,
        signal,
      );
      return { healthy: isLocalWhisperAuditHealthPayload(payload) };
    } catch {
      return { healthy: false };
    }
  }

  /**
   * Prouve depuis le réseau réel de l'appelant que la frontière privée reste fermée.
   *
   * Aucun contenu métier n'est envoyé : les trois premiers appels sont vides et le dernier
   * contient uniquement des octets nuls au-delà de la limite annoncée. Le gateway doit le
   * refuser sur Content-Length avant tout parsing ou appel Whisper.
   */
  async proveDeploymentControls(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly healthy: boolean }> {
    if (options.signal?.aborted) return { healthy: false };
    const signal = boundedProviderSignal(options.signal);
    const wrongToken = `${this.token[0] === '!' ? '"' : '!'}${this.token.slice(1)}`;
    const oversized = new Uint8Array(LOCAL_WHISPER_AUDIT_CONTRACT.maxRequestBytes + 1);
    const controls: readonly {
      readonly url: string;
      readonly init: RequestInit;
      readonly expectedStatus: number;
    }[] = [
      {
        url: this.endpoints.transcriptionUrl,
        init: { method: 'POST', redirect: 'error', signal },
        expectedStatus: 401,
      },
      {
        url: this.endpoints.transcriptionUrl,
        init: {
          method: 'POST',
          headers: { authorization: `Bearer ${wrongToken}` },
          redirect: 'error',
          signal,
        },
        expectedStatus: 401,
      },
      {
        url: `${this.endpoints.baseUrl}/load`,
        init: { method: 'GET', redirect: 'error', signal },
        expectedStatus: 404,
      },
      {
        url: this.endpoints.transcriptionUrl,
        init: {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'multipart/form-data; boundary=bob-live-audit-readiness',
          },
          body: oversized,
          redirect: 'error',
          signal,
        },
        expectedStatus: 413,
      },
    ];
    try {
      for (const control of controls) {
        signal.throwIfAborted();
        const response = await fetch(control.url, control.init);
        const exact = response.status === control.expectedStatus
          && response.headers.get('cache-control') === 'no-store'
          && response.headers.get('content-type')?.toLowerCase()
            === 'application/json; charset=utf-8';
        await response.body?.cancel('local-whisper-deployment-control').catch(() => undefined);
        if (!exact) return { healthy: false };
      }
      signal.throwIfAborted();
      return { healthy: true };
    } catch {
      return { healthy: false };
    } finally {
      oversized.fill(0);
    }
  }
}

/** STT cloud Mistral Voxtral Mini Transcribe. Audio brut non persisté : base64 entrant -> multipart sortant. */
export class MistralVoxtralSttAdapter implements SttPort {
  readonly id = 'mistral-voxtral-stt';
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.MISTRAL_STT_MODEL ?? 'voxtral-mini-latest',
    private readonly baseUrl = process.env.MISTRAL_URL ?? 'https://api.mistral.ai/v1',
    private readonly contextBias = process.env.MISTRAL_STT_CONTEXT_BIAS ?? '',
  ) {}

  async transcribe(
    audioBase64: string,
    mimeType: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SttResult> {
    const bytes = Buffer.from(audioBase64, 'base64');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), `audio.${audioExtension(mimeType)}`);
    form.append('model', this.model);
    form.append('language', 'fr');
    if (this.contextBias.trim()) form.append('context_bias', this.contextBias.trim());
    const signal = boundedProviderSignal(options.signal);
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await readBoundedJson(res, MAX_STT_JSON_BYTES, signal)) as { text?: string };
    return { text: (data.text ?? '').trim(), model: this.model };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: !!this.apiKey };
  }
}

export class MistralVoxtralTtsAdapter implements TtsPort {
  readonly id = 'mistral-voxtral-tts';
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.MISTRAL_TTS_MODEL ?? 'voxtral-mini-tts-2603',
    private readonly baseUrl = process.env.MISTRAL_URL ?? 'https://api.mistral.ai/v1',
    private readonly voiceId = process.env.MISTRAL_TTS_VOICE_ID,
    private readonly responseFormat: 'mp3' | 'wav' | 'pcm' | 'flac' | 'opus' = 'mp3',
    private readonly stream = false,
  ) {}

  async synthesize(
    text: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      response_format: this.responseFormat,
      stream: this.stream,
    };
    if (this.voiceId) body.voice_id = this.voiceId;
    const signal = boundedProviderSignal(options.signal);
    const res = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (this.stream) {
      const bytes = await readMistralSpeechStream(res, signal);
      return {
        audioBase64: Buffer.from(bytes).toString('base64'),
        mimeType: `audio/${this.responseFormat}`,
        model: this.model,
      };
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = (await readBoundedJson(res, MAX_TTS_JSON_BYTES, signal)) as { audio_data?: string };
      return { audioBase64: data.audio_data ?? '', mimeType: `audio/${this.responseFormat}`, model: this.model };
    }
    const bytes = Buffer.from(await readBoundedBytes(res, MAX_TTS_AUDIO_BYTES, signal));
    return { audioBase64: bytes.toString('base64'), mimeType: contentType || `audio/${this.responseFormat}`, model: this.model };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: !!this.apiKey };
  }
}

/**
 * Sortie TTS OpenAI qualifiée pour Bob Live.
 *
 * L'endpoint est volontairement non configurable : le domaine de confiance publié dans la
 * preuve audio doit correspondre au fournisseur réel, et non à un proxy « compatible OpenAI ».
 */
export class OpenAiRealtimeSpeechTtsAdapter implements TtsPort {
  readonly id = 'openai-realtime-tts';
  readonly synthesisTrustDomain = 'openai.com' as const;

  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.OPENAI_TTS_MODEL ?? OPENAI_REALTIME_TTS_MODEL,
    private readonly voice = process.env.OPENAI_REALTIME_VOICE ?? OPENAI_REALTIME_TTS_VOICE,
  ) {}

  async synthesize(
    text: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TtsResult> {
    const signal = boundedProviderSignal(options.signal);
    const res = await fetch(OPENAI_AUDIO_SPEECH_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: 'wav',
        instructions: OPENAI_REALTIME_TTS_INSTRUCTIONS,
      }),
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel('openai-tts-http-error').catch(() => undefined);
      throw new Error(`HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'audio/wav' && contentType !== 'audio/x-wav') {
      await res.body?.cancel('openai-tts-invalid-content-type').catch(() => undefined);
      throw new Error('voice_provider_invalid_audio');
    }
    const bytes = materializeOpenAiWaveLengths(
      await readBoundedBytes(res, MAX_TTS_AUDIO_BYTES, signal),
    );
    signal.throwIfAborted();
    if (bytes.byteLength === 0) throw new Error('voice_provider_invalid_audio');
    return {
      audioBase64: Buffer.from(bytes).toString('base64'),
      mimeType: 'audio/wav',
      model: this.model,
    };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: this.apiKey.trim().length > 0 };
  }
}

/** Variante Mistral qualifiée : endpoint officiel figé, WAV streamé et domaine attesté. */
export class MistralRealtimeSpeechTtsAdapter extends MistralVoxtralTtsAdapter {
  readonly synthesisTrustDomain = 'mistral.ai' as const;

  constructor(
    apiKey: string,
    model = process.env.MISTRAL_TTS_MODEL ?? 'voxtral-mini-tts-2603',
    voiceId = process.env.MISTRAL_TTS_VOICE_ID,
  ) {
    super(apiKey, model, MISTRAL_AUDIO_API_BASE_URL, voiceId, 'wav', true);
  }
}

function activeBobLiveVoiceProvider(): 'openai' | 'mistral' | null {
  const enabled = process.env.BOB_LIVE_ENABLED ?? process.env.OPENAI_REALTIME_ENABLED;
  if (enabled !== 'true') return null;
  return process.env.BOB_LIVE_PROVIDER === 'mistral' ? 'mistral' : 'openai';
}

/** STT cloud : Mistral Voxtral prioritaire si configuré, fallback OpenAI Whisper. */
export function buildSttCloud(): SttPort | undefined {
  const liveProvider = activeBobLiveVoiceProvider();
  if (liveProvider === 'openai') {
    return process.env.OPENAI_API_KEY
      ? new WhisperSttAdapter(
          process.env.OPENAI_API_KEY,
          process.env.WHISPER_MODEL ?? 'gpt-4o-mini-transcribe',
          'https://api.openai.com/v1',
        )
      : undefined;
  }
  if (liveProvider === 'mistral') {
    return process.env.MISTRAL_API_KEY
      ? new MistralVoxtralSttAdapter(
          process.env.MISTRAL_API_KEY,
          process.env.MISTRAL_STT_MODEL ?? 'voxtral-mini-latest',
          MISTRAL_AUDIO_API_BASE_URL,
        )
      : undefined;
  }
  const provider = process.env.STT_PROVIDER;
  if ((provider === 'mistral' || !provider) && process.env.MISTRAL_API_KEY) {
    return new MistralVoxtralSttAdapter(process.env.MISTRAL_API_KEY);
  }
  if ((provider === 'openai' || !provider) && process.env.OPENAI_API_KEY) {
    return new WhisperSttAdapter(process.env.OPENAI_API_KEY);
  }
  return undefined;
}

export function buildTtsCloud(): TtsPort | undefined {
  const liveProvider = activeBobLiveVoiceProvider();
  if (liveProvider) return buildRealtimeSpeechTts(liveProvider);
  return process.env.MISTRAL_API_KEY ? new MistralVoxtralTtsAdapter(process.env.MISTRAL_API_KEY) : undefined;
}

/**
 * Sortie Bob Live strictement mono-fournisseur.
 *
 * Aucune clé secondaire n'est consultée : une configuration OpenAI ne peut pas tomber sur
 * Mistral (et inversement), même si les deux secrets sont présents dans l'environnement.
 */
export function buildRealtimeSpeechTts(
  provider: 'openai' | 'mistral' = process.env.BOB_LIVE_PROVIDER === 'mistral' ? 'mistral' : 'openai',
): TtsPort | undefined {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_API_KEY
        ? new OpenAiRealtimeSpeechTtsAdapter(process.env.OPENAI_API_KEY)
        : undefined;
    case 'mistral':
      return process.env.MISTRAL_API_KEY
        ? new MistralRealtimeSpeechTtsAdapter(process.env.MISTRAL_API_KEY)
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Audit acoustique Bob Live : le profil de production utilise par défaut un Whisper
 * auto-hébergé par Bob. Le port OpenAI reste disponible uniquement sur sélection explicite
 * pour les consommateurs historiques hors du wiring Bob Live.
 */
export function buildRealtimeSpeechAuditStt(
  provider: 'openai' | 'local-whisper' = process.env.BOB_LIVE_AUDIT_PROVIDER === 'openai'
    ? 'openai'
    : 'local-whisper',
): SttPort | undefined {
  if (provider === 'local-whisper') {
    const token = process.env.BOB_LIVE_LOCAL_AUDIT_TOKEN;
    const baseUrl = process.env.BOB_LIVE_LOCAL_AUDIT_BASE_URL;
    return token && baseUrl
      ? new LocalWhisperAuditSttAdapter(token, baseUrl)
      : undefined;
  }
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY
      ? new OpenAiRealtimeSpeechAuditSttAdapter(
          process.env.OPENAI_API_KEY,
          process.env.REALTIME_SPEECH_AUDIT_STT_MODEL ?? 'gpt-4o-mini-transcribe',
        )
      : undefined;
  }
  return undefined;
}

interface OpenAiResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    };
  }>;
}

interface AnthropicResponse {
  model?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
}
