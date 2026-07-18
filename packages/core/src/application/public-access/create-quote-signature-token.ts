import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appForbidden, appNotFound } from '../result';
import { type CompanyRepository, type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';

const SIGNATURE_TOKEN_TTL_DAYS = 30;

function addDays(isoInstant: string, days: number): string {
  const d = new Date(isoInstant);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export interface CreateQuoteSignatureTokenDeps {
  companies: CompanyRepository;
  quotes: QuoteRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

export class CreateQuoteSignatureToken {
  constructor(private readonly deps: CreateQuoteSignatureTokenDeps) {}

  async execute(input: {
    quoteId: string;
  }): Promise<Result<{ token: string; expiresAt: string }, AppError>> {
    return this.deps.uow.runInTransaction(async () => {
      // Localisateur sans verrou, DANS le contexte tenant de l'UoW : aucun état métier de cette
      // copie n'est réutilisé. Les verrous suivent ensuite company → quote → token.
      const locator = await this.deps.quotes.findById(input.quoteId);
      if (!locator) return err(appNotFound('quote', input.quoteId));
      const company = await this.deps.companies.lockForShareById(locator.companyId);
      if (!company) return err(appNotFound('company', locator.companyId));
      if (company.isClosed()) return err(appForbidden('Compte clôturé : lien public impossible.'));

      // Le même verrou devis est pris par SignQuote, APRÈS le verrou company partagé.
      const quote = await this.deps.quotes.lockById(input.quoteId);
      if (!quote) return err(appNotFound('quote', input.quoteId));
      if (quote.companyId !== company.id) return err(appNotFound('quote', input.quoteId));
      if (!quote.number)
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'quote',
            message: 'Devis non numéroté : lien de signature impossible.',
          }),
        );
      if (quote.status !== 'sent' && quote.status !== 'viewed')
        return err(appDomain({ code: 'INVALID_TRANSITION', from: quote.status, to: 'signed' }));

      const at = this.deps.clock.now();
      // Validité du devis = calendrier MÉTIER Europe/Paris (même correction que ExpireQuote).
      if (quote.validUntil !== null && quote.validUntil < parisDateOnly(at))
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'validUntil',
            message: 'Devis expiré : lien de signature impossible.',
          }),
        );

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
