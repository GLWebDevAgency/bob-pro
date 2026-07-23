import { type Document, type DocumentLinkedEntityType } from '../../domain/document/document';
import { type DateOnly, type Instant } from '../../shared-kernel/time';

export type InitialDocumentInsertResult =
  | { status: 'inserted'; document: Document }
  | { status: 'exact'; document: Document }
  | { status: 'conflict' };

/**
 * Attestation d'une représentation PDF de facture calculée par l'adapter qui a réellement
 * parsé les octets. Le core ne prétend pas analyser le conteneur PDF ; il transporte en revanche
 * un contrat strict jusqu'à la persistance atomique du document et de sa version initiale.
 */
export type InvoicePdfRepresentationAttestation =
  | {
      documentSha256: string;
      profile: 'plain_pdf';
      embeddedXmlSha256: null;
      detectorVersion: 1;
    }
  | {
      documentSha256: string;
      profile: 'facturx_pdfa3';
      embeddedXmlSha256: string;
      detectorVersion: 1;
    };

export type AttestInvoicePdfInput = InvoicePdfRepresentationAttestation & {
  companyId: string;
  documentId: string;
  versionId: string;
};

/**
 * Compare les faits immuables de l'archive initiale. Les métadonnées éditables du coffre
 * (libellé, dossier, tags, confirmation, révision) sont volontairement exclues : un retry tardif
 * ne doit ni les écraser ni transformer une réussite antérieure en échec.
 */
export function isExactInitialDocumentReplay(existing: Document, requested: Document): boolean {
  const left = existing.toProps();
  const right = requested.toProps();
  if (left.status !== 'active' || right.status !== 'active') return false;
  if (left.versions.length !== 1 || right.versions.length !== 1) return false;
  const leftVersion = left.versions[0]!;
  const rightVersion = right.versions[0]!;
  return (
    left.id === right.id
    && left.companyId === right.companyId
    && left.kind === right.kind
    && left.origin === right.origin
    && left.filename === right.filename
    && left.mimeType === right.mimeType
    && left.byteSize === right.byteSize
    && left.sha256 === right.sha256
    && left.storageKey === right.storageKey
    && left.linkedEntityType === right.linkedEntityType
    && left.linkedEntityId === right.linkedEntityId
    && left.documentDate === right.documentDate
    && left.issuedAt === right.issuedAt
    && left.retentionUntil === right.retentionUntil
    && left.deletedAt === right.deletedAt
    && leftVersion.id === rightVersion.id
    && leftVersion.documentId === rightVersion.documentId
    && leftVersion.version === rightVersion.version
    && leftVersion.storageKey === rightVersion.storageKey
    && leftVersion.sha256 === rightVersion.sha256
    && leftVersion.mimeType === rightVersion.mimeType
    && leftVersion.byteSize === rightVersion.byteSize
    && leftVersion.reason === rightVersion.reason
  );
}

export interface DocumentRepository {
  /** Insert append-only de la version initiale ; un retry exact relit l'existant, tout autre
   *  conflit d'identité/clé est refusé sans UPDATE. */
  insertInitialOrConfirmExact(
    d: Document,
    invoicePdfAttestation?: InvoicePdfRepresentationAttestation,
  ): Promise<InitialDocumentInsertResult>;
  /** Enregistre une attestation exacte pour un original déjà présent (reprise/audit). Un conflit
   *  ou un document non conforme renvoie false ; aucune attestation existante n'est réécrite. */
  attestInvoicePdf(input: AttestInvoicePdfInput): Promise<boolean>;
  /** Mutation atomique des métadonnées de rattachement, protégée par révision optimiste.
   *  Un classement explicite vaut validation humaine : `reviewedAt` (valeur latched calculée
   *  par le use case — la première validation fait foi) est persisté avec le lien. */
  classify(input: {
    companyId: string;
    documentId: string;
    linkedEntityType: DocumentLinkedEntityType;
    linkedEntityId: string;
    reviewedAt: Instant;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'>;
  /** Pose la confirmation humaine (reviewedAt) SANS déplacer ni lier — révision optimiste. */
  markReviewed(input: {
    companyId: string;
    documentId: string;
    reviewedAt: Instant;
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
