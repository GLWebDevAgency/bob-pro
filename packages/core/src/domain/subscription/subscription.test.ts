import { describe, it, expect } from 'vitest';
import { PLAN_CATALOG, planCan } from './plan';
import { Subscription } from './subscription';

describe('Offres & entitlements', () => {
  it('catalogue : Gratuit 0 € / Solo 14 € / Pro 29 € / Business 59 €', () => {
    expect(PLAN_CATALOG.free.priceCents).toBe(0);
    expect(PLAN_CATALOG.solo.priceCents).toBe(1400);
    expect(PLAN_CATALOG.pro.priceCents).toBe(2900);
    expect(PLAN_CATALOG.business.priceCents).toBe(5900);
    // Annuel ~ -20 %.
    expect(PLAN_CATALOG.pro.annualMonthlyCents).toBe(2400);
  });
  it('feature-gating : IA Bob = Pro+, paiement en ligne = Business', () => {
    expect(planCan('free', 'ai_quota')).toBe(true);
    expect(planCan('free', 'ai_assistant')).toBe(false);
    expect(planCan('solo', 'ai_assistant')).toBe(false); // Solo ne débloque PAS Bob illimité
    expect(planCan('pro', 'ai_assistant')).toBe(true);
    expect(planCan('pro', 'online_payment')).toBe(false); // paiement en ligne réservé à Business
    expect(planCan('business', 'online_payment')).toBe(true);
    expect(planCan('pro', 'team')).toBe(false);
    expect(planCan('business', 'team')).toBe(true);
  });
});

describe('Subscription', () => {
  const sub = (over: Parameters<typeof Subscription.start>[0]) => {
    const r = Subscription.start(over);
    if (!r.ok) throw new Error('sub');
    return r.value;
  };

  it('can() combine statut actif ET offre', () => {
    const pro = sub({ id: 's1', companyId: 'c1', tier: 'pro', status: 'active' });
    expect(pro.can('ai_assistant')).toBe(true);
    expect(pro.can('online_payment')).toBe(false); // Business uniquement
    expect(pro.can('team')).toBe(false);
  });
  it('un abonnement résilié n’ouvre plus rien', () => {
    const business = sub({ id: 's2', companyId: 'c1', tier: 'business', status: 'active' });
    business.cancel();
    expect(business.can('team')).toBe(false);
    expect(business.isActive()).toBe(false);
  });
  it('changement d’offre + cycle de vie', () => {
    const s = sub({ id: 's3', companyId: 'c1', tier: 'solo' });
    expect(s.status).toBe('trialing');
    s.changePlan('business');
    s.activate('2026-12-31T00:00:00.000Z');
    expect(s.tier).toBe('business');
    expect(s.status).toBe('active');
    expect(s.can('insurance')).toBe(true);
  });
});
