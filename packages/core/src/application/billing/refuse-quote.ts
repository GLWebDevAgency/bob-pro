import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

export interface RefuseQuoteDeps {
  quotes: QuoteRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

export class RefuseQuote {
  constructor(private readonly deps: RefuseQuoteDeps) {}

  async execute(input: { quoteId: string }): Promise<Result<{ status: string }, AppError>> {
    const pre = await this.deps.quotes.findById(input.quoteId);
    if (!pre) return err(appNotFound('quote', input.quoteId));

    try {
      const status = await this.deps.uow.runInTransaction(async () => {
        const quote = await this.deps.quotes.lockById(input.quoteId);
        if (!quote) throw new TxDomainError({ code: 'VALIDATION', field: 'quote', message: 'Devis introuvable.' });

        const at = this.deps.clock.now();
        const refused = quote.refuse(at);
        if (!refused.ok) throw new TxDomainError(refused.error);

        await this.deps.quotes.save(quote);
        await this.deps.publicAccessTokens.revokeActiveFor({
          companyId: quote.companyId,
          resourceType: 'quote',
          resourceId: quote.id,
          scope: 'quote_signature',
          at,
        });
        return quote.status;
      });
      return ok({ status });
    } catch (e) {
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      throw e;
    }
  }
}
