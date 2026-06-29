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
});
