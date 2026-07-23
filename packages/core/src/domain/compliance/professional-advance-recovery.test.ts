import { describe, expect, it } from 'vitest';
import { professionalAdvanceRecoveryGuard } from './professional-advance-recovery';

describe('professionalAdvanceRecoveryGuard', () => {
  it.each(['b2b', 'b2g'] as const)(
    'refuse une facture d\'acompte %s tant que la reprise EXTENDED/PA n\'est pas certifiée',
    (customerType) => {
      const result = professionalAdvanceRecoveryGuard({
        customerType,
        invoiceKind: 'deposit',
        advanceDeductionCents: 0,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION', field: 'advanceRecovery' },
      });
    },
  );

  it('refuse la finale professionnelle qui reprend une avance, mais pas une finale ordinaire', () => {
    expect(
      professionalAdvanceRecoveryGuard({
        customerType: 'b2b',
        invoiceKind: 'final',
        advanceDeductionCents: 30_000,
      }).ok,
    ).toBe(false);
    expect(
      professionalAdvanceRecoveryGuard({
        customerType: 'b2b',
        invoiceKind: 'final',
        advanceDeductionCents: 0,
      }).ok,
    ).toBe(true);
  });

  it.each(['deposit', 'final'] as const)(
    'laisse le flux B2C %s au chemin PDF/e-reporting distinct',
    (invoiceKind) => {
      expect(
        professionalAdvanceRecoveryGuard({
          customerType: 'b2c',
          invoiceKind,
          advanceDeductionCents: invoiceKind === 'final' ? 30_000 : 0,
        }).ok,
      ).toBe(true);
    },
  );
});
