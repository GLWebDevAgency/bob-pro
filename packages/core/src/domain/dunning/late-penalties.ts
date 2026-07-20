import { type DateOnly } from '../../shared-kernel/time';
import { type CustomerType } from '../customer/customer';

/**
 * Pénalités de retard CHIFFRÉES (P12, C-EXP2 vA) — service domaine pur.
 *
 * Régimes (références vérifiées, roadmap expertise-comptable §P12) :
 * · b2b — art. L441-10, II C. com : pénalités de PLEIN DROIT dès le lendemain de l'échéance,
 *   au taux stipulé (CGV/facture) sinon au défaut légal BCE refi + 10 points ; le taux stipulé
 *   ne peut être inférieur à 3× le taux d'intérêt légal (plancher appliqué ET signalé) ;
 *   + indemnité forfaitaire de recouvrement 40 € par facture (art. D441-5 C. com).
 * · b2g — art. L2192-12 et L2192-13 CCP + décret 2013-269 du 29/3/2013 : intérêts moratoires
 *   au taux BCE refi + 8 points, de plein droit, + indemnité forfaitaire 40 €.
 * · b2c — AUCUNE pénalité de plein droit : intérêts moratoires au taux légal UNIQUEMENT à
 *   compter d'une mise en demeure (art. 1344-1 et 1231-6 C. civ) — 0 sans MED envoyée,
 *   JAMAIS d'indemnité 40 € (D441-5 ne vise que les débiteurs professionnels).
 *
 * Calcul : base TTC (reste dû) × taux annuel × jours de retard / 365 — année civile de 365 jours
 * (convention des intérêts moratoires). ARRONDI : au centime le plus proche, demi-centime vers
 * le haut (Math.round sur produit positif), en UNE SEULE passe sur le produit final — jamais de
 * cumul de journaliers arrondis. Interne en centièmes de point (entiers) pour rester exact.
 *
 * Taux : v1 applique le taux du semestre de `asOf` à TOUTE la période (la mise en demeure
 * réclame « à ce jour » au taux courant) ; le référentiel versionné par semestre permettra un
 * découpage semestre par semestre dans une version ultérieure.
 */

// ── Référentiel semestriel VERSIONNÉ (pattern vat-thresholds : une table par période légale) ──

/** Semestre civil au format 'YYYY-S1' | 'YYYY-S2' (mécanisme légal : taux au 1/1 et au 1/7). */
export type PenaltyHalf = `${number}-S1` | `${number}-S2`;

export interface PenaltyRateHalf {
  half: PenaltyHalf;
  /** Taux refi BCE en % annuel, en vigueur au 1er jour du semestre (L441-10 II / décret 2013-269). */
  bceRefiPct: number;
  /**
   * Taux d'intérêt légal en % annuel — cas du créancier PROFESSIONNEL (« tous les autres cas »
   * de l'art. L313-2 CMF) : le créancier est ici l'artisan, jamais un particulier.
   */
  legalRatePct: number;
}

/**
 * Une entrée par semestre — chaque publication (arrêté taux légal, décision BCE) = une ligne.
 * S1 2026 :
 * · BCE refi 2,15 % — valeur vérifiée du rapport expertise-comptable (P12 : BCE+10 = 12,15 %).
 * · Taux légal créancier professionnel 2,62 % — arrêté du 15 décembre 2025 relatif à la fixation
 *   du taux de l'intérêt légal, JORF du 26/12/2025 (Légifrance JORFTEXT000053165408) ; le taux
 *   « personne physique n'agissant pas pour des besoins professionnels » (6,67 %) ne s'applique
 *   pas à Bob (créancier = professionnel).
 */
export const LATE_PENALTY_RATES: readonly PenaltyRateHalf[] = [
  { half: '2026-S1', bceRefiPct: 2.15, legalRatePct: 2.62 },
];

/** Semestre civil d'une date : janvier-juin → S1, juillet-décembre → S2. */
export function halfOf(date: DateOnly): PenaltyHalf {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month <= 6 ? `${year}-S1` : `${year}-S2`;
}

export interface ResolvedPenaltyRates {
  rates: PenaltyRateHalf;
  /** true = le semestre demandé n'est pas au référentiel : taux du dernier semestre CONNU
   *  (jamais un taux inventé — l'appelant affiche l'avertissement). */
  stale: boolean;
}

/**
 * Résout les taux d'un semestre : entrée exacte si connue ; sinon le dernier semestre connu
 * ANTÉRIEUR au semestre demandé (le taux restait en vigueur), à défaut le plus ancien connu —
 * dans les deux cas `stale: true`. Le format 'YYYY-SN' s'ordonne lexicographiquement.
 */
export function resolvePenaltyRates(half: PenaltyHalf): ResolvedPenaltyRates {
  const exact = LATE_PENALTY_RATES.find((r) => r.half === half);
  if (exact !== undefined) return { rates: exact, stale: false };
  const known = [...LATE_PENALTY_RATES].sort((a, b) => (a.half < b.half ? -1 : 1));
  const before = [...known].reverse().find((r) => r.half < half);
  const fallback = before ?? known[0];
  if (fallback === undefined) {
    // Le référentiel est une constante non vide du module : inatteignable, mais typé honnêtement.
    throw new Error('LATE_PENALTY_RATES est vide — référentiel semestriel corrompu');
  }
  return { rates: fallback, stale: true };
}

// ── Calcul des pénalités ──────────────────────────────────────────────────────

/** Indemnité forfaitaire de recouvrement — art. D441-5 C. com / L2192-13 CCP (40 €). */
export const FIXED_INDEMNITY_CENTS = 4000;

export type PenaltyRateBasis =
  /** Taux stipulé aux CGV/facture (b2b, ≥ plancher). */
  | 'stipule'
  /** Défaut légal b2b : BCE refi + 10 points (L441-10 II). */
  | 'bce_plus_10'
  /** Taux réglementaire b2g : BCE refi + 8 points (décret 2013-269). */
  | 'bce_plus_8'
  /** Taux légal (b2c, créancier professionnel — art. 1231-6 C. civ). */
  | 'taux_legal'
  /** Plancher 3× taux légal substitué à un taux stipulé trop bas (L441-10 II). */
  | 'plancher_3x_legal';

export interface ComputeLatePenaltiesInput {
  /** Base des pénalités en centimes : le reste dû TTC (L441-10 : montant TTC de la créance). */
  ttcCents: number;
  dueAt: DateOnly;
  asOf: DateOnly;
  customerType: CustomerType;
  /**
   * Taux annuel stipulé aux CGV/facture, en % (b2b uniquement — ignoré en b2g où le taux est
   * réglementaire, et en b2c où seul le taux légal court). Sous 3× le taux légal, le plancher
   * est substitué et `flooredToLegalMinimum` signalé.
   */
  stipulatedAnnualRatePct?: number;
  /**
   * b2c : date de la mise en demeure envoyée — SANS elle, aucun intérêt ne court (art. 1344-1).
   * Les intérêts courent à compter du LENDEMAIN de la MED (convention prudente, symétrique du
   * lendemain de l'échéance b2b : le jour de l'envoi ne compte pas).
   */
  fromMiseEnDemeureAt?: DateOnly;
}

export interface LatePenalties {
  /** Intérêts/pénalités de retard courus à `asOf`, en centimes. */
  interestCents: number;
  /** Indemnité forfaitaire de recouvrement en centimes — 4000 (b2b/b2g en retard), 0 en b2c. */
  fixedIndemnityCents: number;
  /** Accroissement quotidien au taux courant en centimes (0 si rien ne court) — « ça coûte X €/jour ». */
  dailyCents: number;
  /** Jours de retard décomptés (b2b/b2g : depuis le lendemain de l'échéance ; b2c : depuis la MED). */
  days: number;
  /** Taux annuel appliqué, en %. */
  rateAnnualPct: number;
  rateBasis: PenaltyRateBasis;
  /** true = semestre de `asOf` hors référentiel : taux du dernier semestre connu (à avertir). */
  stale: boolean;
  /** true = taux stipulé sous 3× le taux légal : plancher appliqué (L441-10 II). */
  flooredToLegalMinimum: boolean;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

/** Arrondi au centime : base × taux (centièmes de point) × jours / 365 — entiers de bout en bout. */
function interestCentsOf(baseCents: number, rateCentiPct: number, days: number): number {
  return Math.round((baseCents * rateCentiPct * days) / (10_000 * 365));
}

export function computeLatePenalties(input: ComputeLatePenaltiesInput): LatePenalties {
  const { rates, stale } = resolvePenaltyRates(halfOf(input.asOf));
  const base = Math.max(0, Math.round(input.ttcCents));
  // DateOnly « YYYY-MM-DD » : la comparaison lexicographique est la comparaison chronologique.
  const isLate = input.asOf > input.dueAt;

  let rateAnnualPct: number;
  let rateBasis: PenaltyRateBasis;
  let flooredToLegalMinimum = false;
  let days = 0;
  let fixedIndemnityCents = 0;
  let running = false;

  switch (input.customerType) {
    case 'b2b': {
      const floorPct = 3 * rates.legalRatePct;
      const chosenPct = input.stipulatedAnnualRatePct ?? rates.bceRefiPct + 10;
      if (chosenPct < floorPct) {
        rateAnnualPct = floorPct;
        rateBasis = 'plancher_3x_legal';
        flooredToLegalMinimum = true;
      } else {
        rateAnnualPct = chosenPct;
        rateBasis = input.stipulatedAnnualRatePct !== undefined ? 'stipule' : 'bce_plus_10';
      }
      // De plein droit dès le LENDEMAIN de l'échéance (L441-10 II) : le jour J n'est pas en retard.
      days = isLate ? daysBetween(input.dueAt, input.asOf) : 0;
      fixedIndemnityCents = isLate ? FIXED_INDEMNITY_CENTS : 0;
      running = isLate;
      break;
    }
    case 'b2g': {
      // Taux réglementaire (décret 2013-269) : un taux stipulé ne peut y déroger — ignoré.
      rateAnnualPct = rates.bceRefiPct + 8;
      rateBasis = 'bce_plus_8';
      days = isLate ? daysBetween(input.dueAt, input.asOf) : 0;
      fixedIndemnityCents = isLate ? FIXED_INDEMNITY_CENTS : 0;
      running = isLate;
      break;
    }
    case 'b2c': {
      rateAnnualPct = rates.legalRatePct;
      rateBasis = 'taux_legal';
      const med = input.fromMiseEnDemeureAt;
      // Aucune MED → RIEN ne court ni n'est dû (art. 1344-1) ; jamais de 40 € (D441-5 = pros).
      running = med !== undefined && med <= input.asOf;
      days = med !== undefined && input.asOf > med ? daysBetween(med, input.asOf) : 0;
      break;
    }
  }

  // Taux en centièmes de point (entier) : 12,15 % → 1215 — le calcul reste en arithmétique entière.
  const rateCentiPct = Math.round(rateAnnualPct * 100);
  return {
    interestCents: interestCentsOf(base, rateCentiPct, days),
    fixedIndemnityCents,
    dailyCents: running ? interestCentsOf(base, rateCentiPct, 1) : 0,
    days,
    rateAnnualPct: rateCentiPct / 100,
    rateBasis,
    stale,
    flooredToLegalMinimum,
  };
}
