import {
  AGENT_MISSION_PROTOCOL_M2A,
  type AgentMission,
} from '../../domain/agent/agent-mission';
import {
  type AgentMissionEventSnapshot,
} from '../../domain/agent/agent-mission-event';
import {
  type Result,
  err,
  ok,
} from '../../shared-kernel/result';
import {
  CATALOGUE_CANDIDATE_SEARCH_LIMIT,
} from '../ports/catalogue-candidate-search';
import {
  type AgentMissionFingerprintPort,
} from '../ports/agent-mission-fingerprint';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionEventCorrelation,
  agentMissionDomainError,
  deriveAgentMissionSystemCommandId,
  expireAgentMissionInTransaction,
  guardAgentMissionReplayForeground,
  isCanonicalAgentMissionOwner,
  isCanonicalAgentMissionUuid,
  missingAgentMission,
  recordAgentMissionEvent,
  rejectedAgentMissionCapability,
  requireAgentMissionFingerprint,
  resolveQuoteAgentMissionEventLookup,
  resolveQuoteAgentMissionForUpdate,
  resolveQuoteAgentMissionLookup,
  toAgentMissionView,
  unavailableAgentMissionCompany,
  unavailableAgentMissionForeground,
  verifyAgentMissionFingerprint,
  type AgentMissionViewV1,
} from './agent-mission-application';
import {
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionUnitOfWorkPort,
} from '../ports/agent-mission-unit-of-work';
import {
  type IdGeneratorPort,
} from '../ports/services';
import {
  type AppError,
  appConflict,
} from '../result';
import {
  presentCatalogueChoicesOnQuoteLineWork,
  recordCatalogueNotFoundOnQuoteLineWork,
  type AgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWorkTransitionResult,
} from './quote-line-work';

export interface ContinueQuoteAgentMissionLineQueueInput extends AgentMissionOwner {
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly missionId: string;
  readonly parentCommandId: string;
}

export interface AgentMissionCatalogueContinuationReceipt {
  readonly commandId: string;
  readonly eventType: 'catalogue_not_found' | 'catalogue_choices_presented';
  readonly missionRevisionAfter: number;
}

export interface ContinueQuoteAgentMissionLineQueueOutput {
  readonly outcome:
    | 'catalogue_not_found'
    | 'choices_presented'
    | 'empty'
    | 'deferred_to_m2a2'
    | 'superseded'
    | 'replayed';
  readonly mission: AgentMissionViewV1;
  readonly pendingLineId: string | null;
  readonly presentedChoiceCount: number;
  readonly continuationReceipt: AgentMissionCatalogueContinuationReceipt | null;
}

export interface ContinueQuoteAgentMissionLineQueueDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class ContinueQuoteAgentMissionLineQueueAbort extends Error {
  constructor(readonly appError: AppError) {
    super('continue-quote-agent-mission-line-queue-abort');
  }
}

function abort(error: AppError): never {
  throw new ContinueQuoteAgentMissionLineQueueAbort(error);
}

function validation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function invalidPersistedState(port: string, cause: string): never {
  abort({ kind: 'dependency', port, cause });
}

function workTransitionValue(
  result: AgentMissionQuoteLineWorkTransitionResult,
): AgentMissionQuoteLineWork {
  if (result.ok) return result.value;
  if (result.error.code === 'agent_mission_quote_line_work_revision_conflict') {
    abort(appConflict('agent_mission_quote_line_work', 'stale_revision'));
  }
  return invalidPersistedState(
    'agent_mission_quote_line_work',
    result.error.code,
  );
}

function parentCorrelation(
  snapshot: AgentMissionEventSnapshot,
): AgentMissionEventCorrelation | undefined {
  if (
    snapshot.realtimeSessionId === null
    && snapshot.turnId === null
    && snapshot.contextRevision === null
    && snapshot.contextDigest === null
  ) return undefined;
  if (
    snapshot.realtimeSessionId !== null
    && snapshot.contextRevision !== null
    && snapshot.contextDigest !== null
  ) {
    return {
      realtimeSessionId: snapshot.realtimeSessionId,
      turnId: null,
      contextRevision: snapshot.contextRevision,
      contextDigest: snapshot.contextDigest,
    };
  }
  return invalidPersistedState(
    'agent_mission_event',
    'invalid_parent_correlation',
  );
}

function canonicalContinuation(input: {
  readonly owner: AgentMissionOwner;
  readonly missionId: string;
  readonly commandId: string;
  readonly parent: AgentMissionEventSnapshot;
}): string {
  return JSON.stringify([
    'bob.agent-mission.system-command.continue-quote-line.v1',
    input.owner.companyId,
    input.owner.ownerUserId,
    input.missionId,
    input.commandId,
    input.parent.eventType,
    input.parent.commandId,
    input.parent.missionRevisionAfter,
  ]);
}

function slotMatchesMission(
  slot: AgentMissionQuoteDraftSlot,
  mission: AgentMission,
): boolean {
  const draft = mission.payload.draft;
  return draft !== null
    && slot.agentMissionId === mission.id
    && slot.payload.draft.sessionId === draft.sessionId
    && slot.revision === draft.slotRevision
    && slot.payload.draft.contentRevision === draft.contentRevision
    && slot.payload.draft.step === 'lignes'
    && slot.payload.draft.customer !== null;
}

function lockedHead(
  workItems: readonly AgentMissionQuoteLineWork[],
  owner: AgentMissionOwner,
  missionId: string,
): AgentMissionQuoteLineWork | null {
  if (
    workItems.length > 20
    || workItems.some((item) => (
      item.companyId !== owner.companyId
      || item.ownerUserId !== owner.ownerUserId
      || item.missionId !== missionId
    ))
    || new Set(workItems.map((item) => item.id)).size !== workItems.length
    || new Set(workItems.map((item) => item.ordinal)).size !== workItems.length
  ) {
    return invalidPersistedState(
      'agent_mission_quote_line_work',
      'invalid_locked_queue',
    );
  }
  if (workItems.length === 0) return null;
  for (let index = 1; index < workItems.length; index += 1) {
    if ((workItems[index - 1]?.ordinal ?? 0) >= (workItems[index]?.ordinal ?? 0)) {
      return invalidPersistedState(
        'agent_mission_quote_line_work',
        'unordered_locked_queue',
      );
    }
  }
  return workItems[0] as AgentMissionQuoteLineWork;
}

function receiptFromSnapshot(
  snapshot: AgentMissionEventSnapshot,
): AgentMissionCatalogueContinuationReceipt {
  if (
    snapshot.eventType !== 'catalogue_not_found'
    && snapshot.eventType !== 'catalogue_choices_presented'
  ) {
    return invalidPersistedState(
      'agent_mission_event',
      'invalid_catalogue_continuation_receipt',
    );
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
): ContinueQuoteAgentMissionLineQueueOutput {
  if (
    snapshot.eventType === 'catalogue_not_found'
    && snapshot.data.kind === 'catalogue_not_found'
  ) {
    return {
      outcome: 'replayed',
      mission,
      pendingLineId: snapshot.data.pendingLineId,
      presentedChoiceCount: 0,
      continuationReceipt: receiptFromSnapshot(snapshot),
    };
  }
  if (
    snapshot.eventType === 'catalogue_choices_presented'
    && snapshot.data.kind === 'catalogue_choices_presented'
  ) {
    return {
      outcome: 'replayed',
      mission,
      pendingLineId: snapshot.data.pendingLineId,
      presentedChoiceCount: snapshot.data.candidateCount + 1,
      continuationReceipt: receiptFromSnapshot(snapshot),
    };
  }
  return invalidPersistedState(
    'agent_mission_event',
    'invalid_catalogue_continuation_receipt',
  );
}

export class ContinueQuoteAgentMissionLineQueue {
  constructor(private readonly deps: ContinueQuoteAgentMissionLineQueueDeps) {}

  async execute(
    input: ContinueQuoteAgentMissionLineQueueInput,
  ): Promise<Result<ContinueQuoteAgentMissionLineQueueOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return err(validation('identity', 'Identité mission invalide.'));
    }
    if (
      !isCanonicalAgentMissionUuid(input.missionId)
      || !isCanonicalAgentMissionUuid(input.parentCommandId)
    ) {
      return err(validation('command', 'Identifiants canoniques requis.'));
    }
    if (input.authority.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };

    try {
      const execution = await this.deps.unitOfWork.runQuoteCreationOwner(
        owner,
        input.authority,
        async (transaction) => {
          const now = await transaction.databaseNow();
          const parentLookup = await transaction.events.findByCommandId({
            ...owner,
            commandId: input.parentCommandId,
          });
          const parentResult = resolveQuoteAgentMissionEventLookup(parentLookup);
          if (!parentResult.ok) abort(parentResult.error);
          const parent = parentResult.value;
          if (parent === null) {
            abort(appConflict('agent_mission_line_continuation', 'parent_missing'));
          }
          const parentSnapshot = parent.toSnapshot();
          if (
            parentSnapshot.missionId !== input.missionId
          ) {
            abort(appConflict('agent_mission_line_continuation', 'parent_invalid'));
          }
          const commandId = deriveAgentMissionSystemCommandId({
            operation: 'continue_quote_line_catalogue',
            ...owner,
            missionId: input.missionId,
            parentEventType: parentSnapshot.eventType,
            parentCommandId: parentSnapshot.commandId,
            parentMissionRevision: parentSnapshot.missionRevisionAfter,
          });
          const canonical = canonicalContinuation({
            owner,
            missionId: input.missionId,
            commandId,
            parent: parentSnapshot,
          });

          const consumedLookup = await transaction.events.findByCommandId({
            ...owner,
            commandId,
          });
          const consumedResult = resolveQuoteAgentMissionEventLookup(consumedLookup);
          if (!consumedResult.ok) abort(consumedResult.error);
          const consumed = consumedResult.value;
          if (consumed !== null) {
            const snapshot = consumed.toSnapshot();
            if (snapshot.missionId !== input.missionId || snapshot.actor !== 'system') {
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
              return invalidPersistedState(
                'agent_mission_repository',
                'catalogue_event_without_mission',
              );
            }
            const foreground = await guardAgentMissionReplayForeground({
              transaction,
              owner,
              replayedMissionId: replayedMission.id,
            });
            if (!foreground.ok) abort(foreground.error);
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
          if (mission.revision !== parentSnapshot.missionRevisionAfter) {
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              kind: 'success',
              output: {
                outcome: 'superseded',
                mission: view.value,
                pendingLineId: null,
                presentedChoiceCount: 0,
                continuationReceipt: null,
              } satisfies ContinueQuoteAgentMissionLineQueueOutput,
            } as const;
          }
          if (mission.status !== 'active') {
            abort(appConflict('agent_mission', `terminal_${mission.status}`));
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
          if (mission.phase !== 'awaiting_lines') {
            abort(appConflict('agent_mission', 'invalid_phase'));
          }
          const correlation = parentCorrelation(parentSnapshot);
          if (correlation !== undefined) {
            const binding = mission.currentBinding;
            const appliedContext = transaction.realtime.appliedContext;
            if (
              binding === null
              || binding.realtimeSessionId !== correlation.realtimeSessionId
              || binding.contextRevision !== correlation.contextRevision
              || binding.contextDigest !== correlation.contextDigest
              || transaction.realtime.realtimeSessionId !== correlation.realtimeSessionId
              || appliedContext === null
              || appliedContext.revision !== correlation.contextRevision
              || appliedContext.digest !== correlation.contextDigest
            ) {
              abort(appConflict(
                'agent_mission_line_continuation',
                'context_stale',
              ));
            }
          }
          const slot = await transaction.quoteDrafts.getForUpdate(owner);
          if (slot === null || !slotMatchesMission(slot, mission)) {
            abort(appConflict('agent_mission_quote_draft', 'draft_stale'));
          }
          const workItems = await transaction.quoteLineWork.listForUpdate({
            ...owner,
            missionId: mission.id,
          });
          const head = lockedHead(workItems, owner, mission.id);
          if (head === null) {
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              kind: 'success',
              output: {
                outcome: 'empty',
                mission: view.value,
                pendingLineId: null,
                presentedChoiceCount: 0,
                continuationReceipt: null,
              } satisfies ContinueQuoteAgentMissionLineQueueOutput,
            } as const;
          }
          if (
            head.state !== 'queued'
            || head.catalogueResolution !== 'pending'
            || head.serviceReference === null
          ) {
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              kind: 'success',
              output: {
                outcome: 'deferred_to_m2a2',
                mission: view.value,
                pendingLineId: head.id,
                presentedChoiceCount: 0,
                continuationReceipt: null,
              } satisfies ContinueQuoteAgentMissionLineQueueOutput,
            } as const;
          }

          const searched = await transaction.catalogueCandidates.search({
            companyId: owner.companyId,
            query: head.serviceReference,
            limit: CATALOGUE_CANDIDATE_SEARCH_LIMIT,
          });
          if (
            !Array.isArray(searched.candidates)
            || typeof searched.truncated !== 'boolean'
            || searched.candidates.length > 5
            || (searched.truncated && searched.candidates.length !== 5)
            || new Set(searched.candidates.map((candidate) => candidate.id)).size
              !== searched.candidates.length
            || searched.candidates.some((candidate) => (
              !Number.isSafeInteger(candidate.revision)
              || candidate.revision < 1
              || candidate.revision > 2_147_483_647
            ))
          ) {
            return invalidPersistedState(
              'catalogue_candidate_search',
              'invalid_search_result',
            );
          }
          if (searched.truncated) {
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              kind: 'success',
              output: {
                outcome: 'deferred_to_m2a2',
                mission: view.value,
                pendingLineId: head.id,
                presentedChoiceCount: 0,
                continuationReceipt: null,
              } satisfies ContinueQuoteAgentMissionLineQueueOutput,
            } as const;
          }

          let nextWork: AgentMissionQuoteLineWork;
          let transition;
          let outcome: 'catalogue_not_found' | 'choices_presented';
          let presentedChoiceCount: number;
          if (searched.candidates.length === 0) {
            nextWork = workTransitionValue(recordCatalogueNotFoundOnQuoteLineWork({
              workItem: head,
              expectedRevision: head.revision,
              occurredAt: now,
            }));
            const resolved = mission.recordCatalogueNotFound({
              expectedRevision: mission.revision,
              pendingLineId: head.id,
              workRevisionAfter: nextWork.revision,
              occurredAt: now,
            });
            if (!resolved.ok) abort(agentMissionDomainError(resolved.error));
            transition = resolved.value;
            outcome = 'catalogue_not_found';
            presentedChoiceCount = 0;
          } else {
            nextWork = workTransitionValue(presentCatalogueChoicesOnQuoteLineWork({
              workItem: head,
              expectedRevision: head.revision,
              occurredAt: now,
            }));
            const choices = searched.candidates.map((candidate) => ({
              choiceId: this.deps.ids.newId(),
              catalogueItemId: candidate.id,
              expectedCatalogueRevision: candidate.revision,
            }));
            const presented = mission.presentCatalogueChoices({
              expectedRevision: mission.revision,
              decisionId: this.deps.ids.newId(),
              pendingLineId: head.id,
              expectedWorkRevision: nextWork.revision,
              expectedDraft: {
                sessionId: slot.payload.draft.sessionId,
                slotRevision: slot.revision,
                contentRevision: slot.payload.draft.contentRevision,
              },
              candidates: choices,
              freeLineChoiceId: this.deps.ids.newId(),
              occurredAt: now,
            });
            if (!presented.ok) abort(agentMissionDomainError(presented.error));
            transition = presented.value;
            outcome = 'choices_presented';
            presentedChoiceCount = choices.length + 1;
          }

          const updatedWork = await transaction.quoteLineWork.updateCas({
            workItem: nextWork,
            expectedRevision: head.revision,
          });
          if (updatedWork !== 'updated') {
            abort(appConflict('agent_mission_quote_line_work', 'stale_revision'));
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
          const draftReference = {
            sessionId: slot.payload.draft.sessionId,
            slotRevision: slot.revision,
            contentRevision: slot.payload.draft.contentRevision,
          };
          const event = recordAgentMissionEvent({
            owner,
            transition,
            actor: 'system',
            commandId,
            fingerprint: fingerprint.value,
            ids: this.deps.ids,
            draftBefore: draftReference,
            draftAfter: draftReference,
            ...(correlation === undefined ? {} : { correlation }),
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
              mission: view.value,
              pendingLineId: head.id,
              presentedChoiceCount,
              continuationReceipt: receiptFromSnapshot(eventSnapshot),
            } satisfies ContinueQuoteAgentMissionLineQueueOutput,
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
      if (cause instanceof ContinueQuoteAgentMissionLineQueueAbort) {
        return err(cause.appError);
      }
      throw cause;
    }
  }
}
