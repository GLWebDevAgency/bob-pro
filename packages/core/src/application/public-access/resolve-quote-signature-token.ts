import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort } from '../ports/services';

export interface ResolveQuoteSignatureTokenDeps {
  publicAccessTokens: PublicAccessTokenRepository;
  clock: ClockPort;
}

export class ResolveQuoteSignatureToken {
  constructor(private readonly deps: ResolveQuoteSignatureTokenDeps) {}

  async execute(input: { token: string }): Promise<Result<{ grantId: string; companyId: string; quoteId: string }, AppError>> {
    const grant = await this.deps.publicAccessTokens.findActive(input.token, this.deps.clock.now());
    if (!grant || grant.scope !== 'quote_signature' || grant.resourceType !== 'quote') {
      return err(appNotFound('public-signature-token', 'redacted'));
    }
    return ok({ grantId: grant.id, companyId: grant.companyId, quoteId: grant.resourceId });
  }
}
