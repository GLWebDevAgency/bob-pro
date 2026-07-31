import { type VatRate } from './vat-rate';
import { type Discount } from './discount';

export type LineCategory = 'labor' | 'supply' | 'travel' | 'disbursement' | 'subscription';

/**
 * Plafond technique commun des montants HT saisis dans une pièce commerciale.
 *
 * La valeur est partagée par les lignes de devis, leur total et le catalogue afin qu'une
 * prestation enregistrée soit toujours réutilisable dans un devis sans changer de domaine.
 */
export const MAX_BILLING_AMOUNT_CENTS = 1_500_000_000;

/**
 * Montant HT brut canonique d'une ligne, avec la même politique d'arrondi que Quote, Invoice,
 * Factur-X et les rendus. `null` signifie que l'entrée ne respecte pas les bornes facturables.
 */
export function calculateBillingLineTotalCents(input: {
  readonly qty: number;
  readonly unitPriceHT: number;
}): number | null {
  if (
    !Number.isFinite(input.qty)
    || input.qty <= 0
    || Math.round(input.qty * 1_000) !== input.qty * 1_000
    || !Number.isSafeInteger(input.unitPriceHT)
    || Object.is(input.unitPriceHT, -0)
    || input.unitPriceHT < 0
    || input.unitPriceHT > MAX_BILLING_AMOUNT_CENTS
  ) {
    return null;
  }
  const total = Math.round(input.qty * input.unitPriceHT);
  return Number.isSafeInteger(total)
    && !Object.is(total, -0)
    && total >= 0
    && total <= MAX_BILLING_AMOUNT_CENTS
    ? total
    : null;
}

/** Tous les caractères de contrôle Unicode sont interdits dans un texte facturable. */
export function hasBillingControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

export interface LineInput {
  label: string;
  category: LineCategory;
  qty: number;
  unit?: string;
  unitPriceHT: number; // centimes
  vatRate: VatRate;
  /**
   * B3 — remise DE LIGNE (% ou montant HT en centimes), optionnelle et additive : les pièces
   * antérieures restent lisibles sans elle. La remise s'impute sur la base HT de la ligne
   * (qty × unitPriceHT arrondi) AVANT le calcul de la TVA (assiette par taux après remises).
   */
  discount?: Discount;
}
