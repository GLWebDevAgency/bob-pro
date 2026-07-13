import { describe, expect, it } from 'vitest';
import { type Document } from '../../domain/document/document';
import { DocumentFolder } from '../../domain/document/document-folder';
import { type DocumentRepository } from '../ports/document-repository';
import { type DocumentStoragePort, type StoredObject } from '../ports/document-storage';
import { type ClockPort } from '../ports/services';
import { type DocumentDownloadUrl, GetDocumentDownloadUrl } from './get-document-download-url';
import { ListDocuments } from './list-documents';
import { buildDocumentStorageKey } from './storage-key';
import { StoreDocument } from './store-document';

const BYTES = new Uint8Array([1, 2, 3]);
const SHA = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
const OTHER_SHA = 'b'.repeat(64);

const clock: ClockPort = {
  now: () => '2026-06-01T10:00:00.000Z',
  today: () => '2026-06-01',
};

const existingLinkTargets = { exists: async () => true };
const sameTenantFolder = DocumentFolder.create({
  id: 'folder-same',
  companyId: 'co-1',
  name: 'Achats',
  now: clock.now(),
});
const crossTenantFolder = DocumentFolder.create({
  id: 'folder-cross',
  companyId: 'co-2',
  name: 'Privé',
  now: clock.now(),
});
const inactiveFolder = DocumentFolder.create({
  id: 'folder-inactive',
  companyId: 'co-1',
  name: 'Archivé',
  now: clock.now(),
});
if (!sameTenantFolder.ok || !crossTenantFolder.ok || !inactiveFolder.ok) throw new Error('fixture dossier invalide');
inactiveFolder.value.markDeleted('2026-06-01T11:00:00.000Z');
const existingFolders = {
  findById: async (companyId: string, folderId: string) => {
    const folder = folderId === sameTenantFolder.value.id
      ? sameTenantFolder.value
      : folderId === crossTenantFolder.value.id
        ? crossTenantFolder.value
        : folderId === inactiveFolder.value.id
          ? inactiveFolder.value
        : null;
    return folder?.companyId === companyId ? folder : null;
  },
};

class MemoryDocuments implements DocumentRepository {
  readonly map = new Map<string, Document>();
  async save(d: Document): Promise<void> {
    this.map.set(d.id, d);
  }
  async classify(): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    return 'not_found';
  }
  async findById(companyId: string, id: string): Promise<Document | null> {
    const document = this.map.get(id);
    return document && document.companyId === companyId ? document : null;
  }
  async findByEntity(companyId: string, entityType: string, entityId: string): Promise<Document[]> {
    return [...this.map.values()].filter((d) => {
      const p = d.toProps();
      return p.companyId === companyId && p.linkedEntityType === entityType && p.linkedEntityId === entityId;
    });
  }
  async listByCompany(companyId: string): Promise<Document[]> {
    return [...this.map.values()].filter((d) => d.companyId === companyId);
  }
  async listExpired(now: string): Promise<Document[]> {
    return [...this.map.values()].filter((d) => d.retentionUntil <= now);
  }
}

class MemoryStorage implements DocumentStoragePort {
  readonly objects = new Map<string, { companyId: string; bytes: Uint8Array; contentType: string }>();
  readonly removed: string[] = [];
  constructor(private readonly storedSha = SHA) {}
  async put(input: { companyId: string; key: string; bytes: Uint8Array; contentType: string }): Promise<StoredObject> {
    this.objects.set(input.key, { companyId: input.companyId, bytes: input.bytes, contentType: input.contentType });
    return { key: input.key, sizeBytes: input.bytes.byteLength, sha256: this.storedSha };
  }
  async get(companyId: string, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const object = this.objects.get(key);
    return object && object.companyId === companyId ? { bytes: object.bytes, contentType: object.contentType } : null;
  }
  async getSignedUrl(companyId: string, key: string, ttlSeconds: number): Promise<string> {
    return `signed://${companyId}/${key}?ttl=${ttlSeconds}`;
  }
  async stat(companyId: string, key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
    const object = this.objects.get(key);
    return object && object.companyId === companyId ? { sizeBytes: object.bytes.byteLength, contentType: object.contentType } : null;
  }
  async remove(_companyId: string, key: string): Promise<void> {
    this.removed.push(key);
    this.objects.delete(key);
  }
}

function input() {
  const storageKey = buildDocumentStorageKey({
    companyId: 'co-1',
    documentId: 'doc-1',
    version: 1,
    sha256: SHA,
    filename: 'ticket.jpg',
    mimeType: 'image/jpeg',
  });
  return {
    id: 'doc-1',
    versionId: 'ver-1',
    companyId: 'co-1',
    kind: 'expense_receipt' as const,
    origin: 'uploaded' as const,
    filename: 'ticket.jpg',
    mimeType: 'image/jpeg',
    bytes: BYTES,
    sha256: SHA,
    storageKey,
    linkedEntityType: 'expense' as const,
    linkedEntityId: 'exp-1',
    documentDate: '2026-05-30',
  };
}

describe('documents application use cases', () => {
  it('stocke les bytes, persiste les métadonnées et expose une URL signée', async () => {
    const documents = new MemoryDocuments();
    const storage = new MemoryStorage();
    const stored = await new StoreDocument({
      documents,
      folders: existingFolders,
      linkTargets: existingLinkTargets,
      storage,
      clock,
    }).execute(input());

    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value).toMatchObject({
      id: 'doc-1',
      kind: 'expense_receipt',
      origin: 'uploaded',
      version: 1,
      retentionUntil: '2036-05-30',
    });

    const list = await new ListDocuments({ documents }).execute({
      companyId: 'co-1',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-1',
    });
    expect(list.ok && list.value.map((d) => d.id)).toEqual(['doc-1']);

    const signed = await new GetDocumentDownloadUrl({ documents, storage }).execute({
      companyId: 'co-1',
      documentId: 'doc-1',
      ttlSeconds: 120,
    });
    expect(signed.ok).toBe(true);
    if (signed.ok) {
      const value: DocumentDownloadUrl = signed.value;
      expect(value.url).toContain('ttl=120');
      expect(value.filename).toBe('ticket.jpg');
    }
  });

  it('compense le stockage objet si le sha retourné ne correspond pas', async () => {
    const documents = new MemoryDocuments();
    const storage = new MemoryStorage(OTHER_SHA);
    const stored = await new StoreDocument({
      documents,
      folders: existingFolders,
      linkTargets: existingLinkTargets,
      storage,
      clock,
    }).execute(input());

    expect(stored.ok).toBe(false);
    if (!stored.ok) expect(stored.error.kind).toBe('dependency');
    expect(documents.map.size).toBe(0);
    expect(storage.objects.size).toBe(0);
    expect(storage.removed).toEqual([input().storageKey]);
  });

  it('refuse une cible métier absente avant toute écriture objet ou métadonnée', async () => {
    const documents = new MemoryDocuments();
    const storage = new MemoryStorage();
    const stored = await new StoreDocument({
      documents,
      folders: existingFolders,
      linkTargets: { exists: async () => false },
      storage,
      clock,
    }).execute(input());

    expect(stored).toEqual({ ok: false, error: { kind: 'not_found', entity: 'expense', id: 'exp-1' } });
    expect(documents.map.size).toBe(0);
    expect(storage.objects.size).toBe(0);
  });

  it('accepte uniquement un dossier actif du même tenant avant l’écriture objet', async () => {
    const sameTenantStorage = new MemoryStorage();
    const sameTenant = await new StoreDocument({
      documents: new MemoryDocuments(),
      folders: existingFolders,
      linkTargets: existingLinkTargets,
      storage: sameTenantStorage,
      clock,
    }).execute({ ...input(), folderId: sameTenantFolder.value.id });

    expect(sameTenant.ok && sameTenant.value.folderId).toBe(sameTenantFolder.value.id);
    expect(sameTenantStorage.objects.size).toBe(1);

    for (const folderId of ['folder-missing', crossTenantFolder.value.id, inactiveFolder.value.id]) {
      const documents = new MemoryDocuments();
      const storage = new MemoryStorage();
      const rejected = await new StoreDocument({
        documents,
        folders: existingFolders,
        linkTargets: existingLinkTargets,
        storage,
        clock,
      }).execute({ ...input(), folderId });

      expect(rejected).toEqual({
        ok: false,
        error: { kind: 'not_found', entity: 'document_folder', id: folderId },
      });
      expect(documents.map.size).toBe(0);
      expect(storage.objects.size).toBe(0);
    }
  });
});
