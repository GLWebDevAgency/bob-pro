import {
  ADDON_CATALOG,
  PLAN_CATALOG,
  TIER_ORDER,
  addOnAvailableForTier,
  addOnCan,
  planCan,
  planCanWithAddOns,
  type AddOn,
  type Feature,
  type PlanTier,
} from '../subscription/plan';
import { type SubscriptionStatus } from '../subscription/subscription';

/**
 * PAYWALL CONTEXTUEL (pilier 2) — service domaine PUR : décide ce qui se passe quand un
 * utilisateur touche une capacité verrouillée, AU MOMENT du besoin (jamais un mur générique).
 *
 * Principes non négociables (cible artisan, confiance = rétention) :
 * · HONNÊTETÉ TARIFAIRE : on propose toujours le déblocage LE MOINS CHER légitime
 *   (add-on éligible avant montée de palier si l'add-on suffit et coûte moins) ;
 * · JAMAIS d'upsell à un impayé : status past_due → régularisation d'abord, point ;
 * · l'ancrage est le DELTA mensuel réel (« +20 €/mois »), lu dans PLAN_CATALOG
 *   (source unique, contrat C26 v2) — jamais un prix recalculé ou arrondi ici ;
 * · un essai (reverse trial) actif couvre la capacité → accès, marqué viaTrial pour que
 *   l'UI rappelle honnêtement l'échéance au lieu de laisser croire à un acquis.
 */

export interface PaywallContext {
  readonly feature: Feature;
  /** Palier RÉELLEMENT payé (jamais le palier d'essai — il arrive via trialTier). */
  readonly tier: PlanTier;
  readonly addOns: readonly AddOn[];
  readonly status: SubscriptionStatus;
  /** Palier prêté par un essai EN COURS (reverse trial) — null/absent hors essai. */
  readonly trialTier?: PlanTier | null;
}

export type PaywallDecision =
  | { readonly kind: 'allowed'; readonly viaTrial: boolean }
  /** Paiement en échec : on répare la relation AVANT de vendre quoi que ce soit. */
  | { readonly kind: 'past_due' }
  | {
      readonly kind: 'upgrade';
      readonly requiredTier: PlanTier;
      /** Prix mensuel du palier requis (centimes) — lu dans PLAN_CATALOG. */
      readonly requiredMonthlyCents: number;
      /** Équivalent mensuel facturé à l'année — l'option sereine, jamais cachée. */
      readonly requiredAnnualMonthlyCents: number;
      /** L'ancrage honnête : ce que ça coûte EN PLUS par mois depuis le palier actuel. */
      readonly monthlyDeltaCents: number;
    }
  | {
      readonly kind: 'addon';
      readonly addOn: AddOn;
      /** Prix mensuel de l'add-on — le chemin le MOINS CHER quand il suffit. */
      readonly monthlyPriceCents: number;
    }
  /** Capacité dans aucun catalogue : défense — l'UI n'affiche RIEN de vendable. */
  | { readonly kind: 'unavailable' };

/** Plus petit palier (ordre free<solo<pro<business) incluant la capacité — null si aucun. */
export function requiredTierFor(feature: Feature): PlanTier | null {
  for (const tier of TIER_ORDER) {
    if (planCan(tier, feature)) return tier;
  }
  return null;
}

/** Add-on le moins cher, ÉLIGIBLE au palier courant, qui octroie la capacité — null sinon. */
export function cheapestAddOnFor(tier: PlanTier, feature: Feature): AddOn | null {
  const candidates = (Object.keys(ADDON_CATALOG) as AddOn[])
    .filter((addOn) => addOnAvailableForTier(tier, addOn) && addOnCan(addOn, feature))
    .sort((a, b) => ADDON_CATALOG[a].priceCents - ADDON_CATALOG[b].priceCents);
  return candidates[0] ?? null;
}

export function decidePaywall(context: PaywallContext): PaywallDecision {
  const { feature, addOns, status } = context;
  // Un abonnement résilié a perdu ses droits : la décision se calcule depuis 'free' —
  // le paywall redevient une proposition de valeur complète, pas un delta trompeur.
  const paidTier: PlanTier = status === 'canceled' ? 'free' : context.tier;

  if (status === 'past_due') return { kind: 'past_due' };

  if (planCanWithAddOns(paidTier, addOns, feature)) return { kind: 'allowed', viaTrial: false };

  // L'essai prête un palier ENTIER (reverse trial) : s'il couvre, accès marqué viaTrial.
  const trialTier = context.trialTier ?? null;
  if (trialTier !== null && planCanWithAddOns(trialTier, addOns, feature)) {
    return { kind: 'allowed', viaTrial: true };
  }

  const required = requiredTierFor(feature);
  const addOn = cheapestAddOnFor(paidTier, feature);

  if (required === null && addOn === null) {
    // Capacité portée UNIQUEMENT par un add-on inéligible au palier courant (ex. avance sur
    // facture, minTier pro) : le chemin honnête est la montée vers le palier d'éligibilité —
    // jamais un silence qui laisserait croire que la capacité n'existe pas.
    const gated = (Object.keys(ADDON_CATALOG) as AddOn[])
      .filter((candidate) => addOnCan(candidate, feature))
      .sort((a, b) => ADDON_CATALOG[a].priceCents - ADDON_CATALOG[b].priceCents)[0];
    if (gated === undefined) return { kind: 'unavailable' };
    const minTier = ADDON_CATALOG[gated].minTier;
    return {
      kind: 'upgrade',
      requiredTier: minTier,
      requiredMonthlyCents: PLAN_CATALOG[minTier].priceCents,
      requiredAnnualMonthlyCents: PLAN_CATALOG[minTier].annualMonthlyCents,
      monthlyDeltaCents: Math.max(0, PLAN_CATALOG[minTier].priceCents - PLAN_CATALOG[paidTier].priceCents),
    };
  }

  const upgrade: PaywallDecision | null =
    required === null
      ? null
      : {
          kind: 'upgrade',
          requiredTier: required,
          requiredMonthlyCents: PLAN_CATALOG[required].priceCents,
          requiredAnnualMonthlyCents: PLAN_CATALOG[required].annualMonthlyCents,
          monthlyDeltaCents: Math.max(0, PLAN_CATALOG[required].priceCents - PLAN_CATALOG[paidTier].priceCents),
        };
  const viaAddOn: PaywallDecision | null =
    addOn === null ? null : { kind: 'addon', addOn, monthlyPriceCents: ADDON_CATALOG[addOn].priceCents };

  if (upgrade === null) return viaAddOn as PaywallDecision;
  if (viaAddOn === null) return upgrade;
  // Les deux existent : le moins cher gagne ; à égalité l'add-on (moindre engagement).
  return (viaAddOn as { monthlyPriceCents: number }).monthlyPriceCents <=
    (upgrade as { monthlyDeltaCents: number }).monthlyDeltaCents
    ? viaAddOn
    : upgrade;
}
