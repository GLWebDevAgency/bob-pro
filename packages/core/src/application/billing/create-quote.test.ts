import { describe, expect, it } from 'vitest';
import { canonicalCreateQuotePayload, type CreateQuoteInput } from './create-quote';

function input(
  overrides: Partial<Omit<CreateQuoteInput, 'companyId'>> = {},
): Omit<CreateQuoteInput, 'companyId'> {
  return {
    customerId: 'customer-1',
    lines: [
      {
        label: 'Pose chauffe-eau',
        category: 'labor',
        qty: 2,
        unitPriceHT: 8_000,
        vatRate: 10,
      },
    ],
    ...overrides,
  };
}

describe('canonicalCreateQuotePayload', () => {
  it('normalise les valeurs optionnelles sans conserver la clé technique', () => {
    const implicit = canonicalCreateQuotePayload(input({ idempotencyKey: 'voice-quote-secret-1' }));
    const explicit = canonicalCreateQuotePayload(input({
      idempotencyKey: 'another-secret',
      context: { housingOlderThan2y: false, energyRenovation: false },
    }));

    expect(implicit).toEqual(explicit);
    expect(implicit).not.toHaveProperty('idempotencyKey');
  });

  it('conserve chaque différence qui change le devis', () => {
    expect(canonicalCreateQuotePayload(input({
      lines: [{ ...input().lines[0]!, unitPriceHT: 8_001 }],
    }))).not.toEqual(canonicalCreateQuotePayload(input()));
    expect(canonicalCreateQuotePayload(input({ context: { housingOlderThan2y: true } }))).not.toEqual(
      canonicalCreateQuotePayload(input()),
    );
  });
});
