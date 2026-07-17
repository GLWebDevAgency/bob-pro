import { type VatRate } from './vat-rate';

export type LineCategory = 'labor' | 'supply' | 'travel' | 'disbursement' | 'subscription';

/**
 * Plafond technique commun des montants HT saisis dans une pièce commerciale.
 *
 * La valeur est partagée par les lignes de devis, leur total et le catalogue afin qu'une
 * prestation enregistrée soit toujours réutilisable dans un devis sans changer de domaine.
 */
export const MAX_BILLING_AMOUNT_CENTS = 1_500_000_000;

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
}
