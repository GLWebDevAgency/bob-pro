import { describe, it, expect } from 'vitest';
import { scoreCustomer } from './score-customer';

describe('scoreCustomer', () => {
  it('bon payeur proche de 100', () => {
    expect(scoreCustomer({ avgDelayDays: 1, outstanding: 0, paidOnTimeRatio: 1 })).toBeGreaterThanOrEqual(85);
  });
  it('mauvais payeur < 65', () => {
    expect(scoreCustomer({ avgDelayDays: 40, outstanding: 500000, paidOnTimeRatio: 0.2 })).toBeLessThan(65);
  });
  it('borne 0..100', () => {
    const s = scoreCustomer({ avgDelayDays: 999, outstanding: 9_999_999, paidOnTimeRatio: 0 });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});
