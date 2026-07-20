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
  return (
    candidate?.kind === 'unavailable' &&
    typeof candidate.service === 'string' &&
    candidate.service.startsWith('bank-balance')
  );
}

export function isExpectedMissingBankingInput(error: unknown): boolean {
  return isBankBalanceQualificationError(error) || isCashflowBankingInputMissing(error);
}
