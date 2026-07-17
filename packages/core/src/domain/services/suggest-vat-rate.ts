import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type VatRate, VAT_RATES } from '../billing/shared/vat-rate';
import { type LineCategory } from '../billing/shared/line-item';
import { type Company } from '../company/company';
import { type Customer } from '../customer/customer';

export interface SuggestVatInput {
  company: Company;
  customer: Customer;
  category: LineCategory;
  /** Taux confirmé pour cette pièce. Requis par TypeScript ; la garde runtime protège
   * aussi les entrées JSON/non typées. */
  requestedRate: number;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
}

export function suggestVatRate(input: SuggestVatInput): DomainResult<VatRate> {
  const { company, customer, context, requestedRate } = input;

  // La frontière de persistance doit toujours transmettre le taux explicitement confirmé.
  // Ni le métier ni un contexte partiel ne valent consentement fiscal.
  if (requestedRate === undefined) {
    return err({
      code: 'VALIDATION',
      field: 'vatRate',
      message: 'Confirme le taux de TVA avant de créer la pièce.',
    });
  }

  // 1. Franchise en base : 0 obligatoire.
  if (company.isVatFranchise()) {
    if (requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'franchise_293B' });
    return ok(0);
  }
  // 2. Autoliquidation BTP B2B sous-traitance : 0 obligatoire.
  if (company.requiresAutoliquidation({ type: customer.type, isSubcontractingBtp: customer.isSubcontractingBtp })) {
    if (requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'autoliquidation' });
    return ok(0);
  }
  // 3. Taux choisi explicitement, dans l'ensemble fermé. Le taux zéro n'est autorisé
  // que par les deux règles déterministes traitées plus haut.
  if (!(VAT_RATES as readonly number[]).includes(requestedRate) || requestedRate === 0)
    return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'unknown' });

  // Les taux travaux exigent le contexte correspondant : le taux ne fabrique jamais en
  // silence l'éligibilité du logement.
  if (requestedRate === 10 && context?.housingOlderThan2y !== true)
    return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'unknown' });
  if (
    requestedRate === 5.5
    && (context?.housingOlderThan2y !== true || context.energyRenovation !== true)
  )
    return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'unknown' });

  return ok(requestedRate as VatRate);
}
