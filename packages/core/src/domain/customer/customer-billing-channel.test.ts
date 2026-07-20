import { describe, expect, it } from 'vitest';
import { Customer, validateBillingChannel, type CustomerProps } from './customer';

/**
 * Canal de FACTURATION du client (validé fondateur) : email | chorus | portail.
 * Les champs annexes n'existent que pour LEUR type (fail-closed) ; nullable = email par défaut.
 */

const base: CustomerProps = {
  id: 'cust-1',
  companyId: 'co-1',
  type: 'b2g',
  name: 'Mairie de Sèvres',
  address: { line1: '1 place de la Mairie', zip: '92310', city: 'Sèvres' },
};

describe('validateBillingChannel — formes acceptées', () => {
  it('email nu (aucun champ annexe)', () => {
    const r = validateBillingChannel({ type: 'email' });
    expect(r.ok && r.value).toEqual({ type: 'email' });
  });

  it('chorus avec code service (trimé)', () => {
    const r = validateBillingChannel({ type: 'chorus', chorusServiceCode: '  SERV-42  ' });
    expect(r.ok && r.value).toEqual({ type: 'chorus', chorusServiceCode: 'SERV-42' });
  });

  it('chorus SANS code service (certaines entités n’en exigent pas)', () => {
    const r = validateBillingChannel({ type: 'chorus' });
    expect(r.ok && r.value).toEqual({ type: 'chorus' });
  });

  it('portail avec nom et URL https', () => {
    const r = validateBillingChannel({
      type: 'portail',
      portailNom: 'Portail Vinci',
      portailUrl: 'https://fournisseurs.vinci.com',
    });
    expect(r.ok && r.value).toEqual({
      type: 'portail',
      portailNom: 'Portail Vinci',
      portailUrl: 'https://fournisseurs.vinci.com',
    });
  });
});

describe('validateBillingChannel — refus fail-closed', () => {
  it('type inconnu', () => {
    const r = validateBillingChannel({ type: 'fax' } as never);
    expect(r.ok).toBe(false);
  });

  it('code service sur un canal NON chorus (état sans sens)', () => {
    const r = validateBillingChannel({ type: 'email', chorusServiceCode: 'SERV-42' });
    expect(r.ok).toBe(false);
  });

  it('mémo portail sur un canal NON portail', () => {
    const r = validateBillingChannel({ type: 'chorus', portailNom: 'X' });
    expect(r.ok).toBe(false);
  });

  it('URL de portail sans schéma http(s)', () => {
    const r = validateBillingChannel({ type: 'portail', portailUrl: 'fournisseurs.vinci.com' });
    expect(r.ok).toBe(false);
  });

  it('code service vide après trim', () => {
    const r = validateBillingChannel({ type: 'chorus', chorusServiceCode: '   ' });
    expect(r.ok).toBe(false);
  });
});

describe('Customer.of — intégration du canal', () => {
  it('absent = défaut email honnête (undefined, jamais un canal inventé)', () => {
    const r = Customer.of(base);
    expect(r.ok && r.value.billingChannel).toBeUndefined();
  });

  it('canal valide : normalisé, round-trip toProps fidèle, getter défensif', () => {
    const r = Customer.of({
      ...base,
      billingChannel: { type: 'chorus', chorusServiceCode: 'SERV-42' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const channel = r.value.billingChannel!;
    expect(channel).toEqual({ type: 'chorus', chorusServiceCode: 'SERV-42' });
    // Copie défensive : muter le retour ne touche jamais l'état interne.
    (channel as { type: string }).type = 'email';
    expect(r.value.billingChannel).toEqual({ type: 'chorus', chorusServiceCode: 'SERV-42' });
    expect(Customer.of(r.value.toProps()).ok).toBe(true);
  });

  it('canal invalide : la fiche entière est refusée (jamais un canal ignoré en silence)', () => {
    const r = Customer.of({ ...base, billingChannel: { type: 'portail', chorusServiceCode: 'X' } });
    expect(r.ok).toBe(false);
  });
});
