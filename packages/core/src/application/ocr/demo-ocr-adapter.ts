import { type Result, ok } from '../../shared-kernel/result';
import { addDays } from '../../shared-kernel/time';
import { type AppError } from '../result';
import { type OcrPort, type OcrExtractInput } from '../ports/ocr';
import { type ClockPort } from '../ports/services';
import { canonicalReceiptFilename, normalizeSuggestedTags, type OcrExtraction, type ExpenseCategoryGuess } from '../../domain/ocr/ocr-extraction';

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
  // Grossiste généraliste : on y achète de tout — la devinette « autre » est une ambiguïté
  // DE FAIT (l'OCR avoue ne pas savoir) ; confiance plafonnée basse → la question de
  // catégorie (ASK-3) est exerçable en démo, de façon déterministe par photo.
  { name: 'Metro Cash & Carry', siren: null, cat: 'autre' },
];

/**
 * Adapter OCR de démonstration : déterministe et hors-ligne — l'app fonctionne sans service externe
 * (parité avec/sans IA). Réutilisé par le client local (mobile démo) et le backend en DEMO_MODE.
 */
export class DemoOcrAdapter implements OcrPort {
  constructor(private readonly clock?: ClockPort) {}

  async extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>> {
    const h = hash32(input.contentBase64);
    const sup = SUPPLIERS[h % SUPPLIERS.length]!;
    const totalTtcCents = 1500 + (h % 48500);
    const vatRate = [20, 10, 5.5][h % 3]!;
    const totalHtCents = Math.round(totalTtcCents / (1 + vatRate / 100));
    const vatCents = totalTtcCents - totalHtCents;
    // Date dans le passé récent (0..89 j avant aujourd'hui) : réaliste + jamais future, déterministe par jour.
    const documentDate = addDays(this.clock?.today() ?? '2026-06-29', -(h % 90));
    const extraction: OcrExtraction = {
      supplierName: sup.name,
      supplierSiren: sup.siren,
      documentDate,
      totalTtcCents,
      totalHtCents,
      vatCents,
      vatRatePctApplied: vatRate,
      currency: 'EUR',
      categoryGuess: sup.cat,
      confidence: sup.cat === 'autre' ? 0.55 + (h % 15) / 100 : 0.78 + (h % 20) / 100,
      rawText: `${sup.name}\nTOTAL TTC ${(totalTtcCents / 100).toFixed(2)} EUR\nTVA ${vatRate}%`,
      suggestedTags: normalizeSuggestedTags([sup.cat, sup.name]),
      suggestedFilename: canonicalReceiptFilename({ documentDate, supplierName: sup.name, totalTtcCents }),
    };
    return ok(extraction);
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
