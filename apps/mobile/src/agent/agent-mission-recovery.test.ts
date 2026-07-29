import { describe, expect, it } from 'vitest';
import type { QuoteAgentMissionResumeView } from '@bob/core';
import {
  deriveAgentMissionRecoverySnapshot,
  sameRecoveredMission,
} from './agent-mission-recovery-state';

const RESUMABLE = {
  mission: {
    id: '20000000-0000-4000-8000-000000000001',
    status: 'active',
    phase: 'awaiting_customer_choice',
    revision: 4,
    actionable: true,
    draft: {
      sessionId: 'quote-draft-session',
      slotRevision: 2,
      contentRevision: 1,
    },
    idleExpiresAt: '2026-07-29T10:10:00.000Z',
    hardExpiresAt: '2026-07-29T11:00:00.000Z',
  },
  draft: {
    sessionId: 'quote-draft-session',
    slotRevision: 2,
    contentRevision: 1,
    step: 'client',
  },
  customerChoices: [
    {
      status: 'available',
      choiceId: '50000000-0000-4000-8000-000000000001',
      label: 'Camping Les Pins',
    },
  ],
} as const satisfies QuoteAgentMissionResumeView;

describe('AgentMissionRecovery — preuve froide fail-closed', () => {
  it('n’autorise le manuel qu’après une réponse serveur explicitement vide', () => {
    expect(deriveAgentMissionRecoverySnapshot({
      authenticated: true,
      pending: false,
      fetching: false,
      failed: false,
      data: { mission: null },
    })).toEqual({ phase: 'absent' });
  });

  it.each([
    {
      label: 'non authentifié',
      input: {
        authenticated: false,
        pending: false,
        fetching: false,
        failed: false,
        data: undefined,
      },
      expected: { phase: 'error', reason: 'unauthenticated' },
    },
    {
      label: 'chargement initial',
      input: {
        authenticated: true,
        pending: true,
        fetching: true,
        failed: false,
        data: undefined,
      },
      expected: { phase: 'loading' },
    },
    {
      label: 'rafraîchissement',
      input: {
        authenticated: true,
        pending: false,
        fetching: true,
        failed: false,
        data: { mission: null } as QuoteAgentMissionResumeView,
      },
      expected: { phase: 'loading' },
    },
    {
      label: 'panne serveur',
      input: {
        authenticated: true,
        pending: false,
        fetching: false,
        failed: true,
        data: undefined,
      },
      expected: { phase: 'error', reason: 'unavailable' },
    },
  ])('reste fermé pendant $label', ({ input, expected }) => {
    expect(deriveAgentMissionRecoverySnapshot(input)).toEqual(expected);
  });

  it('conserve uniquement la projection minimale autoritaire', () => {
    expect(deriveAgentMissionRecoverySnapshot({
      authenticated: true,
      pending: false,
      fetching: false,
      failed: false,
      data: RESUMABLE,
    })).toEqual({ phase: 'resumable', value: RESUMABLE });
  });

  it('compare toutes les fences mission et brouillon', () => {
    expect(sameRecoveredMission(RESUMABLE, {
      id: RESUMABLE.mission.id,
      revision: RESUMABLE.mission.revision,
      draft: RESUMABLE.mission.draft,
    })).toBe(true);
    expect(sameRecoveredMission(RESUMABLE, {
      id: RESUMABLE.mission.id,
      revision: RESUMABLE.mission.revision + 1,
      draft: RESUMABLE.mission.draft,
    })).toBe(false);
    expect(sameRecoveredMission(RESUMABLE, {
      id: RESUMABLE.mission.id,
      revision: RESUMABLE.mission.revision,
      draft: {
        ...RESUMABLE.mission.draft,
        contentRevision: RESUMABLE.mission.draft.contentRevision + 1,
      },
    })).toBe(false);
  });
});
