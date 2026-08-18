import type { AgentContext } from '@bob/ai';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
  type RealtimeAgentMissionProtocolVersion,
} from '@bob/api-client';
import type { RealtimeVoiceClientPolicyCloseReason } from '@bob/core';
import type { RealtimeFallbackReason } from '../realtime/realtime-transport';
import type { LegacyFallbackChannel } from '../realtime/realtime-recovery-policy';
import type { RealtimeSessionStopReceipt } from './realtime-session';

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

export interface AgentRealtimeStopPort {
  stop(reason: 'user' | 'background' | 'unmount'): Promise<RealtimeSessionStopReceipt>;
  stopForPolicy(reason: RealtimeVoiceClientPolicyCloseReason): Promise<RealtimeSessionStopReceipt>;
  stopAfterManualHandoff(): Promise<void>;
}

/**
 * Une demande d'arrêt n'est acquittée qu'après fermeture du transport ET restitution Mission.
 * Un verdict incertain est rejoué une fois sur la même autorité ; il ne devient jamais un faux
 * `idle`. Le prochain geste utilisateur pourra encore retenter le contrôleur conservé.
 */
export async function closeAgentRealtimeController(input: {
  readonly controller: AgentRealtimeStopPort | null;
  readonly reason: 'user' | 'background' | 'unmount';
  readonly policyReason?: RealtimeVoiceClientPolicyCloseReason | null;
  readonly afterManualHandoff?: boolean;
}): Promise<'closed' | 'unconfirmed'> {
  const controller = input.controller;
  if (controller === null) return 'closed';
  try {
    if (input.afterManualHandoff === true) {
      await controller.stopAfterManualHandoff();
      return 'closed';
    }
    const first = input.policyReason
      ? await controller.stopForPolicy(input.policyReason)
      : await controller.stop(input.reason);
    if (first.status === 'closed') return 'closed';
  } catch {
    // La même autorité reste possédée : le retry ci-dessous est le seul geste permis.
  }
  try {
    const retry = await controller.stop(input.reason);
    return retry.status;
  } catch {
    return 'unconfirmed';
  }
}

export type AgentRealtimeControllerAcquisition<T> =
  | { readonly kind: 'owned'; readonly controller: T }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'failed' };

/** Une continuation de bootstrap ne peut modifier l'UI que si sa génération possède encore la
 * session. Le cas superseded est volontairement inerte, même si aucun controller n'a été rendu. */
export function classifyAgentRealtimeControllerAcquisition<T>(input: {
  readonly generation: number;
  readonly currentGeneration: number;
  readonly active: boolean;
  readonly driver: AgentSessionDriver;
  readonly appState: string;
  readonly controller: T | null;
}): AgentRealtimeControllerAcquisition<T> {
  if (input.generation !== input.currentGeneration) return { kind: 'superseded' };
  if (
    !input.active
    || !realtimeOwnsAgentSession(input.driver)
    || input.appState !== 'active'
    || input.controller === null
  ) return { kind: 'failed' };
  return { kind: 'owned', controller: input.controller };
}

interface AgentRealtimeControllerBinding<Controller, Client, Checkpoint> {
  readonly leaseId: number;
  readonly controller: Controller;
  readonly client: Client;
  checkpointUsed: Checkpoint | null;
  usable: boolean;
}

export interface AgentRealtimeControllerLease<Client, Checkpoint> {
  readonly client: Client;
  readonly getCheckpoint: () => Checkpoint | null;
  readonly recordCheckpointUsed: (checkpoint: Checkpoint | null) => void;
  readonly isCurrent: () => boolean;
}

/** Registre sérialisé : controller, client et checkpoint forment un seul binding atomique. */
export class AgentRealtimeControllerRegistry<Controller, Client, Checkpoint> {
  private binding: AgentRealtimeControllerBinding<Controller, Client, Checkpoint> | null = null;
  private serial: Promise<void> = Promise.resolve();
  private nextLeaseId = 0;

  /** Seule une autorité utilisable peut être appelée par l'UI. Le binding retenu après une
   * fermeture incertaine reste privé au registre afin que `close`/`acquire` puissent le retenter. */
  peek(): Controller | null {
    return this.binding?.usable === true ? this.binding.controller : null;
  }

  owns(controller: Controller): boolean {
    return this.binding?.usable === true && this.binding.controller === controller;
  }

  hasMismatch(desired: { client: Client; checkpoint: Checkpoint | null }): boolean {
    const binding = this.binding;
    return binding !== null && this.bindingMismatch(binding, desired);
  }

  async acquire(input: {
    readonly readDesired: () => { client: Client; checkpoint: Checkpoint | null };
    readonly create: (
      lease: AgentRealtimeControllerLease<Client, Checkpoint>,
    ) => Controller;
    readonly closeStale: (controller: Controller) => Promise<'closed' | 'unconfirmed'>;
  }): Promise<Controller | null> {
    const bindingAtCall = this.binding;
    if (
      bindingAtCall !== null
      && (
        !bindingAtCall.usable
        || this.bindingMismatch(bindingAtCall, input.readDesired())
      )
    ) {
      // Une rotation demandée fence l'ancien controller dans la pile appelante, avant même la
      // microtâche du mutex. Ses hooks ne disposent d'aucune fenêtre pour repeindre la future UI.
      bindingAtCall.usable = false;
    }
    return this.exclusive(async () => {
      let desired = input.readDesired();
      const current = this.binding;
      if (current !== null && current.usable && !this.hasMismatch(desired)) {
        return current.controller;
      }
      if (current !== null) {
        // Fencer les hooks AVANT le premier await : un controller en rotation/fermeture ne peut
        // jamais redevenir l'autorité UI parce qu'un begin concurrent a réarmé la session.
        current.usable = false;
        if (await input.closeStale(current.controller) !== 'closed') return null;
        if (this.binding === current) this.binding = null;
        desired = input.readDesired();
      }
      const leaseId = ++this.nextLeaseId;
      const controllerRef: { current: Controller | null } = { current: null };
      let bindingInstalled = false;
      let stagedCheckpoint: Checkpoint | null = null;
      const lease: AgentRealtimeControllerLease<Client, Checkpoint> = {
        client: desired.client,
        getCheckpoint: () => input.readDesired().checkpoint,
        recordCheckpointUsed: (checkpoint) => {
          if (!bindingInstalled) {
            stagedCheckpoint = checkpoint;
            return;
          }
          const binding = this.binding;
          if (
            binding?.leaseId === leaseId
            && binding.controller === controllerRef.current
          ) {
            binding.checkpointUsed = checkpoint;
          }
        },
        isCurrent: () => {
          const binding = this.binding;
          return binding?.leaseId === leaseId
            && binding.controller === controllerRef.current
            && binding.usable;
        },
      };
      const controller = input.create(lease);
      controllerRef.current = controller;
      this.binding = {
        leaseId,
        controller,
        client: desired.client,
        checkpointUsed: stagedCheckpoint,
        usable: true,
      };
      bindingInstalled = true;
      return controller;
    });
  }

  async close(
    closeCurrent: (controller: Controller) => Promise<'closed' | 'unconfirmed'>,
  ): Promise<'closed' | 'unconfirmed'> {
    // Le stop UI est synchrone du point de vue de l'autorité : le mutex sérialise les effets,
    // mais les callbacks de l'ancien controller sont inertes dès l'appel public.
    if (this.binding !== null) this.binding.usable = false;
    return this.exclusive(async () => {
      const current = this.binding;
      if (current === null) return 'closed';
      current.usable = false;
      const result = await closeCurrent(current.controller);
      if (result === 'closed' && this.binding === current) this.binding = null;
      return result;
    });
  }

  private bindingMismatch(
    binding: AgentRealtimeControllerBinding<Controller, Client, Checkpoint>,
    desired: { client: Client; checkpoint: Checkpoint | null },
  ): boolean {
    return binding.client !== desired.client
      || (binding.checkpointUsed !== null && binding.checkpointUsed !== desired.checkpoint);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
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

export interface AgentSessionRealtimeBootstrapOwnershipInput<T> {
  readonly generation: number;
  readonly currentGeneration: () => number;
  readonly isActive: () => boolean;
  readonly currentDriver: () => AgentSessionDriver;
  readonly currentAppState: () => string;
  readonly start: () => Promise<T>;
  readonly stopOwnedController: () => void;
}

export interface AgentSessionRealtimeBootstrapOwnership<T> {
  readonly outcome: T;
  readonly owned: boolean;
}

/**
 * Attend un bootstrap non annulable sans laisser une ancienne ouverture fermer la suivante.
 *
 * Une génération encore courante mais devenue inactive doit nettoyer SON contrôleur. Une
 * génération remplacée ne le possède plus : appeler `stop()` ici tuerait la nouvelle session B
 * lorsque la promesse de A se résout tardivement.
 */
export async function settleAgentSessionRealtimeBootstrap<T>(
  input: AgentSessionRealtimeBootstrapOwnershipInput<T>,
): Promise<AgentSessionRealtimeBootstrapOwnership<T>> {
  const outcome = await input.start();
  const currentGeneration = input.currentGeneration();
  const owned = input.generation === currentGeneration
    && input.isActive()
    && realtimeOwnsAgentSession(input.currentDriver())
    && input.currentAppState() === 'active';
  if (!owned && input.generation === currentGeneration) input.stopOwnedController();
  return Object.freeze({ outcome, owned });
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
