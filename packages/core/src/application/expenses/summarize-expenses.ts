import { type DateOnly } from '../../shared-kernel/time';
import { type ExpenseCategory, type ExpenseStatus } from '../../domain/expense/expense';

/**
 * Synthèse des dépenses (E10 — écran Dépenses + Bob « combien de charges ce mois ? »).
 * Use case pur : reste à payer (la dette fournisseurs vivante), payé sur le mois,
 * TVA déductible du mois (miroir du 44566 posté par E1), ventilation par catégorie.
 */

export interface ExpenseSummaryData {
  totalTtcCents: number;
  vatCents: number | null;
  category: ExpenseCategory;
  status: ExpenseStatus;
  documentDate: DateOnly;
}

export interface ExpenseCategoryCount {
  category: ExpenseCategory;
  count: number;
  ttcCents: number;
}

export interface ExpensesSummary {
  /** Dette fournisseurs vivante (Σ TTC des dépenses à payer). */
  toPayCents: number;
  toPayCount: number;
  /** Décaissé sur le mois demandé (dépenses payées, datées du mois). */
  paidThisMonthCents: number;
  /** TVA déductible MENTIONNÉE sur les pièces du mois (art. 242 nonies A). */
  vatDeductibleThisMonthCents: number;
  /** Par catégorie (toutes périodes), ordre de première apparition — stable pour les chips. */
  byCategory: readonly ExpenseCategoryCount[];
}

export function summarizeExpenses(
  expenses: readonly ExpenseSummaryData[],
  opts: { month: string },
): ExpensesSummary {
  let toPayCents = 0;
  let toPayCount = 0;
  let paidThisMonthCents = 0;
  let vatDeductibleThisMonthCents = 0;
  const byCategoryMap = new Map<ExpenseCategory, { count: number; ttcCents: number }>();

  for (const expense of expenses) {
    if (expense.status === 'to_pay') {
      toPayCents += expense.totalTtcCents;
      toPayCount += 1;
    }
    const inMonth = expense.documentDate.startsWith(opts.month);
    if (inMonth && expense.status === 'paid') paidThisMonthCents += expense.totalTtcCents;
    if (inMonth) vatDeductibleThisMonthCents += expense.vatCents ?? 0;
    const bucket = byCategoryMap.get(expense.category) ?? { count: 0, ttcCents: 0 };
    bucket.count += 1;
    bucket.ttcCents += expense.totalTtcCents;
    byCategoryMap.set(expense.category, bucket);
  }

  return {
    toPayCents,
    toPayCount,
    paidThisMonthCents,
    vatDeductibleThisMonthCents,
    byCategory: [...byCategoryMap.entries()].map(([category, b]) => ({ category, ...b })),
  };
}
