export type GlobalBobSessionStopReason =
  | 'entitlement_unconfirmed'
  | 'entitlement_revoked'
  | 'incompatible_route';

/**
 * Parcours d'ENTRÉE : l'utilisateur n'est pas encore connecté, ou son espace de travail n'existe
 * pas encore. Bob n'y a aucune donnée à lire, aucun geste à poser, aucune question à laquelle
 * répondre — l'y afficher promet une aide qu'il ne peut pas rendre, et le premier contact avec
 * l'assistant se solde par une déception. Il apparaît une fois l'utilisateur DANS l'application.
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
  // La route prime sur le droit : elle est connue localement et sans latence, là où l'abonnement
  // dépend d'un appel réseau qui, pendant l'onboarding, échoue par construction (pas de tenant).
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
