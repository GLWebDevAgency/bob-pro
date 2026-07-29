import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_QUOTE_LINE_MAX_QUANTITY_MILLI,
  AGENT_MISSION_QUOTE_LINE_MAX_SERVICE_REFERENCE_LENGTH,
  parseAgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWork,
} from './quote-line-work';

const ID = '11111111-1111-4111-8111-111111111111';
const MISSION_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const DIFF_HASH = 'a'.repeat(64);

function queued(
  patch: Partial<AgentMissionQuoteLineWork> = {},
): AgentMissionQuoteLineWork {
  return {
    id: ID,
    companyId: 'company-1',
    ownerUserId: 'owner-1',
    missionId: MISSION_ID,
    ordinal: 1,
    revision: 1,
    state: 'queued',
    origin: 'user_voice',
    serviceReference: 'Main-d’œuvre plomberie',
    category: 'labor',
    quantityMilli: 2_000,
    unit: 'heure',
    unitPriceCents: 5_500,
    requestedVatRate: 20,
    priceBasis: 'per_unit',
    housingOlderThan2y: null,
    energyRenovation: null,
    requiredFact: null,
    catalogueResolution: 'pending',
    catalogueItemId: null,
    expectedCatalogueRevision: null,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    createdAt: '2026-07-29T12:00:00.000Z',
    updatedAt: '2026-07-29T12:00:00.000Z',
    ...patch,
  };
}

describe('parseAgentMissionQuoteLineWork', () => {
  it.each([
    queued(),
    queued({
      state: 'awaiting_catalogue_choice',
    }),
    queued({
      state: 'awaiting_details',
      requiredFact: 'vat_rate',
      catalogueResolution: 'free',
    }),
    queued({
      state: 'awaiting_confirmation',
      catalogueResolution: 'selected',
      catalogueItemId: 'catalogue-1',
      expectedCatalogueRevision: 2,
      proposalId: PROPOSAL_ID,
      proposalRevision: 1,
      proposalDiffHash: DIFF_HASH,
    }),
  ])('accepte un état cohérent et fermé', (value) => {
    expect(parseAgentMissionQuoteLineWork(value)).toEqual({
      ok: true,
      value,
    });
  });

  it('accepte une ligne queued entièrement incomplète sans sentinelle vide', () => {
    const value = queued({
      serviceReference: null,
      category: null,
      quantityMilli: null,
      unit: null,
      unitPriceCents: null,
      requestedVatRate: null,
      priceBasis: null,
    });

    expect(parseAgentMissionQuoteLineWork(value)).toEqual({
      ok: true,
      value,
    });
  });

  it.each([
    ['id', 'not-a-uuid', 'invalid_uuid'],
    ['companyId', ' company-1', 'invalid_identifier'],
    ['missionId', 'not-a-uuid', 'invalid_uuid'],
    ['ordinal', 0, 'invalid_value'],
    ['ordinal', 21, 'invalid_value'],
    ['revision', 0, 'invalid_revision'],
    ['state', 'done', 'invalid_value'],
    ['origin', 'model', 'invalid_value'],
    ['serviceReference', '', 'invalid_value'],
    ['serviceReference', `A\nB`, 'invalid_value'],
    [
      'serviceReference',
      'x'.repeat(AGENT_MISSION_QUOTE_LINE_MAX_SERVICE_REFERENCE_LENGTH + 1),
      'invalid_value',
    ],
    ['category', 'disbursement', 'invalid_value'],
    ['quantityMilli', 0, 'invalid_value'],
    [
      'quantityMilli',
      AGENT_MISSION_QUOTE_LINE_MAX_QUANTITY_MILLI + 1,
      'invalid_value',
    ],
    ['unit', ' heure', 'invalid_value'],
    ['unitPriceCents', 0, 'invalid_value'],
    ['requestedVatRate', 7, 'invalid_value'],
    ['priceBasis', 'guess', 'invalid_value'],
    ['housingOlderThan2y', 'yes', 'invalid_value'],
    ['requiredFact', 'customer', 'invalid_value'],
    ['catalogueResolution', 'unknown', 'invalid_value'],
    ['catalogueItemId', 'catalogue/1', 'invalid_identifier'],
    ['expectedCatalogueRevision', 0, 'invalid_revision'],
    ['proposalId', 'not-a-uuid', 'invalid_uuid'],
    ['proposalRevision', 2, 'invalid_revision'],
    ['proposalDiffHash', 'ABC', 'invalid_value'],
    ['createdAt', '2026-07-29', 'invalid_instant'],
  ])(
    'rejette %s hors contrat',
    (field, replacement, reason) => {
      const result = parseAgentMissionQuoteLineWork({
        ...queued(),
        [field]: replacement,
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'invalid_agent_mission_quote_line_work',
          field,
          reason,
        },
      });
    },
  );

  it('rejette toute clé non négociée', () => {
    expect(parseAgentMissionQuoteLineWork({
      ...queued(),
      transcript: 'secret',
    })).toEqual({
      ok: false,
      error: {
        code: 'invalid_agent_mission_quote_line_work',
        field: '$',
        reason: 'invalid_shape',
      },
    });
  });

  it.each([
    [
      'catalogue pending ne porte pas de fence',
      queued({
        catalogueResolution: 'pending',
        catalogueItemId: 'catalogue-1',
        expectedCatalogueRevision: 1,
      }),
    ],
    [
      'le catalogue est une paire atomique',
      queued({
        state: 'awaiting_details',
        requiredFact: 'vat_rate',
        catalogueResolution: 'selected',
        catalogueItemId: 'catalogue-1',
      }),
    ],
    [
      'le prix est une paire atomique',
      queued({
        unitPriceCents: 5_500,
        priceBasis: null,
      }),
    ],
    [
      'la proposition est un triplet atomique',
      queued({
        state: 'awaiting_confirmation',
        catalogueResolution: 'free',
        proposalId: PROPOSAL_ID,
        proposalRevision: 1,
      }),
    ],
    [
      'le choix catalogue exige un libellé',
      queued({
        state: 'awaiting_catalogue_choice',
        serviceReference: null,
      }),
    ],
    [
      'la question exige requiredFact',
      queued({
        state: 'awaiting_details',
      }),
    ],
    [
      'la confirmation exige tous les faits',
      queued({
        state: 'awaiting_confirmation',
        catalogueResolution: 'free',
        unit: null,
        proposalId: PROPOSAL_ID,
        proposalRevision: 1,
        proposalDiffHash: DIFF_HASH,
      }),
    ],
  ])('rejette un état incohérent : %s', (_label, value) => {
    const result = parseAgentMissionQuoteLineWork(value);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_agent_mission_quote_line_work',
        reason: 'inconsistent_state',
      },
    });
  });

  it.each([
    queued({ catalogueResolution: 'free' }),
    queued({
      catalogueResolution: 'selected',
      catalogueItemId: 'catalogue-1',
      expectedCatalogueRevision: 3,
    }),
  ])('accepte queued comme frontière système après résolution catalogue', (value) => {
    expect(parseAgentMissionQuoteLineWork(value)).toEqual({ ok: true, value });
  });

  it('interdit une question métier tant que le catalogue reste non résolu', () => {
    expect(parseAgentMissionQuoteLineWork(queued({
      state: 'awaiting_details',
      requiredFact: 'unit_price',
      catalogueResolution: 'pending',
    }))).toMatchObject({
      ok: false,
      error: {
        field: 'state',
        reason: 'inconsistent_state',
      },
    });
    expect(parseAgentMissionQuoteLineWork(queued({
      state: 'awaiting_details',
      serviceReference: null,
      requiredFact: 'service_reference',
      catalogueResolution: 'pending',
    }))).toMatchObject({ ok: true });
  });

  it('rejette une horloge qui régresse', () => {
    expect(parseAgentMissionQuoteLineWork(queued({
      updatedAt: '2026-07-29T11:59:59.999Z',
    }))).toEqual({
      ok: false,
      error: {
        code: 'invalid_agent_mission_quote_line_work',
        field: 'updatedAt',
        reason: 'inconsistent_state',
      },
    });
  });
});
