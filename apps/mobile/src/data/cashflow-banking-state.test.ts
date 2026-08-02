import { describe, expect, it } from 'vitest';
import {
  cashflowProjectionWhenQualified,
  hasUnqualifiedCashflowBankingSource,
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

  it('regroupe uniquement absence et péremption du solde comme saisie attendue', () => {
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

  it.each([
    'bank-balance-tenant-scope',
    'bank-balance-qualification',
    'bank-balance-testing-adapter',
  ])('laisse %s en incident fail-closed', (service) => {
    const error = { kind: 'unavailable', service };
    expect(isBankBalanceQualificationError(error)).toBe(false);
    expect(isExpectedMissingBankingInput(error)).toBe(false);
  });

  it('ne présente jamais bankingSource:none comme une projection qualifiée', () => {
    const emptyTransportProjection = {
      available: 0,
      payout: 0,
      bankingSource: 'none',
    } as const;
    expect(hasUnqualifiedCashflowBankingSource(emptyTransportProjection)).toBe(true);
    expect(cashflowProjectionWhenQualified(emptyTransportProjection)).toBeUndefined();
    expect(
      cashflowProjectionWhenQualified({
        available: 42_000,
        bankingSource: 'qualified_snapshot',
      }),
    ).toEqual({ available: 42_000, bankingSource: 'qualified_snapshot' });
    // Compatibilité des réponses antérieures au champ de provenance : absence ≠ sentinel none.
    expect(cashflowProjectionWhenQualified({ available: 42_000 })).toEqual({ available: 42_000 });
  });
});
