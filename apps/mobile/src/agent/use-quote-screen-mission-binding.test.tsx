import { StrictMode, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMissionViewV1 } from '@bob/core';
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

async function mount(input: {
  readonly authoritativeDraft: QuoteDraftAuthoritativeReference | null;
  readonly hydrateDraft?: (
    expected: QuoteDraftAuthoritativeReference,
  ) => Promise<{ readonly status: 'ready'; readonly reference: QuoteDraftAuthoritativeReference }>;
  readonly suspendLiveForManualHandoff?: () => Promise<boolean>;
  readonly stopLiveAfterManualHandoff?: () => Promise<void>;
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
        input.stopLiveAfterManualHandoff ?? (async () => undefined),
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
      confirmedContext: null,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
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
      confirmedContext: null,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
      readCurrentQuoteCreation: vi.fn(),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation: vi.fn(),
    };
    fixtures.recovery = {
      snapshot: {
        phase: 'resumable',
        value: {
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
        },
      },
      refresh: vi.fn(async (): Promise<AgentMissionRecoverySnapshot> => ({
        phase: 'error',
        reason: 'unavailable',
      })),
      refreshAfterMutation: vi.fn(async (): Promise<AgentMissionRecoverySnapshot> => ({
        phase: 'error',
        reason: 'unavailable',
      })),
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

  it('bloque le writer puis libère M1-C seulement après la passation durable', async () => {
    const order: string[] = [];
    const context = confirmedContext();
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    const readCurrentQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: { mission: boundMission(context) },
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
  });

  it('ne libère jamais le writer si la lecture causale retrouve une mission active', async () => {
    const context = confirmedContext();
    const current = boundMission(context);
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
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
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: current },
      })),
      acknowledgeQuoteScreen: vi.fn(),
      decideQuoteCreation: vi.fn(),
      manualHandoffQuoteCreation,
    };
    const recovered: AgentMissionRecoverySnapshot = {
      phase: 'resumable',
      value: {
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
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    fixtures.actions = {
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission: boundMission(context) },
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
      confirmedContext: context,
      lastTurnSettlement: null,
    };
    const readCurrentQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: { mission: boundMission(context) },
    }));
    const manualHandoffQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: {
        outcome: 'cancelled' as const,
        mission: handedOffMission(context),
      },
    }));
    fixtures.actions = {
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
        stopLiveAfterManualHandoff: async () => undefined,
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
      readCurrentQuoteCreation: vi.fn(async () => ({
        status: 'completed' as const,
        value: { mission },
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
        stopLiveAfterManualHandoff: async () => undefined,
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
