import { PLAN_CATALOG, planCan, type Feature, type PlanTier } from '../subscription/plan';

/**
 * DIFF DE CHANGEMENT D'OFFRE (pilier 2) — « ce que tu gagnes / ce que tu perds », calculé
 * depuis PLAN_CATALOG (source unique C26 v2), jamais rédigé à la main. La transparence
 * radicale du changement de plan : l'artisan voit les conséquences AVANT de confirmer,
 * dans les deux sens (upgrade ET downgrade) — le downgrade honnête est un argument de
 * confiance, pas un risque.
 */

export interface PlanChangeDiff {
  readonly from: PlanTier;
  readonly to: PlanTier;
  /** Capacités OUVERTES par le changement (ordre du catalogue cible). */
  readonly gained: readonly Feature[];
  /** Capacités PERDUES — affichées avec le même poids que les gains, jamais en petit. */
  readonly lost: readonly Feature[];
  /** Delta mensuel en centimes (négatif = économie) — le chiffre de l'ancrage honnête. */
  readonly monthlyDeltaCents: number;
  /** Variation des quotas d'actions IA (null = illimité fair-use). */
  readonly aiActionsFrom: number | null;
  readonly aiActionsTo: number | null;
}

export function diffPlanChange(from: PlanTier, to: PlanTier): PlanChangeDiff {
  const gained = PLAN_CATALOG[to].features.filter((feature) => !planCan(from, feature));
  const lost = PLAN_CATALOG[from].features.filter((feature) => !planCan(to, feature));
  return {
    from,
    to,
    gained,
    lost,
    monthlyDeltaCents: PLAN_CATALOG[to].priceCents - PLAN_CATALOG[from].priceCents,
    aiActionsFrom: PLAN_CATALOG[from].ai.monthlyActions,
    aiActionsTo: PLAN_CATALOG[to].ai.monthlyActions,
  };
}
