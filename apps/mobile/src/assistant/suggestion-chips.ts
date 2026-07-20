/**
 * DÉCOUVRABILITÉ (S9) — chips de suggestion de l'Assistant : un POOL de commandes CANONIQUES
 * supportées (chaque libellé i18n ×3 tons matche un intent @bob/ai à coup sûr — jamais une
 * commande inventée), servi par ROTATION à chaque visite de l'onglet. Logique pure, testée :
 * l'écran ne fait que consommer `rotateSuggestionChips(pool, visite)`.
 */
import type { I18nKey } from '@bob/i18n';

/** Pool canonique — l'ordre alterne les domaines (facturation / pilotage / fiscal / dépenses)
 * pour que chaque fenêtre de rotation montre un éventail, pas quatre variantes du même sujet. */
export const SUGGESTION_CHIP_POOL: readonly I18nKey[] = [
  'assistant.chipRelance', // relance
  'assistant.chipPayout', // payout
  'assistant.chipMonth', // cloture
  'assistant.chipDiag', // diagnostic
  'assistant.chipVat', // tva
  'assistant.chipBalance', // balance âgée
  'assistant.chipPilotage', // pilotage
  'assistant.chipNewQuote', // nouveau_devis
  'assistant.chipScan', // scan
  'assistant.chipEcheances', // échéances fiscales
  'assistant.chipHelp', // aide — le catalogue des capacités
];

/** Largeur de la rangée (proto §isAssistant) : 4 chips visibles, le reste au tour suivant. */
export const SUGGESTION_CHIPS_PER_VISIT = 4;

/**
 * Fenêtre déterministe de `count` chips pour la visite n° `visit` (0, 1, 2, …) : la fenêtre
 * AVANCE de `count` à chaque visite (wrap circulaire) — tout le pool finit par être montré,
 * sans doublon dans une même fenêtre, et une même visite rend toujours la même rangée.
 */
export function rotateSuggestionChips<T>(
  pool: readonly T[],
  visit: number,
  count: number = SUGGESTION_CHIPS_PER_VISIT,
): readonly T[] {
  if (pool.length === 0 || count <= 0) return [];
  const size = Math.min(count, pool.length);
  const safeVisit = Number.isFinite(visit) ? Math.max(0, Math.trunc(visit)) : 0;
  const start = (safeVisit * size) % pool.length;
  return Array.from({ length: size }, (_, i) => pool[(start + i) % pool.length]!);
}
