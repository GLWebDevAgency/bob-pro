import { describe, expect, it, vi } from 'vitest';
import type {
  AcknowledgeQuoteScreenOutput,
  AgentMissionViewV1,
  DecideQuoteAgentMissionOutput,
} from '@bob/core';
import type {
  QuoteDraftAuthoritativeReference,
} from '../quote-draft/quote-draft-remote-store';
import type {
  AgentMissionConfirmedContext,
  AgentMissionRuntimeActions,
} from './agent-mission-runtime';
import {
  authoritativeCustomerChoices,
  deriveQuoteCustomerSelectionRows,
  QuoteCustomerDecisionCoordinator,
  QuoteManualHandoffCoordinator,
  quoteScreenInstanceId,
  QuoteScreenMissionCoordinator,
  type QuoteScreenMissionObservation,
  type QuoteScreenMissionPorts,
} from './quote-screen-mission-coordinator';
import type {
  AgentMissionRecoverySnapshot,
  PresentQuoteAgentMissionResumeView,
} from './agent-mission-recovery-state';

const REALTIME_ID = '10000000-0000-4000-8000-000000000001';
const MISSION_ID = '20000000-0000-4000-8000-000000000001';
const DRAFT_ZERO: QuoteDraftAuthoritativeReference = {
  sessionId: 'draft-zero',
  slotRevision: 1,
  contentRevision: 0,
};
const DRAFT_SELECTED: QuoteDraftAuthoritativeReference = {
  sessionId: 'draft-zero',
  slotRevision: 2,
  contentRevision: 1,
};

function context(
  revision: number,
  digestCharacter: string,
  instanceId: string,
): AgentMissionConfirmedContext {
  return {
    realtimeSessionId: REALTIME_ID,
    revision,
    digest: digestCharacter.repeat(64),
    screen: { name: '/devis/new', instanceId },
  };
}

function mission(input: {
  revision: number;
  draft: QuoteDraftAuthoritativeReference;
  context?: AgentMissionConfirmedContext;
}): AgentMissionViewV1 {
  return {
    id: MISSION_ID,
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase: input.draft.contentRevision === 0 ? 'awaiting_customer' : 'awaiting_lines',
    revision: input.revision,
    payloadVersion: 1,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: input.draft,
      decision: null,
      stagedCustomerResolution: null,
    },
    currentBinding: input.context === undefined
      ? null
      : {
          realtimeSessionId: REALTIME_ID,
          contextRevision: input.context.revision,
          contextDigest: input.context.digest,
          screenName: '/devis/new',
          screenInstanceId: input.context.screen.instanceId,
          acknowledgedAt: '2026-07-29T00:00:00.000Z',
        },
    idleExpiresAt: '2026-07-29T00:10:00.000Z',
    hardExpiresAt: '2026-07-29T01:00:00.000Z',
    terminalAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  } as AgentMissionViewV1;
}

function acknowledgement(
  updated: AgentMissionViewV1,
): AcknowledgeQuoteScreenOutput {
  return {
    outcome: 'acknowledged',
    receipt: {
      ackCommandId: '30000000-0000-4000-8000-000000000001',
      missionId: MISSION_ID,
      missionRevisionAfter: updated.revision,
      realtimeSessionId: REALTIME_ID,
      contextRevision: updated.currentBinding?.contextRevision ?? 1,
      contextDigest: updated.currentBinding?.contextDigest ?? 'a'.repeat(64),
      occurredAt: '2026-07-29T00:00:00.000Z',
    },
    mission: updated,
  };
}

function selectedDecision(
  updated: AgentMissionViewV1,
  outcome: 'selected' | 'replayed' = 'selected',
): DecideQuoteAgentMissionOutput {
  return outcome === 'replayed'
    ? { outcome, effect: { kind: 'selected' }, mission: updated }
    : { outcome, effect: { kind: 'selected' }, mission: updated };
}

function awaitingCustomerChoice(): AgentMissionViewV1 {
  const current = mission({ revision: 3, draft: DRAFT_ZERO });
  return {
    ...current,
    phase: 'awaiting_customer_choice',
    payload: {
      ...current.payload,
      decision: {
        kind: 'customer',
        decisionId: '40000000-0000-4000-8000-000000000001',
        choiceSetRevision: 3,
        candidates: [
          {
            choiceId: '50000000-0000-4000-8000-000000000001',
            customerId: 'customer-a',
          },
          {
            choiceId: '50000000-0000-4000-8000-000000000002',
            customerId: 'customer-b',
          },
        ],
        choiceSetHash: 'f'.repeat(64),
      },
    },
  };
}

function observation(input: {
  confirmed?: AgentMissionConfirmedContext | null;
  instanceId: string;
  draft: QuoteDraftAuthoritativeReference | null;
  realtimeSessionId?: string | null;
  recovery?: AgentMissionRecoverySnapshot;
}): QuoteScreenMissionObservation {
  return {
    runtimeGeneration: 1,
    realtimeSessionId: input.realtimeSessionId === undefined
      ? REALTIME_ID
      : input.realtimeSessionId,
    confirmedContext: input.confirmed === undefined ? null : input.confirmed,
    screenInstanceId: input.instanceId,
    authoritativeDraft: input.draft,
    recovery: input.recovery ?? { phase: 'absent' },
  };
}

const refreshAbsentRecovery = async (): Promise<AgentMissionRecoverySnapshot> => ({
  phase: 'absent',
});

function recovered(
  current: AgentMissionViewV1,
  customerChoices: PresentQuoteAgentMissionResumeView['customerChoices'] = [],
): PresentQuoteAgentMissionResumeView {
  const draft = current.payload.draft;
  if (draft === null) throw new Error('Invalid recovery fixture');
  return {
    mission: {
      id: current.id,
      status: current.status as 'active' | 'expired',
      phase: current.phase,
      revision: current.revision,
      actionable: current.actionable,
      draft,
      idleExpiresAt: current.idleExpiresAt,
      hardExpiresAt: current.hardExpiresAt,
    },
    draft: {
      ...draft,
      step: draft.contentRevision === 0 ? 'client' : 'lignes',
    },
    customerChoices,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('deriveQuoteCustomerSelectionRows — vérité des choix rendus', () => {
  const customers = [
    { id: 'customer-a', name: 'Alpha' },
    { id: 'customer-b', name: 'Bravo' },
    { id: 'customer-c', name: 'Charlie' },
  ] as const;

  it('préserve les ordinaux persistés, masque le libellé supprimé puis rend le reste réel', () => {
    const current = awaitingCustomerChoice();
    const decision = current.payload.decision;
    if (decision?.kind !== 'customer') throw new Error('Invalid test fixture');

    const rows = deriveQuoteCustomerSelectionRows(
      customers,
      {
        ...decision,
        candidates: [
          decision.candidates[1]!,
          {
            choiceId: '50000000-0000-4000-8000-000000000003',
            customerId: 'customer-deleted',
          },
        ],
      },
      [
        {
          status: 'available',
          choiceId: '50000000-0000-4000-8000-000000000002',
          label: 'Bravo renommé',
        },
        {
          status: 'unavailable',
          choiceId: '50000000-0000-4000-8000-000000000003',
        },
      ],
    );

    expect(rows).toEqual([
      {
        kind: 'available',
        customer: { ...customers[1], name: 'Bravo renommé' },
        missionOrdinal: 1,
      },
      {
        kind: 'unavailable',
        customerId: 'customer-deleted',
        missionOrdinal: 2,
      },
      {
        kind: 'available',
        customer: customers[0],
        missionOrdinal: null,
      },
      {
        kind: 'available',
        customer: customers[2],
        missionOrdinal: null,
      },
    ]);
    expect(rows[1]).not.toHaveProperty('customer');
  });

  it('rend uniquement la liste réelle et sans ordinal hors désambiguïsation', () => {
    expect(deriveQuoteCustomerSelectionRows(customers, null, null)).toEqual(
      customers.map((customer) => ({
        kind: 'available',
        customer,
        missionOrdinal: null,
      })),
    );
  });

  it('ne rend jamais un libellé du cache sans projection autoritaire correspondante', () => {
    const current = awaitingCustomerChoice();
    const decision = current.payload.decision;
    if (decision?.kind !== 'customer') throw new Error('Invalid test fixture');
    expect(deriveQuoteCustomerSelectionRows(customers, decision, null).slice(0, 2))
      .toEqual([
        { kind: 'unavailable', customerId: 'customer-a', missionOrdinal: 1 },
        { kind: 'unavailable', customerId: 'customer-b', missionOrdinal: 2 },
      ]);
  });

  it('rend le choix PostgreSQL sélectionnable même si la liste clients ne le contient pas', () => {
    const current = awaitingCustomerChoice();
    const decision = current.payload.decision;
    if (decision?.kind !== 'customer') throw new Error('Invalid test fixture');

    expect(deriveQuoteCustomerSelectionRows(
      [],
      decision,
      [
        {
          status: 'available',
          choiceId: '50000000-0000-4000-8000-000000000001',
          label: 'Camping Les Pins',
        },
        {
          status: 'unavailable',
          choiceId: '50000000-0000-4000-8000-000000000002',
        },
      ],
    )).toEqual([
      {
        kind: 'authoritative',
        customerId: 'customer-a',
        label: 'Camping Les Pins',
        missionOrdinal: 1,
      },
      {
        kind: 'unavailable',
        customerId: 'customer-b',
        missionOrdinal: 2,
      },
    ]);
  });
});

describe('authoritativeCustomerChoices — fences de projection', () => {
  it('accepte uniquement la même mission, révision, brouillon et ordre opaque', () => {
    const current = awaitingCustomerChoice();
    const choices = [
      {
        status: 'available' as const,
        choiceId: '50000000-0000-4000-8000-000000000001',
        label: 'Alpha réel',
      },
      {
        status: 'unavailable' as const,
        choiceId: '50000000-0000-4000-8000-000000000002',
      },
    ];
    const exact: AgentMissionRecoverySnapshot = {
      phase: 'resumable',
      value: recovered(current, choices),
    };
    expect(authoritativeCustomerChoices(exact, current)).toEqual(choices);
    expect(authoritativeCustomerChoices({
      phase: 'resumable',
      value: {
        ...recovered(current, choices),
        mission: {
          ...recovered(current, choices).mission,
          revision: current.revision + 1,
        },
      },
    }, current)).toBeNull();
    expect(authoritativeCustomerChoices({
      phase: 'resumable',
      value: recovered(current, [...choices].reverse()),
    }, current)).toBeNull();
  });
});

describe('QuoteCustomerDecisionCoordinator — parité tap et choix durable', () => {
  it('convertit un client proposé en choix opaque et ne transmet jamais son customerId', async () => {
    const decideQuoteCreation = vi.fn<
      AgentMissionRuntimeActions['decideQuoteCreation']
    >(async () => ({
      status: 'completed' as const,
      value: selectedDecision(mission({ revision: 4, draft: DRAFT_SELECTED })),
    }));
    const coordinator = new QuoteCustomerDecisionCoordinator(() =>
      '60000000-0000-4000-8000-000000000001');

    await coordinator.select({
      mission: awaitingCustomerChoice(),
      customerId: 'customer-b',
      expectedScreenInstanceId: 'devis-client',
    }, { decideQuoteCreation });

    expect(decideQuoteCreation).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      commandId: '60000000-0000-4000-8000-000000000001',
      expectedMissionRevision: 3,
      expectedDraftSessionId: DRAFT_ZERO.sessionId,
      expectedDraftSlotRevision: DRAFT_ZERO.slotRevision,
      expectedDraftContentRevision: DRAFT_ZERO.contentRevision,
      expectedScreenInstanceId: 'devis-client',
      action: 'choose_presented_option',
      decisionId: '40000000-0000-4000-8000-000000000001',
      choiceSetRevision: 3,
      choiceId: '50000000-0000-4000-8000-000000000002',
    });
    expect(decideQuoteCreation.mock.calls[0]?.[0]).not.toHaveProperty('customerId');
  });

  it('laisse un tap explicite hors suggestions sélectionner un client relu par le serveur', async () => {
    const decideQuoteCreation = vi.fn<
      AgentMissionRuntimeActions['decideQuoteCreation']
    >(async () => ({
      status: 'completed' as const,
      value: selectedDecision(mission({ revision: 4, draft: DRAFT_SELECTED })),
    }));
    const coordinator = new QuoteCustomerDecisionCoordinator(() =>
      '60000000-0000-4000-8000-000000000001');

    await coordinator.select({
      mission: awaitingCustomerChoice(),
      customerId: 'customer-outside-choice-set',
      expectedScreenInstanceId: 'devis-client',
    }, { decideQuoteCreation });

    expect(decideQuoteCreation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'select_screen_customer',
      customerId: 'customer-outside-choice-set',
    }));
  });

  it('partage le double tap et réutilise son commandId après une réponse perdue', async () => {
    const firstAttempt = deferred<Awaited<
      ReturnType<AgentMissionRuntimeActions['decideQuoteCreation']>
    >>();
    let attempt = 0;
    const decideQuoteCreation = vi.fn<
      AgentMissionRuntimeActions['decideQuoteCreation']
    >(() => {
      attempt += 1;
      return attempt === 1
        ? firstAttempt.promise
        : Promise.resolve({
            status: 'completed' as const,
            value: selectedDecision(mission({ revision: 3, draft: DRAFT_SELECTED })),
          });
    });
    let createdCommands = 0;
    const coordinator = new QuoteCustomerDecisionCoordinator(() => {
      createdCommands += 1;
      return '60000000-0000-4000-8000-000000000001';
    });
    const input = {
      mission: mission({ revision: 2, draft: DRAFT_ZERO }),
      customerId: 'customer-a',
      expectedScreenInstanceId: 'devis-client',
    } as const;

    const first = coordinator.select(input, { decideQuoteCreation });
    const doubled = coordinator.select(input, { decideQuoteCreation });
    expect(first).toBe(doubled);
    expect(decideQuoteCreation).toHaveBeenCalledOnce();
    firstAttempt.resolve({ status: 'unavailable' });
    await first;

    await coordinator.select(input, { decideQuoteCreation });
    expect(decideQuoteCreation).toHaveBeenCalledTimes(2);
    expect(decideQuoteCreation.mock.calls.map(([call]) => call.commandId)).toEqual([
      '60000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
    ]);
    expect(createdCommands).toBe(1);
  });

  it('échoue fermé hors phase client sans appeler le réseau', async () => {
    const decideQuoteCreation = vi.fn();
    const coordinator = new QuoteCustomerDecisionCoordinator(() =>
      '60000000-0000-4000-8000-000000000001');

    await expect(coordinator.select({
      mission: mission({ revision: 4, draft: DRAFT_SELECTED }),
      customerId: 'customer-a',
      expectedScreenInstanceId: 'devis-lines',
    }, { decideQuoteCreation })).resolves.toEqual({ status: 'invalid_response' });
    expect(decideQuoteCreation).not.toHaveBeenCalled();
  });
});

describe('QuoteManualHandoffCoordinator — passation durable', () => {
  it('partage un double tap puis réutilise le même commandId après réponse perdue', async () => {
    const firstAttempt = deferred<Awaited<ReturnType<
      AgentMissionRuntimeActions['manualHandoffQuoteCreation']
    >>>();
    const terminalMission = {
      ...mission({ revision: 4, draft: DRAFT_SELECTED }),
      status: 'cancelled',
      actionable: false,
      revision: 5,
      terminalAt: '2026-07-29T00:01:00.000Z',
    } as AgentMissionViewV1;
    let attempt = 0;
    const manualHandoffQuoteCreation = vi.fn<
      AgentMissionRuntimeActions['manualHandoffQuoteCreation']
    >(() => {
      attempt += 1;
      return attempt === 1
        ? firstAttempt.promise
        : Promise.resolve({
            status: 'completed' as const,
            value: {
              outcome: 'replayed' as const,
              mission: terminalMission,
            },
          });
    });
    let commandCount = 0;
    const coordinator = new QuoteManualHandoffCoordinator(() => {
      commandCount += 1;
      return '70000000-0000-4000-8000-000000000001';
    });
    const input = {
      mission: mission({ revision: 4, draft: DRAFT_SELECTED }),
      expectedScreenInstanceId: 'devis-lines',
    } as const;

    const first = coordinator.handoff(input, { manualHandoffQuoteCreation });
    const doubled = coordinator.handoff(input, { manualHandoffQuoteCreation });
    expect(first).toBe(doubled);
    expect(manualHandoffQuoteCreation).toHaveBeenCalledOnce();
    firstAttempt.resolve({ status: 'unavailable' });
    await first;

    await coordinator.handoff(input, { manualHandoffQuoteCreation });
    expect(manualHandoffQuoteCreation).toHaveBeenCalledTimes(2);
    expect(manualHandoffQuoteCreation.mock.calls.map(([call]) => call.commandId)).toEqual([
      '70000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001',
    ]);
    expect(commandCount).toBe(1);
  });

  it('refuse la passation avant awaiting_lines sans appeler le réseau', async () => {
    const manualHandoffQuoteCreation = vi.fn();
    const coordinator = new QuoteManualHandoffCoordinator(() =>
      '70000000-0000-4000-8000-000000000001');

    await expect(coordinator.handoff({
      mission: mission({ revision: 2, draft: DRAFT_ZERO }),
      expectedScreenInstanceId: 'devis-client',
    }, { manualHandoffQuoteCreation })).resolves.toEqual({
      status: 'invalid_response',
    });
    expect(manualHandoffQuoteCreation).not.toHaveBeenCalled();
  });
});

describe('QuoteScreenMissionCoordinator — point fixe contexte + brouillon', () => {
  it('distingue deux longues sessions partageant exactement le même suffixe', () => {
    const suffix = 'same-suffix'.repeat(12);
    const first = quoteScreenInstanceId({
      sessionId: `tenant-a:${suffix}`,
      slotRevision: 8,
      contentRevision: 3,
      step: 'lignes',
    });
    const second = quoteScreenInstanceId({
      sessionId: `tenant-b:${suffix}`,
      slotRevision: 8,
      contentRevision: 3,
      step: 'lignes',
    });

    expect(first).not.toBe(second);
    expect(first).toHaveLength('devis-new:'.length + 64);
    expect(first).toBe(quoteScreenInstanceId({
      sessionId: `tenant-a:${suffix}`,
      slotRevision: 8,
      contentRevision: 3,
      step: 'lignes',
    }));
  });

  it('reste manuel sans session seulement après la preuve froide mission:null', async () => {
    const actions = {
      readCurrentQuoteCreation: vi.fn(),
      acknowledgeQuoteScreen: vi.fn(),
    } as unknown as QuoteScreenMissionPorts['actions'];
    const hydrateDraft = vi.fn();
    const coordinator = new QuoteScreenMissionCoordinator(() =>
      '30000000-0000-4000-8000-000000000001');

    await expect(coordinator.advance(observation({
      realtimeSessionId: null,
      instanceId: 'manual',
      draft: null,
    }), { actions, hydrateDraft, refreshRecovery: refreshAbsentRecovery })).resolves.toEqual({
      phase: 'manual',
      reason: 'no_mission',
    });
    expect(actions.readCurrentQuoteCreation).not.toHaveBeenCalled();
    expect(hydrateDraft).not.toHaveBeenCalled();
  });

  it('bloque le manuel et propose la reprise lorsqu’une mission a survécu au kill', async () => {
    const current = awaitingCustomerChoice();
    const recovery = recovered(current, [
      {
        status: 'available',
        choiceId: '50000000-0000-4000-8000-000000000001',
        label: 'Alpha réel',
      },
      {
        status: 'available',
        choiceId: '50000000-0000-4000-8000-000000000002',
        label: 'Bravo réel',
      },
    ]);
    const actions = {
      readCurrentQuoteCreation: vi.fn(),
      acknowledgeQuoteScreen: vi.fn(),
    } as unknown as QuoteScreenMissionPorts['actions'];
    const coordinator = new QuoteScreenMissionCoordinator(() => 'unused');

    await expect(coordinator.advance(observation({
      realtimeSessionId: null,
      instanceId: 'cold-resume',
      draft: null,
      recovery: { phase: 'resumable', value: recovery },
    }), {
      actions,
      hydrateDraft: vi.fn(),
      refreshRecovery: refreshAbsentRecovery,
    })).resolves.toEqual({ phase: 'resume_required', recovery });
    expect(actions.readCurrentQuoteCreation).not.toHaveBeenCalled();
  });

  it('n’effectue aucune lecture ni ACK avant le contexte rendu exact', async () => {
    const actions = {
      readCurrentQuoteCreation: vi.fn(),
      acknowledgeQuoteScreen: vi.fn(),
    } as unknown as AgentMissionRuntimeActions;
    const coordinator = new QuoteScreenMissionCoordinator(() =>
      '30000000-0000-4000-8000-000000000001');

    await expect(coordinator.advance(observation({
      confirmed: context(1, 'a', 'ancien-écran'),
      instanceId: 'nouvel-écran',
      draft: DRAFT_ZERO,
    }), {
      actions,
      hydrateDraft: vi.fn(),
      refreshRecovery: refreshAbsentRecovery,
    })).resolves.toEqual({
      phase: 'waiting_context',
    });
    expect(actions.readCurrentQuoteCreation).not.toHaveBeenCalled();
    expect(actions.acknowledgeQuoteScreen).not.toHaveBeenCalled();
  });

  it('attend le refetch de reprise déjà en vol sans en démarrer un second', async () => {
    const currentContext = context(2, 'b', 'devis-client');
    const currentMission = {
      ...awaitingCustomerChoice(),
      currentBinding: {
        realtimeSessionId: REALTIME_ID,
        contextRevision: currentContext.revision,
        contextDigest: currentContext.digest,
        screenName: '/devis/new',
        screenInstanceId: currentContext.screen.instanceId,
        acknowledgedAt: '2026-07-29T00:00:00.000Z',
      },
    } as AgentMissionViewV1;
    const refreshRecovery = vi.fn<QuoteScreenMissionPorts['refreshRecovery']>();
    const coordinator = new QuoteScreenMissionCoordinator(() => 'unused');

    await expect(coordinator.advance(observation({
      confirmed: currentContext,
      instanceId: currentContext.screen.instanceId,
      draft: DRAFT_ZERO,
      recovery: { phase: 'loading' },
    }), {
      actions: {
        readCurrentQuoteCreation: vi.fn(async () => ({
          status: 'completed' as const,
          value: { mission: currentMission },
        })),
        acknowledgeQuoteScreen: vi.fn(),
      },
      hydrateDraft: vi.fn(),
      refreshRecovery,
    })).resolves.toEqual({ phase: 'waiting_recovery' });
    expect(refreshRecovery).not.toHaveBeenCalled();
  });

  it('fait deux ACK contextuellement distincts après une sélection exacte', async () => {
    const clientContext = context(2, 'b', 'devis-client');
    const linesContext = context(3, 'c', 'devis-lines');
    let currentMission = mission({ revision: 1, draft: DRAFT_ZERO });
    let currentDraft = DRAFT_ZERO;
    const acknowledgementInputs: unknown[] = [];
    const actions: QuoteScreenMissionPorts['actions'] = {
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: currentMission },
      })),
      acknowledgeQuoteScreen: vi.fn(async (input) => {
        acknowledgementInputs.push(input);
        currentMission = acknowledgementInputs.length === 1
          ? mission({ revision: 3, draft: DRAFT_SELECTED, context: clientContext })
          : mission({ revision: 4, draft: DRAFT_SELECTED, context: linesContext });
        return {
          status: 'completed' as const,
          value: acknowledgement(currentMission),
        };
      }),
    };
    const hydrateDraft: QuoteScreenMissionPorts['hydrateDraft'] = vi.fn(async (expected) => {
      currentDraft = expected;
      return { status: 'ready' as const, reference: expected };
    });
    let command = 0;
    const coordinator = new QuoteScreenMissionCoordinator(
      () => `30000000-0000-4000-8000-${String(++command).padStart(12, '0')}`,
    );

    await expect(coordinator.advance(observation({
      confirmed: clientContext,
      instanceId: clientContext.screen.instanceId,
      draft: currentDraft,
    }), {
      actions,
      hydrateDraft,
      refreshRecovery: refreshAbsentRecovery,
    })).resolves.toEqual({ phase: 'refreshing' });
    expect(currentDraft).toEqual(DRAFT_SELECTED);

    await expect(coordinator.advance(observation({
      confirmed: linesContext,
      instanceId: linesContext.screen.instanceId,
      draft: currentDraft,
    }), {
      actions,
      hydrateDraft,
      refreshRecovery: refreshAbsentRecovery,
    })).resolves.toEqual({ phase: 'refreshing' });

    await expect(coordinator.advance(observation({
      confirmed: linesContext,
      instanceId: linesContext.screen.instanceId,
      draft: currentDraft,
    }), {
      actions,
      hydrateDraft,
      refreshRecovery: refreshAbsentRecovery,
    })).resolves.toMatchObject({
      phase: 'ready',
      mission: { revision: 4, phase: 'awaiting_lines' },
    });
    expect(acknowledgementInputs).toHaveLength(2);
    expect(acknowledgementInputs).toEqual([
      expect.objectContaining({
        expectedScreenInstanceId: 'devis-client',
        expectedMissionRevision: 1,
        draft: DRAFT_ZERO,
      }),
      expect.objectContaining({
        expectedScreenInstanceId: 'devis-lines',
        expectedMissionRevision: 3,
        draft: DRAFT_SELECTED,
      }),
    ]);
  });

  it('atteint le point fixe en un ACK quand le brouillon ne change pas', async () => {
    const clientContext = context(2, 'b', 'devis-client');
    let currentMission = mission({ revision: 1, draft: DRAFT_ZERO });
    const acknowledgeQuoteScreen = vi.fn(async () => {
      currentMission = mission({ revision: 2, draft: DRAFT_ZERO, context: clientContext });
      return {
        status: 'completed' as const,
        value: acknowledgement(currentMission),
      };
    });
    const actions: QuoteScreenMissionPorts['actions'] = {
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: currentMission },
      })),
      acknowledgeQuoteScreen,
    };
    const hydrateDraft = vi.fn(async () => ({
      status: 'ready' as const,
      reference: DRAFT_ZERO,
    }));
    const coordinator = new QuoteScreenMissionCoordinator(() =>
      '30000000-0000-4000-8000-000000000001');
    const input = observation({
      confirmed: clientContext,
      instanceId: clientContext.screen.instanceId,
      draft: DRAFT_ZERO,
    });

    await expect(coordinator.advance(input, {
      actions,
      hydrateDraft,
      refreshRecovery: refreshAbsentRecovery,
    }))
      .resolves.toEqual({ phase: 'refreshing' });
    await expect(coordinator.advance(input, {
      actions,
      hydrateDraft,
      refreshRecovery: refreshAbsentRecovery,
    }))
      .resolves.toMatchObject({ phase: 'ready' });
    expect(acknowledgeQuoteScreen).toHaveBeenCalledOnce();
  });

  it('partage le même vol sous double rendu et réutilise le commandId après réponse perdue', async () => {
    const currentContext = context(2, 'b', 'devis-client');
    const currentMission = mission({ revision: 1, draft: DRAFT_ZERO });
    const readGate = deferred<ReturnType<
      AgentMissionRuntimeActions['readCurrentQuoteCreation']
    > extends Promise<infer T> ? T : never>();
    const commandIds: string[] = [];
    let ackAttempt = 0;
    const actions: QuoteScreenMissionPorts['actions'] = {
      readCurrentQuoteCreation: vi.fn(() => readGate.promise),
      acknowledgeQuoteScreen: vi.fn(async (input) => {
        commandIds.push(input.commandId);
        ackAttempt += 1;
        return ackAttempt === 1
          ? { status: 'unavailable' as const }
          : {
              status: 'completed' as const,
              value: acknowledgement(
                mission({ revision: 2, draft: DRAFT_ZERO, context: currentContext }),
              ),
            };
      }),
    };
    let createdCommands = 0;
    const coordinator = new QuoteScreenMissionCoordinator(() => {
      createdCommands += 1;
      return '30000000-0000-4000-8000-000000000001';
    });
    const input = observation({
      confirmed: currentContext,
      instanceId: currentContext.screen.instanceId,
      draft: DRAFT_ZERO,
    });
    const ports = {
      actions,
      hydrateDraft: vi.fn(async () => ({
        status: 'ready' as const,
        reference: DRAFT_ZERO,
      })),
      refreshRecovery: refreshAbsentRecovery,
    };

    const first = coordinator.advance(input, ports);
    const doubled = coordinator.advance(input, ports);
    expect(first).toBe(doubled);
    readGate.resolve({
      status: 'completed',
      value: { mission: currentMission },
    });
    await expect(first).resolves.toEqual({
      phase: 'error',
      reason: 'mission_unavailable',
    });
    await coordinator.advance(input, ports);
    expect(commandIds).toEqual([
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
    ]);
    expect(createdCommands).toBe(1);
  });

  it('bloque explicitement une saisie locale sans jamais tenter l’ACK', async () => {
    const currentContext = context(2, 'b', 'devis-client');
    const actions: QuoteScreenMissionPorts['actions'] = {
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: mission({ revision: 1, draft: DRAFT_SELECTED }) },
      })),
      acknowledgeQuoteScreen: vi.fn(),
    };
    const coordinator = new QuoteScreenMissionCoordinator(() =>
      '30000000-0000-4000-8000-000000000001');

    await expect(coordinator.advance(observation({
      confirmed: currentContext,
      instanceId: currentContext.screen.instanceId,
      draft: DRAFT_ZERO,
    }), {
      actions,
      hydrateDraft: vi.fn(async () => ({ status: 'local_changes' as const })),
      refreshRecovery: refreshAbsentRecovery,
    })).resolves.toEqual({ phase: 'blocked', reason: 'local_changes' });
    expect(actions.acknowledgeQuoteScreen).not.toHaveBeenCalled();
  });
});
