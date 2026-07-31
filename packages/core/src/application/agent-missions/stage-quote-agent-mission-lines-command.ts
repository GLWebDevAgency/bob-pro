import {
  AGENT_MISSION_PROTOCOL_M2A,
} from '../../domain/agent/agent-mission';
import {
  isCanonicalAgentMissionUserCommandId,
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
  type AgentMissionQuoteLineCandidateV1,
  type NormalizedAgentMissionQuoteLineCandidateV1,
  normalizeAgentMissionQuoteLineCandidate,
} from './quote-line-candidate';
import {
  isCanonicalAgentMissionDraftSessionId,
} from './agent-mission-identifiers';
import {
  stageQuoteAgentMissionLinesInTransaction,
} from './stage-quote-agent-mission-lines';

const INT4_MAX = 2_147_483_647;

export interface StageQuoteAgentMissionLinesInput extends AgentMissionOwner {
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
}

export interface StageQuoteAgentMissionLinesOutput {
  readonly outcome: 'staged' | 'replayed';
  readonly mission: AgentMissionViewV1;
  readonly stagedCount: number;
  readonly firstQueueOrdinal: number;
  readonly lastQueueOrdinal: number;
}

export interface StageQuoteAgentMissionLinesDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class StageQuoteAgentMissionLinesAbort extends Error {
  constructor(readonly appError: AppError) {
    super('stage-quote-agent-mission-lines-abort');
  }
}

function abort(error: AppError): never {
  throw new StageQuoteAgentMissionLinesAbort(error);
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

function normalizeLines(
  lines: unknown,
): Result<readonly NormalizedAgentMissionQuoteLineCandidateV1[], AppError> {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 20) {
    return err(validation('lines', 'Entre une et vingt lignes sont requises.'));
  }
  const normalized: NormalizedAgentMissionQuoteLineCandidateV1[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = normalizeAgentMissionQuoteLineCandidate(lines[index]);
    if (!parsed.ok) {
      return err(validation(
        `lines[${index}].${parsed.error.field}`,
        `Ligne invalide (${parsed.error.reason}).`,
      ));
    }
    normalized.push(parsed.value);
  }
  return ok(Object.freeze(normalized));
}

function canonicalLine(
  line: NormalizedAgentMissionQuoteLineCandidateV1,
): readonly unknown[] {
  return [
    line.serviceReference,
    line.category,
    line.quantityMilli,
    line.unit,
    line.unitPriceCents,
    line.requestedVatRate,
    line.priceBasis,
  ];
}

export function canonicalStageQuoteAgentMissionLinesCommand(input: {
  readonly owner: AgentMissionOwner;
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly normalizedLines: readonly NormalizedAgentMissionQuoteLineCandidateV1[];
}): string {
  const correlation = input.origin.correlation;
  return JSON.stringify([
    'bob.agent-mission.command.stage-quote-lines.v1',
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
    input.normalizedLines.map(canonicalLine),
  ]);
}

function slotMatches(
  slot: AgentMissionQuoteDraftSlot,
  missionId: string,
  input: Pick<
    StageQuoteAgentMissionLinesInput,
    | 'expectedDraftSessionId'
    | 'expectedDraftSlotRevision'
    | 'expectedDraftContentRevision'
  >,
): boolean {
  return slot.agentMissionId === missionId
    && slot.payload.draft.sessionId === input.expectedDraftSessionId
    && slot.revision === input.expectedDraftSlotRevision
    && slot.payload.draft.contentRevision === input.expectedDraftContentRevision
    && slot.payload.draft.step === 'lignes'
    && slot.payload.draft.customer !== null;
}

export class StageQuoteAgentMissionLines {
  constructor(private readonly deps: StageQuoteAgentMissionLinesDeps) {}

  async execute(
    input: StageQuoteAgentMissionLinesInput,
  ): Promise<Result<StageQuoteAgentMissionLinesOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return err(validation('identity', 'Identité mission invalide.'));
    }
    if (
      !isCanonicalAgentMissionUuid(input.missionId)
      || !isCanonicalAgentMissionUserCommandId(input.commandId)
    ) {
      return err(validation('command', 'Identifiants canoniques requis.'));
    }
    if (
      !isPositiveInt4(input.expectedMissionRevision)
      || !isPositiveInt4(input.expectedDraftSlotRevision)
      || !Number.isSafeInteger(input.expectedDraftContentRevision)
      || input.expectedDraftContentRevision < 0
      || input.expectedDraftContentRevision > INT4_MAX
      || !isCanonicalAgentMissionDraftSessionId(input.expectedDraftSessionId)
    ) {
      return err(validation('fences', 'Révisions de brouillon invalides.'));
    }
    if (!isCanonicalAgentMissionUserCommandOrigin(input.origin)) {
      return err(validation('origin', 'Provenance de commande invalide.'));
    }
    if (input.authority.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    const normalizedLines = normalizeLines(input.lines);
    if (!normalizedLines.ok) return normalizedLines;

    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const canonical = canonicalStageQuoteAgentMissionLinesCommand({
      owner,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      origin: input.origin,
      normalizedLines: normalizedLines.value,
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
              || snapshot.eventType !== 'line_candidates_staged'
              || snapshot.data.kind !== 'line_candidates_staged'
              || snapshot.actor !== input.origin.actor
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
                cause: 'line_staging_event_without_mission',
              });
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
              output: {
                outcome: 'replayed',
                mission: view.value,
                stagedCount: snapshot.data.stagedCount,
                firstQueueOrdinal: snapshot.data.firstQueueOrdinal,
                lastQueueOrdinal: snapshot.data.lastQueueOrdinal,
              } satisfies StageQuoteAgentMissionLinesOutput,
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
          if (mission.phase !== 'awaiting_lines') {
            abort(appConflict('agent_mission', 'invalid_phase'));
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
          if (slot === null || !slotMatches(slot, mission.id, input)) {
            abort(appConflict('agent_mission_quote_draft', 'draft_stale'));
          }
          const missionDraft = mission.payload.draft;
          if (
            missionDraft === null
            || missionDraft.sessionId !== slot.payload.draft.sessionId
            || missionDraft.slotRevision !== slot.revision
            || missionDraft.contentRevision !== slot.payload.draft.contentRevision
          ) {
            abort(appConflict('agent_mission_quote_draft', 'draft_stale'));
          }

          const staged = await stageQuoteAgentMissionLinesInTransaction({
            transaction,
            owner,
            mission,
            confirmedLineCount: slot.payload.draft.lines.length,
            candidates: input.lines,
            origin: input.origin.actor,
            occurredAt: now,
            ids: this.deps.ids,
          });
          if (!staged.ok) abort(staged.error);
          const transition = mission.recordLineCandidatesStaged({
            expectedRevision: input.expectedMissionRevision,
            stagedCount: staged.value.workItems.length,
            firstQueueOrdinal: staged.value.firstQueueOrdinal,
            lastQueueOrdinal: staged.value.lastQueueOrdinal,
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
            transition: transition.value,
            actor: input.origin.actor,
            commandId: input.commandId,
            fingerprint: fingerprint.value,
            ids: this.deps.ids,
            draftBefore: draftReference,
            draftAfter: draftReference,
            ...(correlation.value === undefined ? {} : { correlation: correlation.value }),
          });
          if (!event.ok) abort(event.error);
          await transaction.events.append(event.value);
          const view = toAgentMissionView(transition.value.mission, now);
          if (!view.ok) abort(view.error);
          return {
            kind: 'success',
            output: {
              outcome: 'staged',
              mission: view.value,
              stagedCount: staged.value.workItems.length,
              firstQueueOrdinal: staged.value.firstQueueOrdinal,
              lastQueueOrdinal: staged.value.lastQueueOrdinal,
            } satisfies StageQuoteAgentMissionLinesOutput,
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
      if (cause instanceof StageQuoteAgentMissionLinesAbort) {
        return err(cause.appError);
      }
      throw cause;
    }
  }
}
