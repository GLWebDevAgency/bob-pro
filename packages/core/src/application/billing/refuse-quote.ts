import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository } from '../ports/repositories';
import { type ClockPort } from '../ports/services';

export class RefuseQuote {
  constructor(private readonly deps: { quotes: QuoteRepository; clock: ClockPort }) {}

  async execute(input: { quoteId: string }): Promise<Result<{ status: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));
    const refused = quote.refuse(this.deps.clock.now());
    if (!refused.ok) return err(appDomain(refused.error));
    await this.deps.quotes.save(quote);
    return ok({ status: quote.status });
  }
}
