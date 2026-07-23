import { createHash } from 'node:crypto';

export type DocumentArchiveJobStatus = 'pending' | 'done' | 'failed';

/**
 * Motif d'archivage — détermine la pièce visée par `pieceId` :
 * - 'invoice-issued' : original (PDF + Factur-X) d'une facture ÉMISE (immutabilité comptable) ;
 * - 'invoice-issued-pdf-only-b2c' : original PDF d'une facture B2C sans endpoint électronique ;
 *   le job n'invente jamais un XML Flux 2 qui serait invalide sans BT-49 ;
 * - 'quote-signed'   : original du DEVIS SIGNÉ, c'est-à-dire le contrat (A8 — conservation
 *   10 ans des contrats électroniques B2C ≥ 120 €, art. L213-1 code conso ; valeur probante
 *   de l'écrit électronique, art. 1366-1367 code civil).
 */
export type DocumentArchiveJobReason =
  | 'invoice-issued'
  | 'invoice-issued-pdf-only-b2c'
  | 'quote-signed';

export const LEGACY_ARCHIVE_PROOF_REQUIRED = '[archive-integrity-proof-required]';

export interface DocumentArchiveArtifactProof {
  kind: 'invoice_pdf' | 'facturx_xml' | 'signed_quote';
  /** Attestation dérivée des octets relus, jamais du nom/type de la pièce. */
  contentProfile: 'plain_pdf' | 'facturx_pdfa3' | 'facturx_xml';
  documentId: string;
  versionId: string;
  version: 1;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

/** Preuve versionnée, construite uniquement après relecture des octets du stockage objet. */
export interface DocumentArchiveIntegrityProof {
  version: 1;
  algorithm: 'sha256';
  companyId: string;
  pieceId: string;
  reason: DocumentArchiveJobReason;
  artifacts: DocumentArchiveArtifactProof[];
}

export function isValidDocumentArchiveIntegrityProof(
  proof: DocumentArchiveIntegrityProof,
): boolean {
  if (
    proof === null
    || typeof proof !== 'object'
    || Object.keys(proof).sort().join(',') !==
      'algorithm,artifacts,companyId,pieceId,reason,version'
    || !Array.isArray(proof.artifacts)
    || (
      proof.reason !== 'invoice-issued'
      && proof.reason !== 'invoice-issued-pdf-only-b2c'
      && proof.reason !== 'quote-signed'
    )
    || proof.version !== 1
    || proof.algorithm !== 'sha256'
    || typeof proof.companyId !== 'string'
    || proof.companyId.trim() === ''
    || typeof proof.pieceId !== 'string'
    || proof.pieceId.trim() === ''
  ) {
    return false;
  }
  const expectedKinds = proof.reason === 'invoice-issued'
    ? ['facturx_xml', 'invoice_pdf']
    : proof.reason === 'invoice-issued-pdf-only-b2c'
      ? ['invoice_pdf']
      : ['signed_quote'];
  const kinds: string[] = [];
  const documentIds = new Set<string>();
  const versionIds = new Set<string>();
  const storageKeys = new Set<string>();
  for (const artifact of proof.artifacts) {
    if (
      artifact === null
      || typeof artifact !== 'object'
      || Object.keys(artifact).sort().join(',') !==
        'byteSize,contentProfile,documentId,kind,mimeType,sha256,storageKey,version,versionId'
      || typeof artifact.documentId !== 'string'
      || artifact.documentId.trim() === ''
      || typeof artifact.versionId !== 'string'
      || artifact.versionId.trim() === ''
      || artifact.version !== 1
      || typeof artifact.storageKey !== 'string'
      || !artifact.storageKey.startsWith(
        `companies/${proof.companyId}/documents/${artifact.documentId}/`,
      )
      || artifact.storageKey.includes('..')
      || artifact.storageKey.includes('//')
      || artifact.mimeType !== (
        artifact.kind === 'facturx_xml' ? 'application/xml' : 'application/pdf'
      )
      || artifact.contentProfile !== (
        artifact.kind === 'facturx_xml'
          ? 'facturx_xml'
          : artifact.kind === 'signed_quote'
            ? 'plain_pdf'
            : proof.reason === 'invoice-issued'
              ? 'facturx_pdfa3'
              : 'plain_pdf'
      )
      || !Number.isSafeInteger(artifact.byteSize)
      || artifact.byteSize <= 0
      || typeof artifact.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || documentIds.has(artifact.documentId)
      || versionIds.has(artifact.versionId)
      || storageKeys.has(artifact.storageKey)
    ) {
      return false;
    }
    kinds.push(artifact.kind);
    documentIds.add(artifact.documentId);
    versionIds.add(artifact.versionId);
    storageKeys.add(artifact.storageKey);
  }
  kinds.sort();
  return kinds.length === expectedKinds.length
    && kinds.every((kind, index) => kind === expectedKinds[index]);
}

export function documentArchiveIntegrityProofSha256(
  proof: DocumentArchiveIntegrityProof,
): string {
  const artifacts = [...proof.artifacts]
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .map((artifact) => [
      artifact.kind,
      artifact.contentProfile,
      artifact.documentId,
      artifact.versionId,
      artifact.version,
      artifact.storageKey,
      artifact.mimeType,
      artifact.byteSize,
      artifact.sha256,
    ]);
  return createHash('sha256')
    .update(JSON.stringify([
      proof.version,
      proof.algorithm,
      proof.companyId,
      proof.pieceId,
      proof.reason,
      artifacts,
    ]))
    .digest('hex');
}

export interface DocumentArchiveJob {
  id: string;
  companyId: string;
  /**
   * Id de la pièce à archiver : facture (reason 'invoice-issued') OU devis (reason
   * 'quote-signed'). Colonne historique `invoiceId` en base — un renommage de colonne ne
   * serait pas une migration additive ; la sémantique est portée par `reason`.
   */
  pieceId: string;
  reason: DocumentArchiveJobReason;
  status: DocumentArchiveJobStatus;
  attempts: number;
  nextAttemptAt: string;
  /** Fence du worker courant ; `nextAttemptAt` en est l'échéance récupérable. */
  leaseToken: string | null;
  lastError: string | null;
  integrityProof: DocumentArchiveIntegrityProof | null;
  integrityProofSha256: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueDocumentArchiveJobInput {
  id: string;
  companyId: string;
  pieceId: string;
  reason: DocumentArchiveJobReason;
  now: string;
}

export interface DocumentArchiveJobRepository {
  enqueue(input: EnqueueDocumentArchiveJobInput): Promise<void>;
  listDue(companyId: string, now: string, limit: number): Promise<DocumentArchiveJob[]>;
  /** Un seul worker gagne le lease avant rendu/stockage ; un lease expiré est récupérable. */
  claimForArchive(
    id: string,
    companyId: string,
    expectedUpdatedAt: string,
    now: string,
    leaseUntil: string,
    leaseToken: string,
  ): Promise<{ outcome: 'claimed'; job: DocumentArchiveJob } | { outcome: 'skipped' }>;
  /** Ordre d'archivage d'UNE pièce, quel que soit son statut — null = aucun ordre jamais émis
   *  (pièce antérieure à la mécanique d'archivage : legacy honnête, jamais rétro-générée). */
  findByPiece(
    companyId: string,
    pieceId: string,
    reason: DocumentArchiveJobReason,
  ): Promise<DocumentArchiveJob | null>;
  /** Nombre d'ordres sans terminaison ET preuve — barrière de complétude. */
  countIncomplete(companyId: string, reason: DocumentArchiveJobReason): Promise<number>;
  markDone(
    id: string,
    companyId: string,
    leaseToken: string,
    proof: DocumentArchiveIntegrityProof,
    proofSha256: string,
    at: string,
  ): Promise<boolean>;
  markFailed(
    id: string,
    companyId: string,
    leaseToken: string,
    at: string,
    nextAttemptAt: string,
    error: string,
  ): Promise<boolean>;
}
