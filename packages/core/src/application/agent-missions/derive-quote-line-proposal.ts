import {
  MAX_BILLING_AMOUNT_CENTS,
} from '../../domain/billing/shared/line-item';
import { sha256Hex } from '../../shared-kernel/sha256';
import {
  appendResolvedQuoteDraftLine,
} from '../quote-drafts/apply-quote-draft-transition';
import {
  parseQuoteDraftPayload,
  type QuoteDraftPayloadLine,
  type QuoteDraftPayloadLineMetadata,
  type QuoteDraftPayloadV1,
} from '../quote-drafts/quote-draft-slot';
import {
  type CatalogueCandidateRecord,
} from '../ports/catalogue-candidate-search';
import {
  deriveQuoteVatDecisionOptions,
  type QuoteVatDecisionContext,
} from './derive-quote-vat-decision-options';
import {
  type AgentMissionQuoteLineRequiredFact,
  type AgentMissionQuoteLineWork,
  type ResolvedAgentMissionQuoteLineFacts,
} from './quote-line-work';

export type QuoteLineProposalRejectionReason =
  | 'catalogue_unresolved'
  | 'catalogue_stale'
  | 'vat_context_mismatch'
  | 'mixed_vat_rate'
  | 'invalid_existing_vat_decision'
  | 'unsupported_vat_rate'
  | 'ineligible_reduced_rate'
  | 'inexact_total_price'
  | 'amount_out_of_bounds'
  | 'invalid_draft';

export interface ResolvedQuoteLineProposal {
  readonly facts: ResolvedAgentMissionQuoteLineFacts;
  readonly line: QuoteDraftPayloadLine;
  readonly metadata: QuoteDraftPayloadLineMetadata;
  readonly vatDecision: NonNullable<QuoteDraftPayloadV1['draft']['vatDecision']>;
  readonly diffHash: string;
}

export type QuoteLineProposalDerivation =
  | {
      readonly kind: 'required_fact';
      readonly requiredFact: AgentMissionQuoteLineRequiredFact;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: QuoteLineProposalRejectionReason;
    }
  | {
      readonly kind: 'resolved';
      readonly proposal: ResolvedQuoteLineProposal;
    };

function required(
  requiredFact: AgentMissionQuoteLineRequiredFact,
): QuoteLineProposalDerivation {
  return Object.freeze({ kind: 'required_fact', requiredFact });
}

function rejected(
  reason: QuoteLineProposalRejectionReason,
): QuoteLineProposalDerivation {
  return Object.freeze({ kind: 'rejected', reason });
}

function roundPositiveMilliAmount(
  quantityMilli: number,
  unitPriceCents: number,
): bigint {
  return (
    BigInt(quantityMilli) * BigInt(unitPriceCents) + 500n
  ) / 1_000n;
}

function resolvePerUnitPrice(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly quantityMilli: number;
  readonly selectedCatalogue: CatalogueCandidateRecord | null;
}):
  | { readonly kind: 'required_fact' }
  | { readonly kind: 'rejected'; readonly reason: QuoteLineProposalRejectionReason }
  | { readonly kind: 'resolved'; readonly unitPriceCents: number } {
  const storedPrice = input.workItem.unitPriceCents;
  const basis = input.workItem.priceBasis;
  if (storedPrice === null || basis === null) {
    if (input.selectedCatalogue === null) return { kind: 'required_fact' };
    return {
      kind: 'resolved',
      unitPriceCents: input.selectedCatalogue.unitPriceHT,
    };
  }
  if (basis === 'per_unit') {
    return { kind: 'resolved', unitPriceCents: storedPrice };
  }
  const numerator = BigInt(storedPrice) * 1_000n;
  const denominator = BigInt(input.quantityMilli);
  if (numerator % denominator !== 0n) {
    return { kind: 'rejected', reason: 'inexact_total_price' };
  }
  const perUnit = numerator / denominator;
  if (perUnit < 1n || perUnit > BigInt(MAX_BILLING_AMOUNT_CENTS)) {
    return { kind: 'rejected', reason: 'amount_out_of_bounds' };
  }
  return { kind: 'resolved', unitPriceCents: Number(perUnit) };
}

export function computeQuoteDraftAppendLineDiffHash(input: {
  readonly payload: QuoteDraftPayloadV1;
  readonly line: QuoteDraftPayloadLine;
  readonly metadata: QuoteDraftPayloadLineMetadata;
  readonly vatDecision: NonNullable<QuoteDraftPayloadV1['draft']['vatDecision']>;
}): string {
  return sha256Hex(JSON.stringify([
    'bob.quote-draft.append-line-diff.v1',
    [
      input.payload.draft.sessionId,
      input.payload.draft.contentRevision,
      input.payload.draft.lines.length,
    ],
    [
      input.line.label,
      input.line.category,
      Math.round(input.line.qty * 1_000),
      input.line.unit ?? null,
      input.line.unitPriceHT,
      input.line.vatRate,
    ],
    [
      input.metadata.id,
      input.metadata.interaction,
      input.metadata.catalogue === undefined
        ? null
        : [
            input.metadata.catalogue.id,
            input.metadata.catalogue.source,
            input.metadata.catalogue.indicative,
          ],
    ],
    [
      input.vatDecision.rate,
      input.vatDecision.housingOlderThan2y ?? null,
      input.vatDecision.energyRenovation ?? null,
    ],
  ]));
}

/**
 * Fusion déterministe des faits utilisateur, du catalogue réel, du contexte fiscal et du
 * brouillon relu. Le LLM ne calcule ni prix unitaire, ni TVA, ni total.
 */
export function deriveQuoteLineProposal(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly payload: QuoteDraftPayloadV1;
  readonly selectedCatalogue: CatalogueCandidateRecord | null;
  readonly vatContext: QuoteVatDecisionContext;
}): QuoteLineProposalDerivation {
  const parsedPayload = parseQuoteDraftPayload(input.payload);
  if (!parsedPayload.ok) return rejected('invalid_draft');
  const draft = parsedPayload.value.draft;
  if (
    draft.step !== 'lignes'
    || draft.customer === null
  ) {
    return rejected('invalid_draft');
  }
  if (draft.customer.id !== input.vatContext.customerId) {
    return rejected('vat_context_mismatch');
  }

  if (input.workItem.catalogueResolution === 'pending') {
    return input.workItem.serviceReference === null
      ? required('service_reference')
      : rejected('catalogue_unresolved');
  }
  if (
    input.workItem.catalogueResolution === 'selected'
    && (
      input.selectedCatalogue === null
      || input.selectedCatalogue.id !== input.workItem.catalogueItemId
      || input.selectedCatalogue.revision
        !== input.workItem.expectedCatalogueRevision
    )
  ) {
    return rejected('catalogue_stale');
  }
  if (
    input.workItem.catalogueResolution === 'free'
    && input.selectedCatalogue !== null
  ) {
    return rejected('catalogue_stale');
  }

  const catalogue = input.selectedCatalogue;
  const serviceReference = catalogue?.label
    ?? input.workItem.serviceReference;
  if (serviceReference === null) return required('service_reference');

  if (
    catalogue !== null
    && input.workItem.category !== null
    && input.workItem.category !== catalogue.category
    && !input.workItem.catalogueCategoryOverrideConfirmed
  ) {
    return required('category');
  }
  const category = input.workItem.category ?? catalogue?.category ?? null;
  if (category === null) return required('category');

  const quantityMilli = input.workItem.quantityMilli;
  if (quantityMilli === null) return required('quantity');

  if (
    catalogue?.unit !== null
    && catalogue?.unit !== undefined
    && input.workItem.unit !== null
    && input.workItem.unit !== catalogue.unit
    && !input.workItem.catalogueUnitOverrideConfirmed
  ) {
    return required('unit');
  }
  const unit = input.workItem.unit ?? catalogue?.unit ?? null;
  if (unit === null) return required('unit');

  const price = resolvePerUnitPrice({
    workItem: input.workItem,
    quantityMilli,
    selectedCatalogue: catalogue,
  });
  if (price.kind === 'required_fact') return required('unit_price');
  if (price.kind === 'rejected') return rejected(price.reason);
  if (
    roundPositiveMilliAmount(quantityMilli, price.unitPriceCents)
      > BigInt(MAX_BILLING_AMOUNT_CENTS)
  ) {
    return rejected('amount_out_of_bounds');
  }

  const existingVat = draft.vatDecision;
  const housingOlderThan2y = input.workItem.housingOlderThan2y
    ?? existingVat?.housingOlderThan2y
    ?? null;
  const energyRenovation = input.workItem.energyRenovation
    ?? existingVat?.energyRenovation
    ?? null;
  const vat = deriveQuoteVatDecisionOptions({
    facts: input.vatContext,
    category,
    requestedRate:
      input.workItem.requestedVatRate
      ?? catalogue?.vatRate
      ?? null,
    housingOlderThan2y,
    energyRenovation,
    existingVatDecision: existingVat,
    existingLineCount: draft.lines.length,
  });
  if (vat.kind === 'required_fact') return required(vat.requiredFact);
  if (vat.kind === 'invalid') {
    const reason = vat.reason === 'mixed_vat_rate'
      ? 'mixed_vat_rate'
      : vat.reason === 'invalid_existing_vat_decision'
        ? 'invalid_existing_vat_decision'
        : vat.reason === 'ineligible_reduced_rate'
          ? 'ineligible_reduced_rate'
          : 'unsupported_vat_rate';
    return rejected(reason);
  }

  const vatDecision: NonNullable<QuoteDraftPayloadV1['draft']['vatDecision']> = {
    rate: vat.rate,
    ...(vat.rate === 10 || vat.rate === 5.5
      ? { housingOlderThan2y: true }
      : {}),
    ...(vat.rate === 5.5 ? { energyRenovation: true } : {}),
  };
  const line: QuoteDraftPayloadLine = {
    label: serviceReference,
    category,
    qty: quantityMilli / 1_000,
    unit,
    unitPriceHT: price.unitPriceCents,
    vatRate: vat.rate,
  };
  const metadata: QuoteDraftPayloadLineMetadata = {
    id: input.workItem.id,
    interaction: input.workItem.origin === 'user_voice' ? 'voice' : 'manual',
    ...(catalogue === null
      ? {}
      : {
          catalogue: {
            id: catalogue.id,
            source: 'perso',
            indicative: false,
          },
        }),
  };
  const appendCheck = appendResolvedQuoteDraftLine({
    payload: parsedPayload.value,
    expectedContentRevision: draft.contentRevision,
    resolvedLine: line,
    metadata,
    vatDecision,
  });
  if (!appendCheck.ok) return rejected('invalid_draft');

  const facts: ResolvedAgentMissionQuoteLineFacts = {
    serviceReference,
    category,
    quantityMilli,
    unit,
    unitPriceCents: price.unitPriceCents,
    requestedVatRate: vat.rate,
    priceBasis: 'per_unit',
    housingOlderThan2y,
    energyRenovation,
  };
  return Object.freeze({
    kind: 'resolved',
    proposal: Object.freeze({
      facts: Object.freeze(facts),
      line: Object.freeze(line),
      metadata: Object.freeze(metadata),
      vatDecision: Object.freeze(vatDecision),
      diffHash: computeQuoteDraftAppendLineDiffHash({
        payload: parsedPayload.value,
        line,
        metadata,
        vatDecision,
      }),
    }),
  });
}
