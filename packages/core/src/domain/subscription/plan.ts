export type PlanTier = 'solo' | 'pro' | 'business';

export type Feature =
  | 'ai_assistant' // Bob (toutes offres)
  | 'online_payment' // paiement en ligne des factures par les clients
  | 'invoice_advance' // avance sur facture
  | 'team' // membres d'équipe
  | 'priority_support'
  | 'insurance'; // assurance décennale / RC Pro partenaire

export interface Plan {
  tier: PlanTier;
  label: string;
  priceCents: number; // par mois
  features: readonly Feature[];
}

/** Offres du proto : Solo 19 € / Pro 39 € / Business 79 €. */
export const PLAN_CATALOG: Record<PlanTier, Plan> = {
  solo: { tier: 'solo', label: 'Solo', priceCents: 1900, features: ['ai_assistant'] },
  pro: {
    tier: 'pro',
    label: 'Pro',
    priceCents: 3900,
    features: ['ai_assistant', 'online_payment', 'invoice_advance'],
  },
  business: {
    tier: 'business',
    label: 'Business',
    priceCents: 7900,
    features: ['ai_assistant', 'online_payment', 'invoice_advance', 'team', 'priority_support', 'insurance'],
  },
};

export function planEntitlements(tier: PlanTier): ReadonlySet<Feature> {
  return new Set(PLAN_CATALOG[tier].features);
}

export function planCan(tier: PlanTier, feature: Feature): boolean {
  return PLAN_CATALOG[tier].features.includes(feature);
}
