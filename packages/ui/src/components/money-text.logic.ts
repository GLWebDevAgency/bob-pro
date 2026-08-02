/**
 * MoneyText — logique pure de mapping variante → clé de l'échelle typographique.
 * hero = 42/800 (heroNum) · moneyHero = 27/800 (héros d'écran, cran Lot 0 — arbitrage
 * TYPO : « héros money ~27/800 via variant MoneyText ») · big = 21/800 (bigNum) ·
 * body = 14.5/500 (body).
 */

export type MoneyVariant = 'hero' | 'moneyHero' | 'big' | 'body';

export type MoneyTypeKey = 'heroNum' | 'moneyHero' | 'bigNum' | 'body';

/** Mappe la variante de montant → clé de `type` (@bob/tokens). Pure, testable sans RN. */
export function moneyTypeKey(variant: MoneyVariant): MoneyTypeKey {
  switch (variant) {
    case 'hero':
      return 'heroNum';
    case 'moneyHero':
      return 'moneyHero';
    case 'big':
      return 'bigNum';
    case 'body':
      return 'body';
  }
}
