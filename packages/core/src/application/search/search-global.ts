import { type Totals } from '../../domain/billing/shared/totals';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus, type QuoteStatus } from '../../domain/billing/shared/state-machines';
import { normalizeSupplierName } from '../documents/derive-vault-view';
import { searchVault } from '../documents/search-vault';
import { type VaultDocumentData } from '../documents/derive-vault-view';

/**
 * Recherche GLOBALE (A7) — un seul use case pur pour l'écran /recherche ET pour Bob
 * (« retrouve la facture de la mairie ») : clients par nom, pièces par numéro OU par nom
 * de client, documents via searchVault (nom de fichier + tags — source unique C14).
 * Insensible aux accents/casse (normalizeSupplierName). Aucune I/O ; requête vide → vide.
 */

export interface GlobalSearchCustomer {
  id: string;
  name: string;
  type: 'b2c' | 'b2b' | 'b2g';
}

export interface GlobalSearchInvoiceData {
  id: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string | null;
  customerId: string;
  totals: Totals;
}

export interface GlobalSearchQuoteData {
  id: string;
  status: QuoteStatus;
  number: string | null;
  customerId: string;
  totals: Totals;
}

export interface GlobalSearchInput {
  query: string;
  customers: readonly GlobalSearchCustomer[];
  invoices: readonly GlobalSearchInvoiceData[];
  quotes: readonly GlobalSearchQuoteData[];
  documents: readonly VaultDocumentData[];
}

export interface GlobalPieceHit {
  /** Route de destination : facture ou devis. */
  source: 'invoice' | 'quote';
  id: string;
  number: string | null;
  customerName: string;
  /** Ce que la pièce vaut à l'écran : net à payer (facture) / TTC (devis). */
  amountCents: number;
}

export interface GlobalSearchResult {
  customers: GlobalSearchCustomer[];
  pieces: GlobalPieceHit[];
  documents: VaultDocumentData[];
  totalCount: number;
}

const EMPTY: GlobalSearchResult = { customers: [], pieces: [], documents: [], totalCount: 0 };

export function searchGlobal(input: GlobalSearchInput): GlobalSearchResult {
  const q = normalizeSupplierName(input.query);
  if (q.length === 0) return EMPTY;

  // Clients : préfixe d'abord (tri stable), puis inclusion.
  const customers = input.customers
    .filter((c) => normalizeSupplierName(c.name).includes(q))
    .sort((a, b) => {
      const aStarts = normalizeSupplierName(a.name).startsWith(q) ? 0 : 1;
      const bStarts = normalizeSupplierName(b.name).startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    });

  const nameById = new Map(input.customers.map((c) => [c.id, c.name]));
  const matchesPiece = (number: string | null, customerId: string): boolean => {
    if (number !== null && normalizeSupplierName(number).includes(q)) return true;
    const name = nameById.get(customerId);
    return name !== undefined && normalizeSupplierName(name).includes(q);
  };

  // Pièces : les numéros qui matchent d'abord (une recherche « F-2026 » vise la pièce),
  // brouillons sans numéro trouvables par le nom du client.
  const pieces: GlobalPieceHit[] = [
    ...input.invoices
      .filter((i) => matchesPiece(i.number, i.customerId))
      .map((i) => ({
        source: 'invoice' as const,
        id: i.id,
        number: i.number,
        customerName: nameById.get(i.customerId) ?? '',
        amountCents: i.totals.netToPay,
      })),
    ...input.quotes
      .filter((quote) => matchesPiece(quote.number, quote.customerId))
      .map((quote) => ({
        source: 'quote' as const,
        id: quote.id,
        number: quote.number,
        customerName: nameById.get(quote.customerId) ?? '',
        amountCents: quote.totals.ttc,
      })),
  ].sort((a, b) => {
    const aByNumber = a.number !== null && normalizeSupplierName(a.number).includes(q) ? 0 : 1;
    const bByNumber = b.number !== null && normalizeSupplierName(b.number).includes(q) ? 0 : 1;
    return aByNumber - bByNumber || (b.number ?? '').localeCompare(a.number ?? '');
  });

  // Documents : la MÊME recherche que le coffre (fichier + tags) — source unique C14.
  const documents = searchVault(input.documents, input.query);

  return { customers, pieces, documents, totalCount: customers.length + pieces.length + documents.length };
}
