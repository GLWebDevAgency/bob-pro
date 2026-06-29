import { describe, it, expect } from 'vitest';
import { Payment } from './payment';

describe('Payment', () => {
  it('record un montant positif', () => {
    const r = Payment.record({ id: 'p1', companyId: 'c1', invoiceId: 'i1', amount: 48840, method: 'transfer', receivedAt: '2026-06-01T00:00:00.000Z' });
    expect(r.ok).toBe(true);
  });
  it('refuse un montant <= 0', () => {
    const r = Payment.record({ id: 'p1', companyId: 'c1', invoiceId: 'i1', amount: 0, method: 'cash', receivedAt: '2026-06-01T00:00:00.000Z' });
    expect(r.ok).toBe(false);
  });
});
