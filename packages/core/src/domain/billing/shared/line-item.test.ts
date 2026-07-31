import { describe, expect, it } from 'vitest';
import {
  calculateBillingLineTotalCents,
  MAX_BILLING_AMOUNT_CENTS,
} from './line-item';

describe('calculateBillingLineTotalCents', () => {
  it('applique exactement l’arrondi historique des pièces, y compris aux frontières flottantes', () => {
    expect(calculateBillingLineTotalCents({
      qty: 0.009,
      unitPriceHT: 1_500,
    })).toBe(13);
    expect(calculateBillingLineTotalCents({
      qty: 0.015,
      unitPriceHT: 1_500,
    })).toBe(23);
  });

  it('refuse une quantité, un prix ou un total hors bornes facturables', () => {
    expect(calculateBillingLineTotalCents({
      qty: 0,
      unitPriceHT: 1_500,
    })).toBeNull();
    expect(calculateBillingLineTotalCents({
      qty: 1.000_1,
      unitPriceHT: 1_500,
    })).toBeNull();
    expect(calculateBillingLineTotalCents({
      qty: 2,
      unitPriceHT: MAX_BILLING_AMOUNT_CENTS,
    })).toBeNull();
  });
});
