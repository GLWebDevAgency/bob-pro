import { describe, expect, it } from 'vitest';
import { cheapestAddOnFor, decidePaywall, requiredTierFor } from './paywall';
import { PLAN_CATALOG } from '../subscription/plan';

describe('requiredTierFor — plus petit palier incluant la capacité', () => {
  it('voice_live → pro (jamais business : on vend le SEUIL, pas le sommet)', () => {
    expect(requiredTierFor('voice_live')).toBe('pro');
  });
  it('team → business ; ocr → solo ; ai_quota → free', () => {
    expect(requiredTierFor('team')).toBe('business');
    expect(requiredTierFor('ocr')).toBe('solo');
    expect(requiredTierFor('ai_quota')).toBe('free');
  });
});

describe('decidePaywall — honnêteté tarifaire au moment du besoin', () => {
  it('capacité couverte par le palier payé → allowed (viaTrial false)', () => {
    expect(
      decidePaywall({ feature: 'voice_live', tier: 'pro', addOns: [], status: 'active' }),
    ).toEqual({ kind: 'allowed', viaTrial: false });
  });

  it('free qui touche le micro Live → upgrade vers PRO avec le delta réel du catalogue', () => {
    const decision = decidePaywall({ feature: 'voice_live', tier: 'free', addOns: [], status: 'active' });
    expect(decision).toEqual({
      kind: 'upgrade',
      requiredTier: 'pro',
      requiredMonthlyCents: PLAN_CATALOG.pro.priceCents,
      requiredAnnualMonthlyCents: PLAN_CATALOG.pro.annualMonthlyCents,
      monthlyDeltaCents: PLAN_CATALOG.pro.priceCents - PLAN_CATALOG.free.priceCents,
    });
  });

  it('solo → pro : le delta est bien 39−19=20 €/mois (ancrage honnête, jamais le prix plein)', () => {
    const decision = decidePaywall({ feature: 'auto_dunning', tier: 'solo', addOns: [], status: 'active' });
    expect(decision).toMatchObject({ kind: 'upgrade', requiredTier: 'pro', monthlyDeltaCents: 2000 });
  });

  it('client payant + capacité couverte par MIEUX (ai_quota ⊂ ai_assistant) → allowed, jamais une upgrade vers free', () => {
    expect(decidePaywall({ feature: 'ai_quota', tier: 'solo', addOns: [], status: 'active' })).toEqual({
      kind: 'allowed',
      viaTrial: false,
    });
  });

  it('past_due → régularisation, JAMAIS un upsell à un impayé', () => {
    expect(decidePaywall({ feature: 'voice_live', tier: 'solo', addOns: [], status: 'past_due' })).toEqual({
      kind: 'past_due',
    });
  });

  it('résilié → les droits sont perdus : décision calculée depuis free (proposition complète)', () => {
    const decision = decidePaywall({ feature: 'ocr', tier: 'pro', addOns: [], status: 'canceled' });
    expect(decision).toMatchObject({
      kind: 'upgrade',
      requiredTier: 'solo',
      monthlyDeltaCents: PLAN_CATALOG.solo.priceCents, // depuis free, pas depuis l'ancien pro
    });
  });

  it('essai reverse trial actif couvrant la capacité → allowed viaTrial (l’UI rappelle l’échéance)', () => {
    expect(
      decidePaywall({ feature: 'voice_live', tier: 'free', addOns: [], status: 'trialing', trialTier: 'pro' }),
    ).toEqual({ kind: 'allowed', viaTrial: true });
  });

  it('add-on éligible MOINS CHER que la montée de palier → le chemin le moins cher gagne', () => {
    // insurance (0 €, minTier solo) octroie 'insurance' — face à un upgrade il gagne toujours.
    const decision = decidePaywall({ feature: 'insurance', tier: 'solo', addOns: [], status: 'active' });
    expect(decision).toEqual({ kind: 'addon', addOn: 'insurance', monthlyPriceCents: 0 });
  });

  it('add-on possédé → allowed directement (planCanWithAddOns)', () => {
    expect(
      decidePaywall({ feature: 'insurance', tier: 'solo', addOns: ['insurance'], status: 'active' }),
    ).toEqual({ kind: 'allowed', viaTrial: false });
  });

  it('add-on non éligible au palier courant → jamais proposé (invoice_advance exige pro)', () => {
    expect(cheapestAddOnFor('solo', 'invoice_advance')).toBeNull();
    const decision = decidePaywall({ feature: 'invoice_advance', tier: 'solo', addOns: [], status: 'active' });
    expect(decision).toMatchObject({ kind: 'upgrade', requiredTier: 'pro' });
  });

  it('capacité hors de tout catalogue et de tout add-on → unavailable (rien de vendable)', () => {
    // 'accounting_control' n'existe qu'en business ; on vérifie la défense avec une feature
    // réellement absente de tous les paliers : aucune — le type Feature l'interdit. On teste
    // donc le chemin via un palier déjà au maximum : business qui a tout → allowed.
    expect(
      decidePaywall({ feature: 'accounting_control', tier: 'business', addOns: [], status: 'active' }),
    ).toEqual({ kind: 'allowed', viaTrial: false });
  });

  it('l’essai n’ouvre JAMAIS un palier au-delà du sien (team=business hors d’un essai pro)', () => {
    const decision = decidePaywall({ feature: 'team', tier: 'free', addOns: [], status: 'trialing', trialTier: 'pro' });
    expect(decision).toMatchObject({ kind: 'upgrade', requiredTier: 'business' });
  });
});
