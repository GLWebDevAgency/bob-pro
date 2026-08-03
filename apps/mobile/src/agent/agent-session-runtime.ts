import type { AgentContext } from '@bob/ai';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
  type RealtimeAgentMissionProtocolVersion,
} from '@bob/api-client';
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

export interface AgentSessionFailedClosedPlan {
  readonly driver: 'idle';
  readonly active: false;
  readonly issue: 'failed';
  readonly phase: 'error';
  readonly responseKey: 'live.error';
}

/** Une autorité Mission perdue ferme l'orbe sans jamais armer le pilote legacy. */
export function planAgentSessionFailedClosed(): AgentSessionFailedClosedPlan {
  return Object.freeze({
    driver: 'idle',
    active: false,
    issue: 'failed',
    phase: 'error',
    responseKey: 'live.error',
  });
}

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
 * Une mission M2-A possède sa reprise durable. La recréer via l'orchestrateur générique
 * dupliquerait la capability puis masquerait la première cause terminale derrière un 429.
 * Le runtime Conversation V2 garde le même contrat, y compris avant M2-A.
 */
export function realtimeGenericReconnectBudget(
  agentMissionProtocolVersion: RealtimeAgentMissionProtocolVersion | null,
  conversationRuntimeOwnsRecovery: boolean,
): 0 | 1 {
  return agentMissionProtocolVersion === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
    || conversationRuntimeOwnsRecovery
    ? 0
    : 1;
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

/**
 * S3 — ORBE HONNÊTE : grâce avant de constater qu'une écoute annoncée n'a plus d'oreille.
 * Alignée sur la grâce du résultat terminal natif (un final peut suivre `end` de quelques ms).
 */
export const LEGACY_LISTENING_SILENCE_GRACE_MS = 350;

export interface LegacyListeningSilenceInput {
  readonly active: boolean;
  readonly driver: AgentSessionDriver;
  readonly phase: string;
  readonly voiceListening: boolean;
}

/**
 * S3 — ORBE HONNÊTE : la reco native se termine SEULE sur silence (ni résultat, ni onIssue).
 * Sans ce constat, l'orbe promet « Je t'écoute… » micro fermé. Vrai UNIQUEMENT pour le pilote
 * legacy : en temps réel, la phase vient du serveur et l'oreille locale est volontairement
 * fermée — ce n'est jamais un silence à rattraper.
 */
export function shouldRecoverLegacyListeningSilence(input: LegacyListeningSilenceInput): boolean {
  return (
    input.active
    && input.driver === 'legacy'
    && input.phase === 'listening'
    && !input.voiceListening
  );
}

/**
 * S4 — CONTINUITÉ MAINS-LIBRES : le handoff se PRONONCE avant la mise en veille — le corps de
 * la réponse PUIS la consigne (« ça se termine dans l'Assistant »). Mains libres, l'utilisateur
 * sait quoi faire sans regarder l'écran ; l'affichage, lui, garde les deux textes séparés.
 */
export function composeHandoffSpeech(body: string, reviewInstruction: string): string {
  const trimmedBody = body.trim();
  const instruction = reviewInstruction.trim();
  if (trimmedBody === '') return instruction;
  if (instruction === '') return trimmedBody;
  return `${trimmedBody} ${instruction}`;
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
