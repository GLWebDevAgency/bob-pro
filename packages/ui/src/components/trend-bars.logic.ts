/**
 * TrendBars — logique PURE (Lot 5, plan DA 01/08 : « la seule dataviz de l'app mérite
 * d'entrer au kit avec le fail-closed par construction »).
 *
 * DOCTRINE :
 * · la largeur d'une barre est un POURCENTAGE déjà dérivé par l'écran depuis les dérivations
 *   serveur/core (deriveBusinessReview & co) — le kit ne calcule AUCUN agrégat métier ;
 * · l'animation 0→n% (400 ms ease-out) ne joue que si la préférence reduce-motion est
 *   RÉSOLUE à 'inactive'. `unknown` = statique dès la première frame (doctrine tab bar v2),
 *   `active` = statique. L'état FINAL est identique au pixel dans les trois états.
 */
import type { PreferenceState } from './bob-tab-bar.logic';

/** 400 ms ease-out — la signature « barres qui poussent » des meilleures fintechs. */
export const TREND_BARS_ANIMATION_MS = 400;
/** Géométrie par défaut — celle des barres mensuelles de pilotage (série facturé/encaissé). */
export const TREND_BAR_DEFAULT_HEIGHT = 7;
export const TREND_BAR_DEFAULT_RADIUS = 4;
export const TREND_BARS_DEFAULT_GAP = 3;

export interface TrendBarsMotion {
  /** true UNIQUEMENT si la préférence est résolue à 'inactive' — fail-closed par construction. */
  readonly animated: boolean;
  /** 400 quand animé, 0 sinon (aucun timer fantôme en mode statique). */
  readonly durationMs: number;
}

/**
 * Résout le droit d'animer depuis la préférence tri-état. `unknown` N'EST PAS un « probablement
 * pas réduit » : c'est l'ignorance, et l'ignorance ferme l'animation (fail-closed).
 */
export function resolveTrendBarsMotion(preference: PreferenceState): TrendBarsMotion {
  const animated = preference === 'inactive';
  return { animated, durationMs: animated ? TREND_BARS_ANIMATION_MS : 0 };
}

/**
 * RATCHET FIGÉ AU MONTAGE (verdict Lot 5, P1) — le droit d'animer se décide UNE fois, à la
 * première frame, et ne peut ensuite qu'être RETIRÉ, jamais rendu :
 * · `granted === null` (première frame) → la décision est celle de la préférence courante ;
 * · une frame statique (ignorance ou réduction) est DÉFINITIVE pour ce montage — une
 *   résolution tardive à 'inactive' ne rejoue jamais la poussée : la largeur vraie déjà
 *   peinte ne retombe JAMAIS à 0 (sonde du verdict : FRAME1 42 % → FRAME2 0) ;
 * · une bascule 'active' en vol coupe l'animation, et la coupure est définitive — pas de
 *   ré-armement qui repeindrait une valeur intermédiaire périmée.
 * Même arbitrage que la garde `started` de FadeIn (FAIL-CLOSED MOTION, Lot 0) — coût
 * assumé : un montage ouvert sous ignorance reste statique, l'information est là au pixel.
 */
export function ratchetTrendBarsMotion(
  granted: boolean | null,
  preference: PreferenceState,
): boolean {
  const live = resolveTrendBarsMotion(preference).animated;
  if (granted === null) return live;
  return granted && live;
}

/**
 * Borne une part en % sur [0, 100] — jamais une barre négative, jamais un dépassement de
 * piste, et un NaN/Infinity (division par un max nul en amont) devient 0 : la dataviz
 * honnête ne dessine rien plutôt qu'un mensonge.
 */
export function clampTrendBarPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}
