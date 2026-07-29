import { describe, expect, it, vi } from 'vitest';
import type { LlmPort, LlmToolCall } from '@bob/ai';
import type {
  AgentMissionViewV1,
  DecideQuoteAgentMissionOutput,
} from '@bob/core';
import {
  RealtimeQuoteMissionOrchestrator,
  type RealtimeQuoteMissionGateway,
} from './realtime-quote-mission-orchestrator';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const PROOF = Object.freeze({
  subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
  principalBindingHash: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
});
const SESSION_ID = '20000000-0000-4000-8000-000000000001';
const TURN_ID = '10000000-0000-4000-8000-000000000001';

function llm(call: LlmToolCall): LlmPort {
  return {
    id: 'test',
    complete: vi.fn(async () => ({
      text: null,
      toolCalls: [call],
      model: 'gpt-test',
    })),
    generate: vi.fn(async () => ({ text: '', model: 'gpt-test' })),
    health: vi.fn(async () => ({ healthy: true })),
  };
}

function toolCall(
  action:
    | 'start_quote_creation'
    | 'set_customer_reference'
    | 'select_presented_customer'
    | 'unrelated',
  customerReference: string | null,
  choiceOrdinal: number | null,
  extra: Readonly<Record<string, unknown>> = {},
): LlmToolCall {
  return {
    name: 'mettre_a_jour_mission_devis',
    arguments: {
      action,
      customer_reference: customerReference,
      choice_ordinal: choiceOrdinal,
      ...extra,
    },
  };
}

function mission(
  overrides: Partial<AgentMissionViewV1> = {},
): AgentMissionViewV1 {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase: 'awaiting_quote_screen',
    revision: 1,
    payloadVersion: 1,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: {
        sessionId: 'draft-session-1',
        slotRevision: 1,
        contentRevision: 0,
      },
      decision: null,
      stagedCustomerResolution: {
        kind: 'exact',
        customerId: 'customer-camping',
      },
    },
    currentBinding: null,
    idleExpiresAt: '2026-07-30T00:00:00.000Z',
    hardExpiresAt: '2026-08-05T00:00:00.000Z',
    terminalAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function harness(input: {
  readonly call: LlmToolCall;
  readonly current?: AgentMissionViewV1 | null;
  readonly currentAfterDecision?: AgentMissionViewV1 | null;
  readonly started?: AgentMissionViewV1;
  readonly decided?: AgentMissionViewV1;
  readonly decisionOutcome?: 'selected' | 'invalidated' | 'presented' | 'not_found' | 'replayed';
  readonly replayEffect?: DecideQuoteAgentMissionOutput['effect'];
  readonly decisionFailure?: 'conflict' | 'throws';
}) {
  let currentReadCount = 0;
  const getCurrent = vi.fn<RealtimeQuoteMissionGateway['getCurrent']>(async () => {
    const selected = currentReadCount > 0 && 'currentAfterDecision' in input
      ? input.currentAfterDecision ?? null
      : input.current ?? null;
    currentReadCount += 1;
    return {
      ok: true,
      value: { mission: selected },
    };
  });
  const startFromVoiceTurn = vi.fn<RealtimeQuoteMissionGateway['startFromVoiceTurn']>(
    async () => ({
      ok: true,
      value: {
        outcome: 'created',
        startOutcome: 'no_slot',
        mission: input.started ?? mission(),
      },
    }),
  );
  const decideFromVoiceTurn = vi.fn<
    RealtimeQuoteMissionGateway['decideFromVoiceTurn']
  >(async () => {
    if (input.decisionFailure === 'throws') {
      throw new Error('response lost');
    }
    if (input.decisionFailure === 'conflict') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_decision',
          reason: 'revision_mismatch',
        },
      };
    }
    const outcome = input.decisionOutcome ?? 'selected';
    const missionView = input.decided ?? mission({
      phase: 'awaiting_lines',
      revision: 4,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    let value: DecideQuoteAgentMissionOutput;
    if (outcome === 'presented') {
      value = { outcome, effect: { kind: outcome, candidateCount: 2 }, mission: missionView };
    } else if (outcome === 'not_found') {
      value = { outcome, effect: { kind: outcome, result: 'none' }, mission: missionView };
    } else if (outcome === 'invalidated') {
      value = {
        outcome,
        effect: { kind: outcome, reason: 'candidate_unavailable' },
        mission: missionView,
      };
    } else if (outcome === 'replayed') {
      value = {
        outcome,
        effect: input.replayEffect ?? { kind: 'selected' },
        mission: missionView,
      };
    } else {
      value = { outcome, effect: { kind: outcome }, mission: missionView };
    }
    return {
      ok: true,
      value,
    };
  });
  const gateway: RealtimeQuoteMissionGateway = {
    getCurrent,
    startFromVoiceTurn,
    decideFromVoiceTurn,
  };
  const model = llm(input.call);
  const orchestrator = new RealtimeQuoteMissionOrchestrator(model, gateway);
  return {
    orchestrator,
    model,
    getCurrent,
    startFromVoiceTurn,
    decideFromVoiceTurn,
  };
}

function input(signal = new AbortController().signal) {
  return {
    authority: {
      owner: OWNER,
      proof: PROOF,
      realtimeSessionId: SESSION_ID,
    },
    turnId: TURN_ID,
    transcript: 'Fais un devis pour Camping les Pins',
    history: [],
    contextRevision: 4,
    contextDigest: 'f'.repeat(64),
    signal,
  };
}

describe('RealtimeQuoteMissionOrchestrator', () => {
  it('persiste la mission et la référence client avant de rendre la navigation', async () => {
    const h = harness({
      call: toolCall('start_quote_creation', 'Camping les Pins', null),
    });

    const outcome = await h.orchestrator.run(input());

    expect(outcome).toEqual({
      status: 'ready',
      canonicalSpeech:
        'J’ai trouvé le client dans tes données. J’ouvre le devis et je poursuis dès que l’écran est prêt.',
      navigate: '/devis/new',
    });
    expect(h.startFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF },
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      customerReference: 'Camping les Pins',
    });
    expect(h.getCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      h.startFromVoiceTurn.mock.invocationCallOrder[0]!,
    );
  });

  it('délègue uniquement un unrelated explicitement compris', async () => {
    const h = harness({
      call: toolCall('unrelated', null, null),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'not_applicable',
    });
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('échoue fermé sur des arguments LLM non exacts sans appeler le domaine', async () => {
    const h = harness({
      call: toolCall('start_quote_creation', 'Camping les Pins', null, {
        customerId: 'hallucinated-id',
      }),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech:
        'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.',
    });
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('résout une nouvelle référence client par le même use case durable sans renavigation', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping les Pins', null),
      current: mission({ phase: 'awaiting_customer' }),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Client confirmé. L’écran est à jour. Tu peux toucher Continuer à la main pour ajouter les prestations.',
      speechPurpose: 'action_result',
    });
    expect(h.decideFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF },
      missionId: '30000000-0000-4000-8000-000000000001',
      turnId: TURN_ID,
      realtimeSessionId: SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 1,
      expectedDraftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      decision: {
        action: 'resolve_customer_reference',
        customerReference: 'Camping les Pins',
      },
    });
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('convertit un ordinal en choiceId persistant sans transmettre de customerId', async () => {
    const current = mission({
      phase: 'awaiting_customer_choice',
      revision: 3,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 1,
          contentRevision: 0,
        },
        decision: {
          kind: 'customer',
          decisionId: '40000000-0000-4000-8000-000000000001',
          choiceSetRevision: 3,
          candidates: [
            {
              choiceId: '50000000-0000-4000-8000-000000000001',
              customerId: 'customer-first',
            },
            {
              choiceId: '50000000-0000-4000-8000-000000000002',
              customerId: 'customer-second',
            },
          ],
          choiceSetHash: 'e'.repeat(64),
        },
        stagedCustomerResolution: null,
      },
    });
    const h = harness({
      call: toolCall('select_presented_customer', null, 2),
      current,
    });

    await expect(h.orchestrator.run(input())).resolves.toMatchObject({
      status: 'handled',
      speechPurpose: 'action_result',
    });
    expect(h.decideFromVoiceTurn).toHaveBeenCalledWith(expect.objectContaining({
      missionId: current.id,
      expectedMissionRevision: 3,
      decision: {
        action: 'choose_presented_option',
        decisionId: '40000000-0000-4000-8000-000000000001',
        choiceSetRevision: 3,
        choiceId: '50000000-0000-4000-8000-000000000002',
      },
    }));
    expect(h.decideFromVoiceTurn.mock.calls[0]?.[0].decision).not.toHaveProperty(
      'customerId',
    );
  });

  it('rend un choix structuré quand la résolution réelle reste ambiguë', async () => {
    const choices = mission({
      phase: 'awaiting_customer_choice',
      revision: 2,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 1,
          contentRevision: 0,
        },
        decision: {
          kind: 'customer',
          decisionId: '40000000-0000-4000-8000-000000000001',
          choiceSetRevision: 2,
          candidates: [
            {
              choiceId: '50000000-0000-4000-8000-000000000001',
              customerId: 'customer-first',
            },
            {
              choiceId: '50000000-0000-4000-8000-000000000002',
              customerId: 'customer-second',
            },
          ],
          choiceSetHash: 'e'.repeat(64),
        },
        stagedCustomerResolution: null,
      },
    });
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping', null),
      current: mission({ phase: 'awaiting_customer' }),
      decided: choices,
      decisionOutcome: 'presented',
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'J’ai trouvé 2 clients possibles, affichés dans le même ordre. Dis-moi le premier, le deuxième, ou précise le nom.',
      speechPurpose: 'structured_choice',
    });
  });

  it('relit l’autorité quand le tap gagne la course et annonce l’état convergé', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping les Pins', null),
      current: mission({ phase: 'awaiting_customer' }),
      currentAfterDecision: mission({
        phase: 'awaiting_lines',
        revision: 4,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      decisionFailure: 'conflict',
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Le client est déjà confirmé. J’ai actualisé le devis avec l’état enregistré.',
      speechPurpose: 'action_result',
    });
    expect(h.getCurrent).toHaveBeenCalledTimes(2);
  });

  it('relit l’autorité après une réponse réseau perdue au lieu d’inventer un échec', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping les Pins', null),
      current: mission({ phase: 'awaiting_customer' }),
      currentAfterDecision: mission({
        phase: 'awaiting_lines',
        revision: 4,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      decisionFailure: 'throws',
    });

    await expect(h.orchestrator.run(input())).resolves.toMatchObject({
      status: 'handled',
      canonicalSpeech:
        'Le client est déjà confirmé. J’ai actualisé le devis avec l’état enregistré.',
    });
    expect(h.getCurrent).toHaveBeenCalledTimes(2);
  });

  it('ne présente pas comme actuels les choix d’un replay devenu historique', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping', null),
      current: mission({ phase: 'awaiting_customer' }),
      decided: mission({
        phase: 'awaiting_lines',
        revision: 5,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      decisionOutcome: 'replayed',
      replayEffect: { kind: 'presented', candidateCount: 2 },
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Le client est déjà confirmé. J’ai actualisé le devis avec l’état enregistré.',
      speechPurpose: 'action_result',
    });
  });

  it('ne redélègue jamais au cerveau générique pendant une phase mission non actionnable', async () => {
    const h = harness({
      call: toolCall('unrelated', null, null),
      current: mission({ phase: 'awaiting_quote_screen' }),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech:
        'La mission est déjà en cours. J’attends que l’étape affichée soit confirmée avant de poursuivre.',
    });
    expect(h.model.complete).not.toHaveBeenCalled();
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('propage l’interruption sans publier de réponse ni mutation', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({
      call: toolCall('start_quote_creation', null, null),
    });

    await expect(h.orchestrator.run(input(controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.getCurrent).not.toHaveBeenCalled();
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });
});
