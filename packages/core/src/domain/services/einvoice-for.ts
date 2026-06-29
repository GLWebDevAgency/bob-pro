import { type Company } from '../company/company';
import { type Customer } from '../customer/customer';

export interface EinvoiceProfile {
  channel: 'pdp' | 'chorus_pro' | 'ereporting';
  ereportingKind?: 'transactions' | 'paiement';
  scope?: 'domestic' | 'international';
  label: string;
  ready: boolean;
}

export function einvoiceFor(customer: Customer, company: Company): EinvoiceProfile {
  const issuerReady = company.assertCanIssue().ok;
  if (customer.type === 'b2g')
    return { channel: 'chorus_pro', label: 'Client public · Chorus Pro', ready: issuerReady && !!customer.siren };
  if (customer.type === 'b2b')
    return { channel: 'pdp', label: 'Facture electronique requise (PDP)', ready: issuerReady && !!customer.siren };
  return {
    channel: 'ereporting',
    ereportingKind: 'transactions',
    scope: customer.isInternational() ? 'international' : 'domestic',
    label: 'Vente a un particulier · e-reporting',
    ready: issuerReady,
  };
}
