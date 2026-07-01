import { type Document } from '../../domain/document/document';
import { type DateOnly } from '../../shared-kernel/time';

export interface DocumentRepository {
  save(d: Document): Promise<void>;
  findById(companyId: string, id: string): Promise<Document | null>;
  findByEntity(companyId: string, entityType: string, entityId: string): Promise<Document[]>;
  listByCompany(companyId: string): Promise<Document[]>;
  listExpired(now: DateOnly): Promise<Document[]>;
}
