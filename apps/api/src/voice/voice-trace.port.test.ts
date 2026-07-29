import { describe, expect, it } from 'vitest';
import { voiceTraceErrorFacts } from './voice-trace.port';

describe('voiceTraceErrorFacts', () => {
  it('conserve les faits structurés d’une ressource expirée sans objet Error brut', () => {
    expect(voiceTraceErrorFacts({
      kind: 'gone',
      entity: 'agent_mission',
      reason: 'expired',
    })).toEqual({
      kind: 'gone',
      entity: 'agent_mission',
      reason: 'expired',
    });
  });
});
