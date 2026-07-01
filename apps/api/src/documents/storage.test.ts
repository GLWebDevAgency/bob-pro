import { describe, expect, it } from 'vitest';
import { InMemoryDocumentStorage } from './storage';

const BYTES = new Uint8Array([1, 2, 3]);
const SHA = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

describe('InMemoryDocumentStorage', () => {
  it('stocke sans écraser et retourne le sha256 réel', async () => {
    const storage = new InMemoryDocumentStorage();
    const key = `companies/co-1/documents/doc-1/v1/${SHA}.bin`;

    const stored = await storage.put({ companyId: 'co-1', key, bytes: BYTES, contentType: 'application/octet-stream' });

    expect(stored).toEqual({ key, sizeBytes: 3, sha256: SHA });
    await expect(storage.put({ companyId: 'co-1', key, bytes: BYTES, contentType: 'application/octet-stream' })).rejects.toThrow(
      'already exists',
    );
  });

  it('refuse une clé hors périmètre tenant', async () => {
    const storage = new InMemoryDocumentStorage();

    await expect(
      storage.put({
        companyId: 'co-1',
        key: `companies/co-2/documents/doc-1/v1/${SHA}.bin`,
        bytes: BYTES,
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow('outside tenant scope');
  });
});
