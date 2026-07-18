import { type Document, type DocumentLinkedEntityType } from '../../domain/document/document';
import { type DateOnly } from '../../shared-kernel/time';

export interface DocumentRepository {
  save(d: Document): Promise<void>;
  /** Mutation atomique des métadonnées de rattachement, protégée par révision optimiste. */
  classify(input: {
    companyId: string;
    documentId: string;
    linkedEntityType: DocumentLinkedEntityType;
    linkedEntityId: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'>;
  /** Mutation atomique du libellé d'affichage (révision optimiste) — l'adapter journalise pour l'audit. */
  rename(input: {
    companyId: string;
    documentId: string;
    displayName: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'>;
  findById(companyId: string, id: string): Promise<Document | null>;
  findByEntity(companyId: string, entityType: string, entityId: string): Promise<Document[]>;
  listByCompany(companyId: string): Promise<Document[]>;
  listExpired(now: DateOnly): Promise<Document[]>;
}
