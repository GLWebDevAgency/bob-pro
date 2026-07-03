/**
 * Use case pur « résumé du grand-livre » (claim C17) : écritures RÉELLES (AccountingEntryView
 * tel que servi par l'api-client) → synthèse pour l'écran Comptabilité ET pour Bob
 * (« ma compta est-elle équilibrée ? ») — parité d'actions, aucune I/O.
 */

/** Projection minimale d'une écriture (structurellement compatible AccountingEntryView). */
export interface AccountingEntrySummaryData {
  id: string;
  journal: string;
  entryDate: string; // AAAA-MM-JJ
  lines: readonly { debitCents: number; creditCents: number }[];
}

export interface AccountingJournalCount {
  journal: string;
  count: number;
}

export interface AccountingSummary {
  /** Écritures retenues (après filtre journal éventuel). */
  entryCount: number;
  /** Comptes par journal — l'ordre suit la première apparition (stable pour les chips). */
  byJournal: readonly AccountingJournalCount[];
  totalDebitCents: number;
  totalCreditCents: number;
  /** La partie double tient : débits = crédits au centime. */
  balanced: boolean;
  /** Écritures du mois courant (AAAA-MM) — la matière du « mois prêt ». */
  currentMonthCount: number;
}

export function summarizeAccountingEntries(
  entries: readonly AccountingEntrySummaryData[],
  opts: { month?: string; journal?: string | null } = {},
): AccountingSummary {
  const filtered = opts.journal ? entries.filter((e) => e.journal === opts.journal) : [...entries];
  const byJournalMap = new Map<string, number>();
  let totalDebitCents = 0;
  let totalCreditCents = 0;
  let currentMonthCount = 0;
  for (const entry of filtered) {
    byJournalMap.set(entry.journal, (byJournalMap.get(entry.journal) ?? 0) + 1);
    for (const line of entry.lines) {
      totalDebitCents += line.debitCents;
      totalCreditCents += line.creditCents;
    }
    if (opts.month !== undefined && entry.entryDate.startsWith(opts.month)) currentMonthCount += 1;
  }
  return {
    entryCount: filtered.length,
    byJournal: [...byJournalMap.entries()].map(([journal, count]) => ({ journal, count })),
    totalDebitCents,
    totalCreditCents,
    balanced: totalDebitCents === totalCreditCents,
    currentMonthCount,
  };
}
