/**
 * Compte de résultat (CDR-1) — le document normé que l'expert-comptable associé lit après
 * la balance : il DÉCOMPOSE le résultat en 4 soldes intermédiaires français (exploitation,
 * financier, courant, exceptionnel, net) au lieu du grossier « classe 7 − classe 6 ».
 * Use case pur ; mapping compte PCG → rubrique conçu et VÉRIFIÉ adversarialement
 * (workflow wf_386fd432-c06). Même dérivation pour l'écran Clôture et pour Bob.
 *
 * Deux règles cardinales issues de la vérification :
 * · MATCHING PLUS-LONG-PRÉFIXE : 681 (exploitation) ≠ 686 (financier) ≠ 687 (exceptionnel) ;
 *   idem 781/786/787 (reprises) et 791/796/797 (transferts). Un préfixe court « 68 » enverrait
 *   une dotation financière dans l'exploitation. Le compte seedé 6811 tombe donc dans 681.
 * · CONVENTION DE SIGNE alignée sur deriveTrialBalance (balanceCents = débit − crédit) :
 *   produit = somme(−balanceCents), charge = somme(+balanceCents) — ainsi les RRR à
 *   contre-sens (709 débiteur, 609 créditeur) et le destockage (71 négatif) se cumulent
 *   correctement dans leur rubrique parente sans reclassement.
 *
 * INVARIANT : resultatNetCents == Σ(soldes signés classe 7) − Σ(soldes signés classe 6),
 * soit exactement le résultat provisoire de deriveTrialBalance. La ventilation fine ne
 * change jamais le total, elle le décompose (test dédié).
 */

export interface IncomeStatementEntryData {
  lines: readonly { account: string; debitCents: number; creditCents: number }[];
}

type RubriqueKey =
  | 'exploitationProduits'
  | 'exploitationCharges'
  | 'financierProduits'
  | 'financierCharges'
  | 'exceptionnelProduits'
  | 'exceptionnelCharges'
  | 'participation'
  | 'impotBenefices';

/** Table préfixe → rubrique (mapping canonique vérifié). Le sens fixe la convention de signe. */
const PREFIX_MAP: readonly { prefix: string; rubrique: RubriqueKey; sens: 'produit' | 'charge' }[] = [
  // Exploitation
  { prefix: '70', rubrique: 'exploitationProduits', sens: 'produit' },
  { prefix: '71', rubrique: 'exploitationProduits', sens: 'produit' },
  { prefix: '72', rubrique: 'exploitationProduits', sens: 'produit' },
  { prefix: '73', rubrique: 'exploitationProduits', sens: 'produit' },
  { prefix: '74', rubrique: 'exploitationProduits', sens: 'produit' },
  { prefix: '75', rubrique: 'exploitationProduits', sens: 'produit' },
  { prefix: '781', rubrique: 'exploitationProduits', sens: 'produit' },
  { prefix: '791', rubrique: 'exploitationProduits', sens: 'produit' },
  { prefix: '60', rubrique: 'exploitationCharges', sens: 'charge' },
  { prefix: '61', rubrique: 'exploitationCharges', sens: 'charge' },
  { prefix: '62', rubrique: 'exploitationCharges', sens: 'charge' },
  { prefix: '63', rubrique: 'exploitationCharges', sens: 'charge' },
  { prefix: '64', rubrique: 'exploitationCharges', sens: 'charge' },
  { prefix: '65', rubrique: 'exploitationCharges', sens: 'charge' },
  { prefix: '681', rubrique: 'exploitationCharges', sens: 'charge' },
  // Financier
  { prefix: '76', rubrique: 'financierProduits', sens: 'produit' },
  { prefix: '786', rubrique: 'financierProduits', sens: 'produit' },
  { prefix: '796', rubrique: 'financierProduits', sens: 'produit' },
  { prefix: '66', rubrique: 'financierCharges', sens: 'charge' },
  { prefix: '686', rubrique: 'financierCharges', sens: 'charge' },
  // Exceptionnel
  { prefix: '77', rubrique: 'exceptionnelProduits', sens: 'produit' },
  { prefix: '787', rubrique: 'exceptionnelProduits', sens: 'produit' },
  { prefix: '797', rubrique: 'exceptionnelProduits', sens: 'produit' },
  { prefix: '67', rubrique: 'exceptionnelCharges', sens: 'charge' },
  { prefix: '687', rubrique: 'exceptionnelCharges', sens: 'charge' },
  // Sous le résultat exceptionnel (classe 69) — 691 réservé par le plus-long-préfixe.
  { prefix: '691', rubrique: 'participation', sens: 'charge' },
  { prefix: '69', rubrique: 'impotBenefices', sens: 'charge' },
];

export interface IncomeStatement {
  exploitationProduitsCents: number;
  exploitationChargesCents: number;
  resultatExploitationCents: number;
  financierProduitsCents: number;
  financierChargesCents: number;
  resultatFinancierCents: number;
  /** Résultat courant avant impôts = exploitation + financier. */
  resultatCourantCents: number;
  exceptionnelProduitsCents: number;
  exceptionnelChargesCents: number;
  resultatExceptionnelCents: number;
  /** Participation des salariés (691) — déduite AVANT l'IS. */
  participationCents: number;
  /** Résultat net avant impôt = courant + exceptionnel − participation. */
  resultatNetAvantImpotCents: number;
  /** Impôt sur les bénéfices (69 hors 691) — 0 pour un artisan à l'IR (BIC). */
  impotBeneficesCents: number;
  /** Résultat net = net avant impôt − IS. INVARIANT = classe 7 − classe 6. */
  resultatNetCents: number;
}

/** Rubrique du compte la plus spécifique (plus long préfixe) — null si hors classes 6/7/9. */
function rubriqueOf(account: string): { rubrique: RubriqueKey; sens: 'produit' | 'charge' } | null {
  let best: { rubrique: RubriqueKey; sens: 'produit' | 'charge' } | null = null;
  let bestLen = 0;
  for (const { prefix, rubrique, sens } of PREFIX_MAP) {
    if (account.startsWith(prefix) && prefix.length > bestLen) {
      best = { rubrique, sens };
      bestLen = prefix.length;
    }
  }
  return best;
}

export function deriveIncomeStatement(entries: readonly IncomeStatementEntryData[]): IncomeStatement {
  const totals: Record<RubriqueKey, number> = {
    exploitationProduits: 0,
    exploitationCharges: 0,
    financierProduits: 0,
    financierCharges: 0,
    exceptionnelProduits: 0,
    exceptionnelCharges: 0,
    participation: 0,
    impotBenefices: 0,
  };

  // Cumul par compte d'abord (solde signé unique par compte), puis ventilation.
  const balanceByAccount = new Map<string, number>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      balanceByAccount.set(line.account, (balanceByAccount.get(line.account) ?? 0) + line.debitCents - line.creditCents);
    }
  }

  for (const [account, balanceCents] of balanceByAccount) {
    const hit = rubriqueOf(account);
    if (!hit) continue; // comptes de bilan (classes 1-5) : hors compte de résultat
    // produit crédité → −balance ; charge débitée → +balance (RRR et destockage absorbés).
    totals[hit.rubrique] += hit.sens === 'produit' ? -balanceCents : balanceCents;
  }

  const resultatExploitationCents = totals.exploitationProduits - totals.exploitationCharges;
  const resultatFinancierCents = totals.financierProduits - totals.financierCharges;
  const resultatCourantCents = resultatExploitationCents + resultatFinancierCents;
  const resultatExceptionnelCents = totals.exceptionnelProduits - totals.exceptionnelCharges;
  const resultatNetAvantImpotCents = resultatCourantCents + resultatExceptionnelCents - totals.participation;
  const resultatNetCents = resultatNetAvantImpotCents - totals.impotBenefices;

  return {
    exploitationProduitsCents: totals.exploitationProduits,
    exploitationChargesCents: totals.exploitationCharges,
    resultatExploitationCents,
    financierProduitsCents: totals.financierProduits,
    financierChargesCents: totals.financierCharges,
    resultatFinancierCents,
    resultatCourantCents,
    exceptionnelProduitsCents: totals.exceptionnelProduits,
    exceptionnelChargesCents: totals.exceptionnelCharges,
    resultatExceptionnelCents,
    participationCents: totals.participation,
    resultatNetAvantImpotCents,
    impotBeneficesCents: totals.impotBenefices,
    resultatNetCents,
  };
}
