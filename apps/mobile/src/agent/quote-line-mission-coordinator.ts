import type {
  AgentMissionQuoteLineCandidateV1,
  AgentMissionQuoteLinePatchV1,
  AgentMissionViewV1,
  QuoteAgentMissionPresentationV1,
} from '@bob/core';
import type {
  AgentMissionRuntimeActions,
} from './agent-mission-runtime';
import { AgentMissionCommandIdRegistry } from './agent-mission-command-id-registry';

export interface QuoteLineMissionFrame {
  readonly mission: AgentMissionViewV1;
  readonly presentation: QuoteAgentMissionPresentationV1;
  readonly expectedScreenInstanceId: string;
}

type QuoteLineActions = Pick<
  AgentMissionRuntimeActions,
  | 'stageQuoteLines'
  | 'decideQuoteCatalogueChoice'
  | 'patchQuoteLine'
  | 'cancelPendingQuoteLine'
  | 'decideQuoteLineProposal'
>;

type QuoteLinePatchScope = 'answer_required_fact' | 'explicit_correction';
type ProposalAction = 'confirm_line' | 'edit_line' | 'cancel_line';

function invalid<T>(): Promise<T> {
  return Promise.resolve({ status: 'invalid_response' } as T);
}

/**
 * Adaptateur tactile du même contrat V2 que la voix.
 *
 * Il ne modifie jamais le brouillon mobile. Il transforme le geste en commande scellée, conserve
 * la même clé d'idempotence lors d'un retry et laisse le serveur relire toutes les fences.
 */
export class QuoteLineMissionCoordinator {
  constructor(
    private readonly createCommandId: () => string,
    private readonly commandIds = new AgentMissionCommandIdRegistry(),
  ) {}

  stage(
    frame: QuoteLineMissionFrame,
    lines: readonly AgentMissionQuoteLineCandidateV1[],
    actions: Pick<QuoteLineActions, 'stageQuoteLines'>,
  ): ReturnType<AgentMissionRuntimeActions['stageQuoteLines']> {
    const common = this.common(frame);
    if (
      common === null
      || frame.mission.phase !== 'awaiting_lines'
      || lines.length === 0
    ) {
      return invalid();
    }
    const commandId = this.commandId([
      'stage',
      common,
      lines,
    ]);
    return actions.stageQuoteLines({
      ...common,
      commandId,
      lines,
    });
  }

  chooseCatalogue(
    frame: QuoteLineMissionFrame,
    choiceId: string,
    actions: Pick<QuoteLineActions, 'decideQuoteCatalogueChoice'>,
  ): ReturnType<AgentMissionRuntimeActions['decideQuoteCatalogueChoice']> {
    const common = this.common(frame);
    const decision = frame.presentation.decision;
    const pending = frame.presentation.pendingLine;
    if (
      common === null
      || decision?.kind !== 'catalogue'
      || pending === null
      || pending.pendingLineId !== decision.pendingLineId
      || pending.expectedWorkRevision !== decision.expectedWorkRevision
      || (
        decision.freeLineChoiceId !== choiceId
        && !decision.choices.some((choice) => choice.choiceId === choiceId)
      )
    ) {
      return invalid();
    }
    const commandId = this.commandId([
      'catalogue',
      common,
      decision.decisionId,
      decision.choiceSetRevision,
      pending,
      choiceId,
    ]);
    return actions.decideQuoteCatalogueChoice({
      ...common,
      commandId,
      decisionId: decision.decisionId,
      choiceSetRevision: decision.choiceSetRevision,
      pendingLineId: pending.pendingLineId,
      expectedWorkRevision: pending.expectedWorkRevision,
      choiceId,
      additionalLines: [],
    });
  }

  patch(
    frame: QuoteLineMissionFrame,
    scope: QuoteLinePatchScope,
    patch: AgentMissionQuoteLinePatchV1,
    actions: Pick<QuoteLineActions, 'patchQuoteLine'>,
  ): ReturnType<AgentMissionRuntimeActions['patchQuoteLine']> {
    const common = this.common(frame);
    const pending = frame.presentation.pendingLine;
    if (
      common === null
      || pending === null
      || (
        scope === 'answer_required_fact'
        && frame.presentation.requiredFact !== patch.field
      )
    ) {
      return invalid();
    }
    const commandId = this.commandId([
      'patch',
      common,
      pending,
      scope,
      patch,
    ]);
    return actions.patchQuoteLine({
      ...common,
      commandId,
      pendingLineId: pending.pendingLineId,
      expectedWorkRevision: pending.expectedWorkRevision,
      scope,
      patch,
    });
  }

  cancelPending(
    frame: QuoteLineMissionFrame,
    actions: Pick<QuoteLineActions, 'cancelPendingQuoteLine'>,
  ): ReturnType<AgentMissionRuntimeActions['cancelPendingQuoteLine']> {
    const common = this.common(frame);
    const pending = frame.presentation.pendingLine;
    if (
      common === null
      || frame.mission.phase !== 'awaiting_line_details'
      || frame.presentation.decision !== null
      || pending === null
    ) {
      return invalid();
    }
    const commandId = this.commandId([
      'cancel_pending',
      common,
      pending,
    ]);
    return actions.cancelPendingQuoteLine({
      ...common,
      commandId,
      pendingLineId: pending.pendingLineId,
      expectedWorkRevision: pending.expectedWorkRevision,
    });
  }

  decideProposal(
    frame: QuoteLineMissionFrame,
    action: ProposalAction,
    actions: Pick<QuoteLineActions, 'decideQuoteLineProposal'>,
  ): ReturnType<AgentMissionRuntimeActions['decideQuoteLineProposal']> {
    const common = this.common(frame);
    const decision = frame.presentation.decision;
    const proposal = frame.presentation.proposal;
    const pending = frame.presentation.pendingLine;
    if (
      common === null
      || decision?.kind !== 'line_confirmation'
      || pending === null
      || pending.pendingLineId !== decision.pendingLineId
      || pending.expectedWorkRevision !== decision.expectedWorkRevision
      || (
        action === 'confirm_line'
        && (
          proposal === null
          || frame.presentation.proposalStatus.kind !== 'available'
          || proposal.proposalId !== decision.proposalId
          || proposal.diffHash !== decision.diffHash
        )
      )
    ) {
      return invalid();
    }
    const choice = decision.choices.find((candidate) => candidate.action === action);
    if (choice === undefined) return invalid();
    const commandId = this.commandId([
      'proposal',
      common,
      decision.decisionId,
      decision.choiceSetRevision,
      decision.choiceSetHash,
      choice.choiceId,
      pending,
      decision.proposalId,
      decision.diffHash,
    ]);
    return actions.decideQuoteLineProposal({
      ...common,
      commandId,
      decisionId: decision.decisionId,
      choiceSetRevision: decision.choiceSetRevision,
      choiceSetHash: decision.choiceSetHash,
      choiceId: choice.choiceId,
      pendingLineId: pending.pendingLineId,
      proposalId: decision.proposalId,
      proposalRevision: decision.proposalRevision,
      expectedWorkRevision: pending.expectedWorkRevision,
      expectedCatalogue: decision.expectedCatalogue,
      diffHash: decision.diffHash,
    });
  }

  private common(frame: QuoteLineMissionFrame): {
    readonly missionId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly expectedScreenInstanceId: string;
  } | null {
    const mission = frame.mission;
    const draft = mission.payload.draft;
    if (
      mission.kind !== 'quote_creation'
      || mission.status !== 'active'
      || !mission.actionable
      || draft === null
      || frame.presentation.schema !== 'bob.agent-mission.quote-presentation'
      || frame.presentation.version !== 1
      || frame.expectedScreenInstanceId.trim() === ''
    ) {
      return null;
    }
    return {
      missionId: mission.id,
      expectedMissionRevision: mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      expectedScreenInstanceId: frame.expectedScreenInstanceId,
    };
  }

  private commandId(input: readonly unknown[]): string {
    const key = JSON.stringify(input);
    return this.commandIds.getOrCreate(key, this.createCommandId);
  }
}
