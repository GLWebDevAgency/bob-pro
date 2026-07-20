import { requiredTierFor } from './paywall';
import { TIER_ORDER, type Feature, type PlanTier } from '../subscription/plan';
import { type ValueDigest } from '../engagement/value-ledger';

/**
 * BILAN DE FIN D'ESSAI (pilier 2) — « Ce que Bob a fait pour toi », avec une recommandation
 * CALCULÉE depuis l'usage réel, DOWNSELL INCLUS : si l'usage des 14 jours tient dans Solo,
 * Bob recommande Solo — recommander moins cher quand ça suffit est LE geste qui fait la
 * réputation sur un marché où tout le monde se parle au dépôt de matériaux.
 *
 * Règle : la recommandation est le PLUS PETIT palier couvrant les capacités RÉELLEMENT
 * utilisées pendant l'essai (pas les capacités survolées) ; l'écran présente les trois
 * issues (recommandé / autres paliers / rester en gratuit) avec le même poids visuel.
 */

export interface TrialReport {
  /** Capacités payantes réellement UTILISÉES pendant l'essai (actions abouties). */
  readonly featuresUsed: readonly Feature[];
  /** La valeur vécue de la période d'essai — null si l'essai n'a rien produit. */
  readonly digest: ValueDigest | null;
  /** Le plus petit palier couvrant l'usage réel — 'free' si rien de payant n'a servi. */
  readonly recommendedTier: PlanTier;
  /** Capacités utilisées qui seraient PERDUES en restant sur le palier recommandé inférieur
   *  au palier d'essai — vide si la recommandation couvre tout (par construction). */
  readonly usedButNotInRecommended: readonly Feature[];
}

export function buildTrialReport(input: {
  readonly featuresUsed: readonly Feature[];
  readonly digest: ValueDigest | null;
}): TrialReport {
  // Le plus petit palier couvrant TOUTES les capacités utilisées.
  let recommended: PlanTier = 'free';
  for (const feature of input.featuresUsed) {
    const required = requiredTierFor(feature);
    if (required === null) continue; // capacité portée par un add-on : ne force pas le palier
    if (TIER_ORDER.indexOf(required) > TIER_ORDER.indexOf(recommended)) recommended = required;
  }
  return {
    featuresUsed: input.featuresUsed,
    digest: input.digest,
    recommendedTier: recommended,
    usedButNotInRecommended: [], // par construction : le palier recommandé couvre l'usage
  };
}
