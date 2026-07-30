import {
  isCatalogueCategory,
  type CatalogueCategory,
} from '../catalogue/derive-catalogue';
import {
  hasBillingControlCharacter,
  MAX_BILLING_AMOUNT_CENTS,
} from '../../domain/billing/shared/line-item';
import type { VatRate } from '../../domain/billing/shared/vat-rate';
import type { Instant } from '../../shared-kernel/time';
import {
  AGENT_MISSION_QUOTE_LINE_MAX_QUANTITY_MILLI,
  AGENT_MISSION_QUOTE_LINE_MAX_SERVICE_REFERENCE_LENGTH,
  AGENT_MISSION_QUOTE_LINE_MAX_UNIT_LENGTH,
  parseAgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWorkOrigin,
  type AgentMissionQuoteLineWork,
} from './quote-line-work';

const CANDIDATE_KEYS = [
  'serviceReference',
  'categoryHint',
  'quantityDecimal',
  'unitReference',
  'unitPriceDecimal',
  'currency',
  'priceBasis',
  'vatRateHint',
] as const;

const PRICE_BASES = ['per_unit', 'total'] as const;
const VAT_RATE_HINTS = ['0', '2.1', '5.5', '10', '20'] as const;

export interface AgentMissionQuoteLineCandidateV1 {
  readonly serviceReference: string | null;
  readonly categoryHint: CatalogueCategory | null;
  readonly quantityDecimal: string | null;
  readonly unitReference: string | null;
  readonly unitPriceDecimal: string | null;
  readonly currency: 'EUR' | null;
  readonly priceBasis: (typeof PRICE_BASES)[number] | null;
  readonly vatRateHint: (typeof VAT_RATE_HINTS)[number] | null;
}

export interface NormalizedAgentMissionQuoteLineCandidateV1 {
  readonly serviceReference: string | null;
  readonly category: CatalogueCategory | null;
  readonly quantityMilli: number | null;
  readonly unit: string | null;
  /**
   * Montant explicitement dit, en centimes. Quand `priceBasis='total'`, M2-A-2 est seul autorisé
   * à le convertir en prix unitaire si la division par la quantité est exacte.
   */
  readonly unitPriceCents: number | null;
  readonly requestedVatRate: VatRate | null;
  readonly priceBasis: (typeof PRICE_BASES)[number] | null;
}

export type AgentMissionQuoteLineCandidateErrorReason =
  | 'invalid_shape'
  | 'invalid_value'
  | 'out_of_bounds';

export interface AgentMissionQuoteLineCandidateError {
  readonly code: 'invalid_agent_mission_quote_line_candidate';
  readonly field: string;
  readonly reason: AgentMissionQuoteLineCandidateErrorReason;
}

export type AgentMissionQuoteLineCandidateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentMissionQuoteLineCandidateError };

function fail<T>(
  field: string,
  reason: AgentMissionQuoteLineCandidateErrorReason,
): AgentMissionQuoteLineCandidateResult<T> {
  return {
    ok: false,
    error: {
      code: 'invalid_agent_mission_quote_line_candidate',
      field,
      reason,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function canonicalSingleLine(
  value: unknown,
  maximumLength: number,
): string | null | undefined {
  if (value === null) return null;
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value !== value.trim()
    || hasBillingControlCharacter(value)
  ) return undefined;
  return value;
}

function decimalToScaledInteger(
  value: unknown,
  fractionDigits: 2 | 3,
  maximum: number,
): number | null {
  if (typeof value !== 'string') return null;
  const pattern = fractionDigits === 2
    ? /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u
    : /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/u;
  if (!pattern.test(value) || value.length > 64) return null;
  const [integer = '', fraction = ''] = value.split('.');
  try {
    const scaled = (
      BigInt(integer) * (10n ** BigInt(fractionDigits))
      + BigInt(fraction.padEnd(fractionDigits, '0'))
    );
    if (scaled < 1n || scaled > BigInt(maximum)) return null;
    return Number(scaled);
  } catch {
    return null;
  }
}

function vatRate(value: (typeof VAT_RATE_HINTS)[number]): VatRate {
  switch (value) {
    case '0': return 0;
    case '2.1': return 2.1;
    case '5.5': return 5.5;
    case '10': return 10;
    case '20': return 20;
  }
}

export function normalizeAgentMissionQuoteLineCandidate(
  input: unknown,
): AgentMissionQuoteLineCandidateResult<NormalizedAgentMissionQuoteLineCandidateV1> {
  if (!isRecord(input) || !exactKeys(input, CANDIDATE_KEYS)) {
    return fail('$', 'invalid_shape');
  }
  const serviceReference = canonicalSingleLine(
    input['serviceReference'],
    AGENT_MISSION_QUOTE_LINE_MAX_SERVICE_REFERENCE_LENGTH,
  );
  if (serviceReference === undefined) return fail('serviceReference', 'invalid_value');
  const unit = canonicalSingleLine(
    input['unitReference'],
    AGENT_MISSION_QUOTE_LINE_MAX_UNIT_LENGTH,
  );
  if (unit === undefined) return fail('unitReference', 'invalid_value');
  if (
    input['categoryHint'] !== null
    && !isCatalogueCategory(input['categoryHint'])
  ) {
    return fail('categoryHint', 'invalid_value');
  }
  const quantityMilli = input['quantityDecimal'] === null
    ? null
    : decimalToScaledInteger(
        input['quantityDecimal'],
        3,
        AGENT_MISSION_QUOTE_LINE_MAX_QUANTITY_MILLI,
      );
  if (input['quantityDecimal'] !== null && quantityMilli === null) {
    return fail('quantityDecimal', 'out_of_bounds');
  }
  const unitPriceCents = input['unitPriceDecimal'] === null
    ? null
    : decimalToScaledInteger(
        input['unitPriceDecimal'],
        2,
        MAX_BILLING_AMOUNT_CENTS,
      );
  if (input['unitPriceDecimal'] !== null && unitPriceCents === null) {
    return fail('unitPriceDecimal', 'out_of_bounds');
  }
  if (
    (unitPriceCents === null) !== (input['currency'] === null)
    || (unitPriceCents === null) !== (input['priceBasis'] === null)
    || (input['currency'] !== null && input['currency'] !== 'EUR')
    || (
      input['priceBasis'] !== null
      && !PRICE_BASES.includes(input['priceBasis'] as (typeof PRICE_BASES)[number])
    )
  ) {
    return fail('price', 'invalid_value');
  }
  if (
    input['vatRateHint'] !== null
    && !VAT_RATE_HINTS.includes(input['vatRateHint'] as (typeof VAT_RATE_HINTS)[number])
  ) {
    return fail('vatRateHint', 'invalid_value');
  }
  return {
    ok: true,
    value: Object.freeze({
      serviceReference,
      category: input['categoryHint'] as CatalogueCategory | null,
      quantityMilli,
      unit,
      unitPriceCents,
      requestedVatRate: input['vatRateHint'] === null
        ? null
        : vatRate(input['vatRateHint'] as (typeof VAT_RATE_HINTS)[number]),
      priceBasis: input['priceBasis'] as (typeof PRICE_BASES)[number] | null,
    }),
  };
}

export function createQueuedAgentMissionQuoteLineWork(input: {
  readonly id: string;
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly missionId: string;
  readonly ordinal: number;
  readonly origin: AgentMissionQuoteLineWorkOrigin;
  readonly candidate: unknown;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineCandidateResult<AgentMissionQuoteLineWork> {
  const normalized = normalizeAgentMissionQuoteLineCandidate(input.candidate);
  if (!normalized.ok) return normalized;
  const workItem = parseAgentMissionQuoteLineWork({
    id: input.id,
    companyId: input.companyId,
    ownerUserId: input.ownerUserId,
    missionId: input.missionId,
    ordinal: input.ordinal,
    revision: 1,
    state: 'queued',
    origin: input.origin,
    serviceReference: normalized.value.serviceReference,
    category: normalized.value.category,
    quantityMilli: normalized.value.quantityMilli,
    unit: normalized.value.unit,
    unitPriceCents: normalized.value.unitPriceCents,
    requestedVatRate: normalized.value.requestedVatRate,
    priceBasis: normalized.value.priceBasis,
    housingOlderThan2y: null,
    energyRenovation: null,
    requiredFact: null,
    catalogueResolution: 'pending',
    catalogueItemId: null,
    expectedCatalogueRevision: null,
    catalogueCategoryOverrideConfirmed: false,
    catalogueUnitOverrideConfirmed: false,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  });
  return workItem.ok
    ? { ok: true, value: workItem.value }
    : {
        ok: false,
        error: {
          code: 'invalid_agent_mission_quote_line_candidate',
          field: workItem.error.field,
          reason: workItem.error.reason === 'invalid_shape'
            ? 'invalid_shape'
            : 'invalid_value',
        },
      };
}
