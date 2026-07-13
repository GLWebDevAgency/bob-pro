import { randomUUID } from 'node:crypto';
import type { PlanTier } from '@bob/core';
import { requestContext } from '../../observability/logger';
import type { Persistence } from '../../persistence/persistence';

export interface RealtimeEntitlementDecision {
  readonly allowed: boolean;
  readonly plan: PlanTier;
}

export interface RealtimeEntitlementPort {
  check(input: { userId: string; companyId: string }): Promise<RealtimeEntitlementDecision>;
}

export interface RealtimeEntitlementExecutor {
  realtimeVoiceEntitlement(): RealtimeEntitlementDecision;
}

/** Recrée une portée tenant courte : aucun résultat d'abonnement n'est partagé entre sessions. */
export class RealtimeBackendEntitlementAdapter implements RealtimeEntitlementPort {
  constructor(
    private readonly persistence: Persistence,
    private readonly resolveExecutor: () => RealtimeEntitlementExecutor,
  ) {}

  async check(input: { userId: string; companyId: string }): Promise<RealtimeEntitlementDecision> {
    return requestContext.run(
      {
        correlationId: `bob-live-entitlement-${randomUUID()}`,
        principal: { userId: input.userId, companyId: input.companyId },
      },
      () => this.persistence.runWithTenant(
        input.companyId,
        () => Promise.resolve(this.resolveExecutor().realtimeVoiceEntitlement()),
      ),
    );
  }
}
