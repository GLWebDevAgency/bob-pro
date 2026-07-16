import { describe, expect, it } from 'vitest';
import {
  advanceGlobalBobSessionStopFence,
  deriveGlobalBobSessionStopReason,
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
      pathname: '/gallery',
    })).toBe('incompatible_route');
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
