import { type Result, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { Company } from '../../domain/company/company';
import { type CompanyRepository } from '../ports/repositories';
import { type SubscriptionRepository } from '../ports/subscription-repository';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';

export interface CloseAccountInput {
  readonly companyId: string;
  /** Anti-tap accidentel : doit égaler EXACTEMENT le nom de la company (Company.name), saisi
   *  par l'utilisateur sur l'écran de confirmation à froid — jamais pré-rempli côté client. */
  readonly confirmationText: string;
  /** Motif libre optionnel (churn survey) — jamais requis, jamais exposé ailleurs. */
  readonly reason: string | null;
  readonly now: Instant;
}

export interface CloseAccountView {
  readonly companyId: string;
  readonly closedAt: Instant;
  /** true si la company était DÉJÀ clôturée avant cet appel — aucun effet de bord répété
   *  (idempotence : companies.save/subscriptions.save ne sont PAS rejoués). */
  readonly alreadyClosed: boolean;
}

/**
 * CloseAccount (Apple App Store Review Guideline 5.1.1(v) — suppression de compte in-app).
 *
 * ARCHITECTURE : CLÔTURE + RÉTENTION LÉGALE, JAMAIS UN CASCADE DELETE.
 * Deux raisons, l'une technique et l'une légale, convergent vers la même décision :
 *  1) `Company → Invoice/Quote/AccountingEntry` sont `onDelete: Restrict` en base (schema.prisma) —
 *     un hard-delete de la company échouerait tant qu'une seule pièce existe.
 *  2) Le Code de commerce impose la conservation des pièces comptables ÉMISES (factures, avoirs,
 *     écritures) pendant 10 ans — même si l'utilisateur ferme son compte. Les supprimer serait
 *     illégal, pas seulement risqué.
 * Cette use case ne touche donc JAMAIS aux factures/devis/écritures : elle marque la company
 * `closedAt` (le guard tenant API refuse ensuite toute requête sur ce tenant — 403 « compte
 * clôturé ») et coupe les capacités actives qui pourraient encore agir en son nom (abonnement,
 * liens de signature publics). Les push tokens (table `devices`, hors @bob/core) et la
 * suppression du user Supabase Auth (identité personnelle : prénom/email/téléphone — ENTIÈREMENT
 * hors Postgres, cf. commentaire CompanyProps.closedAt) sont orchestrés par l'appelant
 * (BackendService.closeAccount), pas ici : ce use case ne connaît que les ports @bob/core.
 *
 * ANONYMISATION : cette company n'a AUCUN champ « identité personnelle de l'utilisateur » — name/
 * siret/address/iban/decennale sont l'identité LÉGALE DE L'ENTREPRISE, relue en direct par le
 * rendu des pièces déjà émises (ex. renderInvoicePdf) : les modifier après coup falsifierait
 * rétroactivement des documents légalement retenus. Rien n'est donc anonymisé ici — c'est le
 * point, documenté pour ne jamais être « corrigé » par erreur vers un cascade delete plus tard.
 *
 * IDEMPOTENT : un second appel avec le MÊME confirmationText renvoie `alreadyClosed: true` sans
 * rejouer la clôture/l'annulation d'abonnement (closedAt conservé tel quel, revokeAllForCompany
 * reste sûr à rejouer par construction — c'est un update conditionnel sur les lignes actives).
 */
export class CloseAccount {
  constructor(
    private readonly deps: {
      companies: CompanyRepository;
      subscriptions: SubscriptionRepository;
      publicAccessTokens: PublicAccessTokenRepository;
    },
  ) {}

  async execute(input: CloseAccountInput): Promise<Result<CloseAccountView, AppError>> {
    const company = await this.deps.companies.findById(input.companyId);
    if (!company) return err(appNotFound('company', input.companyId));

    // Guard anti-tap accidentel : TOUJOURS revalidé, y compris sur un appel idempotent — jamais
    // de bypass simplement parce que la company est déjà clôturée.
    if (input.confirmationText.trim() !== company.name) {
      return err({
        kind: 'validation',
        issues: [
          {
            field: 'confirmationText',
            message: 'Le nom saisi ne correspond pas au nom de l’entreprise — clôture refusée.',
          },
        ],
      });
    }

    const alreadyClosed = company.isClosed();
    const closedAt = company.closedAt ?? input.now;

    if (!alreadyClosed) {
      const closed = Company.of({
        ...company.toProps(),
        closedAt,
        ...(input.reason !== null ? { closureReason: input.reason } : {}),
      });
      if (!closed.ok) return err(appDomain(closed.error));
      await this.deps.companies.save(closed.value);
    }

    // Abonnement : invalidation idempotente (le early-access fallback — aucune ligne — n'a rien
    // à annuler ; un canceled déjà posé n'est pas réécrit).
    const subscription = await this.deps.subscriptions.findByCompanyId(input.companyId);
    if (subscription && subscription.status !== 'canceled') {
      await this.deps.subscriptions.save({ ...subscription, status: 'canceled', updatedAt: input.now });
    }

    // Liens de signature publics : coupe toute capacité d'agir encore au nom de ce tenant.
    await this.deps.publicAccessTokens.revokeAllForCompany({ companyId: input.companyId, at: input.now });

    return ok({ companyId: input.companyId, closedAt, alreadyClosed });
  }
}
