export type PlanTier = 'free' | 'solo' | 'pro' | 'business';

export type Feature =
  | 'ai_quota' // Bob en quota découverte (palier gratuit)
  | 'ai_assistant' // Bob agentique disponible
  | 'voice_live' // BOB LIVE : conversation vocale temps réel (WebRTC) — coût audio réel par session
  | 'bob_essentials' // Bob réactif : aide, recherche, brouillons, diagnostics
  | 'bob_operations' // Bob proactif : relances, trésorerie, paiements, routines
  | 'bob_control' // Bob gouverné : équipe, supervision, audit avancé
  | 'einvoice_emission' // émission de factures électroniques (2027)
  | 'ocr' // OCR des dépenses fournisseurs
  | 'accounting_foundation' // socle invisible : plan comptable + écritures vérifiables simples
  | 'accounting_operations' // pré-compta opérationnelle : TVA, rapprochement, clôture, export cabinet
  | 'accounting_control' // contrôle comptable : personnalisation, rôles, audit exportable
  | 'cashflow_forecast' // trésorerie prévisionnelle
  | 'auto_dunning' // relances automatiques rédigées par l'IA
  | 'online_payment' // paiement en ligne des factures par les clients
  | 'invoice_advance' // add-on partenaire : avance sur facture
  | 'team' // membres d'équipe / rôles
  | 'priority_support'
  | 'insurance'; // add-on partenaire : assurance décennale / RC Pro

export type AiCapabilityTier = 'discovery' | 'essentials' | 'operations' | 'control';

export type AutonomyEntitlement = 'confirm_all' | 'confirm_outbound' | 'auto';

export interface AiEntitlement {
  capability: AiCapabilityTier;
  defaultAutonomy: AutonomyEntitlement;
  monthlyActions: number | null; // null = fair use contrôlé par abus/coût, pas par UX
}

export interface PlanLimits {
  documentStorageGb: number;
  includedCompanies: number;
  includedTeamSeats: number;
}

export interface Plan {
  tier: PlanTier;
  label: string;
  priceCents: number; // mensuel
  annualMonthlyCents: number; // équivalent mensuel facturé à l'année (~ -20 %)
  tagline: string;
  features: readonly Feature[];
  ai: AiEntitlement;
  limits: PlanLimits;
}

/**
 * Modèle « conformité gratuite, intelligence graduée » (cf. docs/strategy/2026-bob-jarvis-roadmap.md).
 * Différenciation par VALEUR/VOLUME/IA — jamais par appareil (web + mobile à tous les paliers).
 * Solo = Bob réactif ; Pro = Bob opérationnel ; Business = Bob gouverné pour équipe.
 * Prix mensuels (CONSTANTE PRODUIT, contrat C26 v2) : Solo 19 € / Pro 39 € / Business 79 €.
 */
export const PLAN_CATALOG: Record<PlanTier, Plan> = {
  free: {
    tier: 'free',
    label: 'Découverte',
    priceCents: 0,
    annualMonthlyCents: 0,
    tagline: 'Conforme 2026, gratuitement',
    features: ['ai_quota'],
    ai: { capability: 'discovery', defaultAutonomy: 'confirm_all', monthlyActions: 25 },
    limits: { documentStorageGb: 0.5, includedCompanies: 1, includedTeamSeats: 1 },
  },
  solo: {
    tier: 'solo',
    label: 'Solo',
    priceCents: 1900,
    annualMonthlyCents: 1500,
    tagline: 'Bob Essentials pour indépendant',
    features: ['einvoice_emission', 'ocr', 'accounting_foundation', 'ai_assistant', 'bob_essentials'],
    ai: { capability: 'essentials', defaultAutonomy: 'confirm_all', monthlyActions: 300 },
    limits: { documentStorageGb: 5, includedCompanies: 1, includedTeamSeats: 1 },
  },
  pro: {
    tier: 'pro',
    label: 'Pro',
    priceCents: 3900,
    annualMonthlyCents: 3100,
    tagline: 'Bob Operations pilote le quotidien',
    features: [
      'einvoice_emission',
      'ocr',
      'accounting_foundation',
      'accounting_operations',
      'ai_assistant',
      'bob_essentials',
      'bob_operations',
      'voice_live',
      'auto_dunning',
      'cashflow_forecast',
      'online_payment',
    ],
    ai: { capability: 'operations', defaultAutonomy: 'confirm_all', monthlyActions: 1500 },
    limits: { documentStorageGb: 20, includedCompanies: 1, includedTeamSeats: 1 },
  },
  business: {
    tier: 'business',
    label: 'Business',
    priceCents: 7900,
    annualMonthlyCents: 6300,
    tagline: 'Bob Control pour piloter en équipe',
    features: [
      'einvoice_emission',
      'ocr',
      'accounting_foundation',
      'accounting_operations',
      'accounting_control',
      'ai_assistant',
      'bob_essentials',
      'bob_operations',
      'bob_control',
      'voice_live',
      'auto_dunning',
      'cashflow_forecast',
      'online_payment',
      'team',
      'priority_support',
    ],
    ai: { capability: 'control', defaultAutonomy: 'confirm_all', monthlyActions: null },
    limits: { documentStorageGb: 100, includedCompanies: 3, includedTeamSeats: 5 },
  },
};

export function planEntitlements(tier: PlanTier): ReadonlySet<Feature> {
  return new Set(PLAN_CATALOG[tier].features);
}

export function planCan(tier: PlanTier, feature: Feature): boolean {
  return PLAN_CATALOG[tier].features.includes(feature);
}

/**
 * Relation de SUPERSESSION : une capacité d'un palier inférieur remplacée par une capacité
 * SUPÉRIEURE aux paliers payants (le catalogue n'est pas strictement cumulatif). Sert aux
 * surfaces de monétisation : un diff honnête n'affiche jamais la perte d'une capacité
 * remplacée par mieux, et un paywall ne « vend » jamais une capacité déjà couverte par mieux.
 */
export const FEATURE_SUPERSEDED_BY: Readonly<Partial<Record<Feature, Feature>>> = {
  ai_quota: 'ai_assistant', // le quota découverte est absorbé par Bob assistant complet
};

/** Ordre croissant des paliers — sert à savoir si un palier en couvre un autre. */
export const TIER_ORDER: readonly PlanTier[] = ['free', 'solo', 'pro', 'business'];

/** Vrai si `tier` est au moins au niveau de `min` (free < solo < pro < business). */
export function tierAtLeast(tier: PlanTier, min: PlanTier): boolean {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(min);
}

// ----------------------------------------------------------------------------
// Grille publique « Changer d'offre » (claim C26) — paliers payants uniquement.
// ----------------------------------------------------------------------------

/** Paliers payants affichés dans la grille publique (C26). */
export const PAID_TIERS = ['solo', 'pro', 'business'] as const;
export type PaidTier = (typeof PAID_TIERS)[number];

export interface PlanGridEntry {
  tier: PaidTier;
  label: string;
  /** Prix mensuel en centimes — LU dans PLAN_CATALOG (source unique, jamais dupliqué). */
  monthlyCents: number;
  /** Descriptif court de la grille — dérivé des `features` réelles du palier, rien d'inventé. */
  blurb: string;
}

/**
 * Grille tarifaire publique (CONSTANTE PRODUIT, contrat C26 v2 : Solo 19 / Pro 39 / Business 79).
 * Les prix sont LUS dans PLAN_CATALOG — une seule source de vérité. Les descriptifs reflètent
 * les `features` effectives du palier (pas les promesses du proto : « plusieurs banques » ou
 * « relances » en Solo n'existent pas dans le catalogue → absents ici).
 */
export const PLAN_PRICING: Readonly<Record<PaidTier, PlanGridEntry>> = {
  solo: {
    tier: 'solo',
    label: PLAN_CATALOG.solo.label,
    monthlyCents: PLAN_CATALOG.solo.priceCents,
    blurb: 'Devis & factures illimités · Scan des dépenses (OCR) · Facturation électronique',
  },
  pro: {
    tier: 'pro',
    label: PLAN_CATALOG.pro.label,
    monthlyCents: PLAN_CATALOG.pro.priceCents,
    blurb: 'Tout Solo + Paiement en ligne · Relances automatiques · Trésorerie prévisionnelle',
  },
  business: {
    tier: 'business',
    label: PLAN_CATALOG.business.label,
    monthlyCents: PLAN_CATALOG.business.priceCents,
    blurb: 'Tout Pro + Équipe & rôles · Contrôle comptable avancé · Support prioritaire',
  },
};

/** Add-ons orthogonaux aux paliers : vertical, partenaire ou accélération contrôlée. */
export type AddOn =
  | 'vertical_btp'
  | 'insurance'
  | 'invoice_advance'
  | 'autonomy_confirm_outbound'
  | 'autonomy_auto';

export type AddOnKind = 'vertical' | 'partner' | 'autonomy';

export interface AddOnPlan {
  addOn: AddOn;
  kind: AddOnKind;
  label: string;
  priceCents: number; // mensuel, en supplément
  tagline: string;
  minTier: PlanTier;
  grants: readonly Feature[];
  autonomy?: AutonomyEntitlement;
}

export const ADDON_CATALOG: Record<AddOn, AddOnPlan> = {
  vertical_btp: {
    addOn: 'vertical_btp',
    kind: 'vertical',
    label: 'Pack Chantier BTP',
    priceCents: 1000,
    minTier: 'free',
    tagline: 'Chantiers, situations de travaux, retenue de garantie',
    grants: [],
  },
  insurance: {
    addOn: 'insurance',
    kind: 'partner',
    label: 'Assurance pro',
    priceCents: 0,
    minTier: 'solo',
    tagline: 'RC Pro ou décennale via partenaire, sans lier le coeur Business',
    grants: ['insurance'],
  },
  invoice_advance: {
    addOn: 'invoice_advance',
    kind: 'partner',
    label: 'Avance sur facture',
    priceCents: 0,
    minTier: 'pro',
    tagline: 'Financement partenaire sur facture éligible',
    grants: ['invoice_advance'],
  },
  autonomy_confirm_outbound: {
    addOn: 'autonomy_confirm_outbound',
    kind: 'autonomy',
    label: 'Autonomie contrôlée',
    priceCents: 200,
    minTier: 'solo',
    tagline: 'Bob exécute les actions internes, confirmation avant sortie client',
    grants: [],
    autonomy: 'confirm_outbound',
  },
  autonomy_auto: {
    addOn: 'autonomy_auto',
    kind: 'autonomy',
    label: 'Autonomie avancée',
    priceCents: 500,
    minTier: 'solo',
    tagline: 'Bob agit plus vite, avec garde-fous de conformité et journalisation',
    grants: [],
    autonomy: 'auto',
  },
};

export function addOnAvailableForTier(tier: PlanTier, addOn: AddOn): boolean {
  return tierAtLeast(tier, ADDON_CATALOG[addOn].minTier);
}

export function addOnCan(addOn: AddOn, feature: Feature): boolean {
  return ADDON_CATALOG[addOn].grants.includes(feature);
}

export function planCanWithAddOns(tier: PlanTier, addOns: readonly AddOn[], feature: Feature): boolean {
  return planCan(tier, feature) || addOns.some((addOn) => addOnAvailableForTier(tier, addOn) && addOnCan(addOn, feature));
}

export const AUTONOMY_ORDER: readonly AutonomyEntitlement[] = ['confirm_all', 'confirm_outbound', 'auto'];

export function resolveAutonomyEntitlement(tier: PlanTier, addOns: readonly AddOn[] = []): AutonomyEntitlement {
  const base = PLAN_CATALOG[tier].ai.defaultAutonomy;
  return addOns.reduce<AutonomyEntitlement>((current, addOn) => {
    if (!addOnAvailableForTier(tier, addOn)) return current;
    const next = ADDON_CATALOG[addOn].autonomy;
    if (!next) return current;
    return AUTONOMY_ORDER.indexOf(next) > AUTONOMY_ORDER.indexOf(current) ? next : current;
  }, base);
}
