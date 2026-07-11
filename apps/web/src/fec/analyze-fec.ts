import {
  deriveBalanceSheet,
  deriveClosingReview,
  deriveIncomeStatement,
  deriveTrialBalance,
  type BalanceSheet,
  type ClosingReview,
  type DateOnly,
  type IncomeStatement,
  type TrialBalance,
  type TrialBalanceRow,
} from '@bob/core';

import type { ParsedFec, ParsedFecEntry } from './parse-fec';

export interface LabeledTrialBalanceRow extends TrialBalanceRow {
  readonly label: string;
}

export type LabeledTrialBalance = Omit<TrialBalance, 'rows'> & {
  readonly rows: readonly LabeledTrialBalanceRow[];
};

export interface UnbalancedFecEntry {
  readonly key: string;
  readonly journalCode: string;
  readonly entryNumber: string;
  readonly entryDate: string;
  readonly totalDebitCents: number;
  readonly totalCreditCents: number;
  /** Débit - crédit : positif si une contrepartie crédit manque. */
  readonly differenceCents: number;
}

export interface FecAnalysisChecks {
  /** Toutes les écritures, prises individuellement, respectent la partie double. */
  readonly entriesBalanced: boolean;
  /** Totaux Débit/Crédit du FEC entier. */
  readonly trialBalanceBalanced: boolean;
  /** Total actif = total passif dans le moteur de bilan. */
  readonly balanceSheetBalanced: boolean;
  /** Résultat balance = compte de résultat = résultat porté au bilan. */
  readonly resultConsistent: boolean;
  readonly allPassed: boolean;
}

export interface FecAnalysis {
  readonly trialBalance: LabeledTrialBalance;
  readonly incomeStatement: IncomeStatement;
  readonly balanceSheet: BalanceSheet;
  /** Chiffre d'affaires strict : soldes créditeurs des comptes 70x (709 le minore). */
  readonly turnoverCents: number;
  readonly unbalancedEntries: readonly UnbalancedFecEntry[];
  readonly checks: FecAnalysisChecks;
}

/**
 * Rejoue la revue de clôture officielle sur les écritures groupées du FEC. Les détails
 * restent en mémoire ; seul leur résumé agrégé est ensuite autorisé dans localStorage.
 */
export function deriveFecClosingReview(
  fec: ParsedFec,
  options: { yearEnd?: boolean } = {},
): ClosingReview {
  const period =
    fec.period.from !== null && fec.period.to !== null
      ? {
          from: fec.period.from as DateOnly,
          to: fec.period.to as DateOnly,
        }
      : null;

  return deriveClosingReview({
    entries: fec.entries.map((entry) => ({
      entryDate: entry.entryDate as DateOnly,
      lines: entry.lines,
    })),
    ...(period === null ? {} : { period }),
    ...(options.yearEnd === undefined ? {} : { yearEnd: options.yearEnd }),
  });
}

function inspectEntryBalance(entry: ParsedFecEntry): UnbalancedFecEntry | null {
  let totalDebitCents = 0;
  let totalCreditCents = 0;
  for (const line of entry.lines) {
    totalDebitCents += line.debitCents;
    totalCreditCents += line.creditCents;
  }
  const differenceCents = totalDebitCents - totalCreditCents;
  if (differenceCents === 0) return null;
  return {
    key: entry.key,
    journalCode: entry.journalCode,
    entryNumber: entry.entryNumber,
    entryDate: entry.entryDate,
    totalDebitCents,
    totalCreditCents,
    differenceCents,
  };
}

export function analyzeFec(fec: ParsedFec): FecAnalysis {
  // Les trois moteurs reçoivent exactement le même jeu d'écritures groupées par journal+numéro.
  const trialBalanceCore = deriveTrialBalance(fec.entries);
  const incomeStatement = deriveIncomeStatement(fec.entries);
  const balanceSheet = deriveBalanceSheet(fec.entries);

  const trialBalance: LabeledTrialBalance = {
    ...trialBalanceCore,
    rows: trialBalanceCore.rows.map((row) => ({
      ...row,
      label: fec.accountLabels[row.account] ?? `Compte ${row.account}`,
    })),
  };

  const turnoverCents = trialBalance.rows
    .filter((row) => row.account.startsWith('70'))
    .reduce((total, row) => total + row.creditCents - row.debitCents, 0);
  const unbalancedEntries = fec.entries
    .map(inspectEntryBalance)
    .filter((entry): entry is UnbalancedFecEntry => entry !== null);
  const resultConsistent =
    trialBalance.resultCents === incomeStatement.resultatNetCents &&
    incomeStatement.resultatNetCents === balanceSheet.passif.resultatNetCents;
  const entriesBalanced = unbalancedEntries.length === 0;
  const checks: FecAnalysisChecks = {
    entriesBalanced,
    trialBalanceBalanced: trialBalance.balanced,
    balanceSheetBalanced: balanceSheet.balanced,
    resultConsistent,
    allPassed:
      entriesBalanced && trialBalance.balanced && balanceSheet.balanced && resultConsistent,
  };

  return { trialBalance, incomeStatement, balanceSheet, turnoverCents, unbalancedEntries, checks };
}
