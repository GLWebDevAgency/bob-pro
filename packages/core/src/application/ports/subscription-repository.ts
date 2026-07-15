import { type Instant } from '../../shared-kernel/time';
import { type PlanTier } from '../../domain/subscription/plan';
import { type SubscriptionStatus } from '../../domain/subscription/subscription';

/**
 * PERSISTANCE DE L'ABONNEMENT (pilier 2) — la ligne DB par tenant (table `subscriptions`),
 * source de vérité derrière GetSubscriptionStatus. Distincte de l'agrégat `Subscription`
 * (domain/subscription/subscription.ts) : ce dernier porte le COMPORTEMENT d'entitlement
 * (can/autonomyEntitlement) sur un instantané, cette ligne porte l'ÉTAT PERSISTÉ, y compris
 * l'essai inversé (trialEndsAt) que l'agrégat ne connaît pas.
 *
 * `plan` = palier PAYÉ souscrit (jamais le palier prêté par un essai en cours). Pendant un
 * essai inversé (reverse trial), `status` vaut 'trialing' et `plan` porte le palier prêté
 * (Pro par défaut, cf. startReverseTrial @bob/core) ; trialEndsAt fixe l'échéance. La descente
 * douce vers le palier réellement payé après essai est un CHANGEMENT de `plan` par l'appelant
 * (checkout / atterrissage), jamais une mutation implicite de cette ligne.
 */
export type SubscriptionStore = 'apple' | 'google' | 'none';

export interface SubscriptionRecord {
  readonly id: string;
  readonly companyId: string;
  readonly plan: PlanTier;
  readonly status: SubscriptionStatus;
  /** Échéance de l'essai inversé en cours — null hors essai (jamais démarré ou déjà atterri). */
  readonly trialEndsAt: Instant | null;
  readonly currentPeriodEnd: Instant | null;
  /** Canal d'achat (IAP) — null tant qu'aucun store n'a facturé ce tenant. */
  readonly store: SubscriptionStore | null;
  readonly storeRef: string | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface SubscriptionRepository {
  findByCompanyId(companyId: string): Promise<SubscriptionRecord | null>;
  /**
   * Démarre l'essai inversé du tenant — IDEMPOTENT : si une ligne existe déjà pour ce companyId
   * (retry de provisioning, cf. backend.service.registerCompany), elle est renvoyée TELLE QUELLE,
   * jamais réinitialisée (un essai ne redémarre pas sous un utilisateur qui retape le formulaire).
   */
  startTrial(input: {
    id: string;
    companyId: string;
    plan: PlanTier;
    trialEndsAt: Instant;
    now: Instant;
  }): Promise<SubscriptionRecord>;
  /** Écriture complète (changement de plan/statut, atterrissage post-essai, webhook store). */
  save(record: SubscriptionRecord): Promise<SubscriptionRecord>;
}
