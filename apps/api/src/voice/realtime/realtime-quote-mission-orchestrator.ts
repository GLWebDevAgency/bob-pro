import {
  understandQuoteCreationTurn,
  understandQuoteCreationTurnV2,
  type AgentHistoryTurn,
  type LlmPort,
  type QuoteCreationUnderstandingPhase,
  type QuoteCreationUnderstandingPhaseV2,
} from '@bob/ai';
import type {
  AgentMissionOwner,
  AgentMissionQuoteLineCandidateV1,
  AgentMissionQuoteLineRequiredFact,
  AgentMissionRealtimeAuthorityProof,
  AgentMissionViewV1,
  AppError,
  DecideQuoteAgentMissionOutput,
  Result,
  StartQuoteAgentMissionOutput,
} from '@bob/core';
import type {
  AgentMissionLineContinuationServiceOutput,
  AgentMissionServiceAuthorization,
  DecideQuoteAgentMissionCatalogueChoiceServiceOutput,
  StageQuoteAgentMissionLinesServiceOutput,
} from '../../agent-missions/agent-mission.service';

export interface RealtimeQuoteMissionAuthority {
  readonly owner: AgentMissionOwner;
  readonly proof: AgentMissionRealtimeAuthorityProof;
  readonly realtimeSessionId: string;
}

export interface RealtimeQuoteMissionGateway {
  getCurrent(
    authorization: AgentMissionServiceAuthorization,
  ): Promise<Result<{ readonly mission: AgentMissionViewV1 | null }, AppError>>;
  startFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly realtimeSessionId: string;
    readonly turnId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly customerReference: string | null;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<StartQuoteAgentMissionOutput, AppError>>;
  decideFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly turnId: string;
    readonly realtimeSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decision:
      | {
          readonly action: 'choose_presented_option';
          readonly decisionId: string;
          readonly choiceSetRevision: number;
          readonly choiceId: string;
        }
        | {
          readonly action: 'resolve_customer_reference';
          readonly customerReference: string;
        };
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<DecideQuoteAgentMissionOutput, AppError>>;
  stageLinesFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly turnId: string;
    readonly realtimeSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<StageQuoteAgentMissionLinesServiceOutput, AppError>>;
  decideCatalogueChoiceFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly turnId: string;
    readonly realtimeSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly choiceId: string;
    readonly additionalLines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<
  Result<DecideQuoteAgentMissionCatalogueChoiceServiceOutput, AppError>
  >;
}

export interface RealtimeQuoteMissionOrchestrationInput {
  readonly authority: RealtimeQuoteMissionAuthority;
  readonly turnId: string;
  readonly transcript: string;
  readonly history: readonly AgentHistoryTurn[];
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly signal: AbortSignal;
}

export type RealtimeQuoteMissionOrchestrationOutcome =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'failed'; readonly canonicalSpeech: string }
  | {
      readonly status: 'handled';
      readonly canonicalSpeech: string;
      readonly speechPurpose: 'action_result' | 'structured_choice';
    }
  | {
      readonly status: 'ready';
      readonly canonicalSpeech: string;
      readonly navigate: '/devis/new';
    };

export interface RealtimeQuoteMissionOrchestratorPort {
  run(
    input: RealtimeQuoteMissionOrchestrationInput,
  ): Promise<RealtimeQuoteMissionOrchestrationOutcome>;
}

const TEMPORARY_FAILURE =
  'Je rencontre un souci temporaire et je ne peux pas vérifier l’état de la mission. Consulte l’écran avant de réessayer.';
const UNSAFE_UNDERSTANDING =
  'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.';

function understandingState(mission: AgentMissionViewV1 | null): {
  readonly phase: QuoteCreationUnderstandingPhase;
  readonly presentedCustomerCount: number;
} | 'mission_locked' {
  if (mission === null) {
    return { phase: 'inactive', presentedCustomerCount: 0 };
  }
  if (mission.status !== 'active') return 'mission_locked';
  if (mission.phase === 'awaiting_customer') {
    return { phase: 'awaiting_customer', presentedCustomerCount: 0 };
  }
  if (
    mission.phase === 'awaiting_customer_choice'
    && mission.payload.decision?.kind === 'customer'
    && mission.payload.decision.candidates.length >= 1
    && mission.payload.decision.candidates.length <= 5
  ) {
    return {
      phase: 'awaiting_customer_choice',
      presentedCustomerCount: mission.payload.decision.candidates.length,
    };
  }
  return 'mission_locked';
}

function understandingStateV2(mission: AgentMissionViewV1 | null): {
  readonly phase: QuoteCreationUnderstandingPhaseV2;
  readonly presentedChoiceCount: number;
} | 'mission_locked' {
  if (mission === null) {
    return { phase: 'inactive', presentedChoiceCount: 0 };
  }
  if (mission.status !== 'active') return 'mission_locked';
  if (mission.phase === 'awaiting_customer') {
    return { phase: 'awaiting_customer', presentedChoiceCount: 0 };
  }
  if (
    mission.phase === 'awaiting_customer_choice'
    && mission.payload.decision?.kind === 'customer'
    && mission.payload.decision.candidates.length >= 1
    && mission.payload.decision.candidates.length <= 5
  ) {
    return {
      phase: 'awaiting_customer_choice',
      presentedChoiceCount: mission.payload.decision.candidates.length,
    };
  }
  if (mission.phase === 'awaiting_lines') {
    return { phase: 'awaiting_lines', presentedChoiceCount: 0 };
  }
  if (
    mission.phase === 'awaiting_catalogue_choice'
    && mission.payload.decision?.kind === 'catalogue'
    && mission.payload.decision.candidates.length >= 1
    && mission.payload.decision.candidates.length <= 5
  ) {
    return {
      phase: 'awaiting_catalogue_choice',
      presentedChoiceCount: mission.payload.decision.candidates.length + 1,
    };
  }
  return 'mission_locked';
}

function canonicalStartSpeech(mission: AgentMissionViewV1): string {
  if (mission.phase === 'awaiting_draft_decision') {
    return 'J’ai retrouvé un brouillon en cours. Je l’ouvre pour que tu choisisses de le reprendre ou de recommencer.';
  }
  const staged = mission.payload.stagedCustomerResolution;
  if (staged?.kind === 'exact') {
    return 'J’ai trouvé le client dans tes données. J’ouvre le devis et je poursuis dès que l’écran est prêt.';
  }
  if (staged?.kind === 'choices') {
    return 'J’ai trouvé plusieurs clients possibles. J’ouvre le devis pour te présenter les choix.';
  }
  if (staged?.kind === 'too_many') {
    return 'J’ai besoin d’un nom de client plus précis. J’ouvre le devis pour que tu puisses le compléter.';
  }
  return 'Je prépare le devis. Choisis le client, ou dis-moi son nom.';
}

function currentCatalogueChoiceCount(mission: AgentMissionViewV1): number | null {
  const decision = mission.payload.decision;
  return mission.status === 'active'
    && mission.phase === 'awaiting_catalogue_choice'
    && decision?.kind === 'catalogue'
    ? decision.candidates.length
    : null;
}

function canonicalCatalogueChoiceSpeech(count: number): string {
  return count > 1
    ? `J’ai trouvé ${count} prestations réelles dans ton catalogue, plus l’option de créer une ligne libre. Elles sont conservées dans cet ordre pour ton choix.`
    : 'J’ai trouvé une prestation réelle dans ton catalogue, plus l’option de créer une ligne libre. Les deux choix sont conservés dans cet ordre.';
}

function requiredFactSpeech(fact: AgentMissionQuoteLineRequiredFact | null): string {
  switch (fact) {
    case 'service_reference':
      return 'J’ai trouvé plus de cinq prestations possibles. Précise le libellé ou le type de prestation pour que je sélectionne la bonne.';
    case 'category':
      return 'J’ai besoin de savoir s’il s’agit de main-d’œuvre, de fourniture, de déplacement ou d’abonnement.';
    case 'quantity':
      return 'Quelle quantité dois-je facturer pour cette ligne ?';
    case 'unit':
      return 'Dans quelle unité dois-je facturer cette prestation ?';
    case 'unit_price':
      return 'Quel prix unitaire dois-je appliquer à cette ligne ?';
    case 'vat_rate':
      return 'Je ne peux pas déterminer le taux de TVA sans risque. Indique-moi le taux à appliquer.';
    case 'housing_older_than_2y':
      return 'Le logement concerné a-t-il plus de deux ans ?';
    case 'energy_renovation':
      return 'Ces travaux relèvent-ils de la rénovation énergétique ?';
    case null:
      return 'Dis-moi ce que tu veux corriger sur cette ligne.';
  }
}

function canonicalLineContinuationState(
  continuation: AgentMissionLineContinuationServiceOutput,
  mission: AgentMissionViewV1,
): RealtimeQuoteMissionOrchestrationOutcome {
  if (continuation.outcome === 'details_requested') {
    return {
      status: 'handled',
      canonicalSpeech: requiredFactSpeech(continuation.requiredFact),
      speechPurpose: 'structured_choice',
    };
  }
  if (continuation.outcome === 'proposal_presented') {
    return {
      status: 'handled',
      canonicalSpeech:
        'J’ai préparé la ligne sans modifier le devis. Vérifie la proposition, puis dis-moi si tu confirmes, si tu veux la corriger ou l’annuler.',
      speechPurpose: 'structured_choice',
    };
  }
  return canonicalV2MissionState(mission);
}

function canonicalV2MissionState(
  mission: AgentMissionViewV1 | null,
): RealtimeQuoteMissionOrchestrationOutcome {
  if (mission === null || mission.status !== 'active') {
    return {
      status: 'handled',
      canonicalSpeech:
        'Cette mission n’est plus active. J’ai actualisé son état sans exécuter une nouvelle action.',
      speechPurpose: 'action_result',
    };
  }
  const catalogueCount = currentCatalogueChoiceCount(mission);
  if (catalogueCount !== null) {
    return {
      status: 'handled',
      canonicalSpeech: canonicalCatalogueChoiceSpeech(catalogueCount),
      speechPurpose: 'structured_choice',
    };
  }
  const customerCount = currentCustomerChoiceCount(mission);
  if (customerCount !== null) {
    return {
      status: 'handled',
      canonicalSpeech: canonicalCurrentChoiceSpeech(customerCount),
      speechPurpose: 'structured_choice',
    };
  }
  if (mission.phase === 'awaiting_lines') {
    return {
      status: 'handled',
      canonicalSpeech:
        'Les informations données sont conservées dans la mission. Je poursuis à partir de l’état réellement enregistré.',
      speechPurpose: 'action_result',
    };
  }
  if (mission.phase === 'awaiting_line_details') {
    return {
      status: 'handled',
      canonicalSpeech:
        'Cette ligne attend une précision. Dis-moi ce que tu veux compléter ou corriger.',
      speechPurpose: 'structured_choice',
    };
  }
  if (mission.phase === 'awaiting_line_confirmation') {
    return {
      status: 'handled',
      canonicalSpeech:
        'La proposition de ligne est prête. Dis-moi si tu confirmes, si tu veux la corriger ou l’annuler.',
      speechPurpose: 'structured_choice',
    };
  }
  if (mission.phase === 'awaiting_customer') {
    return {
      status: 'handled',
      canonicalSpeech:
        'Le client reste à choisir. Dis-moi son nom pour reprendre la même mission.',
      speechPurpose: 'structured_choice',
    };
  }
  return {
    status: 'failed',
    canonicalSpeech:
      'L’étape enregistrée ne permet pas encore cette action. Rien de plus n’a été exécuté.',
  };
}

function currentCustomerChoiceCount(mission: AgentMissionViewV1): number | null {
  const decision = mission.payload.decision;
  return mission.status === 'active'
    && mission.phase === 'awaiting_customer_choice'
    && decision?.kind === 'customer'
    ? decision.candidates.length
    : null;
}

function canonicalCurrentChoiceSpeech(count: number): string {
  return count > 1
    ? `J’ai trouvé ${count} clients possibles, affichés dans le même ordre. Dis-moi le premier, le deuxième, ou précise le nom.`
    : 'J’ai trouvé un client proche, affiché à l’écran. Confirme-le, ou précise le nom.';
}

function canonicalConvergedDecision(
  mission: AgentMissionViewV1 | null,
): Extract<
  RealtimeQuoteMissionOrchestrationOutcome,
  { readonly status: 'handled' }
> {
  if (mission === null || mission.status !== 'active') {
    return {
      status: 'handled',
      canonicalSpeech:
        'Cette mission n’est plus active. J’ai actualisé son état à l’écran.',
      speechPurpose: 'action_result',
    };
  }
  if (mission.phase === 'awaiting_lines') {
    return {
      status: 'handled',
      canonicalSpeech:
        'Le client est déjà confirmé. J’ai actualisé le devis avec l’état enregistré.',
      speechPurpose: 'action_result',
    };
  }
  const choiceCount = currentCustomerChoiceCount(mission);
  if (choiceCount !== null) {
    return {
      status: 'handled',
      canonicalSpeech: canonicalCurrentChoiceSpeech(choiceCount),
      speechPurpose: 'structured_choice',
    };
  }
  if (mission.phase === 'awaiting_customer') {
    return {
      status: 'handled',
      canonicalSpeech:
        'Le client reste à choisir. J’ai actualisé l’étape avec l’état enregistré.',
      speechPurpose: 'structured_choice',
    };
  }
  return {
    status: 'handled',
    canonicalSpeech:
      'La mission a changé pendant ta demande. J’ai actualisé l’écran avec l’état enregistré.',
    speechPurpose: 'action_result',
  };
}

function canonicalDecisionOutcome(
  output: DecideQuoteAgentMissionOutput,
): Extract<
  RealtimeQuoteMissionOrchestrationOutcome,
  { readonly status: 'handled' }
> {
  const effect = output.effect;
  if (effect.kind === 'selected') {
    return output.mission.status === 'active'
      && output.mission.phase === 'awaiting_lines'
      ? {
          status: 'handled',
          canonicalSpeech:
            'Client confirmé. L’écran est à jour. Tu peux toucher Continuer à la main pour ajouter les prestations.',
          speechPurpose: 'action_result',
        }
      : canonicalConvergedDecision(output.mission);
  }
  if (effect.kind === 'presented') {
    const currentCount = currentCustomerChoiceCount(output.mission);
    if (currentCount === effect.candidateCount) {
      return {
        status: 'handled',
        canonicalSpeech: canonicalCurrentChoiceSpeech(currentCount),
        speechPurpose: 'structured_choice',
      };
    }
    return canonicalConvergedDecision(output.mission);
  }
  if (effect.kind === 'invalidated') {
    return output.outcome === 'replayed'
      ? canonicalConvergedDecision(output.mission)
      : {
          status: 'handled',
          canonicalSpeech:
            'Ce client n’est plus disponible. Le devis n’a pas été modifié. Dis-moi lequel choisir.',
          speechPurpose: 'structured_choice',
        };
  }
  return output.outcome === 'replayed'
    ? canonicalConvergedDecision(output.mission)
    : {
        status: 'handled',
        canonicalSpeech:
          'Je n’ai pas de correspondance suffisamment sûre. Vérifie le nom ou précise-le.',
        speechPurpose: 'structured_choice',
      };
}

/**
 * Frontière probabiliste → déterministe de M1-C.
 *
 * Le LLM ne reçoit aucune autorité et ne produit qu'une frame typée. Le gateway recharge la
 * mission et exécute le use case avec la preuve issue de la lease. Toute sortie ambiguë échoue
 * fermée afin de ne jamais retomber sur l'ancien hint de navigation sans mission.
 */
export class RealtimeQuoteMissionOrchestrator
implements RealtimeQuoteMissionOrchestratorPort {
  constructor(
    private readonly llm: LlmPort,
    private readonly missions: RealtimeQuoteMissionGateway,
  ) {}

  private async convergeAfterUncertainDecision(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly signal: AbortSignal;
  }): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    let refreshed: Awaited<ReturnType<RealtimeQuoteMissionGateway['getCurrent']>>;
    try {
      refreshed = await this.missions.getCurrent(input.authorization);
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    return refreshed.ok
      ? (
          input.authorization.proof.protocolVersion === 2
            ? canonicalV2MissionState(refreshed.value.mission)
            : canonicalConvergedDecision(refreshed.value.mission)
        )
      : { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
  }

  private async runV2(input: {
    readonly request: RealtimeQuoteMissionOrchestrationInput;
    readonly authorization: AgentMissionServiceAuthorization;
    readonly mission: AgentMissionViewV1 | null;
  }): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    const state = understandingStateV2(input.mission);
    if (state === 'mission_locked') {
      return {
        status: 'failed',
        canonicalSpeech:
          'La mission attend la confirmation de l’étape affichée. Rien de nouveau n’a été exécuté.',
      };
    }

    let understood: Awaited<ReturnType<typeof understandQuoteCreationTurnV2>>;
    try {
      understood = await understandQuoteCreationTurnV2(this.llm, {
        transcript: input.request.transcript,
        phase: state.phase,
        presentedChoiceCount: state.presentedChoiceCount,
        requiredFact: null,
        timeZone: null,
        locale: 'fr-FR',
        signal: input.request.signal,
      });
    } catch {
      input.request.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.request.signal.throwIfAborted();
    if (understood.status === 'rejected') {
      return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
    }
    const operation = understood.frame.operations[0];
    if (operation === undefined) {
      return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
    }
    if (operation.kind === 'unrelated') return { status: 'not_applicable' };

    if (operation.kind === 'start_quote_creation') {
      let started: Awaited<ReturnType<RealtimeQuoteMissionGateway['startFromVoiceTurn']>>;
      try {
        started = await this.missions.startFromVoiceTurn({
          authorization: input.authorization,
          realtimeSessionId: input.request.authority.realtimeSessionId,
          turnId: input.request.turnId,
          contextRevision: input.request.contextRevision,
          contextDigest: input.request.contextDigest,
          customerReference: operation.customerReference,
          lines: operation.lines,
        });
      } catch {
        input.request.signal.throwIfAborted();
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      input.request.signal.throwIfAborted();
      if (!started.ok || started.value.mission.status !== 'active') {
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      return {
        status: 'ready',
        canonicalSpeech: canonicalStartSpeech(started.value.mission),
        navigate: '/devis/new',
      };
    }

    const mission = input.mission;
    const draft = mission?.payload.draft ?? null;
    if (mission === null || draft === null) {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }

    if (operation.kind === 'append_line_candidates') {
      let staged: Awaited<
      ReturnType<RealtimeQuoteMissionGateway['stageLinesFromVoiceTurn']>
      >;
      try {
        staged = await this.missions.stageLinesFromVoiceTurn({
          authorization: input.authorization,
          missionId: mission.id,
          turnId: input.request.turnId,
          realtimeSessionId: input.request.authority.realtimeSessionId,
          contextRevision: input.request.contextRevision,
          contextDigest: input.request.contextDigest,
          expectedMissionRevision: mission.revision,
          expectedDraftSessionId: draft.sessionId,
          expectedDraftSlotRevision: draft.slotRevision,
          expectedDraftContentRevision: draft.contentRevision,
          lines: operation.lines,
        });
      } catch {
        input.request.signal.throwIfAborted();
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      input.request.signal.throwIfAborted();
      if (!staged.ok) {
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      if (staged.value.continuation.outcome === 'catalogue_not_found') {
        return {
          status: 'handled',
          canonicalSpeech:
            'Je n’ai trouvé aucune prestation correspondante dans ton catalogue. La ligne libre est conservée dans la mission, sans inventer de tarif.',
          speechPurpose: 'action_result',
        };
      }
      return canonicalLineContinuationState(
        staged.value.continuation,
        staged.value.mission,
      );
    }

    if (
      operation.kind === 'set_customer_reference'
      || (
        operation.kind === 'select_presented_choice'
        && mission.phase === 'awaiting_customer_choice'
      )
    ) {
      const decision = operation.kind === 'select_presented_choice'
        ? (() => {
            const presented = mission.payload.decision;
            const candidate = presented?.kind === 'customer'
              ? presented.candidates[operation.ordinal - 1]
              : undefined;
            return presented?.kind === 'customer' && candidate !== undefined
              ? {
                  action: 'choose_presented_option' as const,
                  decisionId: presented.decisionId,
                  choiceSetRevision: presented.choiceSetRevision,
                  choiceId: candidate.choiceId,
                }
              : null;
          })()
        : {
            action: 'resolve_customer_reference' as const,
            customerReference: operation.customerReference,
          };
      if (decision === null) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      let decided: Awaited<
      ReturnType<RealtimeQuoteMissionGateway['decideFromVoiceTurn']>
      >;
      try {
        decided = await this.missions.decideFromVoiceTurn({
          authorization: input.authorization,
          missionId: mission.id,
          turnId: input.request.turnId,
          realtimeSessionId: input.request.authority.realtimeSessionId,
          contextRevision: input.request.contextRevision,
          contextDigest: input.request.contextDigest,
          expectedMissionRevision: mission.revision,
          expectedDraftSessionId: draft.sessionId,
          expectedDraftSlotRevision: draft.slotRevision,
          expectedDraftContentRevision: draft.contentRevision,
          decision,
          lines: operation.lines,
        });
      } catch {
        input.request.signal.throwIfAborted();
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      input.request.signal.throwIfAborted();
      if (!decided.ok) {
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      return canonicalV2MissionState(decided.value.mission);
    }

    if (
      operation.kind === 'select_presented_choice'
      && mission.phase === 'awaiting_catalogue_choice'
    ) {
      const presented = mission.payload.decision;
      if (presented?.kind !== 'catalogue') {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      const choiceIds = [
        ...presented.candidates.map((candidate) => candidate.choiceId),
        presented.freeLineChoiceId,
      ];
      const choiceId = choiceIds[operation.ordinal - 1];
      if (choiceId === undefined) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      let decided: Awaited<
      ReturnType<
      RealtimeQuoteMissionGateway['decideCatalogueChoiceFromVoiceTurn']
      >
      >;
      try {
        decided = await this.missions.decideCatalogueChoiceFromVoiceTurn({
          authorization: input.authorization,
          missionId: mission.id,
          turnId: input.request.turnId,
          realtimeSessionId: input.request.authority.realtimeSessionId,
          contextRevision: input.request.contextRevision,
          contextDigest: input.request.contextDigest,
          expectedMissionRevision: mission.revision,
          expectedDraftSessionId: presented.expectedDraft.sessionId,
          expectedDraftSlotRevision: presented.expectedDraft.slotRevision,
          expectedDraftContentRevision: presented.expectedDraft.contentRevision,
          decisionId: presented.decisionId,
          choiceSetRevision: presented.choiceSetRevision,
          pendingLineId: presented.pendingLineId,
          expectedWorkRevision: presented.expectedWorkRevision,
          choiceId,
          additionalLines: operation.lines,
        });
      } catch {
        input.request.signal.throwIfAborted();
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      input.request.signal.throwIfAborted();
      if (!decided.ok) {
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      if (decided.value.outcome === 'invalidated') {
        if (decided.value.continuation.outcome === 'catalogue_not_found') {
          return {
            status: 'handled',
            canonicalSpeech:
              'Cette prestation a changé. Après relecture, aucune correspondance actuelle ne reste ; la ligne libre est conservée sans tarif inventé.',
            speechPurpose: 'action_result',
          };
        }
        return canonicalLineContinuationState(
          decided.value.continuation,
          decided.value.mission,
        );
      }
      return canonicalLineContinuationState(
        decided.value.continuation,
        decided.value.mission,
      );
    }

    return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
  }

  async run(
    input: RealtimeQuoteMissionOrchestrationInput,
  ): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    input.signal.throwIfAborted();
    const authorization: AgentMissionServiceAuthorization = {
      owner: input.authority.owner,
      proof: input.authority.proof,
    };
    let current: Awaited<ReturnType<RealtimeQuoteMissionGateway['getCurrent']>>;
    try {
      current = await this.missions.getCurrent(authorization);
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    if (!current.ok) {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    if (input.authority.proof.protocolVersion === 2) {
      return this.runV2({
        request: input,
        authorization,
        mission: current.value.mission,
      });
    }
    const state = understandingState(current.value.mission);
    if (state === 'mission_locked') {
      return {
        status: 'failed',
        canonicalSpeech:
          'La mission est déjà en cours. J’attends que l’étape affichée soit confirmée avant de poursuivre.',
      };
    }

    let understood: Awaited<ReturnType<typeof understandQuoteCreationTurn>>;
    try {
      understood = await understandQuoteCreationTurn(this.llm, {
        transcript: input.transcript,
        phase: state.phase,
        presentedCustomerCount: state.presentedCustomerCount,
        history: input.history,
        signal: input.signal,
      });
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    if (understood.status === 'rejected') {
      return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
    }

    const operation = understood.frame.operation;
    if (operation.kind === 'unrelated') return { status: 'not_applicable' };
    if (
      operation.kind === 'set_customer_reference'
      || operation.kind === 'select_presented_customer'
    ) {
      const mission = current.value.mission;
      const draft = mission?.payload.draft ?? null;
      if (mission === null || draft === null) {
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      const decision = operation.kind === 'select_presented_customer'
        ? (() => {
            const presented = mission.payload.decision;
            const candidate = presented?.kind === 'customer'
              ? presented.candidates[operation.ordinal - 1]
              : undefined;
            return presented?.kind === 'customer' && candidate !== undefined
              ? {
                  action: 'choose_presented_option' as const,
                  decisionId: presented.decisionId,
                  choiceSetRevision: presented.choiceSetRevision,
                  choiceId: candidate.choiceId,
                }
              : null;
          })()
        : {
            action: 'resolve_customer_reference' as const,
            customerReference: operation.customerReference,
          };
      if (decision === null) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }

      let decided: Awaited<
        ReturnType<RealtimeQuoteMissionGateway['decideFromVoiceTurn']>
      >;
      try {
        decided = await this.missions.decideFromVoiceTurn({
          authorization,
          missionId: mission.id,
          turnId: input.turnId,
          realtimeSessionId: input.authority.realtimeSessionId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
          expectedMissionRevision: mission.revision,
          expectedDraftSessionId: draft.sessionId,
          expectedDraftSlotRevision: draft.slotRevision,
          expectedDraftContentRevision: draft.contentRevision,
          decision,
          lines: [],
        });
      } catch {
        input.signal.throwIfAborted();
        return this.convergeAfterUncertainDecision({
          authorization,
          signal: input.signal,
        });
      }
      input.signal.throwIfAborted();
      if (!decided.ok || decided.value.mission.status !== 'active') {
        return this.convergeAfterUncertainDecision({
          authorization,
          signal: input.signal,
        });
      }
      return canonicalDecisionOutcome(decided.value);
    }

    let started: Awaited<ReturnType<RealtimeQuoteMissionGateway['startFromVoiceTurn']>>;
    try {
      started = await this.missions.startFromVoiceTurn({
        authorization,
        realtimeSessionId: input.authority.realtimeSessionId,
        turnId: input.turnId,
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        customerReference: operation.customerReference,
        lines: [],
      });
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    if (!started.ok || started.value.mission.status !== 'active') {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    return {
      status: 'ready',
      canonicalSpeech: canonicalStartSpeech(started.value.mission),
      navigate: '/devis/new',
    };
  }
}
