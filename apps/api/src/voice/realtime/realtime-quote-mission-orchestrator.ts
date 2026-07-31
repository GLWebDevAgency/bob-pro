import {
  type AgentHistoryTurn,
  type QuoteCreationSemanticFrameV1,
  type QuoteCreationSemanticFrameV2,
  type QuoteCreationUnderstandingPhase,
  type QuoteCreationUnderstandingPhaseV2,
  type RealtimeQuoteSemanticMissionContext,
  type RealtimeSemanticCurrentLine,
  type RealtimeSemanticPresentedChoice,
} from '@bob/ai';
import type {
  AgentMissionOwner,
  AgentMissionQuoteLineCandidateV1,
  AgentMissionQuoteLinePatchScope,
  AgentMissionQuoteLinePatchV1,
  AgentMissionQuoteLineRequiredFact,
  AgentMissionRealtimeAuthorityProof,
  AgentMissionViewV1,
  AppError,
  DecideQuoteAgentMissionOutput,
  QuoteAgentMissionPresentationV1,
  QuoteAgentMissionPlannerResumeV2,
  QuoteAgentMissionResumeViewV2,
  Result,
  StartQuoteAgentMissionOutput,
} from '@bob/core';
import { MAX_BILLING_LINES } from '@bob/core';
import type {
  CancelQuoteAgentMissionPendingLineServiceOutput,
  DecideQuoteAgentMissionLineProposalServiceOutput,
  AgentMissionLineContinuationServiceOutput,
  AgentMissionServiceAuthorization,
  DecideQuoteAgentMissionCatalogueChoiceServiceOutput,
  GetCurrentQuoteAgentMissionServiceOutputV2,
  PatchQuoteAgentMissionLineServiceOutput,
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
  getCurrentV2(
    authorization: AgentMissionServiceAuthorization,
  ): Promise<Result<GetCurrentQuoteAgentMissionServiceOutputV2, AppError>>;
  getCurrentPlannerResumeV2(
    authorization: AgentMissionServiceAuthorization,
  ): Promise<Result<QuoteAgentMissionPlannerResumeV2, AppError>>;
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
  }): Promise<Result<DecideQuoteAgentMissionCatalogueChoiceServiceOutput, AppError>>;
  patchLineFromVoiceTurn(input: {
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
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly scope: AgentMissionQuoteLinePatchScope;
    readonly patch: AgentMissionQuoteLinePatchV1;
  }): Promise<Result<PatchQuoteAgentMissionLineServiceOutput, AppError>>;
  cancelPendingLineFromVoiceTurn(input: {
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
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
  }): Promise<
    Result<CancelQuoteAgentMissionPendingLineServiceOutput, AppError>
  >;
  decideLineProposalFromVoiceTurn(input: {
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
    readonly choiceSetHash: string;
    readonly choiceId: string;
    readonly pendingLineId: string;
    readonly proposalId: string;
    readonly proposalRevision: 1;
    readonly expectedWorkRevision: number;
    readonly expectedCatalogue:
      | { readonly itemId: string; readonly revision: number }
      | null;
    readonly diffHash: string;
  }): Promise<
    Result<DecideQuoteAgentMissionLineProposalServiceOutput, AppError>
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

export type RealtimeQuoteMissionPreparedTurn =
  | {
      readonly protocolVersion: 1;
      readonly snapshot: Readonly<{ readonly mission: AgentMissionViewV1 | null }>;
      readonly semanticContext: RealtimeQuoteSemanticMissionContext;
      readonly availableCapabilities: readonly string[];
    }
  | {
      readonly protocolVersion: 2;
      readonly snapshot: Readonly<GetCurrentQuoteAgentMissionServiceOutputV2>;
      readonly semanticContext: RealtimeQuoteSemanticMissionContext;
      readonly availableCapabilities: readonly string[];
    };

export type RealtimeQuoteMissionPreparationOutcome =
  | {
      readonly status: 'prepared';
      readonly prepared: RealtimeQuoteMissionPreparedTurn;
    }
  | { readonly status: 'failed'; readonly canonicalSpeech: string };

export interface RealtimeQuoteMissionOrchestratorPort {
  prepare(
    input: RealtimeQuoteMissionOrchestrationInput,
  ): Promise<RealtimeQuoteMissionPreparationOutcome>;
  runPlanned(input: {
    readonly request: RealtimeQuoteMissionOrchestrationInput;
    readonly prepared: RealtimeQuoteMissionPreparedTurn;
    readonly frame: QuoteCreationSemanticFrameV1 | QuoteCreationSemanticFrameV2;
  }): Promise<RealtimeQuoteMissionOrchestrationOutcome>;
}

const TEMPORARY_FAILURE =
  'Je rencontre un souci temporaire et je ne peux pas vérifier l’état de la mission. Consulte l’écran avant de réessayer.';
const UNSAFE_UNDERSTANDING =
  'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.';
const QUOTE_LINE_LIMIT_REACHED = `Ce devis contient déjà ${MAX_BILLING_LINES} lignes, soit la limite autorisée. Je n’ai ajouté aucune nouvelle ligne. Pour modifier ses lignes, arrête cette mission Bob : le brouillon restera enregistré et l’édition manuelle sera libérée.`;
const UNPROCESSED_REQUEST_REMINDER =
  'J’ai aussi entendu une autre demande dans cette phrase, mais je ne l’ai pas exécutée avec ce choix. Termine cette étape, puis redis-la pour que je la traite séparément.';

function discloseUnprocessedRequest(
  outcome: RealtimeQuoteMissionOrchestrationOutcome,
  hasUnprocessedRequest: boolean,
): RealtimeQuoteMissionOrchestrationOutcome {
  if (!hasUnprocessedRequest || outcome.status === 'failed') return outcome;
  return Object.freeze({
    ...outcome,
    canonicalSpeech: `${outcome.canonicalSpeech} ${UNPROCESSED_REQUEST_REMINDER}`,
  });
}
const QUOTE_SEMANTIC_CAPABILITIES_V2 = Object.freeze([
  'quote.line.stage',
  'quote.catalogue.search',
  'quote.line.patch',
  'quote.line.confirm',
] as const);
const QUOTE_SEMANTIC_CAPABILITIES_V1 = Object.freeze(['quote.customer.resolve'] as const);

function isQuoteLineLimitReached(error: AppError): boolean {
  return (
    error.kind === 'conflict' &&
    error.entity === 'agent_mission_quote_draft' &&
    error.reason === 'line_limit_reached'
  );
}

function understandingState(mission: AgentMissionViewV1 | null):
  | {
  readonly phase: QuoteCreationUnderstandingPhase;
  readonly presentedCustomerCount: number;
    }
  | 'mission_locked' {
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

type RealtimeQuoteMissionSnapshotV2 =
  Readonly<GetCurrentQuoteAgentMissionServiceOutputV2>;

function understandingStateV2(snapshot: RealtimeQuoteMissionSnapshotV2): {
  readonly phase: QuoteCreationUnderstandingPhaseV2;
  readonly presentedChoiceCount: number;
  readonly requiredFact: AgentMissionQuoteLineRequiredFact | null;
} | 'mission_locked' {
  const { mission, presentation } = snapshot;
  if (mission === null) {
    return presentation === null
      ? { phase: 'inactive', presentedChoiceCount: 0, requiredFact: null }
      : 'mission_locked';
  }
  if (presentation === null || mission.status !== 'active') return 'mission_locked';
  if (mission.phase === 'awaiting_customer') {
    return {
      phase: 'awaiting_customer',
      presentedChoiceCount: 0,
      requiredFact: null,
    };
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
      requiredFact: null,
    };
  }
  if (mission.phase === 'awaiting_lines') {
    return {
      phase: 'awaiting_lines',
      presentedChoiceCount: 0,
      requiredFact: null,
    };
  }
  if (
    mission.phase === 'awaiting_catalogue_choice'
    && presentation.decision?.kind === 'catalogue'
    && presentation.catalogueChoices.length >= 1
    && presentation.catalogueChoices.length <= 5
    && presentation.freeLineChoiceId !== null
  ) {
    return {
      phase: 'awaiting_catalogue_choice',
      presentedChoiceCount: presentation.catalogueChoices.length + 1,
      requiredFact: null,
    };
  }
  if (
    mission.phase === 'awaiting_line_details'
    && presentation.pendingLine !== null
    && presentation.decision === null
  ) {
    return {
      phase: 'awaiting_line_details',
      presentedChoiceCount: 0,
      requiredFact: presentation.requiredFact,
    };
  }
  if (
    mission.phase === 'awaiting_line_confirmation'
    && presentation.pendingLine !== null
    && presentation.requiredFact === null
    && presentation.decision?.kind === 'line_confirmation'
  ) {
    return {
      phase: 'awaiting_line_confirmation',
      presentedChoiceCount: 0,
      requiredFact: null,
    };
  }
  return 'mission_locked';
}

function choiceAlias(index: number): RealtimeSemanticPresentedChoice['alias'] {
  return `C${index + 1}` as RealtimeSemanticPresentedChoice['alias'];
}

function semanticContextV1(
  mission: AgentMissionViewV1 | null,
): RealtimeQuoteSemanticMissionContext {
  const state = understandingState(mission);
  const missionFence = {
    missionAlias: mission === null ? null : 'M1' as const,
    missionRevision: mission?.revision ?? 0,
    confirmedLineCount: 0,
    pendingLineCount: 0,
    pendingDecisionKind:
      mission?.payload.decision?.kind === 'customer'
        ? 'customer' as const
        : null,
  };
  if (state === 'mission_locked') {
    return {
      ...missionFence,
      protocolVersion: 1,
      phase: 'locked',
      presentedChoices: [],
    };
  }
  return {
    ...missionFence,
    protocolVersion: 1,
    phase: state.phase,
    presentedChoices: Object.freeze(
      Array.from({ length: state.presentedCustomerCount }, (_, index) => Object.freeze({
        alias: choiceAlias(index),
        kind: 'customer' as const,
        available: true,
        label: null,
        category: null,
        unit: null,
        unitPriceDecimal: null,
        currency: null,
      })),
    ),
  };
}

function plannerResumeMatchesSnapshot(
  snapshot: RealtimeQuoteMissionSnapshotV2,
  planner: QuoteAgentMissionPlannerResumeV2,
): boolean {
  const { resume, currentLine } = planner;
  if (snapshot.mission === null || snapshot.presentation === null) {
    return snapshot.mission === null
      && snapshot.presentation === null
      && resume.mission === null
      && resume.presentation === null
      && currentLine === null;
  }
  if (resume.mission === null || resume.presentation === null) return false;
  const draft = snapshot.mission.payload.draft;
  const pendingLine = snapshot.presentation.pendingLine;
  return draft !== null
    && resume.mission.id === snapshot.mission.id
    && resume.mission.status === snapshot.mission.status
    && resume.mission.phase === snapshot.mission.phase
    && resume.mission.revision === snapshot.mission.revision
    && resume.mission.actionable === snapshot.mission.actionable
    && resume.mission.draft.sessionId === draft.sessionId
    && resume.mission.draft.slotRevision === draft.slotRevision
    && resume.mission.draft.contentRevision === draft.contentRevision
    && (
      pendingLine === null
        ? currentLine === null
        : currentLine !== null
          && currentLine.pendingLineId === pendingLine.pendingLineId
          && currentLine.expectedWorkRevision === pendingLine.expectedWorkRevision
    )
    && sameSnapshot(
      { mission: snapshot.mission, presentation: resume.presentation },
      snapshot,
    );
}

function customerSemanticChoices(
  snapshot: RealtimeQuoteMissionSnapshotV2,
  resume: QuoteAgentMissionResumeViewV2,
): readonly RealtimeSemanticPresentedChoice[] | null {
  const decision = snapshot.mission?.payload.decision;
  if (
    snapshot.mission?.phase !== 'awaiting_customer_choice'
    || decision?.kind !== 'customer'
  ) {
    return resume.mission === null || resume.customerChoices.length === 0 ? [] : null;
  }
  if (
    resume.mission === null
    || resume.customerChoices.length !== decision.candidates.length
    || resume.customerChoices.length < 1
    || resume.customerChoices.length > 5
  ) return null;
  const choices: RealtimeSemanticPresentedChoice[] = [];
  for (let index = 0; index < decision.candidates.length; index += 1) {
    const sealed = decision.candidates[index];
    const projected = resume.customerChoices[index];
    if (
      sealed === undefined
      || projected === undefined
      || sealed.choiceId !== projected.choiceId
    ) return null;
    choices.push(Object.freeze({
      alias: choiceAlias(index),
      kind: 'customer',
      available: projected.status === 'available',
      label: projected.status === 'available' ? projected.label : null,
      category: null,
      unit: null,
      unitPriceDecimal: null,
      currency: null,
    }));
  }
  return Object.freeze(choices);
}

function catalogueSemanticChoices(
  snapshot: RealtimeQuoteMissionSnapshotV2,
): readonly RealtimeSemanticPresentedChoice[] | null {
  const { mission, presentation } = snapshot;
  if (
    mission?.phase !== 'awaiting_catalogue_choice'
    || presentation?.decision?.kind !== 'catalogue'
  ) return [];
  if (
    presentation.catalogueChoices.length < 1
    || presentation.catalogueChoices.length > 5
    || presentation.freeLineChoiceId === null
    || presentation.catalogueChoices.length
      !== presentation.decision.choices.length
  ) return null;
  const choices: RealtimeSemanticPresentedChoice[] = [];
  for (let index = 0; index < presentation.catalogueChoices.length; index += 1) {
    const projected = presentation.catalogueChoices[index];
    const sealed = presentation.decision.choices[index];
    if (
      projected === undefined
      || sealed === undefined
      || projected.choiceId !== sealed.choiceId
    ) return null;
    choices.push(Object.freeze({
      alias: choiceAlias(index),
      kind: 'catalogue',
      available: projected.available,
      label: projected.label,
      category: projected.category,
      unit: projected.unit,
      unitPriceDecimal: projected.unitPriceCents === null
        ? null
        : (projected.unitPriceCents / 100).toFixed(2),
      currency: projected.unitPriceCents === null ? null : 'EUR',
    }));
  }
  choices.push(Object.freeze({
    alias: choiceAlias(choices.length),
    kind: 'free_line',
    available: true,
    label: 'Créer une ligne libre',
    category: null,
    unit: null,
    unitPriceDecimal: null,
    currency: null,
  }));
  return Object.freeze(choices);
}

function scaledDecimal(value: number, scale: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / scale);
  const fraction = String(absolute % scale)
    .padStart(String(scale - 1).length, '0')
    .replace(/0+$/u, '');
  return `${sign}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

function semanticCurrentLine(
  current: QuoteAgentMissionPlannerResumeV2['currentLine'],
  presentation: QuoteAgentMissionPresentationV1 | null,
): RealtimeSemanticCurrentLine | null {
  const line = presentation?.proposal?.line;
  if (line !== undefined) {
    return Object.freeze({
      label: line.label,
      category: line.category,
      quantityDecimal: String(line.qty),
      unit: line.unit ?? null,
      unitPriceDecimal: scaledDecimal(line.unitPriceHT, 100),
      currency: 'EUR',
      vatRate: String(line.vatRate),
      priceBasis: current?.priceBasis ?? 'per_unit',
      housingOlderThan2y: current?.housingOlderThan2y ?? null,
      energyRenovation: current?.energyRenovation ?? null,
    });
  }
  if (current === null) return null;
  return Object.freeze({
    label: current.serviceReference,
    category: current.category,
    quantityDecimal: current.quantityMilli === null
      ? null
      : scaledDecimal(current.quantityMilli, 1_000),
    unit: current.unit,
    unitPriceDecimal: current.unitPriceCents === null
      ? null
      : scaledDecimal(current.unitPriceCents, 100),
    currency: current.unitPriceCents === null ? null : 'EUR',
    vatRate: current.requestedVatRate === null
      ? null
      : String(current.requestedVatRate),
    priceBasis: current.priceBasis,
    housingOlderThan2y: current.housingOlderThan2y,
    energyRenovation: current.energyRenovation,
  });
}

function semanticContextV2(
  snapshot: RealtimeQuoteMissionSnapshotV2,
  planner: QuoteAgentMissionPlannerResumeV2,
): RealtimeQuoteSemanticMissionContext | null {
  if (!plannerResumeMatchesSnapshot(snapshot, planner)) return null;
  const { resume } = planner;
  const state = understandingStateV2(snapshot);
  const pendingDecisionKind =
    snapshot.mission?.payload.decision?.kind === 'customer'
      ? 'customer' as const
      : snapshot.presentation?.decision?.kind ?? null;
  const missionFence = {
    missionAlias: snapshot.mission === null ? null : 'M1' as const,
    missionRevision: snapshot.mission?.revision ?? 0,
    confirmedLineCount: planner.confirmedLineCount,
    pendingLineCount: planner.pendingLineCount,
    pendingDecisionKind,
  };
  if (state === 'mission_locked') {
    return {
      ...missionFence,
      protocolVersion: 2,
      phase: 'locked',
      presentedChoices: [],
    };
  }
  const customerChoices = customerSemanticChoices(snapshot, resume);
  const catalogueChoices = catalogueSemanticChoices(snapshot);
  if (customerChoices === null || catalogueChoices === null) return null;
  const presentedChoices = state.phase === 'awaiting_customer_choice'
    ? customerChoices
    : state.phase === 'awaiting_catalogue_choice'
      ? catalogueChoices
      : [];
  return {
    ...missionFence,
    protocolVersion: 2,
    phase: state.phase,
    requiredFact: state.requiredFact,
    presentedChoices,
    currentLine: semanticCurrentLine(
      planner.currentLine,
      snapshot.presentation,
    ),
  };
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

function currentCatalogueChoiceState(
  mission: AgentMissionViewV1,
  presentation: QuoteAgentMissionPresentationV1,
): {
  readonly choices: readonly {
    readonly available: boolean;
    readonly label: string | null;
    readonly unit: string | null;
    readonly unitPriceCents: number | null;
  }[];
} | null {
  return mission.status === 'active'
    && mission.phase === 'awaiting_catalogue_choice'
    && presentation.decision?.kind === 'catalogue'
    && presentation.freeLineChoiceId !== null
    ? {
        choices: Object.freeze(presentation.catalogueChoices.map((choice) => (
          Object.freeze({
            available: choice.available,
            label: choice.label,
            unit: choice.unit,
            unitPriceCents: choice.unitPriceCents,
          })
        ))),
      }
    : null;
}

function canonicalCatalogueChoiceSpeech(state: {
  readonly choices: readonly {
    readonly available: boolean;
    readonly label: string | null;
    readonly unit: string | null;
    readonly unitPriceCents: number | null;
  }[];
}): string {
  const ordinalLabels = [
    'Premier choix',
    'Deuxième choix',
    'Troisième choix',
    'Quatrième choix',
    'Cinquième choix',
  ] as const;
  const catalogueChoices = state.choices.map((choice, index) => {
    const ordinal = ordinalLabels[index] ?? `Choix numéro ${index + 1}`;
    if (
      !choice.available
      || choice.label === null
      || choice.unit === null
      || choice.unitPriceCents === null
    ) {
      return `${ordinal} : cette prestation n’est plus disponible.`;
    }
    return [
      `${ordinal} : « ${choice.label} »`,
      `à ${formatFrenchEuros(choice.unitPriceCents / 100)} hors taxes par ${choice.unit}.`,
    ].join(', ');
  });
  const availableCount = state.choices.filter((choice) => (
    choice.available
    && choice.label !== null
    && choice.unit !== null
    && choice.unitPriceCents !== null
  )).length;
  const introduction = availableCount === 0
    ? 'Aucune prestation catalogue affichée ne peut être sélectionnée.'
    : `J’ai trouvé ${availableCount} prestation${availableCount > 1 ? 's' : ''} disponible${availableCount > 1 ? 's' : ''} dans ton catalogue.`;
  return [
    introduction,
    ...catalogueChoices,
    'Dernier choix : créer une ligne libre.',
    'Tu peux dire le premier, le deuxième, ou le choix que tu veux.',
  ].join(' ');
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

function formatFrenchNumber(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 3,
  }).format(value);
}

function formatFrenchEuros(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function canonicalProposalSpeech(
  presentation: QuoteAgentMissionPresentationV1,
): string {
  if (presentation.proposalStatus.kind === 'stale') {
    return presentation.proposalStatus.reason === 'catalogue_changed'
      ? 'La prestation du catalogue a changé. Rien n’a été ajouté. Corrige la ligne pour que je prépare une nouvelle proposition.'
      : 'Le contexte de TVA a changé. Rien n’a été ajouté. Corrige la ligne pour que je prépare une nouvelle proposition.';
  }
  const proposal = presentation.proposal;
  if (
    presentation.proposalStatus.kind !== 'available'
    || proposal === null
  ) {
    return 'La proposition n’est plus disponible. Rien n’a été ajouté ; j’ai actualisé l’état réel.';
  }
  const line = proposal.line;
  const unit = line.unit === undefined || line.unit.trim().length === 0
    ? ''
    : ` ${line.unit}`;
  const catalogue = proposal.catalogue === null
    ? 'ligne libre'
    : `catalogue « ${proposal.catalogue.label} »`;
  const totalBefore = formatFrenchEuros(
    proposal.diff.before.totalHtCents / 100,
  );
  const totalAfter = formatFrenchEuros(
    proposal.diff.after.totalHtCents / 100,
  );
  return [
    `J’ai préparé « ${line.label} » : ${formatFrenchNumber(line.qty)}${unit},`,
    `${formatFrenchEuros(line.unitPriceHT / 100)} hors taxes par unité,`,
    `TVA ${formatFrenchNumber(line.vatRate)} %, depuis ${catalogue}.`,
    `Le total hors taxes du devis passerait de ${totalBefore} à ${totalAfter}.`,
    'Dis-moi si tu confirmes, si tu veux la corriger ou l’annuler.',
  ].join(' ');
}

function canonicalLineContinuationState(
  continuation: AgentMissionLineContinuationServiceOutput,
  snapshot: Readonly<{
    readonly mission: AgentMissionViewV1;
    readonly presentation: QuoteAgentMissionPresentationV1;
  }>,
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
      canonicalSpeech: canonicalProposalSpeech(snapshot.presentation),
      speechPurpose: 'structured_choice',
    };
  }
  return canonicalV2MissionState(snapshot);
}

function canonicalV2MissionState(
  snapshot: RealtimeQuoteMissionSnapshotV2,
): RealtimeQuoteMissionOrchestrationOutcome {
  const { mission, presentation } = snapshot;
  if (mission === null || mission.status !== 'active') {
    return {
      status: 'handled',
      canonicalSpeech:
        'Cette mission n’est plus active. J’ai actualisé son état sans exécuter une nouvelle action.',
      speechPurpose: 'action_result',
    };
  }
  if (presentation === null) {
    return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
  }
  const catalogueState = currentCatalogueChoiceState(mission, presentation);
  if (catalogueState !== null) {
    return {
      status: 'handled',
      canonicalSpeech: canonicalCatalogueChoiceSpeech(catalogueState),
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
      canonicalSpeech: requiredFactSpeech(presentation.requiredFact),
      speechPurpose: 'structured_choice',
    };
  }
  if (mission.phase === 'awaiting_line_confirmation') {
    return {
      status: 'handled',
      canonicalSpeech: canonicalProposalSpeech(presentation),
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

function sameSnapshot(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function withCanonicalPrefix(
  prefix: string,
  outcome: RealtimeQuoteMissionOrchestrationOutcome,
): RealtimeQuoteMissionOrchestrationOutcome {
  if (outcome.status !== 'handled') return outcome;
  return {
    ...outcome,
    canonicalSpeech: `${prefix} ${outcome.canonicalSpeech}`,
  };
}

function canonicalLineDecisionOutcome(
  operation:
    | 'confirm_current_proposal'
    | 'reject_current_proposal'
    | 'cancel_current_line',
  output: DecideQuoteAgentMissionLineProposalServiceOutput,
): RealtimeQuoteMissionOrchestrationOutcome {
  const snapshot = {
    mission: output.mission,
    presentation: output.presentation,
  } as const;
  if (
    output.outcome === 'invalidated'
    || (
      output.outcome === 'replayed'
      && output.invalidationReason !== null
    )
  ) {
    return canonicalV2MissionState(snapshot);
  }
  if (operation === 'confirm_current_proposal') {
    if (output.outcome !== 'confirmed' && output.outcome !== 'replayed') {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    return withCanonicalPrefix(
      'La ligne est ajoutée au devis.',
      canonicalLineContinuationState(output.continuation, snapshot),
    );
  }
  if (operation === 'reject_current_proposal') {
    if (output.outcome !== 'edit_requested' && output.outcome !== 'replayed') {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    return withCanonicalPrefix(
      'La ligne reste dans la mission et n’a pas été ajoutée au devis.',
      canonicalLineContinuationState(output.continuation, snapshot),
    );
  }
  if (output.outcome !== 'cancelled' && output.outcome !== 'replayed') {
    return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
  }
  return withCanonicalPrefix(
    'La ligne est retirée de la mission. Le devis n’a pas été modifié.',
    canonicalLineContinuationState(output.continuation, snapshot),
  );
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
  constructor(private readonly missions: RealtimeQuoteMissionGateway) {}

  private async convergeAfterUncertainDecision(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly signal: AbortSignal;
  }): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    if (input.authorization.proof.protocolVersion === 2) {
      let refreshedV2: Awaited<
        ReturnType<RealtimeQuoteMissionGateway['getCurrentV2']>
      >;
      try {
        refreshedV2 = await this.missions.getCurrentV2(input.authorization);
      } catch {
        input.signal.throwIfAborted();
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      input.signal.throwIfAborted();
      return refreshedV2.ok
        ? canonicalV2MissionState(refreshedV2.value)
        : { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    let refreshed: Awaited<
      ReturnType<RealtimeQuoteMissionGateway['getCurrent']>
    >;
    try {
      refreshed = await this.missions.getCurrent(input.authorization);
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    return refreshed.ok
      ? canonicalConvergedDecision(refreshed.value.mission)
      : { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
  }

  private async runV2(input: {
    readonly request: RealtimeQuoteMissionOrchestrationInput;
    readonly authorization: AgentMissionServiceAuthorization;
    readonly snapshot: RealtimeQuoteMissionSnapshotV2;
    readonly frame: QuoteCreationSemanticFrameV2;
  }): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    input.request.signal.throwIfAborted();
    const operation = input.frame.operations[0];
    if (operation === undefined) {
      return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
    }

    let refreshed: Awaited<
      ReturnType<RealtimeQuoteMissionGateway['getCurrentV2']>
    >;
    try {
      refreshed = await this.missions.getCurrentV2(input.authorization);
    } catch {
      input.request.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.request.signal.throwIfAborted();
    if (!refreshed.ok) {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    if (!sameSnapshot(input.snapshot, refreshed.value)) {
      return canonicalV2MissionState(refreshed.value);
    }

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
      if (!started.ok) {
        if (isQuoteLineLimitReached(started.error)) {
          return {
            status: 'handled',
            canonicalSpeech: QUOTE_LINE_LIMIT_REACHED,
            speechPurpose: 'action_result',
          };
        }
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      if (started.value.mission.status !== 'active') {
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      return {
        status: 'ready',
        canonicalSpeech: canonicalStartSpeech(started.value.mission),
        navigate: '/devis/new',
      };
    }

    const mission = refreshed.value.mission;
    const presentation = refreshed.value.presentation;
    const draft = mission?.payload.draft ?? null;
    if (mission === null || draft === null || presentation === null) {
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
        if (isQuoteLineLimitReached(staged.error)) {
          return {
            status: 'handled',
            canonicalSpeech: QUOTE_LINE_LIMIT_REACHED,
            speechPurpose: 'action_result',
          };
        }
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
      return canonicalLineContinuationState(staged.value.continuation, {
          mission: staged.value.mission,
          presentation: staged.value.presentation,
      });
    }

    if (
      operation.kind === 'set_customer_reference' ||
      (operation.kind === 'select_presented_choice' && mission.phase === 'awaiting_customer_choice')
    ) {
      const decision =
        operation.kind === 'select_presented_choice'
        ? (() => {
            const presented = mission.payload.decision;
              const candidate =
                presented?.kind === 'customer'
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
      const lines = operation.kind === 'set_customer_reference' ? operation.lines : [];
      if (decision === null) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      let decided: Awaited<ReturnType<RealtimeQuoteMissionGateway['decideFromVoiceTurn']>>;
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
          lines,
        });
      } catch {
        input.request.signal.throwIfAborted();
        const converged = await this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
        return discloseUnprocessedRequest(
          converged,
          operation.kind === 'select_presented_choice' && operation.hasUnprocessedRequest,
        );
      }
      input.request.signal.throwIfAborted();
      if (!decided.ok) {
        if (isQuoteLineLimitReached(decided.error)) {
          return discloseUnprocessedRequest(
            {
            status: 'handled',
            canonicalSpeech: QUOTE_LINE_LIMIT_REACHED,
            speechPurpose: 'action_result',
            },
            operation.kind === 'select_presented_choice' && operation.hasUnprocessedRequest,
          );
        }
        const converged = await this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
        return discloseUnprocessedRequest(
          converged,
          operation.kind === 'select_presented_choice' && operation.hasUnprocessedRequest,
        );
      }
      const converged = await this.convergeAfterUncertainDecision({
        authorization: input.authorization,
        signal: input.request.signal,
      });
      return discloseUnprocessedRequest(
        converged,
        operation.kind === 'select_presented_choice' && operation.hasUnprocessedRequest,
      );
    }

    if (
      operation.kind === 'select_presented_choice'
      && mission.phase === 'awaiting_catalogue_choice'
    ) {
      const presented = presentation.decision;
      if (presented?.kind !== 'catalogue') {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      const choiceIds = [
        ...presented.choices.map((choice) => choice.choiceId),
        presented.freeLineChoiceId,
      ];
      const choiceId = choiceIds[operation.ordinal - 1];
      if (choiceId === undefined) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      const catalogueChoice = presentation.catalogueChoices[operation.ordinal - 1];
      if (
        operation.ordinal <= presented.choices.length &&
        (catalogueChoice === undefined || catalogueChoice.choiceId !== choiceId)
      ) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      if (catalogueChoice?.available === false) {
        return discloseUnprocessedRequest(
          {
          status: 'handled',
            canonicalSpeech: `La prestation numéro ${operation.ordinal} n’est plus disponible dans ton catalogue. Rien n’a été sélectionné. Choisis une autre option affichée ou la ligne libre.`,
          speechPurpose: 'structured_choice',
          },
          operation.hasUnprocessedRequest,
        );
      }
      let decided: Awaited<
        ReturnType<RealtimeQuoteMissionGateway['decideCatalogueChoiceFromVoiceTurn']>
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
        });
      } catch {
        input.request.signal.throwIfAborted();
        const converged = await this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
        return discloseUnprocessedRequest(converged, operation.hasUnprocessedRequest);
      }
      input.request.signal.throwIfAborted();
      if (!decided.ok) {
        if (isQuoteLineLimitReached(decided.error)) {
          return discloseUnprocessedRequest(
            {
            status: 'handled',
            canonicalSpeech: QUOTE_LINE_LIMIT_REACHED,
            speechPurpose: 'action_result',
            },
            operation.hasUnprocessedRequest,
          );
        }
        const converged = await this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
        return discloseUnprocessedRequest(converged, operation.hasUnprocessedRequest);
      }
      if (decided.value.outcome === 'invalidated') {
        if (decided.value.continuation.outcome === 'catalogue_not_found') {
          return discloseUnprocessedRequest(
            {
            status: 'handled',
            canonicalSpeech:
              'Cette prestation a changé. Après relecture, aucune correspondance actuelle ne reste ; la ligne libre est conservée sans tarif inventé.',
            speechPurpose: 'action_result',
            },
            operation.hasUnprocessedRequest,
          );
        }
        return discloseUnprocessedRequest(
          canonicalLineContinuationState(decided.value.continuation, {
            mission: decided.value.mission,
            presentation: decided.value.presentation,
          }),
          operation.hasUnprocessedRequest,
        );
      }
      return discloseUnprocessedRequest(
        canonicalLineContinuationState(decided.value.continuation, {
          mission: decided.value.mission,
          presentation: decided.value.presentation,
        }),
        operation.hasUnprocessedRequest,
      );
    }

    if (operation.kind === 'patch_pending_line') {
      const pendingLine = presentation.pendingLine;
      if (pendingLine === null) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      let patched: Awaited<
        ReturnType<RealtimeQuoteMissionGateway['patchLineFromVoiceTurn']>
      >;
      try {
        patched = await this.missions.patchLineFromVoiceTurn({
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
          pendingLineId: pendingLine.pendingLineId,
          expectedWorkRevision: pendingLine.expectedWorkRevision,
          scope: operation.scope,
          patch: operation.patch,
        });
      } catch {
        input.request.signal.throwIfAborted();
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      input.request.signal.throwIfAborted();
      if (!patched.ok) {
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      return canonicalLineContinuationState(
        patched.value.continuation,
        {
          mission: patched.value.mission,
          presentation: patched.value.presentation,
        },
      );
    }

    if (
      operation.kind === 'cancel_current_line'
      && mission.phase === 'awaiting_line_details'
    ) {
      const pendingLine = presentation.pendingLine;
      if (
        pendingLine === null
        || presentation.decision !== null
        || pendingLine.pendingLineId.length === 0
      ) {
        return canonicalV2MissionState(refreshed.value);
      }
      let cancelled: Awaited<
        ReturnType<
          RealtimeQuoteMissionGateway['cancelPendingLineFromVoiceTurn']
        >
      >;
      try {
        cancelled = await this.missions.cancelPendingLineFromVoiceTurn({
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
          pendingLineId: pendingLine.pendingLineId,
          expectedWorkRevision: pendingLine.expectedWorkRevision,
        });
      } catch {
        input.request.signal.throwIfAborted();
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      input.request.signal.throwIfAborted();
      if (!cancelled.ok) {
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      return withCanonicalPrefix(
        'La ligne est retirée de la mission. Le devis n’a pas été modifié.',
        canonicalLineContinuationState(
          cancelled.value.continuation,
          {
            mission: cancelled.value.mission,
            presentation: cancelled.value.presentation,
          },
        ),
      );
    }

    if (
      operation.kind === 'confirm_current_proposal'
      || operation.kind === 'reject_current_proposal'
      || operation.kind === 'cancel_current_line'
    ) {
      const decision = presentation.decision;
      const pendingLine = presentation.pendingLine;
      if (
        decision?.kind !== 'line_confirmation'
        || pendingLine === null
        || pendingLine.pendingLineId !== decision.pendingLineId
        || pendingLine.expectedWorkRevision !== decision.expectedWorkRevision
        || (
          operation.kind === 'confirm_current_proposal'
          && (
            presentation.proposalStatus.kind !== 'available'
            || presentation.proposal === null
            || presentation.proposal.proposalId !== decision.proposalId
            || presentation.proposal.diffHash !== decision.diffHash
          )
        )
      ) {
        return canonicalV2MissionState(refreshed.value);
      }
      const action = operation.kind === 'confirm_current_proposal'
        ? 'confirm_line'
        : operation.kind === 'reject_current_proposal'
          ? 'edit_line'
          : 'cancel_line';
      const choice = decision.choices.find((candidate) => candidate.action === action);
      if (choice === undefined) {
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      let decided: Awaited<
        ReturnType<
          RealtimeQuoteMissionGateway['decideLineProposalFromVoiceTurn']
        >
      >;
      try {
        decided = await this.missions.decideLineProposalFromVoiceTurn({
          authorization: input.authorization,
          missionId: mission.id,
          turnId: input.request.turnId,
          realtimeSessionId: input.request.authority.realtimeSessionId,
          contextRevision: input.request.contextRevision,
          contextDigest: input.request.contextDigest,
          expectedMissionRevision: mission.revision,
          expectedDraftSessionId: decision.expectedDraft.sessionId,
          expectedDraftSlotRevision: decision.expectedDraft.slotRevision,
          expectedDraftContentRevision: decision.expectedDraft.contentRevision,
          decisionId: decision.decisionId,
          choiceSetRevision: decision.choiceSetRevision,
          choiceSetHash: decision.choiceSetHash,
          choiceId: choice.choiceId,
          pendingLineId: decision.pendingLineId,
          proposalId: decision.proposalId,
          proposalRevision: decision.proposalRevision,
          expectedWorkRevision: decision.expectedWorkRevision,
          expectedCatalogue: decision.expectedCatalogue,
          diffHash: decision.diffHash,
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
      return canonicalLineDecisionOutcome(operation.kind, decided.value);
    }

    return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
  }

  private async runV1(input: {
    readonly request: RealtimeQuoteMissionOrchestrationInput;
    readonly authorization: AgentMissionServiceAuthorization;
    readonly snapshot: Readonly<{ readonly mission: AgentMissionViewV1 | null }>;
    readonly frame: QuoteCreationSemanticFrameV1;
  }): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    const operation = input.frame.operation;
    if (operation.kind === 'unrelated') {
      return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
    }
    let refreshed: Awaited<ReturnType<RealtimeQuoteMissionGateway['getCurrent']>>;
    try {
      refreshed = await this.missions.getCurrent(input.authorization);
    } catch {
      input.request.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.request.signal.throwIfAborted();
    if (!refreshed.ok) {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    if (!sameSnapshot(input.snapshot, refreshed.value)) {
      return canonicalConvergedDecision(refreshed.value.mission);
    }
    if (
      operation.kind === 'set_customer_reference'
      || operation.kind === 'select_presented_customer'
    ) {
      const mission = refreshed.value.mission;
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
          lines: [],
        });
      } catch {
        input.request.signal.throwIfAborted();
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      input.request.signal.throwIfAborted();
      if (!decided.ok || decided.value.mission.status !== 'active') {
        return this.convergeAfterUncertainDecision({
          authorization: input.authorization,
          signal: input.request.signal,
        });
      }
      return canonicalDecisionOutcome(decided.value);
    }

    let started: Awaited<ReturnType<RealtimeQuoteMissionGateway['startFromVoiceTurn']>>;
    try {
      started = await this.missions.startFromVoiceTurn({
        authorization: input.authorization,
        realtimeSessionId: input.request.authority.realtimeSessionId,
        turnId: input.request.turnId,
        contextRevision: input.request.contextRevision,
        contextDigest: input.request.contextDigest,
        customerReference: operation.customerReference,
        lines: [],
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

  async prepare(
    input: RealtimeQuoteMissionOrchestrationInput,
  ): Promise<RealtimeQuoteMissionPreparationOutcome> {
    input.signal.throwIfAborted();
    const authorization: AgentMissionServiceAuthorization = {
      owner: input.authority.owner,
      proof: input.authority.proof,
    };
    if (input.authority.proof.protocolVersion === 2) {
      let current: Awaited<ReturnType<RealtimeQuoteMissionGateway['getCurrentV2']>>;
      let resume: Awaited<
        ReturnType<RealtimeQuoteMissionGateway['getCurrentPlannerResumeV2']>
      >;
      try {
        current = await this.missions.getCurrentV2(authorization);
        input.signal.throwIfAborted();
        resume = await this.missions.getCurrentPlannerResumeV2(authorization);
      } catch {
        input.signal.throwIfAborted();
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      input.signal.throwIfAborted();
      if (!current.ok || !resume.ok) {
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      const semanticContext = semanticContextV2(current.value, resume.value);
      if (semanticContext === null) {
        return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
      }
      return {
        status: 'prepared',
        prepared: Object.freeze({
          protocolVersion: 2,
          snapshot: current.value,
          semanticContext,
          availableCapabilities:
            semanticContext.phase === 'locked'
              ? Object.freeze([])
              : QUOTE_SEMANTIC_CAPABILITIES_V2,
        }),
      };
    }
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
    const semanticContext = semanticContextV1(current.value.mission);
    return {
      status: 'prepared',
      prepared: Object.freeze({
        protocolVersion: 1,
        snapshot: current.value,
        semanticContext,
        availableCapabilities:
          semanticContext.phase === 'locked'
            ? Object.freeze([])
            : QUOTE_SEMANTIC_CAPABILITIES_V1,
      }),
    };
  }

  runPlanned(input: {
    readonly request: RealtimeQuoteMissionOrchestrationInput;
    readonly prepared: RealtimeQuoteMissionPreparedTurn;
    readonly frame: QuoteCreationSemanticFrameV1 | QuoteCreationSemanticFrameV2;
  }): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    input.request.signal.throwIfAborted();
    const authorization: AgentMissionServiceAuthorization = {
      owner: input.request.authority.owner,
      proof: input.request.authority.proof,
    };
    if (
      input.prepared.semanticContext.phase === 'locked'
      || input.prepared.protocolVersion !== input.frame.version
      || input.request.authority.proof.protocolVersion !== input.prepared.protocolVersion
    ) {
      return Promise.resolve({
        status: 'failed',
        canonicalSpeech: UNSAFE_UNDERSTANDING,
      });
    }
    return input.prepared.protocolVersion === 2 && input.frame.version === 2
      ? this.runV2({
          request: input.request,
          authorization,
          snapshot: input.prepared.snapshot,
          frame: input.frame,
        })
      : input.prepared.protocolVersion === 1 && input.frame.version === 1
        ? this.runV1({
            request: input.request,
            authorization,
            snapshot: input.prepared.snapshot,
            frame: input.frame,
          })
        : Promise.resolve({
            status: 'failed',
            canonicalSpeech: UNSAFE_UNDERSTANDING,
          });
  }
}
