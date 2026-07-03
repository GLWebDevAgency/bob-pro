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
    const kind = mode === 'deposit' ? 'deposit' : 'final';
    if (quote.status !== 'signed')
      return err(appDomain({ code: 'VALIDATION', field: 'quote', message: 'Le devis doit etre signe.' }));

    const existing = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, kind);
    if (existing) return ok({ invoiceId: existing.id });

    // Facture FINALE après acompte : l'acompte déjà ÉMIS (fiscalement existant) est déduit
    // du net à payer — le flow reste corrélé de bout en bout (devis → acompte → solde).
    let depositDeduction: { amountCents: number; invoiceId: string } | undefined;
    if (mode === 'final') {
      const deposit = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, 'deposit');
      if (deposit && deposit.status !== 'draft' && deposit.status !== 'cancelled') {
        depositDeduction = { amountCents: deposit.totals().netToPay, invoiceId: deposit.id };
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
