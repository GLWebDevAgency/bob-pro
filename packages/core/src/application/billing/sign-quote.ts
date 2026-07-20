import { type Result, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import {
  type EarlyExecutionRequest,
  type Signature,
  type SignatureMethod,
} from '../../domain/billing/shared/signature';
import { retractationExpiresAt } from '../../domain/compliance/retractation';
import {
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
} from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

export interface SignQuoteDeps {
  companies: CompanyRepository;
  /** A3 — le type du client (b2c/b2b/b2g) décide si la demande d'exécution anticipée a un sens. */
  customers: Pick<CustomerRepository, 'findById'>;
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
  /**
   * A3 — le client a coché « Je demande l'exécution immédiate des travaux… » (art. L221-25
   * c. conso) au moment de signer. Tracée dans la signature (horodatage serveur) UNIQUEMENT
   * pour un client consommateur (b2c) : pour un professionnel le droit de rétractation
   * n'existe pas, il n'y a donc RIEN à renoncer — le drapeau est ignoré, jamais persisté.
   */
  earlyExecutionRequested?: boolean;
}

function normalizeSignerName(value: unknown): Result<string, AppError> {
  if (typeof value !== 'string') {
    return err(
      appDomain({ code: 'VALIDATION', field: 'signerName', message: 'Nom du signataire requis.' }),
    );
  }
  if (hasForbiddenFormatCharacter(value)) {
    return err(
      appDomain({
        code: 'VALIDATION',
        field: 'signerName',
        message: 'Nom du signataire invalide.',
      }),
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    return err(
      appDomain({
        code: 'VALIDATION',
        field: 'signerName',
        message: 'Nom du signataire invalide.',
      }),
    );
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

export interface SignQuoteOutput {
  status: string;
  /**
   * A3 — jeton BRUT de la fonctionnalité de rétractation en ligne (L221-21), créé pour un
   * devis B2C : l'appelant en dérive l'URL à présenter au consommateur et à lui transmettre
   * sur support durable. Null = client professionnel (pas de droit de rétractation).
   */
  retractation: { token: string; expiresAt: Instant } | null;
}

/**
 * Signature d'un devis — sur place (interne, authentifiée) ou à distance (lien public tokenisé).
 * Toute signature révoque, DANS LA MÊME transaction que l'écriture, TOUS les jetons publics
 * `quote_signature` actifs du devis : un lien partagé ne doit plus rien exposer une fois le
 * devis signé, qu'il ait servi à signer ou non (P0 — grants non révoqués après signature).
 * A3 : pour un client B2C, la MÊME transaction crée le jeton de la fonctionnalité de
 * rétractation en ligne (scope `quote_retractation`, L221-21) — jamais révoqué par la signature.
 */
export class SignQuote {
  constructor(private readonly deps: SignQuoteDeps) {}

  async execute(input: SignQuoteInput): Promise<Result<SignQuoteOutput, AppError>> {
    const signerName = normalizeSignerName(input.signerName);
    if (!signerName.ok) return signerName;

    const pre = await this.deps.quotes.findById(input.quoteId);
    if (!pre) return err(appNotFound('quote', input.quoteId));

    try {
      const status = await this.deps.uow.runInTransaction(async () => {
        // Ordre global anti-deadlock : company (SHARE) → quote (UPDATE) → token. CloseAccount
        // prend company en UPDATE : une signature est donc entièrement avant ou après la clôture.
        const company = await this.deps.companies.lockForShareById(pre.companyId);
        if (!company)
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'company',
            message: 'Société introuvable.',
          });
        if (company.isClosed()) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'company',
            message: 'Compte clôturé.',
          });
        }
        const quote = await this.deps.quotes.lockById(input.quoteId);
        if (!quote)
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'quote',
            message: 'Devis introuvable.',
          });
        if (quote.companyId !== company.id) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'quote',
            message: 'Devis introuvable.',
          });
        }

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
            grant.companyId === company.id &&
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

        // A3 — la qualité du client est FIGÉE à la conclusion du contrat (Signature.customerType,
        // lue dans la MÊME transaction) : elle décide du droit de rétractation, de l'interdiction
        // de paiement L221-10 et de la fonctionnalité en ligne L221-21. Fail-closed : client
        // introuvable (ou d'un autre tenant) → refus, on ne conclut pas un contrat dont on
        // ignore le régime légal.
        const customer = await this.deps.customers.findById(quote.customerId);
        if (!customer || customer.companyId !== company.id) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'customer',
            message: 'Client introuvable.',
          });
        }

        // A3 — renonciation au gel : la demande d'exécution anticipée n'est tracée que pour un
        // CONSOMMATEUR (b2c) — pour un professionnel le droit n'existe pas, rien à renoncer.
        let earlyExecution: EarlyExecutionRequest | undefined;
        if (input.earlyExecutionRequested && customer.type === 'b2c') {
          earlyExecution = { requestedAt: at };
        }

        const method: SignatureMethod = input.remoteGrant ? 'remote_link' : 'onsite_draw';
        const signature: Signature = {
          signerName: signerName.value,
          signedAt: at,
          method,
          accepted: true,
          customerType: customer.type,
          ...(input.proofSha256
            ? { proof: { method, sha256: input.proofSha256, capturedAt: at } }
            : {}),
          ...(earlyExecution ? { earlyExecution } : {}),
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

        // A3 — fonctionnalité de rétractation EN LIGNE (art. L221-21 dernier al. et D221-5
        // c. conso, en vigueur depuis le 19/06/2026) : créée DANS la même transaction que la
        // signature d'un devis B2C, valable pendant TOUTE la durée du délai de rétractation —
        // la révocation des jetons de signature ci-dessus ne prive donc plus le consommateur
        // de toute interface pendant le délai (c'était le manquement P0).
        let retractation: { token: string; expiresAt: Instant } | null = null;
        if (customer.type === 'b2c') {
          const expiresAt = retractationExpiresAt(at);
          const created = await this.deps.publicAccessTokens.create({
            companyId: quote.companyId,
            resourceType: 'quote',
            resourceId: quote.id,
            scope: 'quote_retractation',
            expiresAt,
          });
          retractation = { token: created.token, expiresAt };
        }
        return { status: quote.status, retractation };
      });
      return ok(status);
    } catch (e) {
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      throw e;
    }
  }
}
