import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly, type DateOnly } from '../../shared-kernel/time';
import { Document, type DocumentKind, type DocumentLinkedEntityType, type DocumentOrigin } from '../../domain/document/document';
import { type DocumentFolderRepository } from '../ports/document-folder-repository';
import { type DocumentRepository } from '../ports/document-repository';
import { type DocumentLinkTargetPort } from '../ports/document-link-target';
import { type DocumentStoragePort } from '../ports/document-storage';
import { type ClockPort } from '../ports/services';
import { type AppError, appDomain, appNotFound } from '../result';
import { documentToView, type DocumentView } from './document-view';

export interface StoreDocumentInput {
  id: string;
  versionId: string;
  companyId: string;
  kind: DocumentKind;
  origin: DocumentOrigin;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
  storageKey: string;
  folderId?: string | null;
  linkedEntityType?: DocumentLinkedEntityType | null;
  linkedEntityId?: string | null;
  documentDate?: DateOnly | null;
  issuedAt?: DateOnly | null;
  createdBy?: string | null;
  retentionUntil?: DateOnly;
  reason?: string;
  /** Tags proposés par l'OCR, confirmés à l'enregistrement (#11). */
  tags?: string[];
}

export interface StoreDocumentDeps {
  documents: Pick<DocumentRepository, 'save'>;
  folders: Pick<DocumentFolderRepository, 'findById'>;
  linkTargets: DocumentLinkTargetPort;
  storage: DocumentStoragePort;
  clock: ClockPort;
}

function addYears(date: DateOnly, years: number): DateOnly {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function dependencyError(port: string, e: unknown): AppError {
  return { kind: 'dependency', port, cause: e instanceof Error ? e.message : String(e) };
}

async function bestEffortRemove(storage: DocumentStoragePort, companyId: string, storageKey: string): Promise<void> {
  try {
    await storage.remove(companyId, storageKey);
  } catch {
    // L'appelant reçoit l'erreur primaire ; la purge sera reprise par maintenance si besoin.
  }
}

export class StoreDocument {
  constructor(private readonly deps: StoreDocumentDeps) {}

  async execute(input: StoreDocumentInput): Promise<Result<DocumentView, AppError>> {
    if (input.bytes.byteLength === 0) {
      return err({ kind: 'validation', issues: [{ field: 'bytes', message: 'Document vide.' }] });
    }

    const now = this.deps.clock.now();
    // Ancre calendrier par défaut = jour MÉTIER Europe/Paris (classement + rétention légale) :
    // l'UTC brut daterait de la veille une pièce déposée entre minuit et ~2 h, heure de Paris.
    const anchor = input.issuedAt ?? input.documentDate ?? parisDateOnly(now);
    const linkedEntityType = input.linkedEntityType ?? null;
    const linkedEntityId = input.linkedEntityId ?? null;
    const document = Document.record({
      id: input.id,
      companyId: input.companyId,
      kind: input.kind,
      origin: input.origin,
      status: 'active',
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      sha256: input.sha256,
      storageKey: input.storageKey,
      folderId: input.folderId ?? null,
      linkedEntityType,
      linkedEntityId,
      documentDate: input.documentDate ?? null,
      issuedAt: input.issuedAt ?? null,
      createdAt: now,
      createdBy: input.createdBy ?? null,
      tags: input.tags ?? [],
      retentionUntil: input.retentionUntil ?? addYears(anchor, 10),
      deletedAt: null,
      versions: [
        {
          id: input.versionId,
          documentId: input.id,
          version: 1,
          storageKey: input.storageKey,
          sha256: input.sha256,
          mimeType: input.mimeType,
          byteSize: input.bytes.byteLength,
          createdAt: now,
          reason: input.reason ?? 'initial',
        },
      ],
    });
    if (!document.ok) return err(appDomain(document.error));

    const documentProps = document.value.toProps();
    const folderId = document.value.folderId;
    if (folderId !== null) {
      const folder = await this.deps.folders.findById(input.companyId, folderId);
      if (!folder || folder.status !== 'active') {
        return err(appNotFound('document_folder', folderId));
      }
    }
    if (
      documentProps.linkedEntityType !== null
      && documentProps.linkedEntityId !== null
      && !(await this.deps.linkTargets.exists({
        companyId: input.companyId,
        linkedEntityType: documentProps.linkedEntityType,
        linkedEntityId: documentProps.linkedEntityId,
      }))
    ) {
      return err(appNotFound(documentProps.linkedEntityType, documentProps.linkedEntityId));
    }

    let stored;
    try {
      stored = await this.deps.storage.put({
        companyId: input.companyId,
        key: input.storageKey,
        bytes: input.bytes,
        contentType: input.mimeType,
      });
    } catch (e) {
      return err(dependencyError('document-storage', e));
    }

    if (stored.sha256 !== input.sha256 || stored.sizeBytes !== input.bytes.byteLength) {
      await bestEffortRemove(this.deps.storage, input.companyId, input.storageKey);
      return err({
        kind: 'dependency',
        port: 'document-storage',
        cause: 'Stored object metadata mismatch.',
      });
    }

    try {
      await this.deps.documents.save(document.value);
    } catch (e) {
      await bestEffortRemove(this.deps.storage, input.companyId, input.storageKey);
      throw e;
    }

    return ok(documentToView(document.value));
  }
}
