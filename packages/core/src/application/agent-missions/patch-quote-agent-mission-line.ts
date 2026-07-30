import {
  AGENT_MISSION_PROTOCOL_M2A,
  type AgentMission,
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
  isCanonicalAgentMissionDraftSessionId,
} from './agent-mission-identifiers';
import {
  normalizeAgentMissionQuoteLinePatch,
  type AgentMissionQuoteLinePatchV1,
  type NormalizedAgentMissionQuoteLinePatch,
} from './quote-line-patch';
import {
  patchQuoteLineFactOnWork,
  type AgentMissionQuoteLinePatchScope,
  type AgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWorkTransitionResult,
} from './quote-line-work';

const INT4_MAX = 2_147_483_647;

export interface PatchQuoteAgentMissionLineInput extends AgentMissionOwner {
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly scope: AgentMissionQuoteLinePatchScope;
  readonly patch: AgentMissionQuoteLinePatchV1;
}

export interface PatchQuoteAgentMissionLineOutput {
  readonly outcome: 'patched' | 'replayed';
  readonly pendingLineId: string;
  readonly workRevisionAfter: number;
  readonly mission: AgentMissionViewV1;
}

export interface PatchQuoteAgentMissionLineDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class PatchQuoteAgentMissionLineAbort extends Error {
  constructor(readonly appError: AppError) {
    super('patch-quote-agent-mission-line-abort');
  }
}

function abort(error: AppError): never {
  throw new PatchQuoteAgentMissionLineAbort(error);
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

function canonicalPatch(patch: NormalizedAgentMissionQuoteLinePatch): readonly unknown[] {
  switch (patch.field) {
    case 'service_reference':
    case 'category':
    case 'unit':
    case 'vat_rate':
    case 'housing_older_than_2y':
    case 'energy_renovation':
      return [patch.field, patch.value];
    case 'quantity':
      return [patch.field, patch.quantityMilli];
    case 'unit_price':
      return [patch.field, patch.unitPriceCents, patch.basis];
  }
}

export function canonicalPatchQuoteAgentMissionLineCommand(input: {
  readonly owner: AgentMissionOwner;
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly scope: AgentMissionQuoteLinePatchScope;
  readonly normalizedPatch: NormalizedAgentMissionQuoteLinePatch;
}): string {
  const correlation = input.origin.correlation;
  return JSON.stringify([
    'bob.agent-mission.command.patch-quote-line.v1',
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
      input.pendingLineId,
      input.expectedWorkRevision,
      input.scope,
      canonicalPatch(input.normalizedPatch),
    ],
  ]);
}

function slotMatches(
  slot: AgentMissionQuoteDraftSlot,
  mission: AgentMission,
  input: Pick<
    PatchQuoteAgentMissionLineInput,
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
  if (
    result.error.code === 'agent_mission_quote_line_work_catalogue_fence_conflict'
  ) {
    abort(appConflict('agent_mission_catalogue', 'catalogue_revision'));
  }
  abort({
    kind: 'dependency',
    port: 'agent_mission_quote_line_work',
    cause: result.error.code,
  });
}

function replayOutput(
  snapshot: AgentMissionEventSnapshot,
  mission: AgentMissionViewV1,
): PatchQuoteAgentMissionLineOutput {
  if (
    snapshot.eventType !== 'line_fact_patched'
    || snapshot.data.kind !== 'line_fact_patched'
  ) {
    abort({
      kind: 'dependency',
      port: 'agent_mission_event',
      cause: 'invalid_line_patch_receipt',
    });
  }
  return {
    outcome: 'replayed',
    pendingLineId: snapshot.data.pendingLineId,
    workRevisionAfter: snapshot.data.workRevisionAfter,
    mission,
  };
}

export class PatchQuoteAgentMissionLine {
  constructor(private readonly deps: PatchQuoteAgentMissionLineDeps) {}

  async execute(
    input: PatchQuoteAgentMissionLineInput,
  ): Promise<Result<PatchQuoteAgentMissionLineOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return err(validation('identity', 'Identité mission invalide.'));
    }
    if (
      !isCanonicalAgentMissionUuid(input.missionId)
      || !isCanonicalAgentMissionUserCommandId(input.commandId)
      || !isCanonicalAgentMissionUuid(input.pendingLineId)
    ) {
      return err(validation('command', 'Identifiants canoniques requis.'));
    }
    if (
      !isPositiveInt4(input.expectedMissionRevision)
      || !isPositiveInt4(input.expectedDraftSlotRevision)
      || !Number.isSafeInteger(input.expectedDraftContentRevision)
      || input.expectedDraftContentRevision < 0
      || input.expectedDraftContentRevision > INT4_MAX
      || !isPositiveInt4(input.expectedWorkRevision)
      || !isCanonicalAgentMissionDraftSessionId(input.expectedDraftSessionId)
    ) {
      return err(validation('fences', 'Révisions de ligne invalides.'));
    }
    if (
      input.scope !== 'answer_required_fact'
      && input.scope !== 'explicit_correction'
    ) {
      return err(validation('scope', 'Portée de correction invalide.'));
    }
    if (!isCanonicalAgentMissionUserCommandOrigin(input.origin)) {
      return err(validation('origin', 'Provenance de commande invalide.'));
    }
    if (input.authority.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    const normalizedPatch = normalizeAgentMissionQuoteLinePatch(input.patch);
    if (!normalizedPatch.ok) {
      return err(validation(
        `patch.${normalizedPatch.error.field}`,
        `Correction invalide (${normalizedPatch.error.reason}).`,
      ));
    }
    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const canonical = canonicalPatchQuoteAgentMissionLineCommand({
      owner,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      origin: input.origin,
      pendingLineId: input.pendingLineId,
      expectedWorkRevision: input.expectedWorkRevision,
      scope: input.scope,
      normalizedPatch: normalizedPatch.value,
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
              || snapshot.eventType !== 'line_fact_patched'
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
                cause: 'line_patch_event_without_mission',
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
          if (
            mission.phase !== 'awaiting_line_details'
            && mission.phase !== 'awaiting_line_confirmation'
            && mission.phase !== 'awaiting_catalogue_choice'
          ) {
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
          if (
            head.id !== input.pendingLineId
            || head.revision !== input.expectedWorkRevision
          ) {
            abort(appConflict('agent_mission_quote_line_work', 'stale_revision'));
          }

          const needsCatalogueFence = head.catalogueResolution === 'selected'
            && (
              normalizedPatch.value.field === 'category'
              || normalizedPatch.value.field === 'unit'
            );
          let selectedCatalogue = null;
          let selectedCatalogueStatus:
            'not_required' | 'matched' | 'stale' = 'not_required';
          if (needsCatalogueFence) {
            const catalogue = await transaction.catalogueCandidates.getById({
              companyId: owner.companyId,
              id: head.catalogueItemId as string,
            });
            if (
              catalogue === null
              || catalogue.revision !== head.expectedCatalogueRevision
            ) {
              selectedCatalogueStatus = 'stale';
            } else {
              selectedCatalogue = catalogue;
              selectedCatalogueStatus = 'matched';
            }
          }
          const nextWork = workTransitionValue(patchQuoteLineFactOnWork({
            workItem: head,
            expectedRevision: head.revision,
            patch: normalizedPatch.value,
            scope: input.scope,
            selectedCatalogue,
            selectedCatalogueStatus,
            occurredAt: now,
          }));
          const patched = mission.patchLineFact({
            expectedRevision: mission.revision,
            pendingLineId: head.id,
            field: normalizedPatch.value.field,
            workRevisionAfter: nextWork.revision,
            occurredAt: now,
          });
          if (!patched.ok) abort(agentMissionDomainError(patched.error));

          const updatedWork = await transaction.quoteLineWork.updateCas({
            workItem: nextWork,
            expectedRevision: head.revision,
          });
          if (updatedWork !== 'updated') {
            abort(appConflict('agent_mission_quote_line_work', 'stale_revision'));
          }
          const updatedMission = await transaction.missions.updateCas({
            mission: patched.value.mission,
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
            transition: patched.value,
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
          const view = toAgentMissionView(patched.value.mission, now);
          if (!view.ok) abort(view.error);
          return {
            kind: 'success',
            output: {
              outcome: 'patched',
              pendingLineId: head.id,
              workRevisionAfter: nextWork.revision,
              mission: view.value,
            } satisfies PatchQuoteAgentMissionLineOutput,
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
      if (cause instanceof PatchQuoteAgentMissionLineAbort) {
        return err(cause.appError);
      }
      throw cause;
    }
  }
}
