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
  type AgentMissionQuoteLineCandidateV1,
  type NormalizedAgentMissionQuoteLineCandidateV1,
  normalizeAgentMissionQuoteLineCandidate,
} from './quote-line-candidate';
import {
  consumeCatalogueChoiceOnQuoteLineWork,
  invalidateCatalogueChoiceOnQuoteLineWork,
  type AgentMissionQuoteLineCatalogueChoiceResolution,
  type AgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWorkTransitionResult,
} from './quote-line-work';
import {
  stageQuoteAgentMissionLinesInTransaction,
} from './stage-quote-agent-mission-lines';

const INT4_MAX = 2_147_483_647;

export interface DecideQuoteAgentMissionCatalogueChoiceInput extends AgentMissionOwner {
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
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly choiceId: string;
  readonly additionalLines: readonly AgentMissionQuoteLineCandidateV1[];
}

export interface DecideQuoteAgentMissionCatalogueChoiceOutput {
  readonly outcome: 'selected' | 'invalidated' | 'replayed';
  readonly resolution: 'free' | 'selected' | null;
  readonly invalidationReason: 'candidate_unavailable' | 'choice_set_stale' | null;
  readonly mission: AgentMissionViewV1;
}

export interface DecideQuoteAgentMissionCatalogueChoiceDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class DecideQuoteAgentMissionCatalogueChoiceAbort extends Error {
  constructor(readonly appError: AppError) {
    super('decide-quote-agent-mission-catalogue-choice-abort');
  }
}

function abort(error: AppError): never {
  throw new DecideQuoteAgentMissionCatalogueChoiceAbort(error);
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

function normalizeAdditionalLines(
  lines: unknown,
): Result<readonly NormalizedAgentMissionQuoteLineCandidateV1[], AppError> {
  if (!Array.isArray(lines) || lines.length > 20) {
    return err(validation('additionalLines', 'Vingt lignes supplémentaires maximum.'));
  }
  const normalized: NormalizedAgentMissionQuoteLineCandidateV1[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = normalizeAgentMissionQuoteLineCandidate(lines[index]);
    if (!parsed.ok) {
      return err(validation(
        `additionalLines[${index}].${parsed.error.field}`,
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

export function canonicalDecideQuoteAgentMissionCatalogueChoiceCommand(input: {
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
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly choiceId: string;
  readonly normalizedAdditionalLines:
    readonly NormalizedAgentMissionQuoteLineCandidateV1[];
}): string {
  const correlation = input.origin.correlation;
  return JSON.stringify([
    'bob.agent-mission.command.catalogue-choice.v1',
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
      input.pendingLineId,
      input.expectedWorkRevision,
      input.choiceId,
    ],
    input.normalizedAdditionalLines.map(canonicalLine),
  ]);
}

function slotMatches(
  slot: AgentMissionQuoteDraftSlot,
  mission: AgentMission,
  input: Pick<
    DecideQuoteAgentMissionCatalogueChoiceInput,
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

function replayOutput(
  snapshot: AgentMissionEventSnapshot,
  mission: AgentMissionViewV1,
): DecideQuoteAgentMissionCatalogueChoiceOutput {
  if (
    snapshot.eventType === 'catalogue_choice_selected'
    && snapshot.data.kind === 'catalogue_choice_selected'
  ) {
    return {
      outcome: 'replayed',
      resolution: snapshot.data.resolution,
      invalidationReason: null,
      mission,
    };
  }
  if (
    snapshot.eventType === 'decision_invalidated'
    && snapshot.data.kind === 'decision_invalidated'
    && (
      snapshot.data.reason === 'candidate_unavailable'
      || snapshot.data.reason === 'choice_set_stale'
    )
  ) {
    return {
      outcome: 'replayed',
      resolution: null,
      invalidationReason: snapshot.data.reason,
      mission,
    };
  }
  abort({
    kind: 'dependency',
    port: 'agent_mission_event',
    cause: 'invalid_catalogue_choice_receipt',
  });
}

export class DecideQuoteAgentMissionCatalogueChoice {
  constructor(private readonly deps: DecideQuoteAgentMissionCatalogueChoiceDeps) {}

  async execute(
    input: DecideQuoteAgentMissionCatalogueChoiceInput,
  ): Promise<Result<DecideQuoteAgentMissionCatalogueChoiceOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return err(validation('identity', 'Identité mission invalide.'));
    }
    if (
      !isCanonicalAgentMissionUuid(input.missionId)
      || !isCanonicalAgentMissionUserCommandId(input.commandId)
      || !isCanonicalAgentMissionUuid(input.decisionId)
      || !isCanonicalAgentMissionUuid(input.pendingLineId)
      || !isCanonicalAgentMissionUuid(input.choiceId)
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
      || !isCanonicalAgentMissionDraftSessionId(input.expectedDraftSessionId)
    ) {
      return err(validation('fences', 'Révisions de décision invalides.'));
    }
    if (!isCanonicalAgentMissionUserCommandOrigin(input.origin)) {
      return err(validation('origin', 'Provenance de commande invalide.'));
    }
    if (input.authority.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    const normalizedAdditionalLines = normalizeAdditionalLines(input.additionalLines);
    if (!normalizedAdditionalLines.ok) return normalizedAdditionalLines;
    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const canonical = canonicalDecideQuoteAgentMissionCatalogueChoiceCommand({
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
      pendingLineId: input.pendingLineId,
      expectedWorkRevision: input.expectedWorkRevision,
      choiceId: input.choiceId,
      normalizedAdditionalLines: normalizedAdditionalLines.value,
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
                snapshot.eventType !== 'catalogue_choice_selected'
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
                cause: 'catalogue_choice_event_without_mission',
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
          if (mission.phase !== 'awaiting_catalogue_choice') {
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
            || head.state !== 'awaiting_catalogue_choice'
            || head.catalogueResolution !== 'pending'
          ) {
            abort(appConflict('agent_mission_quote_line_work', 'choice_set_stale'));
          }
          const decision = mission.payload.decision;
          if (
            decision?.kind !== 'catalogue'
            || decision.decisionId !== input.decisionId
            || decision.choiceSetRevision !== input.choiceSetRevision
            || decision.pendingLineId !== input.pendingLineId
            || decision.expectedWorkRevision !== input.expectedWorkRevision
          ) {
            abort(appConflict('agent_mission', 'choice_set_stale'));
          }

          const selectedCandidate = decision.candidates.find(
            (candidate) => candidate.choiceId === input.choiceId,
          );
          const isFree = decision.freeLineChoiceId === input.choiceId;
          if (!isFree && selectedCandidate === undefined) {
            abort(appConflict('agent_mission', 'choice_not_presented'));
          }

          let invalidationReason:
            | 'candidate_unavailable'
            | 'choice_set_stale'
            | null = null;
          let observedResolution:
            | { readonly kind: 'free' }
            | {
                readonly kind: 'selected';
                readonly catalogueItemId: string;
                readonly catalogueRevision: number;
              };
          if (isFree) {
            observedResolution = { kind: 'free' };
          } else {
            const candidate = selectedCandidate as NonNullable<typeof selectedCandidate>;
            const catalogue = await transaction.catalogueCandidates.getById({
              companyId: owner.companyId,
              id: candidate.catalogueItemId,
            });
            if (catalogue === null) {
              invalidationReason = 'candidate_unavailable';
              observedResolution = { kind: 'free' };
            } else if (catalogue.revision !== candidate.expectedCatalogueRevision) {
              invalidationReason = 'choice_set_stale';
              observedResolution = { kind: 'free' };
            } else {
              observedResolution = {
                kind: 'selected',
                catalogueItemId: catalogue.id,
                catalogueRevision: catalogue.revision,
              };
            }
          }

          let nextWork: AgentMissionQuoteLineWork;
          let transition;
          let output: Omit<
            DecideQuoteAgentMissionCatalogueChoiceOutput,
            'mission'
          >;
          if (invalidationReason !== null) {
            nextWork = workTransitionValue(invalidateCatalogueChoiceOnQuoteLineWork({
              workItem: head,
              expectedRevision: head.revision,
              occurredAt: now,
            }));
            const invalidated = mission.invalidateCatalogueDecision({
              expectedRevision: mission.revision,
              reason: invalidationReason,
              occurredAt: now,
            });
            if (!invalidated.ok) abort(agentMissionDomainError(invalidated.error));
            transition = invalidated.value;
            output = {
              outcome: 'invalidated',
              resolution: null,
              invalidationReason,
            };
          } else {
            const selected = mission.selectCatalogueChoice({
              expectedRevision: mission.revision,
              decisionId: input.decisionId,
              choiceSetRevision: input.choiceSetRevision,
              choiceId: input.choiceId,
              pendingLineId: input.pendingLineId,
              expectedWorkRevision: input.expectedWorkRevision,
              observedDraft: {
                sessionId: slot.payload.draft.sessionId,
                slotRevision: slot.revision,
                contentRevision: slot.payload.draft.contentRevision,
              },
              observedResolution,
              workRevisionAfter: head.revision + 1,
              occurredAt: now,
            });
            if (!selected.ok) abort(agentMissionDomainError(selected.error));
            const workResolution: AgentMissionQuoteLineCatalogueChoiceResolution =
              selected.value.resolution.kind === 'free'
                ? { kind: 'free' }
                : {
                    kind: 'selected',
                    catalogueItemId: selected.value.resolution.catalogueItemId,
                    expectedCatalogueRevision:
                      selected.value.resolution.expectedCatalogueRevision,
                  };
            nextWork = workTransitionValue(consumeCatalogueChoiceOnQuoteLineWork({
              workItem: head,
              expectedRevision: head.revision,
              resolution: workResolution,
              occurredAt: now,
            }));
            transition = selected.value.transition;
            output = {
              outcome: 'selected',
              resolution: selected.value.resolution.kind,
              invalidationReason: null,
            };
          }

          // « Le premier, puis ajoute le déplacement » est une seule commande utilisateur.
          // Une invalidation catalogue ne doit jamais acquitter le choix en perdant sa suite :
          // les lignes additionnelles sont donc staged dans la même transaction, quel que soit
          // le résultat du choix. L'item obsolète reste pending et sera recherché de nouveau.
          if (input.additionalLines.length > 0) {
            const additionallyStaged = await stageQuoteAgentMissionLinesInTransaction({
              transaction,
              owner,
              mission,
              candidates: input.additionalLines,
              origin: input.origin.actor,
              occurredAt: now,
              ids: this.deps.ids,
            });
            if (!additionallyStaged.ok) abort(additionallyStaged.error);
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
          const view = toAgentMissionView(transition.mission, now);
          if (!view.ok) abort(view.error);
          return {
            kind: 'success',
            output: {
              ...output,
              mission: view.value,
            } satisfies DecideQuoteAgentMissionCatalogueChoiceOutput,
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
      if (cause instanceof DecideQuoteAgentMissionCatalogueChoiceAbort) {
        return err(cause.appError);
      }
      throw cause;
    }
  }
}
