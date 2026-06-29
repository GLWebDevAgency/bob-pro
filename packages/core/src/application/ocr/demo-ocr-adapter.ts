import { type Result, ok } from '../../shared-kernel/result';
import { type AppError } from '../result';
import { type OcrPort, type OcrExtractInput } from '../ports/ocr';
import { type OcrExtraction, type ExpenseCategoryGuess } from '../../domain/ocr/ocr-extraction';

// FNV-1a 32 bits — déterministe (pas de Date.now / Math.random) : démo reproductible.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const SUPPLIERS: { name: string; siren: string | null; cat: ExpenseCategoryGuess }[] = [
  { name: 'Point P Matériaux', siren: null, cat: 'materiel' },
  { name: 'Leroy Merlin', siren: null, cat: 'fournitures' },
  { name: 'TotalEnergies Station', siren: null, cat: 'carburant' },
  { name: 'Brasserie du Coin', siren: null, cat: 'repas' },
  { name: 'SARL Dupont Plomberie', siren: '732829320', cat: 'sous_traitance' },
];

/**
 * Adapter OCR de démonstration : déterministe et hors-ligne — l'app fonctionne sans service externe
 * (parité avec/sans IA). Réutilisé par le client local (mobile démo) et le backend en DEMO_MODE.
 */
export class DemoOcrAdapter implements OcrPort {
  async extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>> {
    const h = hash32(input.contentBase64);
    const sup = SUPPLIERS[h % SUPPLIERS.length]!;
    const totalTtcCents = 1500 + (h % 48500);
    const vatRate = [20, 10, 5.5][h % 3]!;
    const totalHtCents = Math.round(totalTtcCents / (1 + vatRate / 100));
    const vatCents = totalTtcCents - totalHtCents;
    const month = String(1 + ((h >>> 16) % 12)).padStart(2, '0');
    const day = String(1 + ((h >>> 8) % 28)).padStart(2, '0');
    const extraction: OcrExtraction = {
      supplierName: sup.name,
      supplierSiren: sup.siren,
      documentDate: `2026-${month}-${day}`,
      totalTtcCents,
      totalHtCents,
      vatCents,
      vatRatePctApplied: vatRate,
      currency: 'EUR',
      categoryGuess: sup.cat,
      confidence: 0.78 + (h % 20) / 100,
      rawText: `${sup.name}\nTOTAL TTC ${(totalTtcCents / 100).toFixed(2)} EUR\nTVA ${vatRate}%`,
    };
    return ok(extraction);
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
