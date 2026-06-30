import {
  type LlmPort,
  type LlmMessage,
  type LlmResult,
  type LlmCompletion,
  type LlmCompleteOptions,
  type LlmToolCall,
  type Provider,
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
