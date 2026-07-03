import { describe, expect, it } from 'vitest';
import { Document, type DocumentProps } from '../../domain/document/document';
import { type DocumentRepository } from '../ports/document-repository';
import { buildDocumentStorageKey } from './storage-key';
import { ClassifyDocument } from './classify-document';

const SHA = 'a'.repeat(64);
const COMPANY = 'co-mercier';

function makeDocument(over: Partial<DocumentProps> = {}): Document {
  const id = over.id ?? 'doc-leroy';
  const storageKey = buildDocumentStorageKey({
    companyId: COMPANY,
    documentId: id,
    version: 1,
    sha256: SHA,
    filename: 'recu-leroy-merlin.jpg',
    mimeType: 'image/jpeg',
  });
  const props: DocumentProps = {
    id,
    companyId: COMPANY,
    kind: 'expense_receipt',
    origin: 'ocr',
    status: 'active',
    filename: 'recu-leroy-merlin.jpg',
    mimeType: 'image/jpeg',
    byteSize: 3,
    sha256: SHA,
    storageKey,
    linkedEntityType: null,
    linkedEntityId: null,
    documentDate: '2026-07-01',
    issuedAt: null,
    createdAt: '2026-07-01T08:00:00.000Z',
    createdBy: 'local',
    deletedAt: null,
    retentionUntil: '2036-07-01',
    versions: [
      {
        id: `${id}-v1`,
        documentId: id,
        version: 1,
        storageKey,
        sha256: SHA,
        mimeType: 'image/jpeg',
        byteSize: 3,
        createdAt: '2026-07-01T08:00:00.000Z',
        reason: 'scan initial',
      },
    ],
    ...over,
  };
  const r = Document.record(props);
  if (!r.ok) throw new Error(`fixture invalide: ${JSON.stringify(r.error)}`);
  return r.value;
}

class MemoryDocuments implements DocumentRepository {
  readonly map = new Map<string, Document>();
  async save(d: Document): Promise<void> {
    this.map.set(d.id, d);
  }
  async findById(companyId: string, id: string): Promise<Document | null> {
    const document = this.map.get(id);
    return document && document.companyId === companyId ? document : null;
  }
  async findByEntity(): Promise<Document[]> {
    return [];
  }
  async listByCompany(companyId: string): Promise<Document[]> {
    return [...this.map.values()].filter((d) => d.companyId === companyId);
  }
  async listExpired(): Promise<Document[]> {
    return [];
  }
}

describe('ClassifyDocument (A1-C14 — confirmation du classement proposé après OCR)', () => {
  it('rattache le document à la dépense et persiste (sort d’« À valider »)', async () => {
    const documents = new MemoryDocuments();
    await documents.save(makeDocument());
    const uc = new ClassifyDocument({ documents });

    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-leroy',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.linkedEntityType).toBe('expense');
      expect(r.value.linkedEntityId).toBe('exp-leroy');
    }
    const saved = await documents.findById(COMPANY, 'doc-leroy');
    expect(saved?.toProps().linkedEntityId).toBe('exp-leroy');
  });

  it('refuse un document introuvable (ou hors tenant)', async () => {
    const uc = new ClassifyDocument({ documents: new MemoryDocuments() });
    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'inconnu',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('refuse un rattachement incomplet (invariant du domaine)', async () => {
    const documents = new MemoryDocuments();
    await documents.save(makeDocument());
    const uc = new ClassifyDocument({ documents });
    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: '',
    });
    expect(r.ok).toBe(false);
  });

  it('refuse de classer un document supprimé', async () => {
    const documents = new MemoryDocuments();
    await documents.save(
      makeDocument({ id: 'doc-del', status: 'deleted', deletedAt: '2026-07-02T08:00:00.000Z' }),
    );
    const uc = new ClassifyDocument({ documents });
    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-del',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-1',
    });
    expect(r.ok).toBe(false);
  });
});
