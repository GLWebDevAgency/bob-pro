import { Document } from '../../domain/document/document';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type ClockPort } from '../ports/services';
import { type DocumentRepository } from '../ports/document-repository';
import { documentToView, type DocumentView } from './document-view';

export interface AcknowledgeDocumentInput {
  companyId: string;
  documentId: string;
  expectedRevision: number;
}

export interface AcknowledgeDocumentDeps {
  documents: Pick<DocumentRepository, 'findById' | 'markReviewed'>;
  clock: ClockPort;
}

/**
 * « C'est bon, je valide » : pose la confirmation humaine (reviewedAt) d'un document scanné
 * SANS le déplacer ni le lier — le document sort de la file « À valider », son rangement et
 * son éventuel rattachement métier restent strictement intacts. Même use case pour l'UI et
 * pour Bob (parité d'actions voix). Idempotent : re-valider un document déjà confirmé ne
 * réécrit rien (la première validation fait foi), protégé par révision optimiste.
 */
export class AcknowledgeDocument {
  constructor(private readonly deps: AcknowledgeDocumentDeps) {}

  async execute(input: AcknowledgeDocumentInput): Promise<Result<DocumentView, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision document invalide.' }],
      });
    }
    const document = await this.deps.documents.findById(input.companyId, input.documentId);
    if (!document) return err(appNotFound('document', input.documentId));
    if (document.revision !== input.expectedRevision) {
      return err(appConflict('document', 'Le document a été modifié. Recharge avant de valider.'));
    }
    // Le clone protège les adaptateurs in-memory : une tentative perdante ne doit jamais muter
    // l'agrégat partagé avant que le compare-and-set du repository ait gagné.
    const next = Document.rehydrate(document.toProps());
    const reviewed = next.markReviewed(this.deps.clock.now());
    if (!reviewed.ok) return err(appDomain(reviewed.error));
    if (next.revision === document.revision) return ok(documentToView(document));
    const saved = await this.deps.documents.markReviewed({
      companyId: input.companyId,
      documentId: input.documentId,
      reviewedAt: next.reviewedAt!,
      expectedRevision: input.expectedRevision,
    });
    if (saved === 'not_found') return err(appNotFound('document', input.documentId));
    if (saved === 'revision_conflict') {
      return err(appConflict('document', 'Le document a été modifié. Recharge avant de valider.'));
    }
    return ok(documentToView(next));
  }
}
