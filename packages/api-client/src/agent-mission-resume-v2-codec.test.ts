import {
  computeQuoteMissionCatalogueChoiceSetHash,
  computeQuoteMissionLineConfirmationChoiceSetHash,
  type LineConfirmationDecisionV1,
} from '@bob/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeQuoteAgentMissionResume,
  decodeQuoteAgentMissionResumeV2,
} from './agent-mission-codec';
import { HttpBobClient } from './http-client';
import { LocalBobClient } from './local-client';

const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const WORK_ID = '22222222-2222-4222-8222-222222222222';
const DECISION_ID = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const CONFIRM_CHOICE_ID = '55555555-5555-4555-8555-555555555551';
const EDIT_CHOICE_ID = '55555555-5555-4555-8555-555555555552';
const CANCEL_CHOICE_ID = '55555555-5555-4555-8555-555555555553';
const CATALOGUE_CHOICE_ONE = '66666666-6666-4666-8666-666666666661';
const CATALOGUE_CHOICE_TWO = '66666666-6666-4666-8666-666666666662';
const FREE_CHOICE_ID = '66666666-6666-4666-8666-666666666663';
const DRAFT = Object.freeze({
  sessionId: 'quote-draft-session-1',
  slotRevision: 3,
  contentRevision: 2,
});

function mission(phase: 'awaiting_catalogue_choice' | 'awaiting_line_confirmation') {
  return {
    id: MISSION_ID,
    status: 'active',
    phase,
    revision: 9,
    actionable: true,
    draft: DRAFT,
    idleExpiresAt: '2026-07-31T08:00:00.000Z',
    hardExpiresAt: '2026-08-06T08:00:00.000Z',
  };
}

function lineConfirmationDecision(): LineConfirmationDecisionV1 {
  const choices = Object.freeze([
    Object.freeze({
      choiceId: CONFIRM_CHOICE_ID,
      action: 'confirm_line' as const,
    }),
    Object.freeze({
      choiceId: EDIT_CHOICE_ID,
      action: 'edit_line' as const,
    }),
    Object.freeze({
      choiceId: CANCEL_CHOICE_ID,
      action: 'cancel_line' as const,
    }),
  ]) satisfies LineConfirmationDecisionV1['choices'];
  const input = {
    missionId: MISSION_ID,
    choiceSetRevision: 9,
    decisionId: DECISION_ID,
    pendingLineId: WORK_ID,
    proposalId: PROPOSAL_ID,
    proposalRevision: 1 as const,
    expectedDraft: DRAFT,
    expectedWorkRevision: 4,
    expectedCatalogue: null,
    expectedVatContextDigest: 'a'.repeat(64),
    diffHash: 'b'.repeat(64),
    choices,
  };
  const hash = computeQuoteMissionLineConfirmationChoiceSetHash(input);
  if (!hash.ok) throw new Error('fixture line confirmation invalide');
  return Object.freeze({
    kind: 'line_confirmation',
    decisionId: input.decisionId,
    choiceSetRevision: input.choiceSetRevision,
    pendingLineId: input.pendingLineId,
    proposalId: input.proposalId,
    proposalRevision: input.proposalRevision,
    expectedDraft: input.expectedDraft,
    expectedWorkRevision: input.expectedWorkRevision,
    expectedCatalogue: input.expectedCatalogue,
    expectedVatContextDigest: input.expectedVatContextDigest,
    diffHash: input.diffHash,
    choices,
    choiceSetHash: hash.value,
  });
}

function lineConfirmationWire() {
  const decision = lineConfirmationDecision();
  return {
    mission: mission('awaiting_line_confirmation'),
    draft: {
      ...DRAFT,
      step: 'lignes',
    },
    customerChoices: [],
    presentation: {
      schema: 'bob.agent-mission.quote-presentation',
      version: 1,
      requiredFact: null,
      pendingLine: {
        pendingLineId: WORK_ID,
        expectedWorkRevision: 4,
      },
      decision,
      catalogueChoices: [],
      freeLineChoiceId: null,
      proposalStatus: { kind: 'available' },
      proposal: {
        proposalId: PROPOSAL_ID,
        diffHash: 'b'.repeat(64),
        line: {
          label: 'Main-d’œuvre plomberie',
          category: 'labor',
          qty: 2,
          unitPriceHT: 5_500,
          vatRate: 20,
          unit: 'heure',
        },
        catalogue: null,
      },
    },
  };
}

function catalogueWire() {
  const choices = [
    {
      choiceId: CATALOGUE_CHOICE_ONE,
      catalogueItemId: 'catalogue-main-oeuvre',
      expectedCatalogueRevision: 7,
    },
    {
      choiceId: CATALOGUE_CHOICE_TWO,
      catalogueItemId: 'catalogue-deplacement',
      expectedCatalogueRevision: 3,
    },
  ];
  const hash = computeQuoteMissionCatalogueChoiceSetHash({
    missionId: MISSION_ID,
    choiceSetRevision: 9,
    decisionId: DECISION_ID,
    pendingLineId: WORK_ID,
    expectedDraft: DRAFT,
    expectedWorkRevision: 2,
    candidates: choices,
    freeLineChoiceId: FREE_CHOICE_ID,
  });
  if (!hash.ok) throw new Error('fixture catalogue invalide');
  return {
    mission: mission('awaiting_catalogue_choice'),
    draft: {
      ...DRAFT,
      step: 'lignes',
    },
    customerChoices: [],
    presentation: {
      schema: 'bob.agent-mission.quote-presentation',
      version: 1,
      requiredFact: null,
      pendingLine: {
        pendingLineId: WORK_ID,
        expectedWorkRevision: 2,
      },
      decision: {
        kind: 'catalogue',
        decisionId: DECISION_ID,
        choiceSetRevision: 9,
        pendingLineId: WORK_ID,
        expectedDraft: DRAFT,
        expectedWorkRevision: 2,
        choices,
        freeLineChoiceId: FREE_CHOICE_ID,
        choiceSetHash: hash.value,
      },
      catalogueChoices: [
        {
          choiceId: CATALOGUE_CHOICE_ONE,
          available: true,
          label: 'Heure de main-d’œuvre plomberie',
          category: 'labor',
          unit: 'heure',
          unitPriceCents: 5_500,
          vatRate: 2.1,
        },
        {
          choiceId: CATALOGUE_CHOICE_TWO,
          available: false,
          label: null,
          category: null,
          unit: null,
          unitPriceCents: null,
          vatRate: null,
        },
      ],
      freeLineChoiceId: FREE_CHOICE_ID,
      proposalStatus: { kind: 'absent' },
      proposal: null,
    },
  };
}

describe('QuoteAgentMissionResumeViewV2 codec', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepte la proposition exacte et conserve les fences exécutables', () => {
    const wire = lineConfirmationWire();
    expect(decodeQuoteAgentMissionResumeV2(wire)).toEqual(wire);
    expect(decodeQuoteAgentMissionResumeV2({
      mission: null,
      presentation: null,
    })).toEqual({
      mission: null,
      presentation: null,
    });
  });

  it('accepte les choix catalogue réels dans leur ordre, dont la TVA 2,1 %', () => {
    const wire = catalogueWire();
    expect(decodeQuoteAgentMissionResumeV2(wire)).toEqual(wire);
  });

  it.each([
    [
      'une clé top-level ajoutée',
      () => ({ ...lineConfirmationWire(), tenantId: 'forged' }),
    ],
    [
      'une clé interne ajoutée',
      () => {
        const wire = lineConfirmationWire();
        return {
          ...wire,
          presentation: { ...wire.presentation, internalWork: 'forbidden' },
        };
      },
    ],
    [
      'un hash de décision falsifié',
      () => {
        const wire = lineConfirmationWire();
        return {
          ...wire,
          presentation: {
            ...wire.presentation,
            decision: {
              ...wire.presentation.decision,
              choiceSetHash: 'c'.repeat(64),
            },
          },
        };
      },
    ],
    [
      'des actions réordonnées',
      () => {
        const wire = lineConfirmationWire();
        return {
          ...wire,
          presentation: {
            ...wire.presentation,
            decision: {
              ...wire.presentation.decision,
              choices: [
                wire.presentation.decision.choices[1],
                wire.presentation.decision.choices[0],
                wire.presentation.decision.choices[2],
              ],
            },
          },
        };
      },
    ],
    [
      'une fence de work différente',
      () => {
        const wire = lineConfirmationWire();
        return {
          ...wire,
          presentation: {
            ...wire.presentation,
            pendingLine: {
              ...wire.presentation.pendingLine,
              expectedWorkRevision: 5,
            },
          },
        };
      },
    ],
    [
      'une proposition prétendue stale mais encore exposée',
      () => {
        const wire = lineConfirmationWire();
        return {
          ...wire,
          presentation: {
            ...wire.presentation,
            proposalStatus: {
              kind: 'stale',
              reason: 'vat_context_changed',
            },
          },
        };
      },
    ],
    [
      'une valeur financière invalide',
      () => {
        const wire = lineConfirmationWire();
        return {
          ...wire,
          presentation: {
            ...wire.presentation,
            proposal: {
              ...wire.presentation.proposal,
              line: {
                ...wire.presentation.proposal.line,
                unitPriceHT: -1,
              },
            },
          },
        };
      },
    ],
  ])('refuse %s', (_label, mutate) => {
    expect(decodeQuoteAgentMissionResumeV2(mutate())).toBeNull();
  });

  it('refuse un ordre catalogue différent de la décision scellée', () => {
    const wire = catalogueWire();
    expect(decodeQuoteAgentMissionResumeV2({
      ...wire,
      presentation: {
        ...wire.presentation,
        catalogueChoices: [
          wire.presentation.catalogueChoices[1],
          wire.presentation.catalogueChoices[0],
        ],
      },
    })).toBeNull();
  });

  it('préserve le wire V1 exact et lui interdit les phases M2-A', () => {
    const wire = lineConfirmationWire();
    expect(decodeQuoteAgentMissionResume({
      mission: wire.mission,
      draft: wire.draft,
      customerChoices: [],
    })).toBeNull();
    expect(decodeQuoteAgentMissionResumeV2({
      mission: null,
      presentation: null,
      draft: null,
    })).toBeNull();
  });

  it('négocie le GET V2 par header JWT sans capability ni fallback V1', async () => {
    const wire = lineConfirmationWire();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer supabase-jwt',
        'x-bob-agent-mission-protocol-version': '2',
      });
      expect(init?.headers).not.toHaveProperty('x-bob-agent-mission-capability');
      return new Response(JSON.stringify(wire), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-1',
      getToken: async () => 'supabase-jwt',
    });

    await expect(client.getCurrentQuoteAgentMissionResumeV2()).resolves.toEqual({
      ok: true,
      value: wire,
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ...wire,
      internalState: 'forbidden',
    }), {
      headers: { 'content-type': 'application/json' },
    }));
    await expect(client.getCurrentQuoteAgentMissionResumeV2()).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('reste fail-closed en local au lieu de fabriquer une projection V2', async () => {
    await expect(
      new LocalBobClient().getCurrentQuoteAgentMissionResumeV2(),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'agent_mission_resume_v2_persistence',
      },
    });
  });
});
