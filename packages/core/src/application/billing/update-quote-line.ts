import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type LineInput } from '../../domain/billing/shared/line-item';
import { type QuoteRepository } from '../ports/repositories';

export interface UpdateQuoteLineInput {
  quoteId: string;
  lineId: string;
  patch: Partial<Pick<LineInput, 'label' | 'qty' | 'unitPriceHT' | 'vatRate'>>;
}

export interface UpdateQuoteLineDeps {
  quotes: QuoteRepository;
}

/** R6 : édition ligne par ligne d'un devis BROUILLON (Quote.updateLine porte la garde assertDraft). */
export class UpdateQuoteLine {
  constructor(private readonly deps: UpdateQuoteLineDeps) {}

  async execute(input: UpdateQuoteLineInput): Promise<Result<{ status: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));
    const updated = quote.updateLine(input.lineId, input.patch);
    if (!updated.ok) return err(appDomain(updated.error));
    await this.deps.quotes.save(quote);
    return ok({ status: quote.status });
  }
}
