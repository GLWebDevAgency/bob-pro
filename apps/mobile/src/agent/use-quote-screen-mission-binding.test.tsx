import { StrictMode, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMissionViewV1 } from '@bob/core';
import type { QuoteDraftAuthoritativeReference } from '../quote-draft/quote-draft-remote-store';
import type {
  AgentMissionConfirmedContext,
  AgentMissionRuntimeActions,
  AgentMissionRuntimeSnapshot,
} from './agent-mission-runtime';
import {
  useQuoteScreenMissionBinding,
  type QuoteScreenMissionBinding,
} from './use-quote-screen-mission-binding';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const fixtures = vi.hoisted(() => ({
  actions: null as unknown as AgentMissionRuntimeActions,
  snapshot: null as unknown as AgentMissionRuntimeSnapshot,
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => '30000000-0000-4000-8000-000000000001',
}));
vi.mock('./agent-mission-provider', () => ({
  useAgentMissionRuntimeActions: () => fixtures.actions,
  useAgentMissionRuntimeSnapshot: () => fixtures.snapshot,
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

async function mount(input: {
  readonly authoritativeDraft: QuoteDraftAuthoritativeReference | null;
  readonly hydrateDraft?: (
    expected: QuoteDraftAuthoritativeReference,
  ) => Promise<{ readonly status: 'ready'; readonly reference: QuoteDraftAuthoritativeReference }>;
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

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  it('conserve le wizard manuel sans session et sans aucun appel réseau', async () => {
    fixtures.snapshot = {
      generation: 0,
      realtimeSessionId: null,
      confirmedContext: null,
    };
    fixtures.actions = {
      readCurrentQuoteCreation: vi.fn(),
      acknowledgeQuoteScreen: vi.fn(),
    };
    const mounted = await mount({ authoritativeDraft: null });
    renderer = mounted.renderer;

    expect(mounted.current().state).toEqual({
      phase: 'manual',
      reason: 'no_realtime_session',
    });
    expect(fixtures.actions.readCurrentQuoteCreation).not.toHaveBeenCalled();
  });

  it('libère M1-C après le même brouillon et le même contexte confirmé', async () => {
    const context = confirmedContext();
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      confirmedContext: context,
    };
    const readCurrentQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: { mission: boundMission(context) },
    }));
    fixtures.actions = {
      readCurrentQuoteCreation,
      acknowledgeQuoteScreen: vi.fn(),
    };
    const mounted = await mount({ authoritativeDraft: DRAFT, strict: true });
    renderer = mounted.renderer;

    expect(mounted.current().state).toMatchObject({
      phase: 'handoff',
      mission: { id: MISSION_ID, revision: 5 },
    });
    expect(readCurrentQuoteCreation).toHaveBeenCalledTimes(1);
    expect(fixtures.actions.acknowledgeQuoteScreen).not.toHaveBeenCalled();
  });

  it('ne réhydrate plus par-dessus une saisie manuelle après le handoff lignes', async () => {
    const context = confirmedContext();
    fixtures.snapshot = {
      generation: 2,
      realtimeSessionId: REALTIME_ID,
      confirmedContext: context,
    };
    const readCurrentQuoteCreation = vi.fn(async () => ({
      status: 'completed' as const,
      value: { mission: boundMission(context) },
    }));
    fixtures.actions = {
      readCurrentQuoteCreation,
      acknowledgeQuoteScreen: vi.fn(),
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
    };
    const hydrateDraft = vi.fn(async () => ({ status: 'busy' as const }));
    let binding: QuoteScreenMissionBinding | null = null;
    function Probe() {
      const current = useQuoteScreenMissionBinding({
        screenInstanceId: SCREEN_ID,
        authoritativeDraft: DRAFT,
        persistenceStatus: 'saving',
        hydrateDraft,
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
