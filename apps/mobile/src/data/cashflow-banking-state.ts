type AppErrorShape = {
  readonly kind?: unknown;
  readonly service?: unknown;
  readonly entity?: unknown;
};

function appErrorShape(error: unknown): AppErrorShape | null {
  return error !== null && typeof error === 'object' ? (error as AppErrorShape) : null;
}

/** L'API refuse toute projection tant qu'aucun solde bancaire réel n'a été confirmé. */
export function isCashflowBankingInputMissing(error: unknown): boolean {
  const candidate = appErrorShape(error);
  return candidate?.kind === 'unavailable' && candidate.service === 'cashflow-banking-source';
}

/** États du GET solde que l'UI doit présenter comme une confirmation attendue, pas une panne. */
export function isBankBalanceQualificationError(error: unknown): boolean {
  const candidate = appErrorShape(error);
  if (candidate?.kind === 'not_found' && candidate.entity === 'bank_balance_snapshot') return true;
  return candidate?.kind === 'unavailable' && candidate.service === 'bank-balance-stale';
}

export function isExpectedMissingBankingInput(error: unknown): boolean {
  return isBankBalanceQualificationError(error) || isCashflowBankingInputMissing(error);
}

type CashflowProjectionShape = {
  readonly bankingSource?: unknown;
};

/**
 * `bankingSource: none` décrit un tenant sans observation bancaire qualifiée. Le payload à zéro
 * est utile au transport pour distinguer un compte vierge d'une panne, mais ce n'est JAMAIS une
 * projection financière affichable. L'UI doit attendre/faire confirmer le solde, ou échouer fermé
 * si un autre endpoint affirme simultanément qu'un solde qualifié existe.
 */
export function hasUnqualifiedCashflowBankingSource(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return (value as CashflowProjectionShape).bankingSource === 'none';
}

/** Préserve les projections legacy/qualifiées et retire uniquement le sentinel exact `none`. */
export function cashflowProjectionWhenQualified<T>(value: T | undefined): T | undefined {
  return hasUnqualifiedCashflowBankingSource(value) ? undefined : value;
}
