import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository, type InvoiceRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort } from '../ports/services';

/** Expiration par défaut d'un lien de VISUALISATION — plus longue que la signature (30 j) car
 *  la pièce reste consultable longtemps après (référence pour le client), sans engagement. */
export const DOCUMENT_VIEW_TOKEN_DEFAULT_TTL_DAYS = 30;

function addDays(isoInstant: string, days: number): string {
  const d = new Date(isoInstant);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export interface CreateDocumentViewLinkDeps {
  quotes: QuoteRepository;
  invoices: InvoiceRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  clock: ClockPort;
}

export interface CreateDocumentViewLinkInput {
  kind: 'quote' | 'invoice';
  id: string;
  /** TTL configurable — absent = DOCUMENT_VIEW_TOKEN_DEFAULT_TTL_DAYS (30 j). */
  ttlDays?: number;
}

/**
 * Lien public de VISUALISATION (devis ou facture) — canal d'envoi universel : la pièce se
 * partage par SMS/WhatsApp via un lien, sans jamais exiger l'e-mail du client. Même doctrine
 * P0 R4 que `CreateQuoteSignatureLink` : AUCUN port de notification dans les dépendances —
 * l'absence d'envoi sortant est prouvée par construction, pas par discipline d'appel. Rotation :
 * tout jeton `document_view` actif de la pièce est révoqué avant d'en émettre un nouveau (un
 * ancien lien partagé par erreur cesse d'être résolvable dès qu'un nouveau est préparé).
 *
 * Gardes par statut (jamais un brouillon, jamais fabriqué depuis l'UI) :
 *  - devis : tout statut SAUF `draft` (sent/viewed/signed/refused/expired — un client doit
 *    pouvoir revoir un devis même refusé/expiré, c'est une consultation, pas un engagement).
 *  - facture : ÉMISE uniquement (`number` ET `issuedAt` non nuls) — jamais un brouillon interne,
 *    même si son statut affiché n'est pas encore 'issued' au sens strict (ex. `cancelled` peut
 *    provenir d'un brouillon annulé sans avoir jamais été numéroté : le contrôle porte sur
 *    number/issuedAt, l'invariant réel, pas sur le seul statut).
 */
export class CreateDocumentViewLink {
  constructor(private readonly deps: CreateDocumentViewLinkDeps) {}

  async execute(
    input: CreateDocumentViewLinkInput,
  ): Promise<Result<{ token: string; expiresAt: string }, AppError>> {
    const ttlDays = input.ttlDays ?? DOCUMENT_VIEW_TOKEN_DEFAULT_TTL_DAYS;

    let companyId: string;
    if (input.kind === 'quote') {
      const quote = await this.deps.quotes.findById(input.id);
      if (!quote) return err(appNotFound('quote', input.id));
      if (quote.status === 'draft')
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'quote',
            message: 'Devis brouillon : lien de consultation impossible.',
          }),
        );
      companyId = quote.companyId;
    } else {
      const invoice = await this.deps.invoices.findById(input.id);
      if (!invoice) return err(appNotFound('invoice', input.id));
      if (invoice.number === null || invoice.issuedAt === null)
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'invoice',
            message: 'Facture non émise : lien de consultation impossible.',
          }),
        );
      companyId = invoice.companyId;
    }

    const expiresAt = addDays(this.deps.clock.now(), ttlDays);
    await this.deps.publicAccessTokens.revokeActiveFor({
      companyId,
      resourceType: input.kind,
      resourceId: input.id,
      scope: 'document_view',
      at: this.deps.clock.now(),
    });
    const created = await this.deps.publicAccessTokens.create({
      companyId,
      resourceType: input.kind,
      resourceId: input.id,
      scope: 'document_view',
      expiresAt,
    });
    return ok({ token: created.token, expiresAt });
  }
}
