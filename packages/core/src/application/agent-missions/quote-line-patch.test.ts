import { describe, expect, it } from 'vitest';
import { normalizeAgentMissionQuoteLinePatch } from './quote-line-patch';

describe('normalizeAgentMissionQuoteLinePatch', () => {
  it.each([
    [
      { field: 'service_reference', value: 'Entretien vitrines' },
      { field: 'service_reference', value: 'Entretien vitrines' },
    ],
    [
      { field: 'quantity', decimal: '2.5' },
      { field: 'quantity', quantityMilli: 2_500 },
    ],
    [
      {
        field: 'unit_price',
        decimal: '55',
        currency: 'EUR',
        basis: 'per_unit',
      },
      { field: 'unit_price', unitPriceCents: 5_500, basis: 'per_unit' },
    ],
    [
      { field: 'vat_rate', value: '2.1' },
      { field: 'vat_rate', value: 2.1 },
    ],
    [
      { field: 'housing_older_than_2y', value: true },
      { field: 'housing_older_than_2y', value: true },
    ],
  ] as const)('normalise sans flottants ni heuristique %#', (input, expected) => {
    expect(normalizeAgentMissionQuoteLinePatch(input)).toEqual({
      ok: true,
      value: expected,
    });
  });

  it.each([
    { field: 'quantity', decimal: '2,5' },
    { field: 'unit_price', decimal: '55', currency: 'USD', basis: 'per_unit' },
    { field: 'vat_rate', value: '7' },
    { field: 'unit', value: ' heure' },
    { field: 'category', value: 'disbursement' },
    { field: 'service_reference', value: 'Entretien\nvitrines' },
    { field: 'quantity', decimal: '2', extra: true },
  ])('refuse une forme non canonique %#', (input) => {
    expect(normalizeAgentMissionQuoteLinePatch(input).ok).toBe(false);
  });
});
