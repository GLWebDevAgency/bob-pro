import { describe, expect, it } from 'vitest';
import {
  DocumentFolder,
  type DocumentFolderProps,
  type DocumentFolderSystemKey,
} from '../../domain/document/document-folder';
import { ok } from '../../shared-kernel/result';
import { type ClockPort, type IdGeneratorPort, type UnitOfWorkPort } from '../ports/services';
import {
  type DocumentFolderMembership,
  type DocumentFolderMembershipWriteResult,
  type DocumentFolderPage,
  type DocumentFolderRepository,
  type DocumentFolderWriteResult,
} from '../ports/document-folder-repository';
import {
  CreateDocumentFolder,
  DeleteDocumentFolder,
  DOCUMENT_FOLDER_MAX_DEPTH,
  ListDocumentFolders,
  MoveDocumentFolder,
  MoveDocumentToFolder,
  PreviewDeleteDocumentFolder,
  RenameDocumentFolder,
} from './document-folders';

const COMPANY = 'co-1';
const NOW = '2026-07-13T12:00:00.000Z';
const clock: ClockPort = { now: () => NOW, today: () => '2026-07-13' };

function cloneFolder(folder: DocumentFolder): DocumentFolder {
  return DocumentFolder.rehydrate(folder.toProps());
}

function makeFolder(input: {
  id: string;
  name?: string;
  parentId?: string | null;
  companyId?: string;
  systemKey?: DocumentFolderSystemKey | null;
}): DocumentFolder {
  const created = DocumentFolder.create({
    id: input.id,
    companyId: input.companyId ?? COMPANY,
    parentId: input.parentId ?? null,
    name: input.name ?? input.id,
    systemKey: input.systemKey ?? null,
    now: NOW,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return created.value;
}

class MemoryFolderRepository implements DocumentFolderRepository {
  folders = new Map<string, DocumentFolder>();
  documents = new Map<string, DocumentFolderMembership>();

  seed(...folders: DocumentFolder[]): void {
    for (const folder of folders) this.folders.set(folder.id, cloneFolder(folder));
  }

  snapshot(): { folders: DocumentFolderProps[]; documents: DocumentFolderMembership[] } {
    return {
      folders: [...this.folders.values()].map((folder) => folder.toProps()),
      documents: [...this.documents.values()].map((document) => ({ ...document })),
    };
  }

  restore(snapshot: ReturnType<MemoryFolderRepository['snapshot']>): void {
    this.folders = new Map(snapshot.folders.map((props) => [props.id, DocumentFolder.rehydrate(props)]));
    this.documents = new Map(snapshot.documents.map((document) => [document.id, { ...document }]));
  }

  async findById(companyId: string, folderId: string): Promise<DocumentFolder | null> {
    const folder = this.folders.get(folderId);
    return folder?.companyId === companyId ? cloneFolder(folder) : null;
  }

  async listActiveAncestors(companyId: string, folderId: string): Promise<DocumentFolder[]> {
    const chain: DocumentFolder[] = [];
    let current = this.folders.get(folderId);
    const seen = new Set<string>();
    while (current && current.companyId === companyId && current.status === 'active' && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(cloneFolder(current));
      current = current.parentId === null ? undefined : this.folders.get(current.parentId);
    }
    if (chain.length === 0 || (chain.at(-1)?.parentId !== null && current === undefined)) return [];
    return chain.reverse();
  }

  async listActiveSubtree(companyId: string, folderId: string): Promise<DocumentFolder[]> {
    const root = this.folders.get(folderId);
    if (!root || root.companyId !== companyId || root.status !== 'active') return [];
    const result: DocumentFolder[] = [];
    const pending = [root.id];
    while (pending.length > 0) {
      const id = pending.shift()!;
      const folder = this.folders.get(id);
      if (!folder || folder.companyId !== companyId || folder.status !== 'active') continue;
      result.push(cloneFolder(folder));
      pending.push(
        ...[...this.folders.values()]
          .filter((candidate) => candidate.companyId === companyId && candidate.status === 'active' && candidate.parentId === id)
          .map((candidate) => candidate.id),
      );
    }
    return result;
  }

  async listChildren(input: {
    companyId: string;
    parentId: string | null;
    limit: number;
    cursor?: string | null;
  }): Promise<DocumentFolderPage> {
    const all = [...this.folders.values()]
      .filter((folder) => folder.companyId === input.companyId && folder.status === 'active' && folder.parentId === input.parentId)
      .sort((a, b) => a.toProps().normalizedName.localeCompare(b.toProps().normalizedName) || a.id.localeCompare(b.id));
    const offset = input.cursor ? Number(input.cursor) : 0;
    const items = all.slice(offset, offset + input.limit).map(cloneFolder);
    return { items, nextCursor: offset + items.length < all.length ? String(offset + items.length) : null };
  }

  async findActiveSiblingByNormalizedName(input: {
    companyId: string;
    parentId: string | null;
    normalizedName: string;
    excludeFolderId?: string;
  }): Promise<DocumentFolder | null> {
    const folder = [...this.folders.values()].find(
      (candidate) =>
        candidate.companyId === input.companyId &&
        candidate.status === 'active' &&
        candidate.parentId === input.parentId &&
        candidate.id !== input.excludeFolderId &&
        candidate.toProps().normalizedName === input.normalizedName,
    );
    return folder ? cloneFolder(folder) : null;
  }

  async save(folder: DocumentFolder, expectedRevision: number | null): Promise<DocumentFolderWriteResult> {
    const current = this.folders.get(folder.id);
    if (expectedRevision === null) {
      if (current) return { status: 'revision_conflict' };
    } else if (!current || current.revision !== expectedRevision) {
      return { status: 'revision_conflict' };
    }
    const props = folder.toProps();
    const duplicate = [...this.folders.values()].some(
      (candidate) =>
        candidate.id !== folder.id &&
        candidate.companyId === folder.companyId &&
        candidate.status === 'active' &&
        candidate.parentId === folder.parentId &&
        candidate.toProps().normalizedName === props.normalizedName,
    );
    if (duplicate) return { status: 'name_conflict' };
    this.folders.set(folder.id, cloneFolder(folder));
    return { status: 'saved' };
  }

  async findDocumentMembership(companyId: string, documentId: string): Promise<DocumentFolderMembership | null> {
    const document = this.documents.get(documentId);
    return document?.companyId === companyId ? { ...document } : null;
  }

  async listDocumentMemberships(companyId: string, folderIds: readonly string[]): Promise<DocumentFolderMembership[]> {
    const accepted = new Set(folderIds);
    return [...this.documents.values()]
      .filter((document) => document.companyId === companyId && document.folderId !== null && accepted.has(document.folderId))
      .map((document) => ({ ...document }));
  }

  async moveDocument(input: {
    companyId: string;
    documentId: string;
    targetFolderId: string | null;
    reviewedAt: string | null;
    expectedRevision: number;
  }): Promise<DocumentFolderMembershipWriteResult> {
    const current = this.documents.get(input.documentId);
    if (!current || current.companyId !== input.companyId || current.status !== 'active') return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    const revision = current.revision + 1;
    this.documents.set(current.id, {
      ...current,
      folderId: input.targetFolderId,
      // Contrat du port : reviewedAt non-null est posé atomiquement avec le rangement.
      ...(input.reviewedAt !== null ? { reviewedAt: input.reviewedAt } : {}),
      revision,
    });
    return { status: 'saved', revision };
  }
}

class MemoryUow implements UnitOfWorkPort {
  calls = 0;
  constructor(private readonly repository: MemoryFolderRepository) {}
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.calls += 1;
    const snapshot = this.repository.snapshot();
    try {
      return await fn();
    } catch (error) {
      this.repository.restore(snapshot);
      throw error;
    }
  }
}

function harness() {
  const folders = new MemoryFolderRepository();
  const uow = new MemoryUow(folders);
  let id = 0;
  const ids: IdGeneratorPort = { newId: () => `folder-${++id}` };
  return { folders, uow, ids, deps: { folders, uow, ids, clock } };
}

describe('document folders application', () => {
  it('crée des dossiers tenant-scoped, pagine et refuse un doublon frère', async () => {
    const h = harness();
    const create = new CreateDocumentFolder(h.deps);
    expect((await create.execute({ companyId: COMPANY, name: 'Achats' })).ok).toBe(true);
    expect((await create.execute({ companyId: COMPANY, name: 'Banque' })).ok).toBe(true);

    const duplicate = await create.execute({ companyId: COMPANY, name: '  ÀCHATS  ' });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.kind).toBe('conflict');

    const firstPage = await new ListDocumentFolders({ folders: h.folders }).execute({ companyId: COMPANY, limit: 1 });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.value.items).toHaveLength(1);
    expect(firstPage.value.nextCursor).not.toBeNull();
    const secondPage = await new ListDocumentFolders({ folders: h.folders }).execute({
      companyId: COMPANY,
      limit: 1,
      cursor: firstPage.value.nextCursor,
    });
    expect(secondPage.ok && secondPage.value.items).toHaveLength(1);
  });

  it(`borne l'arbre à ${DOCUMENT_FOLDER_MAX_DEPTH} niveaux`, async () => {
    const h = harness();
    let parentId: string | null = null;
    for (let level = 1; level <= DOCUMENT_FOLDER_MAX_DEPTH; level += 1) {
      const folder = makeFolder({ id: `level-${level}`, parentId });
      h.folders.seed(folder);
      parentId = folder.id;
    }
    const result = await new CreateDocumentFolder(h.deps).execute({ companyId: COMPANY, parentId, name: 'Trop profond' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });

  it('renomme avec révision optimiste et unicité entre frères', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'a', name: 'Achats' }), makeFolder({ id: 'b', name: 'Banque' }));
    const rename = new RenameDocumentFolder({ folders: h.folders, uow: h.uow, clock });
    const duplicate = await rename.execute({ companyId: COMPANY, folderId: 'a', name: 'banque', expectedRevision: 1 });
    expect(duplicate.ok).toBe(false);
    const saved = await rename.execute({ companyId: COMPANY, folderId: 'a', name: 'Fournisseurs', expectedRevision: 1 });
    expect(saved.ok && saved.value.revision).toBe(2);
    const stale = await rename.execute({ companyId: COMPANY, folderId: 'a', name: 'Autre', expectedRevision: 1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe('conflict');
  });

  it('refuse un cycle lors du déplacement', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'root' }), makeFolder({ id: 'child', parentId: 'root' }));
    const result = await new MoveDocumentFolder({ folders: h.folders, uow: h.uow, clock }).execute({
      companyId: COMPANY,
      folderId: 'root',
      parentId: 'child',
      expectedRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });

  it('prévisualise récursivement et bloque un aperçu devenu obsolète', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'source' }));
    const preview = await new PreviewDeleteDocumentFolder({ folders: h.folders }).execute({ companyId: COMPANY, folderId: 'source' });
    expect(preview.ok && preview.value.canDeleteEmpty).toBe(true);
    if (!preview.ok) return;
    h.folders.documents.set('doc-late', { id: 'doc-late', companyId: COMPANY, folderId: 'source', status: 'active', revision: 1 });
    const deleted = await new DeleteDocumentFolder({ folders: h.folders, uow: h.uow, clock }).execute({
      companyId: COMPANY,
      folderId: 'source',
      expectedRevision: preview.value.expectedRevision,
      expectedSnapshot: preview.value.snapshot,
      strategy: { kind: 'empty' },
    });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.kind).toBe('conflict');
    expect((await h.folders.findById(COMPANY, 'source'))?.status).toBe('active');
  });

  it('supprime un dossier vide sans toucher aux documents', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'empty' }));
    const preview = await new PreviewDeleteDocumentFolder({ folders: h.folders }).execute({ companyId: COMPANY, folderId: 'empty' });
    if (!preview.ok) throw new Error('preview');
    const result = await new DeleteDocumentFolder({ folders: h.folders, uow: h.uow, clock }).execute({
      companyId: COMPANY,
      folderId: 'empty',
      expectedRevision: preview.value.expectedRevision,
      expectedSnapshot: preview.value.snapshot,
      strategy: { kind: 'empty' },
    });
    expect(result.ok).toBe(true);
    expect((await h.folders.findById(COMPANY, 'empty'))?.status).toBe('deleted');
    expect(h.uow.calls).toBeGreaterThan(0);
  });

  it('protège les dossiers système contre la suppression tout en laissant leur renommage possible', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'system-purchases', name: 'Achats', systemKey: 'purchases' }));
    const preview = await new PreviewDeleteDocumentFolder({ folders: h.folders }).execute({
      companyId: COMPANY,
      folderId: 'system-purchases',
    });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.kind).toBe('forbidden');

    const renamed = await new RenameDocumentFolder({ folders: h.folders, uow: h.uow, clock }).execute({
      companyId: COMPANY,
      folderId: 'system-purchases',
      name: 'Mes achats',
      expectedRevision: 1,
    });
    expect(renamed.ok && renamed.value.name).toBe('Mes achats');
  });

  it('transfère atomiquement documents et enfants puis tombstone seulement le dossier source', async () => {
    const h = harness();
    h.folders.seed(
      makeFolder({ id: 'source' }),
      makeFolder({ id: 'child', parentId: 'source' }),
      makeFolder({ id: 'grandchild', parentId: 'child' }),
      makeFolder({ id: 'target' }),
    );
    h.folders.documents.set('doc-direct', { id: 'doc-direct', companyId: COMPANY, folderId: 'source', status: 'active', revision: 3 });
    h.folders.documents.set('doc-nested', { id: 'doc-nested', companyId: COMPANY, folderId: 'child', status: 'active', revision: 1 });
    const preview = await new PreviewDeleteDocumentFolder({ folders: h.folders }).execute({ companyId: COMPANY, folderId: 'source' });
    if (!preview.ok) throw new Error('preview');
    expect(preview.value).toMatchObject({ descendantFolderCount: 2, documentCount: 2, directDocumentCount: 1 });

    const result = await new DeleteDocumentFolder({ folders: h.folders, uow: h.uow, clock }).execute({
      companyId: COMPANY,
      folderId: 'source',
      expectedRevision: preview.value.expectedRevision,
      expectedSnapshot: preview.value.snapshot,
      strategy: { kind: 'transfer', targetFolderId: 'target', targetExpectedRevision: 1 },
    });
    expect(result).toEqual(ok({ folderId: 'source', transferredDocuments: 1, transferredChildren: 1 }));
    expect((await h.folders.findById(COMPANY, 'source'))?.status).toBe('deleted');
    expect((await h.folders.findById(COMPANY, 'child'))?.parentId).toBe('target');
    expect((await h.folders.findById(COMPANY, 'grandchild'))?.parentId).toBe('child');
    expect((await h.folders.findDocumentMembership(COMPANY, 'doc-direct'))?.folderId).toBe('target');
    expect((await h.folders.findDocumentMembership(COMPANY, 'doc-nested'))?.folderId).toBe('child');
  });

  it('déplace un document avec une révision attendue sans exposer de port blob', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'target' }));
    h.folders.documents.set('doc-1', { id: 'doc-1', companyId: COMPANY, folderId: null, status: 'active', revision: 4 });
    const move = new MoveDocumentToFolder({ folders: h.folders, uow: h.uow, clock });
    const result = await move.execute({ companyId: COMPANY, documentId: 'doc-1', folderId: 'target', expectedRevision: 4 });
    expect(result).toEqual(ok({ documentId: 'doc-1', folderId: 'target', revision: 5 }));
    const stale = await move.execute({ companyId: COMPANY, documentId: 'doc-1', folderId: null, expectedRevision: 4 });
    expect(stale.ok).toBe(false);
  });

  it('ranger DANS un dossier pose la validation (reviewedAt) — un geste de classement vaut confirmation', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'achats' }));
    h.folders.documents.set('doc-1', { id: 'doc-1', companyId: COMPANY, folderId: null, status: 'active', revision: 1 });
    const move = new MoveDocumentToFolder({ folders: h.folders, uow: h.uow, clock });

    const result = await move.execute({ companyId: COMPANY, documentId: 'doc-1', folderId: 'achats', expectedRevision: 1 });

    expect(result).toEqual(ok({ documentId: 'doc-1', folderId: 'achats', revision: 2 }));
    expect(await h.folders.findDocumentMembership(COMPANY, 'doc-1')).toMatchObject({
      folderId: 'achats',
      reviewedAt: NOW,
    });
  });

  it('sortir d’un dossier (folderId null) n’invalide jamais une confirmation existante', async () => {
    const h = harness();
    h.folders.documents.set('doc-1', {
      id: 'doc-1',
      companyId: COMPANY,
      folderId: 'achats-avant',
      status: 'active',
      revision: 2,
      reviewedAt: '2026-07-10T08:00:00.000Z',
    });
    const move = new MoveDocumentToFolder({ folders: h.folders, uow: h.uow, clock });

    const result = await move.execute({ companyId: COMPANY, documentId: 'doc-1', folderId: null, expectedRevision: 2 });

    expect(result).toEqual(ok({ documentId: 'doc-1', folderId: null, revision: 3 }));
    expect((await h.folders.findDocumentMembership(COMPANY, 'doc-1'))?.reviewedAt).toBe('2026-07-10T08:00:00.000Z');
  });

  it('re-ranger un document déjà validé conserve l’horodatage de sa première validation (latch)', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'fiscal' }));
    h.folders.documents.set('doc-1', {
      id: 'doc-1',
      companyId: COMPANY,
      folderId: null,
      status: 'active',
      revision: 2,
      reviewedAt: '2026-07-10T08:00:00.000Z',
    });
    const move = new MoveDocumentToFolder({ folders: h.folders, uow: h.uow, clock });

    const result = await move.execute({ companyId: COMPANY, documentId: 'doc-1', folderId: 'fiscal', expectedRevision: 2 });

    expect(result).toEqual(ok({ documentId: 'doc-1', folderId: 'fiscal', revision: 3 }));
    expect((await h.folders.findDocumentMembership(COMPANY, 'doc-1'))?.reviewedAt).toBe('2026-07-10T08:00:00.000Z');
  });

  it('« Classer là » vers le dossier où le doc est déjà rangé mais non confirmé pose quand même la validation', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'achats' }));
    h.folders.documents.set('doc-1', { id: 'doc-1', companyId: COMPANY, folderId: 'achats', status: 'active', revision: 3 });
    const move = new MoveDocumentToFolder({ folders: h.folders, uow: h.uow, clock });

    const result = await move.execute({ companyId: COMPANY, documentId: 'doc-1', folderId: 'achats', expectedRevision: 3 });

    expect(result).toEqual(ok({ documentId: 'doc-1', folderId: 'achats', revision: 4 }));
    expect((await h.folders.findDocumentMembership(COMPANY, 'doc-1'))?.reviewedAt).toBe(NOW);

    // Et une fois confirmé, re-ranger au même endroit redevient un no-op sans écriture.
    const replay = await move.execute({ companyId: COMPANY, documentId: 'doc-1', folderId: 'achats', expectedRevision: 4 });
    expect(replay).toEqual(ok({ documentId: 'doc-1', folderId: 'achats', revision: 4 }));
  });

  it('le transfert technique d’une suppression de dossier ne vaut PAS validation', async () => {
    const h = harness();
    h.folders.seed(makeFolder({ id: 'source' }), makeFolder({ id: 'target' }));
    h.folders.documents.set('doc-1', { id: 'doc-1', companyId: COMPANY, folderId: 'source', status: 'active', revision: 1 });
    const preview = await new PreviewDeleteDocumentFolder({ folders: h.folders }).execute({ companyId: COMPANY, folderId: 'source' });
    if (!preview.ok) throw new Error('preview');

    const result = await new DeleteDocumentFolder({ folders: h.folders, uow: h.uow, clock }).execute({
      companyId: COMPANY,
      folderId: 'source',
      expectedRevision: preview.value.expectedRevision,
      expectedSnapshot: preview.value.snapshot,
      strategy: { kind: 'transfer', targetFolderId: 'target', targetExpectedRevision: 1 },
    });

    expect(result.ok).toBe(true);
    const membership = await h.folders.findDocumentMembership(COMPANY, 'doc-1');
    expect(membership?.folderId).toBe('target');
    expect(membership?.reviewedAt ?? null).toBeNull(); // le doc reste « à confirmer »
  });
});
