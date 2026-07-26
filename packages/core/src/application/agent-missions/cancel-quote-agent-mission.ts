import { type Result, err, ok } from '../../shared-kernel/result';
import { isCanonicalAgentMissionUserCommandId } from '../../domain/agent/agent-mission-event';
import { type IdGeneratorPort } from '../ports/services';
import { type AgentMissionFingerprintPort } from '../ports/agent-mission-fingerprint';
import { type AgentMissionOwner } from '../ports/agent-mission-repository';
import { type AgentMissionUnitOfWorkPort } from '../ports/agent-mission-unit-of-work';
import { type AppError, appConflict } from '../result';
import {
  agentMissionDomainError,
  canonicalAgentMissionCommand,
  draftReferenceForMission,
  expireAgentMissionInTransaction,
  isCanonicalAgentMissionOwner,
  isCanonicalAgentMissionUuid,
  missingAgentMission,
  recordAgentMissionEvent,
  requireAgentMissionFingerprint,
  toAgentMissionView,
  unavailableAgentMissionCompany,
  verifyAgentMissionFingerprint,
  type AgentMissionViewV1,
} from './agent-mission-application';

export interface CancelQuoteAgentMissionInput extends AgentMissionOwner {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly reason: 'user_cancelled' | 'manual_handoff';
  /**
   * M1-A ne possède pas encore de tuple Realtime non forgeable. Le canal vocal sera ajouté avec
   * sa corrélation session/turn/contexte ; cette tranche accepte seulement le tap authentifié.
   */
  readonly actor: 'user_tap';
}

export interface CancelQuoteAgentMissionOutput {
  readonly outcome: 'cancelled' | 'replayed';
  readonly mission: AgentMissionViewV1;
}

export interface CancelQuoteAgentMissionDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}

class CancelQuoteAgentMissionAbort extends Error {
  constructor(readonly appError: AppError) {
    super('cancel-quote-agent-mission-abort');
  }
}

function abort(error: AppError): never {
  throw new CancelQuoteAgentMissionAbort(error);
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647;
}

export class CancelQuoteAgentMission {
  constructor(private readonly deps: CancelQuoteAgentMissionDeps) {}

  async execute(
    input: CancelQuoteAgentMissionInput,
  ): Promise<Result<CancelQuoteAgentMissionOutput, AppError>> {
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
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'commandId', message: 'UUID v4 canonique requis.' }],
      });
    }
    if (!isRevision(input.expectedRevision)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision positive requise.' }],
      });
    }
    if (
      (input.reason !== 'user_cancelled' && input.reason !== 'manual_handoff')
      || input.actor !== 'user_tap'
    ) {
      return err({
        kind: 'validation',
        issues: [{ field: 'command', message: 'Commande d’annulation invalide.' }],
      });
    }

    const owner: AgentMissionOwner = {
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
    };
    const canonical = canonicalAgentMissionCommand({
      ...owner,
      operation: 'cancel_quote_creation',
      commandId: input.commandId,
      missionId: input.missionId,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
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
          if (snapshot.eventType !== 'mission_cancelled' || snapshot.missionId !== input.missionId) {
            abort(appConflict('agent_mission_command', 'already_used'));
          }
          const verified = verifyAgentMissionFingerprint(
            this.deps.fingerprints,
            canonical,
            snapshot,
          );
          if (!verified.ok) abort(verified.error);
          if (!verified.value) abort(appConflict('agent_mission_command', 'fingerprint_mismatch'));
          const replayedMission = await transaction.missions.findById({
            ...owner,
            missionId: input.missionId,
          });
          if (replayedMission === null) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_repository',
              cause: 'cancel_event_without_mission',
            });
          }
          const replayedView = toAgentMissionView(replayedMission, now);
          if (!replayedView.ok) abort(replayedView.error);
          return {
            kind: 'success',
            output: {
              outcome: 'replayed',
              mission: replayedView.value,
            } satisfies CancelQuoteAgentMissionOutput,
          } as const;
        }

        const mission = await transaction.missions.findByIdForUpdate({
          ...owner,
          missionId: input.missionId,
        });
        if (mission === null) abort(missingAgentMission(input.missionId));
        // Une réponse HTTP peut être perdue après le commit de l'expiration paresseuse. Le retry
        // exact doit rendre le même conflit `expired`, sans tenter une seconde transition sur
        // l'agrégat déjà terminal.
        if (mission.status === 'expired') return { kind: 'expired' } as const;
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
          return { kind: 'expired' } as const;
        }

        const fingerprint = requireAgentMissionFingerprint(this.deps.fingerprints, canonical);
        if (!fingerprint.ok) abort(fingerprint.error);
        const reference = draftReferenceForMission(mission);
        const cancelled = mission.cancel({
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          occurredAt: now,
        });
        if (!cancelled.ok) abort(agentMissionDomainError(cancelled.error));
        const updated = await transaction.missions.updateCas({
          mission: cancelled.value.mission,
          expectedRevision: input.expectedRevision,
        });
        if (updated !== 'updated') abort(appConflict('agent_mission', 'stale_revision'));
        if (mission.payload.draft !== null) {
          const released = await transaction.quoteDrafts.release({
            ...owner,
            missionId: mission.id,
          });
          if (!released) {
            abort({
              kind: 'dependency',
              port: 'agent_mission_quote_draft',
              cause: 'owned_slot_release_failed',
            });
          }
        }
        const event = recordAgentMissionEvent({
          owner,
          transition: cancelled.value,
          actor: input.actor,
          commandId: input.commandId,
          fingerprint: fingerprint.value,
          ids: this.deps.ids,
          draftBefore: reference,
          draftAfter: reference,
        });
        if (!event.ok) abort(event.error);
        await transaction.events.append(event.value);
        const view = toAgentMissionView(cancelled.value.mission, now);
        if (!view.ok) abort(view.error);
        return {
          kind: 'success',
          output: {
            outcome: 'cancelled',
            mission: view.value,
          } satisfies CancelQuoteAgentMissionOutput,
        } as const;
        },
      );
      if (execution.status === 'company_unavailable') {
        return err(unavailableAgentMissionCompany(execution.reason));
      }
      const result = execution.value;
      return result.kind === 'expired'
        ? err(appConflict('agent_mission', 'expired'))
        : ok(result.output);
    } catch (cause) {
      if (cause instanceof CancelQuoteAgentMissionAbort) return err(cause.appError);
      throw cause;
    }
  }
}
