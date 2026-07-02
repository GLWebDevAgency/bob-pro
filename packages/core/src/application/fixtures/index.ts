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

/**
 * Les 6 clients du proto, portés depuis `DATA_CLIENTS` de Bob Pro.dc.html (lignes ~2326-2400) avec
 * leurs scores `SCORES` (Durand 96 · Martin 62 · Sèvres 78 · Lefèvre 99 · Bernard 88 · Camping 50).
 * Encours en CENTIMES fidèles au proto ; les ids `cust-*` restent stables (consommés par
 * api-client/api/mobile). avgDelayDays = « délai » proto (« — » → 0).
 */
export const CUSTOMER_PROPS: Omit<CustomerProps, 'companyId'>[] = [
  // Mme Durand — b2c, à jour (facture F-2026-104 de 1 180 € payée le 12 juin, acompte 590 €, devis signé 1 770 €).
  { id: 'cust-durand', type: 'b2c', name: 'Mme Durand', address: { line1: '12 rue des Lilas', zip: '92310', city: 'Sèvres' }, email: 'm.durand@email.fr', phone: '06 12 34 56 78', paymentTermsLabel: 'Paiement à réception', score: 96, avgDelayDays: 6, outstanding: 0 },
  // SARL Martin Rénovation — b2b, 2 480 € en retard dont F-2026-088 (1 240 €, en retard 9 j) ; paie à 22 j.
  { id: 'cust-martin', type: 'b2b', name: 'SARL Martin Rénovation', siren: '821503642', address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' }, email: 'contact@martin-renov.fr', phone: '01 45 22 10 90', paymentTermsLabel: 'Paiement à 30 jours', score: 62, avgDelayDays: 22, outstanding: 248000 },
  // Mairie de Sèvres — b2g, 1 850 € en attente (facture Chorus F-2026-090 transmise, marché entretien).
  { id: 'cust-sevres', type: 'b2g', name: 'Mairie de Sèvres', siren: '217504028', address: { line1: '54 Grande Rue', zip: '92310', city: 'Sèvres' }, email: 'marches@ville-sevres.fr', phone: '01 41 14 10 10', paymentTermsLabel: 'Mandat administratif', score: 78, avgDelayDays: 34, outstanding: 185000 },
  // Boulangerie Lefèvre — b2b, contrat entretien annuel, à jour (F-2026-077 et F-2026-055 payées).
  { id: 'cust-lefevre', type: 'b2b', name: 'Boulangerie Lefèvre', siren: '402118553', address: { line1: '3 place du Marché', zip: '92310', city: 'Sèvres' }, email: 'boulangerie.lefevre@email.fr', phone: '06 88 77 66 55', paymentTermsLabel: 'Paiement à 15 jours', score: 99, avgDelayDays: 11, outstanding: 0 },
  // M. Bernard — b2c, devis chauffe-eau 200 L (1 480 €) en attente, aucun encours.
  { id: 'cust-bernard', type: 'b2c', name: 'M. Bernard', address: { line1: '8 allée des Roses', zip: '92190', city: 'Meudon' }, email: 'p.bernard@email.fr', phone: '06 33 22 11 00', paymentTermsLabel: 'Paiement à réception', score: 88, avgDelayDays: 0, outstanding: 0 },
  // Camping Les Pins — b2b, nouveau client (0 €), facturation électronique à configurer.
  { id: 'cust-camping', type: 'b2b', name: 'Camping Les Pins', siren: '789220117', address: { line1: 'Route du Littoral', zip: '83700', city: 'Saint-Raphaël' }, email: 'contact@camping-lespins.fr', phone: '04 94 00 11 22', paymentTermsLabel: 'À définir', score: 50, avgDelayDays: 0, outstanding: 0 },
];

/** Snapshot de trésorerie du proto (« le solde ment » : 6 820 € banque mais TVA + charges à venir). */
export const CASH_SNAPSHOT = { bankBalance: 682000, receivables: 300000, charges: 100000, vatDue: 124000 };

/**
 * Écran « Aujourd'hui » du proto v2 (Bob Pro.dc.html) — montants en centimes.
 * Héros « Dispo réel aujourd'hui » = 4 950 € ; CASH = projections par horizon (7/30/60/90 j)
 * avec la note de Bob ; 3 priorités du briefing (relance Martin F-2026-088 · facture finale
 * Durand · conformité SIREN).
 */
export const TODAY_FIXTURE = {
  dispoCents: 495000,
  cashByHorizon: {
    7: { cents: 540000, note: 'Tranquille' },
    30: { cents: 495000, note: 'Ça passe' },
    60: { cents: 310000, note: 'Creux, surveille' },
    90: { cents: 720000, note: 'Ça repart' },
  },
  priorities: [
    {
      id: 'prio-relance-martin',
      kind: 'relance',
      title: 'Relancer SARL Martin Rénovation',
      docNumber: 'F-2026-088',
      amountCents: 124000,
      daysLate: 9,
    },
    {
      id: 'prio-facture-durand',
      kind: 'facture_finale',
      title: 'Créer la facture finale',
      customerName: 'Mme Durand',
      amountCents: 118000,
    },
    {
      id: 'prio-conformite-einvoice',
      kind: 'conformite',
      title: "Ta réception de factures n'est pas prête",
      badge: 'Facturation élec. 2026',
      cta: 'Faire le diagnostic',
    },
  ],
} as const;

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
