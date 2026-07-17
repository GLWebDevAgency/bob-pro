import { describe, it, expect } from 'vitest';
import { Company, type CompanyProps } from './company';

const baseProps: CompanyProps = {
  id: 'c1',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  address: { line1: '1 rue X', zip: '92000', city: 'Nanterre' },
  rcsOrRm: 'RM 92',
};

describe('Company', () => {
  it('detecte le BTP et la franchise', () => {
    const r = Company.of(baseProps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.isBtp()).toBe(true);
      expect(r.value.isVatFranchise()).toBe(false);
    }
  });
  it('franchise => isVatFranchise true', () => {
    const r = Company.of({ ...baseProps, vatRegime: 'franchise' });
    if (r.ok) expect(r.value.isVatFranchise()).toBe(true);
  });
  it('assertCanIssue ok quand identite complete', () => {
    const r = Company.of(baseProps);
    if (r.ok) expect(r.value.assertCanIssue().ok).toBe(true);
  });
  it('rejette un SIRET incoherent avec le SIREN', () => {
    const r = Company.of({ ...baseProps, siret: '55208131766522' });
    expect(r.ok).toBe(false);
  });
  it('conserve une clientèle confirmée sans en inventer une par défaut', () => {
    const withoutPortfolio = Company.of(baseProps);
    expect(withoutPortfolio.ok && withoutPortfolio.value.customerPortfolio).toBeUndefined();

    const withPortfolio = Company.of({ ...baseProps, customerPortfolio: 'b2g' });
    expect(withPortfolio.ok && withPortfolio.value.customerPortfolio).toBe('b2g');
  });
  it('rejette une clientèle hors contrat à la réhydratation', () => {
    const r = Company.of({ ...baseProps, customerPortfolio: 'particuliers-et-pros' as never });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'customerPortfolio' },
    });
  });
});
