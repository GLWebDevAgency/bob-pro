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
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer owner-token');
      expect(headers.has('x-company-id')).toBe(false);
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
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { kind: 'dependency', port: 'database', cause: 'unavailable' },
            }),
            {
              status: 503,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
    });

    const result = await client.updateCompanyProfile({ trade: 'plombier', vatRegime: 'franchise' });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'database',
        cause: 'unavailable',
        code: 'BOB-API-502',
        correlationId: expect.stringMatching(/^[0-9a-f-]{8,64}$/),
      },
    });
  });
});

describe('HttpBobClient — coordonnées bancaires (RIB)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('écrit iban/bic sur le tenant authentifié (PATCH /company/billing)', async () => {
    const company = {
      id: 'company-owner',
      iban: 'FR7630006000011234567890189',
      bic: 'BNPAFRPPXXX',
    };
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

describe('HttpBobClient — identité légale (A6 capital, A2 médiateur conso)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('écrit capital + médiateur sur le tenant authentifié (PATCH /company/legal)', async () => {
    const company = {
      id: 'company-owner',
      legalForm: 'SARL',
      capitalSocialCents: 1000000,
      mediateurConso: { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris' },
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/company/legal');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({
        capitalSocialCents: 1000000,
        mediateurConso: { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris' },
      });
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer owner-token');
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

    const result = await client.updateCompanyLegal({
      capitalSocialCents: 1000000,
      mediateurConso: { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris' },
    });

    expect(result).toEqual({ ok: true, value: company });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('effacement explicite : `null` part dans le corps, un champ omis n’y figure pas', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ mediateurConso: null });
      return new Response(JSON.stringify({ id: 'company-owner' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    await client.updateCompanyLegal({ mediateurConso: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('transmet la TVA réellement saisie sans fabriquer de valeur depuis le SIREN', async () => {
    const updatedCompany = {
      id: 'company-owner',
      legalForm: 'EI',
      siren: '732829320',
      tvaIntracom: 'FR44732829320',
    };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ tvaIntracom: 'FR44732829320' });
      return new Response(JSON.stringify(updatedCompany), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    const result = await client.updateCompanyLegal({ tvaIntracom: 'FR44732829320' });
    expect(result.ok && result.value.tvaIntracom).toBe('FR44732829320');
  });

  it('ne transforme pas un refus serveur (EI sans capital) en confirmation locale', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                kind: 'domain',
                error: { code: 'VALIDATION', field: 'capitalSocialCents' },
              },
            }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    const result = await client.updateCompanyLegal({ capitalSocialCents: 500000 });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'domain',
        error: { code: 'VALIDATION', field: 'capitalSocialCents' },
        code: 'BOB-API-422',
        correlationId: expect.stringMatching(/^[0-9a-f-]{8,64}$/),
      },
    });
  });
});

describe('HttpBobClient — inputs d’émission A7 (POST /invoices/:id/issue)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('transmet période de prestation + adresse de chantier dans le corps d’émission', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/invoices/inv-1/issue');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        invoiceId: 'inv-1',
        servicePeriod: { start: '2026-06-02', end: '2026-06-13' },
        deliveryAddress: 'Chantier — 8 allée des Roses, 92190 Meudon',
      });
      return new Response(JSON.stringify({ number: 'F-2026-0001' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    const result = await client.issueInvoice({
      invoiceId: 'inv-1',
      servicePeriod: { start: '2026-06-02', end: '2026-06-13' },
      deliveryAddress: 'Chantier — 8 allée des Roses, 92190 Meudon',
    });
    expect(result).toEqual({ ok: true, value: { number: 'F-2026-0001' } });
  });
});

describe('HttpBobClient — réglages facturation BDD', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lit puis écrit par CAS sans aplatir le patch avec une valeur locale', async () => {
    const settings = {
      companyId: 'company-owner',
      revision: 4,
      showRibOnInvoices: true,
      showInsuranceOnInvoices: false,
      pdfAccentColor: 'green',
      defaultQuoteValidityDays: 45,
      defaultDepositPercent: 20,
      defaultInvoicePaymentTermsDays: null,
      // PR-06 : le serveur porte TOUJOURS la cadence (null = défaut) et l'interrupteur auto.
      relancePolicy: null,
      relanceAutoEnabled: true,
      createdAt: '2026-07-17T06:00:00.000Z',
      updatedAt: '2026-07-17T06:05:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(settings), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockImplementationOnce(async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toBe('https://api.bob.test/company/billing-settings');
        expect(init?.method).toBe('PATCH');
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedRevision: 4,
          defaultQuoteValidityDays: 60,
        });
        return new Response(
          JSON.stringify({
            ...settings,
            revision: 5,
            defaultQuoteValidityDays: 60,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    await expect(client.getCompanyBillingSettings()).resolves.toEqual({
      ok: true,
      value: settings,
    });
    await expect(
      client.updateCompanyBillingSettings({
        expectedRevision: 4,
        patch: { defaultQuoteValidityDays: 60 },
      }),
    ).resolves.toMatchObject({ ok: true, value: { revision: 5, defaultQuoteValidityDays: 60 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tolère un serveur N-1 sans relancePolicy/relanceAutoEnabled : défauts FAIL-CLOSED (cadence défaut, auto OFF)', async () => {
    // Fenêtre de mixité preview/staging : l'app N interroge un serveur d'avant PR-06. Les deux
    // champs additifs absents ⇒ normalisés (null = DEFAULT_RELANCE_POLICY, auto false — jamais
    // une automatisation promise qu'un serveur N-1 n'exécute pas) ; le reste reste STRICT.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              companyId: 'company-owner',
              revision: 4,
              showRibOnInvoices: true,
              showInsuranceOnInvoices: false,
              pdfAccentColor: 'green',
              defaultQuoteValidityDays: 45,
              defaultDepositPercent: 20,
              defaultInvoicePaymentTermsDays: 30,
              createdAt: '2026-07-17T06:00:00.000Z',
              updatedAt: '2026-07-17T06:05:00.000Z',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    await expect(client.getCompanyBillingSettings()).resolves.toMatchObject({
      ok: true,
      value: { revision: 4, relancePolicy: null, relanceAutoEnabled: false },
    });
  });

  it('présents mais difformes, les champs PR-06 restent refusés (la tolérance ne couvre que l’absence)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              companyId: 'company-owner',
              revision: 4,
              showRibOnInvoices: true,
              showInsuranceOnInvoices: false,
              pdfAccentColor: 'green',
              defaultQuoteValidityDays: 45,
              defaultDepositPercent: 20,
              defaultInvoicePaymentTermsDays: 30,
              // Escalade désordonnée : neutre avant cordial — contrat refusé, jamais casté.
              relancePolicy: {
                cordialAfterDays: 20,
                neutreAfterDays: 10,
                fermeAfterDays: 30,
                miseEnDemeureAfterDays: 40,
              },
              relanceAutoEnabled: true,
              createdAt: '2026-07-17T06:00:00.000Z',
              updatedAt: '2026-07-17T06:05:00.000Z',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    await expect(client.getCompanyBillingSettings()).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('refuse un réglage serveur incomplet au lieu de fabriquer les conditions manquantes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              companyId: 'company-owner',
              revision: 1,
              showRibOnInvoices: true,
              showInsuranceOnInvoices: false,
              pdfAccentColor: 'navy',
              defaultQuoteValidityDays: 30,
              defaultDepositPercent: 30,
              createdAt: '2026-07-17T06:00:00.000Z',
              updatedAt: '2026-07-17T06:00:00.000Z',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    await expect(client.getCompanyBillingSettings()).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api-contract',
        code: 'BOB-API-502',
        correlationId: expect.stringMatching(/^[0-9a-f-]{8,64}$/),
        cause: 'Réponse API invalide pour GET /company/billing-settings.',
      },
    });
  });
});
