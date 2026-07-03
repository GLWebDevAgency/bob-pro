import { type Result, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type OcrPort, type OcrExtractInput } from '../ports/ocr';
import { type OcrExtraction, makeOcrExtraction } from '../../domain/ocr/ocr-extraction';

export interface ExtractDocumentInput {
  contentBase64: string;
  mimeType: string;
  /** Contexte métier optionnel (A3-C14) — propagé tel quel au port OCR (données pures). */
  trade?: OcrExtractInput['trade'];
}

export interface ExtractDocumentDeps {
  ocr: OcrPort;
}

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/**
 * Use case : appelle le port OCR, puis revalide/normalise l'extraction via le domaine.
 * Défense en profondeur : même la sortie d'un adapter est revalidée (montants centimes, SIREN Luhn…).
 */
export class ExtractDocument {
  constructor(private readonly deps: ExtractDocumentDeps) {}

  async execute(input: ExtractDocumentInput): Promise<Result<OcrExtraction, AppError>> {
    if (!ACCEPTED.includes(input.mimeType))
      return err({ kind: 'validation', issues: [{ field: 'mimeType', message: `Type non supporté : ${input.mimeType}` }] });

    // Tolère un préfixe data: URI éventuel.
    const contentBase64 = input.contentBase64.replace(/^data:[^;]+;base64,/, '').trim();
    if (!contentBase64)
      return err({ kind: 'validation', issues: [{ field: 'contentBase64', message: 'Document vide.' }] });

    const extracted = await this.deps.ocr.extractDocument({ contentBase64, mimeType: input.mimeType, ...(input.trade ? { trade: input.trade } : {}) });
    if (!extracted.ok) return extracted;

    const normalized = makeOcrExtraction(extracted.value);
    if (!normalized.ok) return err(appDomain(normalized.error));
    return normalized;
  }
}
