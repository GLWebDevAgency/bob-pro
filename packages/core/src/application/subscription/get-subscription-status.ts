import { type Result, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { appUnavailable, type AppError } from '../result';
import { type PlanTier } from '../../domain/subscription/plan';
import { type SubscriptionStatus } from '../../domain/subscription/subscription';
import { type SubscriptionRepository, type SubscriptionStore } from '../ports/subscription-repository';
import { trialDaysLeft, trialPhase, type TrialPhase } from '../../domain/monetization/trial';

/**
 * GetSubscriptionStatus (pilier 2) — LA lecture d'autorité de l'abonnement d'un tenant,
 * source de vérité DB (table `subscriptions`) au lieu du stub early-access historique
 * (`BackendService.subscriptionFor`, toujours business/active — CONSERVÉ pour le gating
 * interne existant, hors scope de ce use case ; cf. SPEC_PILIER2_MONETISATION.md « reste à
 * implémenter #4 »). Branché par : GET /subscription (mobile), le bilan de fin d'essai et
 * l'affordance vocale « où en est mon abonnement / mon essai » (lecture seule).
 *
 * `plan` porte TOUJOURS le palier GRANTÉ maintenant : pendant l'essai inversé (status
 * 'trialing'), c'est le palier prêté (Pro par défaut, startReverseTrial @bob/core) ; une fois
 * atterri (checkout ou descente douce en fin d'essai), c'est le palier réellement payé. Le
 * même champ porte les deux réalités dans le temps — jamais une ambiguïté à un instant donné.
 *
 * L'absence de ligne est une erreur de provisioning explicite. Le use case ne transforme jamais
 * cette absence en offre commerciale, même conservatrice : les appelants échouent fermés.
 */
export interface SubscriptionStatusView {
  readonly plan: PlanTier;
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: Instant | null;
  /** null hors essai (jamais démarré, ou statut différent de 'trialing'). */
  readonly trialPhase: TrialPhase | null;
  readonly trialDaysLeft: number | null;
  readonly currentPeriodEnd: Instant | null;
  readonly store: SubscriptionStore | null;
  readonly storeRef: string | null;
  /** La seule autorité admise est la ligne persistée du tenant. */
  readonly source: 'db';
}

export class GetSubscriptionStatus {
  constructor(private readonly deps: { subscriptions: SubscriptionRepository }) {}

  async execute(input: { companyId: string; now: Instant }): Promise<Result<SubscriptionStatusView, AppError>> {
    const record = await this.deps.subscriptions.findByCompanyId(input.companyId);
    if (record === null) return err(appUnavailable('subscription'));

    // L'essai inversé n'existe QUE pendant status='trialing' avec une échéance posée — un
    // statut atterri (active/canceled/past_due) n'a plus de phase d'essai, même si trialEndsAt
    // traîne encore en base (trace historique, jamais réinterprétée comme un essai courant).
    const trialActive = record.status === 'trialing' && record.trialEndsAt !== null;
    const trial = trialActive ? { tier: record.plan, startedAt: record.createdAt, endsAt: record.trialEndsAt! } : null;

    return ok({
      plan: record.plan,
      status: record.status,
      trialEndsAt: record.trialEndsAt,
      trialPhase: trial === null ? null : trialPhase(trial, input.now),
      trialDaysLeft: trial === null ? null : trialDaysLeft(trial, input.now),
      currentPeriodEnd: record.currentPeriodEnd,
      store: record.store,
      storeRef: record.storeRef,
      source: 'db',
    });
  }
}
