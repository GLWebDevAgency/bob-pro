import { describe, it, expect } from 'vitest';
import { Customer, type CustomerProps } from './customer';

const base: CustomerProps = {
  id: 'k1',
  companyId: 'c1',
  type: 'b2c',
  name: 'Martin',
  address: { line1: 'x', zip: '75001', city: 'Paris' },
  score: 80,
  avgDelayDays: 5,
  outstanding: 0,
};

describe('Customer', () => {
  it('b2b exige un SIREN pour e-invoice', () => {
    const r = Customer.of({ ...base, type: 'b2b', name: 'Durand SARL', score: 96 });
    if (r.ok) expect(r.value.requiresSirenForEinvoice()).toBe(true);
  });
  it('bande de score rouge sous 65', () => {
    const r = Customer.of({ ...base, score: 62, avgDelayDays: 20, outstanding: 50000 });
    if (r.ok) expect(r.value.scoreBand()).toBe('red');
  });
  it('isProfessional : b2b et b2g sont des débiteurs professionnels, b2c non (gate L441-10/CCP)', () => {
    const of = (type: CustomerProps['type']) => {
      const r = Customer.of({ ...base, type });
      if (!r.ok) throw new Error('customer de test invalide');
      return r.value;
    };
    expect(of('b2b').isProfessional()).toBe(true);
    expect(of('b2g').isProfessional()).toBe(true);
    expect(of('b2c').isProfessional()).toBe(false);
  });
});
