import { type Company } from '../company/company';
import { type Customer, type CustomerType } from '../customer/customer';

export interface EinvoiceProfile {
  // 'pa' = Plateforme Agréée (nouveau terme officiel remplaçant « PDP », cf. réforme 2026/2027).
  channel: 'pa' | 'chorus_pro' | 'ereporting';
  ereportingKind?: 'transactions' | 'paiement';
  scope?: 'domestic' | 'international';
  label: string;
  ready: boolean;
}

export type EinvoiceChannel = EinvoiceProfile['channel'];

/**
 * Canal e-invoicing par type de client (règle 2026/2027) : b2g → Chorus Pro ·
 * b2b → Plateforme Agréée · b2c → e-reporting. Source UNIQUE de la règle —
 * consommée par einvoiceFor (entités) et par les écrans (projections, fiche C13).
 */
export function einvoiceChannelFor(type: CustomerType): EinvoiceChannel {
  if (type === 'b2g') return 'chorus_pro';
  if (type === 'b2b') return 'pa';
  return 'ereporting';
}

export function einvoiceFor(customer: Customer, company: Company): EinvoiceProfile {
  const issuerReady = company.assertCanIssue().ok;
  const channel = einvoiceChannelFor(customer.type);
  if (channel === 'chorus_pro')
    return { channel, label: 'Client public · Chorus Pro', ready: issuerReady && !!customer.siren };
  if (channel === 'pa')
    return { channel, label: 'Facture electronique requise (Plateforme Agreee — PA)', ready: issuerReady && !!customer.siren };
  return {
    channel,
    ereportingKind: 'transactions',
    scope: customer.isInternational() ? 'international' : 'domestic',
    label: 'Vente a un particulier · e-reporting',
    ready: issuerReady,
  };
}
