import type { SubscriptionRecord, SubscriptionRepository } from '@bob/core';

/**
 * Abonnements en mémoire (pilier 2) — parité de contrat avec PrismaSubscriptionRepository :
 * une ligne par company (unique companyId), startTrial IDEMPOTENT (un retry de provisioning
 * ne réinitialise jamais une échéance d'essai), save = upsert complet.
 */
export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly byCompany = new Map<string, SubscriptionRecord>();

  async findByCompanyId(companyId: string): Promise<SubscriptionRecord | null> {
    const record = this.byCompany.get(companyId);
    return record ? { ...record } : null;
  }

  async startTrial(input: {
    id: string;
    companyId: string;
    plan: SubscriptionRecord['plan'];
    trialEndsAt: string;
    now: string;
  }): Promise<SubscriptionRecord> {
    const existing = this.byCompany.get(input.companyId);
    if (existing) return { ...existing };
    const record: SubscriptionRecord = {
      id: input.id,
      companyId: input.companyId,
      plan: input.plan,
      status: 'trialing',
      trialEndsAt: input.trialEndsAt,
      currentPeriodEnd: null,
      store: null,
      storeRef: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.byCompany.set(input.companyId, record);
    return { ...record };
  }

  async save(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    const stored: SubscriptionRecord = { ...record };
    this.byCompany.set(record.companyId, stored);
    return { ...stored };
  }
}
