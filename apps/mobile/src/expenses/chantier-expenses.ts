/**
 * Logique PURE de la section « Dépenses » d'une fiche chantier — filtre CLIENT sur la liste
 * de dépenses déjà chargée (useExpenses) : AUCUN endpoint dédié. Dépenses imputées au
 * chantier (chantierId), les plus récentes en tête, et total TTC simple en centimes entiers.
 */

export interface ChantierExpenseLike {
  readonly chantierId?: string | null;
  readonly documentDate: string;
  readonly totalTtcCents: number;
}

/** Dépenses imputées au chantier — les plus récentes en tête (dates ISO, tri lexical sûr). */
export function expensesForChantier<T extends ChantierExpenseLike>(
  expenses: readonly T[],
  chantierId: string,
): T[] {
  if (!chantierId) return [];
  return expenses
    .filter((expense) => (expense.chantierId ?? null) === chantierId)
    .sort((a, b) => b.documentDate.localeCompare(a.documentDate));
}

/** Total TTC simple des dépenses listées — somme en centimes, zéro arrondi caché. */
export function chantierExpensesTotalCents(
  expenses: readonly { readonly totalTtcCents: number }[],
): number {
  return expenses.reduce((total, expense) => total + expense.totalTtcCents, 0);
}
