export type GlobalBobSessionStopReason =
  | 'entitlement_unconfirmed'
  | 'entitlement_revoked'
  | 'incompatible_route';

export function deriveGlobalBobSessionStopReason(input: {
  readonly subscriptionResolved: boolean;
  readonly entitled: boolean;
  readonly pathname: string;
}): GlobalBobSessionStopReason | null {
  if (!input.subscriptionResolved) return 'entitlement_unconfirmed';
  if (!input.entitled) return 'entitlement_revoked';
  if (input.pathname === '/gallery' || input.pathname === '/voix') return 'incompatible_route';
  return null;
}

/**
 * Fence synchrone d'un effet React : une même transition active→interdite coupe exactement une
 * fois. Le retour à une session inactive réarme la protection contre toute activation posthume.
 */
export function advanceGlobalBobSessionStopFence(input: {
  readonly latched: boolean;
  readonly sessionActive: boolean;
  readonly stopReason: GlobalBobSessionStopReason | null;
}): { readonly latched: boolean; readonly shouldStop: boolean } {
  if (!input.sessionActive || input.stopReason === null) {
    return Object.freeze({ latched: false, shouldStop: false });
  }
  if (input.latched) return Object.freeze({ latched: true, shouldStop: false });
  return Object.freeze({ latched: true, shouldStop: true });
}
