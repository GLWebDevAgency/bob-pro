import { describe, expect, it } from 'vitest';
import { DocumentFolder, normalizeDocumentFolderName, validateDocumentFolderName } from './document-folder';

const NOW = '2026-07-13T10:00:00.000Z';

describe('DocumentFolder', () => {
  it('normalise le nom pour garantir une unicité lisible', () => {
    expect(normalizeDocumentFolderName('  Fiscal   &  Social  ')).toBe('fiscal & social');
    expect(normalizeDocumentFolderName('ASSURANCES')).toBe('assurances');
  });

  it('refuse les noms dangereux et un parent identique', () => {
    expect(DocumentFolder.create({ id: 'f-1', companyId: 'co-1', name: '../secret', now: NOW }).ok).toBe(false);
    expect(DocumentFolder.create({ id: 'f-1', companyId: 'co-1', parentId: 'f-1', name: 'Dossier', now: NOW }).ok).toBe(false);
    expect(validateDocumentFolderName(undefined).ok).toBe(false);
  });

  it('versionne les mutations pour le contrôle de concurrence', () => {
    const result = DocumentFolder.create({ id: 'f-1', companyId: 'co-1', name: 'Contrats', now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revision).toBe(1);
    expect(result.value.rename('Contrats clients', '2026-07-13T10:05:00.000Z').ok).toBe(true);
    expect(result.value.revision).toBe(2);
    expect(result.value.markDeleted('2026-07-13T10:06:00.000Z').ok).toBe(true);
    expect(result.value.revision).toBe(3);
    expect(result.value.toProps().deletedAt).toBe('2026-07-13T10:06:00.000Z');
  });
});
