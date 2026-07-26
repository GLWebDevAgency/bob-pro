import { describe, expect, it } from 'vitest';
import {
  PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE,
  professionalAdvanceRecoveryGuard,
} from './professional-advance-recovery';

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
        error: {
          code: 'VALIDATION',
          field: 'advanceRecovery',
          message: PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE,
        },
      });
    },
  );

  it('le refus SUGGÈRE le repli conforme (écran ET voix) — jamais un cul-de-sac sec', () => {
    // Décision fondateur 25/07 : le message sert tel quel à la voix (bob-agent) et aux
    // feuilles d'erreur — il doit porter le chemin équivalent, pas seulement la fermeture.
    expect(PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE).toContain('situation de travaux');
    expect(PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE).toContain(
      'même encaissement, conforme',
    );
    // Le motif technique reste dit (liste des facturables : stringContaining('Factur-X EXTENDED')).
    expect(PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE).toContain('Factur-X EXTENDED');
    // Et la promesse fail-closed demeure : aucun numéro légal consommé par le refus.
    expect(PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE).toContain(
      'Aucun numéro de facture ne sera consommé',
    );
  });

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
