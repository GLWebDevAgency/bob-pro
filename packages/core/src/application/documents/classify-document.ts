import { type Result, ok, err } from '../../shared-kernel/result';
import { Document, type DocumentLinkedEntityType } from '../../domain/document/document';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type DocumentLinkTargetPort } from '../ports/document-link-target';
import { type DocumentRepository } from '../ports/document-repository';
import { type ClockPort } from '../ports/services';
import { documentToView, type DocumentView } from './document-view';

export interface ClassifyDocumentInput {
  companyId: string;
  documentId: string;
  linkedEntityType: DocumentLinkedEntityType;
  linkedEntityId: string;
  expectedRevision: number;
}

export interface ClassifyDocumentDeps {
  documents: DocumentRepository;
  linkTargets: DocumentLinkTargetPort;
  clock: ClockPort;
}

/**
 * Confirme le classement proposé après OCR (claim C14, amendement A1-C14) : le scan a
 * extrait, Bob a proposé (« Je pense : dépense Leroy Merlin ») — « Classer là » rattache
 * réellement le document à l'entité métier. Même use case pour l'UI et pour Bob
 * (parité d'actions) ; le document sort d'« À valider » et compte dans son dossier.
 */
export class ClassifyDocument {
  constructor(private readonly deps: ClassifyDocumentDeps) {}

  async execute(input: ClassifyDocumentInput): Promise<Result<DocumentView, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision document invalide.' }],
      });
    }
    const document = await this.deps.documents.findById(input.companyId, input.documentId);
    if (!document) return err(appNotFound('document', input.documentId));
    if (document.revision !== input.expectedRevision) {
      return err(appConflict('document', 'Le document a été modifié. Recharge avant de confirmer le rattachement.'));
    }
    // Le clone protège les adaptateurs in-memory : une tentative perdante ne doit jamais muter
    // l'agrégat partagé avant que le compare-and-set du repository ait gagné.
    const next = Document.rehydrate(document.toProps());
    const classified = next.classify({
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId,
    });
    if (!classified.ok) return err(appDomain(classified.error));
    // Un geste explicite de classement vaut validation humaine (le doc sort d'« À valider ») ;
    // latch idempotent — une validation antérieure garde son horodatage d'origine.
    const reviewed = next.markReviewed(this.deps.clock.now());
    if (!reviewed.ok) return err(appDomain(reviewed.error));
    const nextProps = next.toProps();
    if (!(await this.deps.linkTargets.exists({
      companyId: input.companyId,
      linkedEntityType: nextProps.linkedEntityType!,
      linkedEntityId: nextProps.linkedEntityId!,
    }))) {
      return err(appNotFound(nextProps.linkedEntityType!, nextProps.linkedEntityId!));
    }
    if (next.revision === document.revision) return ok(documentToView(document));
    const saved = await this.deps.documents.classify({
      companyId: input.companyId,
      documentId: input.documentId,
      linkedEntityType: nextProps.linkedEntityType!,
      linkedEntityId: nextProps.linkedEntityId!,
      reviewedAt: nextProps.reviewedAt!,
      expectedRevision: input.expectedRevision,
    });
    if (saved === 'not_found') return err(appNotFound('document', input.documentId));
    if (saved === 'revision_conflict') {
      return err(appConflict('document', 'Le document a été modifié. Recharge avant de confirmer le rattachement.'));
    }
    return ok(documentToView(next));
  }
}
