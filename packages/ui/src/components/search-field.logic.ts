/**
 * SearchField — logique PURE (Lot 0, plan DA 01/08). Champ de recherche du kit
 * (clients, equipements/[chantierId], recherche — migrés dans LEURS lots) : surface +
 * ombre e1 + loupe + bouton CLEAR à cible 44 pt (l'ajout du lot — aucun des trois écrans
 * n'offrait d'effacement au doigt).
 */

/** Géométrie figée (littéraux du SearchField local de clients.tsx, la référence). */
export const SEARCH_FIELD_GAP = 9;
export const SEARCH_FIELD_PADDING_VERTICAL = 11;
export const SEARCH_FIELD_PADDING_HORIZONTAL = 14;

/** Bouton clear : visuel 28, cible EFFECTIVE 44 par hitSlop (patron Chip du kit). */
export const SEARCH_CLEAR_VISUAL = 28;
export const SEARCH_CLEAR_TARGET = 44;
export const SEARCH_CLEAR_HIT_SLOP = Math.ceil((SEARCH_CLEAR_TARGET - SEARCH_CLEAR_VISUAL) / 2);

/** Le bouton clear n'existe que s'il y a quelque chose à effacer ET un effaceur fourni. */
export function searchClearVisible(value: string, hasOnClear: boolean): boolean {
  return hasOnClear && value.length > 0;
}
