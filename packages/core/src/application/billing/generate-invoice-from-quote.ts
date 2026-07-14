import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { type QuoteRepository, type InvoiceRepository } from '../ports/repositories';
import { type IdGeneratorPort } from '../ports/services';

export interface GenerateInvoiceDeps {
  quotes: QuoteRepository;
  invoices: InvoiceRepository;
  ids: IdGeneratorPort;
}

/** Génère la facture (acompte si depositPct, sinon finale) depuis un devis signé. */
export class GenerateInvoiceFromQuote {
  constructor(private readonly deps: GenerateInvoiceDeps) {}

  async execute(input: { quoteId: string; mode: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));

    const mode = input.mode;
    const kind: 'deposit' | 'final' = mode === 'deposit' ? 'deposit' : 'final';
    if (quote.status !== 'signed')
      return err(appDomain({ code: 'VALIDATION', field: 'quote', message: 'Le devis doit etre signe.' }));

    const existing = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, kind);
    if (existing) return ok({ invoiceId: existing.id });

    // Facture FINALE : TOUT ce qui a déjà été facturé sur ce devis (acompte ET situations
    // ÉMISES — situations successives BTP, A5) est déduit du net à payer. Le flow reste
    // corrélé de bout en bout : devis → acompte → situations → solde exact.
    let depositDeduction: { amountCents: number; invoiceId: string | null } | undefined;
    if (mode === 'final') {
      const companyInvoices = await this.deps.invoices.listByCompany(quote.companyId);
      // Un avoir TOTAL n'annule la déduction qu'une fois émis. Un brouillon d'avoir n'a aucun
      // effet fiscal ; l'identité source durable évite toute heuristique par devis ou montant.
      const totallyCreditedSourceIds = new Set(
        companyInvoices
          .filter(
            (invoice) =>
              invoice.kind === 'credit_note' &&
              invoice.status !== 'draft' &&
              invoice.status !== 'cancelled' &&
              invoice.creditNoteSource !== null,
          )
          .map((invoice) => invoice.creditNoteSource!.invoiceId),
      );
      const alreadyInvoiced = companyInvoices.filter(
        (i) =>
          i.parentQuoteId === quote.id &&
          (i.kind === 'deposit' || i.kind === 'situation') &&
          i.status !== 'draft' &&
          i.status !== 'cancelled' &&
          !totallyCreditedSourceIds.has(i.id),
      );
      const amountCents = alreadyInvoiced.reduce((sum, i) => sum + i.totals().netToPay, 0);
      if (amountCents > 0) {
        // Réf de nav : la pièce source si UNIQUE — composite (plusieurs pièces) sinon.
        depositDeduction = {
          amountCents,
          invoiceId: alreadyInvoiced.length === 1 ? (alreadyInvoiced[0]?.id ?? null) : null,
        };
      }
    }

    const created = Invoice.fromSignedQuote(quote, mode, this.deps.ids.newId(), depositDeduction ? { depositDeduction } : undefined);
    if (!created.ok) return err(appDomain(created.error));

    try {
      await this.deps.invoices.save(created.value);
    } catch (e) {
      const raced = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, kind);
      if (raced) return ok({ invoiceId: raced.id });
      throw e;
    }
    return ok({ invoiceId: created.value.id });
  }
}
