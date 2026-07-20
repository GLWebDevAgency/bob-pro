import { type Result, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import {
  deriveRetractation,
  onlineRetractationAvailability,
  retractationAcknowledgmentLines,
  retractationDeclarationLines,
  type RetractationDeclarationInput,
} from '../../domain/compliance/retractation';
import {
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
} from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

/**
 * A3 — EXERCICE de la rétractation via la fonctionnalité en ligne (art. L221-21 dernier al.
 * c. conso, ordonnance n° 2026-2 du 05/01/2026 ; modalités art. D221-5, décret n° 2026-3) :
 * le consommateur remplit la déclaration (nom + moyen électronique de réception de l'accusé),
 * la soumet via « Confirmer la rétractation », et le professionnel envoie un ACCUSÉ DE
 * RÉCEPTION sur support durable (contenu de la déclaration + date/heure d'envoi).
 * Même doctrine transactionnelle que SignQuote : le jeton public est REVALIDÉ dans la
 * transaction qui verrouille le devis (aucune course révocation/exercice possible), et TOUS
 * les jetons `quote_retractation` du devis sont révoqués une fois la rétractation enregistrée
 * (la fonctionnalité a rempli son office — l'accusé fait foi).
 */
export interface ExerciseRetractationDeps {
  companies: CompanyRepository;
  customers: Pick<CustomerRepository, 'findById'>;
  quotes: QuoteRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

export interface ExerciseRetractationInput {
  quoteId: string;
  /** Jeton brut + grant résolu — REVALIDÉS en transaction (même doctrine que SignQuote). */
  grant: { token: string; grantId: string };
  /** Nom fourni/confirmé par le consommateur dans la déclaration (D221-5, II). */
  declarantName: string;
  /** Moyen électronique choisi pour recevoir l'accusé de réception (D221-5, II et IV). */
  acknowledgmentEmail: string;
}

export interface ExerciseRetractationOutput {
  retractedAt: Instant;
  /** Contenu exact de la déclaration soumise (repris dans l'accusé, D221-5, IV). */
  declarationLines: string[];
  /** Accusé de réception à remettre sur support durable (affichage + envoi électronique). */
  acknowledgmentLines: string[];
  /** Adresse à laquelle l'accusé doit être envoyé (choisie par le consommateur). */
  acknowledgmentEmail: string;
  quoteNumber: string;
  companyName: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeDeclarantName(value: unknown): Result<string, AppError> {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 120) {
    return err(
      appDomain({ code: 'VALIDATION', field: 'declarantName', message: 'Nom du consommateur requis.' }),
    );
  }
  return ok(value.trim().replace(/\s+/g, ' '));
}

function normalizeAcknowledgmentEmail(value: unknown): Result<string, AppError> {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 254 || !EMAIL_PATTERN.test(value.trim())) {
    return err(
      appDomain({
        code: 'VALIDATION',
        field: 'acknowledgmentEmail',
        message: "Adresse électronique requise pour recevoir l'accusé de réception.",
      }),
    );
  }
  return ok(value.trim());
}

export class ExerciseRetractation {
  constructor(private readonly deps: ExerciseRetractationDeps) {}

  async execute(
    input: ExerciseRetractationInput,
  ): Promise<Result<ExerciseRetractationOutput, AppError>> {
    const declarantName = normalizeDeclarantName(input.declarantName);
    if (!declarantName.ok) return declarantName;
    const acknowledgmentEmail = normalizeAcknowledgmentEmail(input.acknowledgmentEmail);
    if (!acknowledgmentEmail.ok) return acknowledgmentEmail;

    const pre = await this.deps.quotes.findById(input.quoteId);
    if (!pre) return err(appNotFound('quote', input.quoteId));

    try {
      const output = await this.deps.uow.runInTransaction(async () => {
        // Ordre global anti-deadlock : company (SHARE) → quote (UPDATE) → token — identique à
        // SignQuote (les deux flux mutent le même devis).
        const company = await this.deps.companies.lockForShareById(pre.companyId);
        if (!company || company.isClosed()) {
          throw new TxDomainError({ code: 'VALIDATION', field: 'company', message: 'Société introuvable.' });
        }
        const quote = await this.deps.quotes.lockById(input.quoteId);
        const quoteNumber = quote?.number ?? null;
        if (!quote || quote.companyId !== company.id || quote.signature === null || quoteNumber === null) {
          throw new TxDomainError({ code: 'VALIDATION', field: 'quote', message: 'Devis introuvable.' });
        }

        const at = this.deps.clock.now();

        // Revalidation du jeton DANS la transaction (course révocation/exercice, cf. SignQuote).
        const grant = await this.deps.publicAccessTokens.findActive(input.grant.token, at);
        const stillValid =
          grant !== null &&
          grant.id === input.grant.grantId &&
          grant.companyId === company.id &&
          grant.resourceType === 'quote' &&
          grant.resourceId === quote.id &&
          grant.scope === 'quote_retractation';
        if (!stillValid) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'retractationToken',
            message: 'Lien de rétractation révoqué ou expiré.',
          });
        }

        // Qualité de consommateur figée à la conclusion (Signature.customerType) ; fallback
        // honnête = type courant de la fiche pour les signatures antérieures au figeage.
        const customer = await this.deps.customers.findById(quote.customerId);
        if (!customer || customer.companyId !== company.id) {
          throw new TxDomainError({ code: 'VALIDATION', field: 'customer', message: 'Client introuvable.' });
        }
        const availability = onlineRetractationAvailability(
          deriveRetractation({ customerType: customer.type, signature: quote.signature }),
          quote.retractedAt !== null,
          at,
        );
        if (!availability.available) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'retractation',
            message:
              availability.reason === 'already_retracted'
                ? 'Rétractation déjà enregistrée.'
                : availability.reason === 'expired'
                  ? 'Le délai de rétractation de 14 jours est expiré.'
                  : "Ce contrat n'ouvre pas de droit de rétractation.",
          });
        }

        const retracted = quote.retract(at);
        if (!retracted.ok) throw new TxDomainError(retracted.error);
        await this.deps.quotes.save(quote);
        // La fonctionnalité a rempli son office : plus aucun jeton de rétractation actif.
        await this.deps.publicAccessTokens.revokeActiveFor({
          companyId: quote.companyId,
          resourceType: 'quote',
          resourceId: quote.id,
          scope: 'quote_retractation',
          at,
        });

        const declaration: RetractationDeclarationInput = {
          declarantName: declarantName.value,
          quoteNumber,
          companyName: company.name,
          acknowledgmentEmail: acknowledgmentEmail.value,
          sentAt: at,
        };
        const result: ExerciseRetractationOutput = {
          retractedAt: at,
          declarationLines: retractationDeclarationLines(declaration),
          acknowledgmentLines: retractationAcknowledgmentLines(declaration),
          acknowledgmentEmail: acknowledgmentEmail.value,
          quoteNumber: declaration.quoteNumber,
          companyName: company.name,
        };
        return result;
      });
      return ok(output);
    } catch (e) {
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      throw e;
    }
  }
}
