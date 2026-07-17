import { describe, it, expect } from 'vitest';
import { Customer, type CustomerProps } from './customer';

const base: CustomerProps = {
  id: 'k1',
  companyId: 'c1',
  type: 'b2c',
  name: 'Martin',
  address: { line1: 'x', zip: '75001', city: 'Paris' },
};

describe('Customer', () => {
  it('b2b exige un SIREN pour e-invoice', () => {
    const r = Customer.of({ ...base, type: 'b2b', name: 'Durand SARL' });
    if (r.ok) expect(r.value.requiresSirenForEinvoice()).toBe(true);
  });
  it('ignore les anciennes métriques injectées à l’exécution au lieu de les persister', () => {
    const r = Customer.of({ ...base, score: 100, avgDelayDays: 0, outstanding: 0 } as CustomerProps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.toProps()).not.toHaveProperty('score');
      expect(r.value.toProps()).not.toHaveProperty('avgDelayDays');
      expect(r.value.toProps()).not.toHaveProperty('outstanding');
    }
  });
  it('contactName : conservé (trim) pour un client entreprise, absent si non fourni', () => {
    const withContact = Customer.of({ ...base, type: 'b2b', name: 'Durand SARL', contactName: '  Julie Durand  ' });
    expect(withContact.ok && withContact.value.contactName).toBe('Julie Durand');

    const withoutContact = Customer.of({ ...base });
    expect(withoutContact.ok && withoutContact.value.contactName).toBeUndefined();
  });

  it('rejette un contactName trop long (> 200 caractères)', () => {
    const r = Customer.of({ ...base, type: 'b2b', name: 'Durand SARL', contactName: 'a'.repeat(201) });
    expect(r.ok).toBe(false);
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
