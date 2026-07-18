import { type Document, type DocumentKind, type DocumentOrigin, type DocumentStatus, type DocumentLinkedEntityType } from '../../domain/document/document';
import { type DateOnly, type Instant } from '../../shared-kernel/time';

export interface DocumentView {
  id: string;
  companyId: string;
  kind: DocumentKind;
  origin: DocumentOrigin;
  status: DocumentStatus;
  filename: string;
  /** Libellé d'affichage (renommable) — jamais vide, défaut dérivé du filename. */
  displayName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storageKey: string;
  folderId: string | null;
  revision: number;
  version: number;
  linkedEntityType: DocumentLinkedEntityType | null;
  linkedEntityId: string | null;
  documentDate: DateOnly | null;
  issuedAt: DateOnly | null;
  createdAt: Instant;
  createdBy: string | null;
  retentionUntil: DateOnly;
  tags: string[];
  /** Confirmation humaine du document scanné — null : jamais validé (dont lignes historiques). */
  reviewedAt: Instant | null;
}

export function documentToView(document: Document): DocumentView {
  const p = document.toProps();
  const latest = p.versions.reduce((max, v) => (v.version > max.version ? v : max), p.versions[0]!);
  return {
    id: p.id,
    companyId: p.companyId,
    kind: p.kind,
    origin: p.origin,
    status: p.status,
    filename: p.filename,
    displayName: document.displayName,
    mimeType: p.mimeType,
    byteSize: p.byteSize,
    sha256: p.sha256,
    storageKey: p.storageKey,
    folderId: p.folderId ?? null,
    revision: p.revision ?? 1,
    version: latest.version,
    linkedEntityType: p.linkedEntityType,
    linkedEntityId: p.linkedEntityId,
    documentDate: p.documentDate,
    issuedAt: p.issuedAt,
    createdAt: p.createdAt,
    createdBy: p.createdBy,
    retentionUntil: p.retentionUntil,
    tags: [...p.tags],
    reviewedAt: p.reviewedAt ?? null,
  };
}
