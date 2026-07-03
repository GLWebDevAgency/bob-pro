import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly, type Instant, isValidDateOnly } from '../../shared-kernel/time';

export type DocumentKind = 'invoice_pdf' | 'quote_pdf' | 'facturx_xml' | 'expense_receipt' | 'signed_quote' | 'other';
export type DocumentOrigin = 'generated' | 'uploaded' | 'ocr';
export type DocumentStatus = 'active' | 'deleted';
export type DocumentLinkedEntityType = 'invoice' | 'quote' | 'expense' | 'chantier' | 'company';

export interface DocumentVersionProps {
  id: string;
  documentId: string;
  version: number;
  storageKey: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
  createdAt: Instant;
  reason: string;
}

export interface DocumentProps {
  id: string;
  companyId: string;
  kind: DocumentKind;
  origin: DocumentOrigin;
  status: DocumentStatus;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storageKey: string;
  linkedEntityType: DocumentLinkedEntityType | null;
  linkedEntityId: string | null;
  documentDate: DateOnly | null;
  issuedAt: DateOnly | null;
  createdAt: Instant;
  createdBy: string | null;
  retentionUntil: DateOnly;
  deletedAt: Instant | null;
  versions: DocumentVersionProps[];
}

const KINDS: readonly DocumentKind[] = ['invoice_pdf', 'quote_pdf', 'facturx_xml', 'expense_receipt', 'signed_quote', 'other'];
const ORIGINS: readonly DocumentOrigin[] = ['generated', 'uploaded', 'ocr'];
const STATUSES: readonly DocumentStatus[] = ['active', 'deleted'];
const LINKED_ENTITY_TYPES: readonly DocumentLinkedEntityType[] = ['invoice', 'quote', 'expense', 'chantier', 'company'];
const SHA256 = /^[a-f0-9]{64}$/;

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validByteSize(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateVersion(v: DocumentVersionProps, documentId: string): DomainResult<DocumentVersionProps> {
  if (!nonEmpty(v.id)) return err({ code: 'VALIDATION', field: 'version.id', message: 'Id de version requis.' });
  if (v.documentId !== documentId)
    return err({ code: 'VALIDATION', field: 'version.documentId', message: 'Version rattachée au mauvais document.' });
  if (!Number.isSafeInteger(v.version) || v.version <= 0)
    return err({ code: 'VALIDATION', field: 'version.version', message: 'Numéro de version invalide.' });
  if (!nonEmpty(v.storageKey)) return err({ code: 'VALIDATION', field: 'version.storageKey', message: 'Clé de stockage requise.' });
  if (!SHA256.test(v.sha256)) return err({ code: 'VALIDATION', field: 'version.sha256', message: 'SHA-256 invalide.' });
  if (!nonEmpty(v.mimeType)) return err({ code: 'VALIDATION', field: 'version.mimeType', message: 'Type MIME requis.' });
  if (!validByteSize(v.byteSize)) return err({ code: 'VALIDATION', field: 'version.byteSize', message: 'Taille invalide.' });
  if (!nonEmpty(v.createdAt)) return err({ code: 'VALIDATION', field: 'version.createdAt', message: 'Date de création requise.' });
  const reason = v.reason.trim();
  if (!reason) return err({ code: 'VALIDATION', field: 'version.reason', message: 'Motif de version requis.' });
  return ok({ ...v, reason });
}

/**
 * Agrégat Document — métadonnées comptables d'un fichier archivé.
 * Le binaire vit dans un stockage objet ; l'agrégat porte l'audit, le rattachement métier et la rétention.
 */
export class Document {
  private constructor(private readonly p: DocumentProps) {}

  static record(props: DocumentProps): DomainResult<Document> {
    if (!nonEmpty(props.id)) return err({ code: 'VALIDATION', field: 'id', message: 'Id document requis.' });
    if (!nonEmpty(props.companyId)) return err({ code: 'VALIDATION', field: 'companyId', message: 'Tenant requis.' });
    if (!KINDS.includes(props.kind)) return err({ code: 'VALIDATION', field: 'kind', message: 'Type de document inconnu.' });
    if (!ORIGINS.includes(props.origin)) return err({ code: 'VALIDATION', field: 'origin', message: 'Origine de document inconnue.' });
    if (!STATUSES.includes(props.status)) return err({ code: 'VALIDATION', field: 'status', message: 'Statut de document inconnu.' });
    const filename = props.filename.trim();
    if (!filename) return err({ code: 'VALIDATION', field: 'filename', message: 'Nom de fichier requis.' });
    if (!nonEmpty(props.mimeType)) return err({ code: 'VALIDATION', field: 'mimeType', message: 'Type MIME requis.' });
    if (!validByteSize(props.byteSize)) return err({ code: 'VALIDATION', field: 'byteSize', message: 'Taille invalide.' });
    if (!SHA256.test(props.sha256)) return err({ code: 'VALIDATION', field: 'sha256', message: 'SHA-256 invalide.' });
    if (!nonEmpty(props.storageKey)) return err({ code: 'VALIDATION', field: 'storageKey', message: 'Clé de stockage requise.' });
    if (!props.storageKey.startsWith(`companies/${props.companyId}/documents/${props.id}/`)) {
      return err({ code: 'VALIDATION', field: 'storageKey', message: 'Clé de stockage hors périmètre tenant.' });
    }
    if ((props.linkedEntityType === null) !== (props.linkedEntityId === null)) {
      return err({ code: 'VALIDATION', field: 'linkedEntity', message: 'Rattachement métier incomplet.' });
    }
    if (props.linkedEntityType !== null && !LINKED_ENTITY_TYPES.includes(props.linkedEntityType)) {
      return err({ code: 'VALIDATION', field: 'linkedEntityType', message: 'Type de rattachement inconnu.' });
    }
    if (props.documentDate !== null && !isValidDateOnly(props.documentDate))
      return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date document invalide.' });
    if (props.issuedAt !== null && !isValidDateOnly(props.issuedAt))
      return err({ code: 'VALIDATION', field: 'issuedAt', message: 'Date émission invalide.' });
    if (!isValidDateOnly(props.retentionUntil))
      return err({ code: 'VALIDATION', field: 'retentionUntil', message: 'Date de rétention invalide.' });
    if (props.status === 'deleted' && props.deletedAt === null)
      return err({ code: 'VALIDATION', field: 'deletedAt', message: 'Date de suppression requise.' });
    if (props.versions.length === 0) return err({ code: 'VALIDATION', field: 'versions', message: 'Version initiale requise.' });

    const versions: DocumentVersionProps[] = [];
    const seen = new Set<number>();
    for (const v of props.versions) {
      const valid = validateVersion(v, props.id);
      if (!valid.ok) return valid;
      if (seen.has(valid.value.version)) {
        return err({ code: 'VALIDATION', field: 'versions', message: 'Version dupliquée.' });
      }
      seen.add(valid.value.version);
      versions.push(valid.value);
    }
    const current = versions.reduce((max, v) => (v.version > max.version ? v : max), versions[0]!);
    if (current.storageKey !== props.storageKey || current.sha256 !== props.sha256 || current.byteSize !== props.byteSize || current.mimeType !== props.mimeType) {
      return err({ code: 'VALIDATION', field: 'versions', message: 'La version courante ne correspond pas aux métadonnées.' });
    }

    return ok(new Document({ ...props, filename, versions }));
  }

  static rehydrate(props: DocumentProps): Document {
    return new Document({ ...props, versions: props.versions.map((v) => ({ ...v })) });
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get kind(): DocumentKind {
    return this.p.kind;
  }
  get status(): DocumentStatus {
    return this.p.status;
  }
  get storageKey(): string {
    return this.p.storageKey;
  }
  get sha256(): string {
    return this.p.sha256;
  }
  get retentionUntil(): DateOnly {
    return this.p.retentionUntil;
  }

  addVersion(version: DocumentVersionProps): DomainResult<void> {
    if (this.p.status !== 'active') return err({ code: 'INVALID_TRANSITION', from: this.p.status, to: 'active' });
    const next = Math.max(...this.p.versions.map((v) => v.version)) + 1;
    if (version.version !== next)
      return err({ code: 'VALIDATION', field: 'version', message: `Version attendue : ${next}.` });
    const valid = validateVersion(version, this.p.id);
    if (!valid.ok) return valid;
    this.p.versions.push(valid.value);
    this.p.storageKey = valid.value.storageKey;
    this.p.sha256 = valid.value.sha256;
    this.p.mimeType = valid.value.mimeType;
    this.p.byteSize = valid.value.byteSize;
    return ok(undefined);
  }

  /**
   * Classe le document : rattachement métier confirmé (proposition OCR validée par
   * l'artisan, ou par Bob — parité d'actions). Un document supprimé ne se classe pas.
   */
  classify(link: { linkedEntityType: DocumentLinkedEntityType; linkedEntityId: string }): DomainResult<void> {
    if (this.p.status !== 'active') return err({ code: 'INVALID_TRANSITION', from: this.p.status, to: 'active' });
    if (!LINKED_ENTITY_TYPES.includes(link.linkedEntityType))
      return err({ code: 'VALIDATION', field: 'linkedEntityType', message: 'Type de rattachement inconnu.' });
    if (!nonEmpty(link.linkedEntityId))
      return err({ code: 'VALIDATION', field: 'linkedEntityId', message: 'Rattachement métier incomplet.' });
    this.p.linkedEntityType = link.linkedEntityType;
    this.p.linkedEntityId = link.linkedEntityId;
    return ok(undefined);
  }

  markDeleted(at: Instant): DomainResult<void> {
    if (this.p.status === 'deleted') return ok(undefined);
    this.p.status = 'deleted';
    this.p.deletedAt = at;
    return ok(undefined);
  }

  toProps(): DocumentProps {
    return { ...this.p, versions: this.p.versions.map((v) => ({ ...v })) };
  }
}
