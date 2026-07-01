import {
  type LlmPort,
  type LlmMessage,
  type LlmResult,
  type LlmCompletion,
  type LlmCompleteOptions,
  type LlmToolCall,
  type Provider,
  type SttPort,
  type SttResult,
  type TtsPort,
  type TtsResult,
} from '@bob/ai';

const TIMEOUT_MS = 12_000;

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
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
    const data = (await fetchJson(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
    })) as OpenAiResponse;
    const msg = data.choices?.[0]?.message;
    const toolCalls: LlmToolCall[] = (msg?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c) => ({ name: c.function.name, arguments: safeParseArgs(c.function.arguments) }));
    return { text: msg?.content ?? null, toolCalls, model: data.model ?? this.cfg.model };
  }

  async generate(messages: LlmMessage[]): Promise<LlmResult> {
    const r = await this.complete(messages);
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
    const data = (await fetchJson(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })) as AnthropicResponse;
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

  async generate(messages: LlmMessage[]): Promise<LlmResult> {
    const r = await this.complete(messages);
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
  readonly id = 'whisper';
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.WHISPER_MODEL ?? 'whisper-1',
    private readonly baseUrl = process.env.OPENAI_URL ?? 'https://api.openai.com/v1',
  ) {}

  async transcribe(audioBase64: string, mimeType: string): Promise<SttResult> {
    const bytes = Buffer.from(audioBase64, 'base64');
    const ext = audioExtension(mimeType);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), `audio.${ext}`);
    form.append('model', this.model);
    form.append('language', 'fr');
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { text?: string };
    return { text: (data.text ?? '').trim(), model: this.model };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: !!this.apiKey };
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

  async transcribe(audioBase64: string, mimeType: string): Promise<SttResult> {
    const bytes = Buffer.from(audioBase64, 'base64');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), `audio.${audioExtension(mimeType)}`);
    form.append('model', this.model);
    form.append('language', 'fr');
    if (this.contextBias.trim()) form.append('context_bias', this.contextBias.trim());
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { text?: string };
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
  ) {}

  async synthesize(text: string): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      response_format: this.responseFormat,
    };
    if (this.voiceId) body.voice_id = this.voiceId;
    const res = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { audio_data?: string };
      return { audioBase64: data.audio_data ?? '', mimeType: `audio/${this.responseFormat}`, model: this.model };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return { audioBase64: bytes.toString('base64'), mimeType: contentType || `audio/${this.responseFormat}`, model: this.model };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: !!this.apiKey };
  }
}

/** STT cloud : Mistral Voxtral prioritaire si configuré, fallback OpenAI Whisper. */
export function buildSttCloud(): SttPort | undefined {
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
  return process.env.MISTRAL_API_KEY ? new MistralVoxtralTtsAdapter(process.env.MISTRAL_API_KEY) : undefined;
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
