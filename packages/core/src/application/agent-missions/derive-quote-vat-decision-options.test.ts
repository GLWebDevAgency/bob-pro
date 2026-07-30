import { describe, expect, it } from 'vitest';
import {
  deriveQuoteVatDecisionOptions,
  type QuoteVatDecisionContext,
} from './derive-quote-vat-decision-options';

const standard: QuoteVatDecisionContext = {
  customerId: 'customer-1',
  companyVatRegime: 'reel_simpl',
  companyTrade: 'plombier',
  customerType: 'b2c',
  customerIsSubcontractingBtp: false,
};

function derive(
  input: Omit<
    Parameters<typeof deriveQuoteVatDecisionOptions>[0],
    'existingVatDecision' | 'existingLineCount'
  > & Partial<Pick<
    Parameters<typeof deriveQuoteVatDecisionOptions>[0],
    'existingVatDecision' | 'existingLineCount'
  >>,
) {
  return deriveQuoteVatDecisionOptions({
    ...input,
    existingVatDecision: input.existingVatDecision ?? null,
    existingLineCount: input.existingLineCount ?? 0,
  });
}

describe('deriveQuoteVatDecisionOptions', () => {
  it('impose zéro en franchise sans reprendre le taux suggéré', () => {
    expect(derive({
      facts: { ...standard, companyVatRegime: 'franchise' },
      category: 'supply',
      requestedRate: 20,
      housingOlderThan2y: null,
      energyRenovation: null,
    })).toEqual({
      kind: 'resolved',
      rate: 0,
      forcedBy: 'franchise_293B',
    });
  });

  it('impose zéro pour la sous-traitance BTP B2B', () => {
    expect(derive({
      facts: {
        ...standard,
        customerType: 'b2b',
        customerIsSubcontractingBtp: true,
      },
      category: 'labor',
      requestedRate: null,
      housingOlderThan2y: null,
      energyRenovation: null,
    })).toEqual({
      kind: 'resolved',
      rate: 0,
      forcedBy: 'autoliquidation',
    });
  });

  it('ne fabrique jamais 20 % quand aucun taux n’est connu', () => {
    expect(derive({
      facts: standard,
      category: 'labor',
      requestedRate: null,
      housingOlderThan2y: null,
      energyRenovation: null,
    })).toEqual({
      kind: 'required_fact',
      requiredFact: 'vat_rate',
    });
  });

  it('demande les faits travaux dans leur ordre déterministe', () => {
    expect(derive({
      facts: standard,
      category: 'labor',
      requestedRate: 5.5,
      housingOlderThan2y: null,
      energyRenovation: null,
    })).toEqual({
      kind: 'required_fact',
      requiredFact: 'housing_older_than_2y',
    });
    expect(derive({
      facts: standard,
      category: 'labor',
      requestedRate: 5.5,
      housingOlderThan2y: true,
      energyRenovation: null,
    })).toEqual({
      kind: 'required_fact',
      requiredFact: 'energy_renovation',
    });
  });

  it('valide 2,1 % et refuse un taux réduit déclaré inéligible', () => {
    expect(derive({
      facts: standard,
      category: 'supply',
      requestedRate: 2.1,
      housingOlderThan2y: null,
      energyRenovation: null,
    })).toEqual({
      kind: 'resolved',
      rate: 2.1,
      forcedBy: null,
    });
    expect(derive({
      facts: standard,
      category: 'labor',
      requestedRate: 10,
      housingOlderThan2y: false,
      energyRenovation: null,
    })).toEqual({
      kind: 'invalid',
      reason: 'ineligible_reduced_rate',
    });
  });

  it('impose le taux du brouillon existant et refuse la TVA mixte', () => {
    expect(derive({
      facts: standard,
      category: 'labor',
      requestedRate: null,
      housingOlderThan2y: null,
      energyRenovation: null,
      existingLineCount: 1,
      existingVatDecision: { rate: 20 },
    })).toEqual({
      kind: 'resolved',
      rate: 20,
      forcedBy: null,
    });
    expect(derive({
      facts: standard,
      category: 'labor',
      requestedRate: 10,
      housingOlderThan2y: true,
      energyRenovation: null,
      existingLineCount: 1,
      existingVatDecision: { rate: 20 },
    })).toEqual({
      kind: 'invalid',
      reason: 'mixed_vat_rate',
    });
  });

  it('refuse un brouillon qui possède des lignes sans décision TVA', () => {
    expect(derive({
      facts: standard,
      category: 'labor',
      requestedRate: 20,
      housingOlderThan2y: null,
      energyRenovation: null,
      existingLineCount: 1,
      existingVatDecision: null,
    })).toEqual({
      kind: 'invalid',
      reason: 'invalid_existing_vat_decision',
    });
  });
});
