import { type DocumentAnalysisDraft } from '../../domain/document/document-analysis';
import { type DocumentFolderSystemKey } from '../../domain/document/document-folder';
import { type Result } from '../../shared-kernel/result';
import { type AppError } from '../result';

/**
 * Contexte de classement tenant-aware transmis au moteur documentaire.
 *
 * Il énumère les SEULES cibles réelles que le modèle peut suggérer : tout id hors de cette
 * liste est rejeté au retour par `makeDocumentDestinationSuggestion` (anti-hallucination).
 * Un document peut légitimement viser un dossier hors chantier (frais généraux, Kbis…).
 */
export interface DocumentClassificationContext {
  /** Chantiers ouverts du tenant (id réel + nom, client éventuel pour aider le modèle). */
  chantiersOuverts: readonly { id: string; nom: string; clientNom?: string | null }[];
  /** Dossiers du coffre (systemKey présent pour les dossiers système, null pour un personnalisé). */
  dossiers: readonly { id: string; nom: string; systemKey?: DocumentFolderSystemKey | null }[];
}

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
  /** Contexte de classement — optionnel (compat) ; sans lui, aucune suggestion de chantier ne survivra. */
  classificationContext?: DocumentClassificationContext;
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
