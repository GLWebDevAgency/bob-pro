import { type CashflowProjection, type Horizon } from './project-cashflow';

/**
 * Bande de lecture d'une prévision de trésorerie (claim C11 — note à côté du montant).
 * Quatre lectures, à la voix de Bob : « Tranquille » / « Ça passe » / « Creux, surveille » /
 * « Ça repart ». Dérivation PURE depuis les projections réelles (aucun seuil caché dans l'UI).
 */
export type CashflowBand = 'tranquille' | 'passe' | 'creux' | 'repart';

export interface CashflowSeriesPoint {
  horizon: Horizon;
  projection: CashflowProjection;
}

/**
 * Règles (dans l'ordre) sur la série d'horizons du scénario courant :
 * 1. « creux »      — la dispo passe sous zéro à l'horizon regardé (projection.risk) ;
 * 2. « repart »     — un horizon plus court était en creux, celui-ci est repassé au-dessus ;
 * 3. « tranquille » — versement possible ET la réserve (TVA + marge) pèse moins de la moitié
 *                     de la dispo (payout × 2 ≥ available) : marge confortable ;
 * 4. « passe »      — dispo positive mais serrée (réserve > moitié de la dispo, ou payout nul).
 * Retourne null si l'horizon demandé n'est pas dans la série (donnée absente → pas de note).
 */
export function cashflowBand(
  series: readonly CashflowSeriesPoint[],
  selected: Horizon,
): CashflowBand | null {
  const point = series.find((p) => p.horizon === selected);
  if (point === undefined) return null;

  if (point.projection.risk) return 'creux';
  if (series.some((p) => p.horizon < selected && p.projection.risk)) return 'repart';
  if (point.projection.payout > 0 && point.projection.payout * 2 >= point.projection.available) {
    return 'tranquille';
  }
  return 'passe';
}
