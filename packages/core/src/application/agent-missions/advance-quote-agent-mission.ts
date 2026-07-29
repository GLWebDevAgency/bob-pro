import { type AgentMission } from '../../domain/agent/agent-mission';
import {
  isCanonicalAgentMissionUserCommandId,
  type AgentMissionEventSnapshot,
} from '../../domain/agent/agent-mission-event';
import { type Result, err, ok } from '../../shared-kernel/result';
import { applyQuoteDraftCustomerSelection } from '../quote-drafts/apply-quote-draft-transition';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionUnitOfWorkPort,
} from '../ports/agent-mission-unit-of-work';
import { type AgentMissionFingerprintPort } from '../ports/agent-mission-fingerprint';
import { type IdGeneratorPort } from '../ports/services';
import {
  type AppError,
  appConflict,
} from '../result';
import {
  agentMissionDomainError,
  canonicalAgentMissionAdvanceCustomerCommand,
  deriveAgentMissionSystemCommandId,
  isCanonicalAgentMissionOwner,
  isCanonicalAgentMissionUuid,
  isCanonicalCustomerCandidateReference,
  missingAgentMission,
  recordAgentMissionEvent,
  rejectedAgentMissionCapability,
  requireAgentMissionFingerprint,
  toAgentMissionView,
  unavailableAgentMissionCompany,
  verifyAgentMissionFingerprint,
  type AgentMissionViewV1,
} from './agent-mission-application';

export interface AdvanceQuoteAgentMissionInput extends AgentMissionOwner {
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly missionId: string;
  readonly acknowledgementCommandId: string;
}

export interface AdvanceQuoteAgentMissionOutput {
  readonly outcome: 'advanced' | 'replayed' | 'superseded';
  readonly mission: AgentMissionViewV1;
}

export interface AdvanceQuoteAgentMissionDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class AdvanceQuoteAgentMissionAbort extends Error {
  constructor(readonly appError: AppError) {
    super('advance-quote-agent-mission-abort');
  }
}

function abort(error: AppError): never {
  throw new AdvanceQuoteAgentMissionAbort(error);
}

function screenAckReceipt(
  snapshot: AgentMissionEventSnapshot,
  missionId: string,
): {
  readonly missionRevisionAfter: number;
  readonly realtimeSessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
} | null {
  if (
    snapshot.eventType !== 'screen_acknowledged'
    || snapshot.missionId !== missionId
    || snapshot.actor !== 'system'
    || snapshot.realtimeSessionId === null
    || snapshot.turnId !== null
    || snapshot.contextRevision === null
    || snapshot.contextDigest === null
  ) return null;
  return {
    missionRevisionAfter: snapshot.missionRevisionAfter,
    realtimeSessionId: snapshot.realtimeSessionId,
    contextRevision: snapshot.contextRevision,
    contextDigest: snapshot.contextDigest,
  };
}

function draftReference(slot: AgentMissionQuoteDraftSlot): {
  readonly sessionId: string;
  readonly slotRevision: number;
  readonly contentRevision: number;
} {
  return {
    sessionId: slot.payload.draft.sessionId,
    slotRevision: slot.revision,
    contentRevision: slot.payload.draft.contentRevision,
  };
}

function invalidCustomerRead(): never {
  abort({
    kind: 'dependency',
    port: 'customer_candidate_search',
    cause: 'invalid_customer_read',
  });
}

function bindingMatchesReceipt(
  mission: AgentMission,
  receipt: NonNullable<ReturnType<typeof screenAckReceipt>>,
): boolean {
  const binding = mission.currentBinding;
  return (
    binding !== null
    && binding.realtimeSessionId === receipt.realtimeSessionId
    && binding.contextRevision === receipt.contextRevision
    && binding.contextDigest === receipt.contextDigest
  );
}

function draftMatchesMission(
  slot: AgentMissionQuoteDraftSlot,
  mission: AgentMission,
): boolean {
  const reference = mission.payload.draft;
  return (
    reference !== null
    && slot.agentMissionId === mission.id
    && slot.payload.draft.sessionId === reference.sessionId
    && slot.revision === reference.slotRevision
    && slot.payload.draft.contentRevision === reference.contentRevision
    && slot.payload.draft.step === 'client'
    && slot.payload.draft.customer === null
  );
}

function transitionValue(
  transition: ReturnType<AgentMission['consumeStagedCustomerResolution']>,
) {
  if (!transition.ok) abort(agentMissionDomainError(transition.error));
  return transition.value;
}

export class AdvanceQuoteAgentMission {
  constructor(private readonly deps: AdvanceQuoteAgentMissionDeps) {}

  async execute(
    input: AdvanceQuoteAgentMissionInput,
  ): Promise<Result<AdvanceQuoteAgentMissionOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'identity', message: 'Identité mission invalide.' }],
      });
    }
    if (!isCanonicalAgentMissionUuid(input.missionId)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'missionId', message: 'UUID canonique requis.' }],
      });
    }
    if (!isCanonicalAgentMissionUserCommandId(input.acknowledgementCommandId)) {
      return err({
        kind: 'validation',
        issues: [{
          field: 'acknowledgementCommandId',
          message: 'UUID v4 canonique requis.',
        }],
      });
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
          const acknowledgement = await transaction.events.findByCommandId({
            ...owner,
            commandId: input.acknowledgementCommandId,
          });
          if (acknowledgement === null) {
            abort(appConflict('agent_mission_screen_ack', 'missing_acknowledgement'));
          }
          const receipt = screenAckReceipt(acknowledgement.toSnapshot(), input.missionId);
          if (receipt === null) {
            abort(appConflict('agent_mission_screen_ack', 'invalid_acknowledgement'));
          }
          if (transaction.realtime.realtimeSessionId !== receipt.realtimeSessionId) {
            abort(appConflict('agent_mission_screen_ack', 'context_stale'));
          }

          const commandId = deriveAgentMissionSystemCommandId({
            operation: 'consume_staged_customer_resolution',
            ...owner,
            missionId: input.missionId,
            acknowledgementMissionRevision: receipt.missionRevisionAfter,
          });
          const canonical = canonicalAgentMissionAdvanceCustomerCommand({
            ...owner,
            commandId,
            missionId: input.missionId,
            acknowledgementCommandId: input.acknowledgementCommandId,
            acknowledgementMissionRevision: receipt.missionRevisionAfter,
            realtimeSessionId: receipt.realtimeSessionId,
            contextRevision: receipt.contextRevision,
            contextDigest: receipt.contextDigest,
          });
          const consumed = await transaction.events.findByCommandId({
            ...owner,
            commandId,
          });
          if (consumed !== null) {
            const snapshot = consumed.toSnapshot();
            if (
              snapshot.missionId !== input.missionId
              || snapshot.actor !== 'system'
              || (
                snapshot.eventType !== 'customer_not_found'
                && snapshot.eventType !== 'customer_choice_presented'
                && snapshot.eventType !== 'customer_selected'
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
            const mission = await transaction.missions.findById({
              ...owner,
              missionId: input.missionId,
            });
            if (mission === null) {
              abort({
                kind: 'dependency',
                port: 'agent_mission_repository',
                cause: 'continuation_event_without_mission',
              });
            }
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              outcome: 'replayed',
              mission: view.value,
            } satisfies AdvanceQuoteAgentMissionOutput;
          }

          const mission = await transaction.missions.findByIdForUpdate({
            ...owner,
            missionId: input.missionId,
          });
          if (mission === null) abort(missingAgentMission(input.missionId));
          if (
            mission.status !== 'active'
            || mission.revision !== receipt.missionRevisionAfter
            || !bindingMatchesReceipt(mission, receipt)
            || mission.payload.stagedCustomerResolution === null
          ) {
            const view = toAgentMissionView(mission, now);
            if (!view.ok) abort(view.error);
            return {
              outcome: 'superseded',
              mission: view.value,
            } satisfies AdvanceQuoteAgentMissionOutput;
          }

          const slot = await transaction.quoteDrafts.getForUpdate(owner);
          if (slot === null || !draftMatchesMission(slot, mission)) {
            abort(appConflict('agent_mission_quote_draft', 'draft_stale'));
          }
          const before = draftReference(slot);
          const staged = mission.payload.stagedCustomerResolution;
          const fingerprint = requireAgentMissionFingerprint(
            this.deps.fingerprints,
            canonical,
          );
          if (!fingerprint.ok) abort(fingerprint.error);

          let transition;
          let draftAfter = slot;
          if (staged.kind === 'none' || staged.kind === 'too_many') {
            transition = transitionValue(mission.consumeStagedCustomerResolution({
              expectedRevision: mission.revision,
              outcome: 'not_found',
              occurredAt: now,
            }));
          } else if (staged.kind === 'exact') {
            const customer = await transaction.customers.findById({
              companyId: owner.companyId,
              customerId: staged.customerId,
            });
            if (
              customer !== null
              && (
                !isCanonicalCustomerCandidateReference(customer)
                || customer.customerId !== staged.customerId
              )
            ) invalidCustomerRead();
            if (customer === null) {
              transition = transitionValue(mission.consumeStagedCustomerResolution({
                expectedRevision: mission.revision,
                outcome: 'not_found',
                occurredAt: now,
              }));
            } else {
              const payload = applyQuoteDraftCustomerSelection(slot.payload, {
                id: customer.customerId,
                name: customer.canonicalName,
              });
              if (!payload.ok) {
                abort({
                  kind: 'dependency',
                  port: 'agent_mission_quote_draft',
                  cause: `${payload.error.code}:${payload.error.path}`,
                });
              }
              const selected = await transaction.quoteDrafts.selectCustomerCas({
                ...owner,
                missionId: mission.id,
                expectedSlotRevision: slot.revision,
                expectedDraftSessionId: slot.payload.draft.sessionId,
                expectedDraftContentRevision: slot.payload.draft.contentRevision,
                payload: payload.value,
              });
              if (selected === null) {
                abort(appConflict('agent_mission_quote_draft', 'stale_revision'));
              }
              draftAfter = selected;
              transition = transitionValue(mission.consumeStagedCustomerResolution({
                expectedRevision: mission.revision,
                outcome: 'select_exact',
                customerId: customer.customerId,
                updatedDraft: draftReference(selected),
                occurredAt: now,
              }));
            }
          } else {
            const available = await transaction.customers.findByIds({
              companyId: owner.companyId,
              customerIds: staged.candidates.map((candidate) => candidate.customerId),
            });
            const stagedIds = new Set(
              staged.candidates.map((candidate) => candidate.customerId),
            );
            if (
              !Array.isArray(available)
              || available.length > staged.candidates.length
              || available.some(
                (candidate) => (
                  !isCanonicalCustomerCandidateReference(candidate)
                  || !stagedIds.has(candidate.customerId)
                ),
              )
            ) invalidCustomerRead();
            const availableIds = new Set(available.map((candidate) => candidate.customerId));
            if (availableIds.size !== available.length) {
              invalidCustomerRead();
            }
            const candidates = staged.candidates.filter(
              (candidate) => availableIds.has(candidate.customerId),
            );
            transition = candidates.length === 0
              ? transitionValue(mission.consumeStagedCustomerResolution({
                  expectedRevision: mission.revision,
                  outcome: 'not_found',
                  occurredAt: now,
                }))
              : transitionValue(mission.consumeStagedCustomerResolution({
                  expectedRevision: mission.revision,
                  outcome: 'present_choices',
                  candidates,
                  occurredAt: now,
                }));
          }

          const updated = await transaction.missions.updateCas({
            mission: transition.mission,
            expectedRevision: mission.revision,
          });
          if (updated !== 'updated') {
            abort(appConflict('agent_mission', 'stale_revision'));
          }
          const event = recordAgentMissionEvent({
            owner,
            transition,
            actor: 'system',
            commandId,
            fingerprint: fingerprint.value,
            ids: this.deps.ids,
            draftBefore: before,
            draftAfter: draftReference(draftAfter),
            correlation: {
              realtimeSessionId: receipt.realtimeSessionId,
              turnId: null,
              contextRevision: receipt.contextRevision,
              contextDigest: receipt.contextDigest,
            },
          });
          if (!event.ok) abort(event.error);
          await transaction.events.append(event.value);
          const view = toAgentMissionView(transition.mission, now);
          if (!view.ok) abort(view.error);
          return {
            outcome: 'advanced',
            mission: view.value,
          } satisfies AdvanceQuoteAgentMissionOutput;
        },
      );
      if (execution.status === 'company_unavailable') {
        return err(unavailableAgentMissionCompany(execution.reason));
      }
      if (execution.status === 'capability_rejected') {
        return err(rejectedAgentMissionCapability(execution.reason));
      }
      return ok(execution.value);
    } catch (cause) {
      if (cause instanceof AdvanceQuoteAgentMissionAbort) return err(cause.appError);
      throw cause;
    }
  }
}
