import {
  AGENT_MISSION_PROTOCOL_M2A,
  AgentMission,
  type AgentMissionTransition,
  type QuoteMissionStagedCustomerResolutionV1,
  type QuoteMissionDraftReferenceV1,
} from '../../domain/agent/agent-mission';
import { isCanonicalAgentMissionUserCommandId } from '../../domain/agent/agent-mission-event';
import { type Result, err, ok } from '../../shared-kernel/result';
import {
  createEmptyQuoteDraftPayload,
  isMeaningfulQuoteDraftPayload,
  type QuoteDraftSlot,
} from '../quote-drafts/quote-draft-slot';
import { type IdGeneratorPort } from '../ports/services';
import { type AgentMissionFingerprintPort } from '../ports/agent-mission-fingerprint';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionUnitOfWorkPort,
} from '../ports/agent-mission-unit-of-work';
import {
  type AppError,
  appConflict,
} from '../result';
import {
  agentMissionDomainError,
  canonicalAgentMissionStartCommand,
  draftReferenceForMission,
  expireAgentMissionInTransaction,
  guardAgentMissionReplayForeground,
  isCanonicalAgentMissionOwner,
  isCanonicalAgentMissionUserCommandOrigin,
  recordAgentMissionEvent,
  resolveQuoteAgentMissionEventLookup,
  resolveQuoteAgentMissionLookup,
  requireAgentMissionFingerprint,
  toAgentMissionView,
  rejectedAgentMissionCapability,
  unavailableAgentMissionCompany,
  unavailableAgentMissionForeground,
  verifyAgentMissionFingerprint,
  type AgentMissionUserCommandOrigin,
  type AgentMissionViewV1,
} from './agent-mission-application';
import {
  isCanonicalCustomerReference,
  resolveCustomerReference,
} from './resolve-customer-reference';
import {
  type AgentMissionQuoteLineCandidateV1,
  type NormalizedAgentMissionQuoteLineCandidateV1,
  normalizeAgentMissionQuoteLineCandidate,
} from './quote-line-candidate';
import {
  stageQuoteAgentMissionLinesInTransaction,
} from './stage-quote-agent-mission-lines';

export interface StartQuoteAgentMissionCommand extends AgentMissionOwner {
  readonly commandId: string;
  readonly authority: AgentMissionRealtimeAuthorityProof;
  readonly origin: AgentMissionUserCommandOrigin;
  /**
   * Référence sémantique transitoire : liée au HMAC, résolue sous tenant, jamais persistée.
   * `null` signifie que le tour n'a pas nommé de client.
   */
  readonly customerReference: string | null;
  /**
   * Additif M2-A : optionnel pour préserver le writer V1. Toute ligne non vide exige le
   * protocole 2 et est insérée dans la transaction du start/join, jamais après coup.
   */
  readonly lines?: readonly AgentMissionQuoteLineCandidateV1[];
}

export interface StartQuoteAgentMissionOutput {
  readonly outcome: 'created' | 'joined_active' | 'replayed';
  readonly startOutcome: 'no_slot' | 'empty_slot_adopted' | 'draft_conflict' | null;
  readonly mission: AgentMissionViewV1;
}

export interface StartQuoteAgentMissionDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class StartQuoteAgentMissionAbort extends Error {
  constructor(readonly appError: AppError) {
    super('start-quote-agent-mission-abort');
  }
}

function abort(error: AppError): never {
  throw new StartQuoteAgentMissionAbort(error);
}

function draftReference(slot: QuoteDraftSlot): QuoteMissionDraftReferenceV1 {
  return {
    sessionId: slot.payload.draft.sessionId,
    slotRevision: slot.revision,
    contentRevision: slot.payload.draft.contentRevision,
  };
}

function transitionValue(
  transition: ReturnType<typeof AgentMission.start> | ReturnType<AgentMission['expire']>,
): AgentMissionTransition {
  if (!transition.ok) abort(agentMissionDomainError(transition.error));
  return transition.value;
}

function normalizeStartLines(
  input: unknown,
): Result<readonly NormalizedAgentMissionQuoteLineCandidateV1[], AppError> {
  if (!Array.isArray(input) || input.length > 20) {
    return err({
      kind: 'validation',
      issues: [{ field: 'lines', message: 'Vingt lignes maximum.' }],
    });
  }
  const normalized: NormalizedAgentMissionQuoteLineCandidateV1[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const parsed = normalizeAgentMissionQuoteLineCandidate(input[index]);
    if (!parsed.ok) {
      return err({
        kind: 'validation',
        issues: [{
          field: `lines[${index}].${parsed.error.field}`,
          message: `Ligne invalide (${parsed.error.reason}).`,
        }],
      });
    }
    normalized.push(parsed.value);
  }
  return ok(Object.freeze(normalized));
}

function canonicalStartLine(
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

export function canonicalAgentMissionStartCommandM2A(input: {
  readonly owner: AgentMissionOwner;
  readonly commandId: string;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly customerReference: string | null;
  readonly normalizedLines: readonly NormalizedAgentMissionQuoteLineCandidateV1[];
}): string {
  const correlation = input.origin.correlation;
  return JSON.stringify([
    'bob.agent-mission.command.start-quote.m2a.v1',
    input.owner.companyId,
    input.owner.ownerUserId,
    input.commandId,
    [
      input.origin.actor,
      correlation?.realtimeSessionId ?? null,
      input.origin.actor === 'user_voice' ? input.origin.correlation.turnId : null,
      correlation?.contextRevision ?? null,
      correlation?.contextDigest ?? null,
    ],
    input.customerReference,
    input.normalizedLines.map(canonicalStartLine),
  ]);
}

function sameDraftReference(
  slot: AgentMissionQuoteDraftSlot,
  reference: QuoteMissionDraftReferenceV1,
): boolean {
  return (
    slot.payload.draft.sessionId === reference.sessionId
    && slot.revision === reference.slotRevision
    && slot.payload.draft.contentRevision === reference.contentRevision
  );
}

export class StartQuoteAgentMission {
  constructor(private readonly deps: StartQuoteAgentMissionDeps) {}

  async execute(
    input: StartQuoteAgentMissionCommand,
  ): Promise<Result<StartQuoteAgentMissionOutput, AppError>> {
    if (!isCanonicalAgentMissionOwner(input)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'identity', message: 'Identité mission invalide.' }],
      });
    }
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'commandId', message: 'UUID v4 canonique requis.' }],
      });
    }
    if (!isCanonicalAgentMissionUserCommandOrigin(input.origin)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'origin', message: 'Provenance de commande invalide.' }],
      });
    }
    if (
      input.customerReference !== null
      && !isCanonicalCustomerReference(input.customerReference)
    ) {
      return err({
        kind: 'validation',
        issues: [{ field: 'customerReference', message: 'Référence client invalide.' }],
      });
    }
    const lines = normalizeStartLines(input.lines ?? []);
    if (!lines.ok) return lines;
    if (
      lines.value.length > 0
      && input.authority.protocolVersion !== AGENT_MISSION_PROTOCOL_M2A
    ) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const startCanonical = input.authority.protocolVersion === AGENT_MISSION_PROTOCOL_M2A
      ? canonicalAgentMissionStartCommandM2A({
          owner,
          commandId: input.commandId,
          origin: input.origin,
          customerReference: input.customerReference,
          normalizedLines: lines.value,
        })
      : canonicalAgentMissionStartCommand({
          ...owner,
          commandId: input.commandId,
          origin: input.origin,
          customerReference: input.customerReference,
        });

    try {
      const execution = await this.deps.unitOfWork.runQuoteCreationOwner(
        owner,
        input.authority,
        async (transaction) => {
        const now = await transaction.databaseNow();
        if (input.origin.correlation !== null) {
          const appliedContext = transaction.realtime.appliedContext;
          if (
            transaction.realtime.realtimeSessionId
              !== input.origin.correlation.realtimeSessionId
            || appliedContext === null
            || appliedContext.revision !== input.origin.correlation.contextRevision
            || appliedContext.digest !== input.origin.correlation.contextDigest
          ) {
            abort(appConflict('agent_mission_command', 'context_stale'));
          }
        }
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
            snapshot.eventType !== 'mission_started'
            && snapshot.eventType !== 'mission_joined'
          ) {
            abort(appConflict('agent_mission_command', 'already_used'));
          }
          const verified = verifyAgentMissionFingerprint(
            this.deps.fingerprints,
            startCanonical,
            snapshot,
          );
          if (!verified.ok) abort(verified.error);
          if (!verified.value) abort(appConflict('agent_mission_command', 'fingerprint_mismatch'));
          const missionLookup = await transaction.missions.findById({
            ...owner,
            missionId: snapshot.missionId,
          });
          const missionResult = resolveQuoteAgentMissionLookup(missionLookup);
          if (!missionResult.ok) abort(missionResult.error);
          const mission = missionResult.value;
          if (mission === null) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_repository',
              cause: 'creator_event_without_mission',
            });
          }
          const replayGuard = await guardAgentMissionReplayForeground({
            transaction,
            owner,
            replayedMissionId: mission.id,
          });
          if (!replayGuard.ok) abort(replayGuard.error);
          const view = toAgentMissionView(mission, now);
          if (!view.ok) abort(view.error);
          return {
            outcome: 'replayed',
            startOutcome: snapshot.data.kind === 'mission_started'
              ? snapshot.data.startOutcome
              : null,
            mission: view.value,
          } satisfies StartQuoteAgentMissionOutput;
        }

        const foreground = await transaction.missions.findForegroundForUpdate(owner);
        if (foreground !== null && foreground.status !== 'known') {
          abort(foreground.status === 'unsupported_protocol'
            ? appConflict('agent_mission_protocol', 'upgrade_required')
            : appConflict('agent_mission_foreground', 'active_mission_exists'));
        }
        const active = foreground?.mission ?? null;
        if (active !== null) {
          const expired = active.isExpiredAt(now);
          if (!expired.ok) abort(agentMissionDomainError(expired.error));
          if (!expired.value) {
            const reference = draftReferenceForMission(active);
            const observedSlot = await transaction.quoteDrafts.getForUpdate(owner);
            const expectedOwnedByMission = active.payload.draft !== null;
            if (
              observedSlot === null
              || !sameDraftReference(observedSlot, reference)
              || (
                expectedOwnedByMission
                  ? observedSlot.agentMissionId !== active.id
                  : observedSlot.agentMissionId !== null
              )
            ) {
              abort({
                kind: 'dependency',
                port: 'agent_mission_quote_draft',
                cause: 'active_mission_draft_binding_mismatch',
              });
            }
            let stagedCustomerResolution: QuoteMissionStagedCustomerResolutionV1 | null = null;
            if (input.customerReference !== null) {
              const resolved = await resolveCustomerReference({
                companyId: owner.companyId,
                query: input.customerReference,
                customers: transaction.customers,
                ids: this.deps.ids,
              });
              if (!resolved.ok) abort(resolved.error);
              stagedCustomerResolution = resolved.value;
            }
            const fingerprint = requireAgentMissionFingerprint(
              this.deps.fingerprints,
              startCanonical,
            );
            if (!fingerprint.ok) abort(fingerprint.error);
            const joined = transitionValue(active.joinActive({
              expectedRevision: active.revision,
              stagedCustomerResolution,
              occurredAt: now,
            }));
            if (lines.value.length > 0) {
              const staged = await stageQuoteAgentMissionLinesInTransaction({
                transaction,
                owner,
                mission: active,
                confirmedLineCount: observedSlot.payload.draft.lines.length,
                candidates: input.lines ?? [],
                origin: input.origin.actor,
                occurredAt: now,
                ids: this.deps.ids,
              });
              if (!staged.ok) abort(staged.error);
            }
            const updated = await transaction.missions.updateCas({
              mission: joined.mission,
              expectedRevision: active.revision,
            });
            if (updated !== 'updated') {
              abort(appConflict('agent_mission', 'stale_revision'));
            }
            const event = recordAgentMissionEvent({
              owner,
              transition: joined,
              actor: input.origin.actor,
              commandId: input.commandId,
              fingerprint: fingerprint.value,
              ids: this.deps.ids,
              draftBefore: reference,
              draftAfter: reference,
              ...(input.origin.correlation === null
                ? {}
                : {
                    correlation: {
                      ...input.origin.correlation,
                      turnId: input.origin.actor === 'user_voice'
                        ? input.origin.correlation.turnId
                        : null,
                    },
                  }),
            });
            if (!event.ok) abort(event.error);
            await transaction.events.append(event.value);
            const view = toAgentMissionView(joined.mission, now);
            if (!view.ok) abort(view.error);
            return {
              outcome: 'joined_active',
              startOutcome: null,
              mission: view.value,
            } satisfies StartQuoteAgentMissionOutput;
          }
          const terminalized = await expireAgentMissionInTransaction({
            transaction,
            owner,
            mission: active,
            occurredAt: now,
            fingerprints: this.deps.fingerprints,
            ids: this.deps.ids,
          });
          if (!terminalized.ok) abort(terminalized.error);
        }

        const observedSlot = await transaction.quoteDrafts.getForUpdate(owner);
        if (observedSlot !== null && observedSlot.agentMissionId !== null) {
          abort({
            kind: 'dependency',
            port: 'agent_mission_quote_draft',
            cause: 'slot_owned_without_active_mission',
          });
        }

        let slot: AgentMissionQuoteDraftSlot;
        let startOutcome: Exclude<StartQuoteAgentMissionOutput['startOutcome'], null>;
        if (observedSlot === null) {
          const payload = createEmptyQuoteDraftPayload(this.deps.ids.newId());
          if (!payload.ok) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_quote_draft',
              cause: `${payload.error.code}:${payload.error.path}`,
            });
          }
          const created = await transaction.quoteDrafts.create({ ...owner, payload: payload.value });
          if (created === null) abort(appConflict('quote_draft_slot', 'concurrent_create'));
          slot = created;
          startOutcome = 'no_slot';
        } else {
          slot = observedSlot;
          startOutcome = isMeaningfulQuoteDraftPayload(slot.payload)
            ? 'draft_conflict'
            : 'empty_slot_adopted';
        }
        let stagedCustomerResolution: QuoteMissionStagedCustomerResolutionV1 | null = null;
        if (input.customerReference !== null) {
          const resolved = await resolveCustomerReference({
            companyId: owner.companyId,
            query: input.customerReference,
            customers: transaction.customers,
            ids: this.deps.ids,
          });
          if (!resolved.ok) abort(resolved.error);
          stagedCustomerResolution = resolved.value;
        }

        const missionId = this.deps.ids.newId();
        const started = startOutcome === 'draft_conflict'
          ? AgentMission.start({
              id: missionId,
              ...owner,
              protocolVersion: input.authority.protocolVersion,
              createdAt: now,
              stagedCustomerResolution,
              startOutcome,
              existingDraft: draftReference(slot),
              decision: {
                decisionId: this.deps.ids.newId(),
                resumeChoiceId: this.deps.ids.newId(),
                requestDiscardChoiceId: this.deps.ids.newId(),
              },
            })
          : AgentMission.start({
              id: missionId,
              ...owner,
              protocolVersion: input.authority.protocolVersion,
              createdAt: now,
              stagedCustomerResolution,
              startOutcome,
              draft: draftReference(slot),
            });
        const transition = transitionValue(started);
        const inserted = await transaction.missions.insert(transition.mission);
        if (inserted === 'conflict') {
          const racedForeground = await transaction.missions.findForegroundForUpdate(owner);
          if (racedForeground === null) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_repository',
              cause: 'insert_conflict_without_active_foreground',
            });
          }
          abort(appConflict('agent_mission_foreground', 'active_mission_exists'));
        }

        if (startOutcome !== 'draft_conflict') {
          const claimed = await transaction.quoteDrafts.claim({
            ...owner,
            missionId: transition.mission.id,
            expectedSlotRevision: slot.revision,
            expectedDraftSessionId: slot.payload.draft.sessionId,
          });
          if (claimed === null || claimed.agentMissionId !== transition.mission.id) {
            abort(appConflict('quote_draft_slot', 'claim_conflict'));
          }
          slot = claimed;
        }
        if (lines.value.length > 0) {
          const staged = await stageQuoteAgentMissionLinesInTransaction({
            transaction,
            owner,
            mission: transition.mission,
            confirmedLineCount: slot.payload.draft.lines.length,
            candidates: input.lines ?? [],
            origin: input.origin.actor,
            occurredAt: now,
            ids: this.deps.ids,
          });
          if (!staged.ok) abort(staged.error);
        }

        const fingerprint = requireAgentMissionFingerprint(
          this.deps.fingerprints,
          startCanonical,
        );
        if (!fingerprint.ok) abort(fingerprint.error);
        const event = recordAgentMissionEvent({
          owner,
          transition,
          actor: input.origin.actor,
          commandId: input.commandId,
          fingerprint: fingerprint.value,
          ids: this.deps.ids,
          draftBefore: startOutcome === 'no_slot' ? null : draftReference(slot),
          draftAfter: draftReference(slot),
          ...(input.origin.correlation === null
            ? {}
            : {
                correlation: {
                  ...input.origin.correlation,
                  turnId: input.origin.actor === 'user_voice'
                    ? input.origin.correlation.turnId
                    : null,
                },
              }),
        });
        if (!event.ok) abort(event.error);
        await transaction.events.append(event.value);

        const view = toAgentMissionView(transition.mission, now);
        if (!view.ok) abort(view.error);
        return {
          outcome: 'created',
          startOutcome,
          mission: view.value,
        } satisfies StartQuoteAgentMissionOutput;
        },
      );
      if (execution.status === 'company_unavailable') {
        return err(unavailableAgentMissionCompany(execution.reason));
      }
      if (execution.status === 'foreground_unavailable') {
        return err(unavailableAgentMissionForeground(execution.reason));
      }
      return execution.status === 'capability_rejected'
        ? err(rejectedAgentMissionCapability(execution.reason))
        : ok(execution.value);
    } catch (cause) {
      if (cause instanceof StartQuoteAgentMissionAbort) return err(cause.appError);
      throw cause;
    }
  }

}
