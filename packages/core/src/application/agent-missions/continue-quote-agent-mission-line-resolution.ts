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
  type AgentMissionFingerprintPort,
} from '../ports/agent-mission-fingerprint';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  CATALOGUE_CANDIDATE_SEARCH_LIMIT,
} from '../ports/catalogue-candidate-search';
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
  deriveQuoteLineProposal,
  type QuoteLineProposalRejectionReason,
} from './derive-quote-line-proposal';
import {
  presentQuoteLineProposalOnWork,
  requestQuoteLineCatalogueRefreshOnWork,
  requestQuoteLineDetailsOnWork,
  type AgentMissionQuoteLineRequiredFact,
  type AgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWorkTransitionResult,
} from './quote-line-work';

export interface ContinueQuoteAgentMissionLineResolutionInput
  extends AgentMissionOwner {
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly missionId: string;
  /**
   * Reçu utilisateur ou système connu du client. La continuation suit elle-même l'éventuel reçu
   * catalogue intermédiaire afin qu'une perte de réponse ne casse jamais la convergence.
   */
  readonly parentCommandId: string;
}

export interface AgentMissionLineContinuationReceipt {
  readonly commandId: string;
  readonly eventType: 'line_details_requested' | 'line_proposal_presented';
  readonly missionRevisionAfter: number;
}

export interface ContinueQuoteAgentMissionLineResolutionOutput {
  readonly outcome:
    | 'details_requested'
    | 'proposal_presented'
    | 'empty'
    | 'catalogue_choice_pending'
    | 'needs_catalogue_resolution'
    | 'stable'
    | 'superseded'
    | 'replayed';
  readonly mission: AgentMissionViewV1;
  readonly pendingLineId: string | null;
  readonly requiredFact: AgentMissionQuoteLineRequiredFact | null;
  readonly proposalId: string | null;
  readonly continuationReceipt: AgentMissionLineContinuationReceipt | null;
}

export interface ContinueQuoteAgentMissionLineResolutionDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class ContinueQuoteAgentMissionLineResolutionAbort extends Error {
  constructor(readonly appError: AppError) {
    super('continue-quote-agent-mission-line-resolution-abort');
  }
}

function abort(error: AppError): never {
  throw new ContinueQuoteAgentMissionLineResolutionAbort(error);
}

function validation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function invalidPersistedState(port: string, cause: string): never {
  abort({ kind: 'dependency', port, cause });
}

const LINE_RESOLUTION_PARENT_EVENTS = new Set<
  AgentMissionEventSnapshot['eventType']
>([
  'mission_started',
  'customer_resolution_staged',
  'screen_acknowledged',
  'customer_selected',
  'decision_invalidated',
  'line_candidates_staged',
  'catalogue_not_found',
  'catalogue_choices_presented',
  'catalogue_choice_selected',
  'line_fact_patched',
  'line_proposal_rejected',
  'line_confirmed',
  'line_cancelled',
]);

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
    'bob.agent-mission.system-command.continue-quote-line-resolution.v1',
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
  const sorted = [...workItems].sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1]?.ordinal ?? 0) >= (sorted[index]?.ordinal ?? 0)) {
      return invalidPersistedState(
        'agent_mission_quote_line_work',
        'unordered_locked_queue',
      );
    }
  }
  return sorted[0] as AgentMissionQuoteLineWork;
}

function receiptFromSnapshot(
  snapshot: AgentMissionEventSnapshot,
): AgentMissionLineContinuationReceipt {
  if (
    snapshot.eventType !== 'line_details_requested'
    && snapshot.eventType !== 'line_proposal_presented'
  ) {
    return invalidPersistedState(
      'agent_mission_event',
      'invalid_line_resolution_receipt',
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
): ContinueQuoteAgentMissionLineResolutionOutput {
  if (
    snapshot.eventType === 'line_details_requested'
    && snapshot.data.kind === 'line_details_requested'
  ) {
    return {
      outcome: 'replayed',
      mission,
      pendingLineId: snapshot.data.pendingLineId,
      requiredFact: snapshot.data.requiredFact,
      proposalId: null,
      continuationReceipt: receiptFromSnapshot(snapshot),
    };
  }
  if (
    snapshot.eventType === 'line_proposal_presented'
    && snapshot.data.kind === 'line_proposal_presented'
  ) {
    return {
      outcome: 'replayed',
      mission,
      pendingLineId: snapshot.data.pendingLineId,
      requiredFact: null,
      proposalId: snapshot.data.proposalId,
      continuationReceipt: receiptFromSnapshot(snapshot),
    };
  }
  return invalidPersistedState(
    'agent_mission_event',
    'invalid_line_resolution_receipt',
  );
}

function requiredFactForRejection(
  reason: QuoteLineProposalRejectionReason,
): AgentMissionQuoteLineRequiredFact | null {
  if (reason === 'inexact_total_price' || reason === 'amount_out_of_bounds') {
    return 'unit_price';
  }
  if (reason === 'unsupported_vat_rate' || reason === 'ineligible_reduced_rate') {
    return 'vat_rate';
  }
  return null;
}

function stableOutput(input: {
  readonly outcome:
    | 'empty'
    | 'catalogue_choice_pending'
    | 'needs_catalogue_resolution'
    | 'stable'
    | 'superseded';
  readonly mission: AgentMissionViewV1;
  readonly pendingLineId?: string | null;
}): ContinueQuoteAgentMissionLineResolutionOutput {
  return {
    outcome: input.outcome,
    mission: input.mission,
    pendingLineId: input.pendingLineId ?? null,
    requiredFact: null,
    proposalId: null,
    continuationReceipt: null,
  };
}

export class ContinueQuoteAgentMissionLineResolution {
  constructor(
    private readonly deps: ContinueQuoteAgentMissionLineResolutionDeps,
  ) {}

  async execute(
    input: ContinueQuoteAgentMissionLineResolutionInput,
  ): Promise<Result<ContinueQuoteAgentMissionLineResolutionOutput, AppError>> {
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
          const rootLookup = await transaction.events.findByCommandId({
            ...owner,
            commandId: input.parentCommandId,
          });
          const rootResult = resolveQuoteAgentMissionEventLookup(rootLookup);
          if (!rootResult.ok) abort(rootResult.error);
          const root = rootResult.value;
          if (root === null) {
            abort(appConflict('agent_mission_line_continuation', 'parent_missing'));
          }
          const rootSnapshot = root.toSnapshot();
          if (
            rootSnapshot.missionId !== input.missionId
            || !LINE_RESOLUTION_PARENT_EVENTS.has(rootSnapshot.eventType)
          ) {
            abort(appConflict('agent_mission_line_continuation', 'parent_invalid'));
          }

          /*
           * Une commande de staging peut avoir produit un reçu catalogue intermédiaire avant
           * cette continuation. On le suit par son UUID dérivé, sans demander au client de
           * connaître une commande système interne.
           */
          let parentSnapshot = rootSnapshot;
          if (
            rootSnapshot.eventType !== 'catalogue_not_found'
            && rootSnapshot.eventType !== 'catalogue_choices_presented'
          ) {
            const catalogueCommandId = deriveAgentMissionSystemCommandId({
              operation: 'continue_quote_line_catalogue',
              ...owner,
              missionId: input.missionId,
              parentEventType: rootSnapshot.eventType,
              parentCommandId: rootSnapshot.commandId,
              parentMissionRevision: rootSnapshot.missionRevisionAfter,
            });
            const catalogueLookup = await transaction.events.findByCommandId({
              ...owner,
              commandId: catalogueCommandId,
            });
            const catalogueResult = resolveQuoteAgentMissionEventLookup(catalogueLookup);
            if (!catalogueResult.ok) abort(catalogueResult.error);
            const catalogueReceipt = catalogueResult.value;
            if (catalogueReceipt !== null) {
              const observed = catalogueReceipt.toSnapshot();
              if (
                observed.missionId !== input.missionId
                || observed.actor !== 'system'
                || (
                  observed.eventType !== 'catalogue_not_found'
                  && observed.eventType !== 'catalogue_choices_presented'
                )
                || observed.missionRevisionBefore !== rootSnapshot.missionRevisionAfter
              ) {
                return invalidPersistedState(
                  'agent_mission_event',
                  'invalid_catalogue_continuation_chain',
                );
              }
              parentSnapshot = observed;
            }
          }

          const commandId = deriveAgentMissionSystemCommandId({
            operation: 'continue_quote_line_resolution',
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
                'line_resolution_event_without_mission',
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
              output: stableOutput({ outcome: 'superseded', mission: view.value }),
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
          if (mission.phase === 'awaiting_catalogue_choice') {
            const decision = mission.payload.decision;
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              kind: 'success',
              output: stableOutput({
                outcome: 'catalogue_choice_pending',
                mission: view.value,
                pendingLineId: decision?.kind === 'catalogue'
                  ? decision.pendingLineId
                  : null,
              }),
            } as const;
          }
          if (
            mission.phase === 'awaiting_line_details'
            || mission.phase === 'awaiting_line_confirmation'
          ) {
            const decision = mission.payload.decision;
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              kind: 'success',
              output: stableOutput({
                outcome: 'stable',
                mission: view.value,
                pendingLineId: decision?.kind === 'line_confirmation'
                  ? decision.pendingLineId
                  : null,
              }),
            } as const;
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
              output: stableOutput({ outcome: 'empty', mission: view.value }),
            } as const;
          }
          if (head.state !== 'queued') {
            return invalidPersistedState(
              'agent_mission_quote_line_work',
              'phase_work_state_mismatch',
            );
          }
          let catalogueSearchTruncated = false;
          if (
            head.catalogueResolution === 'pending'
            && head.serviceReference !== null
          ) {
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
            catalogueSearchTruncated = searched.truncated;
          }
          if (
            head.catalogueResolution === 'pending'
            && head.serviceReference !== null
            && !catalogueSearchTruncated
          ) {
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              kind: 'success',
              output: stableOutput({
                outcome: 'needs_catalogue_resolution',
                mission: view.value,
                pendingLineId: head.id,
              }),
            } as const;
          }

          let selectedCatalogue = null;
          let catalogueStale = false;
          if (head.catalogueResolution === 'selected') {
            const catalogue = await transaction.catalogueCandidates.getById({
              companyId: owner.companyId,
              id: head.catalogueItemId as string,
            });
            if (
              catalogue === null
              || catalogue.revision !== head.expectedCatalogueRevision
            ) {
              catalogueStale = true;
            } else {
              selectedCatalogue = catalogue;
            }
          }

          let nextWork: AgentMissionQuoteLineWork;
          let transition;
          let outcome: 'details_requested' | 'proposal_presented';
          let requiredFact: AgentMissionQuoteLineRequiredFact | null = null;
          let proposalId: string | null = null;
          if (catalogueSearchTruncated) {
            requiredFact = 'service_reference';
            nextWork = workTransitionValue(requestQuoteLineDetailsOnWork({
              workItem: head,
              expectedRevision: head.revision,
              requiredFact,
              occurredAt: now,
            }));
            const requested = mission.requestLineDetails({
              expectedRevision: mission.revision,
              pendingLineId: head.id,
              requiredFact,
              workRevisionAfter: nextWork.revision,
              occurredAt: now,
            });
            if (!requested.ok) abort(agentMissionDomainError(requested.error));
            transition = requested.value;
            outcome = 'details_requested';
          } else if (catalogueStale) {
            nextWork = workTransitionValue(requestQuoteLineCatalogueRefreshOnWork({
              workItem: head,
              expectedRevision: head.revision,
              occurredAt: now,
            }));
            requiredFact = 'service_reference';
            const requested = mission.requestLineDetails({
              expectedRevision: mission.revision,
              pendingLineId: head.id,
              requiredFact,
              workRevisionAfter: nextWork.revision,
              occurredAt: now,
            });
            if (!requested.ok) abort(agentMissionDomainError(requested.error));
            transition = requested.value;
            outcome = 'details_requested';
          } else {
            const customerId = slot.payload.draft.customer?.id;
            if (customerId === undefined) {
              return invalidPersistedState(
                'agent_mission_quote_draft',
                'customer_missing',
              );
            }
            const vatContext = await transaction.quoteVatContext.getForUpdate({
              companyId: owner.companyId,
              customerId,
            });
            if (vatContext === null || vatContext.customerId !== customerId) {
              return invalidPersistedState(
                'quote_vat_context',
                'context_unavailable',
              );
            }
            const derivation = deriveQuoteLineProposal({
              workItem: head,
              payload: slot.payload,
              selectedCatalogue,
              vatContext,
            });
            const derivedRequiredFact = derivation.kind === 'required_fact'
              ? derivation.requiredFact
              : derivation.kind === 'rejected'
                ? requiredFactForRejection(derivation.reason)
                : null;
            if (derivation.kind !== 'resolved' && derivedRequiredFact === null) {
              abort(appConflict(
                'agent_mission_quote_line_proposal',
                derivation.kind === 'rejected'
                  ? derivation.reason
                  : 'unresolved',
              ));
            }
            if (derivation.kind !== 'resolved') {
              requiredFact = derivedRequiredFact;
              nextWork = workTransitionValue(requestQuoteLineDetailsOnWork({
                workItem: head,
                expectedRevision: head.revision,
                requiredFact: requiredFact as AgentMissionQuoteLineRequiredFact,
                occurredAt: now,
              }));
              const requested = mission.requestLineDetails({
                expectedRevision: mission.revision,
                pendingLineId: head.id,
                requiredFact,
                workRevisionAfter: nextWork.revision,
                occurredAt: now,
              });
              if (!requested.ok) abort(agentMissionDomainError(requested.error));
              transition = requested.value;
              outcome = 'details_requested';
            } else {
              proposalId = this.deps.ids.newId();
              nextWork = workTransitionValue(presentQuoteLineProposalOnWork({
                workItem: head,
                expectedRevision: head.revision,
                facts: derivation.proposal.facts,
                proposalId,
                proposalDiffHash: derivation.proposal.diffHash,
                occurredAt: now,
              }));
              const presented = mission.presentLineProposal({
                expectedRevision: mission.revision,
                decisionId: this.deps.ids.newId(),
                pendingLineId: head.id,
                proposalId,
                expectedDraft: {
                  sessionId: slot.payload.draft.sessionId,
                  slotRevision: slot.revision,
                  contentRevision: slot.payload.draft.contentRevision,
                },
                expectedWorkRevision: nextWork.revision,
                expectedCatalogue: selectedCatalogue === null
                  ? null
                  : {
                      itemId: selectedCatalogue.id,
                      revision: selectedCatalogue.revision,
                    },
                expectedVatContextDigest: computeQuoteVatContextDigest(vatContext),
                diffHash: derivation.proposal.diffHash,
                confirmChoiceId: this.deps.ids.newId(),
                editChoiceId: this.deps.ids.newId(),
                cancelChoiceId: this.deps.ids.newId(),
                occurredAt: now,
              });
              if (!presented.ok) abort(agentMissionDomainError(presented.error));
              transition = presented.value;
              outcome = 'proposal_presented';
            }
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
              requiredFact,
              proposalId,
              continuationReceipt: receiptFromSnapshot(eventSnapshot),
            } satisfies ContinueQuoteAgentMissionLineResolutionOutput,
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
      if (cause instanceof ContinueQuoteAgentMissionLineResolutionAbort) {
        return err(cause.appError);
      }
      throw cause;
    }
  }
}
