import { type Trade } from './company';
import { type PlanTier, type AddOn, tierAtLeast } from '../subscription/plan';

/**
 * Configuration par métier : le métier façonne le PRODUIT (modules pertinents,
 * vocabulaire), JAMAIS le prix ni un taux fiscal présumé. Quoi montrer = métier ; quoi
 * débloquer = palier (cf.
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
  insurance: [],
  invoice_advance: [],
  autonomy_confirm_outbound: [],
  autonomy_auto: [],
};

export interface TradeProfile {
  trade: Trade;
  label: string;
  modules: readonly ModuleKey[]; // modules pertinents (devis_factures toujours inclus)
  vocabulary: { customer: string; project: string };
}

export const TRADE_PROFILES: Record<Trade, TradeProfile> = {
  plombier: {
    trade: 'plombier',
    label: 'Plombier',
    modules: ['devis_factures', 'chantiers', 'acomptes', 'situations_travaux', 'retenue_garantie'],
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  electricien: {
    trade: 'electricien',
    label: 'Électricien',
    modules: ['devis_factures', 'chantiers', 'acomptes', 'retenue_garantie'],
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  macon: {
    trade: 'macon',
    label: 'Maçon',
    modules: ['devis_factures', 'chantiers', 'situations_travaux', 'retenue_garantie'],
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  peintre: {
    trade: 'peintre',
    label: 'Peintre',
    modules: ['devis_factures', 'chantiers', 'acomptes'],
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  paysagiste: {
    trade: 'paysagiste',
    label: 'Paysagiste',
    modules: ['devis_factures', 'chantiers', 'abonnements'],
    vocabulary: { customer: 'Client', project: 'Chantier' },
  },
  frigoriste: {
    trade: 'frigoriste',
    // PR-10 — froid commercial / climatisation (bêta Fly Services) : le revenu = contrats
    // d'entretien sur un parc d'équipements PAR SITE — le module chantiers devient le module
    // « sites », les abonnements portent les contrats récurrents, l'acompte reste utile en pose.
    label: 'Frigoriste',
    modules: ['devis_factures', 'chantiers', 'acomptes', 'abonnements'],
    vocabulary: { customer: 'Client', project: 'Site' },
  },
  mainteneur: {
    trade: 'mainteneur',
    // PR-10 — maintenance multitechnique (fontaines, CVC, équipements) : mêmes briques que le
    // frigoriste — sites + contrats récurrents — SANS être un métier du bâtiment (isBtpTrade
    // false : jamais d'autoliquidation BTP présumée).
    label: 'Mainteneur',
    modules: ['devis_factures', 'chantiers', 'acomptes', 'abonnements'],
    vocabulary: { customer: 'Client', project: 'Site' },
  },
  consultant: {
    trade: 'consultant',
    label: 'Consultant',
    modules: ['devis_factures', 'cra', 'frais_refactures'],
    vocabulary: { customer: 'Client', project: 'Mission' },
  },
  freelance_it: {
    trade: 'freelance_it',
    // Freelance IT (dev, DevOps, data, conseil SI) : régie AU TEMPS (CRA/TJM) + projets au
    // FORFAIT (avec acomptes) + MAINTENANCE récurrente (TMA/abonnement) + frais refacturés
    // (licences, cloud, déplacements). Aucun module BTP — d'où l'absence de `chantiers`.
    label: 'Freelance IT',
    modules: ['devis_factures', 'cra', 'forfaits', 'acomptes', 'frais_refactures', 'abonnements'],
    vocabulary: { customer: 'Client', project: 'Mission' },
  },
  photographe: {
    trade: 'photographe',
    label: 'Photographe',
    modules: ['devis_factures', 'acomptes', 'cession_droits'],
    vocabulary: { customer: 'Client', project: 'Prestation' },
  },
  coach: {
    trade: 'coach',
    label: 'Coach',
    modules: ['devis_factures', 'forfaits', 'abonnements'],
    vocabulary: { customer: 'Client', project: 'Séance' },
  },
  autre: {
    trade: 'autre',
    label: 'Autre',
    modules: ['devis_factures'],
    vocabulary: { customer: 'Client', project: 'Projet' },
  },
};

export function tradeProfile(trade: Trade): TradeProfile {
  return TRADE_PROFILES[trade];
}

/**
 * Terminologie adaptative du regroupement chantier/projet — un plombier parle de « chantier »,
 * un freelance IT de « mission », un photographe de « prestation », etc. Dérivée de
 * TRADE_PROFILES.vocabulary.project (source unique du nom métier) : PAS de second mapping
 * concurrent, juste l'accord grammatical (genre, pluriel, articles) qui manquait pour composer
 * des phrases correctes ({worksiteTerm} dans @bob/i18n). Toujours en minuscule (les gabarits de
 * phrase gèrent la casse en tête de phrase).
 */
export interface WorksiteTerminology {
  readonly singular: string;
  readonly plural: string;
  readonly gender: 'm' | 'f';
  readonly article: {
    /** « un »/« une ». */
    readonly indefinite: string;
    /** « le »/« la » (jamais l'élision — aucun des noms gérés ne commence par une voyelle). */
    readonly definite: string;
  };
}

const WORKSITE_TERMINOLOGY_BY_NOUN: Record<string, WorksiteTerminology> = {
  Chantier: {
    singular: 'chantier',
    plural: 'chantiers',
    gender: 'm',
    article: { indefinite: 'un', definite: 'le' },
  },
  Mission: {
    singular: 'mission',
    plural: 'missions',
    gender: 'f',
    article: { indefinite: 'une', definite: 'la' },
  },
  Prestation: {
    singular: 'prestation',
    plural: 'prestations',
    gender: 'f',
    article: { indefinite: 'une', definite: 'la' },
  },
  Séance: {
    singular: 'séance',
    plural: 'séances',
    gender: 'f',
    article: { indefinite: 'une', definite: 'la' },
  },
  Projet: {
    singular: 'projet',
    plural: 'projets',
    gender: 'm',
    article: { indefinite: 'un', definite: 'le' },
  },
  // PR-10 — métiers de la maintenance : le même écran parle « chantier » à un maçon et
  // « site » à un frigoriste (aucun second mapping : dérivé de vocabulary.project).
  Site: {
    singular: 'site',
    plural: 'sites',
    gender: 'm',
    article: { indefinite: 'un', definite: 'le' },
  },
};

/** Repli sûr si un métier futur n'a pas encore de nom déclaré dans WORKSITE_TERMINOLOGY_BY_NOUN. */
const DEFAULT_WORKSITE_TERMINOLOGY: WorksiteTerminology = WORKSITE_TERMINOLOGY_BY_NOUN.Projet!;

/**
 * Métier → terminologie du regroupement chantier/projet (BTP → chantier, IT/design/conseil →
 * mission/projet, par défaut → projet). Pure, testée : aucune I/O, aucun accès réseau.
 */
export function tradeToWorksiteTerminology(trade: Trade): WorksiteTerminology {
  const noun = tradeProfile(trade).vocabulary.project;
  return WORKSITE_TERMINOLOGY_BY_NOUN[noun] ?? DEFAULT_WORKSITE_TERMINOLOGY;
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
    modules: p.modules.map((key) => ({
      key,
      label: MODULE_LABELS[key],
      unlockTier: MODULE_UNLOCK_TIER[key],
      active: tierAtLeast(tier, MODULE_UNLOCK_TIER[key]) || grantedByAddOn(key),
    })),
  };
}
