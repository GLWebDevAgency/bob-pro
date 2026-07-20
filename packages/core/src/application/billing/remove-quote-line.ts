import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository } from '../ports/repositories';
import { type UnitOfWorkPort } from '../ports/services';

export interface RemoveQuoteLineInput {
  quoteId: string;
  lineId: string;
}

export interface RemoveQuoteLineDeps {
  quotes: QuoteRepository;
  uow: UnitOfWorkPort;
}

class TxAppError extends Error {
  constructor(readonly appError: AppError) {
    super('remove-quote-line-transaction');
  }
}

/** R6 : suppression d'une ligne d'un devis BROUILLON (Quote.removeLine porte la garde assertDraft). */
export class RemoveQuoteLine {
  constructor(private readonly deps: RemoveQuoteLineDeps) {}

  async execute(input: RemoveQuoteLineInput): Promise<Result<{ status: string }, AppError>> {
    try {
      const status = await this.deps.uow.runInTransaction(async () => {
        const quote = await this.deps.quotes.lockById(input.quoteId);
        if (!quote) throw new TxAppError(appNotFound('quote', input.quoteId));
        const removed = quote.removeLine(input.lineId);
        if (!removed.ok) throw new TxAppError(appDomain(removed.error));
        await this.deps.quotes.save(quote);
        return quote.status;
      });
      return ok({ status });
    } catch (cause) {
      if (cause instanceof TxAppError) return err(cause.appError);
      throw cause;
    }
  }
}
