import { describe, expect, it } from 'vitest';
import { buildDocumentStorageKey, documentFileExtension } from './storage-key';

describe('document storage key', () => {
  it('préfère le MIME validé à une extension utilisateur trompeuse', () => {
    expect(documentFileExtension({ filename: 'preuve.exe', mimeType: 'image/jpeg' })).toBe('jpg');
    expect(buildDocumentStorageKey({
      companyId: 'co-1',
      documentId: 'doc-1',
      version: 1,
      sha256: 'a'.repeat(64),
      filename: 'preuve.exe',
      mimeType: 'image/jpeg',
    })).toBe(`companies/co-1/documents/doc-1/v1/${'a'.repeat(64)}.jpg`);
  });

  it('conserve une extension de nom bornée pour un type générique futur', () => {
    expect(documentFileExtension({ filename: 'archive.BOBFMT', mimeType: 'application/x-bob' })).toBe('bobfmt');
    expect(documentFileExtension({ filename: 'archive', mimeType: 'application/x-bob' })).toBe('bin');
  });
});
