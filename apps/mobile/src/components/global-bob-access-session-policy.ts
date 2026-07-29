export type GlobalBobSessionStopReason =
  | 'entitlement_unconfirmed'
  | 'entitlement_revoked'
  | 'incompatible_route';

/**
 * Parcours où Bob est volontairement indisponible en V1 : Auth n'a aucune session exploitable ;
 * l'onboarding est authentifié mais reste un parcours de configuration explicitement exclu de
 * la parité vocale V1. L'y afficher promettrait une aide qu'il ne peut pas encore rendre.
 *
 * Une route est reconnue par égalité ou par préfixe de segment : `/auth` couvre `/auth/callback`
 * et `/auth/recovery`, sans jamais capturer un `/authentification` qui n'aurait rien à voir.
 */
export const BOB_ENTRY_ROUTES = Object.freeze(['/auth', '/onboarding'] as const);

export function isBobEntryRoute(pathname: string): boolean {
  const route = pathname.replace(/\/+$/, '') || '/';
  return BOB_ENTRY_ROUTES.some((entry) => route === entry || route.startsWith(`${entry}/`));
}

export function deriveGlobalBobSessionStopReason(input: {
  readonly subscriptionResolved: boolean;
  readonly entitled: boolean;
  readonly pathname: string;
}): GlobalBobSessionStopReason | null {
  // La route prime sur le droit : elle est connue localement et sans latence. Auth n'a aucune
  // session exploitable et l'onboarding est volontairement hors parité vocale pendant la V1.
  if (input.pathname === '/voix' || isBobEntryRoute(input.pathname)) return 'incompatible_route';
  if (!input.subscriptionResolved) return 'entitlement_unconfirmed';
  if (!input.entitled) return 'entitlement_revoked';
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
