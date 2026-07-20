import { type Result, ok } from '../../shared-kernel/result';
import { type DocumentKind, type DocumentLinkedEntityType } from '../../domain/document/document';
import { type DocumentRepository } from '../ports/document-repository';
import { type AppError } from '../result';
import { documentToView, type DocumentView } from './document-view';

export interface ListDocumentsInput {
  companyId: string;
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType;
  linkedEntityId?: string;
  folderId?: string | null;
  includeDeleted?: boolean;
}

export class ListDocuments {
  constructor(private readonly deps: { documents: DocumentRepository }) {}

  async execute(input: ListDocumentsInput): Promise<Result<DocumentView[], AppError>> {
    const documents =
      input.linkedEntityType && input.linkedEntityId
        ? await this.deps.documents.findByEntity(input.companyId, input.linkedEntityType, input.linkedEntityId)
        : await this.deps.documents.listByCompany(input.companyId);
    return ok(
      documents
        .filter((d) => input.includeDeleted === true || d.status === 'active')
        .map(documentToView)
        .filter((d) => (input.kind ? d.kind === input.kind : true))
        .filter((d) => (input.linkedEntityType ? d.linkedEntityType === input.linkedEntityType : true))
        .filter((d) => (input.linkedEntityId ? d.linkedEntityId === input.linkedEntityId : true))
        .filter((d) => (input.folderId !== undefined ? d.folderId === input.folderId : true)),
    );
  }
}
