import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort } from '../ports/services';

/**
 * A3 — résolution du jeton public de la FONCTIONNALITÉ DE RÉTRACTATION en ligne (art. L221-21
 * dernier al. c. conso, scope `quote_retractation`). Même doctrine anti-énumération que
 * ResolveQuoteSignatureToken : tout jeton inconnu/révoqué/hors-scope répond « introuvable »
 * sans distinction. Le locator ne donne AUCUNE autorisation : l'exercice revalide le grant
 * DANS la transaction qui verrouille le devis (ExerciseRetractation).
 */
export interface ResolveQuoteRetractationTokenDeps {
  publicAccessTokens: PublicAccessTokenRepository;
  clock: ClockPort;
}

export class ResolveQuoteRetractationToken {
  constructor(private readonly deps: ResolveQuoteRetractationTokenDeps) {}

  async execute(
    input: { token: string },
  ): Promise<Result<{ grantId: string; companyId: string; quoteId: string }, AppError>> {
    const grant = await this.deps.publicAccessTokens.findActive(input.token, this.deps.clock.now());
    if (!grant || grant.scope !== 'quote_retractation' || grant.resourceType !== 'quote') {
      return err(appNotFound('public-retractation-token', 'redacted'));
    }
    return ok({ grantId: grant.id, companyId: grant.companyId, quoteId: grant.resourceId });
  }
}
