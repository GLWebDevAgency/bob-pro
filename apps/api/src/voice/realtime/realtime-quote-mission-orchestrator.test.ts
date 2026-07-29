import { describe, expect, it, vi } from 'vitest';
import type { LlmPort, LlmToolCall } from '@bob/ai';
import type { AgentMissionViewV1 } from '@bob/core';
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
  readonly started?: AgentMissionViewV1;
}) {
  const getCurrent = vi.fn<RealtimeQuoteMissionGateway['getCurrent']>(async () => ({
    ok: true,
    value: { mission: input.current ?? null },
  }));
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
  const gateway: RealtimeQuoteMissionGateway = {
    getCurrent,
    startFromVoiceTurn,
  };
  const model = llm(input.call);
  const orchestrator = new RealtimeQuoteMissionOrchestrator(model, gateway);
  return { orchestrator, model, getCurrent, startFromVoiceTurn };
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

  it('ne contourne pas une transition client reconnue mais pas encore livrée', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping les Pins', null),
      current: mission({ phase: 'awaiting_customer' }),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech:
        'La mission est bien ouverte, mais je ne peux pas encore appliquer ce choix vocal de façon sûre. Continue sur l’écran.',
    });
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
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
