import type { FrenchOperationCategory } from '@bob/core';

export const INVOICE_OPERATION_CATEGORIES = [
  'services',
  'goods',
  'mixed',
] as const satisfies readonly FrenchOperationCategory[];

export interface InvoiceIssueDecisionState {
  operationCategory: FrenchOperationCategory | null;
  embargoOverride: boolean;
}

export const EMPTY_INVOICE_ISSUE_DECISION: InvoiceIssueDecisionState = Object.freeze({
  operationCategory: null,
  embargoOverride: false,
});

/**
 * Une émission peut traverser deux décisions séquentielles (BT-23 puis embargo, ou l'inverse).
 * Cette fusion préserve chaque consentement explicite jusqu'au succès ou à l'annulation du
 * parcours ; aucun replay ne doit redemander une décision déjà prise ni la perdre en route.
 */
export function mergeInvoiceIssueDecision(
  current: InvoiceIssueDecisionState,
  input: {
    operationCategory?: FrenchOperationCategory;
    embargoOverride?: boolean;
  },
): InvoiceIssueDecisionState {
  return {
    operationCategory: input.operationCategory ?? current.operationCategory,
    embargoOverride: input.embargoOverride === true || current.embargoOverride,
  };
}

export function invoiceIssueDecisionInput(state: InvoiceIssueDecisionState): {
  operationCategory?: FrenchOperationCategory;
  embargoOverride?: true;
} {
  return {
    ...(state.operationCategory === null
      ? {}
      : { operationCategory: state.operationCategory }),
    ...(state.embargoOverride ? { embargoOverride: true as const } : {}),
  };
}

export function parseInvoiceOperationCategoryChoice(
  value: unknown,
): FrenchOperationCategory | null {
  return typeof value === 'string'
    && INVOICE_OPERATION_CATEGORIES.includes(value as FrenchOperationCategory)
    ? (value as FrenchOperationCategory)
    : null;
}

/**
 * Le transport HTTP normalise généralement le refus en AppError.validation, tandis que le
 * client local peut restituer directement l'erreur de domaine. Les deux canaux doivent ouvrir
 * exactement la même décision structurée ; aucun message libre n'est utilisé comme signal.
 */
export function isOperationCategoryRequiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    kind?: unknown;
    issues?: unknown;
    error?: unknown;
  };

  if (candidate.kind === 'validation' && Array.isArray(candidate.issues)) {
    return candidate.issues.some((issue) =>
      Boolean(
        issue
        && typeof issue === 'object'
        && 'field' in issue
        && (issue as { field?: unknown }).field === 'operationCategory',
      ));
  }

  if (candidate.kind === 'domain' && candidate.error && typeof candidate.error === 'object') {
    const domain = candidate.error as { code?: unknown; field?: unknown };
    return domain.code === 'VALIDATION' && domain.field === 'operationCategory';
  }

  return false;
}
