import type { AgentConversationTurn } from './agent-session';

export interface AssistantLiveTurnImportPlan {
  /** Nouveaux ids à acquitter, y compris le tour Bob rendu par une carte structurée. */
  readonly consumedIds: readonly string[];
  /** Tours textuels à ajouter au fil ; jamais un id déjà importé. */
  readonly visibleTurns: readonly AgentConversationTurn[];
}

/**
 * Import monotone du journal Live vers le fil Assistant.
 * Le dernier texte Bob identique à une carte run/proposition est acquitté sans seconde bulle.
 */
export function planAssistantLiveTurnImport(input: {
  readonly conversation: readonly AgentConversationTurn[];
  readonly importedIds: ReadonlySet<string>;
  readonly structuredBobText?: string;
}): AssistantLiveTurnImportPlan {
  const structuredBobIndex = input.structuredBobText === undefined
    ? -1
    : input.conversation.findLastIndex(
        (turn) => turn.role === 'bob' && turn.text === input.structuredBobText,
      );
  const unseen = input.conversation
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => !input.importedIds.has(turn.id));
  return Object.freeze({
    consumedIds: Object.freeze(unseen.map(({ turn }) => turn.id)),
    visibleTurns: Object.freeze(
      unseen
        .filter(({ index }) => index !== structuredBobIndex)
        .map(({ turn }) => turn),
    ),
  });
}
