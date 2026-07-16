import type { AgentContext } from '@bob/ai';

/** Le pilote qui possede l'oreille et la bouche a un instant donne. */
export type AgentSessionDriver = 'idle' | 'live_bootstrap' | 'live' | 'legacy';

export function realtimeOwnsAgentSession(driver: AgentSessionDriver): boolean {
  return driver === 'live_bootstrap' || driver === 'live';
}

/**
 * Empreinte semantique du seul contexte envoye au cerveau serveur.
 *
 * L'ordre des entites est intentionnel : « le deuxieme resultat » depend de cet ordre. Les
 * references React, le layout et les affordances locales n'y entrent jamais, afin qu'une simple
 * rerender ne coupe pas le micro alors qu'une hydratation metier le fait toujours.
 */
export function agentContextSemanticKey(context: AgentContext): string {
  return JSON.stringify([
    1,
    context.screen.name,
    context.screen.instanceId,
    context.entities.map((entity) => [entity.type, entity.id, entity.label]),
    context.capabilities,
  ]);
}

/**
 * `inactive` est transitoire sur iOS. Android peut, lui, publier `background` pendant la boîte
 * système de permission micro : cette transition ne doit jamais tuer la session que l'utilisateur
 * vient précisément d'ouvrir. Le vrai background hors permission reste autoritaire.
 */
export function shouldStopAgentSessionForAppState(
  state: string,
  permissionRequestInFlight = false,
): boolean {
  return state === 'background' && !permissionRequestInFlight;
}
