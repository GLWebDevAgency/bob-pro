import { describe, it, expect } from 'vitest';
import { ADDON_CATALOG, PLAN_CATALOG, planCan, resolveAutonomyEntitlement } from './plan';
import { Subscription } from './subscription';

describe('Offres & entitlements', () => {
  it('catalogue : Gratuit 0 € / Solo 14 € / Pro 39 € / Business 69 €', () => {
    expect(PLAN_CATALOG.free.priceCents).toBe(0);
    expect(PLAN_CATALOG.solo.priceCents).toBe(1400);
    expect(PLAN_CATALOG.pro.priceCents).toBe(3900);
    expect(PLAN_CATALOG.business.priceCents).toBe(6900);
    // Annuel ~ -20 %.
    expect(PLAN_CATALOG.pro.annualMonthlyCents).toBe(3100);
  });
  it('feature-gating : Solo = Essentials, Pro = Operations + paiement, Business = Control', () => {
    expect(planCan('free', 'ai_quota')).toBe(true);
    expect(planCan('free', 'ai_assistant')).toBe(false);
    expect(planCan('solo', 'ai_assistant')).toBe(true);
    expect(planCan('solo', 'bob_essentials')).toBe(true);
    expect(planCan('solo', 'bob_operations')).toBe(false);
    expect(planCan('pro', 'ai_assistant')).toBe(true);
    expect(planCan('pro', 'bob_operations')).toBe(true);
    expect(planCan('pro', 'online_payment')).toBe(true);
    expect(planCan('business', 'bob_control')).toBe(true);
    expect(planCan('business', 'online_payment')).toBe(true);
    expect(planCan('business', 'insurance')).toBe(false);
    expect(planCan('business', 'invoice_advance')).toBe(false);
    expect(planCan('pro', 'team')).toBe(false);
    expect(planCan('business', 'team')).toBe(true);
  });

  it('add-ons : assurance, avance et autonomie restent orthogonaux aux plans', () => {
    expect(ADDON_CATALOG.autonomy_confirm_outbound.priceCents).toBe(200);
    expect(ADDON_CATALOG.autonomy_auto.priceCents).toBe(500);
    expect(resolveAutonomyEntitlement('solo')).toBe('confirm_all');
    expect(resolveAutonomyEntitlement('solo', ['autonomy_confirm_outbound'])).toBe('confirm_outbound');
    expect(resolveAutonomyEntitlement('solo', ['autonomy_auto'])).toBe('auto');
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
    expect(pro.can('online_payment')).toBe(true);
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
    expect(s.can('insurance')).toBe(false);
    s.addAddOn('insurance');
    expect(s.can('insurance')).toBe(true);
  });
});
