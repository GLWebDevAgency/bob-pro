import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBobClient } from './http-client';

describe('HttpBobClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports FEC files with authoritative metadata from the API', async () => {
    const metadata = {
      filename: '732829320FEC20261231.txt',
      descriptionFilename: '732829320FEC20261231-description.txt',
      entryCount: 7,
      rowCount: 19,
      warnings: ['Compte 411 absent du plan comptable.'],
    };
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/accounting/fec-metadata?')) {
        return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/accounting/fec-description?')) {
        return new Response('Descriptif FEC\n', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': 'attachment; filename="732829320FEC20261231-description.txt"',
          },
        });
      }
      if (url.includes('/accounting/fec?')) {
        return new Response('JournalCode\tEcritureNum\nVE\t1\n', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': 'attachment; filename="732829320FEC20261231.txt"',
          },
        });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-mercier',
      getToken: async () => 'test-token',
    });

    const r = await client.exportFec({ from: '2026-01-01', to: '2026-12-31' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.value.filename).toBe(metadata.filename);
    expect(r.value.descriptionFilename).toBe(metadata.descriptionFilename);
    expect(r.value.entryCount).toBe(metadata.entryCount);
    expect(r.value.rowCount).toBe(metadata.rowCount);
    expect(r.value.warnings).toEqual(metadata.warnings);
    expect(r.value.content).toContain('JournalCode');
    expect(r.value.descriptionContent).toContain('Descriptif FEC');
  });

  it("loads a payment accounting preview for an invoice", async () => {
    const preview = {
      invoiceId: 'inv-1',
      available: true,
      reason: null,
      reference: 'F-2026-0001',
      amountCents: 12000,
      remainingCents: 12000,
      method: 'transfer',
      totalDebitCents: 12000,
      totalCreditCents: 12000,
      lines: [
        { account: '512', label: 'Encaissement F-2026-0001', debitCents: 12000, creditCents: 0 },
        { account: '411', label: 'Encaissement F-2026-0001', debitCents: 0, creditCents: 12000 },
      ],
    };
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://api.bob.test/invoices/inv-1/payment-accounting-preview?amount=12000&method=transfer') {
        return new Response(JSON.stringify(preview), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    const r = await client.paymentAccountingPreview({ invoiceId: 'inv-1', amountCents: 12000, method: 'transfer' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.value).toEqual(preview);
  });

  it('loads expense defaults from the API memory endpoint', async () => {
    const defaults = {
      supplierName: 'Leroy Merlin',
      supplierSiren: '552100554',
      category: 'materiel',
      vatRatePct: 20,
      source: 'memory',
    };
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.bob.test/expenses/defaults') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({ supplierName: 'Leroy Merlin', categoryGuess: 'autre' });
        return new Response(JSON.stringify(defaults), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    const r = await client.suggestExpenseDefaults({
      supplierName: 'Leroy Merlin',
      supplierSiren: null,
      vatRatePctApplied: null,
      categoryGuess: 'autre',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(defaults);
  });
});
