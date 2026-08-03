/**
 * Journal UI en mémoire du propriétaire Bob Live.
 *
 * Il traverse les navigations et les sessions successives tant que le provider authentifié reste
 * monté. La borne protège le mobile d'une croissance sans limite ; elle est volontairement très
 * supérieure à l'historique court envoyé au modèle, qui reste une responsabilité distincte.
 */
export const AGENT_CONVERSATION_JOURNAL_MAX_TURNS = 256;

export function appendAgentConversationJournal<T>(
  current: readonly T[],
  appended: readonly T[],
): readonly T[] {
  if (appended.length === 0) return current;
  return Object.freeze(
    [...current, ...appended].slice(-AGENT_CONVERSATION_JOURNAL_MAX_TURNS),
  );
}
