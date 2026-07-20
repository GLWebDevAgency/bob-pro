import {
  DocumentFolder,
  type DocumentFolderProps,
  type DocumentFolderSystemKey,
  validateDocumentFolderName,
} from '../../domain/document/document-folder';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type ClockPort, type IdGeneratorPort, type UnitOfWorkPort } from '../ports/services';
import {
  type DocumentFolderMembership,
  type DocumentFolderRepository,
} from '../ports/document-folder-repository';

export const DOCUMENT_FOLDER_MAX_DEPTH = 8;

export type DocumentFolderView = DocumentFolderProps;

export interface DocumentFolderDeletionSnapshot {
  folders: { id: string; parentId: string | null; revision: number }[];
  documents: { id: string; folderId: string | null; revision: number }[];
}

export interface DocumentFolderDeletionPreview {
  folder: DocumentFolderView;
  expectedRevision: number;
  directChildCount: number;
  descendantFolderCount: number;
  directDocumentCount: number;
  documentCount: number;
  canDeleteEmpty: boolean;
  /** À conserver côté serveur dans une proposition opaque ; ne pas faire confiance au client. */
  snapshot: DocumentFolderDeletionSnapshot;
}

export type DeleteDocumentFolderStrategy =
  | { kind: 'empty' }
  | { kind: 'transfer'; targetFolderId: string; targetExpectedRevision: number };

type FolderDeps = {
  folders: DocumentFolderRepository;
  clock: ClockPort;
  uow: UnitOfWorkPort;
};

class FolderTransactionAbort extends Error {
  constructor(readonly appError: AppError) {
    super('document-folder-transaction-abort');
  }
}

function conflict(reason: string): AppError {
  return appConflict('document_folder', reason);
}

function invalid(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function activeFolder(folder: DocumentFolder | null): folder is DocumentFolder {
  return folder !== null && folder.status === 'active';
}

function view(folder: DocumentFolder): DocumentFolderView {
  return folder.toProps();
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

async function inTransaction<T>(
  uow: UnitOfWorkPort,
  work: () => Promise<Result<T, AppError>>,
): Promise<Result<T, AppError>> {
  try {
    const value = await uow.runInTransaction(async () => {
      const result = await work();
      if (!result.ok) throw new FolderTransactionAbort(result.error);
      return result.value;
    });
    return ok(value);
  } catch (cause) {
    if (cause instanceof FolderTransactionAbort) return err(cause.appError);
    throw cause;
  }
}

async function requireParentChain(
  folders: DocumentFolderRepository,
  companyId: string,
  parentId: string | null,
): Promise<Result<DocumentFolder[], AppError>> {
  if (parentId === null) return ok([]);
  const chain = await folders.listActiveAncestors(companyId, parentId);
  if (chain.length === 0 || chain.at(-1)?.id !== parentId) return err(appNotFound('document_folder', parentId));
  if (chain.some((candidate) => candidate.status !== 'active')) {
    return err(conflict('Le dossier parent n’est plus actif.'));
  }
  return ok(chain);
}

async function siblingNameAvailable(
  folders: DocumentFolderRepository,
  input: {
    companyId: string;
    parentId: string | null;
    name: string;
    excludeFolderId?: string;
  },
): Promise<Result<void, AppError>> {
  const name = validateDocumentFolderName(input.name);
  if (!name.ok) return err(appDomain(name.error));
  const sibling = await folders.findActiveSiblingByNormalizedName({
    companyId: input.companyId,
    parentId: input.parentId,
    normalizedName: name.value.normalizedName,
    ...(input.excludeFolderId ? { excludeFolderId: input.excludeFolderId } : {}),
  });
  return sibling ? err(conflict('Un dossier de même nom existe déjà à cet emplacement.')) : ok(undefined);
}

function folderWriteError(status: 'revision_conflict' | 'name_conflict'): AppError {
  return status === 'revision_conflict'
    ? conflict('Le dossier a été modifié. Recharge-le avant de réessayer.')
    : conflict('Un dossier de même nom existe déjà à cet emplacement.');
}

function snapshotOf(
  subtree: readonly DocumentFolder[],
  documents: readonly DocumentFolderMembership[],
): DocumentFolderDeletionSnapshot {
  return {
    folders: subtree
      .map((folder) => ({ id: folder.id, parentId: folder.parentId, revision: folder.revision }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    documents: documents
      .map((document) => ({ id: document.id, folderId: document.folderId, revision: document.revision }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function sameSnapshot(a: DocumentFolderDeletionSnapshot, b: DocumentFolderDeletionSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function subtreeHeight(subtree: readonly DocumentFolder[], rootId: string): number {
  const byId = new Map(subtree.map((folder) => [folder.id, folder]));
  const memo = new Map<string, number>([[rootId, 1]]);
  const depth = (folder: DocumentFolder): number => {
    const known = memo.get(folder.id);
    if (known !== undefined) return known;
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    const value = parent ? depth(parent) + 1 : 1;
    memo.set(folder.id, value);
    return value;
  };
  return subtree.reduce((max, folder) => Math.max(max, depth(folder)), 1);
}

export class CreateDocumentFolder {
  constructor(private readonly deps: FolderDeps & { ids: IdGeneratorPort }) {}

  execute(input: {
    companyId: string;
    parentId?: string | null;
    name: string;
    systemKey?: DocumentFolderSystemKey | null;
  }): Promise<Result<DocumentFolderView, AppError>> {
    return inTransaction(this.deps.uow, async () => {
      const parentId = input.parentId ?? null;
      const chain = await requireParentChain(this.deps.folders, input.companyId, parentId);
      if (!chain.ok) return chain;
      if (chain.value.length + 1 > DOCUMENT_FOLDER_MAX_DEPTH) {
        return err(invalid('parentId', `Un dossier ne peut pas dépasser ${DOCUMENT_FOLDER_MAX_DEPTH} niveaux.`));
      }
      const available = await siblingNameAvailable(this.deps.folders, { ...input, parentId });
      if (!available.ok) return available;
      const created = DocumentFolder.create({
        id: this.deps.ids.newId(),
        companyId: input.companyId,
        parentId,
        name: input.name,
        systemKey: input.systemKey ?? null,
        now: this.deps.clock.now(),
      });
      if (!created.ok) return err(appDomain(created.error));
      const saved = await this.deps.folders.save(created.value, null);
      if (saved.status !== 'saved') return err(folderWriteError(saved.status));
      return ok(view(created.value));
    });
  }
}

export class RenameDocumentFolder {
  constructor(private readonly deps: FolderDeps) {}

  execute(input: {
    companyId: string;
    folderId: string;
    name: string;
    expectedRevision: number;
  }): Promise<Result<DocumentFolderView, AppError>> {
    if (!validRevision(input.expectedRevision)) return Promise.resolve(err(invalid('expectedRevision', 'Révision invalide.')));
    return inTransaction(this.deps.uow, async () => {
      const folder = await this.deps.folders.findById(input.companyId, input.folderId);
      if (!activeFolder(folder)) return err(appNotFound('document_folder', input.folderId));
      if (folder.revision !== input.expectedRevision) return err(conflict('Le dossier a été modifié.'));
      const available = await siblingNameAvailable(this.deps.folders, {
        companyId: input.companyId,
        parentId: folder.parentId,
        name: input.name,
        excludeFolderId: folder.id,
      });
      if (!available.ok) return available;
      const before = folder.revision;
      const renamed = folder.rename(input.name, this.deps.clock.now());
      if (!renamed.ok) return err(appDomain(renamed.error));
      if (folder.revision === before) return ok(view(folder));
      const saved = await this.deps.folders.save(folder, input.expectedRevision);
      if (saved.status !== 'saved') return err(folderWriteError(saved.status));
      return ok(view(folder));
    });
  }
}

export class MoveDocumentFolder {
  constructor(private readonly deps: FolderDeps) {}

  execute(input: {
    companyId: string;
    folderId: string;
    parentId: string | null;
    expectedRevision: number;
  }): Promise<Result<DocumentFolderView, AppError>> {
    if (!validRevision(input.expectedRevision)) return Promise.resolve(err(invalid('expectedRevision', 'Révision invalide.')));
    return inTransaction(this.deps.uow, async () => {
      const folder = await this.deps.folders.findById(input.companyId, input.folderId);
      if (!activeFolder(folder)) return err(appNotFound('document_folder', input.folderId));
      if (folder.revision !== input.expectedRevision) return err(conflict('Le dossier a été modifié.'));
      const parentChain = await requireParentChain(this.deps.folders, input.companyId, input.parentId);
      if (!parentChain.ok) return parentChain;
      if (parentChain.value.some((ancestor) => ancestor.id === folder.id)) {
        return err(invalid('parentId', 'Un dossier ne peut pas être déplacé dans son propre sous-arbre.'));
      }
      const subtree = await this.deps.folders.listActiveSubtree(input.companyId, folder.id);
      if (parentChain.value.length + subtreeHeight(subtree, folder.id) > DOCUMENT_FOLDER_MAX_DEPTH) {
        return err(invalid('parentId', `Le déplacement dépasserait ${DOCUMENT_FOLDER_MAX_DEPTH} niveaux.`));
      }
      const available = await siblingNameAvailable(this.deps.folders, {
        companyId: input.companyId,
        parentId: input.parentId,
        name: folder.toProps().name,
        excludeFolderId: folder.id,
      });
      if (!available.ok) return available;
      const before = folder.revision;
      const moved = folder.move(input.parentId, this.deps.clock.now());
      if (!moved.ok) return err(appDomain(moved.error));
      if (folder.revision === before) return ok(view(folder));
      const saved = await this.deps.folders.save(folder, input.expectedRevision);
      if (saved.status !== 'saved') return err(folderWriteError(saved.status));
      return ok(view(folder));
    });
  }
}

export class ListDocumentFolders {
  constructor(private readonly deps: { folders: DocumentFolderRepository }) {}

  async execute(input: {
    companyId: string;
    parentId?: string | null;
    limit?: number;
    cursor?: string | null;
  }): Promise<Result<{ items: DocumentFolderView[]; nextCursor: string | null }, AppError>> {
    const limit = input.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return err(invalid('limit', 'La taille de page doit être comprise entre 1 et 100.'));
    }
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = await this.deps.folders.findById(input.companyId, parentId);
      if (!activeFolder(parent)) return err(appNotFound('document_folder', parentId));
    }
    const page = await this.deps.folders.listChildren({
      companyId: input.companyId,
      parentId,
      limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    return ok({ items: page.items.filter((folder) => folder.status === 'active').map(view), nextCursor: page.nextCursor });
  }
}

export class PreviewDeleteDocumentFolder {
  constructor(private readonly deps: { folders: DocumentFolderRepository }) {}

  async execute(input: { companyId: string; folderId: string }): Promise<Result<DocumentFolderDeletionPreview, AppError>> {
    const folder = await this.deps.folders.findById(input.companyId, input.folderId);
    if (!activeFolder(folder)) return err(appNotFound('document_folder', input.folderId));
    if (folder.toProps().systemKey !== null) {
      return err({ kind: 'forbidden', reason: 'Les dossiers système peuvent être renommés, mais pas supprimés.' });
    }
    const subtree = await this.deps.folders.listActiveSubtree(input.companyId, input.folderId);
    const folderIds = subtree.map((candidate) => candidate.id);
    const documents = await this.deps.folders.listDocumentMemberships(input.companyId, folderIds);
    const directChildren = subtree.filter((candidate) => candidate.parentId === folder.id);
    const directDocuments = documents.filter((document) => document.folderId === folder.id && document.status === 'active');
    const activeDocuments = documents.filter((document) => document.status === 'active');
    return ok({
      folder: view(folder),
      expectedRevision: folder.revision,
      directChildCount: directChildren.length,
      descendantFolderCount: Math.max(0, subtree.length - 1),
      directDocumentCount: directDocuments.length,
      documentCount: activeDocuments.length,
      canDeleteEmpty: subtree.length === 1 && activeDocuments.length === 0,
      snapshot: snapshotOf(subtree, activeDocuments),
    });
  }
}

export class DeleteDocumentFolder {
  constructor(private readonly deps: FolderDeps) {}

  execute(input: {
    companyId: string;
    folderId: string;
    expectedRevision: number;
    expectedSnapshot: DocumentFolderDeletionSnapshot;
    strategy: DeleteDocumentFolderStrategy;
  }): Promise<Result<{ folderId: string; transferredDocuments: number; transferredChildren: number }, AppError>> {
    if (!validRevision(input.expectedRevision)) return Promise.resolve(err(invalid('expectedRevision', 'Révision invalide.')));
    return inTransaction(this.deps.uow, async () => {
      const folder = await this.deps.folders.findById(input.companyId, input.folderId);
      if (!activeFolder(folder)) return err(appNotFound('document_folder', input.folderId));
      if (folder.toProps().systemKey !== null) {
        return err({ kind: 'forbidden', reason: 'Les dossiers système peuvent être renommés, mais pas supprimés.' });
      }
      if (folder.revision !== input.expectedRevision) return err(conflict('Le dossier a été modifié. Recrée un aperçu.'));

      const subtree = await this.deps.folders.listActiveSubtree(input.companyId, folder.id);
      const documents = (await this.deps.folders.listDocumentMemberships(
        input.companyId,
        subtree.map((candidate) => candidate.id),
      )).filter((document) => document.status === 'active');
      if (!sameSnapshot(snapshotOf(subtree, documents), input.expectedSnapshot)) {
        return err(conflict('Le contenu du dossier a changé. Recrée un aperçu avant de confirmer.'));
      }
      const children = subtree.filter((candidate) => candidate.parentId === folder.id);
      const directDocuments = documents.filter((document) => document.folderId === folder.id);

      if (input.strategy.kind === 'empty') {
        if (children.length > 0 || directDocuments.length > 0) {
          return err(conflict('Le dossier n’est pas vide. Choisis un transfert ou annule.'));
        }
      } else {
        const target = await this.deps.folders.findById(input.companyId, input.strategy.targetFolderId);
        if (!activeFolder(target)) return err(appNotFound('document_folder', input.strategy.targetFolderId));
        if (target.revision !== input.strategy.targetExpectedRevision) {
          return err(conflict('Le dossier de destination a été modifié.'));
        }
        if (subtree.some((candidate) => candidate.id === target.id)) {
          return err(invalid('targetFolderId', 'La destination ne peut pas appartenir au dossier supprimé.'));
        }
        const targetChain = await requireParentChain(this.deps.folders, input.companyId, target.id);
        if (!targetChain.ok) return targetChain;
        const height = subtreeHeight(subtree, folder.id);
        if (children.length > 0 && targetChain.value.length + height - 1 > DOCUMENT_FOLDER_MAX_DEPTH) {
          return err(invalid('targetFolderId', `Le transfert dépasserait ${DOCUMENT_FOLDER_MAX_DEPTH} niveaux.`));
        }
        for (const child of children) {
          const available = await siblingNameAvailable(this.deps.folders, {
            companyId: input.companyId,
            parentId: target.id,
            name: child.toProps().name,
            excludeFolderId: child.id,
          });
          if (!available.ok) return available;
        }

        // Toutes les validations précèdent les écritures. La UoW rollback toute course résiduelle.
        for (const child of children) {
          const expectedRevision = child.revision;
          const moved = child.move(target.id, this.deps.clock.now());
          if (!moved.ok) return err(appDomain(moved.error));
          const saved = await this.deps.folders.save(child, expectedRevision);
          if (saved.status !== 'saved') return err(folderWriteError(saved.status));
        }
        for (const document of directDocuments) {
          const moved = await this.deps.folders.moveDocument({
            companyId: input.companyId,
            documentId: document.id,
            targetFolderId: target.id,
            // Transfert technique de suppression : ce n'est PAS un geste de classement —
            // la confirmation humaine (reviewedAt) du document reste strictement intacte.
            reviewedAt: null,
            expectedRevision: document.revision,
          });
          if (moved.status === 'not_found') return err(appNotFound('document', document.id));
          if (moved.status === 'revision_conflict') return err(conflict('Un document a été modifié pendant le transfert.'));
        }
      }

      const deleted = folder.markDeleted(this.deps.clock.now());
      if (!deleted.ok) return err(appDomain(deleted.error));
      const saved = await this.deps.folders.save(folder, input.expectedRevision);
      if (saved.status !== 'saved') return err(folderWriteError(saved.status));
      return ok({
        folderId: folder.id,
        transferredDocuments: input.strategy.kind === 'transfer' ? directDocuments.length : 0,
        transferredChildren: input.strategy.kind === 'transfer' ? children.length : 0,
      });
    });
  }
}

export class MoveDocumentToFolder {
  constructor(private readonly deps: { folders: DocumentFolderRepository; uow: UnitOfWorkPort; clock: ClockPort }) {}

  execute(input: {
    companyId: string;
    documentId: string;
    folderId: string | null;
    expectedRevision: number;
  }): Promise<Result<{ documentId: string; folderId: string | null; revision: number }, AppError>> {
    if (!validRevision(input.expectedRevision)) return Promise.resolve(err(invalid('expectedRevision', 'Révision invalide.')));
    return inTransaction(this.deps.uow, async () => {
      if (input.folderId !== null) {
        const target = await this.deps.folders.findById(input.companyId, input.folderId);
        if (!activeFolder(target)) return err(appNotFound('document_folder', input.folderId));
      }
      const document = await this.deps.folders.findDocumentMembership(input.companyId, input.documentId);
      if (!document || document.status !== 'active') return err(appNotFound('document', input.documentId));
      if (document.revision !== input.expectedRevision) return err(conflict('Le document a été modifié.'));
      // Ranger DANS un dossier est un geste explicite de classement : il vaut validation
      // humaine (reviewedAt, latch — une confirmation antérieure n'est jamais réécrite).
      // Sortir d'un dossier (folderId null) n'est pas un classement et n'invalide rien.
      const reviewedAt =
        input.folderId !== null && (document.reviewedAt ?? null) === null ? this.deps.clock.now() : null;
      if (document.folderId === input.folderId && reviewedAt === null) {
        return ok({ documentId: document.id, folderId: document.folderId, revision: document.revision });
      }
      const moved = await this.deps.folders.moveDocument({
        companyId: input.companyId,
        documentId: input.documentId,
        targetFolderId: input.folderId,
        reviewedAt,
        expectedRevision: input.expectedRevision,
      });
      if (moved.status === 'not_found') return err(appNotFound('document', input.documentId));
      if (moved.status === 'revision_conflict') return err(conflict('Le document a été modifié.'));
      return ok({ documentId: input.documentId, folderId: input.folderId, revision: moved.revision });
    });
  }
}
