import { type Result, ok, err } from '../../shared-kernel/result';
import { type DocumentRepository } from '../ports/document-repository';
import { type DocumentStoragePort } from '../ports/document-storage';
import { type AppError, appForbidden, appNotFound } from '../result';

export interface DocumentDownloadUrl {
  url: string;
  expiresInSeconds: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

export interface GetDocumentDownloadUrlInput {
  companyId: string;
  documentId: string;
  ttlSeconds?: number;
}

function dependencyError(port: string, e: unknown): AppError {
  return { kind: 'dependency', port, cause: e instanceof Error ? e.message : String(e) };
}

export class GetDocumentDownloadUrl {
  constructor(private readonly deps: { documents: DocumentRepository; storage: DocumentStoragePort }) {}

  async execute(input: GetDocumentDownloadUrlInput): Promise<Result<DocumentDownloadUrl, AppError>> {
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
      return err({ kind: 'validation', issues: [{ field: 'ttlSeconds', message: 'TTL attendu entre 60 et 3600 secondes.' }] });
    }
    const document = await this.deps.documents.findById(input.companyId, input.documentId);
    if (!document) return err(appNotFound('document', input.documentId));
    if (document.status !== 'active') return err(appForbidden('Document supprimé.'));
    const props = document.toProps();
    try {
      const url = await this.deps.storage.getSignedUrl(input.companyId, props.storageKey, ttlSeconds);
      return ok({
        url,
        expiresInSeconds: ttlSeconds,
        filename: props.filename,
        mimeType: props.mimeType,
        byteSize: props.byteSize,
        sha256: props.sha256,
      });
    } catch (e) {
      return err(dependencyError('document-storage', e));
    }
  }
}
