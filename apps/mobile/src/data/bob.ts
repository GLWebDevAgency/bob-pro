import type {
  AgentRun,
  AskOptions,
  PendingAction,
} from '@bob/ai';
import type { AppError, Result } from '@bob/core';
import type { BobClient } from '@bob/api-client';

/**
 * Surface consommée par l'assistant et par l'overlay global.
 *
 * Le binaire Bob est exclusivement distant : le cerveau, les outils, le journal et les
 * relectures tenant-scoped vivent sur l'API. Il n'existe donc aucun second agent local capable
 * de répondre depuis des fixtures ou d'appliquer des valeurs par défaut différentes du serveur.
 */
export interface BobAssistant {
  ask(message: string, opts?: AskOptions): Promise<Result<AgentRun, AppError>>;
  confirm(pending: PendingAction): Promise<Result<AgentRun, AppError>>;
}

/**
 * Adaptateur serveur unique. Les callbacks de phase restent honnêtes : sans flux de progression
 * intermédiaire du endpoint HTTP, seul « comprends » est publié avant la réponse finale.
 */
export function makeBobAgent(client: BobClient): BobAssistant {
  return {
    async ask(message, opts = {}) {
      opts.signal?.throwIfAborted();
      opts.onPhase?.('comprends');
      const result = await client.askBob({
        message,
        ...(opts.autonomy !== undefined ? { autonomy: opts.autonomy } : {}),
        ...(opts.history !== undefined ? { history: opts.history } : {}),
        ...(opts.tone !== undefined ? { tone: opts.tone } : {}),
        ...(opts.context !== undefined ? { context: opts.context } : {}),
      });
      opts.signal?.throwIfAborted();
      return result;
    },
    async confirm(pending) {
      return client.confirmBob(pending);
    },
  };
}
