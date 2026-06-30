import { type LlmPort, type LlmMessage, type LlmResult, type LlmCompletion } from './port';

/** Adapter déterministe, sans clé : dev/CI, fallback de panne, démo. */
export class DemoLlmAdapter implements LlmPort {
  readonly id = 'demo';

  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    const last = messages[messages.length - 1]?.content ?? '';
    // Le démo ne fait pas de tool-calling : il renvoie du texte. La classification offline passe par la regex.
    return { text: `(démo) Bien reçu : ${last.slice(0, 120)}`, toolCalls: [], model: 'demo' };
  }

  async generate(messages: LlmMessage[]): Promise<LlmResult> {
    const last = messages[messages.length - 1]?.content ?? '';
    return { text: `(démo) Bien reçu : ${last.slice(0, 120)}`, model: 'demo' };
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
