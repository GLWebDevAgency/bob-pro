import { describe, expect, it } from 'vitest';
import type { CreateQuoteInput } from '@bob/core';
import { decodeQuoteCreation, localQuoteCreationFingerprint } from './quote-idempotency';

const input: Omit<CreateQuoteInput, 'companyId'> = {
  customerId: 'customer-1',
  idempotencyKey: 'mobile-voice:quote:secret-local-retry',
  lines: [{ label: 'Pose', category: 'labor', qty: 2, unitPriceHT: 8_000, vatRate: 20 }],
};

describe('quote idempotency helpers', () => {
  it('produit les mêmes empreintes canoniques sans exposer la clé', () => {
    const first = localQuoteCreationFingerprint('company-1', input);
    const same = localQuoteCreationFingerprint('company-1', {
      ...input,
      idempotencyKey: 'mobile-voice:quote:secret-local-retry',
      context: { housingOlderThan2y: false, energyRenovation: false },
    });
    expect(first).toEqual(same);
    expect(JSON.stringify(first)).not.toContain(input.idempotencyKey);
  });

  it('décode uniquement une réponse financière exacte et cohérente', () => {
    const output = {
      quoteId: 'quote-1',
      totals: { ht: 16_000, vat: 3_200, ttc: 19_200, netToPay: 19_200, vatByRate: { 20: 3_200 } },
    };
    expect(decodeQuoteCreation(output)).toEqual(output);
    expect(decodeQuoteCreation({ ...output, internal: true })).toBeNull();
    expect(decodeQuoteCreation({ ...output, totals: { ...output.totals, ttc: 1 } })).toBeNull();
    expect(decodeQuoteCreation({ ...output, totals: { ...output.totals, vatByRate: { 17: 3_200 } } })).toBeNull();
  });
});
