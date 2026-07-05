import { type DateOnly } from '../../shared-kernel/time';
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
 * Hors périmètre v1 (aucun métier Bob concerné, documenté) : location meublée de tourisme 6 %.
 * Taux réduits ACRE des créateurs (art. L.131-6-4/D.131-6-3 CSS, marche du décret 2026-69 du
 * 6/2/2026) : voir la section ACRE en bas de fichier — MICRO_ACRE_RATES, resolveAcreRates,
 * acreWindow (C-EXP5d).
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
  /**
   * Taux social ACRE minoré (%) à appliquer À LA PLACE du taux plein (art. D.131-6-3 CSS) —
   * résolu en amont par l'appelant (resolveAcreRates) selon la DATE DE DÉBUT D'ACTIVITÉ.
   * null/absent = pas d'ACRE, taux plein. L'ACRE ne minore QUE le social : le versement
   * libératoire (art. 151-0 CGI) reste dû au taux plein — VFL cumulable avec l'ACRE (C-EXP5d).
   */
  acreRatePct?: number | null;
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
  // ACRE : le taux minoré REMPLACE le taux plein social (art. D.131-6-3 CSS) ; sinon taux plein.
  const effectiveSocialPct = input.acreRatePct ?? rates.socialPct[input.category];
  const socialCentiPct = Math.round(effectiveSocialPct * 100);
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

// ── ACRE : exonération micro-social des créateurs (C-EXP5d — art. L.131-6-4, D.131-6-3 CSS) ──

/**
 * Taux ACRE = taux MINORÉ des cotisations sociales du créateur, à taux fixe UNIQUE (non dégressif
 * depuis la suppression du dispositif triennal — derniers bénéficiaires : débuts avant le
 * 1/4/2020). Il REMPLACE le taux plein social pendant la fenêtre d'exonération (cf. acreWindow) ;
 * le versement libératoire de l'IR (art. 151-0 CGI) reste dû en plein — l'ACRE ne touche QUE le
 * social, VFL cumulable.
 *
 * MODÈLE (corrigé C-EXP-FIX1) : le taux ACRE est une RÉDUCTION du taux plein de l'ANNÉE DÉCLARÉE,
 * PAS une valeur absolue figée. Deux dimensions indépendantes :
 *  · l'ANNÉE de déclaration fixe le taux plein de base (MICRO_SOCIAL_RATES — ex. BNC plein 24,6 %
 *    en 2025 mais 25,6 % en 2026 : l'ACRE BNC vaut donc 12,3 % pour une déclaration 2025 et 12,8 %
 *    pour 2026, à réduction identique) ;
 *  · la DATE DE DÉBUT D'ACTIVITÉ fixe le FACTEUR de réduction (part du plein restant due) : 50 %
 *    avant le 1/7/2026, 75 % pour les créations micro à compter du 1/7/2026 (décret n° 2026-69 du
 *    6/2/2026, JORF JORFTEXT000053449085, art. D.131-6-3 CSS modifié — entrée en vigueur au
 *    1/7/2026 pour le micro-social, échelonnée depuis le 1/1/2026 pour le droit commun).
 *
 * Le taux publié est ARRONDI au dixième de point (0,1 %) : `round1(plein × facteur)` reproduit le
 * barème URSSAF (12,3 × 0,5 = 6,15 → 6,2 ; 12,3 × 0,75 = 9,225 → 9,2 ; 25,6 × 0,5 = 12,8 ;
 * 24,6 × 0,5 = 12,3). Sources vérifiées :
 * · https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000053449085 (décret n° 2026-69 du 6/2/2026) ;
 * · https://www.urssaf.fr/accueil/exoneration-acre-createur.html (page officielle ACRE URSSAF) ;
 * · taux pleins par année = MICRO_SOCIAL_RATES ci-dessus (décrets 2025-943 / actualité BNC 25,6 %).
 */
export interface AcreReductionStep {
  /** Première DATE DE DÉBUT D'ACTIVITÉ à laquelle ce facteur s'applique (borne incluse). */
  effectiveFrom: DateOnly;
  /** Part du taux PLEIN restant due pendant l'exonération (0,5 = moitié due ; 0,75 = trois quarts). */
  factor: number;
}

/**
 * Une entrée par MARCHE de réduction, ordonnée par date de début d'activité croissante — la marche
 * du 1/7/2026 (décret 2026-69) fait passer le micro de 50 % à 75 % du taux plein restant dû.
 */
export const MICRO_ACRE_REDUCTION_STEPS: readonly AcreReductionStep[] = [
  { effectiveFrom: '1970-01-01', factor: 0.5 }, // créations avant le 1/7/2026 : 50 % du plein
  { effectiveFrom: '2026-07-01', factor: 0.75 }, // créations micro dès le 1/7/2026 : 75 % (décret 2026-69)
];

/**
 * Facteur de réduction ACRE applicable à une date de début d'activité : la MARCHE la plus récente
 * dont l'`effectiveFrom` est ≤ dateCreation (à défaut la plus ancienne connue).
 */
export function resolveAcreReductionFactor(dateCreation: DateOnly): number {
  const ordered = [...MICRO_ACRE_REDUCTION_STEPS].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const applicable = [...ordered].reverse().find((s) => s.effectiveFrom <= dateCreation) ?? ordered[0];
  if (applicable === undefined) {
    // Constante non vide du module : inatteignable, mais typé honnêtement (comme MICRO_SOCIAL_RATES).
    throw new Error('MICRO_ACRE_REDUCTION_STEPS est vide — référentiel ACRE corrompu');
  }
  return applicable.factor;
}

/**
 * Taux social ACRE d'une catégorie = taux plein de l'ANNÉE DÉCLARÉE × facteur (date de création),
 * arrondi au dixième de point comme le barème URSSAF publié. Corrige le bug d'un taux figé 2026
 * appliqué à toute année (le BNC plein change entre 2025 et 2026).
 */
export function resolveAcreSocialPct(
  year: number,
  category: MicroActivityCategory,
  dateCreation: DateOnly,
): number {
  const { rates } = resolveMicroSocialRates(year);
  const factor = resolveAcreReductionFactor(dateCreation);
  // Arrondi au 0,1 % : le barème publié est au dixième de point (6,15 → 6,2). Entiers en dixièmes.
  return Math.round(rates.socialPct[category] * 10 * factor) / 10;
}

export interface AcreWindow {
  /** Point de départ EXACT de l'exonération = la date de début d'activité déclarée. */
  start: DateOnly;
  /** Dernier jour du 3e trimestre civil SUIVANT celui du début d'activité (borne incluse). */
  end: DateOnly;
}

/**
 * Fenêtre d'exonération ACRE (fonction PURE). L'exonération court de la date de début d'activité
 * au DERNIER JOUR du 3e trimestre civil SUIVANT celui au cours duquel l'activité a débuté — soit
 * le trimestre de création + 3 trimestres civils (≈ 10 à 12 mois selon la position dans le
 * trimestre). Exemple officiel URSSAF/service-public : début le 3/9/2026 (T3 2026) → fin le
 * 30/6/2027 (fin du T2 2027). Base légale : durée fixée à l'art. D.131-6-3 CSS (bénéficiaires
 * art. L.131-6-4 CSS) ; le décret 2026-69 ne modifie NI la durée NI la règle de fenêtre.
 */
export function acreWindow(dateCreation: DateOnly): AcreWindow {
  const y0 = Number(dateCreation.slice(0, 4));
  const m0 = Number(dateCreation.slice(5, 7));
  const quarter0 = Math.floor((m0 - 1) / 3); // 0..3 (trimestre civil de création)
  const absoluteQuarter = y0 * 4 + quarter0 + 3; // + les 3 trimestres civils suivants
  const endYear = Math.floor(absoluteQuarter / 4);
  const endQuarter = absoluteQuarter % 4; // 0..3
  const endMonth = endQuarter * 3 + 3; // 3, 6, 9 ou 12 (1-indexé)
  const endDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate(); // dernier jour du mois (UTC)
  const mm = String(endMonth).padStart(2, '0');
  const dd = String(endDay).padStart(2, '0');
  return { start: dateCreation, end: `${endYear}-${mm}-${dd}` };
}
