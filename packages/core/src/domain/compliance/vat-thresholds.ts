/**
 * Franchise en base de TVA — seuils de l'art. 293 B du CGI (E6, audit expert-comptable).
 *
 * Seuils en vigueur 2025-2026 (LF 2025 ; la réforme « seuil unique 25 000 € » a été
 * suspendue) : prestations de services 37 500 € (majoré 41 250 €) · livraisons de biens /
 * ventes 85 000 € (majoré 93 500 €). Règles d'effet :
 * · CA ≤ seuil de base → franchise maintenue ;
 * · seuil de base < CA ≤ seuil majoré → TVA au 1er JANVIER suivant (tolérance année en cours) ;
 * · CA > seuil majoré → TVA IMMÉDIATE (dès le jour du dépassement — chaque facture émise
 *   ensuite sans TVA = rappel + pénalités).
 * Le module est versionné par année d'effet : une loi de finances = une nouvelle table.
 */

export type VatActivity = 'services' | 'ventes';

export interface VatFranchiseThresholds {
  baseCents: number;
  majoredCents: number;
}

export const VAT_FRANCHISE_THRESHOLDS_2025: Record<VatActivity, VatFranchiseThresholds> = {
  services: { baseCents: 3_750_000, majoredCents: 4_125_000 },
  ventes: { baseCents: 8_500_000, majoredCents: 9_350_000 },
};

export type VatFranchiseStanding = 'ok' | 'approaching' | 'over_base' | 'over_majored';

export interface VatFranchiseStatus {
  standing: VatFranchiseStanding;
  /** CA rapporté au seuil de base, en % entier (140 % possible au-delà). */
  ratioPct: number;
  thresholds: VatFranchiseThresholds;
  /** Marge restante avant le seuil de base (0 si dépassé). */
  remainingToBaseCents: number;
}

/** Palier d'alerte : à 80 % du seuil de base, l'artisan doit commencer à anticiper. */
const APPROACHING_PCT = 80;

export function assessVatFranchise(input: {
  activity: VatActivity;
  /** Recettes ENCAISSÉES de l'année civile (centimes) — la référence micro/franchise. */
  annualRevenueCents: number;
  thresholds?: VatFranchiseThresholds;
}): VatFranchiseStatus {
  const thresholds = input.thresholds ?? VAT_FRANCHISE_THRESHOLDS_2025[input.activity];
  const revenue = Math.max(0, input.annualRevenueCents);
  const ratioPct = thresholds.baseCents === 0 ? 0 : Math.round((revenue * 100) / thresholds.baseCents);

  let standing: VatFranchiseStanding = 'ok';
  if (revenue > thresholds.majoredCents) standing = 'over_majored';
  else if (revenue > thresholds.baseCents) standing = 'over_base';
  else if (ratioPct >= APPROACHING_PCT) standing = 'approaching';

  return {
    standing,
    ratioPct,
    thresholds,
    remainingToBaseCents: Math.max(0, thresholds.baseCents - revenue),
  };
}
