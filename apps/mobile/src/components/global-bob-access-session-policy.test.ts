import { describe, expect, it } from 'vitest';
import {
  advanceGlobalBobSessionStopFence,
  deriveGlobalBobRecoveryAction,
  deriveGlobalBobRecoveryPresentation,
  deriveGlobalBobSessionStopReason,
  navigateGlobalBobTextRecovery,
  isBobEntryRoute,
  isGlobalBobSubscriptionVerified,
} from './global-bob-access-session-policy';
import { consumeAssistantTextRecoveryFocus } from '../assistant/text-recovery-focus';

describe('GlobalBobAccess — session masquée fail-closed', () => {
  it('refuse comme autorité un payload en cache dont le refetch a échoué', () => {
    expect(isGlobalBobSubscriptionVerified({ hasPayload: true, failed: false })).toBe(true);
    expect(isGlobalBobSubscriptionVerified({ hasPayload: true, failed: true })).toBe(false);
    expect(isGlobalBobSubscriptionVerified({ hasPayload: false, failed: false })).toBe(false);
  });

  it('ferme une session dont le droit n’est plus confirmé ou vient d’être révoqué', () => {
    expect(deriveGlobalBobSessionStopReason({
      subscriptionVerified: false,
      entitled: false,
      pathname: '/',
    })).toBe('entitlement_unconfirmed');
    expect(deriveGlobalBobSessionStopReason({
      subscriptionVerified: true,
      entitled: false,
      pathname: '/',
    })).toBe('entitlement_revoked');
    expect(deriveGlobalBobSessionStopReason({
      subscriptionVerified: true,
      entitled: true,
      pathname: '/',
    })).toBeNull();
  });

  it('ferme les routes incompatibles mais conserve la session dans son Assistant', () => {
    expect(deriveGlobalBobSessionStopReason({
      subscriptionVerified: true,
      entitled: true,
      pathname: '/voix',
    })).toBe('incompatible_route');
    expect(deriveGlobalBobSessionStopReason({
      subscriptionVerified: true,
      entitled: true,
      pathname: '/assistant',
    })).toBeNull();
  });

  it('n’apparaît sur aucun parcours d’entrée, y compris quand l’abonnement est illisible', () => {
    // Cas réel du 29/07/2026 : pendant l'onboarding le tenant n'existe pas encore, l'appel
    // d'abonnement échoue, et le filet `entitlementUnavailable` affichait Bob là où il ne
    // pouvait rien faire. La route doit trancher AVANT le droit, sans attendre le réseau.
    for (const pathname of ['/onboarding', '/auth', '/auth/callback', '/auth/recovery']) {
      expect(deriveGlobalBobSessionStopReason({
        subscriptionVerified: false,
        entitled: false,
        pathname,
      })).toBe('incompatible_route');
      expect(deriveGlobalBobSessionStopReason({
        subscriptionVerified: true,
        entitled: true,
        pathname,
      })).toBe('incompatible_route');
      expect(isBobEntryRoute(pathname)).toBe(true);
    }
  });

  it('ne confond pas un préfixe de segment avec une route qui commence pareil', () => {
    for (const pathname of ['/', '/assistant', '/authentification', '/onboarding-terminal', '/compte']) {
      expect(isBobEntryRoute(pathname)).toBe(false);
    }
    expect(isBobEntryRoute('/onboarding/')).toBe(true);
  });

  it('coupe exactement une fois puis se réarme contre une activation posthume', () => {
    const reason = 'entitlement_revoked' as const;
    const first = advanceGlobalBobSessionStopFence({
      latched: false,
      sessionActive: true,
      stopReason: reason,
    });
    expect(first).toEqual({ latched: true, shouldStop: true });
    const duplicateRender = advanceGlobalBobSessionStopFence({
      latched: first.latched,
      sessionActive: true,
      stopReason: reason,
    });
    expect(duplicateRender).toEqual({ latched: true, shouldStop: false });
    const stopped = advanceGlobalBobSessionStopFence({
      latched: duplicateRender.latched,
      sessionActive: false,
      stopReason: reason,
    });
    expect(stopped).toEqual({ latched: false, shouldStop: false });
    expect(advanceGlobalBobSessionStopFence({
      latched: stopped.latched,
      sessionActive: true,
      stopReason: reason,
    }).shouldStop).toBe(true);
    expect(advanceGlobalBobSessionStopFence({
      latched: false,
      sessionActive: true,
      stopReason: 'entitlement_unconfirmed',
    }).shouldStop).toBe(true);
  });

  it('propose le texte uniquement après une issue terminale inactive', () => {
    for (const issue of ['denied', 'unavailable', 'failed'] as const) {
      expect(deriveGlobalBobRecoveryAction({
        active: false,
        reviewRequired: false,
        hasHandoff: false,
        issue,
      })).toBe('write_in_assistant');
    }
    expect(deriveGlobalBobRecoveryAction({
      active: true,
      reviewRequired: false,
      hasHandoff: false,
      issue: 'failed',
    })).toBe('none');
    expect(deriveGlobalBobRecoveryAction({
      active: false,
      reviewRequired: false,
      hasHandoff: false,
      issue: null,
    })).toBe('none');
  });

  it('conserve le handoff scellé comme unique action prioritaire', () => {
    expect(deriveGlobalBobRecoveryAction({
      active: false,
      reviewRequired: true,
      hasHandoff: true,
      issue: 'failed',
    })).toBe('continue_in_assistant');
    expect(deriveGlobalBobRecoveryAction({
      active: false,
      reviewRequired: true,
      hasHandoff: false,
      issue: 'failed',
    })).toBe('write_in_assistant');
  });

  it('la sortie texte navigue vers l’Assistant sans autre capacité injectable', () => {
    expect(consumeAssistantTextRecoveryFocus()).toBe(false);
    const routes: string[] = [];
    navigateGlobalBobTextRecovery((route) => routes.push(route));
    expect(routes).toEqual(['/(tabs)/assistant']);
    expect(consumeAssistantTextRecoveryFocus()).toBe(true);
    expect(consumeAssistantTextRecoveryFocus()).toBe(false);
  });

  it('le dismiss démonte et désannonce atomiquement une récupération même si un état stale subsiste', () => {
    expect(deriveGlobalBobRecoveryPresentation({
      response: 'La dictée locale est indisponible.',
      active: false,
      reviewRequired: false,
      hasHandoff: false,
      issue: 'unavailable',
    })).toEqual({ cardVisible: true, action: 'write_in_assistant' });
    expect(deriveGlobalBobRecoveryPresentation({
      response: null,
      active: false,
      reviewRequired: false,
      hasHandoff: false,
      issue: 'unavailable',
    })).toEqual({ cardVisible: false, action: 'none' });
  });
});
