import type {
  AcknowledgeQuoteScreenOutput,
  AgentMissionQuoteLinePatchScope,
  AgentMissionQuoteLinePatchV1,
  AgentMissionQuoteLineRequiredFact,
  AgentMissionQuoteLineCandidateV1,
  AgentMissionViewV1,
  AppError,
  CancelQuoteAgentMissionOutput,
  DecideQuoteAgentMissionOutput,
  QuoteAgentMissionPresentationV1,
  Result,
  StageQuoteAgentMissionLinesOutput,
  StartQuoteAgentMissionOutput,
} from '@bob/core';

/**
 * Version demandée par le mobile publié tant que M2-A-3 n'a pas certifié la projection device.
 *
 * Ne pas remplacer cette constante par `2` : le support M2-A est additif et explicite via
 * `REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION`.
 */
export const REALTIME_AGENT_MISSION_PROTOCOL_VERSION = 1 as const;
export const REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION = 2 as const;
export type RealtimeAgentMissionProtocolVersion =
  | typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION
  | typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION;

export interface RealtimeAgentMissionStartQuoteInput {
  readonly commandId: string;
}

export interface RealtimeAgentMissionCancelQuoteInput {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  /**
   * Optionnel uniquement pour compatibilité avec un mobile N-1. Le client courant l'envoie
   * toujours ; absent signifie l'annulation utilisateur historique.
   */
  readonly reason?: 'user_cancelled' | 'manual_handoff';
}

export interface RealtimeAgentMissionAcknowledgeQuoteScreenInput {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly draftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
}

export type RealtimeAgentMissionAcknowledgeQuoteScreenOutputV2 =
  AcknowledgeQuoteScreenOutput & {
    readonly presentation: QuoteAgentMissionPresentationV1;
  };

interface RealtimeAgentMissionQuoteDecisionBase {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
}

export type RealtimeAgentMissionQuoteDecisionInput =
  & RealtimeAgentMissionQuoteDecisionBase
  & (
    | {
        readonly action: 'choose_presented_option';
        readonly decisionId: string;
        readonly choiceSetRevision: number;
        readonly choiceId: string;
      }
    | {
        readonly action: 'select_screen_customer';
        readonly customerId: string;
      }
  );

export type RealtimeAgentMissionQuoteDecisionOutputV2 =
  DecideQuoteAgentMissionOutput & {
    readonly presentation: QuoteAgentMissionPresentationV1;
  };

interface RealtimeAgentMissionQuoteLineCommandBase {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
}

export interface RealtimeAgentMissionStageQuoteLinesInput
extends RealtimeAgentMissionQuoteLineCommandBase {
  readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
}

export interface RealtimeAgentMissionCatalogueChoiceInput
extends RealtimeAgentMissionQuoteLineCommandBase {
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly choiceId: string;
  readonly additionalLines: readonly AgentMissionQuoteLineCandidateV1[];
}

export interface RealtimeAgentMissionLineContinuation {
  readonly outcome:
    | 'catalogue_not_found'
    | 'choices_presented'
    | 'empty'
    | 'deferred_to_m2a2'
    | 'details_requested'
    | 'proposal_presented'
    | 'catalogue_choice_pending'
    | 'stable'
    | 'superseded'
    | 'replayed';
  readonly pendingLineId: string | null;
  readonly presentedChoiceCount: number;
  readonly requiredFact: AgentMissionQuoteLineRequiredFact | null;
  readonly proposalId: string | null;
}

export interface RealtimeAgentMissionStageQuoteLinesOutput
extends Omit<StageQuoteAgentMissionLinesOutput, 'mission'> {
  readonly mission: AgentMissionViewV1;
  readonly continuation: RealtimeAgentMissionLineContinuation;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

export interface RealtimeAgentMissionCatalogueChoiceOutput {
  readonly outcome: 'selected' | 'invalidated' | 'replayed';
  readonly resolution: 'free' | 'selected' | null;
  readonly invalidationReason:
    | 'candidate_unavailable'
    | 'choice_set_stale'
    | null;
  readonly mission: AgentMissionViewV1;
  readonly continuation: RealtimeAgentMissionLineContinuation;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

export interface RealtimeAgentMissionPatchQuoteLineInput
extends RealtimeAgentMissionQuoteLineCommandBase {
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly scope: AgentMissionQuoteLinePatchScope;
  readonly patch: AgentMissionQuoteLinePatchV1;
}

export interface RealtimeAgentMissionPatchQuoteLineOutput {
  readonly outcome: 'patched' | 'replayed';
  readonly pendingLineId: string;
  readonly workRevisionAfter: number;
  readonly mission: AgentMissionViewV1;
  readonly continuation: RealtimeAgentMissionLineContinuation;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

export interface RealtimeAgentMissionLineProposalDecisionInput
extends RealtimeAgentMissionQuoteLineCommandBase {
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
}

export interface RealtimeAgentMissionLineProposalDecisionOutput {
  readonly outcome:
    | 'confirmed'
    | 'edit_requested'
    | 'cancelled'
    | 'invalidated'
    | 'replayed';
  readonly invalidationReason:
    | 'candidate_unavailable'
    | 'choice_set_stale'
    | null;
  readonly mission: AgentMissionViewV1;
  readonly continuation: RealtimeAgentMissionLineContinuation;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

/**
 * Capability Bob Live volatile.
 *
 * Le secret n'est jamais un champ de cet objet : l'implémentation HTTP le conserve dans un
 * champ privé natif et ajoute elle-même le header. Le handle est transférable entre couches,
 * mais ni sérialisable ni reconstructible à partir de son `realtimeSessionId`.
 */
interface RealtimeAgentMissionSessionCommon {
  readonly protocolVersion: RealtimeAgentMissionProtocolVersion;
  readonly realtimeSessionId: string;
  readonly disposed: boolean;
  getCurrentQuoteCreation(
    signal?: AbortSignal,
  ): Promise<Result<{ readonly mission: AgentMissionViewV1 | null }, AppError>>;
  startQuoteCreation(
    input: RealtimeAgentMissionStartQuoteInput,
    signal?: AbortSignal,
  ): Promise<Result<StartQuoteAgentMissionOutput, AppError>>;
  cancelQuoteCreation(
    input: RealtimeAgentMissionCancelQuoteInput,
    signal?: AbortSignal,
  ): Promise<Result<CancelQuoteAgentMissionOutput, AppError>>;
  acknowledgeQuoteScreen(
    input: RealtimeAgentMissionAcknowledgeQuoteScreenInput,
    signal?: AbortSignal,
  ): Promise<Result<AcknowledgeQuoteScreenOutput, AppError>>;
  decideQuoteCreation(
    input: RealtimeAgentMissionQuoteDecisionInput,
    signal?: AbortSignal,
  ): Promise<Result<DecideQuoteAgentMissionOutput, AppError>>;
  /** Efface immédiatement la capability et rend toute méthode réseau inopérante. */
  dispose(): void;
}

export interface RealtimeAgentMissionSessionV1
extends RealtimeAgentMissionSessionCommon {
  readonly protocolVersion: typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION;
}

export interface RealtimeAgentMissionSessionV2
extends RealtimeAgentMissionSessionCommon {
  readonly protocolVersion: typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION;
  acknowledgeQuoteScreen(
    input: RealtimeAgentMissionAcknowledgeQuoteScreenInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeAgentMissionAcknowledgeQuoteScreenOutputV2, AppError>>;
  decideQuoteCreation(
    input: RealtimeAgentMissionQuoteDecisionInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeAgentMissionQuoteDecisionOutputV2, AppError>>;
  stageQuoteLines(
    input: RealtimeAgentMissionStageQuoteLinesInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeAgentMissionStageQuoteLinesOutput, AppError>>;
  decideQuoteCatalogueChoice(
    input: RealtimeAgentMissionCatalogueChoiceInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeAgentMissionCatalogueChoiceOutput, AppError>>;
  patchQuoteLine(
    input: RealtimeAgentMissionPatchQuoteLineInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeAgentMissionPatchQuoteLineOutput, AppError>>;
  decideQuoteLineProposal(
    input: RealtimeAgentMissionLineProposalDecisionInput,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeAgentMissionLineProposalDecisionOutput, AppError>>;
}

export type RealtimeAgentMissionSession =
  | RealtimeAgentMissionSessionV1
  | RealtimeAgentMissionSessionV2;
