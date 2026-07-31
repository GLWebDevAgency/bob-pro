import { describe, expect, it, vi } from 'vitest';
import type {
  RealtimeQuoteMissionOrchestrationInput,
  RealtimeQuoteMissionOrchestrationOutcome,
  RealtimeQuoteMissionOrchestratorPort,
  RealtimeQuoteMissionPreparedTurn,
} from './realtime-quote-mission-orchestrator';
import type { QuoteCreationSemanticFrameV1 } from '@bob/ai';
import {
  QuoteCreationMissionKindAdapter,
  REALTIME_MISSION_UNAVAILABLE_SPEECH,
} from './quote-creation-mission-kind.adapter';

function input(): RealtimeQuoteMissionOrchestrationInput {
  return {
    authority: {
      owner: { companyId: 'company-1', ownerUserId: 'owner-1' },
      proof: {
        protocolVersion: 1,
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
  it('délègue préparation et exécution planifiée sans recréer de cerveau', async () => {
    const outcome: RealtimeQuoteMissionOrchestrationOutcome = {
      status: 'ready',
      canonicalSpeech: 'Je prépare le devis.',
      navigate: '/devis/new',
    };
    const prepared = {
      protocolVersion: 1,
      snapshot: { mission: null },
      semanticContext: {
        missionAlias: null,
        missionRevision: 0,
        confirmedLineCount: 0,
        pendingLineCount: 0,
        pendingDecisionKind: null,
        protocolVersion: 1,
        phase: 'inactive',
        presentedChoices: [],
      },
      availableCapabilities: ['quote.customer.resolve'],
    } as const satisfies RealtimeQuoteMissionPreparedTurn;
    const frame = {
      schema: 'bob.semantic.quote-creation',
      version: 1,
      operation: {
        kind: 'start_quote_creation',
        customerReference: 'Camping Les Pins',
      },
      model: 'gpt-test',
    } as const satisfies QuoteCreationSemanticFrameV1;
    const prepare = vi.fn<RealtimeQuoteMissionOrchestratorPort['prepare']>(
      async () => ({ status: 'prepared', prepared }),
    );
    const runPlanned = vi.fn<RealtimeQuoteMissionOrchestratorPort['runPlanned']>(
      async () => outcome,
    );
    const adapter = new QuoteCreationMissionKindAdapter({ prepare, runPlanned });
    const turn = input();

    await expect(adapter.prepare(turn)).resolves.toEqual({
      status: 'prepared',
      prepared,
    });
    await expect(adapter.runPlanned({
      request: turn,
      prepared,
      frame,
    })).resolves.toBe(outcome);
    expect(prepare).toHaveBeenCalledWith(turn);
    expect(runPlanned).toHaveBeenCalledWith({
      request: turn,
      prepared,
      frame,
    });
  });

  it('échoue fermé avec le refus M1-C exact lorsque le délégué est absent', async () => {
    const adapter = new QuoteCreationMissionKindAdapter(null);

    await expect(adapter.prepare(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
    });
    await expect(adapter.runPlanned({
      request: input(),
      prepared: {} as RealtimeQuoteMissionPreparedTurn,
      frame: {} as QuoteCreationSemanticFrameV1,
    })).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
    });
  });
});
