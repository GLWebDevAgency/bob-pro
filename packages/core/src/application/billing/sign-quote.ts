import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type Signature, type SignatureMethod } from '../../domain/billing/shared/signature';
import { type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

export interface SignQuoteDeps {
  quotes: QuoteRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

export interface SignQuoteInput {
  quoteId: string;
  signerName: string;
  /**
   * Hash SHA-256 (hex) du tracé RÉELLEMENT reçu — calculé côté serveur, jamais fourni tel quel
   * par le client. Absent = aucune preuve transmise (ex. signature à distance sans capture) :
   * `Signature.proof` reste alors absent, jamais fabriqué (c'était le P0 R4).
   */
  proofSha256?: string;
  /**
   * Présent UNIQUEMENT pour une signature via lien public tokenisé. Le jeton brut est REVALIDÉ
   * dans la même transaction que l'écriture de la signature (P0 — course de révocation entre la
   * résolution du grant et l'écriture). Absent = signature interne/sur place authentifiée.
   */
  remoteGrant?: { token: string; grantId: string };
}

function normalizeSignerName(value: unknown): Result<string, AppError> {
  if (typeof value !== 'string') {
    return err(appDomain({ code: 'VALIDATION', field: 'signerName', message: 'Nom du signataire requis.' }));
  }
  if (hasForbiddenFormatCharacter(value)) {
    return err(appDomain({ code: 'VALIDATION', field: 'signerName', message: 'Nom du signataire invalide.' }));
  }
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    return err(appDomain({ code: 'VALIDATION', field: 'signerName', message: 'Nom du signataire invalide.' }));
  }
  const normalized = trimmed.replace(/\s+/g, ' ');
  return ok(normalized);
}

function hasForbiddenFormatCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
    if (code >= 0x80 && code <= 0x9f) return true;
    if (code >= 0x200b && code <= 0x200d) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code === 0xfeff) return true;
  }
  return false;
}

/**
 * Signature d'un devis — sur place (interne, authentifiée) ou à distance (lien public tokenisé).
 * Toute signature révoque, DANS LA MÊME transaction que l'écriture, TOUS les jetons publics
 * `quote_signature` actifs du devis : un lien partagé ne doit plus rien exposer une fois le
 * devis signé, qu'il ait servi à signer ou non (P0 — grants non révoqués après signature).
 */
export class SignQuote {
  constructor(private readonly deps: SignQuoteDeps) {}

  async execute(input: SignQuoteInput): Promise<Result<{ status: string }, AppError>> {
    const signerName = normalizeSignerName(input.signerName);
    if (!signerName.ok) return signerName;

    const pre = await this.deps.quotes.findById(input.quoteId);
    if (!pre) return err(appNotFound('quote', input.quoteId));

    try {
      const status = await this.deps.uow.runInTransaction(async () => {
        const quote = await this.deps.quotes.lockById(input.quoteId);
        if (!quote) throw new TxDomainError({ code: 'VALIDATION', field: 'quote', message: 'Devis introuvable.' });

        const at = this.deps.clock.now();

        // Course résolution -> signature (P0) : le jeton public est REVALIDÉ ici, DANS la
        // transaction qui verrouille déjà le devis (lockById) — toute révocation/rotation
        // concurrente sur ce même devis est soit déjà commitée (revalidation la voit et refuse
        // proprement), soit bloquée derrière le verrou de ligne jusqu'à notre commit.
        if (input.remoteGrant) {
          const grant = await this.deps.publicAccessTokens.findActive(input.remoteGrant.token, at);
          const stillValid =
            grant !== null &&
            grant.id === input.remoteGrant.grantId &&
            grant.resourceType === 'quote' &&
            grant.resourceId === quote.id &&
            grant.scope === 'quote_signature';
          if (!stillValid) {
            throw new TxDomainError({
              code: 'VALIDATION',
              field: 'signatureToken',
              message: 'Lien de signature révoqué ou expiré.',
            });
          }
        }

        const method: SignatureMethod = input.remoteGrant ? 'remote_link' : 'onsite_draw';
        const signature: Signature = {
          signerName: signerName.value,
          signedAt: at,
          method,
          accepted: true,
          ...(input.proofSha256 ? { proof: { method, sha256: input.proofSha256, capturedAt: at } } : {}),
        };
        const signed = quote.sign(signature, at);
        if (!signed.ok) throw new TxDomainError(signed.error);

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
