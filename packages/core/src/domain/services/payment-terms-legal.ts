import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type CustomerType } from '../customer/customer';

/**
 * B4 — Plafonds LÉGAUX des délais de paiement convenus entre PROFESSIONNELS
 * (art. L441-10, I du code de commerce, texte vérifié sur Légifrance) :
 *  • régime général : le délai convenu ne peut dépasser SOIXANTE JOURS à compter de la date
 *    d'émission de la facture ;
 *  • par dérogation, un délai de QUARANTE-CINQ JOURS FIN DE MOIS peut être convenu, à condition
 *    d'être stipulé au contrat et de ne pas constituer un abus manifeste.
 * Sanction : amende administrative jusqu'à 75 000 € (personne physique) / 2 M€ (personne
 * morale), art. L441-16 du code de commerce.
 *
 * Périmètre : clients PROFESSIONNELS (b2b, b2g). Le consommateur (b2c) n'est pas visé par
 * L441-10. NB b2g : la commande publique a son propre délai RÉGLEMENTAIRE de paiement (30 jours,
 * art. R2192-10 du code de la commande publique) — plus strict que le plafond conventionnel
 * validé ici ; le conseil « 30 jours pour un acheteur public » relève du LegalHint côté UI,
 * jamais d'un blocage inventé au domaine.
 */
export const PRO_PAYMENT_TERMS_MAX_DAYS = 60;
export const PRO_PAYMENT_TERMS_END_OF_MONTH_MAX_DAYS = 45;

export interface PaymentTermsCandidate {
  days: number;
  endOfMonth: boolean;
}

/**
 * Valide le plafond légal L441-10 pour un client donné — appliqué à l'ENREGISTREMENT des
 * conditions par client (Customer.paymentTerms) ET revalidé à l'ÉMISSION (fail-closed pour
 * toute donnée antérieure) : une échéance illégale fausserait relances J+3/J+10/J+20/J+30 et
 * pénalités calculées depuis dueAt.
 */
export function validateProPaymentTermsCeiling(
  customerType: CustomerType,
  terms: PaymentTermsCandidate,
): DomainResult<void> {
  if (customerType === 'b2c') return ok(undefined);
  if (terms.endOfMonth) {
    if (terms.days > PRO_PAYMENT_TERMS_END_OF_MONTH_MAX_DAYS)
      return err({
        code: 'VALIDATION',
        field: 'paymentTerms',
        message:
          `Délai « fin de mois » plafonné à ${PRO_PAYMENT_TERMS_END_OF_MONTH_MAX_DAYS} jours entre professionnels ` +
          '(art. L441-10 du code de commerce).',
      });
    return ok(undefined);
  }
  if (terms.days > PRO_PAYMENT_TERMS_MAX_DAYS)
    return err({
      code: 'VALIDATION',
      field: 'paymentTerms',
      message:
        `Délai de paiement plafonné à ${PRO_PAYMENT_TERMS_MAX_DAYS} jours à compter de l'émission entre ` +
        'professionnels (art. L441-10 du code de commerce).',
    });
  return ok(undefined);
}
