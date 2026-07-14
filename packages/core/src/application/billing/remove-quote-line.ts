import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository } from '../ports/repositories';

export interface RemoveQuoteLineInput {
  quoteId: string;
  lineId: string;
}

export interface RemoveQuoteLineDeps {
  quotes: QuoteRepository;
}

/** R6 : suppression d'une ligne d'un devis BROUILLON (Quote.removeLine porte la garde assertDraft). */
export class RemoveQuoteLine {
  constructor(private readonly deps: RemoveQuoteLineDeps) {}

  async execute(input: RemoveQuoteLineInput): Promise<Result<{ status: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));
    const removed = quote.removeLine(input.lineId);
    if (!removed.ok) return err(appDomain(removed.error));
    await this.deps.quotes.save(quote);
    return ok({ status: quote.status });
  }
}
