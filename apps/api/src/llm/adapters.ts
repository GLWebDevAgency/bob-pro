import type { LlmPort, LlmMessage, LlmResult } from '@bob/ai';

function split(messages: LlmMessage[]): { system: string; chat: { role: string; content: string }[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const chat = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  return { system, chat };
}

/** Adapter Claude (Anthropic). Appelé côté backend uniquement (clé jamais sur le device). */
export class AnthropicAdapter implements LlmPort {
  readonly id = 'claude';
  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-opus-4-8',
  ) {}
  async generate(messages: LlmMessage[]): Promise<LlmResult> {
    const { system, chat } = split(messages);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: 1024, system, messages: chat }),
    });
    const data = (await res.json()) as { content?: { text?: string }[] };
    return { text: data.content?.[0]?.text ?? '', model: this.model };
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: this.apiKey.length > 0 };
  }
}

/** Adapter GLM (Zhipu), API compatible OpenAI. */
export class GlmAdapter implements LlmPort {
  readonly id = 'glm';
  constructor(
    private readonly apiKey: string,
    private readonly model = 'glm-4-plus',
  ) {}
  async generate(messages: LlmMessage[]): Promise<LlmResult> {
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: messages.map((m) => ({ role: m.role, content: m.content })) }),
    });
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return { text: data.choices?.[0]?.message?.content ?? '', model: this.model };
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: this.apiKey.length > 0 };
  }
}
