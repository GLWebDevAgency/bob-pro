import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_DRAFT_SESSION_ID_MAX_LENGTH,
  isCanonicalAgentMissionDraftSessionId,
} from './agent-mission-identifiers';

describe('isCanonicalAgentMissionDraftSessionId — parité de borne', () => {
  it.each([
    [160, true],
    [161, true],
    [200, true],
    [201, false],
  ] as const)('classe une session de %s caractères à %s', (length, expected) => {
    expect(isCanonicalAgentMissionDraftSessionId('a'.repeat(length))).toBe(expected);
  });

  it('expose exactement la borne du contrat', () => {
    expect(AGENT_MISSION_DRAFT_SESSION_ID_MAX_LENGTH).toBe(200);
  });

  it.each(['', ' session', 'session ', 'session\n'])(
    'refuse une forme non canonique %j',
    (value) => {
      expect(isCanonicalAgentMissionDraftSessionId(value)).toBe(false);
    },
  );
});
