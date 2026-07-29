import { describe, expect, it, vi } from 'vitest';
import type {
  AcknowledgeQuoteScreenOutput,
  AgentMissionViewV1,
} from '@bob/core';
import type {
  QuoteDraftAuthoritativeReference,
} from '../quote-draft/quote-draft-remote-store';
import type {
  AgentMissionConfirmedContext,
  AgentMissionRuntimeActions,
} from './agent-mission-runtime';
import {
  quoteScreenInstanceId,
  QuoteScreenMissionCoordinator,
  type QuoteScreenMissionObservation,
  type QuoteScreenMissionPorts,
} from './quote-screen-mission-coordinator';

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

function observation(input: {
  confirmed?: AgentMissionConfirmedContext | null;
  instanceId: string;
  draft: QuoteDraftAuthoritativeReference | null;
  realtimeSessionId?: string | null;
}): QuoteScreenMissionObservation {
  return {
    runtimeGeneration: 1,
    realtimeSessionId: input.realtimeSessionId === undefined
      ? REALTIME_ID
      : input.realtimeSessionId,
    confirmedContext: input.confirmed === undefined ? null : input.confirmed,
    screenInstanceId: input.instanceId,
    authoritativeDraft: input.draft,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

  it('reste manuel sans session et n’appelle aucun port', async () => {
    const actions = {
      readCurrentQuoteCreation: vi.fn(),
      acknowledgeQuoteScreen: vi.fn(),
    } as unknown as AgentMissionRuntimeActions;
    const hydrateDraft = vi.fn();
    const coordinator = new QuoteScreenMissionCoordinator(() =>
      '30000000-0000-4000-8000-000000000001');

    await expect(coordinator.advance(observation({
      realtimeSessionId: null,
      instanceId: 'manual',
      draft: null,
    }), { actions, hydrateDraft })).resolves.toEqual({
      phase: 'manual',
      reason: 'no_realtime_session',
    });
    expect(actions.readCurrentQuoteCreation).not.toHaveBeenCalled();
    expect(hydrateDraft).not.toHaveBeenCalled();
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
    }), { actions, hydrateDraft: vi.fn() })).resolves.toEqual({
      phase: 'waiting_context',
    });
    expect(actions.readCurrentQuoteCreation).not.toHaveBeenCalled();
    expect(actions.acknowledgeQuoteScreen).not.toHaveBeenCalled();
  });

  it('fait deux ACK contextuellement distincts après une sélection exacte', async () => {
    const clientContext = context(2, 'b', 'devis-client');
    const linesContext = context(3, 'c', 'devis-lines');
    let currentMission = mission({ revision: 1, draft: DRAFT_ZERO });
    let currentDraft = DRAFT_ZERO;
    const acknowledgementInputs: unknown[] = [];
    const actions: AgentMissionRuntimeActions = {
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
    }), { actions, hydrateDraft })).resolves.toEqual({ phase: 'refreshing' });
    expect(currentDraft).toEqual(DRAFT_SELECTED);

    await expect(coordinator.advance(observation({
      confirmed: linesContext,
      instanceId: linesContext.screen.instanceId,
      draft: currentDraft,
    }), { actions, hydrateDraft })).resolves.toEqual({ phase: 'refreshing' });

    await expect(coordinator.advance(observation({
      confirmed: linesContext,
      instanceId: linesContext.screen.instanceId,
      draft: currentDraft,
    }), { actions, hydrateDraft })).resolves.toMatchObject({
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
    const actions: AgentMissionRuntimeActions = {
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

    await expect(coordinator.advance(input, { actions, hydrateDraft }))
      .resolves.toEqual({ phase: 'refreshing' });
    await expect(coordinator.advance(input, { actions, hydrateDraft }))
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
    const actions: AgentMissionRuntimeActions = {
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
    const actions: AgentMissionRuntimeActions = {
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
    })).resolves.toEqual({ phase: 'blocked', reason: 'local_changes' });
    expect(actions.acknowledgeQuoteScreen).not.toHaveBeenCalled();
  });
});
