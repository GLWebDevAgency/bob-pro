import { describe, expect, it } from 'vitest';
import type { DocumentStoragePort, LoadedStoredObject } from '../ports/document-storage';
import { loadVerifiedStoredObject } from './verified-stored-object';

const KEY = 'companies/co-1/documents/doc-1/v1/original.pdf';
const SHA = 'a'.repeat(64);
const BYTES = new Uint8Array([1, 2, 3]);

function storage(value: LoadedStoredObject | null | Error): DocumentStoragePort {
  return {
    put: async () => { throw new Error('unused'); },
    get: async () => {
      if (value instanceof Error) throw value;
      return value;
    },
    getSignedUrl: async () => { throw new Error('unused'); },
    stat: async () => null,
    remove: async () => undefined,
  };
}

function object(overrides: Partial<LoadedStoredObject> = {}): LoadedStoredObject {
  return {
    key: KEY,
    bytes: BYTES,
    sizeBytes: 3,
    sha256: SHA,
    contentType: 'application/pdf; charset=binary',
    ...overrides,
  };
}

const expected = {
  companyId: 'co-1',
  key: KEY,
  sizeBytes: 3,
  sha256: SHA,
  contentType: 'application/pdf',
};

describe('loadVerifiedStoredObject', () => {
  it('accepte uniquement l’original exact et normalise les paramètres MIME', async () => {
    const result = await loadVerifiedStoredObject(storage(object()), expected);
    expect(result).toEqual({ ok: true, value: object() });
  });

  it.each([
    ['absent', null],
    ['mauvaise clé', object({ key: `${KEY}-other` })],
    ['taille des octets fausse', object({ bytes: new Uint8Array([1, 2]) })],
    ['taille déclarée fausse', object({ sizeBytes: 2 })],
    ['SHA faux à taille identique', object({ sha256: 'b'.repeat(64) })],
    ['MIME faux', object({ contentType: 'image/png' })],
  ])('refuse fermé : %s', async (_label, value) => {
    const result = await loadVerifiedStoredObject(storage(value), expected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'dependency', port: 'document-storage' });
  });

  it('transforme une panne de stockage en erreur de dépendance explicite', async () => {
    const result = await loadVerifiedStoredObject(storage(new Error('storage down')), expected);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'document-storage', cause: 'storage down' },
    });
  });
});
