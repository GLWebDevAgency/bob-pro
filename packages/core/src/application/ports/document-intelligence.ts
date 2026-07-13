import { type DocumentAnalysisDraft } from '../../domain/document/document-analysis';
import { type Result } from '../../shared-kernel/result';
import { type AppError } from '../result';

/**
 * Entrée binaire du moteur documentaire.
 *
 * Les octets sont rechargés côté serveur depuis le coffre : aucun adapter ne doit demander
 * au mobile de renvoyer un base64 après l'archivage de l'original.
 */
export interface DocumentIntelligenceInput {
  documentId: string;
  documentVersion: number;
  sourceSha256: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface DocumentIntelligenceOutput {
  /** Version stable du pipeline (modèle + prompt + schéma), persistable pour l'audit. */
  analyzerVersion: string;
  /** Sortie non fiable : le domaine la revalide avant toute exposition. */
  analysis: DocumentAnalysisDraft;
}

/** Port sortant pur ; les adapters OCR/vision et leurs SDK restent dans l'infrastructure. */
export interface DocumentIntelligencePort {
  analyzeDocument(input: DocumentIntelligenceInput): Promise<Result<DocumentIntelligenceOutput, AppError>>;
}
