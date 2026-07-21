import { describe, expect, it } from 'vitest';
import { Document } from '@bob/core';
import { InMemoryDocumentRepository } from './in-memory';

const SHA = 'a'.repeat(64);

function document(): Document {
  const result = Document.record({
    id: 'doc-1',
    companyId: 'co-1',
    kind: 'other',
    origin: 'uploaded',
    status: 'active',
    filename: 'original.pdf',
    displayName: 'Original',
    mimeType: 'application/pdf',
    byteSize: 42,
    sha256: SHA,
    storageKey: `companies/co-1/documents/doc-1/v1/${SHA}.pdf`,
    folderId: null,
    revision: 1,
    linkedEntityType: null,
    linkedEntityId: null,
    documentDate: '2026-07-21',
    issuedAt: null,
    createdAt: '2026-07-21T08:00:00.000Z',
    createdBy: 'owner-1',
    retentionUntil: '2036-07-21',
    deletedAt: null,
    tags: [],
    reviewedAt: null,
    versions: [{
      id: 'doc-1-v1',
      documentId: 'doc-1',
      version: 1,
      storageKey: `companies/co-1/documents/doc-1/v1/${SHA}.pdf`,
      sha256: SHA,
      mimeType: 'application/pdf',
      byteSize: 42,
      createdAt: '2026-07-21T08:00:00.000Z',
      reason: 'original',
    }],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe('InMemoryDocumentRepository folder membership CAS', () => {
  it('n’autorise qu’un gagnant depuis la même révision', () => {
    const repository = new InMemoryDocumentRepository().seed(document());
    const first = Document.rehydrate(document().toProps());
    const second = Document.rehydrate(document().toProps());
    expect(first.moveToFolder('folder-1').ok).toBe(true);
    expect(second.moveToFolder('folder-2').ok).toBe(true);

    expect(repository.replaceFolderMembershipIfRevision(first, 1)).toBe('saved');
    expect(repository.replaceFolderMembershipIfRevision(second, 1)).toBe('revision_conflict');
  });

  it('refuse toute mutation hors dossier et validation', () => {
    const repository = new InMemoryDocumentRepository().seed(document());
    const props = document().toProps();
    const changed = Document.rehydrate({
      ...props,
      filename: 'autre-original.pdf',
    });

    expect(() => repository.replaceFolderMembershipIfRevision(changed, 1)).toThrow(
      'non-folder document facts changed',
    );
  });

  it('déplace un document multi-version sans altérer son historique', () => {
    const multiVersion = document();
    const secondSha = 'b'.repeat(64);
    expect(multiVersion.addVersion({
      id: 'doc-1-v2',
      documentId: 'doc-1',
      version: 2,
      storageKey: `companies/co-1/documents/doc-1/v2/${secondSha}.pdf`,
      sha256: secondSha,
      mimeType: 'application/pdf',
      byteSize: 84,
      createdAt: '2026-07-21T09:00:00.000Z',
      reason: 'nouvelle version',
    }).ok).toBe(true);
    const repository = new InMemoryDocumentRepository().seed(multiVersion);
    const moved = Document.rehydrate(multiVersion.toProps());
    expect(moved.moveToFolder('folder-archive').ok).toBe(true);

    expect(repository.replaceFolderMembershipIfRevision(moved, 2)).toBe('saved');
    expect(repository.snapshot()[0]).toMatchObject({
      folderId: 'folder-archive',
      revision: 3,
    });
    expect(repository.snapshot()[0]?.versions).toHaveLength(2);
  });
});
