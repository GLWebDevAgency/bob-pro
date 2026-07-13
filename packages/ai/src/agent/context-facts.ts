/**
 * Libellés FRANÇAIS des tokens du domaine pour les FAITS contextuels (readContextEntity).
 * UNE SEULE VÉRITÉ pour les deux hôtes (mobile local + serveur) : sans ce présentateur,
 * chacun dupliquait la construction des faits et Bob PRONONÇAIT les tokens techniques
 * (« Statut : issued », « 2026-07-20 ») là où l'écran affiche « Émise » — parité UI↔Bob rompue.
 * Fail-safe : un token inconnu est rendu tel quel (jamais de crash, jamais d'invention).
 */

const INVOICE_STATUS: Readonly<Record<string, string>> = {
  draft: 'Brouillon',
  issued: 'Émise',
  partially_paid: 'Partiellement payée',
  paid: 'Payée',
  late: 'En retard',
  cancelled: 'Annulée',
};

const QUOTE_STATUS: Readonly<Record<string, string>> = {
  draft: 'Brouillon',
  sent: 'Envoyé',
  viewed: 'Consulté',
  signed: 'Signé',
  refused: 'Refusé',
  expired: 'Expiré',
};

const INVOICE_KIND: Readonly<Record<string, string>> = {
  final: 'Facture finale',
  deposit: 'Facture d’acompte',
  credit_note: 'Avoir',
  situation: 'Facture de situation',
};

const EXPENSE_STATUS: Readonly<Record<string, string>> = {
  to_pay: 'À payer',
  paid: 'Payée',
};

const EXPENSE_CATEGORY: Readonly<Record<string, string>> = {
  fournitures: 'Fournitures',
  materiel: 'Matériel',
  carburant: 'Carburant',
  repas: 'Repas',
  sous_traitance: 'Sous-traitance',
  autre: 'Autre',
};

const DOCUMENT_KIND: Readonly<Record<string, string>> = {
  invoice_pdf: 'Facture (PDF)',
  quote_pdf: 'Devis (PDF)',
  facturx_xml: 'Factur-X',
  expense_receipt: 'Justificatif de dépense',
  signed_quote: 'Devis signé',
  other: 'Autre document',
};

const DOCUMENT_STATUS: Readonly<Record<string, string>> = {
  active: 'Actif',
  deleted: 'Supprimé',
};

const CHANTIER_STATUS: Readonly<Record<string, string>> = {
  open: 'En cours',
  closed: 'Clôturé',
};

const CUSTOMER_TYPE: Readonly<Record<string, string>> = {
  b2c: 'Particulier',
  b2b: 'Professionnel',
  b2g: 'Marché public',
};

const ACCOUNTING_JOURNAL: Readonly<Record<string, string>> = {
  sales: 'Ventes',
  purchases: 'Achats',
  bank: 'Banque',
  misc: 'Opérations diverses',
};

const label = (table: Readonly<Record<string, string>>) => (token: string): string => table[token] ?? token;

export const invoiceStatusLabel = label(INVOICE_STATUS);
export const quoteStatusLabel = label(QUOTE_STATUS);
export const invoiceKindLabel = label(INVOICE_KIND);
export const expenseStatusLabel = label(EXPENSE_STATUS);
export const expenseCategoryLabel = label(EXPENSE_CATEGORY);
export const documentKindLabel = label(DOCUMENT_KIND);
export const documentStatusLabel = label(DOCUMENT_STATUS);
export const chantierStatusLabel = label(CHANTIER_STATUS);
export const customerTypeLabel = label(CUSTOMER_TYPE);
export const accountingJournalLabel = label(ACCOUNTING_JOURNAL);

/** Date ISO (YYYY-MM-DD…) → JJ/MM/AAAA, lisible à l'écran ET à l'oral. Entrée inattendue : telle quelle. */
export function frDateLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
