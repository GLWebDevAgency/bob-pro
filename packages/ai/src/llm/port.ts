export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmResult {
  text: string;
  model: string;
}

/** Spécification d'un outil exposé au LLM (tool-calling) — schéma JSON des arguments. */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface LlmToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmCompletion {
  /** Texte de l'assistant (si le modèle répond en clair plutôt que d'appeler un outil). */
  text: string | null;
  /** Appels d'outils demandés par le modèle (vide si réponse texte). */
  toolCalls: LlmToolCall[];
  model: string;
  finishReason?: string;
}

export interface LlmCompleteOptions {
  system?: string;
  tools?: LlmToolSpec[];
  toolChoice?: 'auto' | 'required' | 'none';
  temperature?: number;
  maxTokens?: number;
  /** Annule physiquement l'appel fournisseur quand un tour vocal est interrompu/supplanté. */
  signal?: AbortSignal;
}

export interface LlmGenerateOptions {
  /** Même contrat que `complete` : aucun appel de naturalisation orphelin après barge-in. */
  signal?: AbortSignal;
}

/**
 * Abstraction d'un fournisseur LLM (provider-agnostique : Claude, GLM, DeepSeek, OpenAI…).
 * Les adapters réels vivent côté backend (apps/api), où les clés sont sécurisées.
 * `complete` porte le tool-calling (cœur du cerveau agentique) ; `generate` reste pour le texte simple.
 */
export interface LlmPort {
  readonly id: string;
  complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<LlmCompletion>;
  generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult>;
  health(): Promise<{ healthy: boolean }>;
}
