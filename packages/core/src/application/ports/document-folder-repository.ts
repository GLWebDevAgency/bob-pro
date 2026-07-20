import { type DocumentFolder } from '../../domain/document/document-folder';

/** Projection minimale d'un document pour les opérations de rangement du coffre. */
export interface DocumentFolderMembership {
  id: string;
  companyId: string;
  folderId: string | null;
  status: 'active' | 'deleted';
  /** Révision optimiste des métadonnées du document (le binaire n'est jamais touché). */
  revision: number;
  /** Confirmation humaine du document — absent (adapter historique) ⇒ null, jamais validé. */
  reviewedAt?: string | null;
}

export interface DocumentFolderPage {
  items: DocumentFolder[];
  nextCursor: string | null;
}

export type DocumentFolderWriteResult =
  | { status: 'saved' }
  | { status: 'revision_conflict' }
  | { status: 'name_conflict' };

export type DocumentFolderMembershipWriteResult =
  | { status: 'saved'; revision: number }
  | { status: 'revision_conflict' }
  | { status: 'not_found' };

/**
 * Port de persistance du rangement documentaire.
 *
 * Les méthodes ne manipulent que les métadonnées dossier/emplacement. Aucun adapter de ce
 * port ne doit supprimer, remplacer ou déplacer un objet du stockage documentaire.
 */
export interface DocumentFolderRepository {
  findById(companyId: string, folderId: string): Promise<DocumentFolder | null>;

  /** Chaîne active racine → dossier, dossier inclus. Une chaîne vide signifie « introuvable ». */
  listActiveAncestors(companyId: string, folderId: string): Promise<DocumentFolder[]>;

  /** Sous-arbre actif, racine incluse. */
  listActiveSubtree(companyId: string, folderId: string): Promise<DocumentFolder[]>;

  listChildren(input: {
    companyId: string;
    parentId: string | null;
    limit: number;
    cursor?: string | null;
  }): Promise<DocumentFolderPage>;

  findActiveSiblingByNormalizedName(input: {
    companyId: string;
    parentId: string | null;
    normalizedName: string;
    excludeFolderId?: string;
  }): Promise<DocumentFolder | null>;

  /** expectedRevision=null signifie création. */
  save(folder: DocumentFolder, expectedRevision: number | null): Promise<DocumentFolderWriteResult>;

  findDocumentMembership(companyId: string, documentId: string): Promise<DocumentFolderMembership | null>;
  listDocumentMemberships(companyId: string, folderIds: readonly string[]): Promise<DocumentFolderMembership[]>;
  moveDocument(input: {
    companyId: string;
    documentId: string;
    targetFolderId: string | null;
    /** Non-null : le rangement vaut validation humaine — l'adapter pose reviewedAt
     *  atomiquement avec le déplacement. Null : transfert technique, la confirmation
     *  existante du document reste strictement intacte. */
    reviewedAt: string | null;
    expectedRevision: number;
  }): Promise<DocumentFolderMembershipWriteResult>;
}
