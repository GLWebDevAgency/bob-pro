import {
  type CatalogueCategory,
} from '../catalogue/derive-catalogue';
import {
  type VatRate,
} from '../../domain/billing/shared/vat-rate';
import {
  normalizeAgentMissionQuoteLineCandidate,
} from './quote-line-candidate';

export type AgentMissionQuoteLinePatchV1 =
  | { readonly field: 'service_reference'; readonly value: string }
  | { readonly field: 'category'; readonly value: CatalogueCategory }
  | { readonly field: 'quantity'; readonly decimal: string }
  | { readonly field: 'unit'; readonly value: string }
  | {
      readonly field: 'unit_price';
      readonly decimal: string;
      readonly currency: 'EUR';
      readonly basis: 'per_unit' | 'total';
    }
  | { readonly field: 'vat_rate'; readonly value: '0' | '2.1' | '5.5' | '10' | '20' }
  | { readonly field: 'housing_older_than_2y'; readonly value: boolean }
  | { readonly field: 'energy_renovation'; readonly value: boolean };

export type NormalizedAgentMissionQuoteLinePatch =
  | { readonly field: 'service_reference'; readonly value: string }
  | { readonly field: 'category'; readonly value: CatalogueCategory }
  | { readonly field: 'quantity'; readonly quantityMilli: number }
  | { readonly field: 'unit'; readonly value: string }
  | {
      readonly field: 'unit_price';
      readonly unitPriceCents: number;
      readonly basis: 'per_unit' | 'total';
    }
  | { readonly field: 'vat_rate'; readonly value: VatRate }
  | { readonly field: 'housing_older_than_2y'; readonly value: boolean }
  | { readonly field: 'energy_renovation'; readonly value: boolean };

export type AgentMissionQuoteLinePatchResult =
  | { readonly ok: true; readonly value: NormalizedAgentMissionQuoteLinePatch }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'invalid_agent_mission_quote_line_patch';
        readonly field: string;
        readonly reason: 'invalid_shape' | 'invalid_value' | 'out_of_bounds';
      };
    };

const PATCH_KEYS: Readonly<Record<AgentMissionQuoteLinePatchV1['field'], readonly string[]>> = {
  service_reference: ['field', 'value'],
  category: ['field', 'value'],
  quantity: ['field', 'decimal'],
  unit: ['field', 'value'],
  unit_price: ['field', 'decimal', 'currency', 'basis'],
  vat_rate: ['field', 'value'],
  housing_older_than_2y: ['field', 'value'],
  energy_renovation: ['field', 'value'],
};

function fail(
  field: string,
  reason: 'invalid_shape' | 'invalid_value' | 'out_of_bounds',
): AgentMissionQuoteLinePatchResult {
  return {
    ok: false,
    error: {
      code: 'invalid_agent_mission_quote_line_patch',
      field,
      reason,
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function singleFieldCandidate(
  field: AgentMissionQuoteLinePatchV1['field'],
  value: Record<string, unknown>,
) {
  return {
    serviceReference: field === 'service_reference' ? value['value'] : null,
    categoryHint: field === 'category' ? value['value'] : null,
    quantityDecimal: field === 'quantity' ? value['decimal'] : null,
    unitReference: field === 'unit' ? value['value'] : null,
    unitPriceDecimal: field === 'unit_price' ? value['decimal'] : null,
    currency: field === 'unit_price' ? value['currency'] : null,
    priceBasis: field === 'unit_price' ? value['basis'] : null,
    vatRateHint: field === 'vat_rate' ? value['value'] : null,
  };
}

export function normalizeAgentMissionQuoteLinePatch(
  input: unknown,
): AgentMissionQuoteLinePatchResult {
  const value = record(input);
  if (value === null || typeof value['field'] !== 'string') {
    return fail('$', 'invalid_shape');
  }
  const expected = PATCH_KEYS[value['field'] as AgentMissionQuoteLinePatchV1['field']];
  if (expected === undefined || !exactKeys(value, expected)) {
    return fail('$', 'invalid_shape');
  }
  const field = value['field'] as AgentMissionQuoteLinePatchV1['field'];
  if (field === 'housing_older_than_2y' || field === 'energy_renovation') {
    return typeof value['value'] === 'boolean'
      ? { ok: true, value: Object.freeze({ field, value: value['value'] }) }
      : fail('value', 'invalid_value');
  }
  const candidate = normalizeAgentMissionQuoteLineCandidate(
    singleFieldCandidate(field, value),
  );
  if (!candidate.ok) {
    return fail(candidate.error.field, candidate.error.reason);
  }
  switch (field) {
    case 'service_reference':
      return candidate.value.serviceReference === null
        ? fail('value', 'invalid_value')
        : {
            ok: true,
            value: Object.freeze({
              field,
              value: candidate.value.serviceReference,
            }),
          };
    case 'category':
      return candidate.value.category === null
        ? fail('value', 'invalid_value')
        : {
            ok: true,
            value: Object.freeze({ field, value: candidate.value.category }),
          };
    case 'quantity':
      return candidate.value.quantityMilli === null
        ? fail('decimal', 'invalid_value')
        : {
            ok: true,
            value: Object.freeze({
              field,
              quantityMilli: candidate.value.quantityMilli,
            }),
          };
    case 'unit':
      return candidate.value.unit === null
        ? fail('value', 'invalid_value')
        : {
            ok: true,
            value: Object.freeze({ field, value: candidate.value.unit }),
          };
    case 'unit_price':
      return candidate.value.unitPriceCents === null
        || candidate.value.priceBasis === null
        ? fail('decimal', 'invalid_value')
        : {
            ok: true,
            value: Object.freeze({
              field,
              unitPriceCents: candidate.value.unitPriceCents,
              basis: candidate.value.priceBasis,
            }),
          };
    case 'vat_rate':
      return candidate.value.requestedVatRate === null
        ? fail('value', 'invalid_value')
        : {
            ok: true,
            value: Object.freeze({
              field,
              value: candidate.value.requestedVatRate,
            }),
          };
  }
}
