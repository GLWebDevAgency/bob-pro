import type { AgentContext } from '@bob/ai';
import type { RealtimeFallbackReason } from '../realtime/realtime-transport';
import type { LegacyFallbackChannel } from '../realtime/realtime-recovery-policy';

/** Le pilote qui possede l'oreille et la bouche a un instant donne. */
export type AgentSessionDriver = 'idle' | 'live_bootstrap' | 'live' | 'legacy';

export type AgentSessionFallbackPlan =
  | { readonly driver: 'legacy'; readonly continueVoice: true; readonly issue: null }
  | {
      readonly driver: 'idle';
      readonly continueVoice: false;
      readonly issue: 'denied' | 'unavailable';
    };

/** Le canal décidé par la policy est autoritaire : `text_only` ne retente jamais un micro. */
export function planAgentSessionFallback(
  reason: RealtimeFallbackReason,
  channel: LegacyFallbackChannel,
): AgentSessionFallbackPlan {
  if (channel === 'voice') {
    return Object.freeze({ driver: 'legacy', continueVoice: true, issue: null });
  }
  return Object.freeze({
    driver: 'idle',
    continueVoice: false,
    issue: reason === 'microphone_denied' ? 'denied' : 'unavailable',
  });
}

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

export interface AgentSessionBackgroundRevalidation {
  readonly waitForPermissionRequests: () => Promise<void>;
  readonly waitForLifecycleStabilization: () => Promise<void>;
  readonly currentAppState: () => string;
  readonly isMounted: () => boolean;
  readonly stop: () => void;
}

/**
 * Diffère la décision pendant la boîte Android, puis la reprend sans angle mort de confidentialité.
 * Aucun timer n'atteste quoi que ce soit : seule la fermeture effective des demandes de permission
 * autorise la relecture de l'état AppState. Un échec inattendu du waiter reste fail-closed si Bob
 * est encore réellement en arrière-plan.
 */
export async function revalidateAgentSessionBackgroundAfterPermission(
  input: AgentSessionBackgroundRevalidation,
): Promise<boolean> {
  try {
    await input.waitForPermissionRequests();
  } catch {
    // Le coordinateur local ne rejette pas aujourd'hui. Si son contrat dérive, la revalidation
    // AppState ci-dessous reste plus sûre que de laisser le micro actif sans propriétaire visible.
  }
  if (!input.isMounted()) return false;
  await input.waitForLifecycleStabilization();
  if (!input.isMounted() || input.currentAppState() !== 'background') return false;
  input.stop();
  return true;
}
