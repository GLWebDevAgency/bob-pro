/**
 * MoneyRow — logique pure (§10, grand-livre « le solde ment »).
 * Mapping signe/variante → tokens patterns.moneyRow. Aucun import react-native.
 */
import { formatEUR } from '@bob/core';
import { patterns } from '@bob/tokens';

export type MoneyRowVariant = 'default' | 'lead' | 'total';

/**
 * Teinte du montant : > 0 → positive (success), < 0 → negative (dangerVivid).
 * Le total (et le zéro) restent navy (patterns.moneyRow.total).
 */
export function moneyRowAmountColor(amountCents: number, variant: MoneyRowVariant = 'default'): string {
  if (variant === 'total') return patterns.moneyRow.total;
  if (amountCents > 0) return patterns.moneyRow.positive;
  if (amountCents < 0) return patterns.moneyRow.negative;
  return patterns.moneyRow.total;
}

/**
 * Texte du montant : « + » explicite sur les entrées (hors total) ;
 * formatEUR porte déjà le signe négatif.
 */
export function moneyRowAmountText(amountCents: number, variant: MoneyRowVariant = 'default'): string {
  const text = formatEUR(amountCents);
  return variant !== 'total' && amountCents > 0 ? `+${text}` : text;
}
