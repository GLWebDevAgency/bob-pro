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
  it('fige une ventilation 411 / 4117 dont la somme égale le paiement', () => {
    const r = Payment.record({
      id: 'p-ret',
      companyId: 'c1',
      invoiceId: 'i1',
      amount: 3000,
      method: 'transfer',
      receivedAt: '2026-06-01T00:00:00.000Z',
      ordinaryReceivableCents: 558,
      retentionReceivableCents: 2442,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ordinaryReceivableCents).toBe(558);
      expect(r.value.retentionReceivableCents).toBe(2442);
    }
    expect(Payment.record({
      id: 'p-bad', companyId: 'c1', invoiceId: 'i1', amount: 3000,
      method: 'transfer', receivedAt: '2026-06-01T00:00:00.000Z',
      ordinaryReceivableCents: 1000, retentionReceivableCents: 1000,
    }).ok).toBe(false);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 12.34])('refuse un montant non entier fini (%s)', (amount) => {
    const r = Payment.record({ id: 'p1', companyId: 'c1', invoiceId: 'i1', amount, method: 'cash', receivedAt: '2026-06-01T00:00:00.000Z' });
    expect(r.ok).toBe(false);
  });
});
