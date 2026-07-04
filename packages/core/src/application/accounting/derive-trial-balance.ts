/**
 * Balance générale des comptes (CLOTURE-1) — LE document de synthèse que l'expert-comptable
 * associé ouvre en premier avant de signer (vision produit : « le cercle »). Use case pur :
 * cumule débits/crédits PAR COMPTE sur les écritures réelles, expose le solde signé et le
 * RÉSULTAT PROVISOIRE (produits classe 7 − charges classe 6 — bénéfice positif).
 * Même dérivation pour l'écran Clôture et pour Bob (« combien je gagne ? »).
 */

export interface TrialBalanceEntryData {
  lines: readonly { account: string; label?: string; debitCents: number; creditCents: number }[];
}

export interface TrialBalanceRow {
  account: string;
  debitCents: number;
  creditCents: number;
  /** Solde signé : positif = débiteur, négatif = créditeur. */
  balanceCents: number;
}

export interface TrialBalance {
  /** Une ligne par compte mouvementé, triée par numéro de compte. */
  rows: readonly TrialBalanceRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  /** La partie double tient au centime sur l'ensemble des comptes. */
  balanced: boolean;
  /** Résultat provisoire = produits (7) − charges (6). Positif = bénéfice. */
  resultCents: number;
  /** Les deux jambes du résultat, pour l'explication (« produits X − charges Y »). */
  revenueCents: number;
  chargesCents: number;
}

export function deriveTrialBalance(entries: readonly TrialBalanceEntryData[]): TrialBalance {
  const byAccount = new Map<string, { debitCents: number; creditCents: number }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const bucket = byAccount.get(line.account) ?? { debitCents: 0, creditCents: 0 };
      bucket.debitCents += line.debitCents;
      bucket.creditCents += line.creditCents;
      byAccount.set(line.account, bucket);
    }
  }

  let totalDebitCents = 0;
  let totalCreditCents = 0;
  let revenueCents = 0;
  let chargesCents = 0;
  const rows: TrialBalanceRow[] = [...byAccount.entries()]
    .map(([account, sums]) => {
      totalDebitCents += sums.debitCents;
      totalCreditCents += sums.creditCents;
      const balanceCents = sums.debitCents - sums.creditCents;
      // Classe 7 : produits au crédit (solde créditeur = CA) ; classe 6 : charges au débit.
      if (account.startsWith('7')) revenueCents += -balanceCents;
      if (account.startsWith('6')) chargesCents += balanceCents;
      return { account, debitCents: sums.debitCents, creditCents: sums.creditCents, balanceCents };
    })
    .sort((a, b) => a.account.localeCompare(b.account));

  return {
    rows,
    totalDebitCents,
    totalCreditCents,
    balanced: totalDebitCents === totalCreditCents,
    resultCents: revenueCents - chargesCents,
    revenueCents,
    chargesCents,
  };
}
