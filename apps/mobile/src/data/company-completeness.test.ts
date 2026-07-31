import { describe, expect, it } from 'vitest';
import type { CompanyProps } from '@bob/core';
import { companyCanIssue, companyIssueBlocker } from './company-completeness';

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

/** Le profil du bug terrain 30/07 : une SAS (société → capital exigé par assertCanIssue). */
const SAS: CompanyProps = {
  ...BASE,
  id: 'company-fly',
  name: 'FLY SERVICES',
  legalForm: 'SAS',
  trade: 'mainteneur',
  rcsOrRm: '732 829 320 RCS Paris',
  capitalSocialCents: 500_000,
};

describe('companyCanIssue', () => {
  it('refuse quand aucune société n’est encore chargée (null/undefined)', () => {
    expect(companyCanIssue(null)).toBe(false);
    expect(companyCanIssue(undefined)).toBe(false);
  });

  it('accepte une entreprise au réel avec RCS/RM, adresse complète et TVA attribuée', () => {
    expect(companyCanIssue(BASE)).toBe(true);
  });

  it('refuse une entreprise sans RCS/RM', () => {
    const { rcsOrRm: _rcsOrRm, ...withoutRcs } = BASE;
    expect(companyCanIssue(withoutRcs)).toBe(false);
  });

  it('refuse une entreprise avec une adresse incomplète', () => {
    expect(companyCanIssue({ ...BASE, address: { line1: '', zip: '92310', city: '' } })).toBe(false);
  });

  it('refuse le régime réel sans TVA attribuée, mais accepte son absence en franchise', () => {
    const { tvaIntracom: _tvaIntracom, ...withoutVat } = BASE;
    expect(companyCanIssue(withoutVat)).toBe(false);
    expect(companyCanIssue({ ...withoutVat, vatRegime: 'franchise' })).toBe(true);
  });

  it('refuse une SOCIÉTÉ sans capital social — le bug FLY SERVICES (une EI, elle, passe sans)', () => {
    expect(companyCanIssue(SAS)).toBe(true);
    const { capitalSocialCents: _capital, ...sasWithoutCapital } = SAS;
    expect(companyCanIssue(sasWithoutCapital)).toBe(false);
    // La même absence de capital sur une EI n'est PAS un blocage (art. R123-238 : sociétés).
    expect(companyCanIssue(BASE)).toBe(true);
  });
});

describe('companyIssueBlocker — nommer le champ qui bloque (jamais décider)', () => {
  it('rend null pour une fiche émissible ou pas encore chargée — null ≠ « laisse passer »', () => {
    expect(companyIssueBlocker(SAS)).toBeNull();
    expect(companyIssueBlocker(null)).toBeNull();
    expect(companyIssueBlocker(undefined)).toBeNull();
  });

  it('nomme `capitalSocial` (vocabulaire produit) pour le champ domaine capitalSocialCents', () => {
    const { capitalSocialCents: _capital, ...sasWithoutCapital } = SAS;
    expect(companyIssueBlocker(sasWithoutCapital)).toBe('capitalSocial');
  });

  it('rend null quand la fiche est structurellement invalide (Company.of KO) — le gate générique bloque', () => {
    // SIREN incohérent avec le SIRET : Company.of refuse avant même assertCanIssue.
    expect(companyIssueBlocker({ ...SAS, siren: '000000000' })).toBeNull();
    expect(companyCanIssue({ ...SAS, siren: '000000000' })).toBe(false);
  });
});
