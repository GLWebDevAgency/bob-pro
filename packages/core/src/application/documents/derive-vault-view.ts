import { type DateOnly, type Instant } from '../../shared-kernel/time';
import { type Totals } from '../../domain/billing/shared/totals';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus } from '../../domain/billing/shared/state-machines';
import { einvoiceChannelFor, type EinvoiceChannel } from '../../domain/services/einvoice-for';
import {
  type DocumentKind,
  type DocumentLinkedEntityType,
  type DocumentOrigin,
  type DocumentStatus,
} from '../../domain/document/document';

/**
 * Use case pur « coffre-fort » (claim C14) : projections RÉELLES (documents / dépenses /
 * factures / clients tels que servis par l'api-client) → vue de l'écran Documents ET
 * matière première pour Bob (parité d'actions : même dérivation pour l'UI et l'agent).
 * Aucune I/O, aucun repli fixtures : sans données, chaque section rend son état vide.
 */

// ── Entrées (projections minimales, structurellement compatibles avec les vues api-client) ──

export interface VaultDocumentData {
  id: string;
  kind: DocumentKind;
  origin: DocumentOrigin;
  status: DocumentStatus;
  filename: string;
  linkedEntityType: DocumentLinkedEntityType | null;
  linkedEntityId: string | null;
  documentDate: DateOnly | null;
  createdAt: Instant;
  /** Tags persistés (#11) — participent à la recherche du coffre. */
  tags?: readonly string[];
}

export interface VaultExpenseData {
  id: string;
  supplierName: string;
  documentDate: DateOnly;
  totalTtcCents: number;
  vatCents: number | null;
}

export interface VaultInvoiceData {
  id: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string | null;
  customerId: string;
  totals: Totals;
}

export interface VaultCustomerData {
  id: string;
  name: string;
  type: 'b2c' | 'b2b' | 'b2g';
}

export interface DeriveVaultViewInput {
  documents: readonly VaultDocumentData[];
  expenses: readonly VaultExpenseData[];
  invoices: readonly VaultInvoiceData[];
  customers: readonly VaultCustomerData[];
  today: DateOnly;
}

// ── Sortie (vue consommée par l'écran Documents) ──

/** Document scanné (OCR) pas encore classé — la carte « À valider ». */
export interface VaultPendingDoc {
  id: string;
  filename: string;
  receivedAt: Instant;
  /** Dépense dont le fournisseur se retrouve dans le nom de fichier — chips métriques réelles
   *  ET cible du « Classer là » (ClassifyDocument, A1-C14). */
  matchedExpense: {
    id: string;
    supplierName: string;
    totalTtcCents: number;
    vatCents: number | null;
    documentDate: DateOnly;
  } | null;
}

/** Les 6 dossiers du proto (DOCS_FOLDERS). L'ordre est celui de la grille. */
export type VaultFolderKey = 'chantiers' | 'achats' | 'assurances' | 'fiscal' | 'banque' | 'comptable';
export const VAULT_FOLDER_KEYS: readonly VaultFolderKey[] = [
  'chantiers',
  'achats',
  'assurances',
  'fiscal',
  'banque',
  'comptable',
];

export interface VaultFolder {
  key: VaultFolderKey;
  count: number;
}

export interface VaultMonthSummary {
  /** Mois de `today` au format AAAA-MM (libellé humain côté i18n). */
  month: string;
  /** Ventes du mois = documents de facturation datés du mois (dédupliqués par facture liée). */
  salesCount: number;
  /** Achats du mois = dépenses datées du mois. */
  purchasesCount: number;
  /** TVA récupérable = somme des vatCents des dépenses du mois — null si aucune TVA connue. */
  vatRecoverableCents: number | null;
  /** Dépenses du mois sans justificatif lié (reçu scanné manquant). */
  missingReceiptsCount: number;
}

export interface VaultRecentInvoice {
  id: string;
  number: string;
  customerName: string;
  customerType: VaultCustomerData['type'];
  kind: InvoiceKind;
  /** Canal e-facture — source unique : einvoiceChannelFor (domain/services, zéro duplication). */
  channel: EinvoiceChannel;
  ttcCents: number;
}

export interface VaultSupplierMemory {
  /** Fournisseurs distincts (normalisés) vus dans les dépenses. */
  count: number;
  /** Jusqu'à 3 noms d'exemple, dans l'ordre de première apparition. */
  examples: readonly string[];
}

export interface VaultView {
  toValidate: readonly VaultPendingDoc[];
  folders: readonly VaultFolder[];
  monthSummary: VaultMonthSummary;
  recentInvoices: readonly VaultRecentInvoice[];
  supplierMemory: VaultSupplierMemory;
  /** Documents actifs du coffre (footer « {n} documents »). */
  totalCount: number;
}

// ── Règles ──

const BILLING_KINDS: ReadonlySet<DocumentKind> = new Set([
  'invoice_pdf',
  'facturx_xml',
  'quote_pdf',
  'signed_quote',
]);
const INVOICE_DOC_KINDS: ReadonlySet<DocumentKind> = new Set(['invoice_pdf', 'facturx_xml']);

export function normalizeSupplierName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Nom de fichier normalisé pour le rapprochement : tirets/underscores/points → espaces. */
export function normalizeFilename(filename: string): string {
  return normalizeSupplierName(filename.replace(/[-_./]/g, ' '));
}

/**
 * Dossier d'un document — mapping v1 documenté (le modèle n'a pas encore de catégorie de
 * dossier) : chantier → Chantiers · dépense/reçu → Achats · pièce de facturation → Comptable.
 * Assurances / Fiscal & social / Banque restent à 0 tant que la catégorie n'existe pas.
 */
export function vaultFolderOf(doc: Pick<VaultDocumentData, 'kind' | 'linkedEntityType'>): VaultFolderKey | null {
  if (doc.linkedEntityType === 'chantier') return 'chantiers';
  if (doc.linkedEntityType === 'expense' || doc.kind === 'expense_receipt') return 'achats';
  if (BILLING_KINDS.has(doc.kind)) return 'comptable';
  return null;
}

function docMonthDate(doc: VaultDocumentData): string {
  return doc.documentDate ?? doc.createdAt.slice(0, 10);
}

function deriveToValidate(
  documents: readonly VaultDocumentData[],
  expenses: readonly VaultExpenseData[],
): VaultPendingDoc[] {
  return documents
    .filter((d) => d.origin === 'ocr' && d.linkedEntityType === null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((d) => {
      const filename = normalizeFilename(d.filename);
      const matched = expenses.find(
        (e) => normalizeSupplierName(e.supplierName).length > 0 && filename.includes(normalizeSupplierName(e.supplierName)),
      );
      return {
        id: d.id,
        filename: d.filename,
        receivedAt: d.createdAt,
        matchedExpense: matched
          ? {
              id: matched.id,
              supplierName: matched.supplierName,
              totalTtcCents: matched.totalTtcCents,
              vatCents: matched.vatCents,
              documentDate: matched.documentDate,
            }
          : null,
      };
    });
}

function deriveFolders(documents: readonly VaultDocumentData[]): VaultFolder[] {
  const counts = new Map<VaultFolderKey, number>(VAULT_FOLDER_KEYS.map((k) => [k, 0]));
  for (const doc of documents) {
    const key = vaultFolderOf(doc);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return VAULT_FOLDER_KEYS.map((key) => ({ key, count: counts.get(key) ?? 0 }));
}

function deriveMonthSummary(
  documents: readonly VaultDocumentData[],
  expenses: readonly VaultExpenseData[],
  today: DateOnly,
): VaultMonthSummary {
  const month = today.slice(0, 7);

  // Ventes = docs facture du mois ; une facture liée compte UNE fois (PDF + Factur-X = 1 vente).
  const linkedInvoiceIds = new Set<string>();
  let unlinkedInvoiceDocs = 0;
  for (const doc of documents) {
    if (!INVOICE_DOC_KINDS.has(doc.kind)) continue;
    if (!docMonthDate(doc).startsWith(month)) continue;
    if (doc.linkedEntityType === 'invoice' && doc.linkedEntityId !== null) linkedInvoiceIds.add(doc.linkedEntityId);
    else unlinkedInvoiceDocs += 1;
  }

  const monthExpenses = expenses.filter((e) => e.documentDate.startsWith(month));
  const vatKnown = monthExpenses.filter((e) => e.vatCents !== null);
  const receiptsByExpense = new Set(
    documents.filter((d) => d.linkedEntityType === 'expense' && d.linkedEntityId !== null).map((d) => d.linkedEntityId),
  );

  return {
    month,
    salesCount: linkedInvoiceIds.size + unlinkedInvoiceDocs,
    purchasesCount: monthExpenses.length,
    vatRecoverableCents: vatKnown.length > 0 ? vatKnown.reduce((sum, e) => sum + (e.vatCents ?? 0), 0) : null,
    missingReceiptsCount: monthExpenses.filter((e) => !receiptsByExpense.has(e.id)).length,
  };
}

/** Suffixe numérique d'un numéro de pièce (F-2026-118 → 118) — tri chronologique sans Intl. */
function numberRank(number: string): number {
  const m = /(\d+)\s*$/.exec(number);
  return m?.[1] !== undefined ? Number(m[1]) : 0;
}

function deriveRecentInvoices(
  invoices: readonly VaultInvoiceData[],
  customers: readonly VaultCustomerData[],
  limit: number,
): VaultRecentInvoice[] {
  const byId = new Map(customers.map((c) => [c.id, c]));
  return invoices
    .filter((i): i is VaultInvoiceData & { number: string } => i.number !== null && i.status !== 'draft')
    .sort((a, b) => numberRank(b.number) - numberRank(a.number) || (a.number < b.number ? 1 : -1))
    .slice(0, limit)
    .map((i) => {
      const customer = byId.get(i.customerId);
      return {
        id: i.id,
        number: i.number,
        customerName: customer?.name ?? '',
        customerType: customer?.type ?? 'b2c',
        kind: i.kind,
        channel: einvoiceChannelFor(customer?.type ?? 'b2c'),
        ttcCents: i.totals.netToPay,
      };
    });
}

function deriveSupplierMemory(expenses: readonly VaultExpenseData[]): VaultSupplierMemory {
  const seen = new Map<string, string>();
  for (const e of expenses) {
    const key = normalizeSupplierName(e.supplierName);
    if (key.length === 0 || seen.has(key)) continue;
    seen.set(key, e.supplierName.trim());
  }
  return { count: seen.size, examples: [...seen.values()].slice(0, 3) };
}

/** Nombre de « factures récentes » affichées (proto : 2 rangées). */
export const VAULT_RECENT_INVOICES_LIMIT = 2;

export function deriveVaultView(input: DeriveVaultViewInput): VaultView {
  const documents = input.documents.filter((d) => d.status === 'active');
  return {
    toValidate: deriveToValidate(documents, input.expenses),
    folders: deriveFolders(documents),
    monthSummary: deriveMonthSummary(documents, input.expenses, input.today),
    recentInvoices: deriveRecentInvoices(input.invoices, input.customers, VAULT_RECENT_INVOICES_LIMIT),
    supplierMemory: deriveSupplierMemory(input.expenses),
    totalCount: documents.length,
  };
}
