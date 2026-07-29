import { describe, expect, it } from 'vitest';
import {
  advanceGlobalBobSessionStopFence,
  deriveGlobalBobSessionStopReason,
  isBobEntryRoute,
} from './global-bob-access-session-policy';

describe('GlobalBobAccess — session masquée fail-closed', () => {
  it('ferme une session dont le droit n’est plus confirmé ou vient d’être révoqué', () => {
    expect(deriveGlobalBobSessionStopReason({
      subscriptionResolved: false,
      entitled: false,
      pathname: '/',
    })).toBe('entitlement_unconfirmed');
    expect(deriveGlobalBobSessionStopReason({
      subscriptionResolved: true,
      entitled: false,
      pathname: '/',
    })).toBe('entitlement_revoked');
    expect(deriveGlobalBobSessionStopReason({
      subscriptionResolved: true,
      entitled: true,
      pathname: '/',
    })).toBeNull();
  });

  it('ferme les routes incompatibles mais conserve la session dans son Assistant', () => {
    expect(deriveGlobalBobSessionStopReason({
      subscriptionResolved: true,
      entitled: true,
      pathname: '/voix',
    })).toBe('incompatible_route');
    expect(deriveGlobalBobSessionStopReason({
      subscriptionResolved: true,
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
        subscriptionResolved: false,
        entitled: false,
        pathname,
      })).toBe('incompatible_route');
      expect(deriveGlobalBobSessionStopReason({
        subscriptionResolved: true,
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
});
