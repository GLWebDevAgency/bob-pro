import {
  sha256Hex,
  type AgentMissionViewV1,
  type CustomerMissionChoiceView,
} from '@bob/core';
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
import {
  sameRecoveredMission,
  type AgentMissionRecoverySnapshot,
  type PresentQuoteAgentMissionResumeView,
} from './agent-mission-recovery-state';

export type QuoteScreenMissionBindingState =
  | { readonly phase: 'detecting' }
  | { readonly phase: 'waiting_context' }
  | {
      readonly phase:
        | 'hydrating'
        | 'acknowledging'
        | 'refreshing'
        | 'waiting_recovery';
    }
  | {
      readonly phase: 'ready';
      readonly mission: AgentMissionViewV1;
      readonly customerChoices: readonly CustomerMissionChoiceView[];
    }
  | {
      /**
       * Une mission a survécu au processus mobile. Le brouillon reste protégé jusqu'au rattachement
       * explicite d'une nouvelle session Live V1 ; cet état ne parle et ne navigue jamais seul.
       */
      readonly phase: 'resume_required';
      readonly recovery: PresentQuoteAgentMissionResumeView;
    }
  | {
      /**
       * M1-C est terminé : le client est durablement sélectionné et l'étape lignes est rendue.
       * L'utilisateur doit encore libérer explicitement le slot avant toute saisie legacy.
       */
      readonly phase: 'handoff_required' | 'handing_off' | 'handoff_error';
      readonly mission: AgentMissionViewV1;
    }
  | {
      /** La mission est terminale et le slot libéré : le writer manuel peut reprendre. */
      readonly phase: 'handoff';
      readonly mission: AgentMissionViewV1;
    }
  | {
      readonly phase: 'manual';
      readonly reason: 'no_mission';
    }
  | {
      readonly phase: 'blocked';
      readonly reason: 'draft_decision_required' | 'local_changes' | 'mission_expired';
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
  readonly recovery: AgentMissionRecoverySnapshot;
}

export interface QuoteScreenMissionPorts {
  readonly actions: Pick<
    AgentMissionRuntimeActions,
    'readCurrentQuoteCreation' | 'acknowledgeQuoteScreen'
  >;
  readonly hydrateDraft: (
    expected: QuoteDraftAuthoritativeReference,
  ) => Promise<QuoteDraftMissionHydrationResult>;
  readonly refreshRecovery: () => Promise<AgentMissionRecoverySnapshot>;
}

export interface QuoteCustomerDecisionInput {
  readonly mission: AgentMissionViewV1;
  readonly customerId: string;
  readonly expectedScreenInstanceId: string;
}

export interface QuoteManualHandoffInput {
  readonly mission: AgentMissionViewV1;
  readonly expectedScreenInstanceId: string;
}

export type QuoteCustomerSelectionRow<
  T extends { readonly id: string; readonly name: string },
> =
  | {
      readonly kind: 'available';
      readonly customer: T;
      readonly missionOrdinal: number | null;
    }
  | {
      readonly kind: 'unavailable';
      readonly customerId: string;
      readonly missionOrdinal: number;
    }
  | {
      /**
       * Choix PostgreSQL frais et sélectionnable même si la query de liste est lente ou en
       * panne. Le label vient de l'autorité de reprise, jamais du modèle ni du cache mobile.
       */
      readonly kind: 'authoritative';
      readonly customerId: string;
      readonly label: string;
      readonly missionOrdinal: number;
    };

/**
 * Vue pure de parité voix/toucher : les choix persistés restent strictement dans leur ordre,
 * un client supprimé garde son ordinal sans ancien libellé, puis la liste réelle continue.
 */
export function deriveQuoteCustomerSelectionRows<
  T extends { readonly id: string; readonly name: string },
>(
  customers: readonly T[],
  decision: Extract<
    AgentMissionViewV1['payload']['decision'],
    { readonly kind: 'customer' }
  > | null,
  authoritativeChoices: readonly CustomerMissionChoiceView[] | null,
): readonly QuoteCustomerSelectionRow<T>[] {
  if (decision === null) {
    return customers.map((customer) => ({
      kind: 'available',
      customer,
      missionOrdinal: null,
    }));
  }
  const customersById = new Map(customers.map(
    (customer) => [customer.id, customer] as const,
  ));
  const suggestedIds = new Set(
    decision.candidates.map((candidate) => candidate.customerId),
  );
  const choicesById = authoritativeChoices === null
    ? new Map<string, CustomerMissionChoiceView>()
    : new Map(authoritativeChoices.map((choice) => [choice.choiceId, choice] as const));
  return [
    ...decision.candidates.map((candidate, index) => {
      const customer = customersById.get(candidate.customerId);
      const choice = choicesById.get(candidate.choiceId);
      if (choice?.status !== 'available') {
        return {
          kind: 'unavailable' as const,
          customerId: candidate.customerId,
          missionOrdinal: index + 1,
        };
      }
      return customer === undefined
        ? {
            kind: 'authoritative' as const,
            customerId: candidate.customerId,
            label: choice.label,
            missionOrdinal: index + 1,
          }
        : {
            kind: 'available' as const,
            // Le libellé de la décision vient du snapshot PostgreSQL frais, jamais du cache de
            // liste ni du modèle. Les autres attributs restent ceux du client réel de l'écran.
            customer: Object.freeze({ ...customer, name: choice.label }),
            missionOrdinal: index + 1,
          };
    }),
    ...customers
      .filter((customer) => !suggestedIds.has(customer.id))
      .map((customer) => ({
        kind: 'available' as const,
        customer,
        missionOrdinal: null,
      })),
  ];
}

/**
 * N'accepte les libellés de reprise que s'ils décrivent exactement la même mission, la même
 * révision, le même brouillon et le même jeu opaque, dans le même ordre.
 */
export function authoritativeCustomerChoices(
  recovery: AgentMissionRecoverySnapshot,
  mission: AgentMissionViewV1,
): readonly CustomerMissionChoiceView[] | null {
  const decision = mission.payload.decision;
  if (decision?.kind !== 'customer') return Object.freeze([]);
  const draft = mission.payload.draft;
  if (
    recovery.phase !== 'resumable'
    || draft === null
    || recovery.value.mission.status !== mission.status
    || recovery.value.mission.phase !== mission.phase
    || recovery.value.mission.actionable !== mission.actionable
    || !sameRecoveredMission(recovery.value, {
      id: mission.id,
      revision: mission.revision,
      draft,
    })
  ) {
    return null;
  }
  const choices = recovery.value.customerChoices;
  if (
    choices.length !== decision.candidates.length
    || choices.some(
      (choice, index) => choice.choiceId !== decision.candidates[index]?.choiceId,
    )
  ) {
    return null;
  }
  return choices;
}

/**
 * Frontière unique du geste « choisir ce client » depuis l'écran.
 *
 * Le mobile ne modifie jamais son brouillon ici. Il transforme seulement le tap en commande
 * métier durable, en réutilisant le choix opaque déjà présenté lorsqu'il existe. Le serveur relit
 * ensuite le client sous le tenant et commet brouillon + mission + événement atomiquement.
 */
export class QuoteCustomerDecisionCoordinator {
  private readonly flights = new Map<
    string,
    ReturnType<AgentMissionRuntimeActions['decideQuoteCreation']>
  >();
  private readonly commands = new Map<string, string>();

  constructor(private readonly createCommandId: () => string) {}

  select(
    input: QuoteCustomerDecisionInput,
    actions: Pick<AgentMissionRuntimeActions, 'decideQuoteCreation'>,
  ): ReturnType<AgentMissionRuntimeActions['decideQuoteCreation']> {
    const mission = input.mission;
    const draft = mission.payload.draft;
    if (
      mission.kind !== 'quote_creation'
      || mission.status !== 'active'
      || !mission.actionable
      || draft === null
      || (
        mission.phase !== 'awaiting_customer'
        && mission.phase !== 'awaiting_customer_choice'
      )
    ) {
      return Promise.resolve({ status: 'invalid_response' });
    }

    const presented = mission.phase === 'awaiting_customer_choice'
      && mission.payload.decision?.kind === 'customer'
      ? mission.payload.decision
      : null;
    if (mission.phase === 'awaiting_customer_choice' && presented === null) {
      return Promise.resolve({ status: 'invalid_response' });
    }
    const candidate = presented?.candidates.find(
      (item) => item.customerId === input.customerId,
    );
    const decision = candidate !== undefined && presented !== null
      ? {
          action: 'choose_presented_option' as const,
          decisionId: presented.decisionId,
          choiceSetRevision: presented.choiceSetRevision,
          choiceId: candidate.choiceId,
        }
      : {
          action: 'select_screen_customer' as const,
          customerId: input.customerId,
        };
    const commandKey = JSON.stringify([
      mission.id,
      mission.revision,
      draft.sessionId,
      draft.slotRevision,
      draft.contentRevision,
      input.expectedScreenInstanceId,
      decision,
    ]);
    const inFlight = this.flights.get(commandKey);
    if (inFlight !== undefined) return inFlight;

    let commandId = this.commands.get(commandKey);
    if (commandId === undefined) {
      commandId = this.createCommandId();
      if (this.commands.size >= 64) {
        const oldest = this.commands.keys().next().value;
        if (typeof oldest === 'string') this.commands.delete(oldest);
      }
      this.commands.set(commandKey, commandId);
    }
    const flight = actions.decideQuoteCreation({
      missionId: mission.id,
      commandId,
      expectedMissionRevision: mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      expectedScreenInstanceId: input.expectedScreenInstanceId,
      ...decision,
    }).finally(() => {
      if (this.flights.get(commandKey) === flight) this.flights.delete(commandKey);
    });
    this.flights.set(commandKey, flight);
    return flight;
  }
}

/**
 * Frontière idempotente du CTA « Continuer à la main ».
 *
 * Un même tuple conserve son UUID après réponse perdue et les doubles taps partagent le vol.
 * Aucun état local n'est libéré avant que la transaction serveur ait terminalisé la mission.
 */
export class QuoteManualHandoffCoordinator {
  private readonly flights = new Map<
    string,
    ReturnType<AgentMissionRuntimeActions['manualHandoffQuoteCreation']>
  >();
  private readonly commands = new Map<string, string>();

  constructor(private readonly createCommandId: () => string) {}

  handoff(
    input: QuoteManualHandoffInput,
    actions: Pick<AgentMissionRuntimeActions, 'manualHandoffQuoteCreation'>,
  ): ReturnType<AgentMissionRuntimeActions['manualHandoffQuoteCreation']> {
    const mission = input.mission;
    const draft = mission.payload.draft;
    if (
      mission.kind !== 'quote_creation'
      || mission.status !== 'active'
      || !mission.actionable
      || mission.phase !== 'awaiting_lines'
      || draft === null
    ) {
      return Promise.resolve({ status: 'invalid_response' });
    }
    const key = JSON.stringify([
      mission.id,
      mission.revision,
      draft.sessionId,
      draft.slotRevision,
      draft.contentRevision,
      input.expectedScreenInstanceId,
      'manual_handoff',
    ]);
    const inFlight = this.flights.get(key);
    if (inFlight !== undefined) return inFlight;
    let commandId = this.commands.get(key);
    if (commandId === undefined) {
      commandId = this.createCommandId();
      if (this.commands.size >= 64) {
        const oldest = this.commands.keys().next().value;
        if (typeof oldest === 'string') this.commands.delete(oldest);
      }
      this.commands.set(key, commandId);
    }
    const flight = actions.manualHandoffQuoteCreation({
      missionId: mission.id,
      commandId,
      expectedMissionRevision: mission.revision,
      expectedScreenInstanceId: input.expectedScreenInstanceId,
    }).finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight;
  }
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
      observation.recovery,
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
      if (observation.recovery.phase === 'loading') return { phase: 'detecting' };
      if (observation.recovery.phase === 'error') {
        return { phase: 'error', reason: 'mission_unavailable' };
      }
      return observation.recovery.phase === 'absent'
        ? { phase: 'manual', reason: 'no_mission' }
        : { phase: 'resume_required', recovery: observation.recovery.value };
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
      return { phase: 'blocked', reason: 'mission_expired' };
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
      const observedChoices = authoritativeCustomerChoices(
        observation.recovery,
        mission,
      );
      if (observedChoices !== null) {
        return { phase: 'ready', mission, customerChoices: observedChoices };
      }
      // La query React Query a déjà un refetch en vol. En lancer un second l'annulerait, puis
      // chaque publication `loading` relancerait la même boucle. Le rendu frais nous réveillera.
      if (observation.recovery.phase === 'loading') {
        return { phase: 'waiting_recovery' };
      }
      if (observation.recovery.phase === 'error') {
        return { phase: 'error', reason: 'mission_unavailable' };
      }
      const refreshedRecovery = await ports.refreshRecovery();
      const refreshedChoices = authoritativeCustomerChoices(
        refreshedRecovery,
        mission,
      );
      return refreshedChoices === null
        ? refreshedRecovery.phase === 'error'
          ? { phase: 'error', reason: 'mission_unavailable' }
          : { phase: 'refreshing' }
        : { phase: 'ready', mission, customerChoices: refreshedChoices };
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
