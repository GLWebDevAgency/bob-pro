import {
  searchSalesDocumentsInMemory,
  suggestSalesDocumentsInMemory,
  type SalesDocumentSearchPiece,
  type SalesDocumentSearchPort,
  type SearchSalesDocumentsInput,
  type SearchSalesDocumentsResult,
  type SuggestSalesDocumentsInput,
  type SuggestSalesDocumentsResult,
} from '@bob/core';
import { InMemoryCustomerRepository, InMemoryQuoteRepository, InMemoryInvoiceRepository } from './in-memory';

/**
 * B9 — pendant en mémoire (mode démo/tests) de GET /documents/search et /documents/suggest.
 * Lit les MÊMES repos que le reste d'InMemoryPersistence (aucun état dupliqué) et délègue tout
 * le ranking/tri/pagination à searchSalesDocumentsInMemory (@bob/core, pur, testé isolément).
 *
 * Limite ASSUMÉE : l'agrégat Quote (domaine) n'a pas de date propre (contrairement à Invoice —
 * voir schema.prisma, Quote.createdAt n'existe qu'en base) ; les devis remontent donc ici avec
 * `date: null`, ce qui les exclut de toute plage de dates active — comportement honnête plutôt
 * que deviner une date, cohérent avec le chemin Postgres réel (cf. migration B9).
 */
export class InMemorySalesDocumentSearchRepository implements SalesDocumentSearchPort {
  constructor(
    private readonly quotes: InMemoryQuoteRepository,
    private readonly invoices: InMemoryInvoiceRepository,
    private readonly customers: InMemoryCustomerRepository,
  ) {}

  private async gather(companyId: string) {
    const [quotes, invoices, customers] = await Promise.all([
      this.quotes.listByCompany(companyId),
      this.invoices.listByCompany(companyId),
      this.customers.listByCompany(companyId),
    ]);
    const quotePieces: SalesDocumentSearchPiece[] = quotes.map((q) => ({
      id: q.id,
      number: q.number,
      customerId: q.customerId,
      status: q.status,
      date: null,
      totals: q.totals(),
      lines: q.lines.map((l) => ({ label: l.label })),
    }));
    const invoicePieces: SalesDocumentSearchPiece[] = invoices.map((i) => ({
      id: i.id,
      number: i.number,
      customerId: i.customerId,
      status: i.status,
      date: i.issuedAt,
      totals: i.totals(),
      lines: i.lines.map((l) => ({ label: l.label })),
    }));
    const customerRefs = customers.map((c) => ({ id: c.id, name: c.name }));
    return { quotePieces, invoicePieces, customerRefs };
  }

  async search(input: SearchSalesDocumentsInput & { companyId: string }): Promise<SearchSalesDocumentsResult> {
    const { quotePieces, invoicePieces, customerRefs } = await this.gather(input.companyId);
    return searchSalesDocumentsInMemory({
      ...input,
      customers: customerRefs,
      quotes: quotePieces,
      invoices: invoicePieces,
    });
  }

  async suggest(input: SuggestSalesDocumentsInput & { companyId: string }): Promise<SuggestSalesDocumentsResult> {
    const { quotePieces, invoicePieces, customerRefs } = await this.gather(input.companyId);
    return suggestSalesDocumentsInMemory({
      ...input,
      customers: customerRefs,
      quotes: quotePieces,
      invoices: invoicePieces,
    });
  }
}
