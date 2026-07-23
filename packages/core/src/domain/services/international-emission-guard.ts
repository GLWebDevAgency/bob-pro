import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Customer } from '../customer/customer';

/**
 * B6 (garde-fou de l'item B7 de l'audit) — client établi HORS DE FRANCE :
 * l'émission est BLOQUÉE, sans contournement.
 *
 * Pourquoi fail-closed : une prestation/vente à un assujetti établi dans l'UE relève de
 * l'AUTOLIQUIDATION par le preneur (art. 259 du CGI, directive 2006/112/CE — mention
 * « Autoliquidation » et n° de TVA intracommunautaire du preneur exigés), et une exportation
 * hors UE de l'EXONÉRATION de l'art. 262 du CGI. Bob ne gère pas encore ces régimes (pas de
 * champ n° TVA intracom du preneur validé VIES, pas de mention dédiée, routage e-invoicing
 * français) : émettre avec une TVA française serait FISCALEMENT FAUX — TVA facturée à tort,
 * due au Trésor par le seul fait de sa mention (art. 283, 3 du CGI). Le blocage protège
 * l'intégrité fiscale de l'artisan ; le module complet (intracom/export) est un lot ultérieur.
 *
 * Bob ne stocke pas encore le pays ISO de l'adresse client ni le régime OSS/export : même pour
 * un particulier, émettre aujourd'hui marquerait faussement FR dans Factur-X. Toute émission
 * internationale est donc refusée jusqu'à modélisation du pays et du traitement fiscal exact.
 */
export const INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE =
  'Client établi hors de France : le pays, la TVA intracommunautaire/OSS et l’exonération export ' +
  'ne sont pas encore modélisés de bout en bout. Pour un professionnel, l’autoliquidation par ' +
  "le preneur (art. 259 du CGI) et l'exonération à l'export (art. 262 du CGI) ne sont pas " +
  'encore gérées. Émettre cette pièce avec une TVA française serait fiscalement faux — ' +
  "l'émission est bloquée pour protéger ton intégrité fiscale, sans contournement possible.";

/** Garde d'émission — refuse toute pièce tant que le pays/régime international est incomplet. */
export function internationalProEmissionGuard(customer: Customer): DomainResult<void> {
  if (customer.isInternational())
    return err({
      code: 'VALIDATION',
      field: 'customer',
      message: INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE,
    });
  return ok(undefined);
}
