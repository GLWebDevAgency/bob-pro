import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Customer } from '../customer/customer';

/**
 * B6 (garde-fou de l'item B7 de l'audit) — client PROFESSIONNEL établi HORS DE FRANCE :
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
 * Périmètre exact : professionnel (b2b/b2g) ET international. Le particulier étranger n'est
 * pas visé (TVA française applicable au B2C de proximité) ; le professionnel FRANÇAIS non plus.
 */
export const INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE =
  'Client professionnel établi hors de France : la TVA intracommunautaire (autoliquidation par ' +
  "le preneur, art. 259 du CGI) et l'exonération à l'export (art. 262 du CGI) ne sont pas " +
  'encore gérées. Émettre cette pièce avec une TVA française serait fiscalement faux — ' +
  "l'émission est bloquée pour protéger ton intégrité fiscale, sans contournement possible.";

/** Garde d'émission — refuse toute pièce (devis→facture, facture directe, émission) pour un pro non-FR. */
export function internationalProEmissionGuard(customer: Customer): DomainResult<void> {
  if (customer.isProfessional() && customer.isInternational())
    return err({
      code: 'VALIDATION',
      field: 'customer',
      message: INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE,
    });
  return ok(undefined);
}
