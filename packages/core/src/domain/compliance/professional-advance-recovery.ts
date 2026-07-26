import type { CustomerType } from '../customer/customer';
import { type DomainResult, err, ok } from '../../shared-kernel/result';

// Le refus SUGGÈRE le repli (décision fondateur 25/07) : ce message part tel quel à l'écran
// ET à la voix (bob-agent, depositUnavailableReason) — jamais un cul-de-sac, toujours le
// chemin équivalent conforme. La situation n'a aucune reprise d'avance à représenter.
export const PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE =
  'La chaîne acompte → facture finale pour un client professionnel reste indisponible ' +
  'jusqu’à la certification Factur-X EXTENDED et Plateforme Agréée de la reprise ' +
  'd’avance. Aucun numéro de facture ne sera consommé — propose plutôt une situation ' +
  'de travaux (par exemple 30 % du marché) : même encaissement, conforme.';

/**
 * Ferme le parcours professionnel tant que Bob ne sait pas représenter puis transmettre la
 * reprise d'avance par taux de TVA et facture antérieure. Le B2C reste un flux PDF/e-reporting
 * distinct : il ne doit pas être bloqué par une limite du profil Factur-X B2B.
 */
export function professionalAdvanceRecoveryGuard(input: {
  customerType: CustomerType;
  invoiceKind: 'deposit' | 'final' | 'situation' | 'credit_note';
  advanceDeductionCents: number;
}): DomainResult<void> {
  if (input.customerType === 'b2c') return ok(undefined);
  if (input.invoiceKind !== 'deposit' && !(input.invoiceKind === 'final' && input.advanceDeductionCents > 0))
    return ok(undefined);
  return err({
    code: 'VALIDATION',
    field: 'advanceRecovery',
    message: PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE,
  });
}
