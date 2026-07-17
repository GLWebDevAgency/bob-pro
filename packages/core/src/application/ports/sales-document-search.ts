import type {
  SearchSalesDocumentsInput,
  SearchSalesDocumentsResult,
  SuggestSalesDocumentsInput,
  SuggestSalesDocumentsResult,
} from '../sales/search-sales-documents';

/**
 * B9 — port de recherche Devis & Factures (GET /documents/search, GET /documents/suggest).
 * Volontairement SÉPARÉ de QuoteRepository/InvoiceRepository : c'est un modèle de LECTURE
 * (CQRS léger) qui joint quotes/invoices/customers/line_items pour le classement pertinence +
 * date — reconstruire les agrégats Quote/Invoice pour chaque résultat serait à la fois inutile
 * (aucune règle métier à appliquer) et coûteux (N+1). L'implémentation Postgres (pg_trgm) vit
 * dans apps/api. Les fonctions pures de classement restent indépendantes de l'adapter et ne
 * constituent jamais une source de documents.
 */
export interface SalesDocumentSearchPort {
  search(input: SearchSalesDocumentsInput & { companyId: string }): Promise<SearchSalesDocumentsResult>;
  suggest(input: SuggestSalesDocumentsInput & { companyId: string }): Promise<SuggestSalesDocumentsResult>;
}
