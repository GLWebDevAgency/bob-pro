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

  async execute(input: { quoteId: string; mode?: 'deposit' | 'final' }): Promise<Result<{ invoiceId: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));

    const mode = input.mode ?? (quote.depositPct !== null ? 'deposit' : 'final');
    const created = Invoice.fromSignedQuote(quote, mode, this.deps.ids.newId());
    if (!created.ok) return err(appDomain(created.error));

    await this.deps.invoices.save(created.value);
    return ok({ invoiceId: created.value.id });
  }
}
