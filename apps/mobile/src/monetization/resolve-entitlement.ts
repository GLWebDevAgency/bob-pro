import {
  decidePaywall,
  type AddOn,
  type Feature,
  type PaywallDecision,
  type PlanTier,
  type SubscriptionStatus,
} from '@bob/core';

export interface EntitlementState {
  readonly allowed: boolean;
  readonly decision: PaywallDecision | null;
  readonly loading: boolean;
  readonly verified: boolean;
}

interface SubscriptionAuthorityView {
  readonly tier: string;
  readonly status: string;
  readonly features: readonly string[];
  readonly addOns?: readonly string[];
}

/**
 * Résout une capacité uniquement depuis une réponse d'abonnement vérifiée. Une panne ou une
 * absence de payload ferme l'accès sans fabriquer de palier et sans afficher un upsell trompeur.
 */
export function resolveEntitlement(input: {
  feature: Feature;
  view: SubscriptionAuthorityView | undefined;
  loading: boolean;
  failed: boolean;
}): EntitlementState {
  // Une photographie en cache reste réelle, mais une erreur de rafraîchissement ne prouve plus
  // que le droit est encore actif (révocation, impayé, changement de plan). Les capacités et
  // mutations restent donc fermées jusqu'à une nouvelle réponse serveur réussie.
  if (input.failed) {
    return { allowed: false, decision: null, loading: false, verified: false };
  }
  if (input.view === undefined) {
    return {
      allowed: false,
      decision: null,
      loading: input.loading && !input.failed,
      verified: false,
    };
  }

  const tier = input.view.tier as PlanTier;
  const status = input.view.status as SubscriptionStatus;
  const addOns = (input.view.addOns ?? []) as AddOn[];
  if (input.view.features.includes(input.feature)) {
    return { allowed: true, decision: null, loading: false, verified: true };
  }
  const decision = decidePaywall({ feature: input.feature, tier, addOns, status });
  return { allowed: decision.kind === 'allowed', decision, loading: false, verified: true };
}
