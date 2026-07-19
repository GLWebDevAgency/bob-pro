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
  /** Libellé d'affichage (renommable) — le `filename` d'archive reste IMMUABLE. Défaut : filename. */
  displayName?: string | null;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storageKey: string;
  /** Emplacement dans le coffre. Indépendant du rattachement métier/comptable. */
  folderId?: string | null;
  /** Révision optimiste des métadonnées (le blob/version reste immuable). */
  revision?: number;
  linkedEntityType: DocumentLinkedEntityType | null;
  linkedEntityId: string | null;
  documentDate: DateOnly | null;
  issuedAt: DateOnly | null;
  createdAt: Instant;
  createdBy: string | null;
  retentionUntil: DateOnly;
  deletedAt: Instant | null;
  versions: DocumentVersionProps[];
  /** Tags de classement/recherche (#11 excellence) — normalisés, ≤ 16. */
  tags: string[];
  /** Confirmation humaine (ou Bob — parité voix) d'un document scanné.
   *  null / absent (ligne historique) = jamais validé. La première validation fait foi. */
  reviewedAt?: Instant | null;
}

const KINDS: readonly DocumentKind[] = ['invoice_pdf', 'quote_pdf', 'facturx_xml', 'expense_receipt', 'signed_quote', 'other'];
const ORIGINS: readonly DocumentOrigin[] = ['generated', 'uploaded', 'ocr'];
const STATUSES: readonly DocumentStatus[] = ['active', 'deleted'];
const LINKED_ENTITY_TYPES: readonly DocumentLinkedEntityType[] = ['invoice', 'quote', 'expense', 'chantier', 'company'];
const SHA256 = /^[a-f0-9]{64}$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export const DOCUMENT_DISPLAY_NAME_MAX_LENGTH = 120;

/** Caractère de contrôle ASCII (C0 + DEL) — interdit dans un libellé d'affichage. */
function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

/**
 * Valide un libellé d'affichage de document (renommage humain ou par Bob) :
 * espaces réduits, non vide, borné, sans caractère de contrôle.
 */
export function validateDocumentDisplayName(value: unknown): DomainResult<string> {
  if (typeof value !== 'string') {
    return err({ code: 'VALIDATION', field: 'displayName', message: "Nom d'affichage requis." });
  }
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) return err({ code: 'VALIDATION', field: 'displayName', message: "Nom d'affichage requis." });
  if (name.length > DOCUMENT_DISPLAY_NAME_MAX_LENGTH) {
    return err({
      code: 'VALIDATION',
      field: 'displayName',
      message: `Le nom d'affichage ne peut pas dépasser ${DOCUMENT_DISPLAY_NAME_MAX_LENGTH} caractères.`,
    });
  }
  if ([...name].some(isControlCharacter)) {
    return err({ code: 'VALIDATION', field: 'displayName', message: "Le nom d'affichage contient un caractère interdit." });
  }
  return ok(name);
}

/** Libellé par défaut dérivé du filename d'archive (assaini et borné, jamais vide). */
function defaultDocumentDisplayName(filename: string): string {
  const collapsed = [...filename]
    .map((character) => (isControlCharacter(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DOCUMENT_DISPLAY_NAME_MAX_LENGTH)
    .trim();
  return collapsed || 'Document';
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
    if (props.revision !== undefined && (!Number.isSafeInteger(props.revision) || props.revision < 1)) {
      return err({ code: 'VALIDATION', field: 'revision', message: 'Révision document invalide.' });
    }
    if (!props.storageKey.startsWith(`companies/${props.companyId}/documents/${props.id}/`)) {
      return err({ code: 'VALIDATION', field: 'storageKey', message: 'Clé de stockage hors périmètre tenant.' });
    }
    if ((props.linkedEntityType === null) !== (props.linkedEntityId === null)) {
      return err({ code: 'VALIDATION', field: 'linkedEntity', message: 'Rattachement métier incomplet.' });
    }
    if (props.linkedEntityType !== null && !LINKED_ENTITY_TYPES.includes(props.linkedEntityType)) {
      return err({ code: 'VALIDATION', field: 'linkedEntityType', message: 'Type de rattachement inconnu.' });
    }
    if (props.linkedEntityType !== null && !nonEmpty(props.linkedEntityId)) {
      return err({ code: 'VALIDATION', field: 'linkedEntityId', message: 'Rattachement métier incomplet.' });
    }
    if (props.documentDate !== null && !isValidDateOnly(props.documentDate))
      return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date document invalide.' });
    if (props.issuedAt !== null && !isValidDateOnly(props.issuedAt))
      return err({ code: 'VALIDATION', field: 'issuedAt', message: 'Date émission invalide.' });
    if (!isValidDateOnly(props.retentionUntil))
      return err({ code: 'VALIDATION', field: 'retentionUntil', message: 'Date de rétention invalide.' });
    if (props.status === 'deleted' && props.deletedAt === null)
      return err({ code: 'VALIDATION', field: 'deletedAt', message: 'Date de suppression requise.' });
    if (props.reviewedAt !== undefined && props.reviewedAt !== null && !nonEmpty(props.reviewedAt))
      return err({ code: 'VALIDATION', field: 'reviewedAt', message: 'Date de validation invalide.' });
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

    const tags = [...new Set(props.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2 && t.length <= 32))].slice(0, 16);

    // Libellé d'affichage : fourni → validé strictement ; absent → dérivé du filename (immuable).
    let displayName: string;
    if (props.displayName !== undefined && props.displayName !== null) {
      const validated = validateDocumentDisplayName(props.displayName);
      if (!validated.ok) return validated;
      displayName = validated.value;
    } else {
      displayName = defaultDocumentDisplayName(filename);
    }

    return ok(new Document({
      ...props,
      folderId: props.folderId ?? null,
      revision: props.revision ?? 1,
      filename,
      displayName,
      linkedEntityId: props.linkedEntityId?.trim() ?? null,
      reviewedAt: props.reviewedAt ?? null,
      versions,
      tags,
    }));
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

  get folderId(): string | null {
    return this.p.folderId ?? null;
  }

  /** Libellé d'affichage courant — retombe sur le filename pour les lignes historiques. */
  get displayName(): string {
    return this.p.displayName ?? defaultDocumentDisplayName(this.p.filename);
  }

  get revision(): number {
    return this.p.revision ?? 1;
  }

  /** Confirmation humaine (« c'est bon ») — null pour toute ligne historique non validée. */
  get reviewedAt(): Instant | null {
    return this.p.reviewedAt ?? null;
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
    this.bumpRevision();
    return ok(undefined);
  }

  /**
   * Classe le document : rattachement métier confirmé (proposition OCR validée par
   * l'artisan, ou par Bob — parité d'actions). Un document supprimé ne se classe pas.
   *
   * GARDE ANTI-ÉCRASEMENT : un lien métier existant ne se réécrit JAMAIS silencieusement.
   * Le re-lien strictement IDENTIQUE reste idempotent (aucun changement, aucune erreur —
   * les retries des clients s'appuient dessus) ; un lien DIFFÉRENT est refusé avec
   * `DOCUMENT_ALREADY_LINKED` (les deux liens dans l'erreur, existant vs demandé).
   */
  classify(link: { linkedEntityType: DocumentLinkedEntityType; linkedEntityId: string }): DomainResult<void> {
    if (this.p.status !== 'active') return err({ code: 'INVALID_TRANSITION', from: this.p.status, to: 'active' });
    if (!LINKED_ENTITY_TYPES.includes(link.linkedEntityType))
      return err({ code: 'VALIDATION', field: 'linkedEntityType', message: 'Type de rattachement inconnu.' });
    if (!nonEmpty(link.linkedEntityId))
      return err({ code: 'VALIDATION', field: 'linkedEntityId', message: 'Rattachement métier incomplet.' });
    const linkedEntityId = link.linkedEntityId.trim();
    // Re-lien identique : idempotent, sans révision fantôme.
    if (this.p.linkedEntityType === link.linkedEntityType && this.p.linkedEntityId === linkedEntityId) {
      return ok(undefined);
    }
    // Lien DIFFÉRENT alors qu'un lien existe : refus explicite — délier est un geste à part.
    if (this.p.linkedEntityType !== null && this.p.linkedEntityId !== null) {
      return err({
        code: 'DOCUMENT_ALREADY_LINKED',
        documentId: this.p.id,
        existing: { linkedEntityType: this.p.linkedEntityType, linkedEntityId: this.p.linkedEntityId },
        requested: { linkedEntityType: link.linkedEntityType, linkedEntityId },
        message:
          `Ce document est déjà rattaché à ${this.p.linkedEntityType}/${this.p.linkedEntityId} ; `
          + `rattachement demandé : ${link.linkedEntityType}/${linkedEntityId}. Délier d'abord le lien existant.`,
      });
    }
    this.p.linkedEntityType = link.linkedEntityType;
    this.p.linkedEntityId = linkedEntityId;
    this.bumpRevision();
    return ok(undefined);
  }

  /** Déplace uniquement l'original dans le coffre, sans modifier son lien métier. */
  moveToFolder(folderId: string | null): DomainResult<void> {
    if (this.p.status !== 'active') return err({ code: 'INVALID_TRANSITION', from: this.p.status, to: 'active' });
    if (folderId !== null && !nonEmpty(folderId)) {
      return err({ code: 'VALIDATION', field: 'folderId', message: 'Dossier de destination invalide.' });
    }
    if ((this.p.folderId ?? null) !== folderId) {
      this.p.folderId = folderId;
      this.bumpRevision();
    }
    return ok(undefined);
  }

  /**
   * Renomme le libellé d'affichage (humain ou Bob — parité d'actions). Le `filename`
   * d'archive, les versions et les empreintes restent immuables : seule la présentation change.
   */
  rename(displayName: string): DomainResult<void> {
    if (this.p.status !== 'active') return err({ code: 'INVALID_TRANSITION', from: this.p.status, to: 'active' });
    const validated = validateDocumentDisplayName(displayName);
    if (!validated.ok) return validated;
    if (this.displayName !== validated.value) {
      this.p.displayName = validated.value;
      this.bumpRevision();
    }
    return ok(undefined);
  }

  /**
   * Pose la confirmation humaine du document (« c'est bon, je valide » — humain ou Bob,
   * parité d'actions). Ne déplace ni ne lie rien : seul reviewedAt change (révision
   * optimiste). Idempotent : re-marquer un document déjà validé ne change rien — la
   * première validation fait foi, son horodatage n'est jamais écrasé.
   */
  markReviewed(at: Instant): DomainResult<void> {
    if ((this.p.reviewedAt ?? null) !== null) return ok(undefined);
    if (this.p.status !== 'active') return err({ code: 'INVALID_TRANSITION', from: this.p.status, to: 'active' });
    if (!nonEmpty(at)) return err({ code: 'VALIDATION', field: 'reviewedAt', message: 'Date de validation requise.' });
    this.p.reviewedAt = at;
    this.bumpRevision();
    return ok(undefined);
  }

  markDeleted(at: Instant): DomainResult<void> {
    if (this.p.status === 'deleted') return ok(undefined);
    this.p.status = 'deleted';
    this.p.deletedAt = at;
    this.bumpRevision();
    return ok(undefined);
  }

  toProps(): DocumentProps {
    return {
      ...this.p,
      folderId: this.p.folderId ?? null,
      revision: this.p.revision ?? 1,
      displayName: this.displayName,
      reviewedAt: this.p.reviewedAt ?? null,
      versions: this.p.versions.map((v) => ({ ...v })),
    };
  }

  private bumpRevision(): void {
    this.p.revision = (this.p.revision ?? 1) + 1;
  }
}
