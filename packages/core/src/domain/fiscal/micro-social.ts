import { type Trade } from '../company/company';

/**
 * Régime micro-social — taux VERSIONNÉS + provision de cotisations (P03, C-EXP5c).
 *
 * Service domaine PUR : la table des taux globaux du micro-entrepreneur (art. D613-4 CSS),
 * versionnée par ANNÉE civile (mécanisme légal : les décrets fixent les marches au 1er janvier),
 * l'option de versement libératoire de l'impôt sur le revenu (art. 151-0 CGI, ADDITIVE au taux
 * social) et le calcul de provision sur un CA ENCAISSÉ — jamais sur le facturé (le micro déclare
 * ce qu'il a ENCAISSÉ, art. L613-8 CSS).
 *
 * Pattern du référentiel : identique à LATE_PENALTY_RATES (domain/dunning/late-penalties.ts) —
 * année demandée hors table → taux de la dernière année CONNUE antérieure (ils restaient en
 * vigueur), à défaut la plus ancienne, et `stale: true` : jamais un taux inventé, l'appelant
 * affiche l'avertissement.
 *
 * Taux 2026 (vérifiés au build, 2026-07-04) — art. D613-4 CSS, rédaction du décret n° 2025-943
 * du 8 septembre 2025 (JORF JORFTEXT000052211971), applicable aux périodes courant à compter
 * du 1er janvier 2026 (Légifrance LEGIARTI000052218738) :
 * · ventes de marchandises (BIC)                       12,3 %
 * · prestations de services BIC (artisan/commerçant)   21,2 %
 * · autres prestations (BNC, régime 102 ter CGI)       25,6 %  (le décret 2025-943 ABAISSE la
 *   marche 2026 : 26,1 % prévus par le décret 2024-484 → 25,6 %)
 * · professions libérales réglementées Cipav           23,2 %
 * Hors périmètre v1 (aucun métier Bob concerné, documenté) : location meublée de tourisme 6 % ;
 * taux réduits ACRE (décret 2026-69 du 6/2/2026) non modélisés.
 *
 * Versement libératoire (option, art. 151-0 CGI — s'AJOUTE au taux social) :
 * 1 % ventes · 1,7 % prestations BIC · 2,2 % BNC et professions libérales (Cipav comprise).
 */

// ── Catégories d'activité micro (nomenclature URSSAF de la déclaration de CA) ──

export type MicroActivityCategory =
  /** Vente de marchandises, objets, fournitures, denrées (BIC — art. 50-0, 1-1° CGI). */
  | 'ventes'
  /** Prestations de services commerciales ou artisanales (BIC — art. 50-0, 1-2° CGI). */
  | 'bic_prestations'
  /** Autres prestations de services — BNC non réglementé (régime 102 ter CGI). */
  | 'bnc'
  /** Professions libérales réglementées relevant de la Cipav (art. R641-1 CSS). */
  | 'liberale_reglementee_cipav';

/** 'certain' = catégorie déclarée/établie ; 'assumed' = dérivée prudemment, à confirmer. */
export type MicroCategoryConfidence = 'certain' | 'assumed';

// ── Référentiel annuel VERSIONNÉ ──

export interface MicroSocialYearRates {
  year: number;
  /** Taux global de cotisations en % du CA encaissé (art. D613-4 CSS). */
  socialPct: Record<MicroActivityCategory, number>;
  /** Versement libératoire de l'IR en % du CA, ADDITIF au taux social (art. 151-0 CGI). */
  vflPct: Record<MicroActivityCategory, number>;
}

/**
 * Une entrée par année civile — chaque décret = une ligne.
 * 2025 : décret n° 2024-484 du 30 mai 2024 (BNC non Cipav : marche à 24,6 % au 1/1/2025 ;
 *        Cipav 23,2 % depuis le 1/7/2024) ; ventes 12,3 % et prestations BIC 21,2 % inchangés.
 * 2026 : décret n° 2025-943 du 8 septembre 2025 (BNC non Cipav ABAISSÉ à 25,6 % au lieu des
 *        26,1 % programmés) ; autres taux inchangés. VFL : art. 151-0, II CGI (stable).
 */
export const MICRO_SOCIAL_RATES: readonly MicroSocialYearRates[] = [
  {
    year: 2025,
    socialPct: { ventes: 12.3, bic_prestations: 21.2, bnc: 24.6, liberale_reglementee_cipav: 23.2 },
    vflPct: { ventes: 1, bic_prestations: 1.7, bnc: 2.2, liberale_reglementee_cipav: 2.2 },
  },
  {
    year: 2026,
    socialPct: { ventes: 12.3, bic_prestations: 21.2, bnc: 25.6, liberale_reglementee_cipav: 23.2 },
    vflPct: { ventes: 1, bic_prestations: 1.7, bnc: 2.2, liberale_reglementee_cipav: 2.2 },
  },
];

export interface ResolvedMicroSocialRates {
  rates: MicroSocialYearRates;
  /** true = année hors référentiel : taux de la dernière année connue (l'appelant avertit). */
  stale: boolean;
}

/**
 * Résout les taux d'une année : entrée exacte si connue ; sinon la dernière année connue
 * ANTÉRIEURE (les taux restaient en vigueur), à défaut la plus ancienne — `stale: true`.
 */
export function resolveMicroSocialRates(year: number): ResolvedMicroSocialRates {
  const exact = MICRO_SOCIAL_RATES.find((r) => r.year === year);
  if (exact !== undefined) return { rates: exact, stale: false };
  const known = [...MICRO_SOCIAL_RATES].sort((a, b) => a.year - b.year);
  const before = [...known].reverse().find((r) => r.year < year);
  const fallback = before ?? known[0];
  if (fallback === undefined) {
    // Le référentiel est une constante non vide du module : inatteignable, mais typé honnêtement.
    throw new Error('MICRO_SOCIAL_RATES est vide — référentiel annuel corrompu');
  }
  return { rates: fallback, stale: true };
}

// ── Catégorie d'activité dérivée du métier (prudente, jamais silencieuse) ──

export interface MicroCategoryGuess {
  category: MicroActivityCategory;
  confidence: MicroCategoryConfidence;
}

/**
 * Métier Bob → catégorie micro. Les artisans du bâtiment relèvent des prestations de services
 * artisanales BIC (21,2 %) — 'certain' : c'est la nature de l'activité, et provisionner TOUT le
 * CA à 21,2 % reste prudent même si une part ventes (12,3 %) existait. Les métiers intellectuels
 * (conseil, photo, coaching) et le repli 'autre' sont posés en BNC 25,6 % — le taux le PLUS HAUT
 * (prudence) — et 'assumed' : l'utilisateur confirme (un photographe peut être artisan BIC ;
 * aucun métier Bob ne relève de la Cipav, qui se déclare explicitement via `category`).
 */
const TRADE_TO_MICRO_CATEGORY: Record<Trade, MicroCategoryGuess> = {
  plombier: { category: 'bic_prestations', confidence: 'certain' },
  electricien: { category: 'bic_prestations', confidence: 'certain' },
  macon: { category: 'bic_prestations', confidence: 'certain' },
  peintre: { category: 'bic_prestations', confidence: 'certain' },
  paysagiste: { category: 'bic_prestations', confidence: 'certain' },
  consultant: { category: 'bnc', confidence: 'assumed' },
  photographe: { category: 'bnc', confidence: 'assumed' },
  coach: { category: 'bnc', confidence: 'assumed' },
  autre: { category: 'bnc', confidence: 'assumed' },
};

export function microCategoryFromTrade(trade: Trade): MicroCategoryGuess {
  return TRADE_TO_MICRO_CATEGORY[trade];
}

// ── Provision sur CA encaissé ──

export interface ComputeMicroSocialProvisionInput {
  /** CA ENCAISSÉ de la période, en centimes (net des remboursements, jamais le facturé). */
  encaissedCents: number;
  category: MicroActivityCategory;
  /** Option versement libératoire de l'IR (art. 151-0 CGI) — additive. */
  vfl: boolean;
  /** Année civile de la période de déclaration (pilote la version des taux). */
  year: number;
}

export interface MicroSocialProvision {
  /** Taux social appliqué, en % (art. D613-4 CSS, version de l'année résolue). */
  socialRatePct: number;
  /** Taux du versement libératoire appliqué, en % — null si l'option n'est pas prise. */
  vflRatePct: number | null;
  /** Somme des deux taux, en %. */
  totalRatePct: number;
  /** Cotisations sociales en centimes. */
  socialCents: number;
  /** Versement libératoire en centimes (0 sans option). */
  vflCents: number;
  /** Total à provisionner : social + VFL (les deux lignes de la déclaration URSSAF). */
  provisionCents: number;
  /** true = année hors référentiel : taux de la dernière année connue (à avertir). */
  stale: boolean;
}

/**
 * Cotisations à provisionner sur un CA encaissé. ARRONDI : chaque ligne (social, VFL) au centime
 * le plus proche SÉPARÉMENT — ce sont deux lignes distinctes de la déclaration URSSAF — puis
 * sommée. Interne en centièmes de point (entiers) : 21,2 % → 2120, le produit reste exact.
 * CA négatif (remboursements > encaissements) → plancher 0 : on ne déclare pas un CA négatif.
 */
export function computeMicroSocialProvision(input: ComputeMicroSocialProvisionInput): MicroSocialProvision {
  const { rates, stale } = resolveMicroSocialRates(input.year);
  const base = Math.max(0, Math.round(input.encaissedCents));
  const socialCentiPct = Math.round(rates.socialPct[input.category] * 100);
  const vflCentiPct = input.vfl ? Math.round(rates.vflPct[input.category] * 100) : 0;
  const socialCents = Math.round((base * socialCentiPct) / 10_000);
  const vflCents = Math.round((base * vflCentiPct) / 10_000);
  return {
    socialRatePct: socialCentiPct / 100,
    vflRatePct: input.vfl ? vflCentiPct / 100 : null,
    totalRatePct: (socialCentiPct + vflCentiPct) / 100,
    socialCents,
    vflCents,
    provisionCents: socialCents + vflCents,
    stale,
  };
}
