import {
  AGENT_MISSION_KIND,
  AgentMission,
  type AgentMissionTransition,
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
import { type AgentMissionUnitOfWorkPort } from '../ports/agent-mission-unit-of-work';
import {
  type AppError,
  appConflict,
} from '../result';
import {
  agentMissionDomainError,
  canonicalAgentMissionCommand,
  draftReferenceForMission,
  expireAgentMissionInTransaction,
  isCanonicalAgentMissionOwner,
  recordAgentMissionEvent,
  requireAgentMissionFingerprint,
  toAgentMissionView,
  unavailableAgentMissionCompany,
  verifyAgentMissionFingerprint,
  type AgentMissionViewV1,
} from './agent-mission-application';

export interface StartQuoteAgentMissionCommand extends AgentMissionOwner {
  readonly commandId: string;
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
    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const startCanonical = canonicalAgentMissionCommand({
      ...owner,
      operation: 'start_quote_creation',
      commandId: input.commandId,
    });

    try {
      const execution = await this.deps.unitOfWork.runQuoteCreationOwner(
        owner,
        async (transaction) => {
        const now = await transaction.databaseNow();
        const consumed = await transaction.events.findByCommandId({
          ...owner,
          commandId: input.commandId,
        });
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
          const mission = await transaction.missions.findById({
            ...owner,
            missionId: snapshot.missionId,
          });
          if (mission === null) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_repository',
              cause: 'creator_event_without_mission',
            });
          }
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

        const active = await transaction.missions.findActiveForUpdate({
          ...owner,
          kind: AGENT_MISSION_KIND,
        });
        if (active !== null) {
          const expired = active.isExpiredAt(now);
          if (!expired.ok) abort(agentMissionDomainError(expired.error));
          if (!expired.value) {
            const fingerprint = requireAgentMissionFingerprint(
              this.deps.fingerprints,
              startCanonical,
            );
            if (!fingerprint.ok) abort(fingerprint.error);
            const reference = draftReferenceForMission(active);
            const joined = transitionValue(active.joinActive({
              expectedRevision: active.revision,
              occurredAt: now,
            }));
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
              actor: 'user_tap',
              commandId: input.commandId,
              fingerprint: fingerprint.value,
              ids: this.deps.ids,
              draftBefore: reference,
              draftAfter: reference,
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

        const missionId = this.deps.ids.newId();
        const started = startOutcome === 'draft_conflict'
          ? AgentMission.start({
              id: missionId,
              ...owner,
              createdAt: now,
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
              createdAt: now,
              startOutcome,
              draft: draftReference(slot),
            });
        const transition = transitionValue(started);
        await transaction.missions.insert(transition.mission);

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

        const fingerprint = requireAgentMissionFingerprint(
          this.deps.fingerprints,
          startCanonical,
        );
        if (!fingerprint.ok) abort(fingerprint.error);
        const event = recordAgentMissionEvent({
          owner,
          transition,
          actor: 'user_tap',
          commandId: input.commandId,
          fingerprint: fingerprint.value,
          ids: this.deps.ids,
          draftBefore: startOutcome === 'no_slot' ? null : draftReference(slot),
          draftAfter: draftReference(slot),
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
      return execution.status === 'company_unavailable'
        ? err(unavailableAgentMissionCompany(execution.reason))
        : ok(execution.value);
    } catch (cause) {
      if (cause instanceof StartQuoteAgentMissionAbort) return err(cause.appError);
      throw cause;
    }
  }

}
