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
});
