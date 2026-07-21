import { Company, type CompanyProps } from '../../domain/company/company';
import { Customer, type CustomerProps } from '../../domain/customer/customer';
import { Expense, type ExpenseProps } from '../../domain/expense/expense';
import { type DateOnly, type Instant } from '../../shared-kernel/time';
import { type DocumentView } from '../documents/document-view';
import { buildDocumentStorageKey } from '../documents/storage-key';

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
  tvaIntracom: 'FR44732829320',
  rcsOrRm: 'RM 92',
  address: { line1: '12 rue des Artisans', zip: '92000', city: 'Nanterre' },
  iban: 'FR7630006000011234567890189',
  bic: 'AGRIFRPP',
  decennale: { insurer: 'AXA', policyNo: 'DEC-2026-1182', coverage: 'France entiere', expiresAt: '2027-12-31' },
};

/**
 * Les 6 identités clients du mode de démonstration. Les métriques financières ne vivent jamais
 * dans une fiche client : même en démo elles sont dérivées des factures et paiements seedés.
 */
export const CUSTOMER_PROPS: Omit<CustomerProps, 'companyId'>[] = [
  // Mme Durand — b2c, à jour (facture F-2026-104 de 1 180 € payée le 12 juin, acompte 590 €, devis signé 1 770 €).
  { id: 'cust-durand', type: 'b2c', name: 'Mme Durand', address: { line1: '12 rue des Lilas', zip: '92310', city: 'Sèvres' }, email: 'm.durand@email.fr', phone: '06 12 34 56 78', paymentTermsLabel: 'Paiement à réception' },
  // SARL Martin Rénovation — b2b, 2 480 € en retard dont F-2026-088 (1 240 €, en retard 9 j) ; paie à 22 j.
  { id: 'cust-martin', type: 'b2b', name: 'SARL Martin Rénovation', siren: '821503646', tvaIntracom: 'FR37821503646', address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' }, email: 'contact@martin-renov.fr', phone: '01 45 22 10 90', paymentTermsLabel: 'Paiement à 30 jours' },
  // Mairie de Sèvres — b2g, 1 850 € en attente (facture Chorus F-2026-090 transmise, marché entretien).
  { id: 'cust-sevres', type: 'b2g', name: 'Mairie de Sèvres', siren: '217504026', address: { line1: '54 Grande Rue', zip: '92310', city: 'Sèvres' }, email: 'marches@ville-sevres.fr', phone: '01 41 14 10 10', paymentTermsLabel: 'Mandat administratif' },
  // Boulangerie Lefèvre — b2b, contrat entretien annuel, à jour (F-2026-077 et F-2026-055 payées).
  { id: 'cust-lefevre', type: 'b2b', name: 'Boulangerie Lefèvre', siren: '402118558', address: { line1: '3 place du Marché', zip: '92310', city: 'Sèvres' }, email: 'boulangerie.lefevre@email.fr', phone: '06 88 77 66 55', paymentTermsLabel: 'Paiement à 15 jours' },
  // M. Bernard — b2c, devis chauffe-eau 200 L (1 480 €) en attente, aucun encours.
  { id: 'cust-bernard', type: 'b2c', name: 'M. Bernard', address: { line1: '8 allée des Roses', zip: '92190', city: 'Meudon' }, email: 'p.bernard@email.fr', phone: '06 33 22 11 00', paymentTermsLabel: 'Paiement à réception' },
  // Camping Les Pins — b2b, nouveau client (0 €), facturation électronique à configurer.
  { id: 'cust-camping', type: 'b2b', name: 'Camping Les Pins', siren: '789220118', address: { line1: 'Route du Littoral', zip: '83700', city: 'Saint-Raphaël' }, email: 'contact@camping-lespins.fr', phone: '04 94 00 11 22', paymentTermsLabel: 'À définir' },
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

// ── Coffre-fort de démo (claim C14, amendement A1-C14) ───────────────────────
// Le mode démo légitime = le client démo (LocalBobClient), jamais l'écran :
// ces seeds exercent le flux réel scan → à valider → « Classer là » → dossier Achats.

/** Dépenses fournisseurs du proto (mémoire fournisseurs ×3, achats du mois, TVA récup.). */
export function seedExpenses(companyId: string, today: DateOnly): Expense[] {
  const month = today.slice(0, 7);
  const year = Number(today.slice(0, 4));
  const monthNum = Number(today.slice(5, 7));
  const prevMonth =
    monthNum === 1 ? `${year - 1}-12` : `${year}-${String(monthNum - 1).padStart(2, '0')}`;
  const specs: Omit<ExpenseProps, 'companyId'>[] = [
    // Leroy Merlin — la dépense OCR rapprochée du reçu « à valider » (proto : 184,90 € / TVA 30,82 €).
    { id: 'local-expense-leroy', supplierName: 'Leroy Merlin', supplierSiren: null, documentDate: today, totalTtcCents: 18490, totalHtCents: 15408, vatCents: 3082, vatRatePct: 20, category: 'fournitures', status: 'to_pay', source: 'ocr' },
    // Cedeo — robinetterie, reçu déjà classé (dossier Achats).
    { id: 'local-expense-cedeo', supplierName: 'Cedeo', supplierSiren: null, documentDate: `${month}-01`, totalTtcCents: 34200, totalHtCents: 28500, vatCents: 5700, vatRatePct: 20, category: 'materiel', status: 'paid', paymentEvidence: { paidOn: `${month}-01`, method: 'transfer', reference: 'FIXTURE-CEDEO', proofDocumentId: null }, source: 'ocr' },
    // Point P — matériaux, mois précédent (mémoire fournisseurs sans peser sur le mois courant).
    { id: 'local-expense-pointp', supplierName: 'Point P', supplierSiren: null, documentDate: `${prevMonth}-14`, totalTtcCents: 52040, totalHtCents: 43367, vatCents: 8673, vatRatePct: 20, category: 'materiel', status: 'paid', paymentEvidence: { paidOn: `${prevMonth}-14`, method: 'card', reference: 'FIXTURE-POINTP', proofDocumentId: null }, source: 'manual' },
  ];
  const recorded = specs.map((spec) => {
    const r = Expense.record({ ...spec, companyId }, { today });
    if (!r.ok) throw new Error(`Fixture expense invalide: ${spec.id}`);
    return r.value;
  });
  // Brico Dépôt — ligne HISTORIQUE « payée sans preuve » (paymentEvidenceLegacyUnverified de la
  // migration preuves) : rehydrate volontaire — Expense.record refuse cet état à la saisie.
  // Elle exerce le parcours de régularisation (badge « Payée — à justifier » → sheet → écriture).
  recorded.push(Expense.rehydrate({
    id: 'local-expense-brico',
    companyId,
    supplierName: 'Brico Dépôt',
    supplierSiren: null,
    documentDate: `${prevMonth}-03`,
    totalTtcCents: 9860,
    totalHtCents: 8217,
    vatCents: 1643,
    vatRatePct: 20,
    category: 'fournitures',
    status: 'paid',
    paymentEvidence: null,
    source: 'manual',
  }));
  return recorded;
}

const SEED_DOC_SHA = 'a'.repeat(64);

/**
 * Documents de démo : reçu Leroy Merlin scanné NON CLASSÉ (carte « À valider », créé il y a
 * 2 min), reçu Cedeo lié à sa dépense (dossier Achats), facture PDF du mois (Comptable + 1 vente).
 */
export function seedVaultDocuments(companyId: string, now: Instant, today: DateOnly): DocumentView[] {
  const month = today.slice(0, 7);
  const retentionUntil = `${Number(today.slice(0, 4)) + 10}${today.slice(4)}`;
  const mk = (input: {
    id: string;
    kind: DocumentView['kind'];
    origin: DocumentView['origin'];
    filename: string;
    mimeType: string;
    byteSize: number;
    linkedEntityType: DocumentView['linkedEntityType'];
    linkedEntityId: string | null;
    documentDate: DateOnly;
    createdAt: Instant;
    tags?: string[];
  }): DocumentView => ({
    id: input.id,
    companyId,
    kind: input.kind,
    origin: input.origin,
    status: 'active',
    filename: input.filename,
    displayName: input.filename,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
    sha256: SEED_DOC_SHA,
    storageKey: buildDocumentStorageKey({
      companyId,
      documentId: input.id,
      version: 1,
      sha256: SEED_DOC_SHA,
      filename: input.filename,
      mimeType: input.mimeType,
    }),
    folderId: null,
    revision: 1,
    version: 1,
    linkedEntityType: input.linkedEntityType,
    linkedEntityId: input.linkedEntityId,
    documentDate: input.documentDate,
    issuedAt: null,
    createdAt: input.createdAt,
    createdBy: 'local',
    retentionUntil,
    tags: input.tags ?? [],
    // Démo fidèle au réel : aucun document seedé n'a encore été confirmé par l'artisan.
    reviewedAt: null,
  });
  const twoMinutesAgo = new Date(Date.parse(now) - 120_000).toISOString();
  return [
    mk({ id: 'seed-doc-leroy', kind: 'expense_receipt', origin: 'ocr', filename: 'recu-leroy-merlin.jpg', mimeType: 'image/jpeg', byteSize: 482_000, linkedEntityType: null, linkedEntityId: null, documentDate: today, createdAt: twoMinutesAgo, tags: ['fournitures', 'leroy-merlin'] }),
    mk({ id: 'seed-doc-cedeo', kind: 'expense_receipt', origin: 'ocr', filename: 'recu-cedeo-robinetterie.jpg', mimeType: 'image/jpeg', byteSize: 391_000, linkedEntityType: 'expense', linkedEntityId: 'local-expense-cedeo', documentDate: `${month}-01`, createdAt: now, tags: ['materiel', 'cedeo', 'robinetterie'] }),
    mk({ id: 'seed-doc-f104', kind: 'invoice_pdf', origin: 'generated', filename: 'facture-F-2026-104.pdf', mimeType: 'application/pdf', byteSize: 128_000, linkedEntityType: null, linkedEntityId: null, documentDate: `${month}-01`, createdAt: now }),
  ];
}
