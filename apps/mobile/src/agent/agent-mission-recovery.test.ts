import { describe, expect, it, vi } from 'vitest';
import {
  computeQuoteMissionCatalogueChoiceSetHash,
  computeQuoteMissionLineConfirmationChoiceSetHash,
  type QuoteAgentMissionPresentationV1,
  type QuoteAgentMissionResumeView,
  type QuoteAgentMissionResumeViewV2,
} from '@bob/core';
import {
  deriveAgentMissionRecoverySnapshot,
  sameRecoveredMission,
  type QuoteAgentMissionRecoveryView,
} from './agent-mission-recovery-state';
import {
  loadQuoteAgentMissionRecovery,
  type QuoteAgentMissionRecoveryClient,
} from './agent-mission-recovery-loader';

const RESUMABLE_V1_RESPONSE = {
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

const RESUMABLE = {
  ...RESUMABLE_V1_RESPONSE,
  protocolVersion: 1,
  presentation: null,
} as const satisfies QuoteAgentMissionRecoveryView;

const RESUMABLE_V2_RESPONSE = {
  ...RESUMABLE_V1_RESPONSE,
  presentation: {
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact: null,
    pendingLine: null,
    decision: null,
    catalogueChoices: [],
    freeLineChoiceId: null,
    proposalStatus: { kind: 'absent' },
    proposal: null,
  },
} as const satisfies QuoteAgentMissionResumeViewV2;

const RESUMABLE_V2 = {
  ...RESUMABLE_V2_RESPONSE,
  protocolVersion: 2,
} as const satisfies QuoteAgentMissionRecoveryView;

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

const QUOTE_LINE_DRAFT = {
  sessionId: 'quote-line-draft-session',
  slotRevision: 7,
  contentRevision: 4,
} as const;

const PENDING_LINE_ID = '60000000-0000-4000-8000-000000000001';
const CATALOGUE_CHOICE_ID = '50000000-0000-4000-8000-000000000010';
const FREE_LINE_CHOICE_ID = '50000000-0000-4000-8000-000000000011';
const PROPOSAL_ID = '70000000-0000-4000-8000-000000000001';

function quoteLinePresentation(
  phase: QuoteLineRecoveryPhase,
  missionId: string,
  missionRevision: number,
): QuoteAgentMissionPresentationV1 {
  const empty = {
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

  if (phase === 'awaiting_lines') return empty;
  if (phase === 'awaiting_catalogue_choice') {
    const choices = [{
      choiceId: CATALOGUE_CHOICE_ID,
      catalogueItemId: 'catalogue-labour-plumbing',
      expectedCatalogueRevision: 3,
    }];
    const hash = computeQuoteMissionCatalogueChoiceSetHash({
      missionId,
      choiceSetRevision: missionRevision,
      decisionId: '40000000-0000-4000-8000-000000000010',
      pendingLineId: PENDING_LINE_ID,
      expectedDraft: QUOTE_LINE_DRAFT,
      expectedWorkRevision: 2,
      candidates: choices,
      freeLineChoiceId: FREE_LINE_CHOICE_ID,
    });
    if (!hash.ok) throw new Error('Fixture de reprise catalogue invalide');
    return {
      ...empty,
      pendingLine: {
        pendingLineId: PENDING_LINE_ID,
        expectedWorkRevision: 2,
      },
      decision: {
        kind: 'catalogue',
        decisionId: '40000000-0000-4000-8000-000000000010',
        choiceSetRevision: missionRevision,
        pendingLineId: PENDING_LINE_ID,
        expectedDraft: QUOTE_LINE_DRAFT,
        expectedWorkRevision: 2,
        choices,
        freeLineChoiceId: FREE_LINE_CHOICE_ID,
        choiceSetHash: hash.value,
      },
      catalogueChoices: [{
        choiceId: CATALOGUE_CHOICE_ID,
        available: true,
        label: 'Heure de main-d’œuvre plomberie',
        category: 'labor',
        unit: 'heure',
        unitPriceCents: 5_500,
        vatRate: 20,
      }],
      freeLineChoiceId: FREE_LINE_CHOICE_ID,
    };
  }
  if (phase === 'awaiting_line_details') {
    return {
      ...empty,
      requiredFact: 'unit_price',
      pendingLine: {
        pendingLineId: PENDING_LINE_ID,
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
    pendingLineId: PENDING_LINE_ID,
    proposalId: PROPOSAL_ID,
    proposalRevision: 1,
    expectedDraft: QUOTE_LINE_DRAFT,
    expectedWorkRevision: 2,
    expectedCatalogue: {
      itemId: 'catalogue-labour-plumbing',
      revision: 3,
    },
    expectedVatContextDigest: 'd'.repeat(64),
    diffHash: 'f'.repeat(64),
    choices,
  });
  if (!hash.ok) throw new Error('Fixture de reprise proposition invalide');
  return {
    ...empty,
    pendingLine: {
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 2,
    },
    decision: {
      kind: 'line_confirmation',
      decisionId: '40000000-0000-4000-8000-000000000020',
      choiceSetRevision: missionRevision,
      pendingLineId: PENDING_LINE_ID,
      proposalId: PROPOSAL_ID,
      proposalRevision: 1,
      expectedDraft: QUOTE_LINE_DRAFT,
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
      proposalId: PROPOSAL_ID,
      diffHash: 'f'.repeat(64),
      diff: {
        kind: 'append_line',
        before: {
          contentRevision: QUOTE_LINE_DRAFT.contentRevision,
          lineCount: 0,
          totalHtCents: 0,
        },
        after: {
          contentRevision: QUOTE_LINE_DRAFT.contentRevision + 1,
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

function quoteLineResumeV2(
  phase: QuoteLineRecoveryPhase,
): Exclude<QuoteAgentMissionResumeViewV2, { readonly mission: null }> {
  const phaseOrdinal = QUOTE_LINE_RECOVERY_PHASES.indexOf(phase);
  const missionId = `20000000-0000-4000-8000-00000000000${phaseOrdinal + 2}`;
  const missionRevision = 10 + phaseOrdinal;
  return {
    mission: {
      id: missionId,
      status: 'active',
      phase,
      revision: missionRevision,
      actionable: true,
      draft: QUOTE_LINE_DRAFT,
      idleExpiresAt: '2026-07-30T16:10:00.000Z',
      hardExpiresAt: '2026-07-30T17:00:00.000Z',
    },
    draft: {
      ...QUOTE_LINE_DRAFT,
      step: 'lignes',
    },
    customerChoices: [],
    presentation: quoteLinePresentation(phase, missionId, missionRevision),
  };
}

const ABSENT = {
  protocolVersion: null,
  mission: null,
  presentation: null,
} as const satisfies QuoteAgentMissionRecoveryView;

describe('AgentMissionRecovery — preuve froide fail-closed', () => {
  it('n’autorise le manuel qu’après une réponse serveur explicitement vide', () => {
    expect(deriveAgentMissionRecoverySnapshot({
      authenticated: true,
      pending: false,
      fetching: false,
      failed: false,
      data: ABSENT,
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
        data: ABSENT,
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

describe('loadQuoteAgentMissionRecovery — négociation V2 puis V1 exacte', () => {
  function client(
    v2: QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResumeV2'],
    v1: QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResume'],
  ): QuoteAgentMissionRecoveryClient {
    return {
      getCurrentQuoteAgentMissionResumeV2: v2,
      getCurrentQuoteAgentMissionResume: v1,
    };
  }

  it('normalise un succès V2 absent sans interroger V1', async () => {
    const getV1 = vi.fn<
      QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResume']
    >();
    const value = await loadQuoteAgentMissionRecovery(client(
      vi.fn(async () => ({
        ok: true as const,
        value: { mission: null, presentation: null },
      })),
      getV1,
    ));

    expect(value).toEqual(ABSENT);
    expect(getV1).not.toHaveBeenCalled();
  });

  it('conserve exactement mission, brouillon, choix et présentation V2 sans interroger V1', async () => {
    const getV1 = vi.fn<
      QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResume']
    >();
    const signal = new AbortController().signal;
    const getV2 = vi.fn<
      QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResumeV2']
    >(async () => ({ ok: true as const, value: RESUMABLE_V2_RESPONSE }));

    const value = await loadQuoteAgentMissionRecovery(
      client(getV2, getV1),
      signal,
    );

    expect(value).toEqual(RESUMABLE_V2);
    if (value.mission === null) throw new Error('Mission V2 attendue');
    expect(value.mission).toBe(RESUMABLE_V2_RESPONSE.mission);
    expect(value.draft).toBe(RESUMABLE_V2_RESPONSE.draft);
    expect(value.customerChoices).toBe(RESUMABLE_V2_RESPONSE.customerChoices);
    expect(value.presentation).toBe(RESUMABLE_V2_RESPONSE.presentation);
    expect(getV2).toHaveBeenCalledWith(signal);
    expect(getV1).not.toHaveBeenCalled();
  });

  it.each(QUOTE_LINE_RECOVERY_PHASES)(
    'conserve à froid la phase A2 %s et sa présentation sans mutation ni downgrade',
    async (phase) => {
      const response = quoteLineResumeV2(phase);
      const getV1 = vi.fn<
        QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResume']
      >();
      const getV2 = vi.fn<
        QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResumeV2']
      >(async () => ({ ok: true as const, value: response }));

      const value = await loadQuoteAgentMissionRecovery(client(getV2, getV1));

      expect(value).toEqual({ ...response, protocolVersion: 2 });
      if (value.mission === null) throw new Error('Mission A2 attendue');
      expect(value.mission).toBe(response.mission);
      expect(value.draft).toBe(response.draft);
      expect(value.presentation).toBe(response.presentation);
      expect(value.presentation).toEqual(quoteLinePresentation(
        phase,
        response.mission.id,
        response.mission.revision,
      ));
      expect(getV2).toHaveBeenCalledOnce();
      expect(getV1).not.toHaveBeenCalled();
    },
  );

  it('reprend V1 uniquement après le conflit upgrade_required exact', async () => {
    const getV1 = vi.fn<
      QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResume']
    >(async () => ({ ok: true as const, value: RESUMABLE_V1_RESPONSE }));
    const signal = new AbortController().signal;
    const value = await loadQuoteAgentMissionRecovery(client(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'conflict' as const,
          entity: 'agent_mission_protocol',
          reason: 'upgrade_required',
        },
      })),
      getV1,
    ), signal);

    expect(value).toEqual(RESUMABLE);
    expect(getV1).toHaveBeenCalledOnce();
    expect(getV1).toHaveBeenCalledWith(signal);
  });

  it.each([
    {
      label: 'un autre conflit',
      error: {
        kind: 'conflict' as const,
        entity: 'agent_mission_protocol',
        reason: 'stale_revision',
      },
    },
    {
      label: 'une panne',
      error: {
        kind: 'unavailable' as const,
        service: 'agent_mission_resume',
      },
    },
  ])('échoue fermé sur $label sans appeler V1', async ({ error }) => {
    const getV1 = vi.fn<
      QuoteAgentMissionRecoveryClient['getCurrentQuoteAgentMissionResume']
    >();
    await expect(loadQuoteAgentMissionRecovery(client(
      vi.fn(async () => ({ ok: false as const, error })),
      getV1,
    ))).rejects.toEqual(error);
    expect(getV1).not.toHaveBeenCalled();
  });

  it('propage une panne du GET V1 après un upgrade_required', async () => {
    const error = {
      kind: 'dependency' as const,
      port: 'api',
      cause: 'offline',
    };
    await expect(loadQuoteAgentMissionRecovery(client(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'conflict' as const,
          entity: 'agent_mission_protocol',
          reason: 'upgrade_required',
        },
      })),
      vi.fn(async () => ({ ok: false as const, error })),
    ))).rejects.toEqual(error);
  });
});
