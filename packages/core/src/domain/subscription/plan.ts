export type PlanTier = 'free' | 'solo' | 'pro' | 'business';

export type Feature =
  | 'ai_quota' // Bob en quota découverte (palier gratuit)
  | 'ai_assistant' // Bob l'IA illimité (fair use)
  | 'einvoice_emission' // émission de factures électroniques (2027)
  | 'ocr' // OCR des dépenses fournisseurs
  | 'cashflow_forecast' // trésorerie prévisionnelle
  | 'auto_dunning' // relances automatiques rédigées par l'IA
  | 'online_payment' // paiement en ligne des factures par les clients
  | 'invoice_advance' // avance sur facture
  | 'team' // membres d'équipe / rôles
  | 'priority_support'
  | 'insurance'; // assurance décennale / RC Pro partenaire

export interface Plan {
  tier: PlanTier;
  label: string;
  priceCents: number; // mensuel
  annualMonthlyCents: number; // équivalent mensuel facturé à l'année (~ -20 %)
  tagline: string;
  features: readonly Feature[];
}

/**
 * Modèle « conformité gratuite, intelligence payante » (cf. docs/strategy/2026-pricing-strategy.md).
 * Différenciation par VALEUR/VOLUME/IA — jamais par appareil (web + mobile à tous les paliers).
 * Réception e-facture 2026 = socle gratuit (commodité) ; Bob l'IA = aimant premium (Pro+).
 */
export const PLAN_CATALOG: Record<PlanTier, Plan> = {
  free: {
    tier: 'free',
    label: 'Découverte',
    priceCents: 0,
    annualMonthlyCents: 0,
    tagline: 'Conforme 2026, gratuitement',
    features: ['ai_quota'],
  },
  solo: {
    tier: 'solo',
    label: 'Solo',
    priceCents: 1400,
    annualMonthlyCents: 1200,
    tagline: 'Facture sans limite',
    features: ['einvoice_emission', 'ocr'],
  },
  pro: {
    tier: 'pro',
    label: 'Pro',
    priceCents: 3900,
    annualMonthlyCents: 3100,
    tagline: 'Bob pilote ta paperasse',
    features: ['einvoice_emission', 'ocr', 'ai_assistant', 'auto_dunning', 'cashflow_forecast'],
  },
  business: {
    tier: 'business',
    label: 'Business',
    priceCents: 6900,
    annualMonthlyCents: 5500,
    tagline: 'Pour les équipes',
    features: [
      'einvoice_emission',
      'ocr',
      'ai_assistant',
      'auto_dunning',
      'cashflow_forecast',
      'online_payment',
      'invoice_advance',
      'team',
      'priority_support',
      'insurance',
    ],
  },
};

export function planEntitlements(tier: PlanTier): ReadonlySet<Feature> {
  return new Set(PLAN_CATALOG[tier].features);
}

export function planCan(tier: PlanTier, feature: Feature): boolean {
  return PLAN_CATALOG[tier].features.includes(feature);
}

/** Ordre croissant des paliers — sert à savoir si un palier en couvre un autre. */
export const TIER_ORDER: readonly PlanTier[] = ['free', 'solo', 'pro', 'business'];

/** Vrai si `tier` est au moins au niveau de `min` (free < solo < pro < business). */
export function tierAtLeast(tier: PlanTier, min: PlanTier): boolean {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(min);
}

/** Add-ons verticaux orthogonaux aux paliers (monétisation des métiers sans prix-métier). */
export type AddOn = 'vertical_btp';

export interface AddOnPlan {
  addOn: AddOn;
  label: string;
  priceCents: number; // mensuel, en supplément
  tagline: string;
}

export const ADDON_CATALOG: Record<AddOn, AddOnPlan> = {
  vertical_btp: {
    addOn: 'vertical_btp',
    label: 'Pack Chantier BTP',
    priceCents: 1000,
    tagline: 'Chantiers, situations de travaux, retenue de garantie',
  },
};
