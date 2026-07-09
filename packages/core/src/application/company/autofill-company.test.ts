import { describe, it, expect } from 'vitest';
import { AutofillCompanyFromSiret } from './autofill-company';
import { type CompanyLookupPort, type CompanyLookupResult } from '../ports/company-lookup';
import { nafToTrade } from '../../domain/company/naf-to-trade';
import { natureJuridiqueToLegalForm } from '../../domain/company/nature-juridique';

const PROFILE: CompanyLookupResult = {
  siren: '356000000',
  siret: '35600000000048',
  denomination: 'LA POSTE',
  nafApe: '43.22A',
  trade: 'plombier',
  natureJuridiqueCode: '5710',
  legalForm: 'SAS',
  dateCreation: '1991-01-01',
  address: { line1: '9 rue du Colonel Pierre Avia', zip: '75015', city: 'Paris' },
  tvaIntracom: 'FR39356000000',
  rge: false,
};

const stub = (res: CompanyLookupResult | null): CompanyLookupPort => ({
  async lookupBySiret() {
    return res;
  },
});

describe('AutofillCompanyFromSiret', () => {
  it('renvoie le profil pour un SIRET valide', async () => {
    const r = await new AutofillCompanyFromSiret({ lookup: stub(PROFILE) }).execute({ siret: '356 000 000 00048' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.denomination).toBe('LA POSTE');
  });

  it('rejette un SIRET invalide (Luhn) sans appeler le port', async () => {
    let called = false;
    const spy: CompanyLookupPort = {
      async lookupBySiret() {
        called = true;
        return PROFILE;
      },
    };
    const r = await new AutofillCompanyFromSiret({ lookup: spy }).execute({ siret: '12345678900000' });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('not_found si le port ne trouve rien', async () => {
    const r = await new AutofillCompanyFromSiret({ lookup: stub(null) }).execute({ siret: '35600000000048' });
    expect(r.ok).toBe(false);
  });
});

describe('nafToTrade', () => {
  it('mappe les NAF connus et ignore les autres', () => {
    expect(nafToTrade('43.22A')).toBe('plombier');
    expect(nafToTrade('70.22Z')).toBe('consultant');
    expect(nafToTrade('53.10Z')).toBeNull();
    expect(nafToTrade(null)).toBeNull();
  });

  it('route les NAF informatiques vers freelance_it, sans capturer le conseil de gestion', () => {
    expect(nafToTrade('62.01Z')).toBe('freelance_it'); // programmation
    expect(nafToTrade('62.02A')).toBe('freelance_it'); // conseil SI
    expect(nafToTrade('62.02B')).toBe('freelance_it'); // TMA
    expect(nafToTrade('62.03Z')).toBe('freelance_it'); // infogérance
    expect(nafToTrade('62.09Z')).toBe('freelance_it'); // autres activités informatiques
    // Le conseil de gestion (70.2x) reste consultant — un dev ≠ un consultant en stratégie.
    expect(nafToTrade('70.22Z')).toBe('consultant');
  });
});

describe('natureJuridiqueToLegalForm', () => {
  it('mappe les codes INSEE sans ambiguïté, null sinon (l’utilisateur choisit)', () => {
    expect(natureJuridiqueToLegalForm('1000')).toBe('EI');
    expect(natureJuridiqueToLegalForm('5498')).toBe('EURL');
    expect(natureJuridiqueToLegalForm('5499')).toBe('SARL');
    expect(natureJuridiqueToLegalForm('5710')).toBe('SAS'); // SASU incluse (même code INSEE)
    expect(natureJuridiqueToLegalForm('6540')).toBeNull(); // SCI : hors périmètre LegalForm
    expect(natureJuridiqueToLegalForm('9220')).toBeNull(); // association
    expect(natureJuridiqueToLegalForm(null)).toBeNull();
  });
});
