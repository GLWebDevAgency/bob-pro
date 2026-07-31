import { StrictMode, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeQuoteMissionCatalogueChoiceSetHash,
  computeQuoteMissionLineConfirmationChoiceSetHash,
  type AgentMissionViewV1,
  type QuoteAgentMissionPresentationV1,
} from '@bob/core';
import type { QuoteDraftAuthoritativeReference } from '../quote-draft/quote-draft-remote-store';
import type {
  AgentMissionConfirmedContext,
  AgentMissionRuntimeActions,
  AgentMissionRuntimeSnapshot,
} from './agent-mission-runtime';
import type { AgentMissionRecoverySnapshot } from './agent-mission-recovery-state';
import {
  useQuoteScreenMissionBinding,
  type QuoteScreenMissionBinding,
} from './use-quote-screen-mission-binding';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const fixtures = vi.hoisted(() => ({
  actions: null as unknown as AgentMissionRuntimeActions,
  snapshot: null as unknown as AgentMissionRuntimeSnapshot,
  recovery: {
    snapshot: { phase: 'absent' } as AgentMissionRecoverySnapshot,
    refresh: vi.fn<() => Promise<AgentMissionRecoverySnapshot>>(
      async () => ({ phase: 'absent' }),
    ),
    refreshAfterMutation: vi.fn<() => Promise<AgentMissionRecoverySnapshot>>(
      async () => ({ phase: 'absent' }),
    ),
  },
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => '30000000-0000-4000-8000-000000000001',
}));
vi.mock('./agent-mission-provider', () => ({
  useAgentMissionRuntimeActions: () => fixtures.actions,
  useAgentMissionRuntimeSnapshot: () => fixtures.snapshot,
}));
vi.mock('./agent-mission-recovery', () => ({
  useAgentMissionRecovery: () => fixtures.recovery,
}));

const REALTIME_ID = '10000000-0000-4000-8000-000000000001';
const MISSION_ID = '20000000-0000-4000-8000-000000000001';
const DRAFT: QuoteDraftAuthoritativeReference = {
  sessionId: 'draft-session',
  slotRevision: 3,
  contentRevision: 1,
};
const OTHER_DRAFT: QuoteDraftAuthoritativeReference = {
  sessionId: 'other-draft-session',
  slotRevision: 4,
  contentRevision: 2,
};
const SCREEN_ID = 'devis-new:draft-session:3:1:lignes';
const EMPTY_PRESENTATION = {
  schema: 'bob.agent-mission.quote-presentation',
  version: 1,
  requiredFact: null,
  pendingLine: null,
  decision: null,
  catalogueChoices: [],
  freeLineChoiceId: null,
  proposalStatus: { kind: 'absent' },
  proposal: null,
} as const satisfies QuoteAgentMissionPresentationV1;

type QuoteLineRecoveryPhase =
  | 'awaiting_lines'
  | 'awaiting_catalogue_choice'
  | 'awaiting_line_details'
  | 'awaiting_line_confirmation';

const QUOTE_LINE_RECOVERY_PHASES = [
  'awaiting_lines',
  'awaiting_catalogue_choice',
  'awaiting_line_details',
  'awaiting_line_confirmation',
] as const satisfies readonly QuoteLineRecoveryPhase[];

function confirmedContext(): AgentMissionConfirmedContext {
  return {
    realtimeSessionId: REALTIME_ID,
    revision: 4,
    digest: 'a'.repeat(64),
    screen: { name: '/devis/new', instanceId: SCREEN_ID },
  };
}

function boundMission(context: AgentMissionConfirmedContext): AgentMissionViewV1 {
  return {
    id: MISSION_ID,
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase: 'awaiting_lines',
    revision: 5,
    payloadVersion: 1,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: DRAFT,
      decision: null,
      stagedCustomerResolution: null,
    },
    currentBinding: {
      realtimeSessionId: REALTIME_ID,
      contextRevision: context.revision,
      contextDigest: context.digest,
      screenName: '/devis/new',
      screenInstanceId: SCREEN_ID,
      acknowledgedAt: '2026-07-29T00:00:00.000Z',
    },
    idleExpiresAt: '2026-07-29T00:10:00.000Z',
    hardExpiresAt: '2026-07-29T01:00:00.000Z',
    terminalAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  } as AgentMissionViewV1;
}

function recoveryPresentation(
  phase: QuoteLineRecoveryPhase,
  missionId: string,
  missionRevision: number,
): QuoteAgentMissionPresentationV1 {
  if (phase === 'awaiting_lines') return EMPTY_PRESENTATION;
  if (phase === 'awaiting_catalogue_choice') {
    const choices = [{
      choiceId: '50000000-0000-4000-8000-000000000010',
      catalogueItemId: 'catalogue-labour-plumbing',
      expectedCatalogueRevision: 3,
    }];
    const hash = computeQuoteMissionCatalogueChoiceSetHash({
      missionId,
      choiceSetRevision: missionRevision,
      decisionId: '40000000-0000-4000-8000-000000000010',
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedDraft: DRAFT,
      expectedWorkRevision: 2,
      candidates: choices,
      freeLineChoiceId: '50000000-0000-4000-8000-000000000011',
    });
    if (!hash.ok) throw new Error('Fixture catalogue invalide');
    return {
      ...EMPTY_PRESENTATION,
      pendingLine: {
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        expectedWorkRevision: 2,
      },
      decision: {
        kind: 'catalogue',
        decisionId: '40000000-0000-4000-8000-000000000010',
        choiceSetRevision: missionRevision,
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        expectedDraft: DRAFT,
        expectedWorkRevision: 2,
        choices,
        freeLineChoiceId: '50000000-0000-4000-8000-000000000011',
        choiceSetHash: hash.value,
      },
      catalogueChoices: [{
        choiceId: '50000000-0000-4000-8000-000000000010',
        available: true,
        label: 'Heure de main-d’œuvre plomberie',
        category: 'labor',
        unit: 'heure',
        unitPriceCents: 5_500,
        vatRate: 20,
      }],
      freeLineChoiceId: '50000000-0000-4000-8000-000000000011',
    };
  }
  if (phase === 'awaiting_line_details') {
    return {
      ...EMPTY_PRESENTATION,
      requiredFact: 'unit_price',
      pendingLine: {
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        expectedWorkRevision: 2,
      },
    };
  }
  const choices = [
    {
      choiceId: '50000000-0000-4000-8000-000000000020',
      action: 'confirm_line' as const,
    },
    {
      choiceId: '50000000-0000-4000-8000-000000000021',
      action: 'edit_line' as const,
    },
    {
      choiceId: '50000000-0000-4000-8000-000000000022',
      action: 'cancel_line' as const,
    },
  ] as const;
  const hash = computeQuoteMissionLineConfirmationChoiceSetHash({
    missionId,
    choiceSetRevision: missionRevision,
    decisionId: '40000000-0000-4000-8000-000000000020',
    pendingLineId: '60000000-0000-4000-8000-000000000001',
    proposalId: '70000000-0000-4000-8000-000000000001',
    proposalRevision: 1,
    expectedDraft: DRAFT,
    expectedWorkRevision: 2,
    expectedCatalogue: {
      itemId: 'catalogue-labour-plumbing',
      revision: 3,
    },
    expectedVatContextDigest: 'd'.repeat(64),
    diffHash: 'f'.repeat(64),
    choices,
  });
  if (!hash.ok) throw new Error('Fixture proposition invalide');
  return {
    ...EMPTY_PRESENTATION,
    pendingLine: {
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedWorkRevision: 2,
    },
    decision: {
      kind: 'line_confirmation',
      decisionId: '40000000-0000-4000-8000-000000000020',
      choiceSetRevision: missionRevision,
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      proposalId: '70000000-0000-4000-8000-000000000001',
      proposalRevision: 1,
      expectedDraft: DRAFT,
      expectedWorkRevision: 2,
      expectedCatalogue: {
        itemId: 'catalogue-labour-plumbing',
        revision: 3,
      },
      expectedVatContextDigest: 'd'.repeat(64),
      diffHash: 'f'.repeat(64),
      choices,
      choiceSetHash: hash.value,
    },
    proposalStatus: { kind: 'available' },
    proposal: {
      proposalId: '70000000-0000-4000-8000-000000000001',
      diffHash: 'f'.repeat(64),
      diff: {
        kind: 'append_line',
        before: {
          contentRevision: DRAFT.contentRevision,
          lineCount: 0,
          totalHtCents: 0,
        },
        after: {
          contentRevision: DRAFT.contentRevision + 1,
          lineCount: 1,
          totalHtCents: 11_000,
        },
      },
      line: {
        label: 'Main-d’œuvre plomberie',
        category: 'labor',
        qty: 2,
        unitPriceHT: 5_500,
        vatRate: 20,
        unit: 'heures',
      },
      catalogue: {
        itemId: 'catalogue-labour-plumbing',
        revision: 3,
        label: 'Heure de main-d’œuvre plomberie',
      },
    },
  };
}

function coldRecoveryV2(
  phase: QuoteLineRecoveryPhase,
): Extract<AgentMissionRecoverySnapshot, { readonly phase: 'resumable' }> {
  const base = boundMission(confirmedContext());
  const phaseOrdinal = QUOTE_LINE_RECOVERY_PHASES.indexOf(phase);
  const missionRevision = base.revision + phaseOrdinal;
  return {
    phase: 'resumable',
    value: {
      protocolVersion: 2,
      mission: {
        id: base.id,
        status: 'active',
        phase,
        revision: missionRevision,
        actionable: true,
        draft: DRAFT,
        idleExpiresAt: base.idleExpiresAt,
        hardExpiresAt: base.hardExpiresAt,
      },
      draft: { ...DRAFT, step: 'lignes' },
      customerChoices: [],
      presentation: recoveryPresentation(phase, base.id, missionRevision),
    },
  };
}

function handedOffMission(context: AgentMissionConfirmedContext): AgentMissionViewV1 {
  return {
    ...boundMission(context),
    status: 'cancelled',
    actionable: false,
    revision: 6,
    terminalAt: '2026-07-29T00:01:00.000Z',
    updatedAt: '2026-07-29T00:01:00.000Z',
  } as AgentMissionViewV1;
}

function recoveredV2(
  current: AgentMissionViewV1,
): AgentMissionRecoverySnapshot {
  return {
    phase: 'resumable',
    value: {
      protocolVersion: 2,
      mission: {
        id: current.id,
        status: 'active',
        phase: current.phase,
        revision: current.revision,
        actionable: true,
        draft: DRAFT,
        idleExpiresAt: current.idleExpiresAt,
        hardExpiresAt: current.hardExpiresAt,
      },
      draft: { ...DRAFT, step: 'lignes' },
      customerChoices: [],
      presentation: EMPTY_PRESENTATION,
    },
  };
}

function unimplementedQuoteLineActions(): Pick<
  AgentMissionRuntimeActions,
  | 'stageQuoteLines'
  | 'decideQuoteCatalogueChoice'
  | 'patchQuoteLine'
  | 'cancelPendingQuoteLine'
  | 'decideQuoteLineProposal'
  | 'abandonQuoteCreation'
> {
  return {
    stageQuoteLines: vi.fn(),
    decideQuoteCatalogueChoice: vi.fn(),
    patchQuoteLine: vi.fn(),
    cancelPendingQuoteLine: vi.fn(),
    decideQuoteLineProposal: vi.fn(),
    abandonQuoteCreation: vi.fn(),
  };
}

async function mount(input: {
  readonly authoritativeDraft: QuoteDraftAuthoritativeReference | null;
  readonly hydrateDraft?: (
    expected: QuoteDraftAuthoritativeReference,
  ) => Promise<{ readonly status: 'ready'; readonly reference: QuoteDraftAuthoritativeReference }>;
  readonly suspendLiveForManualHandoff?: () => Promise<boolean>;
  readonly stopLiveAfterManualHandoff?: () => Promise<number | null>;
  readonly strict?: boolean;
}): Promise<{
  readonly current: () => QuoteScreenMissionBinding;
  readonly renderer: ReactTestRenderer;
}> {
  let binding: QuoteScreenMissionBinding | null = null;
  const hydrateDraft = input.hydrateDraft ?? (async (expected) => ({
    status: 'ready' as const,
    reference: expected,
  }));
  function Probe() {
    const current = useQuoteScreenMissionBinding({
      screenInstanceId: SCREEN_ID,
      authoritativeDraft: input.authoritativeDraft,
      persistenceStatus: 'ready',
      hydrateDraft,
      suspendLiveForManualHandoff:
        input.suspendLiveForManualHandoff ?? (async () => true),
      stopLiveAfterManualHandoff:
        input.stopLiveAfterManualHandoff ?? (async () => fixtures.snapshot.generation),
    });
    useEffect(() => {
      binding = current;
    }, [current]);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(input.strict ? (
      <StrictMode>
        <Probe />
      </StrictMode>
    ) : <Probe />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    current: () => {
      if (binding === null) throw new Error('Binding non publié');
      return binding;
    },
    renderer,
  };
}

describe('useQuoteScreenMissionBinding — frontière React', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    fixtures.recovery = {
      snapshot: { phase: 'absent' },
      refresh: vi.fn(async (): Promise<AgentMissionRecoverySnapshot> => ({
        phase: 'absent',
      })),
      refreshAfterMutation: vi.fn(async (): Promise<AgentMissionRecoverySnapshot> => ({
        phase: 'absent',
      })),
    };
  });

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  it('conserve le wizard manuel sans session après preuve froide mission:null', async () => {
    fixtures.snapshot = {
      generation: 0,
      realtimeSessionId: null,
      protocolVersion: null,
      confirmedContext: null,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation: vi.fn(),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    const mounted = await mount({ authoritativeDraft: null });
    renderer = mounted.renderer;

    expect(mounted.current().state).toEqual({
      phase: 'manual',
      reason: 'no_mission',
    });
    expect(fixtures.actions.readCurrentQuoteCreation).not.toHaveBeenCalled();
  });

  it('propose une reprise explicite après kill sans parler, naviguer ni appeler la capability', async () => {
    const coldMission = boundMission(confirmedContext());
    fixtures.snapshot = {
      generation: 0,
      realtimeSessionId: null,
      protocolVersion: null,
      confirmedContext: null,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation: vi.fn(),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    const coldRecovery: AgentMissionRecoverySnapshot = {
      phase: 'resumable',
      value: {
        protocolVersion: 1,
        mission: {
          id: coldMission.id,
          status: 'active',
          phase: coldMission.phase,
          revision: coldMission.revision,
          actionable: true,
          draft: DRAFT,
          idleExpiresAt: coldMission.idleExpiresAt,
          hardExpiresAt: coldMission.hardExpiresAt,
        },
        draft: { ...DRAFT, step: 'lignes' },
        customerChoices: [],
        presentation: null,
      },
    };
    fixtures.recovery = {
      snapshot: coldRecovery,
      refresh: vi.fn(async (): Promise<AgentMissionRecoverySnapshot> => ({
        phase: 'error',
        reason: 'unavailable',
      })),
      refreshAfterMutation: vi.fn(
        async (): Promise<AgentMissionRecoverySnapshot> => coldRecovery,
      ),
    };

    const mounted = await mount({ authoritativeDraft: null });
    renderer = mounted.renderer;

    expect(mounted.current().state).toMatchObject({
      phase: 'resume_required',
      recovery: { mission: { id: MISSION_ID, revision: 5 } },
    });
    expect(fixtures.actions.readCurrentQuoteCreation).not.toHaveBeenCalled();
    expect(fixtures.recovery.refresh).not.toHaveBeenCalled();
  });

  it.each(QUOTE_LINE_RECOVERY_PHASES)(
    'reprend à froid %s avec la présentation exacte et zéro commande métier',
    async (phase) => {
      fixtures.snapshot = {
        generation: 0,
        realtimeSessionId: null,
        protocolVersion: null,
        confirmedContext: null,
        lastTurnSettlement: null,
      };
      const quoteLineActions = unimplementedQuoteLineActions();
      const readCurrentQuoteCreation = vi.fn();
      const acknowledgeQuoteScreen = vi.fn();
      const decideQuoteCreation = vi.fn();
      const manualHandoffQuoteCreation = vi.fn();
      fixtures.actions = {
        ...quoteLineActions,
        readCurrentQuoteCreation,
        acknowledgeQuoteScreen,
        decideQuoteCreation,
        manualHandoffQuoteCreation,
      };
      const coldRecovery = coldRecoveryV2(phase);
      const refreshAfterMutation = vi.fn(
        async (): Promise<AgentMissionRecoverySnapshot> => coldRecovery,
      );
      fixtures.recovery = {
        snapshot: coldRecovery,
        refresh: vi.fn(async (): Promise<AgentMissionRecoverySnapshot> => coldRecovery),
        refreshAfterMutation,
      };

      const mounted = await mount({ authoritativeDraft: null });
      renderer = mounted.renderer;

      expect(mounted.current().state).toEqual({
        phase: 'resume_required',
        recovery: coldRecovery.value,
      });
      expect(refreshAfterMutation).toHaveBeenCalledOnce();
      expect(readCurrentQuoteCreation).not.toHaveBeenCalled();
      expect(acknowledgeQuoteScreen).not.toHaveBeenCalled();
      expect(decideQuoteCreation).not.toHaveBeenCalled();
      expect(manualHandoffQuoteCreation).not.toHaveBeenCalled();
      expect(quoteLineActions.stageQuoteLines).not.toHaveBeenCalled();
      expect(quoteLineActions.decideQuoteCatalogueChoice).not.toHaveBeenCalled();
      expect(quoteLineActions.patchQuoteLine).not.toHaveBeenCalled();
      expect(quoteLineActions.decideQuoteLineProposal).not.toHaveBeenCalled();
    },
  );

  it('bloque le writer puis libère M1-C seulement après la passation durable', async () => {
    const order: string[] = [];
    const context = confirmedContext();
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 1,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    const readCurrentQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: { mission: boundMission(context), presentation: null },
    }));
    const manualHandoffQuoteCreation = vi.fn(async () => {
      order.push('cancel');
      return {
        status: 'completed' as const,
        value: {
          outcome: 'cancelled' as const,
          mission: handedOffMission(context),
        },
      };
    });
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation,
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation,
    };
    fixtures.recovery.refreshAfterMutation = vi.fn(async () => {
      order.push('refresh');
      return { phase: 'absent' as const };
    });
    const mounted = await mount({
      authoritativeDraft: DRAFT,
      strict: true,
      suspendLiveForManualHandoff: async () => {
        order.push('suspend');
        return true;
      },
      stopLiveAfterManualHandoff: async () => {
        order.push('stop');
        // Le provider réel publie synchroniquement la génération sans capability pendant stop().
        fixtures.snapshot = {
          generation: 3,
          realtimeSessionId: null,
          protocolVersion: null,
          confirmedContext: null,
          lastTurnSettlement: null,
        };
        return 3;
      },
    });
    renderer = mounted.renderer;

    expect(mounted.current().state).toMatchObject({
      phase: 'handoff_required',
      mission: { id: MISSION_ID, revision: 5 },
    });
    expect(readCurrentQuoteCreation).toHaveBeenCalledTimes(1);
    expect(fixtures.actions.acknowledgeQuoteScreen).not.toHaveBeenCalled();
    expect(manualHandoffQuoteCreation).not.toHaveBeenCalled();

    await act(async () => {
      await mounted.current().continueManually();
    });

    expect(manualHandoffQuoteCreation).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      commandId: '30000000-0000-4000-8000-000000000001',
      expectedMissionRevision: 5,
      expectedScreenInstanceId: SCREEN_ID,
    });
    expect(mounted.current().state).toMatchObject({
      phase: 'handoff',
      mission: { id: MISSION_ID, status: 'cancelled', revision: 6 },
    });
    expect(order).toEqual(['suspend', 'cancel', 'stop', 'refresh']);
    expect(fixtures.recovery.refreshAfterMutation).toHaveBeenCalledOnce();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.current().state.phase).toBe('handoff');
    expect(fixtures.recovery.refreshAfterMutation).toHaveBeenCalledOnce();
  });

  it('conserve Bob Live et ferme le writer legacy à awaiting_lines sous V2', async () => {
    const context = confirmedContext();
    const current = boundMission(context);
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 2,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: current, presentation: EMPTY_PRESENTATION },
      })),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    const mounted = await mount({ authoritativeDraft: DRAFT });
    renderer = mounted.renderer;

    expect(mounted.current().state).toEqual({
      phase: 'ready',
      protocolVersion: 2,
      mission: current,
      customerChoices: [],
      presentation: EMPTY_PRESENTATION,
    });
    expect(fixtures.actions.manualHandoffQuoteCreation).not.toHaveBeenCalled();
  });

  it('abandonne V2 avec une commande unique, ferme le transport puis libère le writer', async () => {
    const context = confirmedContext();
    const current = boundMission(context);
    const terminal = {
      ...current,
      status: 'cancelled',
      actionable: false,
      revision: current.revision + 1,
      terminalAt: '2026-07-30T12:00:00.000Z',
    } as AgentMissionViewV1;
    const order: string[] = [];
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 2,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    const abandonQuoteCreation = vi.fn(async () => {
      order.push('cancel');
      return {
        status: 'completed' as const,
        value: { outcome: 'cancelled' as const, mission: terminal },
      };
    });
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      abandonQuoteCreation,
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: current, presentation: EMPTY_PRESENTATION },
      })),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    fixtures.recovery.refreshAfterMutation = vi.fn(async () => {
      order.push('refresh');
      return { phase: 'absent' as const };
    });
    const mounted = await mount({
      authoritativeDraft: DRAFT,
      suspendLiveForManualHandoff: async () => {
        order.push('suspend');
        return true;
      },
      stopLiveAfterManualHandoff: async () => {
        order.push('stop');
        fixtures.snapshot = {
          generation: 3,
          realtimeSessionId: null,
          protocolVersion: null,
          confirmedContext: null,
          lastTurnSettlement: null,
        };
        return 3;
      },
    });
    renderer = mounted.renderer;
    expect(mounted.current().state.phase).toBe('ready');

    let first!: Promise<boolean>;
    let doubled!: Promise<boolean>;
    await act(async () => {
      first = mounted.current().abandonMission();
      doubled = mounted.current().abandonMission();
      expect(doubled).toBe(first);
      await expect(Promise.all([first, doubled])).resolves.toEqual([true, true]);
    });

    expect(abandonQuoteCreation).toHaveBeenCalledOnce();
    expect(abandonQuoteCreation).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      commandId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      expectedMissionRevision: current.revision,
      expectedScreenInstanceId: SCREEN_ID,
    });
    expect(order).toEqual(['suspend', 'cancel', 'stop', 'refresh']);
    expect(mounted.current().state).toEqual({
      phase: 'manual',
      reason: 'no_mission',
    });
  });

  it('refuse de rendre la main si le GET causal retrouve la mission après abandon', async () => {
    const context = confirmedContext();
    const current = boundMission(context);
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 2,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      abandonQuoteCreation: vi.fn(async () => ({ status: 'unavailable' as const })),
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: current, presentation: EMPTY_PRESENTATION },
      })),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    fixtures.recovery.refreshAfterMutation = vi.fn(async () => recoveredV2(current));
    const mounted = await mount({ authoritativeDraft: DRAFT });
    renderer = mounted.renderer;

    await act(async () => {
      await expect(mounted.current().abandonMission()).resolves.toBe(false);
    });

    expect(mounted.current().state).toMatchObject({
      phase: 'resume_required',
      recovery: { mission: { id: MISSION_ID, status: 'active' } },
    });
  });

  it('borne les GET de reprise malgré l’alternance loading et snapshot périmé du même tuple', async () => {
    const context = confirmedContext();
    const base = boundMission(context);
    const current = {
      ...base,
      phase: 'awaiting_customer_choice' as const,
      payload: {
        ...base.payload,
        decision: {
          kind: 'customer' as const,
          decisionId: '40000000-0000-4000-8000-000000000001',
          choiceSetRevision: 3,
          candidates: [{
            choiceId: '50000000-0000-4000-8000-000000000001',
            customerId: 'customer-a',
          }],
          choiceSetHash: 'f'.repeat(64),
        },
      },
    } as AgentMissionViewV1;
    const staleRecovery: AgentMissionRecoverySnapshot = {
      phase: 'resumable',
      value: {
        protocolVersion: 2,
        mission: {
          id: current.id,
          status: 'active',
          phase: current.phase,
          revision: current.revision - 1,
          actionable: true,
          draft: DRAFT,
          idleExpiresAt: current.idleExpiresAt,
          hardExpiresAt: current.hardExpiresAt,
        },
        draft: { ...DRAFT, step: 'client' },
        customerChoices: [{
          status: 'available',
          choiceId: '50000000-0000-4000-8000-000000000001',
          label: 'Camping Les Pins',
        }],
        presentation: EMPTY_PRESENTATION,
      },
    };
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 2,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    const readCurrentQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: { mission: current, presentation: EMPTY_PRESENTATION },
    }));
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation,
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    fixtures.recovery.snapshot = { phase: 'loading' };
    fixtures.recovery.refresh = vi.fn(async () => {
      // React Query publie `loading` pendant le GET. La réponse N-1 reste périmée et sera
      // republiée par le test, comme lors d'une réplication temporairement en retard.
      fixtures.recovery.snapshot = { phase: 'loading' };
      return { phase: 'loading' as const };
    });
    const hydrateDraft = async (expected: QuoteDraftAuthoritativeReference) => ({
      status: 'ready' as const,
      reference: expected,
    });
    const suspendLiveForManualHandoff = async () => true;
    const stopLiveAfterManualHandoff = async () => fixtures.snapshot.generation;

    let binding: QuoteScreenMissionBinding | null = null;
    function Probe({ publication }: { readonly publication: number }) {
      void publication;
      const currentBinding = useQuoteScreenMissionBinding({
        screenInstanceId: SCREEN_ID,
        authoritativeDraft: DRAFT,
        persistenceStatus: 'ready',
        hydrateDraft,
        suspendLiveForManualHandoff,
        stopLiveAfterManualHandoff,
      });
      useEffect(() => {
        binding = currentBinding;
      }, [currentBinding]);
      return null;
    }
    const currentBinding = (): QuoteScreenMissionBinding => {
      if (binding === null) throw new Error('Binding non publié');
      return binding;
    };

    await act(async () => {
      renderer = create(<Probe publication={0} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentBinding().state.phase).toBe('waiting_recovery');

    for (let publication = 1; publication <= 7; publication += 1) {
      fixtures.recovery.snapshot = staleRecovery;
      await act(async () => {
        renderer?.update(<Probe publication={publication} />);
        for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
      });
    }

    expect(fixtures.recovery.refresh).toHaveBeenCalledTimes(7);
    expect(currentBinding().state).toEqual({
      phase: 'error',
      reason: 'slot_unavailable',
    });
    // Une lecture mission par publication `loading` ou `resumable`, jamais une hot-loop autonome.
    expect(readCurrentQuoteCreation.mock.calls.length).toBeLessThanOrEqual(15);
  });

  it('après perte runtime, exige un GET causal avant tout writer puis propose la reprise V2', async () => {
    const context = confirmedContext();
    const current = boundMission(context);
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 2,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: current, presentation: EMPTY_PRESENTATION },
      })),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    let resolveRecovery!: (value: AgentMissionRecoverySnapshot) => void;
    fixtures.recovery.refreshAfterMutation = vi.fn(
      () => new Promise<AgentMissionRecoverySnapshot>((resolvePromise) => {
        resolveRecovery = (value) => {
          // Le vrai provider publie le résultat dans React Query avant de résoudre.
          fixtures.recovery.snapshot = value;
          resolvePromise(value);
        };
      }),
    );
    const mounted = await mount({ authoritativeDraft: DRAFT, strict: true });
    renderer = mounted.renderer;
    expect(mounted.current().state.phase).toBe('ready');

    fixtures.snapshot = {
      generation: 3,
      realtimeSessionId: null,
      protocolVersion: null,
      confirmedContext: null,
      lastTurnSettlement: null,
    };
    await act(async () => {
      mounted.current().retry();
      await Promise.resolve();
    });

    expect(mounted.current().state.phase).not.toBe('manual');
    expect(fixtures.recovery.refreshAfterMutation).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRecovery(recoveredV2(current));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mounted.current().state).toMatchObject({
      phase: 'resume_required',
      recovery: {
        protocolVersion: 2,
        mission: { id: MISSION_ID, revision: 5 },
      },
    });
    expect(fixtures.actions.manualHandoffQuoteCreation).not.toHaveBeenCalled();
  });

  it('ne libère jamais le writer si la lecture causale retrouve une mission active', async () => {
    const context = confirmedContext();
    const current = boundMission(context);
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 1,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    const manualHandoffQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: {
        outcome: 'cancelled' as const,
        mission: handedOffMission(context),
      },
    }));
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: current, presentation: null },
      })),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation,
    };
    const recovered: AgentMissionRecoverySnapshot = {
      phase: 'resumable',
      value: {
        protocolVersion: 1,
        mission: {
          id: current.id,
          status: 'active',
          phase: current.phase,
          revision: current.revision,
          actionable: true,
          draft: DRAFT,
          idleExpiresAt: current.idleExpiresAt,
          hardExpiresAt: current.hardExpiresAt,
        },
        draft: { ...DRAFT, step: 'lignes' },
        customerChoices: [],
        presentation: null,
      },
    };
    fixtures.recovery.refreshAfterMutation = vi.fn(async () => recovered);
    const mounted = await mount({ authoritativeDraft: DRAFT });
    renderer = mounted.renderer;
    expect(mounted.current().state.phase).toBe('handoff_required');

    let first!: Promise<void>;
    let doubled!: Promise<void>;
    await act(async () => {
      first = mounted.current().continueManually();
      doubled = mounted.current().continueManually();
      expect(doubled).toBe(first);
      await Promise.all([first, doubled]);
    });

    expect(manualHandoffQuoteCreation).toHaveBeenCalledOnce();
    expect(fixtures.recovery.refreshAfterMutation).toHaveBeenCalledOnce();
    expect(mounted.current().state).toMatchObject({
      phase: 'resume_required',
      recovery: { mission: { id: MISSION_ID, status: 'active' } },
    });
  });

  it('ne libère jamais le writer si la fermeture transport/capability échoue', async () => {
    const context = confirmedContext();
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 1,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: boundMission(context), presentation: null },
      })),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: {
          outcome: 'cancelled' as const,
          mission: handedOffMission(context),
        },
      })),
    };
    fixtures.recovery.refreshAfterMutation = vi.fn(async () => ({
      phase: 'absent' as const,
    }));
    const mounted = await mount({
      authoritativeDraft: DRAFT,
      stopLiveAfterManualHandoff: async () => {
        throw new Error('release_failed');
      },
    });
    renderer = mounted.renderer;

    await act(async () => {
      await mounted.current().continueManually();
    });

    expect(fixtures.recovery.refreshAfterMutation).toHaveBeenCalledOnce();
    expect(mounted.current().state.phase).toBe('handoff_error');
  });

  it('ne réhydrate plus par-dessus une saisie manuelle après le handoff lignes', async () => {
    const context = confirmedContext();
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 1,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    const readCurrentQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: { mission: boundMission(context), presentation: null },
    }));
    const manualHandoffQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: {
        outcome: 'cancelled' as const,
        mission: handedOffMission(context),
      },
    }));
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation,
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation,
    };
    const hydrateDraft = vi.fn(async (expected: QuoteDraftAuthoritativeReference) => ({
      status: 'ready' as const,
      reference: expected,
    }));
    let binding: QuoteScreenMissionBinding | null = null;
    function Probe({
      authoritativeDraft,
      screenInstanceId,
    }: {
      readonly authoritativeDraft: QuoteDraftAuthoritativeReference | null;
      readonly screenInstanceId: string;
    }) {
      const current = useQuoteScreenMissionBinding({
        screenInstanceId,
        authoritativeDraft,
        persistenceStatus: 'ready',
        hydrateDraft,
        suspendLiveForManualHandoff: async () => true,
        stopLiveAfterManualHandoff: async () => fixtures.snapshot.generation,
      });
      useEffect(() => {
        binding = current;
      }, [current]);
      return null;
    }
    const currentBinding = (): QuoteScreenMissionBinding => {
      if (binding === null) throw new Error('Binding non publié');
      return binding;
    };

    await act(async () => {
      renderer = create(
        <Probe authoritativeDraft={DRAFT} screenInstanceId={SCREEN_ID} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentBinding().state.phase).toBe('handoff_required');
    await act(async () => {
      await currentBinding().continueManually();
    });
    expect(currentBinding().state.phase).toBe('handoff');

    await act(async () => {
      renderer?.update(
        <Probe
          authoritativeDraft={null}
          screenInstanceId={`${SCREEN_ID}:local-edit`}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(currentBinding().state.phase).toBe('handoff');
    expect(readCurrentQuoteCreation).toHaveBeenCalledTimes(1);
    expect(hydrateDraft).not.toHaveBeenCalled();
  });

  it('attend une persistance occupée sans hot-loop ni fausse indisponibilité', async () => {
    const context = confirmedContext();
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      protocolVersion: 1,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    const mission = {
      ...boundMission(context),
      phase: 'awaiting_customer' as const,
      payload: {
        ...boundMission(context).payload,
        draft: OTHER_DRAFT,
      },
      currentBinding: null,
    } as AgentMissionViewV1;
    fixtures.actions = {
      ...unimplementedQuoteLineActions(),
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission, presentation: null },
      })),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    const hydrateDraft = vi.fn(async () => ({ status: 'busy' as const }));
    let binding: QuoteScreenMissionBinding | null = null;
    function Probe() {
      const current = useQuoteScreenMissionBinding({
        screenInstanceId: SCREEN_ID,
        authoritativeDraft: DRAFT,
        persistenceStatus: 'saving',
        hydrateDraft,
        suspendLiveForManualHandoff: async () => true,
        stopLiveAfterManualHandoff: async () => fixtures.snapshot.generation,
      });
      useEffect(() => {
        binding = current;
      }, [current]);
      return null;
    }
    const currentBinding = (): QuoteScreenMissionBinding => {
      if (binding === null) throw new Error('Binding non publié');
      return binding;
    };

    await act(async () => {
      renderer = create(<Probe />);
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });

    expect(currentBinding().state.phase).toBe('hydrating');
    expect(hydrateDraft).toHaveBeenCalledTimes(1);
    expect(fixtures.actions.acknowledgeQuoteScreen).not.toHaveBeenCalled();
  });
});
