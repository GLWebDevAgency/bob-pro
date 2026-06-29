import { describe, it, expect } from 'vitest';
import { AutofillCompanyFromSiret } from './autofill-company';
import { type CompanyLookupPort, type CompanyLookupResult } from '../ports/company-lookup';
import { nafToTrade } from '../../domain/company/naf-to-trade';

const PROFILE: CompanyLookupResult = {
  siren: '356000000',
  siret: '35600000000048',
  denomination: 'LA POSTE',
  nafApe: '43.22A',
  trade: 'plombier',
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
});
