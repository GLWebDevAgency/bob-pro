export type DocumentArchiveJobStatus = 'pending' | 'done' | 'failed';

/**
 * Motif d'archivage — détermine la pièce visée par `pieceId` :
 * - 'invoice-issued' : original (PDF + Factur-X) d'une facture ÉMISE (immutabilité comptable) ;
 * - 'quote-signed'   : original du DEVIS SIGNÉ, c'est-à-dire le contrat (A8 — conservation
 *   10 ans des contrats électroniques B2C ≥ 120 €, art. L213-1 code conso ; valeur probante
 *   de l'écrit électronique, art. 1366-1367 code civil).
 */
export type DocumentArchiveJobReason = 'invoice-issued' | 'quote-signed';

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
  lastError: string | null;
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
  /** Ordre d'archivage d'UNE pièce, quel que soit son statut — null = aucun ordre jamais émis
   *  (pièce antérieure à la mécanique d'archivage : legacy honnête, jamais rétro-générée). */
  findByPiece(
    companyId: string,
    pieceId: string,
    reason: DocumentArchiveJobReason,
  ): Promise<DocumentArchiveJob | null>;
  /** Nombre d'ordres non aboutis (status ≠ done) pour un motif — barrière de complétude. */
  countIncomplete(companyId: string, reason: DocumentArchiveJobReason): Promise<number>;
  markDone(id: string, at: string): Promise<void>;
  markFailed(id: string, at: string, nextAttemptAt: string, error: string): Promise<void>;
}
