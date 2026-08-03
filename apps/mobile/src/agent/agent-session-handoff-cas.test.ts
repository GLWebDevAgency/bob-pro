import { describe, expect, it } from 'vitest';
import {
  consumeAgentSessionHandoff,
  requestAgentSessionHandoff,
} from './agent-session-handoff-cas';

const handoff = (id: string, expiresAt = 2_000) => Object.freeze({
  id,
  expiresAt,
  requestedAt: null,
  payload: `payload-${id}`,
});

describe('AgentSession — handoff compare-and-set', () => {
  it('une fin asynchrone A ne peut pas effacer le handoff B courant', () => {
    const current = handoff('B');
    expect(consumeAgentSessionHandoff(current, 'A')).toEqual({
      value: current,
      changed: false,
    });
    expect(consumeAgentSessionHandoff(current, 'B')).toEqual({
      value: null,
      changed: true,
    });
  });

  it('ne demande que le handoff exact avant son expiration', () => {
    const current = handoff('A');
    expect(requestAgentSessionHandoff(current, 'B', 1_000)).toEqual({
      value: current,
      changed: false,
    });
    expect(requestAgentSessionHandoff(current, 'A', 2_000)).toEqual({
      value: current,
      changed: false,
    });
    expect(requestAgentSessionHandoff(current, 'A', 1_000)).toEqual({
      value: { ...current, requestedAt: 1_000 },
      changed: true,
    });
  });
});
