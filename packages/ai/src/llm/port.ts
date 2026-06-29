export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmResult {
  text: string;
  model: string;
}

export interface LlmStreamEvent {
  type: 'token' | 'done';
  text?: string;
}

/**
 * Abstraction d'un fournisseur LLM. Les adapters réels (Claude, GLM) vivent côté backend
 * (apps/api), où les clés sont sécurisées. Le package @bob/ai ne fournit que l'adapter démo.
 */
export interface LlmPort {
  readonly id: string;
  generate(messages: LlmMessage[]): Promise<LlmResult>;
  health(): Promise<{ healthy: boolean }>;
}
