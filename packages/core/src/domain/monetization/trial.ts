import { type Instant } from '../../shared-kernel/time';
import { TIER_ORDER, type PlanTier } from '../subscription/plan';

/**
 * REVERSE TRIAL (pilier 2) — le nouveau compte démarre avec le palier Pro COMPLET pendant
 * une fenêtre courte, puis redescend en douceur vers son palier payé (free au départ).
 *
 * Pourquoi ce pattern (et pas un freemium nu ni un trial à carte bancaire) :
 * · l'artisan juge sur PREUVE : il doit vivre les relances auto, le vocal et la trésorerie
 *   AVANT de payer — la valeur d'abord, la carte ensuite (réciprocité, zéro piège) ;
 * · la fin d'essai est un moment de vente HONNÊTE : « voilà ce que tu perds » factuel
 *   (les capacités réellement utilisées), jamais un compte à rebours anxiogène ;
 * · aucune carte bancaire requise pour l'essai — la descente est douce, les données restent.
 *
 * Service PUR : aucune horloge interne (now injecté), Instant ISO 8601 comparés en epoch ms.
 */

export const REVERSE_TRIAL_DAYS = 14;
/** Fenêtre « fin proche » : assez tôt pour décider sereinement, trop court pour harceler. */
export const TRIAL_ENDING_SOON_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReverseTrialState {
  /** Palier prêté pendant l'essai (Pro par défaut : le palier « le plus choisi »). */
  readonly tier: PlanTier;
  readonly startedAt: Instant;
  readonly endsAt: Instant;
}

export type TrialPhase = 'active' | 'ending_soon' | 'expired';

export function startReverseTrial(
  now: Instant,
  tier: PlanTier = 'pro',
  days: number = REVERSE_TRIAL_DAYS,
): ReverseTrialState {
  const startMs = Date.parse(now);
  return {
    tier,
    startedAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + Math.max(1, days) * DAY_MS).toISOString(),
  };
}

/** Jours restants ENTIERS arrondis au supérieur (l'utilisateur ne perd jamais « son » jour). */
export function trialDaysLeft(trial: ReverseTrialState, now: Instant): number {
  const left = Date.parse(trial.endsAt) - Date.parse(now);
  return Math.max(0, Math.ceil(left / DAY_MS));
}

export function trialPhase(trial: ReverseTrialState, now: Instant): TrialPhase {
  const daysLeft = trialDaysLeft(trial, now);
  if (daysLeft === 0) return 'expired';
  return daysLeft <= TRIAL_ENDING_SOON_DAYS ? 'ending_soon' : 'active';
}

/** Palier EFFECTIF : le meilleur des deux mondes pendant l'essai, le palier payé après.
 *  Un essai n'ABAISSE jamais un palier payé supérieur (business reste business). */
export function trialEffectiveTier(paidTier: PlanTier, trial: ReverseTrialState | null, now: Instant): PlanTier {
  if (trial === null || trialPhase(trial, now) === 'expired') return paidTier;
  return TIER_ORDER.indexOf(trial.tier) > TIER_ORDER.indexOf(paidTier) ? trial.tier : paidTier;
}
