import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBobClient } from './http-client';

const SNAPSHOT = {
  id: 'balance-1',
  companyId: 'company-owner',
  amountCents: 456_789,
  currency: 'EUR',
  source: 'manual_confirmed',
  reconciliationStatus: 'unreconciled',
  observedAt: '2026-07-17T10:00:00.000Z',
  recordedAt: '2026-07-17T10:00:01.000Z',
  freshness: {
    status: 'fresh',
    ageSeconds: 1,
    maximumAgeSeconds: 86_400,
    policyVersion: 'bank-balance-freshness/1',
  },
  // Ajout ADDITIF : le constaté (456 789) + 60 000 encaissés − 12 000 réglés = 504 789 estimés.
  position: {
    companyId: 'company-owner',
    observedBalanceCents: 456_789,
    observedAt: '2026-07-17T10:00:00.000Z',
    observationSource: 'manual_confirmed',
    estimatedAt: '2026-07-18T09:00:00.000Z',
    estimatedBalanceCents: 504_789,
    movements: {
      inflowCents: 60_000,
      outflowCents: 12_000,
      netCents: 48_000,
      inflowCount: 1,
      outflowCount: 1,
      ignoredBeforeObservationCount: 2,
    },
  },
};

describe('HttpBobClient — preuve bancaire persistée', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lit la dernière preuve dans le tenant authentifié', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/bank-balance');
      expect(init?.method).toBe('GET');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer owner-token');
      expect(headers.has('x-company-id')).toBe(false);
      return new Response(JSON.stringify(SNAPSHOT), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    await expect(client.getLatestBankBalance()).resolves.toEqual({ ok: true, value: SNAPSHOT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('envoie uniquement le montant exact et la date observée', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/bank-balance/manual');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        amountCents: -12_345,
        observedAt: '2026-07-17T10:00:00.000Z',
      });
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer owner-token');
      expect(headers.has('x-company-id')).toBe(false);
      return new Response(JSON.stringify({ ...SNAPSHOT, amountCents: -12_345 }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    const result = await client.recordManualBankBalance({
      amountCents: -12_345,
      observedAt: '2026-07-17T10:00:00.000Z',
    });

    expect(result).toEqual({ ok: true, value: { ...SNAPSHOT, amountCents: -12_345 } });
  });

  it('ne transforme pas une panne BDD en solde local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                kind: 'dependency',
                port: 'bank-balance-snapshot-repository',
                cause: 'unavailable',
              },
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

    await expect(client.getLatestBankBalance()).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'bank-balance-snapshot-repository',
        cause: 'unavailable',
        code: 'BOB-API-502',
        correlationId: expect.stringMatching(/^[0-9a-f-]{8,64}$/),
      },
    });
  });
});

describe('HttpBobClient — position de trésorerie (ajout additif)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('remonte les DEUX nombres : le constaté daté et l’estimé qui en découle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(SNAPSHOT), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
    });

    const result = await client.getLatestBankBalance();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Le fait ne bouge pas ; l'estimation le complète. C'est l'écart que le fondateur voyait
    // manquer quand il marquait une facture payée et que le solde restait figé.
    expect(result.value.amountCents).toBe(456_789);
    expect(result.value.position?.observedBalanceCents).toBe(456_789);
    expect(result.value.position?.estimatedBalanceCents).toBe(504_789);
    expect(result.value.position?.movements.netCents).toBe(48_000);
  });

  it('accepte position: null (projection des mouvements indisponible) sans perdre le constaté', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...SNAPSHOT, position: null }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
    });

    const result = await client.getLatestBankBalance();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.position).toBeNull();
    expect(result.value.amountCents).toBe(456_789);
  });
});
