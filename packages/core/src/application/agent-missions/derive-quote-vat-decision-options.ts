import {
  type CatalogueCategory,
} from '../catalogue/derive-catalogue';
import {
  type VatRate,
} from '../../domain/billing/shared/vat-rate';
import {
  type QuoteDraftPayloadV1,
} from '../quote-drafts/quote-draft-slot';
import {
  requiresVatAutoliquidation,
  suggestVatRateFromFacts,
  type VatDecisionFacts,
} from '../../domain/services/suggest-vat-rate';
import {
  type AgentMissionQuoteLineRequiredFact,
} from './quote-line-work';

export {
  type QuoteVatDecisionContext,
  type QuoteVatContextPort,
} from '../ports/quote-vat-context';

export type QuoteVatDecisionOptions =
  | {
      readonly kind: 'resolved';
      readonly rate: VatRate;
      readonly forcedBy: 'franchise_293B' | 'autoliquidation' | null;
    }
  | {
      readonly kind: 'required_fact';
      readonly requiredFact: Extract<
        AgentMissionQuoteLineRequiredFact,
        'vat_rate' | 'housing_older_than_2y' | 'energy_renovation'
      >;
    }
  | {
      readonly kind: 'invalid';
      readonly reason:
        | 'unsupported_rate'
        | 'ineligible_reduced_rate'
        | 'mixed_vat_rate'
        | 'invalid_existing_vat_decision';
    };

/**
 * Décision TVA pure et non probabiliste.
 *
 * Le catalogue et le LLM ne fournissent qu'une intention. La franchise et l'autoliquidation
 * imposent 0 ; les taux travaux exigent leurs faits d'éligibilité ; tout le reste repasse par
 * `suggestVatRateFromFacts`, source unique du verdict fiscal historique.
 */
export function deriveQuoteVatDecisionOptions(input: {
  readonly facts: VatDecisionFacts;
  readonly category: CatalogueCategory;
  readonly requestedRate: VatRate | null;
  readonly housingOlderThan2y: boolean | null;
  readonly energyRenovation: boolean | null;
  readonly existingVatDecision: QuoteDraftPayloadV1['draft']['vatDecision'];
  readonly existingLineCount: number;
}): QuoteVatDecisionOptions {
  if (
    !Number.isSafeInteger(input.existingLineCount)
    || input.existingLineCount < 0
    || (
      input.existingLineCount > 0
      && input.existingVatDecision === null
    )
  ) {
    return Object.freeze({
      kind: 'invalid',
      reason: 'invalid_existing_vat_decision',
    });
  }
  const forcedRate = input.facts.companyVatRegime === 'franchise'
    || requiresVatAutoliquidation(input.facts)
    ? 0
    : null;
  if (
    forcedRate !== null
    && input.existingLineCount > 0
    && input.existingVatDecision?.rate !== forcedRate
  ) {
    return Object.freeze({
      kind: 'invalid',
      reason: 'mixed_vat_rate',
    });
  }
  if (input.facts.companyVatRegime === 'franchise') {
    return Object.freeze({
      kind: 'resolved',
      rate: 0,
      forcedBy: 'franchise_293B',
    });
  }
  if (requiresVatAutoliquidation(input.facts)) {
    return Object.freeze({
      kind: 'resolved',
      rate: 0,
      forcedBy: 'autoliquidation',
    });
  }
  if (
    input.existingLineCount > 0
    && input.requestedRate !== null
    && input.requestedRate !== input.existingVatDecision?.rate
  ) {
    return Object.freeze({
      kind: 'invalid',
      reason: 'mixed_vat_rate',
    });
  }
  const requestedRate = input.existingLineCount > 0
    ? input.existingVatDecision?.rate ?? null
    : input.requestedRate ?? input.existingVatDecision?.rate ?? null;
  if (requestedRate === null) {
    return Object.freeze({
      kind: 'required_fact',
      requiredFact: 'vat_rate',
    });
  }
  if (requestedRate === 10) {
    if (input.housingOlderThan2y === null) {
      return Object.freeze({
        kind: 'required_fact',
        requiredFact: 'housing_older_than_2y',
      });
    }
    if (!input.housingOlderThan2y) {
      return Object.freeze({
        kind: 'invalid',
        reason: 'ineligible_reduced_rate',
      });
    }
  }
  if (requestedRate === 5.5) {
    if (input.housingOlderThan2y === null) {
      return Object.freeze({
        kind: 'required_fact',
        requiredFact: 'housing_older_than_2y',
      });
    }
    if (!input.housingOlderThan2y) {
      return Object.freeze({
        kind: 'invalid',
        reason: 'ineligible_reduced_rate',
      });
    }
    if (input.energyRenovation === null) {
      return Object.freeze({
        kind: 'required_fact',
        requiredFact: 'energy_renovation',
      });
    }
    if (!input.energyRenovation) {
      return Object.freeze({
        kind: 'invalid',
        reason: 'ineligible_reduced_rate',
      });
    }
  }
  const validated = suggestVatRateFromFacts({
    facts: input.facts,
    category: input.category,
    requestedRate,
    context: {
      ...(input.housingOlderThan2y === null
        ? {}
        : { housingOlderThan2y: input.housingOlderThan2y }),
      ...(input.energyRenovation === null
        ? {}
        : { energyRenovation: input.energyRenovation }),
    },
  });
  return validated.ok
    ? Object.freeze({
        kind: 'resolved',
        rate: validated.value,
        forcedBy: null,
      })
    : Object.freeze({
        kind: 'invalid',
        reason: 'unsupported_rate',
      });
}
