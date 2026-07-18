import { describe, expect, it } from 'vitest';
import { Document, type DocumentProps } from '../../domain/document/document';
import { type DocumentRepository } from '../ports/document-repository';
import { buildDocumentStorageKey } from './storage-key';
import { ClassifyDocument } from './classify-document';

const SHA = 'a'.repeat(64);
const COMPANY = 'co-mercier';
const existingLinkTargets = { exists: async () => true };

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
    tags: [],
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
  forceRevisionConflict = false;
  async save(d: Document): Promise<void> {
    this.map.set(d.id, d);
  }
  async classify(
    input: Parameters<DocumentRepository['classify']>[0],
  ): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    if (this.forceRevisionConflict) return 'revision_conflict';
    const current = this.map.get(input.documentId);
    if (!current || current.companyId !== input.companyId || current.status !== 'active') return 'not_found';
    if (current.revision !== input.expectedRevision) return 'revision_conflict';
    const next = Document.rehydrate(current.toProps());
    const result = next.classify({
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId,
    });
    if (!result.ok) return 'revision_conflict';
    this.map.set(next.id, next);
    return 'saved';
  }
  async rename(
    input: Parameters<DocumentRepository['rename']>[0],
  ): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    if (this.forceRevisionConflict) return 'revision_conflict';
    const current = this.map.get(input.documentId);
    if (!current || current.companyId !== input.companyId || current.status !== 'active') return 'not_found';
    if (current.revision !== input.expectedRevision) return 'revision_conflict';
    const next = Document.rehydrate(current.toProps());
    const result = next.rename(input.displayName);
    if (!result.ok) return 'revision_conflict';
    this.map.set(next.id, next);
    return 'saved';
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
    const uc = new ClassifyDocument({ documents, linkTargets: existingLinkTargets });

    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-leroy',
      expectedRevision: 1,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.linkedEntityType).toBe('expense');
      expect(r.value.linkedEntityId).toBe('exp-leroy');
      expect(r.value.revision).toBe(2);
    }
    const saved = await documents.findById(COMPANY, 'doc-leroy');
    expect(saved?.toProps().linkedEntityId).toBe('exp-leroy');

    const replay = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: ' exp-leroy ',
      expectedRevision: 2,
    });
    expect(replay.ok && replay.value.revision).toBe(2);

    const stale = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-autre',
      expectedRevision: 1,
    });
    expect(stale).toMatchObject({ ok: false, error: { kind: 'conflict' } });
  });

  it('refuse un document introuvable (ou hors tenant)', async () => {
    const uc = new ClassifyDocument({ documents: new MemoryDocuments(), linkTargets: existingLinkTargets });
    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'inconnu',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-1',
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('refuse un rattachement incomplet (invariant du domaine)', async () => {
    const documents = new MemoryDocuments();
    await documents.save(makeDocument());
    const uc = new ClassifyDocument({ documents, linkTargets: existingLinkTargets });
    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: '',
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
  });

  it('refuse de classer un document supprimé', async () => {
    const documents = new MemoryDocuments();
    await documents.save(
      makeDocument({ id: 'doc-del', status: 'deleted', deletedAt: '2026-07-02T08:00:00.000Z' }),
    );
    const uc = new ClassifyDocument({ documents, linkTargets: existingLinkTargets });
    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-del',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-1',
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
  });

  it('échoue sans mutation si le compare-and-set de persistance perd une course', async () => {
    const documents = new MemoryDocuments();
    await documents.save(makeDocument());
    documents.forceRevisionConflict = true;

    const result = await new ClassifyDocument({ documents, linkTargets: existingLinkTargets }).execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-concurrente',
      expectedRevision: 1,
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect((await documents.findById(COMPANY, 'doc-leroy'))?.toProps().linkedEntityId).toBeNull();
  });

  it('refuse une cible métier absente sans muter le document ni lancer le compare-and-set', async () => {
    const documents = new MemoryDocuments();
    await documents.save(makeDocument());
    const classify = documents.classify.bind(documents);
    let classifyCalls = 0;
    documents.classify = async (input) => {
      classifyCalls += 1;
      return classify(input);
    };

    const result = await new ClassifyDocument({
      documents,
      linkTargets: { exists: async () => false },
    }).execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      linkedEntityType: 'expense',
      linkedEntityId: 'exp-absente',
      expectedRevision: 1,
    });

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', entity: 'expense', id: 'exp-absente' } });
    expect(classifyCalls).toBe(0);
    expect((await documents.findById(COMPANY, 'doc-leroy'))?.toProps()).toMatchObject({
      linkedEntityType: null,
      linkedEntityId: null,
      revision: 1,
    });
  });
});
