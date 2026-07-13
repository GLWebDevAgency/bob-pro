import { type Instant } from '../../shared-kernel/time';
import { type PaywallSource } from '../engagement/analytics';

/**
 * GOUVERNANCE DE PRESSION COMMERCIALE (pilier 2) — la règle structurelle qui empêche le
 * système de monétisation de devenir du harcèlement. Verdict unanime du panel de conception :
 * sans budget de pression UNIFIÉ, chaque mécanisme honnête isolément sature le canal ensemble.
 *
 * Règles codées (jamais laissées à la discrétion d'un écran) :
 * · un paywall IGNORÉ deux fois sur la même source → sourdine 14 jours sur CETTE source ;
 * · un refus VOCAL (« non ») → silence 30 jours sur le sujet, tous canaux — dire non à Bob
 *   doit coûter UNE syllabe et être respecté plus fort qu'un tap ;
 * · une seule proposition d'upsell PROACTIVE par semaine, toutes sources confondues
 *   (le paywall déclenché par le GESTE de l'utilisateur n'est pas une proactive : il répond).
 */

export const PAYWALL_MUTE_AFTER_DISMISSALS = 2;
export const PAYWALL_MUTE_DAYS = 14;
export const VOICE_REFUSAL_SILENCE_DAYS = 30;
export const PROACTIVE_UPSELL_MIN_INTERVAL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PaywallPressureHistory {
  /** Rejets consécutifs (sans conversion) sur cette source. */
  readonly dismissalsForSource: number;
  readonly lastDismissedAt: Instant | null;
  /** Dernier refus VOCAL explicite sur ce sujet — le plus fort des signaux. */
  readonly lastVoiceRefusalAt: Instant | null;
  /** Dernière proposition PROACTIVE (toutes sources) — null si jamais. */
  readonly lastProactiveUpsellAt: Instant | null;
}

export type PaywallPressureDecision =
  | { readonly kind: 'show' }
  | { readonly kind: 'muted'; readonly reason: 'dismissed_twice' | 'voice_refusal' | 'weekly_budget' };

/** Le paywall RÉACTIF (l'utilisateur a touché la capacité) — seule la sourdine s'applique. */
export function decideReactivePaywallPressure(
  history: PaywallPressureHistory,
  now: Instant,
): PaywallPressureDecision {
  const nowMs = Date.parse(now);
  if (history.lastVoiceRefusalAt !== null) {
    const since = (nowMs - Date.parse(history.lastVoiceRefusalAt)) / DAY_MS;
    if (since < VOICE_REFUSAL_SILENCE_DAYS) return { kind: 'muted', reason: 'voice_refusal' };
  }
  if (history.dismissalsForSource >= PAYWALL_MUTE_AFTER_DISMISSALS && history.lastDismissedAt !== null) {
    const since = (nowMs - Date.parse(history.lastDismissedAt)) / DAY_MS;
    if (since < PAYWALL_MUTE_DAYS) return { kind: 'muted', reason: 'dismissed_twice' };
  }
  return { kind: 'show' };
}

/** L'upsell PROACTIF (Bob prend l'initiative) — sourdine + budget hebdomadaire global. */
export function decideProactiveUpsellPressure(
  history: PaywallPressureHistory,
  now: Instant,
): PaywallPressureDecision {
  const reactive = decideReactivePaywallPressure(history, now);
  if (reactive.kind === 'muted') return reactive;
  if (history.lastProactiveUpsellAt !== null) {
    const since = (Date.parse(now) - Date.parse(history.lastProactiveUpsellAt)) / DAY_MS;
    if (since < PROACTIVE_UPSELL_MIN_INTERVAL_DAYS) return { kind: 'muted', reason: 'weekly_budget' };
  }
  return { kind: 'show' };
}

/** Ré-export pour les hôtes : la source fait partie du contrat de pression. */
export type { PaywallSource };
