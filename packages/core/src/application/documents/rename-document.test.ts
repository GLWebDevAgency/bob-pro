import { describe, expect, it } from 'vitest';
import { Document, type DocumentProps } from '../../domain/document/document';
import { type DocumentRepository } from '../ports/document-repository';
import { buildDocumentStorageKey } from './storage-key';
import { RenameDocument } from './rename-document';

const SHA = 'a'.repeat(64);
const COMPANY = 'co-mercier';

function makeDocument(over: Partial<DocumentProps> = {}): Document {
  const id = over.id ?? 'doc-leroy';
  const storageKey = buildDocumentStorageKey({
    companyId: COMPANY,
    documentId: id,
    version: 1,
    sha256: SHA,
    filename: 'scan-2026-07-01-083012.jpg',
    mimeType: 'image/jpeg',
  });
  const props: DocumentProps = {
    id,
    companyId: COMPANY,
    kind: 'expense_receipt',
    origin: 'ocr',
    status: 'active',
    filename: 'scan-2026-07-01-083012.jpg',
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

class MemoryDocuments implements Pick<DocumentRepository, 'findById' | 'rename'> {
  readonly map = new Map<string, Document>();
  forceRevisionConflict = false;
  renameCalls = 0;
  save(d: Document): void {
    this.map.set(d.id, d);
  }
  async rename(
    input: Parameters<DocumentRepository['rename']>[0],
  ): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    this.renameCalls += 1;
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
}

describe('RenameDocument (libellé d’affichage — le filename d’archive reste immuable)', () => {
  it('renomme, incrémente la révision et laisse le filename d’archive intact', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument());
    const uc = new RenameDocument({ documents });

    const r = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      displayName: '  Facture Leroy Merlin — 184,90 €  ',
      expectedRevision: 1,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.displayName).toBe('Facture Leroy Merlin — 184,90 €');
      expect(r.value.filename).toBe('scan-2026-07-01-083012.jpg');
      expect(r.value.revision).toBe(2);
    }
    const saved = await documents.findById(COMPANY, 'doc-leroy');
    expect(saved?.displayName).toBe('Facture Leroy Merlin — 184,90 €');
    expect(saved?.toProps().filename).toBe('scan-2026-07-01-083012.jpg');
  });

  it('rejoue sans écriture quand le libellé est identique (idempotence)', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument());
    const uc = new RenameDocument({ documents });

    await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      displayName: 'Facture Leroy Merlin',
      expectedRevision: 1,
    });
    const callsAfterFirst = documents.renameCalls;
    const replay = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      displayName: 'Facture Leroy Merlin',
      expectedRevision: 2,
    });

    expect(replay.ok && replay.value.revision).toBe(2);
    expect(documents.renameCalls).toBe(callsAfterFirst);
  });

  it('refuse une révision périmée (conflit optimiste) sans muter le document', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument());
    const uc = new RenameDocument({ documents });
    await uc.execute({ companyId: COMPANY, documentId: 'doc-leroy', displayName: 'Nom actuel', expectedRevision: 1 });

    const stale = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      displayName: 'Autre nom',
      expectedRevision: 1,
    });

    expect(stale).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect((await documents.findById(COMPANY, 'doc-leroy'))?.displayName).toBe('Nom actuel');
  });

  it('refuse un document introuvable (ou hors tenant) et une révision invalide', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument());
    const uc = new RenameDocument({ documents });

    const missing = await uc.execute({ companyId: COMPANY, documentId: 'inconnu', displayName: 'X y z', expectedRevision: 1 });
    expect(missing).toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const otherTenant = await uc.execute({ companyId: 'co-autre', documentId: 'doc-leroy', displayName: 'X y z', expectedRevision: 1 });
    expect(otherTenant).toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const badRevision = await uc.execute({ companyId: COMPANY, documentId: 'doc-leroy', displayName: 'X y z', expectedRevision: 0 });
    expect(badRevision).toMatchObject({ ok: false, error: { kind: 'validation' } });
  });

  it('refuse un libellé invalide (vide, trop long) via le domaine', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument());
    const uc = new RenameDocument({ documents });

    const empty = await uc.execute({ companyId: COMPANY, documentId: 'doc-leroy', displayName: '   ', expectedRevision: 1 });
    expect(empty).toMatchObject({ ok: false, error: { kind: 'domain' } });

    const tooLong = await uc.execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      displayName: 'x'.repeat(200),
      expectedRevision: 1,
    });
    expect(tooLong).toMatchObject({ ok: false, error: { kind: 'domain' } });
    expect(documents.renameCalls).toBe(0);
  });

  it('refuse de renommer un document supprimé', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument({ id: 'doc-del', status: 'deleted', deletedAt: '2026-07-02T08:00:00.000Z' }));
    const uc = new RenameDocument({ documents });

    const r = await uc.execute({ companyId: COMPANY, documentId: 'doc-del', displayName: 'Nouveau nom', expectedRevision: 1 });
    expect(r.ok).toBe(false);
  });

  it('échoue sans mutation si le compare-and-set de persistance perd une course', async () => {
    const documents = new MemoryDocuments();
    documents.save(makeDocument());
    documents.forceRevisionConflict = true;

    const result = await new RenameDocument({ documents }).execute({
      companyId: COMPANY,
      documentId: 'doc-leroy',
      displayName: 'Nom concurrent',
      expectedRevision: 1,
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect((await documents.findById(COMPANY, 'doc-leroy'))?.displayName).toBe('scan-2026-07-01-083012.jpg');
  });
});
