import type { SubscriptionRecord, SubscriptionRepository } from '@bob/core';

/** Double déterministe réservé au harness de tests API. */
export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly byCompany = new Map<string, SubscriptionRecord>();

  async findByCompanyId(companyId: string): Promise<SubscriptionRecord | null> {
    const record = this.byCompany.get(companyId);
    return record ? { ...record } : null;
  }

  async startEarlyAccess(input: {
    id: string;
    companyId: string;
    plan: SubscriptionRecord['plan'];
    now: string;
  }): Promise<SubscriptionRecord> {
    const existing = this.byCompany.get(input.companyId);
    if (existing) return { ...existing };
    const record: SubscriptionRecord = {
      id: input.id,
      companyId: input.companyId,
      plan: input.plan,
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: null,
      store: 'none',
      storeRef: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.byCompany.set(input.companyId, record);
    return { ...record };
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
