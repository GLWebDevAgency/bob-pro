import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

export interface ExpireQuoteDeps {
  quotes: QuoteRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

function isPastValidity(validUntil: string | null, today: string): boolean {
  return validUntil !== null && validUntil < today;
}

function notExpiredError(): AppError {
  return appDomain({ code: 'VALIDATION', field: 'validUntil', message: 'Devis non expiré.' });
}

export class ExpireQuote {
  constructor(private readonly deps: ExpireQuoteDeps) {}

  async execute(input: { quoteId: string }): Promise<Result<{ status: string }, AppError>> {
    const pre = await this.deps.quotes.findById(input.quoteId);
    if (!pre) return err(appNotFound('quote', input.quoteId));
    if (pre.status !== 'expired' && !isPastValidity(pre.validUntil, this.deps.clock.today())) return err(notExpiredError());

    try {
      const status = await this.deps.uow.runInTransaction(async () => {
        const quote = await this.deps.quotes.lockById(input.quoteId);
        if (!quote) throw new TxDomainError({ code: 'VALIDATION', field: 'quote', message: 'Devis introuvable.' });

        const at = this.deps.clock.now();
        if (quote.status !== 'expired') {
          if (!isPastValidity(quote.validUntil, this.deps.clock.today())) {
            throw new TxDomainError({ code: 'VALIDATION', field: 'validUntil', message: 'Devis non expiré.' });
          }
          const expired = quote.markExpired(at);
          if (!expired.ok) throw new TxDomainError(expired.error);
          await this.deps.quotes.save(quote);
        }

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
