import { describe, it, expect } from 'vitest';
import { isVatRate, VAT_RATES } from './vat-rate';

describe('VatRate', () => {
  it('accepte uniquement {0,2.1,5.5,10,20}', () => {
    expect(VAT_RATES).toEqual([0, 2.1, 5.5, 10, 20]);
    expect(isVatRate(10)).toBe(true);
    expect(isVatRate(7)).toBe(false);
  });
});
