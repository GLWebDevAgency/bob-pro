import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';

const SIGNATURE_TOKEN_TTL_DAYS = 30;

function addDays(isoInstant: string, days: number): string {
  const d = new Date(isoInstant);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export interface CreateQuoteSignatureTokenDeps {
  quotes: QuoteRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

export class CreateQuoteSignatureToken {
  constructor(private readonly deps: CreateQuoteSignatureTokenDeps) {}

  async execute(input: { quoteId: string }): Promise<Result<{ token: string; expiresAt: string }, AppError>> {
    return this.deps.uow.runInTransaction(async () => {
      // Le même verrou de ligne est pris par SignQuote. Une rotation commencée avant/après une
      // signature est donc totalement ordonnée : jamais de lecture `sent` périmée suivie d'un
      // nouveau grant créé après le commit `signed`.
      const quote = await this.deps.quotes.lockById(input.quoteId);
      if (!quote) return err(appNotFound('quote', input.quoteId));
      if (!quote.number)
        return err(appDomain({ code: 'VALIDATION', field: 'quote', message: 'Devis non numéroté : lien de signature impossible.' }));
      if (quote.status !== 'sent' && quote.status !== 'viewed')
        return err(appDomain({ code: 'INVALID_TRANSITION', from: quote.status, to: 'signed' }));

      const at = this.deps.clock.now();
      // Validité du devis = calendrier MÉTIER Europe/Paris (même correction que ExpireQuote).
      if (quote.validUntil !== null && quote.validUntil < parisDateOnly(at))
        return err(appDomain({ code: 'VALIDATION', field: 'validUntil', message: 'Devis expiré : lien de signature impossible.' }));

      const expiresAt = addDays(at, SIGNATURE_TOKEN_TTL_DAYS);
      await this.deps.publicAccessTokens.revokeActiveFor({
        companyId: quote.companyId,
        resourceType: 'quote',
        resourceId: quote.id,
        scope: 'quote_signature',
        at,
      });
      const created = await this.deps.publicAccessTokens.create({
        companyId: quote.companyId,
        resourceType: 'quote',
        resourceId: quote.id,
        scope: 'quote_signature',
        expiresAt,
      });
      return ok({ token: created.token, expiresAt });
    });
  }
}
