import { describe, expect, it } from 'vitest';
import type { CompanyProps } from '@bob/core';
import { companyCanIssue } from './company-completeness';

const BASE: CompanyProps = {
  id: 'company-1',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  tvaIntracom: 'FR44732829320',
  rcsOrRm: 'RM 92',
  address: { line1: '24 rue de la Forge', zip: '92310', city: 'Sèvres' },
};

describe('companyCanIssue', () => {
  it('refuse quand aucune société n’est encore chargée (null/undefined)', () => {
    expect(companyCanIssue(null)).toBe(false);
    expect(companyCanIssue(undefined)).toBe(false);
  });

  it('accepte une société au réel avec RCS/RM, adresse complète et TVA attribuée', () => {
    expect(companyCanIssue(BASE)).toBe(true);
  });

  it('refuse une société sans RCS/RM', () => {
    const { rcsOrRm: _rcsOrRm, ...withoutRcs } = BASE;
    expect(companyCanIssue(withoutRcs)).toBe(false);
  });

  it('refuse une société avec une adresse incomplète', () => {
    expect(companyCanIssue({ ...BASE, address: { line1: '', zip: '92310', city: '' } })).toBe(false);
  });

  it('refuse le régime réel sans TVA attribuée, mais accepte son absence en franchise', () => {
    const { tvaIntracom: _tvaIntracom, ...withoutVat } = BASE;
    expect(companyCanIssue(withoutVat)).toBe(false);
    expect(companyCanIssue({ ...withoutVat, vatRegime: 'franchise' })).toBe(true);
  });
});
