import { type AppError, appDomain } from '../result';
import {
  hasBillingControlCharacter,
  MAX_BILLING_AMOUNT_CENTS,
  type LineInput,
} from '../../domain/billing/shared/line-item';
import { validateLineDiscount } from '../../domain/billing/shared/discount';

export const MAX_BILLING_LINES = 100;

/**
 * Validation FRONTIÈRE des lignes libres d'une pièce (devis — CreateQuote, facture directe —
 * ComposeStandaloneInvoice) : mêmes règles, mêmes messages, une seule source. Retourne la
 * PREMIÈRE erreur rencontrée (null = lignes valides). Les règles cross-agrégat (TVA via
 * suggestVatRate) et les invariants d'agrégat (addLine) restent appliqués ensuite — cette
 * passe protège la frontière JSON/non typée (codecs défensifs).
 */
export function validateLineInputs(lines: LineInput[]): AppError | null {
  if (!Array.isArray(lines) || lines.length > MAX_BILLING_LINES) {
    return appDomain({ code: 'VALIDATION', field: 'lines', message: 'Nombre de lignes invalide.' });
  }
  let totalHtCents = 0;
  for (const line of lines) {
    if (
      typeof line.label !== 'string' ||
      line.label.trim().length === 0 ||
      line.label.length > 500 ||
      hasBillingControlCharacter(line.label)
    ) {
      return appDomain({ code: 'VALIDATION', field: 'label', message: 'Libellé de ligne invalide.' });
    }
    if (
      line.unit !== undefined &&
      (typeof line.unit !== 'string' ||
        line.unit.trim().length === 0 ||
        line.unit.length > 80 ||
        hasBillingControlCharacter(line.unit))
    ) {
      return appDomain({ code: 'VALIDATION', field: 'unit', message: 'Unité de ligne invalide.' });
    }
    if (
      !Number.isSafeInteger(line.unitPriceHT) ||
      line.unitPriceHT < 0 ||
      line.unitPriceHT > MAX_BILLING_AMOUNT_CENTS
    ) {
      return appDomain({ code: 'VALIDATION', field: 'unitPriceHT', message: 'Prix HT invalide.' });
    }
    if (
      !Number.isFinite(line.qty) ||
      line.qty <= 0 ||
      Math.round(line.qty * 1_000) !== line.qty * 1_000
    ) {
      return appDomain({ code: 'VALIDATION', field: 'qty', message: 'Quantité invalide.' });
    }
    // B3 — remise de ligne : structure + plafond contre la base HT de SA ligne ;
    // B9 — refusée sur un débours (art. 267, II-2° CGI) dès la frontière.
    if (line.discount !== undefined) {
      const discount = validateLineDiscount(
        line.discount,
        Math.round(line.qty * line.unitPriceHT),
        line.category,
      );
      if (!discount.ok) return appDomain(discount.error);
    }
    totalHtCents += Math.round(line.qty * line.unitPriceHT);
    if (!Number.isSafeInteger(totalHtCents) || totalHtCents > MAX_BILLING_AMOUNT_CENTS) {
      return appDomain({
        code: 'VALIDATION',
        field: 'lines',
        message: 'Montant total HT hors limite.',
      });
    }
  }
  return null;
}
