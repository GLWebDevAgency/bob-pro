import { describe, it, expect } from 'vitest';
import { Customer, type CustomerProps } from './customer';

const base: CustomerProps = {
  id: 'k1',
  companyId: 'c1',
  type: 'b2b',
  name: 'SARL Martin Rénovation',
  siren: '821503642',
  address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
};

describe('Customer.paymentTerms (B4)', () => {
  it('accepte des conditions valides et les restitue (copie défensive)', () => {
    const r = Customer.of({ ...base, paymentTerms: { days: 45, endOfMonth: true, label: '45 jours fin de mois' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const terms = r.value.paymentTerms;
      expect(terms).toEqual({ days: 45, endOfMonth: true, label: '45 jours fin de mois' });
      // Copie défensive : la mutation du retour ne touche pas l'entité.
      terms!.days = 999;
      expect(r.value.paymentTerms?.days).toBe(45);
    }
  });
  it('absent = undefined (défaut société à l’émission, jamais inventé)', () => {
    const r = Customer.of(base);
    if (r.ok) expect(r.value.paymentTerms).toBeUndefined();
  });
  it('plafond légal L441-10 pour un pro : 61 j nets refusé, 46 j fin de mois refusé', () => {
    expect(Customer.of({ ...base, paymentTerms: { days: 61, endOfMonth: false, label: '61 jours' } }).ok).toBe(false);
    expect(Customer.of({ ...base, paymentTerms: { days: 46, endOfMonth: true, label: '46 FDM' } }).ok).toBe(false);
    expect(Customer.of({ ...base, paymentTerms: { days: 60, endOfMonth: false, label: '60 jours' } }).ok).toBe(true);
  });
  it('b2c : pas de plafond L441-10 (90 j accepté)', () => {
    const { siren: _siren, ...sansSiren } = base;
    const r = Customer.of({
      ...sansSiren,
      type: 'b2c',
      paymentTerms: { days: 90, endOfMonth: false, label: '90 jours' },
    });
    expect(r.ok).toBe(true);
  });
  it('structure invalide refusée (jours négatifs, libellé vide)', () => {
    expect(Customer.of({ ...base, paymentTerms: { days: -1, endOfMonth: false, label: 'x' } }).ok).toBe(false);
    expect(Customer.of({ ...base, paymentTerms: { days: 30, endOfMonth: false, label: '   ' } }).ok).toBe(false);
  });
  it('bornes fiche client (miroir du CHECK SQL) : > 365 j et libellé > 120 caractères refusés', () => {
    const { siren: _siren, ...sansSiren } = base;
    expect(
      Customer.of({
        ...sansSiren,
        type: 'b2c',
        paymentTerms: { days: 366, endOfMonth: false, label: '366 jours' },
      }).ok,
    ).toBe(false);
    expect(
      Customer.of({
        ...base,
        paymentTerms: { days: 30, endOfMonth: false, label: 'x'.repeat(121) },
      }).ok,
    ).toBe(false);
  });
  it('toProps porte les conditions (persistance) et survit au round-trip', () => {
    const r = Customer.of({ ...base, paymentTerms: { days: 30, endOfMonth: false, label: '30 jours nets' } });
    if (!r.ok) throw new Error('customer');
    const rehydrated = Customer.of(r.value.toProps());
    expect(rehydrated.ok).toBe(true);
    if (rehydrated.ok)
      expect(rehydrated.value.paymentTerms).toEqual({ days: 30, endOfMonth: false, label: '30 jours nets' });
  });
});
