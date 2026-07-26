import type { FrenchOperationCategory } from '@bob/core';

export const INVOICE_OPERATION_CATEGORIES = [
  'services',
  'goods',
  'mixed',
] as const satisfies readonly FrenchOperationCategory[];

export interface InvoiceIssueDecisionState {
  operationCategory: FrenchOperationCategory | null;
  embargoOverride: boolean;
  /** PR-04 — émission sans BC exigé, confirmée (préservée entre les décisions séquentielles). */
  purchaseOrderOverride: boolean;
}

export const EMPTY_INVOICE_ISSUE_DECISION: InvoiceIssueDecisionState = Object.freeze({
  operationCategory: null,
  embargoOverride: false,
  purchaseOrderOverride: false,
});

/**
 * Une émission peut traverser plusieurs décisions séquentielles (BT-23, embargo, BC — dans
 * n'importe quel ordre). Cette fusion préserve chaque consentement explicite jusqu'au succès ou
 * à l'annulation du parcours ; aucun replay ne doit redemander une décision déjà prise ni la
 * perdre en route.
 */
export function mergeInvoiceIssueDecision(
  current: InvoiceIssueDecisionState,
  input: {
    operationCategory?: FrenchOperationCategory;
    embargoOverride?: boolean;
    purchaseOrderOverride?: boolean;
  },
): InvoiceIssueDecisionState {
  return {
    operationCategory: input.operationCategory ?? current.operationCategory,
    embargoOverride: input.embargoOverride === true || current.embargoOverride,
    purchaseOrderOverride: input.purchaseOrderOverride === true || current.purchaseOrderOverride,
  };
}

export function invoiceIssueDecisionInput(state: InvoiceIssueDecisionState): {
  operationCategory?: FrenchOperationCategory;
  embargoOverride?: true;
  purchaseOrderOverride?: true;
} {
  return {
    ...(state.operationCategory === null
      ? {}
      : { operationCategory: state.operationCategory }),
    ...(state.embargoOverride ? { embargoOverride: true as const } : {}),
    ...(state.purchaseOrderOverride ? { purchaseOrderOverride: true as const } : {}),
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
 * PR-04 — détection STRUCTURÉE du refus « BC obligatoire » (DomainError PURCHASE_ORDER_REQUIRED),
 * même doctrine que l'embargo : jamais un message libre comme signal. Retourne le message
 * actionnable du domaine (CTA « saisir le BC »), ou null si l'erreur est d'une autre nature.
 */
export function purchaseOrderRequiredMessageOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { kind?: unknown; error?: unknown };
  if (candidate.kind !== 'domain' || !candidate.error || typeof candidate.error !== 'object')
    return null;
  const domain = candidate.error as { code?: unknown; message?: unknown };
  if (domain.code !== 'PURCHASE_ORDER_REQUIRED') return null;
  return typeof domain.message === 'string' ? domain.message : '';
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
