import { describe, expect, it } from 'vitest';
import { GetSubscriptionStatus } from './get-subscription-status';
import { type SubscriptionRecord, type SubscriptionRepository } from '../ports/subscription-repository';

class FakeSubscriptionRepository implements SubscriptionRepository {
  private readonly byCompany = new Map<string, SubscriptionRecord>();
  seed(record: SubscriptionRecord): void {
    this.byCompany.set(record.companyId, record);
  }
  async findByCompanyId(companyId: string): Promise<SubscriptionRecord | null> {
    return this.byCompany.get(companyId) ?? null;
  }
  async startTrial(input: {
    id: string;
    companyId: string;
    plan: SubscriptionRecord['plan'];
    trialEndsAt: string;
    now: string;
  }): Promise<SubscriptionRecord> {
    const existing = this.byCompany.get(input.companyId);
    if (existing) return existing;
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
    return record;
  }
  async save(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    this.byCompany.set(record.companyId, record);
    return record;
  }
}

const T0 = '2026-07-14T09:00:00.000Z';

describe('GetSubscriptionStatus — source de vérité DB (pilier 2)', () => {
  it('aucune ligne (tenant pré-migration) → repli HONNÊTE early-access, aucun essai fantôme', async () => {
    const repo = new FakeSubscriptionRepository();
    const useCase = new GetSubscriptionStatus({ subscriptions: repo });

    const r = await useCase.execute({ companyId: 'co-legacy', now: T0 });

    expect(r.ok && r.value).toEqual({
      plan: 'business',
      status: 'active',
      trialEndsAt: null,
      trialPhase: null,
      trialDaysLeft: null,
      currentPeriodEnd: null,
      store: null,
      storeRef: null,
      source: 'early_access_fallback',
    });
  });

  it('essai inversé en cours (trialing, Pro prêté) → plan = pro, phase active, jours restants', async () => {
    const repo = new FakeSubscriptionRepository();
    await repo.startTrial({ id: 'sub-co-a', companyId: 'co-a', plan: 'pro', trialEndsAt: '2026-07-28T09:00:00.000Z', now: T0 });
    const useCase = new GetSubscriptionStatus({ subscriptions: repo });

    const r = await useCase.execute({ companyId: 'co-a', now: T0 });

    expect(r.ok && r.value).toMatchObject({
      plan: 'pro',
      status: 'trialing',
      trialPhase: 'active',
      trialDaysLeft: 14,
      source: 'db',
    });
  });

  it('à 2 jours de l’échéance → phase ending_soon (le moment de décider, jamais de harcèlement)', async () => {
    const repo = new FakeSubscriptionRepository();
    repo.seed({
      id: 'sub-co-a',
      companyId: 'co-a',
      plan: 'pro',
      status: 'trialing',
      trialEndsAt: '2026-07-16T09:00:00.000Z',
      currentPeriodEnd: null,
      store: null,
      storeRef: null,
      createdAt: '2026-07-02T09:00:00.000Z',
      updatedAt: '2026-07-02T09:00:00.000Z',
    });
    const useCase = new GetSubscriptionStatus({ subscriptions: repo });

    const r = await useCase.execute({ companyId: 'co-a', now: '2026-07-14T09:00:00.000Z' });

    expect(r.ok && r.value.trialPhase).toBe('ending_soon');
    expect(r.ok && r.value.trialDaysLeft).toBe(2);
  });

  it('essai expiré (trialEndsAt dépassé) → phase expired, 0 jour restant', async () => {
    const repo = new FakeSubscriptionRepository();
    repo.seed({
      id: 'sub-co-a',
      companyId: 'co-a',
      plan: 'pro',
      status: 'trialing',
      trialEndsAt: '2026-07-01T09:00:00.000Z',
      currentPeriodEnd: null,
      store: null,
      storeRef: null,
      createdAt: '2026-06-17T09:00:00.000Z',
      updatedAt: '2026-06-17T09:00:00.000Z',
    });
    const useCase = new GetSubscriptionStatus({ subscriptions: repo });

    const r = await useCase.execute({ companyId: 'co-a', now: T0 });

    expect(r.ok && r.value).toMatchObject({ plan: 'pro', trialPhase: 'expired', trialDaysLeft: 0 });
  });

  it('abonnement actif payé (hors essai) → aucune phase d’essai, même avec un trialEndsAt historique', async () => {
    const repo = new FakeSubscriptionRepository();
    repo.seed({
      id: 'sub-co-a',
      companyId: 'co-a',
      plan: 'solo',
      status: 'active',
      trialEndsAt: '2026-06-01T09:00:00.000Z',
      currentPeriodEnd: '2026-08-14T09:00:00.000Z',
      store: 'apple',
      storeRef: 'txn-123',
      createdAt: '2026-05-17T09:00:00.000Z',
      updatedAt: '2026-06-01T09:00:00.000Z',
    });
    const useCase = new GetSubscriptionStatus({ subscriptions: repo });

    const r = await useCase.execute({ companyId: 'co-a', now: T0 });

    expect(r.ok && r.value).toMatchObject({
      plan: 'solo',
      status: 'active',
      trialPhase: null,
      trialDaysLeft: null,
      currentPeriodEnd: '2026-08-14T09:00:00.000Z',
      store: 'apple',
      storeRef: 'txn-123',
    });
  });

  it('startTrial est IDEMPOTENT : un retry de provisioning ne réinitialise jamais l’échéance', async () => {
    const repo = new FakeSubscriptionRepository();
    const first = await repo.startTrial({ id: 'sub-co-a', companyId: 'co-a', plan: 'pro', trialEndsAt: '2026-07-28T09:00:00.000Z', now: T0 });
    const retry = await repo.startTrial({
      id: 'sub-co-a',
      companyId: 'co-a',
      plan: 'pro',
      trialEndsAt: '2026-08-01T09:00:00.000Z', // un retry plus tardif ne doit RIEN décaler
      now: '2026-07-15T09:00:00.000Z',
    });

    expect(retry).toEqual(first);
    expect(retry.trialEndsAt).toBe('2026-07-28T09:00:00.000Z');
  });
});
