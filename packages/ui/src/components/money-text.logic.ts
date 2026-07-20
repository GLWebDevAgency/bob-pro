/**
 * MoneyText — logique pure de mapping variante → clé de l'échelle typographique.
 * hero = 42/800 (heroNum) · big = 21/800 (bigNum) · body = 14.5/500 (body).
 */

export type MoneyVariant = 'hero' | 'big' | 'body';

export type MoneyTypeKey = 'heroNum' | 'bigNum' | 'body';

/** Mappe la variante de montant → clé de `type` (@bob/tokens). Pure, testable sans RN. */
export function moneyTypeKey(variant: MoneyVariant): MoneyTypeKey {
  switch (variant) {
    case 'hero':
      return 'heroNum';
    case 'big':
      return 'bigNum';
    case 'body':
      return 'body';
  }
}
