import { type Trade } from './company';
import { type VatRate } from '../billing/shared/vat-rate';
import { type PlanTier, type AddOn, tierAtLeast } from '../subscription/plan';

/**
 * Configuration par métier : le métier façonne le PRODUIT (modules pertinents, vocabulaire,
 * défaut TVA), JAMAIS le prix. Quoi montrer = métier ; quoi débloquer = palier (cf.
 * docs/strategy/2026-pricing-verticalisation.md). Source unique consommée par mobile ET web.
 */
export type ModuleKey =
  | 'devis_factures' // socle (tous métiers, gratuit)
  | 'chantiers'
  | 'acomptes'
  | 'situations_travaux'
  | 'retenue_garantie'
  | 'cra' // compte rendu d'activité
  | 'frais_refactures'
  | 'forfaits'
  | 'abonnements'
  | 'cession_droits';

export const MODULE_LABELS: Record<ModuleKey, string> = {
  devis_factures: 'Devis & factures',
  chantiers: 'Chantiers',
  acomptes: 'Acomptes',
  situations_travaux: 'Situations de travaux',
  retenue_garantie: 'Retenue de garantie',
  cra: 'Compte rendu d’activité',
  frais_refactures: 'Frais refacturés',
  forfaits: 'Forfaits',
  abonnements: 'Abonnements',
  cession_droits: 'Cession de droits',
};

/** Palier minimal qui débloque chaque module (socle = free ; modules à valeur = pro). */
export const MODULE_UNLOCK_TIER: Record<ModuleKey, PlanTier> = {
  devis_factures: 'free',
  chantiers: 'solo',
  acomptes: 'solo',
  frais_refactures: 'solo',
  forfaits: 'solo',
  cession_droits: 'solo',
  situations_travaux: 'pro',
  retenue_garantie: 'pro',
  cra: 'pro',
  abonnements: 'pro',
};

/** Modules débloqués par un add-on (en plus du palier). Le Pack BTP octroie le module Chantiers
 * ET les modules chantier lourds — conforme au tagline « Pack Chantier BTP » : tout acheteur
 * (même au palier gratuit) obtient bien ce qui est vendu. Inclus de fait dès Pro via le palier. */
export const ADDON_MODULES: Record<AddOn, readonly ModuleKey[]> = {
  vertical_btp: ['chantiers', 'situations_travaux', 'retenue_garantie'],
};

export interface TradeProfile {
  trade: Trade;
  label: string;
  modules: readonly ModuleKey[]; // modules pertinents (devis_factures toujours inclus)
  defaultVatRate: VatRate;
  vocabulary: { customer: string; project: string };
}

export const TRADE_PROFILES: Record<Trade, TradeProfile> = {
  plombier: {
    trade: 'plombier',
    label: 'Plombier',
    modules: ['devis_factures', 'chantiers', 'acomptes', 'situations_travaux', 'retenue_garantie'],
    defaultVatRate: 10,
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  electricien: {
    trade: 'electricien',
    label: 'Électricien',
    modules: ['devis_factures', 'chantiers', 'acomptes', 'retenue_garantie'],
    defaultVatRate: 10,
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  macon: {
    trade: 'macon',
    label: 'Maçon',
    modules: ['devis_factures', 'chantiers', 'situations_travaux', 'retenue_garantie'],
    defaultVatRate: 10,
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  peintre: {
    trade: 'peintre',
    label: 'Peintre',
    modules: ['devis_factures', 'chantiers', 'acomptes'],
    defaultVatRate: 10,
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  paysagiste: {
    trade: 'paysagiste',
    label: 'Paysagiste',
    modules: ['devis_factures', 'chantiers', 'abonnements'],
    defaultVatRate: 10,
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  consultant: {
    trade: 'consultant',
    label: 'Consultant',
    modules: ['devis_factures', 'cra', 'frais_refactures'],
    defaultVatRate: 20,
    vocabulary: { customer: 'Client', project: 'Mission' },
  },
  photographe: {
    trade: 'photographe',
    label: 'Photographe',
    modules: ['devis_factures', 'acomptes', 'cession_droits'],
    defaultVatRate: 20,
    vocabulary: { customer: 'Client', project: 'Prestation' },
  },
  coach: {
    trade: 'coach',
    label: 'Coach',
    modules: ['devis_factures', 'forfaits', 'abonnements'],
    defaultVatRate: 20,
    vocabulary: { customer: 'Client', project: 'Séance' },
  },
  autre: {
    trade: 'autre',
    label: 'Autre',
    modules: ['devis_factures'],
    defaultVatRate: 20,
    vocabulary: { customer: 'Client', project: 'Projet' },
  },
};

export function tradeProfile(trade: Trade): TradeProfile {
  return TRADE_PROFILES[trade];
}

export interface TradeModuleStatus {
  key: ModuleKey;
  label: string;
  unlockTier: PlanTier;
  active: boolean; // débloqué au palier courant
}

export interface TradeConfig {
  trade: Trade;
  label: string;
  vocabulary: { customer: string; project: string };
  defaultVatRate: VatRate;
  modules: TradeModuleStatus[];
}

/**
 * Point de vérité unique : métier × palier -> config produit résolue.
 * Le métier décide la PERTINENCE (quels modules), le palier décide le DROIT (lesquels actifs).
 */
export function resolveTradeConfig(trade: Trade, tier: PlanTier, addOns: readonly AddOn[] = []): TradeConfig {
  const p = TRADE_PROFILES[trade];
  const grantedByAddOn = (key: ModuleKey): boolean => addOns.some((a) => ADDON_MODULES[a].includes(key));
  return {
    trade,
    label: p.label,
    vocabulary: { ...p.vocabulary },
    defaultVatRate: p.defaultVatRate,
    modules: p.modules.map((key) => ({
      key,
      label: MODULE_LABELS[key],
      unlockTier: MODULE_UNLOCK_TIER[key],
      active: tierAtLeast(tier, MODULE_UNLOCK_TIER[key]) || grantedByAddOn(key),
    })),
  };
}
