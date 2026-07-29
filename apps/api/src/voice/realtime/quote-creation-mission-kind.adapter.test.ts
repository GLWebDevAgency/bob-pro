import { describe, expect, it, vi } from 'vitest';
import type {
  RealtimeQuoteMissionOrchestrationInput,
  RealtimeQuoteMissionOrchestrationOutcome,
  RealtimeQuoteMissionOrchestratorPort,
} from './realtime-quote-mission-orchestrator';
import {
  QuoteCreationMissionKindAdapter,
  REALTIME_MISSION_UNAVAILABLE_SPEECH,
} from './quote-creation-mission-kind.adapter';

function input(): RealtimeQuoteMissionOrchestrationInput {
  return {
    authority: {
      owner: { companyId: 'company-1', ownerUserId: 'owner-1' },
      proof: {
        subjectHashCandidates: ['a'.repeat(64)],
        principalBindingHash: 'b'.repeat(64),
        capabilityHash: 'c'.repeat(64),
      },
      realtimeSessionId: '20000000-0000-4000-8000-000000000001',
    },
    turnId: '10000000-0000-4000-8000-000000000001',
    transcript: 'fais un devis pour Camping Les Pins',
    history: [],
    contextRevision: 3,
    contextDigest: 'd'.repeat(64),
    signal: new AbortController().signal,
  };
}

describe('QuoteCreationMissionKindAdapter', () => {
  it('délègue la même entrée et restitue exactement le même outcome', async () => {
    const outcome: RealtimeQuoteMissionOrchestrationOutcome = {
      status: 'ready',
      canonicalSpeech: 'Je prépare le devis.',
      navigate: '/devis/new',
    };
    const run = vi.fn<RealtimeQuoteMissionOrchestratorPort['run']>(
      async () => outcome,
    );
    const adapter = new QuoteCreationMissionKindAdapter({ run });
    const turn = input();

    await expect(adapter.run(turn)).resolves.toBe(outcome);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(turn);
  });

  it('échoue fermé avec le refus M1-C exact lorsque le délégué est absent', async () => {
    const adapter = new QuoteCreationMissionKindAdapter(null);

    await expect(adapter.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
    });
  });
});
