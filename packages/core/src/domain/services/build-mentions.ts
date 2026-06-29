import { type Company } from '../company/company';
import { type Customer } from '../customer/customer';

export interface BuildMentionsInput {
  company: Company;
  customer: Customer;
  kind: 'quote' | 'invoice';
  asOf: string;
  validUntilDays?: number;
}

export function buildMentions(input: BuildMentionsInput): string[] {
  const { company, customer, kind } = input;
  const m: string[] = [];
  m.push(`${company.name} — ${company.address.line1}, ${company.address.zip} ${company.address.city}`);
  if (company.rcsOrRm) m.push(company.rcsOrRm);

  if (company.isVatFranchise()) {
    m.push('TVA non applicable, art. 293 B du CGI');
  }
  if (company.requiresAutoliquidation({ type: customer.type, isSubcontractingBtp: customer.isSubcontractingBtp })) {
    m.push('Autoliquidation de la TVA (sous-traitance BTP, art. 283-2 nonies du CGI)');
  }

  m.push(
    'En cas de retard de paiement : penalites au taux legal en vigueur et indemnite forfaitaire de recouvrement de 40 € (art. L441-10 du code de commerce).',
  );

  if (company.isBtp() && company.decennale) {
    const d = company.decennale;
    m.push(`Assurance decennale : ${d.insurer}, police n°${d.policyNo}, couverture ${d.coverage}.`);
  }

  if (kind === 'quote') {
    m.push('Devis gratuit.');
    if (input.validUntilDays) m.push(`Devis valable ${input.validUntilDays} jours.`);
    m.push('Bon pour accord (date + signature) :');
  }
  return m;
}
