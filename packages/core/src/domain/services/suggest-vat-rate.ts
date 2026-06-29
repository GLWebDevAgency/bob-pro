import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type VatRate, VAT_RATES } from '../billing/shared/vat-rate';
import { type LineCategory } from '../billing/shared/line-item';
import { type Company } from '../company/company';
import { type Customer } from '../customer/customer';

export interface SuggestVatInput {
  company: Company;
  customer: Customer;
  category: LineCategory;
  requestedRate?: number;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
}

export function suggestVatRate(input: SuggestVatInput): DomainResult<VatRate> {
  const { company, customer, context, requestedRate } = input;

  // 1. Franchise en base : 0 obligatoire.
  if (company.isVatFranchise()) {
    if (requestedRate !== undefined && requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'franchise_293B' });
    return ok(0);
  }
  // 2. Autoliquidation BTP B2B sous-traitance : 0 obligatoire.
  if (company.requiresAutoliquidation({ type: customer.type, isSubcontractingBtp: customer.isSubcontractingBtp })) {
    if (requestedRate !== undefined && requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'autoliquidation' });
    return ok(0);
  }
  // 3. Suggestion par defaut.
  let suggested: VatRate = 20;
  if (context?.energyRenovation) suggested = 5.5;
  else if (context?.housingOlderThan2y) suggested = 10;

  // 4. Surcharge utilisateur autorisee si dans l'ensemble ferme.
  if (requestedRate !== undefined) {
    if (!(VAT_RATES as readonly number[]).includes(requestedRate))
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'unknown' });
    return ok(requestedRate as VatRate);
  }
  return ok(suggested);
}
