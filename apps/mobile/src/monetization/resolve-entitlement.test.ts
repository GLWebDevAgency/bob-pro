import { describe, expect, it } from 'vitest';
import { resolveEntitlement } from './resolve-entitlement';

describe('resolveEntitlement — autorité abonnement fail-closed', () => {
  it('ferme la capacité sur erreur sans inventer de plan ni de paywall', () => {
    expect(resolveEntitlement({
      feature: 'voice_live',
      view: undefined,
      loading: false,
      failed: true,
    })).toEqual({ allowed: false, decision: null, loading: false, verified: false });
  });

  it('ferme aussi une capacité mise en cache quand son rafraîchissement échoue', () => {
    expect(resolveEntitlement({
      feature: 'voice_live',
      view: { tier: 'pro', status: 'active', features: ['voice_live'] },
      loading: false,
      failed: true,
    })).toEqual({ allowed: false, decision: null, loading: false, verified: false });
  });

  it('garde un chargement non vérifié fermé', () => {
    expect(resolveEntitlement({
      feature: 'voice_live',
      view: undefined,
      loading: true,
      failed: false,
    })).toEqual({ allowed: false, decision: null, loading: true, verified: false });
  });

  it('ouvre seulement une capacité présente dans la réponse serveur', () => {
    expect(resolveEntitlement({
      feature: 'voice_live',
      view: { tier: 'pro', status: 'active', features: ['voice_live'] },
      loading: false,
      failed: false,
    })).toEqual({ allowed: true, decision: null, loading: false, verified: true });
  });
});
