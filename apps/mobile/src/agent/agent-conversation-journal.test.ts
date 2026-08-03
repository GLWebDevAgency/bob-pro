import { describe, expect, it } from 'vitest';
import {
  AGENT_CONVERSATION_JOURNAL_MAX_TURNS,
  appendAgentConversationJournal,
} from './agent-conversation-journal';

describe('journal UI Bob Live', () => {
  it('conserve les sessions successives tant que la borne n est pas atteinte', () => {
    const sessionA = Object.freeze([{ id: '1:1' }, { id: '1:2' }]);
    const sessionB = Object.freeze([{ id: '2:1' }]);

    expect(appendAgentConversationJournal(sessionA, sessionB)).toEqual([
      { id: '1:1' },
      { id: '1:2' },
      { id: '2:1' },
    ]);
  });

  it('borne la mémoire en gardant les tours terminaux les plus récents', () => {
    const current = Array.from(
      { length: AGENT_CONVERSATION_JOURNAL_MAX_TURNS },
      (_, index) => ({ id: `1:${index + 1}` }),
    );

    const next = appendAgentConversationJournal(current, [{ id: '2:1' }, { id: '2:2' }]);

    expect(next).toHaveLength(AGENT_CONVERSATION_JOURNAL_MAX_TURNS);
    expect(next[0]).toEqual({ id: '1:3' });
    expect(next.at(-1)).toEqual({ id: '2:2' });
    expect(Object.isFrozen(next)).toBe(true);
  });
});
