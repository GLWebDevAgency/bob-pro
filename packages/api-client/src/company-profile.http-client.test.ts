import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBobClient } from './http-client';

describe('HttpBobClient — profil société persistant', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('écrit les choix explicites sur le tenant authentifié', async () => {
    const company = {
      id: 'company-owner',
      name: 'Durand Élec',
      legalForm: 'EI',
      siren: '732829320',
      siret: '73282932000074',
      trade: 'electricien',
      vatRegime: 'reel_simpl',
      customerPortfolio: 'b2g',
      address: { line1: '4 rue du Forgeron', zip: '92310', city: 'Sèvres' },
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/company/profile');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({
        trade: 'electricien',
        vatRegime: 'reel_simpl',
        customerPortfolio: 'b2g',
      });
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer owner-token',
        'x-company-id': 'company-owner',
      });
      return new Response(JSON.stringify(company), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    const result = await client.updateCompanyProfile({
      trade: 'electricien',
      vatRegime: 'reel_simpl',
      customerPortfolio: 'b2g',
    });

    expect(result).toEqual({ ok: true, value: company });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ne transforme pas une panne serveur en confirmation locale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { kind: 'dependency', port: 'database', cause: 'unavailable' },
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })));
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
    });

    const result = await client.updateCompanyProfile({ trade: 'plombier', vatRegime: 'franchise' });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'database', cause: 'unavailable' },
    });
  });
});

describe('HttpBobClient — coordonnées bancaires (RIB)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('écrit iban/bic sur le tenant authentifié (PATCH /company/billing)', async () => {
    const company = { id: 'company-owner', iban: 'FR7630006000011234567890189', bic: 'BNPAFRPPXXX' };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/company/billing');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({
        iban: 'FR76 3000 6000 0112 3456 7890 189',
        bic: 'BNPAFRPPXXX',
      });
      return new Response(JSON.stringify(company), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    const result = await client.updateCompanyBilling({
      iban: 'FR76 3000 6000 0112 3456 7890 189',
      bic: 'BNPAFRPPXXX',
    });

    expect(result).toEqual({ ok: true, value: company });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
