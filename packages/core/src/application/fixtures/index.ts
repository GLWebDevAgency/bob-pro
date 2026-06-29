import { Company, type CompanyProps } from '../../domain/company/company';
import { Customer, type CustomerProps } from '../../domain/customer/customer';

/** Entreprise de seed du prototype : Mercier Plomberie (artisan plombier, réel simplifié, BTP décennale). */
export const MERCIER_PROPS: CompanyProps = {
  id: 'company-mercier',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  apeCode: '4322A',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  rcsOrRm: 'RM 92',
  address: { line1: '12 rue des Artisans', zip: '92000', city: 'Nanterre' },
  iban: 'FR7630006000011234567890189',
  bic: 'AGRIFRPP',
  decennale: { insurer: 'AXA', policyNo: 'DEC-2026-1182', coverage: 'France entiere', expiresAt: '2027-12-31' },
};

/** Les 6 clients du proto avec leurs scores (Durand 96 · Martin 62 · Sevres 78 · Lefevre 99 · Bernard 88 · Camping 50). */
export const CUSTOMER_PROPS: Omit<CustomerProps, 'companyId'>[] = [
  { id: 'cust-durand', type: 'b2b', name: 'Durand SARL', siren: '552081317', address: { line1: '3 av. du Chantier', zip: '92100', city: 'Boulogne' }, email: 'compta@durand.fr', score: 96, avgDelayDays: 2, outstanding: 0 },
  { id: 'cust-martin', type: 'b2c', name: 'M. Martin', address: { line1: '8 rue Oberkampf', zip: '75011', city: 'Paris' }, score: 62, avgDelayDays: 18, outstanding: 162800 },
  { id: 'cust-sevres', type: 'b2g', name: 'Mairie de Sevres', siren: '219200720', address: { line1: '54 Grande Rue', zip: '92310', city: 'Sevres' }, paymentTermsLabel: 'Mandat administratif', score: 78, avgDelayDays: 9, outstanding: 0 },
  { id: 'cust-lefevre', type: 'b2c', name: 'Mme Lefevre', address: { line1: '2 imp. des Lilas', zip: '92500', city: 'Rueil' }, score: 99, avgDelayDays: 0, outstanding: 0 },
  { id: 'cust-bernard', type: 'b2c', name: 'M. Bernard', address: { line1: '17 rue Verte', zip: '92800', city: 'Puteaux' }, score: 88, avgDelayDays: 4, outstanding: 45000 },
  { id: 'cust-camping', type: 'b2b', name: 'Camping Les Pins', siren: '440829834', address: { line1: 'Route de la Plage', zip: '85160', city: 'Saint-Jean-de-Monts' }, score: 50, avgDelayDays: 35, outstanding: 320000 },
];

/** Snapshot de trésorerie du proto (« le solde ment » : 6 820 € banque mais TVA + charges à venir). */
export const CASH_SNAPSHOT = { bankBalance: 682000, receivables: 300000, charges: 100000, vatDue: 124000 };

export function seedCompany(): Company {
  const r = Company.of(MERCIER_PROPS);
  if (!r.ok) throw new Error('Fixture company invalide');
  return r.value;
}

export function seedCustomers(): Customer[] {
  return CUSTOMER_PROPS.map((p) => {
    const r = Customer.of({ ...p, companyId: MERCIER_PROPS.id });
    if (!r.ok) throw new Error(`Fixture customer invalide: ${p.id}`);
    return r.value;
  });
}
