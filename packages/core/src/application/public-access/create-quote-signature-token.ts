import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort } from '../ports/services';

const SIGNATURE_TOKEN_TTL_DAYS = 30;

function addDays(isoInstant: string, days: number): string {
  const d = new Date(isoInstant);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export interface CreateQuoteSignatureTokenDeps {
  quotes: QuoteRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  clock: ClockPort;
}

export class CreateQuoteSignatureToken {
  constructor(private readonly deps: CreateQuoteSignatureTokenDeps) {}

  async execute(input: { quoteId: string }): Promise<Result<{ token: string; expiresAt: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));
    if (!quote.number)
      return err(appDomain({ code: 'VALIDATION', field: 'quote', message: 'Devis non numéroté : lien de signature impossible.' }));
    if (quote.status !== 'sent' && quote.status !== 'viewed')
      return err(appDomain({ code: 'INVALID_TRANSITION', from: quote.status, to: 'signed' }));
    // Validité du devis = calendrier MÉTIER Europe/Paris (même correction que ExpireQuote).
    if (quote.validUntil !== null && quote.validUntil < parisDateOnly(this.deps.clock.now()))
      return err(appDomain({ code: 'VALIDATION', field: 'validUntil', message: 'Devis expiré : lien de signature impossible.' }));

    const expiresAt = addDays(this.deps.clock.now(), SIGNATURE_TOKEN_TTL_DAYS);
    await this.deps.publicAccessTokens.revokeActiveFor({
      companyId: quote.companyId,
      resourceType: 'quote',
      resourceId: quote.id,
      scope: 'quote_signature',
      at: this.deps.clock.now(),
    });
    const created = await this.deps.publicAccessTokens.create({
      companyId: quote.companyId,
      resourceType: 'quote',
      resourceId: quote.id,
      scope: 'quote_signature',
      expiresAt,
    });
    return ok({ token: created.token, expiresAt });
  }
}
