import { describe, expect, it } from 'vitest';
import { diffPlanChange } from './plan-diff';
import {
  PAYWALL_MUTE_DAYS,
  decideProactiveUpsellPressure,
  decideReactivePaywallPressure,
} from './paywall-pressure';
import { buildTrialReport } from './trial-report';

describe('diffPlanChange — « tu gagnes / tu perds » depuis le catalogue, jamais rédigé à la main', () => {
  it('solo → pro : gains réels (voice_live, relances, tréso…) et delta +20 €', () => {
    const diff = diffPlanChange('solo', 'pro');
    expect(diff.gained).toContain('voice_live');
    expect(diff.gained).toContain('auto_dunning');
    expect(diff.lost).toEqual([]);
    expect(diff.monthlyDeltaCents).toBe(2000);
    expect(diff.aiActionsFrom).toBe(300);
    expect(diff.aiActionsTo).toBe(1500);
  });

  it('pro → solo (DOWNGRADE honnête) : les pertes ont le même poids que les gains', () => {
    const diff = diffPlanChange('pro', 'solo');
    expect(diff.lost).toContain('voice_live');
    expect(diff.lost).toContain('cashflow_forecast');
    expect(diff.gained).toEqual([]);
    expect(diff.monthlyDeltaCents).toBe(-2000); // une économie est un chiffre, pas une honte
  });

  it('free → payant : JAMAIS une perte fictive (ai_quota est remplacée par ai_assistant, pas perdue)', () => {
    for (const to of ['solo', 'pro', 'business'] as const) {
      const diff = diffPlanChange('free', to);
      expect(diff.lost).toEqual([]);
      expect(diff.gained).toContain('ai_assistant');
    }
    // Le downgrade vers free, lui, reste honnête : ai_assistant est bien une perte.
    expect(diffPlanChange('solo', 'free').lost).toContain('ai_assistant');
  });

  it('business → business : diff neutre (aucun mensonge par omission)', () => {
    const diff = diffPlanChange('business', 'business');
    expect(diff.gained).toEqual([]);
    expect(diff.lost).toEqual([]);
    expect(diff.monthlyDeltaCents).toBe(0);
  });
});

const NOW = '2026-07-14T09:00:00.000Z';
const CLEAN = {
  dismissalsForSource: 0,
  lastDismissedAt: null,
  lastVoiceRefusalAt: null,
  lastProactiveUpsellAt: null,
};

describe('gouvernance de pression — les règles structurelles anti-harcèlement', () => {
  it('historique propre → show (réactif comme proactif)', () => {
    expect(decideReactivePaywallPressure(CLEAN, NOW)).toEqual({ kind: 'show' });
    expect(decideProactiveUpsellPressure(CLEAN, NOW)).toEqual({ kind: 'show' });
  });

  it('ignoré 2 fois sur la même source → sourdine 14 jours, puis retour', () => {
    const history = { ...CLEAN, dismissalsForSource: 2, lastDismissedAt: '2026-07-10T09:00:00.000Z' };
    expect(decideReactivePaywallPressure(history, NOW)).toEqual({ kind: 'muted', reason: 'dismissed_twice' });
    const after = `2026-07-${10 + PAYWALL_MUTE_DAYS}T10:00:00.000Z`; // J+14 passés
    expect(decideReactivePaywallPressure(history, after)).toEqual({ kind: 'show' });
  });

  it("refus VOCAL → 30 jours de silence, plus fort qu’un tap, tous canaux", () => {
    const history = { ...CLEAN, lastVoiceRefusalAt: '2026-07-01T09:00:00.000Z' };
    expect(decideReactivePaywallPressure(history, NOW)).toEqual({ kind: 'muted', reason: 'voice_refusal' });
    expect(decideProactiveUpsellPressure(history, NOW)).toEqual({ kind: 'muted', reason: 'voice_refusal' });
    expect(decideReactivePaywallPressure(history, '2026-08-05T09:00:00.000Z')).toEqual({ kind: 'show' });
  });

  it('budget proactif : 1 proposition/semaine MAX, le paywall réactif n’est pas compté', () => {
    const history = { ...CLEAN, lastProactiveUpsellAt: '2026-07-10T09:00:00.000Z' };
    expect(decideProactiveUpsellPressure(history, NOW)).toEqual({ kind: 'muted', reason: 'weekly_budget' });
    expect(decideReactivePaywallPressure(history, NOW)).toEqual({ kind: 'show' }); // répondre au geste reste permis
  });
});

describe('buildTrialReport — recommandation CALCULÉE, downsell inclus', () => {
  it('usage 100 % Solo pendant l’essai Pro → recommande SOLO (moins cher, ça suffit)', () => {
    const report = buildTrialReport({ featuresUsed: ['ocr', 'ai_assistant'], digest: null });
    expect(report.recommendedTier).toBe('solo');
  });

  it('Bob Live utilisé → Pro (le plus petit palier couvrant l’usage réel)', () => {
    const report = buildTrialReport({ featuresUsed: ['ocr', 'voice_live'], digest: null });
    expect(report.recommendedTier).toBe('pro');
  });

  it('rien de payant utilisé → free (l’honnêteté jusqu’au bout)', () => {
    expect(buildTrialReport({ featuresUsed: [], digest: null }).recommendedTier).toBe('free');
  });

  it('une capacité d’équipe → business ; l’add-on pur ne force jamais le palier', () => {
    expect(buildTrialReport({ featuresUsed: ['team'], digest: null }).recommendedTier).toBe('business');
    expect(buildTrialReport({ featuresUsed: ['insurance'], digest: null }).recommendedTier).toBe('free');
  });
});
