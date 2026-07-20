import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_MILESTONES,
  NOOP_ANALYTICS,
  nextActivationMilestone,
  type ActivationMilestone,
  type TrackedEvent,
} from './analytics';

describe('nextActivationMilestone — le funnel du « aha », dans l’ordre', () => {
  it('compte neuf → onboarding_completed d’abord', () => {
    expect(nextActivationMilestone(new Set())).toBe('onboarding_completed');
  });

  it('avance jalon par jalon dans l’ordre du funnel', () => {
    const done = new Set<ActivationMilestone>(['onboarding_completed', 'first_document_created']);
    expect(nextActivationMilestone(done)).toBe('first_voice_action');
  });

  it('un jalon sauté reste LE prochain à provoquer (l’ordre prime sur la complétion)', () => {
    const done = new Set<ActivationMilestone>(['onboarding_completed', 'first_invoice_issued']);
    expect(nextActivationMilestone(done)).toBe('first_document_created');
  });

  it('activation complète → null (plus rien à provoquer)', () => {
    expect(nextActivationMilestone(new Set(ACTIVATION_MILESTONES))).toBeNull();
  });
});

describe('AnalyticsPort — contrat sans PII, jamais bloquant', () => {
  it('NOOP_ANALYTICS avale tout sans lever (opt-out RGPD, tests, démo)', () => {
    const event: TrackedEvent = {
      tenantId: 't-opaque',
      at: '2026-07-14T09:00:00.000Z',
      event: { name: 'paywall_viewed', feature: 'voice_live', source: 'voice_live_tap', decision: 'upgrade', requiredTier: 'pro' },
    };
    expect(() => NOOP_ANALYTICS.track(event)).not.toThrow();
  });

  it('le schéma force le tenant OPAQUE et l’horodatage FOURNI (jamais d’horloge domaine)', () => {
    // Contrat de compilation : TrackedEvent exige tenantId + at + event typé.
    const event: TrackedEvent = {
      tenantId: 't1',
      at: '2026-07-14T09:00:00.000Z',
      event: { name: 'trial_started', tier: 'pro', days: 14 },
    };
    expect(event.event.name).toBe('trial_started');
  });
});
