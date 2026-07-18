import { Document } from '../../domain/document/document';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type DocumentRepository } from '../ports/document-repository';
import { documentToView, type DocumentView } from './document-view';

export interface RenameDocumentInput {
  companyId: string;
  documentId: string;
  /** Nouveau libellé d'affichage — le filename d'archive reste immuable. */
  displayName: string;
  expectedRevision: number;
}

export interface RenameDocumentDeps {
  documents: Pick<DocumentRepository, 'findById' | 'rename'>;
}

/**
 * Renomme le libellé d'affichage d'un document du coffre (« Facture Leroy Merlin — 184,90 € »
 * plutôt qu'un nom de scan brut). Même use case pour l'UI et pour Bob (parité d'actions voix).
 * L'archive (filename, versions, sha256) reste immuable : l'audit côté API journalise la
 * mutation via l'adapter du repository, protégée par révision optimiste.
 */
export class RenameDocument {
  constructor(private readonly deps: RenameDocumentDeps) {}

  async execute(input: RenameDocumentInput): Promise<Result<DocumentView, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision document invalide.' }],
      });
    }
    const document = await this.deps.documents.findById(input.companyId, input.documentId);
    if (!document) return err(appNotFound('document', input.documentId));
    if (document.revision !== input.expectedRevision) {
      return err(appConflict('document', 'Le document a été modifié. Recharge avant de renommer.'));
    }
    // Le clone protège les adaptateurs in-memory : une tentative perdante ne doit jamais muter
    // l'agrégat partagé avant que le compare-and-set du repository ait gagné.
    const next = Document.rehydrate(document.toProps());
    const renamed = next.rename(input.displayName);
    if (!renamed.ok) return err(appDomain(renamed.error));
    if (next.revision === document.revision) return ok(documentToView(document));
    const saved = await this.deps.documents.rename({
      companyId: input.companyId,
      documentId: input.documentId,
      displayName: next.displayName,
      expectedRevision: input.expectedRevision,
    });
    if (saved === 'not_found') return err(appNotFound('document', input.documentId));
    if (saved === 'revision_conflict') {
      return err(appConflict('document', 'Le document a été modifié. Recharge avant de renommer.'));
    }
    return ok(documentToView(next));
  }
}
