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
      error: { kind: 'dependency', port: 'bank-balance-snapshot-repository', cause: 'unavailable' },
    });
  });
});
