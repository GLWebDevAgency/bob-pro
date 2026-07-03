import { type Result, ok, err } from '../../shared-kernel/result';
import { type DocumentLinkedEntityType } from '../../domain/document/document';
import { type AppError, appDomain, appNotFound } from '../result';
import { type DocumentRepository } from '../ports/document-repository';
import { documentToView, type DocumentView } from './document-view';

export interface ClassifyDocumentInput {
  companyId: string;
  documentId: string;
  linkedEntityType: DocumentLinkedEntityType;
  linkedEntityId: string;
}

export interface ClassifyDocumentDeps {
  documents: DocumentRepository;
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
    const document = await this.deps.documents.findById(input.companyId, input.documentId);
    if (!document) return err(appNotFound('document', input.documentId));
    const classified = document.classify({
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId,
    });
    if (!classified.ok) return err(appDomain(classified.error));
    await this.deps.documents.save(document);
    return ok(documentToView(document));
  }
}
