import { type LlmPort, type LlmMessage, type LlmResult } from './port';

/** Adapter déterministe, sans clé : dev/CI, fallback de panne, démo. Mêmes types de sortie. */
export class DemoLlmAdapter implements LlmPort {
  readonly id = 'demo';

  async generate(messages: LlmMessage[]): Promise<LlmResult> {
    const last = messages[messages.length - 1]?.content ?? '';
    return { text: `(démo) Bien reçu : ${last.slice(0, 120)}`, model: 'demo' };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
