import { describe, expect, it } from 'vitest';
import {
  isBankBalanceQualificationError,
  isCashflowBankingInputMissing,
  isExpectedMissingBankingInput,
} from './cashflow-banking-state';

describe('cashflow banking input state', () => {
  it('reconnaît uniquement le prérequis bancaire explicite de la projection', () => {
    expect(
      isCashflowBankingInputMissing({
        kind: 'unavailable',
        service: 'cashflow-banking-source',
      }),
    ).toBe(true);
    expect(
      isCashflowBankingInputMissing({ kind: 'unavailable', service: 'cashflow-financial-data' }),
    ).toBe(false);
  });

  it('regroupe absence, péremption et qualification du solde comme saisie attendue', () => {
    expect(
      isBankBalanceQualificationError({
        kind: 'not_found',
        entity: 'bank_balance_snapshot',
      }),
    ).toBe(true);
    expect(
      isBankBalanceQualificationError({ kind: 'unavailable', service: 'bank-balance-stale' }),
    ).toBe(true);
    expect(isExpectedMissingBankingInput(null)).toBe(false);
    expect(isExpectedMissingBankingInput(new Error('network'))).toBe(false);
  });
});
