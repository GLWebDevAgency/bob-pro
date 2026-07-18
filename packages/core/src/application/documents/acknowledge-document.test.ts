import { describe, expect, it } from 'vitest';
import { Document, type DocumentProps } from '../../domain/document/document';
import { type ClockPort } from '../ports/services';
import { type DocumentRepository } from '../ports/document-repository';
import { buildDocumentStorageKey } from './storage-key';
import { AcknowledgeDocument } from './acknowledge-document';

const SHA = 'a'.repeat(64);
const COMPANY = 'co-mercier';
const NOW = '2026-07-16T09:00:00.000Z';
const clock: ClockPort = { now: () => NOW, today: () => '2026-07-16' };

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

class MemoryDocuments implements Pick<DocumentRepository, 'findById' | 'markReviewed'> {
  readonly map = new Map<string, Document>();
  forceRevisionConflict = false;
  markReviewedCalls = 0;
  save(d: Document): void {
    this.map.set(d.id, d);
  }
  async markReviewed(
    input: Parameters<DocumentRepository['markReviewed']>[0],
  ): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    this.markReviewedCalls += 1;
    if (this.forceRevisionConflict) return 'revision_conflict';
    const current = this.map.get(input.documentId);
    if (!current || current.companyId !== input.companyId || current.status !== 'active') return 'not_found';
    if (current.revision !== input.expectedRevision) return 'revision_conflict';
    const next = Document.rehydrate(current.toProps());
    const result = next.markReviewed(input.reviewedAt);
    if (!result.ok) return 'revision_conflict';
    this.map.set(next.id, next);
    return 'saved';
  }
  async findById(companyId: string, id: string): Promise<Document | null> {
    const document = this.map.get(id);
    return document && document.companyId === companyId ? document : null;
  }
}

describe('AcknowledgeDocument (« c’est bon, je valide » — LOT 2)', () => {
  it('pose reviewedAt, incrémente la révision, sans déplacer ni lier', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument({ folderId: 'folder-achats' }));
    const uc = new AcknowledgeDocument({ documents, clock });

    const r = await uc.execute({ companyId: COMPANY, documentId: 'doc-leroy', expectedRevision: 1 });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.reviewedAt).toBe(NOW);
      expect(r.value.revision).toBe(2);
      // Le rangement et le (non-)rattachement restent strictement intacts.
      expect(r.value.folderId).toBe('folder-achats');
      expect(r.value.linkedEntityType).toBeNull();
      expect(r.value.linkedEntityId).toBeNull();
      expect(r.value.filename).toBe('recu-leroy-merlin.jpg');
    }
    expect((await documents.findById(COMPANY, 'doc-leroy'))?.reviewedAt).toBe(NOW);
  });

  it('idempotent : re-valider un document déjà confirmé ne réécrit rien (première validation conservée)', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument({ reviewedAt: '2026-07-10T08:00:00.000Z' }));
    const uc = new AcknowledgeDocument({ documents, clock });

    const r = await uc.execute({ companyId: COMPANY, documentId: 'doc-leroy', expectedRevision: 1 });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.reviewedAt).toBe('2026-07-10T08:00:00.000Z');
      expect(r.value.revision).toBe(1);
    }
    expect(documents.markReviewedCalls).toBe(0); // aucune écriture fantôme
  });

  it('refuse un document introuvable (ou hors tenant) et une révision invalide', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument());
    const uc = new AcknowledgeDocument({ documents, clock });

    const missing = await uc.execute({ companyId: COMPANY, documentId: 'inconnu', expectedRevision: 1 });
    expect(missing).toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const otherTenant = await uc.execute({ companyId: 'co-autre', documentId: 'doc-leroy', expectedRevision: 1 });
    expect(otherTenant).toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const badRevision = await uc.execute({ companyId: COMPANY, documentId: 'doc-leroy', expectedRevision: 0 });
    expect(badRevision).toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(documents.markReviewedCalls).toBe(0);
  });

  it('révision périmée (lecture stale) → conflit, sans mutation', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument({ revision: 3 }));
    const uc = new AcknowledgeDocument({ documents, clock });

    const r = await uc.execute({ companyId: COMPANY, documentId: 'doc-leroy', expectedRevision: 1 });

    expect(r).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect((await documents.findById(COMPANY, 'doc-leroy'))?.reviewedAt).toBeNull();
  });

  it('échoue sans mutation si le compare-and-set de persistance perd une course', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument());
    documents.forceRevisionConflict = true;
    const uc = new AcknowledgeDocument({ documents, clock });

    const r = await uc.execute({ companyId: COMPANY, documentId: 'doc-leroy', expectedRevision: 1 });

    expect(r).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect((await documents.findById(COMPANY, 'doc-leroy'))?.reviewedAt).toBeNull();
  });

  it('refuse de valider un document supprimé (erreur domaine)', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument({ id: 'doc-del', status: 'deleted', deletedAt: '2026-07-02T08:00:00.000Z' }));
    const uc = new AcknowledgeDocument({ documents, clock });

    const r = await uc.execute({ companyId: COMPANY, documentId: 'doc-del', expectedRevision: 1 });

    expect(r).toMatchObject({ ok: false, error: { kind: 'domain' } });
    expect(documents.markReviewedCalls).toBe(0);
  });
});
