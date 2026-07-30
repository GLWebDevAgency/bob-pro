import {
  AGENT_MISSION_PROTOCOL_M2A,
  type AgentMission,
  type LineConfirmationDecisionV1,
} from '../../domain/agent/agent-mission';
import {
  isCanonicalAgentMissionUserCommandId,
  type AgentMissionEventSnapshot,
} from '../../domain/agent/agent-mission-event';
import {
  type Result,
  err,
  ok,
} from '../../shared-kernel/result';
import {
  appendResolvedQuoteDraftLine,
} from '../quote-drafts/apply-quote-draft-transition';
import {
  type AgentMissionFingerprintPort,
} from '../ports/agent-mission-fingerprint';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionUnitOfWorkPort,
} from '../ports/agent-mission-unit-of-work';
import {
  computeQuoteVatContextDigest,
} from '../ports/quote-vat-context';
import {
  type IdGeneratorPort,
} from '../ports/services';
import {
  type AppError,
  appConflict,
} from '../result';
import {
  agentMissionDomainError,
  expireAgentMissionInTransaction,
  guardAgentMissionReplayForeground,
  isCanonicalAgentMissionOwner,
  isCanonicalAgentMissionUserCommandOrigin,
  isCanonicalAgentMissionUuid,
  missingAgentMission,
  recordAgentMissionEvent,
  rejectedAgentMissionCapability,
  requireAgentMissionFingerprint,
  resolveAgentMissionEventCorrelation,
  resolveQuoteAgentMissionEventLookup,
  resolveQuoteAgentMissionForUpdate,
  resolveQuoteAgentMissionLookup,
  toAgentMissionView,
  unavailableAgentMissionCompany,
  unavailableAgentMissionForeground,
  verifyAgentMissionFingerprint,
  type AgentMissionUserCommandOrigin,
  type AgentMissionViewV1,
} from './agent-mission-application';
import {
  isCanonicalAgentMissionDraftSessionId,
} from './agent-mission-identifiers';
import {
  deriveQuoteLineProposal,
} from './derive-quote-line-proposal';
import {
  invalidateQuoteLineProposalOnWork,
  rejectQuoteLineProposalOnWork,
  type AgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWorkTransitionResult,
} from './quote-line-work';
import {
  lineConfirmationDecisionMatchesWork,
} from './quote-line-confirmation-fences';

const INT4_MAX = 2_147_483_647;
const SHA256 = /^[0-9a-f]{64}$/u;

type ExpectedCatalogueFence =
  | { readonly itemId: string; readonly revision: number }
  | null;

export interface DecideQuoteAgentMissionLineProposalInput
  extends AgentMissionOwner {
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly choiceSetHash: string;
  readonly choiceId: string;
  readonly pendingLineId: string;
  readonly proposalId: string;
  readonly proposalRevision: 1;
  readonly expectedWorkRevision: number;
  readonly expectedCatalogue: ExpectedCatalogueFence;
  readonly diffHash: string;
}

export interface AgentMissionLineUserCommandReceipt {
  readonly commandId: string;
  readonly eventType:
    | 'line_proposal_rejected'
    | 'line_confirmed'
    | 'line_cancelled'
    | 'decision_invalidated';
  readonly missionRevisionAfter: number;
}

export interface DecideQuoteAgentMissionLineProposalOutput {
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
  readonly commandReceipt: AgentMissionLineUserCommandReceipt;
}

export interface DecideQuoteAgentMissionLineProposalDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class DecideQuoteAgentMissionLineProposalAbort extends Error {
  constructor(readonly appError: AppError) {
    super('decide-quote-agent-mission-line-proposal-abort');
  }
}

function abort(error: AppError): never {
  throw new DecideQuoteAgentMissionLineProposalAbort(error);
}

function validation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function isPositiveInt4(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && (value as number) >= 1
    && (value as number) <= INT4_MAX;
}

function canonicalExpectedCatalogue(
  value: ExpectedCatalogueFence,
): readonly [string, number] | null {
  return value === null ? null : [value.itemId, value.revision];
}

export function canonicalDecideQuoteAgentMissionLineProposalCommand(input: {
  readonly owner: AgentMissionOwner;
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly choiceSetHash: string;
  readonly choiceId: string;
  readonly pendingLineId: string;
  readonly proposalId: string;
  readonly proposalRevision: 1;
  readonly expectedWorkRevision: number;
  readonly expectedCatalogue: ExpectedCatalogueFence;
  readonly diffHash: string;
}): string {
  const correlation = input.origin.correlation;
  return JSON.stringify([
    'bob.agent-mission.command.decide-quote-line-proposal.v1',
    input.owner.companyId,
    input.owner.ownerUserId,
    input.missionId,
    input.commandId,
    input.expectedMissionRevision,
    [
      input.expectedDraftSessionId,
      input.expectedDraftSlotRevision,
      input.expectedDraftContentRevision,
    ],
    [
      input.origin.actor,
      correlation?.realtimeSessionId ?? null,
      input.origin.actor === 'user_voice' ? input.origin.correlation.turnId : null,
      correlation?.contextRevision ?? null,
      correlation?.contextDigest ?? null,
    ],
    [
      input.decisionId,
      input.choiceSetRevision,
      input.choiceSetHash,
      input.choiceId,
    ],
    [
      input.pendingLineId,
      input.proposalId,
      input.proposalRevision,
      input.expectedWorkRevision,
      canonicalExpectedCatalogue(input.expectedCatalogue),
      input.diffHash,
    ],
  ]);
}

function validExpectedCatalogue(value: unknown): value is ExpectedCatalogueFence {
  if (value === null) return true;
  return typeof value === 'object'
    && !Array.isArray(value)
    && value !== null
    && Object.keys(value).length === 2
    && Object.hasOwn(value, 'itemId')
    && Object.hasOwn(value, 'revision')
    && typeof (value as { readonly itemId?: unknown }).itemId === 'string'
    && ((value as { readonly itemId: string }).itemId.length >= 1)
    && ((value as { readonly itemId: string }).itemId.length <= 200)
    && isPositiveInt4((value as { readonly revision?: unknown }).revision);
}

function sameExpectedCatalogue(
  left: ExpectedCatalogueFence,
  right: ExpectedCatalogueFence,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.itemId === right.itemId
      && left.revision === right.revision;
}

function slotMatches(
  slot: AgentMissionQuoteDraftSlot,
  mission: AgentMission,
  input: Pick<
    DecideQuoteAgentMissionLineProposalInput,
    | 'expectedDraftSessionId'
    | 'expectedDraftSlotRevision'
    | 'expectedDraftContentRevision'
  >,
): boolean {
  const draft = mission.payload.draft;
  return draft !== null
    && slot.agentMissionId === mission.id
    && slot.payload.draft.sessionId === input.expectedDraftSessionId
    && slot.revision === input.expectedDraftSlotRevision
    && slot.payload.draft.contentRevision === input.expectedDraftContentRevision
    && draft.sessionId === slot.payload.draft.sessionId
    && draft.slotRevision === slot.revision
    && draft.contentRevision === slot.payload.draft.contentRevision
    && slot.payload.draft.step === 'lignes'
    && slot.payload.draft.customer !== null;
}

function lockedHead(
  workItems: readonly AgentMissionQuoteLineWork[],
  owner: AgentMissionOwner,
  missionId: string,
): AgentMissionQuoteLineWork {
  if (
    workItems.length < 1
    || workItems.length > 20
    || workItems.some((item) => (
      item.companyId !== owner.companyId
      || item.ownerUserId !== owner.ownerUserId
      || item.missionId !== missionId
    ))
    || new Set(workItems.map((item) => item.id)).size !== workItems.length
    || new Set(workItems.map((item) => item.ordinal)).size !== workItems.length
  ) {
    abort({
      kind: 'dependency',
      port: 'agent_mission_quote_line_work',
      cause: 'invalid_locked_queue',
    });
  }
  const sorted = [...workItems].sort((left, right) => left.ordinal - right.ordinal);
  return sorted[0] as AgentMissionQuoteLineWork;
}

function workTransitionValue(
  result: AgentMissionQuoteLineWorkTransitionResult,
): AgentMissionQuoteLineWork {
  if (result.ok) return result.value;
  if (result.error.code === 'agent_mission_quote_line_work_revision_conflict') {
    abort(appConflict('agent_mission_quote_line_work', 'stale_revision'));
  }
  abort({
    kind: 'dependency',
    port: 'agent_mission_quote_line_work',
    cause: result.error.code,
  });
}

function receiptFromSnapshot(
  snapshot: AgentMissionEventSnapshot,
): AgentMissionLineUserCommandReceipt {
  if (
    snapshot.eventType !== 'line_proposal_rejected'
    && snapshot.eventType !== 'line_confirmed'
    && snapshot.eventType !== 'line_cancelled'
    && snapshot.eventType !== 'decision_invalidated'
  ) {
    abort({
      kind: 'dependency',
      port: 'agent_mission_event',
      cause: 'invalid_line_decision_receipt',
    });
  }
  return {
    commandId: snapshot.commandId,
    eventType: snapshot.eventType,
    missionRevisionAfter: snapshot.missionRevisionAfter,
  };
}

function replayOutput(
  snapshot: AgentMissionEventSnapshot,
  mission: AgentMissionViewV1,
): DecideQuoteAgentMissionLineProposalOutput {
  let invalidationReason:
    | 'candidate_unavailable'
    | 'choice_set_stale'
    | null = null;
  if (
    snapshot.eventType === 'decision_invalidated'
    && snapshot.data.kind === 'decision_invalidated'
  ) {
    if (
      snapshot.data.reason !== 'candidate_unavailable'
      && snapshot.data.reason !== 'choice_set_stale'
    ) {
      abort({
        kind: 'dependency',
        port: 'agent_mission_event',
        cause: 'invalid_line_decision_invalidation_reason',
      });
    }
    invalidationReason = snapshot.data.reason;
  }
  if (
    snapshot.eventType !== 'line_proposal_rejected'
    && snapshot.eventType !== 'line_confirmed'
    && snapshot.eventType !== 'line_cancelled'
    && snapshot.eventType !== 'decision_invalidated'
  ) {
    abort({
      kind: 'dependency',
      port: 'agent_mission_event',
      cause: 'invalid_line_decision_receipt',
    });
  }
  return {
    outcome: 'replayed',
    invalidationReason,
    mission,
    commandReceipt: receiptFromSnapshot(snapshot),
  };
}

function assertDecisionFences(
  decision: LineConfirmationDecisionV1,
  input: DecideQuoteAgentMissionLineProposalInput,
  head: AgentMissionQuoteLineWork,
): void {
  if (
    decision.decisionId !== input.decisionId
    || decision.choiceSetRevision !== input.choiceSetRevision
    || decision.choiceSetHash !== input.choiceSetHash
    || decision.pendingLineId !== input.pendingLineId
    || decision.proposalId !== input.proposalId
    || decision.proposalRevision !== input.proposalRevision
    || decision.expectedWorkRevision !== input.expectedWorkRevision
    || decision.diffHash !== input.diffHash
    || !sameExpectedCatalogue(decision.expectedCatalogue, input.expectedCatalogue)
  ) {
    abort(appConflict('agent_mission_line_proposal', 'choice_set_stale'));
  }
  if (!lineConfirmationDecisionMatchesWork(decision, head)) {
    abort({
      kind: 'dependency',
      port: 'agent_mission_quote_line_work',
      cause: 'line_decision_work_mismatch',
    });
  }
  if (!decision.choices.some((choice) => choice.choiceId === input.choiceId)) {
    abort(appConflict('agent_mission_line_proposal', 'choice_not_presented'));
  }
}

export class DecideQuoteAgentMissionLineProposal {
  constructor(
    private readonly deps: DecideQuoteAgentMissionLineProposalDeps,
  ) {}

  async execute(
    input: DecideQuoteAgentMissionLineProposalInput,
  ): Promise<Result<DecideQuoteAgentMissionLineProposalOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return err(validation('identity', 'Identité mission invalide.'));
    }
    if (
      !isCanonicalAgentMissionUuid(input.missionId)
      || !isCanonicalAgentMissionUserCommandId(input.commandId)
      || !isCanonicalAgentMissionUuid(input.decisionId)
      || !isCanonicalAgentMissionUuid(input.choiceId)
      || !isCanonicalAgentMissionUuid(input.pendingLineId)
      || !isCanonicalAgentMissionUuid(input.proposalId)
    ) {
      return err(validation('command', 'Identifiants canoniques requis.'));
    }
    if (
      !isPositiveInt4(input.expectedMissionRevision)
      || !isPositiveInt4(input.expectedDraftSlotRevision)
      || !Number.isSafeInteger(input.expectedDraftContentRevision)
      || input.expectedDraftContentRevision < 0
      || input.expectedDraftContentRevision > INT4_MAX
      || !isPositiveInt4(input.choiceSetRevision)
      || !isPositiveInt4(input.expectedWorkRevision)
      || input.proposalRevision !== 1
      || !isCanonicalAgentMissionDraftSessionId(input.expectedDraftSessionId)
      || !SHA256.test(input.choiceSetHash)
      || !SHA256.test(input.diffHash)
      || !validExpectedCatalogue(input.expectedCatalogue)
    ) {
      return err(validation('fences', 'Fences de proposition invalides.'));
    }
    if (!isCanonicalAgentMissionUserCommandOrigin(input.origin)) {
      return err(validation('origin', 'Provenance de commande invalide.'));
    }
    if (input.authority.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const canonical = canonicalDecideQuoteAgentMissionLineProposalCommand({
      owner,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      origin: input.origin,
      decisionId: input.decisionId,
      choiceSetRevision: input.choiceSetRevision,
      choiceSetHash: input.choiceSetHash,
      choiceId: input.choiceId,
      pendingLineId: input.pendingLineId,
      proposalId: input.proposalId,
      proposalRevision: input.proposalRevision,
      expectedWorkRevision: input.expectedWorkRevision,
      expectedCatalogue: input.expectedCatalogue,
      diffHash: input.diffHash,
    });

    try {
      const execution = await this.deps.unitOfWork.runQuoteCreationOwner(
        owner,
        input.authority,
        async (transaction) => {
          const now = await transaction.databaseNow();
          const consumedLookup = await transaction.events.findByCommandId({
            ...owner,
            commandId: input.commandId,
          });
          const consumedResult = resolveQuoteAgentMissionEventLookup(consumedLookup);
          if (!consumedResult.ok) abort(consumedResult.error);
          const consumed = consumedResult.value;
          if (consumed !== null) {
            const snapshot = consumed.toSnapshot();
            if (
              snapshot.missionId !== input.missionId
              || snapshot.actor !== input.origin.actor
              || (
                snapshot.eventType !== 'line_proposal_rejected'
                && snapshot.eventType !== 'line_confirmed'
                && snapshot.eventType !== 'line_cancelled'
                && snapshot.eventType !== 'decision_invalidated'
              )
            ) {
              abort(appConflict('agent_mission_command', 'already_used'));
            }
            const verified = verifyAgentMissionFingerprint(
              this.deps.fingerprints,
              canonical,
              snapshot,
            );
            if (!verified.ok) abort(verified.error);
            if (!verified.value) {
              abort(appConflict('agent_mission_command', 'fingerprint_mismatch'));
            }
            const missionLookup = await transaction.missions.findById({
              ...owner,
              missionId: input.missionId,
            });
            const missionResult = resolveQuoteAgentMissionLookup(missionLookup);
            if (!missionResult.ok) abort(missionResult.error);
            const replayedMission = missionResult.value;
            if (replayedMission === null) {
              abort({
                kind: 'dependency',
                port: 'agent_mission_repository',
                cause: 'line_decision_event_without_mission',
              });
            }
            const foreground = await guardAgentMissionReplayForeground({
              transaction,
              owner,
              replayedMissionId: replayedMission.id,
            });
            if (!foreground.ok) abort(foreground.error);
            if (snapshot.eventType === 'line_confirmed') {
              const replayedSlot = await transaction.quoteDrafts.getForUpdate(owner);
              if (
                replayedSlot === null
                || replayedSlot.agentMissionId !== replayedMission.id
                || replayedMission.payload.draft === null
                || replayedSlot.revision !== replayedMission.payload.draft.slotRevision
                || replayedSlot.payload.draft.contentRevision
                  !== replayedMission.payload.draft.contentRevision
              ) {
                abort({
                  kind: 'dependency',
                  port: 'agent_mission_quote_draft',
                  cause: 'confirmed_receipt_without_draft',
                });
              }
            }
            const view = toAgentMissionView(replayedMission, now);
            if (!view.ok) abort(view.error);
            return {
              kind: 'success',
              output: replayOutput(snapshot, view.value),
            } as const;
          }

          const missionResult = await resolveQuoteAgentMissionForUpdate({
            transaction,
            owner,
            missionId: input.missionId,
          });
          if (!missionResult.ok) abort(missionResult.error);
          const mission = missionResult.value;
          if (mission === null) abort(missingAgentMission(input.missionId));
          if (mission.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A) {
            abort(appConflict('agent_mission_protocol', 'upgrade_required'));
          }
          if (mission.status !== 'active') {
            abort(appConflict('agent_mission', `terminal_${mission.status}`));
          }
          if (mission.phase !== 'awaiting_line_confirmation') {
            abort(appConflict('agent_mission', 'invalid_phase'));
          }
          const expired = mission.isExpiredAt(now);
          if (!expired.ok) abort(agentMissionDomainError(expired.error));
          if (expired.value) {
            const terminalized = await expireAgentMissionInTransaction({
              transaction,
              owner,
              mission,
              occurredAt: now,
              fingerprints: this.deps.fingerprints,
              ids: this.deps.ids,
            });
            if (!terminalized.ok) abort(terminalized.error);
            return { kind: 'gone', reason: 'expired' } as const;
          }
          if (mission.revision !== input.expectedMissionRevision) {
            abort(appConflict('agent_mission', 'stale_revision'));
          }
          const correlation = resolveAgentMissionEventCorrelation(
            transaction,
            mission,
            input.origin,
          );
          if (!correlation.ok) abort(correlation.error);
          const slot = await transaction.quoteDrafts.getForUpdate(owner);
          if (slot === null || !slotMatches(slot, mission, input)) {
            abort(appConflict('agent_mission_quote_draft', 'draft_stale'));
          }
          const workItems = await transaction.quoteLineWork.listForUpdate({
            ...owner,
            missionId: mission.id,
          });
          const head = lockedHead(workItems, owner, mission.id);
          const decision = mission.payload.decision;
          if (decision?.kind !== 'line_confirmation') {
            abort(appConflict('agent_mission_line_proposal', 'choice_set_stale'));
          }
          assertDecisionFences(decision, input, head);
          const choice = decision.choices.find(
            (candidate) => candidate.choiceId === input.choiceId,
          );
          if (choice === undefined) {
            abort(appConflict('agent_mission_line_proposal', 'choice_not_presented'));
          }
          const draftBefore = {
            sessionId: slot.payload.draft.sessionId,
            slotRevision: slot.revision,
            contentRevision: slot.payload.draft.contentRevision,
          };

          let transition;
          let draftAfter = draftBefore;
          let outcome:
            | 'confirmed'
            | 'edit_requested'
            | 'cancelled'
            | 'invalidated';
          let invalidationReason:
            | 'candidate_unavailable'
            | 'choice_set_stale'
            | null = null;

          if (choice.action === 'edit_line') {
            const nextWork = workTransitionValue(rejectQuoteLineProposalOnWork({
              workItem: head,
              expectedRevision: head.revision,
              proposalId: decision.proposalId,
              occurredAt: now,
            }));
            const rejected = mission.rejectLineProposal({
              expectedRevision: mission.revision,
              decisionId: input.decisionId,
              choiceSetRevision: input.choiceSetRevision,
              choiceId: input.choiceId,
              pendingLineId: input.pendingLineId,
              proposalId: input.proposalId,
              proposalRevision: input.proposalRevision,
              expectedWorkRevision: input.expectedWorkRevision,
              observedDraft: draftBefore,
              observedCatalogue: decision.expectedCatalogue,
              diffHash: input.diffHash,
              workRevisionAfter: nextWork.revision,
              occurredAt: now,
            });
            if (!rejected.ok) abort(agentMissionDomainError(rejected.error));
            transition = rejected.value;
            const updatedWork = await transaction.quoteLineWork.updateCas({
              workItem: nextWork,
              expectedRevision: head.revision,
            });
            if (updatedWork !== 'updated') {
              abort(appConflict('agent_mission_quote_line_work', 'stale_revision'));
            }
            outcome = 'edit_requested';
          } else if (choice.action === 'cancel_line') {
            const cancelled = mission.cancelLine({
              expectedRevision: mission.revision,
              decisionId: input.decisionId,
              choiceSetRevision: input.choiceSetRevision,
              choiceId: input.choiceId,
              pendingLineId: input.pendingLineId,
              proposalId: input.proposalId,
              proposalRevision: input.proposalRevision,
              expectedWorkRevision: input.expectedWorkRevision,
              observedDraft: draftBefore,
              observedCatalogue: decision.expectedCatalogue,
              diffHash: input.diffHash,
              occurredAt: now,
            });
            if (!cancelled.ok) abort(agentMissionDomainError(cancelled.error));
            transition = cancelled.value;
            const deleted = await transaction.quoteLineWork.delete({
              ...owner,
              missionId: mission.id,
              workItemId: head.id,
              expectedRevision: head.revision,
            });
            if (deleted !== 'deleted') {
              abort(appConflict('agent_mission_quote_line_work', deleted));
            }
            outcome = 'cancelled';
          } else {
            let selectedCatalogue = null;
            let catalogueStale = false;
            if (decision.expectedCatalogue !== null) {
              const catalogue = await transaction.catalogueCandidates.getById({
                companyId: owner.companyId,
                id: decision.expectedCatalogue.itemId,
              });
              if (
                catalogue === null
                || catalogue.revision !== decision.expectedCatalogue.revision
              ) {
                catalogueStale = true;
              } else {
                selectedCatalogue = catalogue;
              }
            }

            if (catalogueStale) {
              const nextWork = workTransitionValue(invalidateQuoteLineProposalOnWork({
                workItem: head,
                expectedRevision: head.revision,
                reason: 'catalogue_stale',
                occurredAt: now,
              }));
              const invalidated = mission.invalidateLineProposal({
                expectedRevision: mission.revision,
                reason: 'candidate_unavailable',
                nextPhase: 'awaiting_line_details',
                occurredAt: now,
              });
              if (!invalidated.ok) abort(agentMissionDomainError(invalidated.error));
              transition = invalidated.value;
              const updatedWork = await transaction.quoteLineWork.updateCas({
                workItem: nextWork,
                expectedRevision: head.revision,
              });
              if (updatedWork !== 'updated') {
                abort(appConflict('agent_mission_quote_line_work', 'stale_revision'));
              }
              outcome = 'invalidated';
              invalidationReason = 'candidate_unavailable';
            } else {
              const customerId = slot.payload.draft.customer?.id;
              if (customerId === undefined) {
                abort({
                  kind: 'dependency',
                  port: 'agent_mission_quote_draft',
                  cause: 'customer_missing',
                });
              }
              const vatContext = await transaction.quoteVatContext.getForUpdate({
                companyId: owner.companyId,
                customerId,
              });
              if (vatContext === null || vatContext.customerId !== customerId) {
                abort({
                  kind: 'dependency',
                  port: 'quote_vat_context',
                  cause: 'context_unavailable',
                });
              }
              const derivation = deriveQuoteLineProposal({
                workItem: head,
                payload: slot.payload,
                selectedCatalogue,
                vatContext,
              });
              const vatContextChanged = computeQuoteVatContextDigest(vatContext)
                !== decision.expectedVatContextDigest;
              const proposalStillExact = derivation.kind === 'resolved'
                && derivation.proposal.diffHash === decision.diffHash
                && derivation.proposal.diffHash === head.proposalDiffHash
                && derivation.proposal.diffHash === input.diffHash;
              if (vatContextChanged) {
                const nextWork = workTransitionValue(invalidateQuoteLineProposalOnWork({
                  workItem: head,
                  expectedRevision: head.revision,
                  reason: 'proposal_stale',
                  occurredAt: now,
                }));
                const invalidated = mission.invalidateLineProposal({
                  expectedRevision: mission.revision,
                  reason: 'choice_set_stale',
                  nextPhase: 'awaiting_lines',
                  occurredAt: now,
                });
                if (!invalidated.ok) abort(agentMissionDomainError(invalidated.error));
                transition = invalidated.value;
                const updatedWork = await transaction.quoteLineWork.updateCas({
                  workItem: nextWork,
                  expectedRevision: head.revision,
                });
                if (updatedWork !== 'updated') {
                  abort(appConflict('agent_mission_quote_line_work', 'stale_revision'));
                }
                outcome = 'invalidated';
                invalidationReason = 'choice_set_stale';
              } else if (!proposalStillExact) {
                abort({
                  kind: 'dependency',
                  port: 'agent_mission_quote_line_proposal',
                  cause: 'proposal_redrive_mismatch',
                });
              } else {
                const proposal = derivation.proposal;
                const appended = appendResolvedQuoteDraftLine({
                  payload: slot.payload,
                  expectedContentRevision: slot.payload.draft.contentRevision,
                  resolvedLine: proposal.line,
                  metadata: proposal.metadata,
                  vatDecision: proposal.vatDecision,
                });
                if (!appended.ok) {
                  abort({
                    kind: 'dependency',
                    port: 'agent_mission_quote_draft',
                    cause: `append_line_${appended.error.code}`,
                  });
                }
                const appendedSlot = await transaction.quoteDrafts.appendLineCas({
                  ...owner,
                  missionId: mission.id,
                  expectedSlotRevision: slot.revision,
                  expectedDraftSessionId: slot.payload.draft.sessionId,
                  expectedDraftContentRevision: slot.payload.draft.contentRevision,
                  payload: appended.value,
                });
                if (appendedSlot === null) {
                  abort(appConflict('agent_mission_quote_draft', 'draft_stale'));
                }
                draftAfter = {
                  sessionId: appendedSlot.payload.draft.sessionId,
                  slotRevision: appendedSlot.revision,
                  contentRevision: appendedSlot.payload.draft.contentRevision,
                };
                const confirmed = mission.confirmLine({
                  expectedRevision: mission.revision,
                  decisionId: input.decisionId,
                  choiceSetRevision: input.choiceSetRevision,
                  choiceId: input.choiceId,
                  pendingLineId: input.pendingLineId,
                  proposalId: input.proposalId,
                  proposalRevision: input.proposalRevision,
                  expectedWorkRevision: input.expectedWorkRevision,
                  observedDraft: draftBefore,
                  observedCatalogue: decision.expectedCatalogue,
                  diffHash: input.diffHash,
                  updatedDraft: draftAfter,
                  occurredAt: now,
                });
                if (!confirmed.ok) abort(agentMissionDomainError(confirmed.error));
                transition = confirmed.value;
                const deleted = await transaction.quoteLineWork.delete({
                  ...owner,
                  missionId: mission.id,
                  workItemId: head.id,
                  expectedRevision: head.revision,
                });
                if (deleted !== 'deleted') {
                  abort(appConflict('agent_mission_quote_line_work', deleted));
                }
                outcome = 'confirmed';
              }
            }
          }

          const updatedMission = await transaction.missions.updateCas({
            mission: transition.mission,
            expectedRevision: mission.revision,
          });
          if (updatedMission !== 'updated') {
            abort(appConflict('agent_mission', 'stale_revision'));
          }
          const fingerprint = requireAgentMissionFingerprint(
            this.deps.fingerprints,
            canonical,
          );
          if (!fingerprint.ok) abort(fingerprint.error);
          const event = recordAgentMissionEvent({
            owner,
            transition,
            actor: input.origin.actor,
            commandId: input.commandId,
            fingerprint: fingerprint.value,
            ids: this.deps.ids,
            draftBefore,
            draftAfter,
            ...(correlation.value === undefined ? {} : { correlation: correlation.value }),
          });
          if (!event.ok) abort(event.error);
          await transaction.events.append(event.value);
          const eventSnapshot = event.value.toSnapshot();
          const view = toAgentMissionView(transition.mission, now);
          if (!view.ok) abort(view.error);
          return {
            kind: 'success',
            output: {
              outcome,
              invalidationReason,
              mission: view.value,
              commandReceipt: receiptFromSnapshot(eventSnapshot),
            } satisfies DecideQuoteAgentMissionLineProposalOutput,
          } as const;
        },
      );
      if (execution.status === 'company_unavailable') {
        return err(unavailableAgentMissionCompany(execution.reason));
      }
      if (execution.status === 'foreground_unavailable') {
        return err(unavailableAgentMissionForeground(execution.reason));
      }
      if (execution.status === 'capability_rejected') {
        return err(rejectedAgentMissionCapability(execution.reason));
      }
      return execution.value.kind === 'gone'
        ? err(appConflict('agent_mission', execution.value.reason))
        : ok(execution.value.output);
    } catch (cause) {
      if (cause instanceof DecideQuoteAgentMissionLineProposalAbort) {
        return err(cause.appError);
      }
      throw cause;
    }
  }
}
