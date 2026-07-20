import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type LineInput } from '../../domain/billing/shared/line-item';
import { type QuoteRepository } from '../ports/repositories';
import { type UnitOfWorkPort } from '../ports/services';

export interface UpdateQuoteLineInput {
  quoteId: string;
  lineId: string;
  patch: Partial<Pick<LineInput, 'label' | 'qty' | 'unitPriceHT' | 'vatRate'>>;
}

export interface UpdateQuoteLineDeps {
  quotes: QuoteRepository;
  uow: UnitOfWorkPort;
}

class TxAppError extends Error {
  constructor(readonly appError: AppError) {
    super('update-quote-line-transaction');
  }
}

/** R6 : édition ligne par ligne d'un devis BROUILLON (Quote.updateLine porte la garde assertDraft). */
export class UpdateQuoteLine {
  constructor(private readonly deps: UpdateQuoteLineDeps) {}

  async execute(input: UpdateQuoteLineInput): Promise<Result<{ status: string }, AppError>> {
    try {
      const status = await this.deps.uow.runInTransaction(async () => {
        const quote = await this.deps.quotes.lockById(input.quoteId);
        if (!quote) throw new TxAppError(appNotFound('quote', input.quoteId));
        const updated = quote.updateLine(input.lineId, input.patch);
        if (!updated.ok) throw new TxAppError(appDomain(updated.error));
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
