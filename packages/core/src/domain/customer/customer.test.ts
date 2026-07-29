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
  it('canonise les espaces issus de la voix et des anciennes lignes', () => {
    const result = Customer.of({
      ...base,
      name: '  Camping\t Les \n Pins  ',
    });
    expect(result.ok && result.value.name).toBe('Camping Les Pins');
  });

  it('refuse les contrôles Unicode non imprimables sans refuser les espaces vocaux', () => {
    expect(Customer.of({ ...base, name: 'Camping\u0081Les Pins' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'name' },
    });
  });

  it('conserve le SIRET de l établissement et en extrait le SIREN quand il est seul', () => {
    const result = Customer.of({
      ...base,
      type: 'b2b',
      name: 'CARREFOUR',
      siret: '4513 2133 501021',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.siret).toBe('45132133501021');
      expect(result.value.siren).toBe('451321335');
    }
  });

  it('refuse un SIRET invalide ou incohérent avec le SIREN', () => {
    expect(
      Customer.of({
        ...base,
        type: 'b2b',
        name: 'CARREFOUR',
        siret: '45132133501020',
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', field: 'siret' } });

    expect(
      Customer.of({
        ...base,
        type: 'b2b',
        name: 'CARREFOUR',
        siren: '732829320',
        siret: '45132133501021',
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', field: 'siret' } });
  });

  it('un SIRET seul fournit le SIREN nécessaire à la TVA française', () => {
    const result = Customer.of({
      ...base,
      type: 'b2b',
      name: 'Mercier Plomberie',
      siret: '73282932000074',
      tvaIntracom: 'FR44732829320',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tvaIntracom).toBe('FR44732829320');
  });

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

  it('normalise une adresse électronique réelle et refuse un endpoint EM invalide', () => {
    const valid = Customer.of({ ...base, email: '  CLIENT@Example.FR  ' });
    expect(valid.ok && valid.value.email).toBe('client@example.fr');

    const invalid = Customer.of({ ...base, email: 'client-sans-domaine' });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'email' },
    });
  });

  it('conserve une TVA française réelle cohérente et refuse toute valeur fabriquée', () => {
    const valid = Customer.of({ ...base, type: 'b2b', siren: '732829320', tvaIntracom: ' fr44 732829320 ' });
    expect(valid.ok && valid.value.tvaIntracom).toBe('FR44732829320');

    expect(Customer.of({ ...base, type: 'b2b', siren: '732829320', tvaIntracom: 'FR24732829320' })).toMatchObject({
      ok: false,
      error: { field: 'tvaIntracom' },
    });
    expect(Customer.of({ ...base, tvaIntracom: 'FR44732829320' })).toMatchObject({
      ok: false,
      error: { field: 'tvaIntracom' },
    });
  });

  it('refuse un SIREN de 9 chiffres dont la clé Luhn est fausse', () => {
    expect(Customer.of({ ...base, type: 'b2b', siren: '732829321' })).toMatchObject({
      ok: false,
      error: { field: 'siren' },
    });
  });

  it('autorise une fiche minimale mais refuse son usage en facturation tant que l’adresse est incomplète', () => {
    const minimal = Customer.of({
      ...base,
      address: { line1: '   ', zip: '', city: 'Paris' },
    });
    expect(minimal.ok).toBe(true);
    expect(minimal.ok && minimal.value.assertBillingAddressComplete()).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'customer.address' },
    });

    const complete = Customer.of(base);
    expect(complete.ok && complete.value.assertBillingAddressComplete().ok).toBe(true);
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
