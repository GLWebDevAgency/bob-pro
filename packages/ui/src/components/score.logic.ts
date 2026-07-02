/**
 * Score — logique pure (§13). Aucun import react-native.
 * Les tranches renvoient une clé sémantique (danger / warning / success)
 * que le composant résout via useTheme().semantic.
 */
export type ScoreBand = 'danger' | 'warning' | 'success';

/** Borne le score dans [0, 100] (NaN → 0). */
export function clampScore(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

/** Tranche de couleur : < 50 danger · 50–75 warning · > 75 success. */
export function scoreBand(score: number): ScoreBand {
  const s = clampScore(score);
  if (s < 50) return 'danger';
  if (s <= 75) return 'warning';
  return 'success';
}

/** Largeur de remplissage de la ScoreBar, en % (= score borné). */
export function scoreFillPercent(score: number): number {
  return clampScore(score);
}
