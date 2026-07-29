import { sha256Hex, type AgentMissionViewV1 } from '@bob/core';
import type {
  QuoteDraftAuthoritativeReference,
} from '../quote-draft/quote-draft-remote-store';
import type {
  QuoteDraftMissionHydrationResult,
} from '../quote-draft/quote-draft-provider';
import type {
  AgentMissionConfirmedContext,
  AgentMissionRuntimeActions,
} from './agent-mission-runtime';

export type QuoteScreenMissionBindingState =
  | { readonly phase: 'detecting' }
  | { readonly phase: 'waiting_context' }
  | { readonly phase: 'hydrating' | 'acknowledging' | 'refreshing' }
  | {
      readonly phase: 'ready';
      readonly mission: AgentMissionViewV1;
    }
  | {
      /**
       * M1-C est terminé : le client est durablement sélectionné et l'étape lignes est rendue.
       * Le coordinateur se retire pour laisser le wizard manuel poursuivre sans réhydrater par
       * dessus ses saisies. M2 remplacera ce handoff par la continuation agentique des lignes.
       */
      readonly phase: 'handoff';
      readonly mission: AgentMissionViewV1;
    }
  | {
      readonly phase: 'manual';
      readonly reason: 'no_realtime_session' | 'no_mission' | 'terminal_mission';
    }
  | {
      readonly phase: 'blocked';
      readonly reason: 'draft_decision_required' | 'local_changes';
    }
  | {
      readonly phase: 'error';
      readonly reason:
        | 'draft_not_found'
        | 'invalid_response'
        | 'mission_unavailable'
        | 'slot_unavailable';
    };

export interface QuoteScreenMissionObservation {
  readonly runtimeGeneration: number;
  readonly realtimeSessionId: string | null;
  readonly confirmedContext: AgentMissionConfirmedContext | null;
  readonly screenInstanceId: string;
  readonly authoritativeDraft: QuoteDraftAuthoritativeReference | null;
}

export interface QuoteScreenMissionPorts {
  readonly actions: AgentMissionRuntimeActions;
  readonly hydrateDraft: (
    expected: QuoteDraftAuthoritativeReference,
  ) => Promise<QuoteDraftMissionHydrationResult>;
}

function sameReference(
  left: QuoteDraftAuthoritativeReference | null,
  right: QuoteDraftAuthoritativeReference,
): boolean {
  return left !== null
    && left.sessionId === right.sessionId
    && left.slotRevision === right.slotRevision
    && left.contentRevision === right.contentRevision;
}

function bindingMatches(
  mission: AgentMissionViewV1,
  context: AgentMissionConfirmedContext,
): boolean {
  const binding = mission.currentBinding;
  return binding !== null
    && binding.realtimeSessionId === context.realtimeSessionId
    && binding.contextRevision === context.revision
    && binding.contextDigest === context.digest
    && binding.screenName === '/devis/new'
    && binding.screenInstanceId === context.screen.instanceId;
}

function contextMatches(
  observation: QuoteScreenMissionObservation,
): observation is QuoteScreenMissionObservation & {
  readonly realtimeSessionId: string;
  readonly confirmedContext: AgentMissionConfirmedContext;
} {
  const context = observation.confirmedContext;
  return observation.realtimeSessionId !== null
    && context !== null
    && context.realtimeSessionId === observation.realtimeSessionId
    && context.screen.name === '/devis/new'
    && context.screen.instanceId === observation.screenInstanceId;
}

function hydrationState(
  result: QuoteDraftMissionHydrationResult,
): QuoteScreenMissionBindingState {
  if (result.status === 'ready') {
    return { phase: 'refreshing' };
  }
  if (result.status === 'busy') return { phase: 'hydrating' };
  if (result.status === 'local_changes') {
    return { phase: 'blocked', reason: 'local_changes' };
  }
  if (result.status === 'not_found') {
    return { phase: 'error', reason: 'draft_not_found' };
  }
  if (result.status === 'unavailable') {
    return { phase: 'error', reason: 'slot_unavailable' };
  }
  return { phase: 'refreshing' };
}

/** Produit un identifiant borné à partir de l'intégralité du rendu, sans suffixe collisionnable. */
export function quoteScreenInstanceId(input: {
  readonly sessionId: string;
  readonly slotRevision: number | null;
  readonly contentRevision: number;
  readonly step: string;
}): string {
  const digest = sha256Hex(JSON.stringify([
    'bob.quote-screen-instance.v1',
    input.sessionId,
    input.slotRevision ?? 'local',
    input.contentRevision,
    input.step,
  ]));
  return `devis-new:${digest}`;
}

/**
 * Coordinateur latest-input-wins de l'écran devis.
 *
 * Une invocation fait au plus une transition réseau/hydratation. Après un refresh, React rend la
 * nouvelle instance et rappelle `advance`; le point fixe est alors vérifié sur des observations
 * fraîches. Les appels strictement identiques partagent le même vol.
 */
export class QuoteScreenMissionCoordinator {
  private readonly flights =
    new Map<string, Promise<QuoteScreenMissionBindingState>>();
  private readonly acknowledgementCommands = new Map<string, string>();

  constructor(private readonly createCommandId: () => string) {}

  advance(
    observation: QuoteScreenMissionObservation,
    ports: QuoteScreenMissionPorts,
  ): Promise<QuoteScreenMissionBindingState> {
    const key = JSON.stringify([
      observation.runtimeGeneration,
      observation.realtimeSessionId,
      observation.confirmedContext?.revision ?? null,
      observation.confirmedContext?.digest ?? null,
      observation.confirmedContext?.screen.name ?? null,
      observation.confirmedContext?.screen.instanceId ?? null,
      observation.screenInstanceId,
      observation.authoritativeDraft?.sessionId ?? null,
      observation.authoritativeDraft?.slotRevision ?? null,
      observation.authoritativeDraft?.contentRevision ?? null,
    ]);
    const current = this.flights.get(key);
    if (current !== undefined) return current;
    const flight = this.advanceOnce(observation, ports).finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight;
  }

  private async advanceOnce(
    observation: QuoteScreenMissionObservation,
    ports: QuoteScreenMissionPorts,
  ): Promise<QuoteScreenMissionBindingState> {
    if (observation.realtimeSessionId === null) {
      return { phase: 'manual', reason: 'no_realtime_session' };
    }
    if (!contextMatches(observation)) return { phase: 'waiting_context' };

    const current = await ports.actions.readCurrentQuoteCreation(
      observation.screenInstanceId,
    );
    if (current.status === 'context_unconfirmed' || current.status === 'stale') {
      return { phase: 'waiting_context' };
    }
    if (current.status !== 'completed') {
      return {
        phase: 'error',
        reason: current.status === 'invalid_response'
          ? 'invalid_response'
          : 'mission_unavailable',
      };
    }
    const mission = current.value.mission;
    if (mission === null) return { phase: 'manual', reason: 'no_mission' };
    if (
      mission.status !== 'active'
      || !mission.actionable
      || mission.kind !== 'quote_creation'
    ) {
      return { phase: 'manual', reason: 'terminal_mission' };
    }
    const expectedDraft = mission.payload.draft;
    if (expectedDraft === null) {
      return { phase: 'blocked', reason: 'draft_decision_required' };
    }

    if (!sameReference(observation.authoritativeDraft, expectedDraft)) {
      const hydrated = await ports.hydrateDraft(expectedDraft);
      return hydrationState(hydrated);
    }
    if (bindingMatches(mission, observation.confirmedContext)) {
      return { phase: 'ready', mission };
    }

    const commandKey = JSON.stringify([
      observation.realtimeSessionId,
      mission.id,
      mission.revision,
      observation.confirmedContext.revision,
      observation.confirmedContext.digest,
      observation.screenInstanceId,
      expectedDraft.sessionId,
      expectedDraft.slotRevision,
      expectedDraft.contentRevision,
    ]);
    let commandId = this.acknowledgementCommands.get(commandKey);
    if (commandId === undefined) {
      commandId = this.createCommandId();
      if (this.acknowledgementCommands.size >= 64) {
        const oldest = this.acknowledgementCommands.keys().next().value;
        if (typeof oldest === 'string') this.acknowledgementCommands.delete(oldest);
      }
      this.acknowledgementCommands.set(commandKey, commandId);
    }
    const acknowledged = await ports.actions.acknowledgeQuoteScreen({
      missionId: mission.id,
      commandId,
      expectedMissionRevision: mission.revision,
      draft: expectedDraft,
      expectedScreenInstanceId: observation.screenInstanceId,
    });
    if (
      acknowledged.status === 'context_unconfirmed'
      || acknowledged.status === 'stale'
    ) {
      return { phase: 'waiting_context' };
    }
    if (acknowledged.status === 'failed') {
      return acknowledged.error.kind === 'conflict'
        ? { phase: 'refreshing' }
        : { phase: 'error', reason: 'mission_unavailable' };
    }
    if (acknowledged.status !== 'completed') {
      return {
        phase: 'error',
        reason: acknowledged.status === 'invalid_response'
          ? 'invalid_response'
          : 'mission_unavailable',
      };
    }
    const refreshedDraft = acknowledged.value.mission.payload.draft;
    if (refreshedDraft === null) {
      return { phase: 'blocked', reason: 'draft_decision_required' };
    }
    // Même si la référence n'a pas changé, relire le slot est normatif après la continuation.
    const hydrated = await ports.hydrateDraft(refreshedDraft);
    return hydrationState(hydrated);
  }
}
