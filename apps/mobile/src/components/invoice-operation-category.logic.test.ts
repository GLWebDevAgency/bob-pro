import { describe, expect, it } from 'vitest';
import {
  EMPTY_INVOICE_ISSUE_DECISION,
  INVOICE_OPERATION_CATEGORIES,
  invoiceIssueDecisionInput,
  isOperationCategoryRequiredError,
  mergeInvoiceIssueDecision,
  parseInvoiceOperationCategoryChoice,
} from './invoice-operation-category.logic';

describe('décision BT-23 mobile', () => {
  it('n’accepte que les trois faits métier fermés', () => {
    expect(INVOICE_OPERATION_CATEGORIES).toEqual(['services', 'goods', 'mixed']);
    expect(parseInvoiceOperationCategoryChoice('services')).toBe('services');
    expect(parseInvoiceOperationCategoryChoice('goods')).toBe('goods');
    expect(parseInvoiceOperationCategoryChoice('mixed')).toBe('mixed');
    expect(parseInvoiceOperationCategoryChoice('S1')).toBeNull();
    expect(parseInvoiceOperationCategoryChoice('hybrid')).toBeNull();
    expect(parseInvoiceOperationCategoryChoice(null)).toBeNull();
  });

  it('reconnaît le même refus via HTTP et via le client local sans lire le message', () => {
    expect(isOperationCategoryRequiredError({
      kind: 'validation',
      issues: [{ field: 'operationCategory', message: 'Texte transport.' }],
    })).toBe(true);
    expect(isOperationCategoryRequiredError({
      kind: 'domain',
      error: { code: 'VALIDATION', field: 'operationCategory', message: 'Texte domaine.' },
    })).toBe(true);
    expect(isOperationCategoryRequiredError({
      kind: 'validation',
      issues: [{ field: 'invoiceId', message: 'Facture manquante.' }],
    })).toBe(false);
    expect(isOperationCategoryRequiredError(new Error('operationCategory'))).toBe(false);
  });

  it('préserve les deux décisions quel que soit leur ordre avant le replay final', () => {
    const embargoThenCategory = mergeInvoiceIssueDecision(
      mergeInvoiceIssueDecision(EMPTY_INVOICE_ISSUE_DECISION, { embargoOverride: true }),
      { operationCategory: 'mixed' },
    );
    expect(invoiceIssueDecisionInput(embargoThenCategory)).toEqual({
      operationCategory: 'mixed',
      embargoOverride: true,
    });

    const categoryThenEmbargo = mergeInvoiceIssueDecision(
      mergeInvoiceIssueDecision(EMPTY_INVOICE_ISSUE_DECISION, { operationCategory: 'services' }),
      { embargoOverride: true },
    );
    expect(invoiceIssueDecisionInput(categoryThenEmbargo)).toEqual({
      operationCategory: 'services',
      embargoOverride: true,
    });
    expect(EMPTY_INVOICE_ISSUE_DECISION).toEqual({
      operationCategory: null,
      embargoOverride: false,
    });
  });
});
