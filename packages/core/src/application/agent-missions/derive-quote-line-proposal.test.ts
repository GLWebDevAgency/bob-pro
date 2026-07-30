import { describe, expect, it } from 'vitest';
import {
  applyQuoteDraftCustomerSelection,
} from '../quote-drafts/apply-quote-draft-transition';
import {
  createEmptyQuoteDraftPayload,
  type QuoteDraftPayloadV1,
} from '../quote-drafts/quote-draft-slot';
import {
  computeQuoteDraftAppendLineDiffHash,
  deriveQuoteLineProposal,
} from './derive-quote-line-proposal';
import {
  type AgentMissionQuoteLineWork,
} from './quote-line-work';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const MISSION_ID = '22222222-2222-4222-8222-222222222222';

function payload(): QuoteDraftPayloadV1 {
  const empty = createEmptyQuoteDraftPayload('quote-session-1');
  if (!empty.ok) throw new Error('fixture');
  const selected = applyQuoteDraftCustomerSelection(empty.value, {
    id: 'customer-1',
    name: 'Camping Les Pins',
  });
  if (!selected.ok) throw new Error('fixture');
  return selected.value;
}

function work(
  patch: Partial<AgentMissionQuoteLineWork> = {},
): AgentMissionQuoteLineWork {
  return {
    id: WORK_ID,
    companyId: 'company-1',
    ownerUserId: 'owner-1',
    missionId: MISSION_ID,
    ordinal: 1,
    revision: 1,
    state: 'queued',
    origin: 'user_voice',
    serviceReference: 'Entretien fontaines RATP',
    category: 'labor',
    quantityMilli: 3_000,
    unit: 'machine',
    unitPriceCents: 40_000,
    requestedVatRate: 20,
    priceBasis: 'per_unit',
    housingOlderThan2y: null,
    energyRenovation: null,
    requiredFact: null,
    catalogueResolution: 'free',
    catalogueItemId: null,
    expectedCatalogueRevision: null,
    catalogueCategoryOverrideConfirmed: false,
    catalogueUnitOverrideConfirmed: false,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    createdAt: '2026-07-30T04:00:00.000Z',
    updatedAt: '2026-07-30T04:00:00.000Z',
    ...patch,
  };
}

const vatContext = {
  customerId: 'customer-1',
  companyVatRegime: 'reel_simpl' as const,
  companyTrade: 'plombier' as const,
  customerType: 'b2c' as const,
  customerIsSubcontractingBtp: false,
};

const catalogue = {
  id: 'catalogue-1',
  revision: 7,
  label: 'Entretien de fontaine',
  category: 'labor' as const,
  unit: 'machine',
  unitPriceHT: 55_000,
  vatRate: 20 as const,
};

describe('deriveQuoteLineProposal', () => {
  it('résout la ligne libre canonique sans calcul confié au modèle', () => {
    const result = deriveQuoteLineProposal({
      workItem: work(),
      payload: payload(),
      selectedCatalogue: null,
      vatContext,
    });

    expect(result).toMatchObject({
      kind: 'resolved',
      proposal: {
        facts: {
          serviceReference: 'Entretien fontaines RATP',
          quantityMilli: 3_000,
          unitPriceCents: 40_000,
          priceBasis: 'per_unit',
        },
        line: {
          label: 'Entretien fontaines RATP',
          qty: 3,
          unit: 'machine',
          unitPriceHT: 40_000,
          vatRate: 20,
        },
        metadata: {
          id: WORK_ID,
          interaction: 'voice',
        },
        vatDecision: { rate: 20 },
      },
    });
    if (result.kind !== 'resolved') throw new Error('expected proposal');
    expect(result.proposal.diffHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('utilise les valeurs réelles du catalogue sans écraser quantité et prix utilisateur', () => {
    const result = deriveQuoteLineProposal({
      workItem: work({
        catalogueResolution: 'selected',
        catalogueItemId: catalogue.id,
        expectedCatalogueRevision: catalogue.revision,
        category: null,
        unit: null,
      }),
      payload: payload(),
      selectedCatalogue: catalogue,
      vatContext,
    });

    expect(result).toMatchObject({
      kind: 'resolved',
      proposal: {
        line: {
          label: catalogue.label,
          category: catalogue.category,
          unit: catalogue.unit,
          qty: 3,
          unitPriceHT: 40_000,
        },
        metadata: {
          catalogue: {
            id: catalogue.id,
            source: 'perso',
            indicative: false,
          },
        },
      },
    });
  });

  it('demande explicitement les contradictions catalogue non arbitrées', () => {
    expect(deriveQuoteLineProposal({
      workItem: work({
        catalogueResolution: 'selected',
        catalogueItemId: catalogue.id,
        expectedCatalogueRevision: catalogue.revision,
        category: 'supply',
      }),
      payload: payload(),
      selectedCatalogue: catalogue,
      vatContext,
    })).toEqual({ kind: 'required_fact', requiredFact: 'category' });

    expect(deriveQuoteLineProposal({
      workItem: work({
        catalogueResolution: 'selected',
        catalogueItemId: catalogue.id,
        expectedCatalogueRevision: catalogue.revision,
        category: 'supply',
        catalogueCategoryOverrideConfirmed: true,
      }),
      payload: payload(),
      selectedCatalogue: catalogue,
      vatContext,
    })).toMatchObject({
      kind: 'resolved',
      proposal: { line: { category: 'supply' } },
    });
  });

  it('convertit un total exact avec BigInt et refuse une division inexacte', () => {
    expect(deriveQuoteLineProposal({
      workItem: work({
        unitPriceCents: 120_000,
        priceBasis: 'total',
      }),
      payload: payload(),
      selectedCatalogue: null,
      vatContext,
    })).toMatchObject({
      kind: 'resolved',
      proposal: {
        facts: { unitPriceCents: 40_000, priceBasis: 'per_unit' },
      },
    });

    expect(deriveQuoteLineProposal({
      workItem: work({
        unitPriceCents: 100,
        priceBasis: 'total',
      }),
      payload: payload(),
      selectedCatalogue: null,
      vatContext,
    })).toEqual({ kind: 'rejected', reason: 'inexact_total_price' });
  });

  it('demande le taux au lieu d’inventer 20 %, puis force zéro en franchise', () => {
    expect(deriveQuoteLineProposal({
      workItem: work({ requestedVatRate: null }),
      payload: payload(),
      selectedCatalogue: null,
      vatContext,
    })).toEqual({ kind: 'required_fact', requiredFact: 'vat_rate' });

    expect(deriveQuoteLineProposal({
      workItem: work(),
      payload: payload(),
      selectedCatalogue: null,
      vatContext: { ...vatContext, companyVatRegime: 'franchise' },
    })).toMatchObject({
      kind: 'resolved',
      proposal: {
        line: { vatRate: 0 },
        vatDecision: { rate: 0 },
      },
    });
  });

  it('refuse catalogue périmé et client fiscal d’un autre brouillon', () => {
    expect(deriveQuoteLineProposal({
      workItem: work({
        catalogueResolution: 'selected',
        catalogueItemId: catalogue.id,
        expectedCatalogueRevision: catalogue.revision,
      }),
      payload: payload(),
      selectedCatalogue: { ...catalogue, revision: 8 },
      vatContext,
    })).toEqual({ kind: 'rejected', reason: 'catalogue_stale' });
    expect(deriveQuoteLineProposal({
      workItem: work(),
      payload: payload(),
      selectedCatalogue: null,
      vatContext: { ...vatContext, customerId: 'customer-2' },
    })).toEqual({ kind: 'rejected', reason: 'vat_context_mismatch' });
  });

  it('lie le hash au diff complet et à la fence du brouillon', () => {
    const result = deriveQuoteLineProposal({
      workItem: work(),
      payload: payload(),
      selectedCatalogue: null,
      vatContext,
    });
    if (result.kind !== 'resolved') throw new Error('expected proposal');
    const proposal = result.proposal;
    expect(computeQuoteDraftAppendLineDiffHash({
      payload: payload(),
      line: { ...proposal.line, unitPriceHT: proposal.line.unitPriceHT + 1 },
      metadata: proposal.metadata,
      vatDecision: proposal.vatDecision,
    })).not.toBe(proposal.diffHash);
    expect(computeQuoteDraftAppendLineDiffHash({
      payload: {
        ...payload(),
        draft: { ...payload().draft, contentRevision: 2 },
      },
      line: proposal.line,
      metadata: proposal.metadata,
      vatDecision: proposal.vatDecision,
    })).not.toBe(proposal.diffHash);
  });
});
