import { type Result, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type AppError, appConflict, appDomain, appForbidden, appNotFound } from '../result';
import { Company } from '../../domain/company/company';
import { type CompanyRepository } from '../ports/repositories';
import { type SubscriptionRepository } from '../ports/subscription-repository';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type UnitOfWorkPort } from '../ports/services';
import { type AccountIdentityDeletionOutboxPort } from '../ports/account-identity-deletion';

export interface CloseAccountInput {
  readonly companyId: string;
  /** Sujet authentifié qui possède l'identité externe à supprimer. */
  readonly userId: string;
  /** UUID créé par l'appelant ; ignoré si une demande idempotente existe déjà. */
  readonly identityDeletionRequestId: string;
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
  /** La suppression fournisseur est durable mais asynchrone ; `done` est possible sur un retry. */
  readonly identityDeletion: {
    readonly requestId: string;
    readonly status: 'pending' | 'done';
    readonly alreadyRequested: boolean;
  };
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
 * liens de signature publics). Les push tokens et les autres tables d'infrastructure restent
 * orchestrés par l'appelant. En revanche, l'INTENTION de supprimer l'identité externe est écrite
 * ici par un port abstrait dans la même unité de travail : aucun crash post-commit ne peut la
 * perdre. L'adapter ne conserve ni email, ni téléphone, ni metadata ; seulement le sujet externe
 * transitoire requis par le worker, puis un reçu pseudonyme minimisé.
 *
 * MINIMISATION : cette company ne porte pas le profil du compte Supabase, mais son identité
 * légale (name/siret/address/iban/coordonnées/decennale) peut quand même constituer une donnée
 * personnelle, notamment pour une entreprise individuelle. Elle est relue en direct par le rendu
 * des pièces déjà émises (ex. renderInvoicePdf) : la modifier aveuglément après coup pourrait
 * falsifier des documents retenus. Rien n'est donc anonymisé ici : chaque catégorie doit suivre la
 * matrice de rétention RGPD/légale, et ce commentaire interdit autant le faux « tout anonyme » que
 * le cascade delete destructeur.
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
      identityDeletionOutbox: AccountIdentityDeletionOutboxPort;
      uow: UnitOfWorkPort;
    },
  ) {}

  async execute(input: CloseAccountInput): Promise<Result<CloseAccountView, AppError>> {
    return this.deps.uow.runInTransaction(async () => {
      // Verrou de cycle de vie pris EN PREMIER. Toute capacité publique détient le verrou
      // partagé correspondant jusqu'au commit : la clôture se place donc avant ou après elle,
      // jamais au milieu d'une émission, d'une lecture ou d'une signature.
      const company = await this.deps.companies.lockById(input.companyId);
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

      // La garde owner/Cabinet et l'outbox précèdent toute mutation Company. Un refus Result ne
      // doit jamais pouvoir committer un closedAt partiel ; une panne adapter lève et rollbacke.
      const deletion = await this.deps.identityDeletionOutbox.ensureRequested({
        requestId: input.identityDeletionRequestId,
        companyId: input.companyId,
        userId: input.userId,
        requestedAt: input.now,
      });
      if (deletion.outcome === 'rejected') {
        return err(
          deletion.reason === 'company_owner_binding_mismatch'
            ? appForbidden(deletion.reason)
            : appConflict('account_deletion', deletion.reason),
        );
      }

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
        await this.deps.subscriptions.save({
          ...subscription,
          status: 'canceled',
          updatedAt: input.now,
        });
      }

      // Tous les scopes publics sont coupés avant de libérer le verrou exclusif company.
      await this.deps.publicAccessTokens.revokeAllForCompany({
        companyId: input.companyId,
        at: input.now,
      });

      return ok({
        companyId: input.companyId,
        closedAt,
        alreadyClosed,
        identityDeletion: deletion.request,
      });
    });
  }
}
