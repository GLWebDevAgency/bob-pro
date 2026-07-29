import {
  isCanonicalAgentMissionUserCommandId,
  type AgentMissionEventSnapshot,
} from '../../domain/agent/agent-mission-event';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type IdGeneratorPort } from '../ports/services';
import { type AgentMissionFingerprintPort } from '../ports/agent-mission-fingerprint';
import { type AgentMissionOwner } from '../ports/agent-mission-repository';
import {
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionUnitOfWorkPort,
} from '../ports/agent-mission-unit-of-work';
import {
  type AppError,
  appConflict,
  appUnavailable,
} from '../result';
import {
  agentMissionDomainError,
  canonicalAgentMissionScreenAckCommand,
  guardAgentMissionReplayForeground,
  isCanonicalAgentMissionOwner,
  isCanonicalAgentMissionUuid,
  missingAgentMission,
  recordAgentMissionEvent,
  rejectedAgentMissionCapability,
  requireAgentMissionFingerprint,
  resolveQuoteAgentMissionEventLookup,
  resolveQuoteAgentMissionLookup,
  resolveQuoteAgentMissionForUpdate,
  toAgentMissionView,
  unavailableAgentMissionCompany,
  unavailableAgentMissionForeground,
  verifyAgentMissionFingerprint,
  type AgentMissionViewV1,
} from './agent-mission-application';
import { isCanonicalAgentMissionDraftSessionId } from './agent-mission-identifiers';

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const POSTGRES_INT_MAX = 2_147_483_647;

export interface AcknowledgeQuoteScreenInput extends AgentMissionOwner {
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly realtimeSessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly draftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
}

export interface AcknowledgeQuoteScreenOutput {
  readonly outcome: 'acknowledged' | 'replayed';
  readonly receipt: AcknowledgeQuoteScreenReceipt;
  readonly mission: AgentMissionViewV1;
}

export interface AcknowledgeQuoteScreenReceipt {
  readonly ackCommandId: string;
  readonly missionId: string;
  readonly missionRevisionAfter: number;
  readonly realtimeSessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly occurredAt: string;
}

export interface AcknowledgeQuoteScreenDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class AcknowledgeQuoteScreenAbort extends Error {
  constructor(readonly appError: AppError) {
    super('acknowledge-quote-screen-abort');
  }
}

function abort(error: AppError): never {
  throw new AcknowledgeQuoteScreenAbort(error);
}

function isRevision(value: unknown, allowZero: boolean): value is number {
  return Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) <= POSTGRES_INT_MAX;
}

function validation(field: string, message: string): Result<never, AppError> {
  return err({ kind: 'validation', issues: [{ field, message }] });
}

function screenObservationError(
  reason: 'context_stale' | 'draft_stale' | 'unavailable',
): AppError {
  return reason === 'unavailable'
    ? appUnavailable('agent_mission_screen_ack')
    : appConflict('agent_mission_screen_ack', reason);
}

function acknowledgementReceipt(
  snapshot: AgentMissionEventSnapshot,
): AcknowledgeQuoteScreenReceipt | null {
  if (
    snapshot.eventType !== 'screen_acknowledged'
    || snapshot.realtimeSessionId === null
    || snapshot.contextRevision === null
    || snapshot.contextDigest === null
    || snapshot.turnId !== null
  ) return null;
  return Object.freeze({
    ackCommandId: snapshot.commandId,
    missionId: snapshot.missionId,
    missionRevisionAfter: snapshot.missionRevisionAfter,
    realtimeSessionId: snapshot.realtimeSessionId,
    contextRevision: snapshot.contextRevision,
    contextDigest: snapshot.contextDigest,
    occurredAt: snapshot.occurredAt,
  });
}

export class AcknowledgeQuoteScreen {
  constructor(private readonly deps: AcknowledgeQuoteScreenDeps) {}

  async execute(
    input: AcknowledgeQuoteScreenInput,
  ): Promise<Result<AcknowledgeQuoteScreenOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return validation('identity', 'Identité mission invalide.');
    }
    if (!isCanonicalAgentMissionUuid(input.missionId)) {
      return validation('missionId', 'UUID canonique requis.');
    }
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return validation('commandId', 'UUID v4 canonique requis.');
    }
    if (!isRevision(input.expectedMissionRevision, false)) {
      return validation('expectedMissionRevision', 'Révision positive requise.');
    }
    if (!isCanonicalAgentMissionUuid(input.realtimeSessionId)) {
      return validation('realtimeSessionId', 'UUID canonique requis.');
    }
    if (!isRevision(input.contextRevision, false)) {
      return validation('contextRevision', 'Révision de contexte positive requise.');
    }
    if (!SHA256_HEX.test(input.contextDigest)) {
      return validation('contextDigest', 'Empreinte SHA-256 canonique requise.');
    }
    if (!isCanonicalAgentMissionDraftSessionId(input.draftSessionId)) {
      return validation('draftSessionId', 'Identifiant de brouillon canonique requis.');
    }
    if (!isRevision(input.expectedDraftSlotRevision, false)) {
      return validation('expectedDraftSlotRevision', 'Révision de slot positive requise.');
    }
    if (!isRevision(input.expectedDraftContentRevision, true)) {
      return validation('expectedDraftContentRevision', 'Révision de contenu positive ou nulle requise.');
    }

    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const canonical = canonicalAgentMissionScreenAckCommand({
      ...owner,
      commandId: input.commandId,
      missionId: input.missionId,
      expectedMissionRevision: input.expectedMissionRevision,
      realtimeSessionId: input.realtimeSessionId,
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
      draftSessionId: input.draftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
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
              snapshot.eventType !== 'screen_acknowledged'
              || snapshot.missionId !== input.missionId
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
            if (transaction.realtime.realtimeSessionId !== input.realtimeSessionId) {
              abort(appConflict('agent_mission_screen_ack', 'context_stale'));
            }
            const replayedLookup = await transaction.missions.findById({
              ...owner,
              missionId: input.missionId,
            });
            const replayedResult = resolveQuoteAgentMissionLookup(replayedLookup);
            if (!replayedResult.ok) abort(replayedResult.error);
            const replayed = replayedResult.value;
            if (replayed === null) {
              abort({
                kind: 'dependency',
                port: 'agent_mission_repository',
                cause: 'screen_ack_event_without_mission',
              });
            }
            const replayGuard = await guardAgentMissionReplayForeground({
              transaction,
              owner,
              replayedMissionId: replayed.id,
            });
            if (!replayGuard.ok) abort(replayGuard.error);
            const view = toAgentMissionView(replayed, now);
            if (!view.ok) abort(view.error);
            const receipt = acknowledgementReceipt(snapshot);
            if (receipt === null) {
              abort({
                kind: 'dependency',
                port: 'agent_mission_event',
                cause: 'invalid_screen_ack_receipt',
              });
            }
            return {
              outcome: 'replayed',
              receipt,
              mission: view.value,
            } satisfies AcknowledgeQuoteScreenOutput;
          }

          if (transaction.realtime.realtimeSessionId !== input.realtimeSessionId) {
            abort(appConflict('agent_mission_screen_ack', 'context_stale'));
          }
          const resolvedMission = await resolveQuoteAgentMissionForUpdate({
            transaction,
            owner,
            missionId: input.missionId,
          });
          if (!resolvedMission.ok) abort(resolvedMission.error);
          const mission = resolvedMission.value;
          if (mission === null) abort(missingAgentMission(input.missionId));
          const expired = mission.isExpiredAt(now);
          if (!expired.ok) abort(agentMissionDomainError(expired.error));
          if (expired.value) abort(appConflict('agent_mission', 'expired'));

          const observation = await transaction.quoteScreen.observeForUpdate(owner, {
            missionId: input.missionId,
            realtimeSessionId: input.realtimeSessionId,
            contextRevision: input.contextRevision,
            contextDigest: input.contextDigest,
            draftSessionId: input.draftSessionId,
            expectedDraftSlotRevision: input.expectedDraftSlotRevision,
            expectedDraftContentRevision: input.expectedDraftContentRevision,
            databaseNow: now,
          });
          if (observation.status === 'rejected') {
            abort(screenObservationError(observation.reason));
          }

          const fingerprint = requireAgentMissionFingerprint(
            this.deps.fingerprints,
            canonical,
          );
          if (!fingerprint.ok) abort(fingerprint.error);
          const transition = mission.acknowledgeQuoteScreen({
            expectedRevision: input.expectedMissionRevision,
            binding: {
              realtimeSessionId: observation.realtimeSessionId,
              contextRevision: observation.contextRevision,
              contextDigest: observation.contextDigest,
              screenName: '/devis/new',
              screenInstanceId: observation.screenInstanceId,
              acknowledgedAt: now,
            },
            observedDraft: observation.draft,
            draftHasCustomer: observation.draftHasCustomer,
            occurredAt: now,
          });
          if (!transition.ok) abort(agentMissionDomainError(transition.error));
          const updated = await transaction.missions.updateCas({
            mission: transition.value.mission,
            expectedRevision: input.expectedMissionRevision,
          });
          if (updated !== 'updated') {
            abort(appConflict('agent_mission', 'stale_revision'));
          }
          const event = recordAgentMissionEvent({
            owner,
            transition: transition.value,
            actor: 'system',
            commandId: input.commandId,
            fingerprint: fingerprint.value,
            ids: this.deps.ids,
            draftBefore: observation.draft,
            draftAfter: observation.draft,
            correlation: {
              realtimeSessionId: observation.realtimeSessionId,
              turnId: null,
              contextRevision: observation.contextRevision,
              contextDigest: observation.contextDigest,
            },
          });
          if (!event.ok) abort(event.error);
          await transaction.events.append(event.value);
          const view = toAgentMissionView(transition.value.mission, now);
          if (!view.ok) abort(view.error);
          const receipt = acknowledgementReceipt(event.value.toSnapshot());
          if (receipt === null) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_event',
              cause: 'invalid_screen_ack_receipt',
            });
          }
          return {
            outcome: 'acknowledged',
            receipt,
            mission: view.value,
          } satisfies AcknowledgeQuoteScreenOutput;
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
      return ok(execution.value);
    } catch (cause) {
      if (cause instanceof AcknowledgeQuoteScreenAbort) return err(cause.appError);
      throw cause;
    }
  }
}
