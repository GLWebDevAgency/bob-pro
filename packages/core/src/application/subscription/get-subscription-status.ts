import { type Result, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type AppError } from '../result';
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
 * Repli HONNÊTE si aucune ligne n'existe encore (tenant provisionné avant cette migration,
 * ou jamais passé par registerCompany) : accès anticipé business/active, AUCUN essai fantôme —
 * jamais une échéance inventée.
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
  /** D'où vient la vérité : 'db' = ligne subscriptions du tenant ; 'early_access_fallback' =
   *  aucune ligne (tenant pré-migration) — l'appelant peut afficher l'accès anticipé honnête. */
  readonly source: 'db' | 'early_access_fallback';
}

const FALLBACK_NO_RECORD: SubscriptionStatusView = {
  plan: 'business',
  status: 'active',
  trialEndsAt: null,
  trialPhase: null,
  trialDaysLeft: null,
  currentPeriodEnd: null,
  store: null,
  storeRef: null,
  source: 'early_access_fallback',
};

export class GetSubscriptionStatus {
  constructor(private readonly deps: { subscriptions: SubscriptionRepository }) {}

  async execute(input: { companyId: string; now: Instant }): Promise<Result<SubscriptionStatusView, AppError>> {
    const record = await this.deps.subscriptions.findByCompanyId(input.companyId);
    if (record === null) return ok(FALLBACK_NO_RECORD);

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
