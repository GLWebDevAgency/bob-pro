import { type Result } from '../../shared-kernel/result';
import { type AppError } from '../result';
import { type OcrExtraction } from '../../domain/ocr/ocr-extraction';

export interface OcrExtractInput {
  /** Octets du document, encodés en base64 (image jpg/png/webp ou PDF). */
  contentBase64: string;
  /** ex. 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'. */
  mimeType: string;
}

/**
 * Port de sortie OCR : extrait des champs structurés d'une facture/ticket fournisseur.
 * Les adapters réels (vision Claude/GLM) vivent côté infra (apps/api) ; @bob/core ne connaît que ce contrat.
 */
export interface OcrPort {
  extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>>;
  health(): Promise<{ healthy: boolean }>;
}
