import { type Result, ok } from '../../shared-kernel/result';
import { addDays } from '../../shared-kernel/time';
import { type AppError } from '../result';
import { type OcrPort, type OcrExtractInput } from '../ports/ocr';
import { type ClockPort } from '../ports/services';
import {
  canonicalReceiptFilename,
  normalizeSuggestedTags,
  type ExpenseCategoryGuess,
  type OcrDocumentKind,
  type OcrExtraction,
  type OcrPaymentMethodSeen,
} from '../../domain/ocr/ocr-extraction';

// FNV-1a 32 bits — déterministe (pas de Date.now / Math.random) : démo reproductible.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const SUPPLIERS: {
  name: string;
  siren: string | null;
  cat: ExpenseCategoryGuess;
  /** Discriminant payé/à payer de la démo — les trois routes (ticket/facture/ambigu) sont exerçables. */
  kind: OcrDocumentKind | null;
  method: OcrPaymentMethodSeen | null;
}[] = [
  { name: 'Point P Matériaux', siren: null, cat: 'materiel', kind: 'facture_fournisseur', method: null },
  { name: 'Leroy Merlin', siren: null, cat: 'fournitures', kind: 'ticket_caisse', method: 'card' },
  { name: 'TotalEnergies Station', siren: null, cat: 'carburant', kind: 'ticket_caisse', method: 'card' },
  { name: 'Brasserie du Coin', siren: null, cat: 'repas', kind: 'ticket_caisse', method: 'cash' },
  { name: 'SARL Dupont Plomberie', siren: '732829320', cat: 'sous_traitance', kind: 'facture_fournisseur', method: null },
  // Grossiste généraliste : on y achète de tout — la devinette « autre » est une ambiguïté
  // DE FAIT (l'OCR avoue ne pas savoir) ; confiance plafonnée basse → la question de
  // catégorie (ASK-3) est exerçable en démo, de façon déterministe par photo. Idem pour le
  // statut payé/à payer : kind null → l'écran de validation pose la question.
  { name: 'Metro Cash & Carry', siren: null, cat: 'autre', kind: null, method: null },
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
      kind: sup.kind,
      paymentMethodSeen: sup.kind === 'ticket_caisse' ? sup.method : null,
      // Facture fournisseur de démo : échéance réaliste à 30 jours de la pièce.
      dueDate: sup.kind === 'facture_fournisseur' ? addDays(documentDate, 30) : null,
    };
    return ok(extraction);
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
