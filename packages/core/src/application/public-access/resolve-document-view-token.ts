import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort } from '../ports/services';

export interface ResolveDocumentViewTokenDeps {
  publicAccessTokens: PublicAccessTokenRepository;
  clock: ClockPort;
}

export interface ResolvedDocumentViewGrant {
  grantId: string;
  companyId: string;
  kind: 'quote' | 'invoice';
  documentId: string;
}

/**
 * Résolution d'un jeton public de VISUALISATION — même mécanique que
 * `ResolveQuoteSignatureToken` : un jeton expiré/révoqué/inconnu, ou porteur d'un AUTRE scope
 * (ex. `quote_signature`), est traité identiquement (`not_found` générique, jamais un détail qui
 * distinguerait « existe mais expiré » de « n'a jamais existé » — anti-énumération).
 */
export class ResolveDocumentViewToken {
  constructor(private readonly deps: ResolveDocumentViewTokenDeps) {}

  async execute(input: { token: string }): Promise<Result<ResolvedDocumentViewGrant, AppError>> {
    const grant = await this.deps.publicAccessTokens.findActive(input.token, this.deps.clock.now());
    if (!grant || grant.scope !== 'document_view') {
      return err(appNotFound('public-document-view-token', 'redacted'));
    }
    return ok({
      grantId: grant.id,
      companyId: grant.companyId,
      kind: grant.resourceType,
      documentId: grant.resourceId,
    });
  }
}
