import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AcknowledgeQuoteScreen,
  AdvanceQuoteAgentMission,
  CancelQuoteAgentMission,
  ContinueQuoteAgentMissionLineQueue,
  DecideQuoteAgentMissionCatalogueChoice,
  DecideQuoteAgentMission,
  GetActiveAgentMission,
  GetResumableQuoteAgentMission,
  StageQuoteAgentMissionLines,
  StartQuoteAgentMission,
  appUnavailable,
  deriveAgentMissionSystemCommandId,
  err,
  type AgentMissionFingerprintPort,
  type AgentMissionQuoteLineCandidateV1,
  type AgentMissionReadExecution,
  type AgentMissionReadTransaction,
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type AgentMissionWriteExecution,
  type AgentMissionViewV1,
  type AcknowledgeQuoteScreenOutput,
  type AppError,
  type CancelQuoteAgentMissionOutput,
  type ContinueQuoteAgentMissionLineQueueOutput,
  type DecideQuoteAgentMissionCatalogueChoiceOutput,
  type DecideQuoteAgentMissionOutput,
  type QuoteAgentMissionCustomerDecision,
  type Result,
  type QuoteAgentMissionResumeView,
  type StageQuoteAgentMissionLinesOutput,
  type StartQuoteAgentMissionOutput,
} from '@bob/core';
import { AppLogger, getPrincipal } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { AGENT_MISSION_FINGERPRINTS } from './agent-mission-fingerprint.provider';
import type { AgentMissionHttpAuthorization } from './agent-mission-http-authority';
import type { AgentMissionCapabilityMetricOperation } from './agent-mission-http-authority';

export type AgentMissionServiceAuthorization = Readonly<
Pick<AgentMissionHttpAuthorization, 'owner' | 'proof'>
>;

export interface StageQuoteAgentMissionLinesServiceOutput
extends Omit<StageQuoteAgentMissionLinesOutput, 'mission'> {
  readonly mission: AgentMissionViewV1;
  readonly continuation: Omit<ContinueQuoteAgentMissionLineQueueOutput, 'mission'>;
}

export interface DecideQuoteAgentMissionCatalogueChoiceServiceOutput
extends Omit<DecideQuoteAgentMissionCatalogueChoiceOutput, 'mission'> {
  readonly mission: AgentMissionViewV1;
  readonly continuation: Omit<ContinueQuoteAgentMissionLineQueueOutput, 'mission'>;
}

function observeBoundedUnitOfWorkOutcome<T>(
  execution: AgentMissionReadExecution<T> | AgentMissionWriteExecution<T>,
  metrics: Pick<
  Metrics,
  'agentMissionCapabilityRejections' | 'agentMissionForegroundContentions'
  >,
  logger: Pick<AppLogger, 'warn'>,
  operation: AgentMissionCapabilityMetricOperation,
): void {
  if (execution.status === 'capability_rejected') {
    metrics.agentMissionCapabilityRejections.inc({
      operation,
      reason: execution.reason,
    });
  }
  if (execution.status === 'foreground_unavailable') {
    metrics.agentMissionForegroundContentions.inc({
      operation,
      reason: execution.reason,
    });
    logger.warn(
      `AgentMission foreground indisponible (${operation}/${execution.reason}).`,
      'AgentMissionService',
    );
  }
}

function instrumentAgentMissionCapabilityRejections(
  delegate: AgentMissionUnitOfWorkPort,
  metrics: Pick<
  Metrics,
  'agentMissionCapabilityRejections' | 'agentMissionForegroundContentions'
  >,
  logger: Pick<AppLogger, 'warn'>,
  operation: AgentMissionCapabilityMetricOperation,
): AgentMissionUnitOfWorkPort {
  return {
    async readQuoteCreationOwner<T>(
      owner: AgentMissionHttpAuthorization['owner'],
      authority: AgentMissionRealtimeAuthorityProof,
      work: (transaction: AgentMissionReadTransaction) => Promise<T>,
    ): Promise<AgentMissionReadExecution<T>> {
      const execution = await delegate.readQuoteCreationOwner(owner, authority, work);
      observeBoundedUnitOfWorkOutcome(execution, metrics, logger, operation);
      return execution;
    },
    async runQuoteCreationOwner<T>(
      owner: AgentMissionHttpAuthorization['owner'],
      authority: AgentMissionRealtimeAuthorityProof,
      work: (transaction: AgentMissionTransaction) => Promise<T>,
    ): Promise<AgentMissionWriteExecution<T>> {
      const execution = await delegate.runQuoteCreationOwner(owner, authority, work);
      observeBoundedUnitOfWorkOutcome(execution, metrics, logger, operation);
      return execution;
    },
  };
}

type AgentMissionAuditReferenceKind = 'tenant' | 'owner' | 'mission';

function auditReference(
  fingerprints: AgentMissionFingerprintPort,
  kind: AgentMissionAuditReferenceKind,
  value: string,
): string | null {
  const fingerprint = fingerprints.sign(
    `bob.agent-mission.audit-reference.v1\u0000${kind}\u0000${value}`,
  );
  return fingerprint === null
    ? null
    : `amr1_${fingerprint.keyVersion}_${fingerprint.hmac}`;
}

function auditReferences(
  fingerprints: AgentMissionFingerprintPort,
  input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly missionId: string;
  },
): Readonly<Record<string, string>> {
  const tenantRef = auditReference(fingerprints, 'tenant', input.companyId);
  const ownerRef = auditReference(fingerprints, 'owner', input.ownerUserId);
  const missionRef = auditReference(fingerprints, 'mission', input.missionId);
  return Object.freeze({
    ...(tenantRef === null ? {} : { tenantRef }),
    ...(ownerRef === null ? {} : { ownerRef }),
    ...(missionRef === null ? {} : { missionRef }),
  });
}

type AgentMissionScreenAckMetricOutcome =
  | 'accepted'
  | 'replayed'
  | 'conflict'
  | 'context_stale'
  | 'draft_stale'
  | 'unavailable';

function agentMissionScreenAckMetricOutcome(
  result: Result<AcknowledgeQuoteScreenOutput, AppError>,
): AgentMissionScreenAckMetricOutcome {
  if (result.ok) {
    return result.value.outcome === 'acknowledged' ? 'accepted' : 'replayed';
  }
  if (
    result.error.kind === 'conflict'
    && result.error.entity === 'agent_mission_screen_ack'
    && (result.error.reason === 'context_stale' || result.error.reason === 'draft_stale')
  ) {
    return result.error.reason;
  }
  return result.error.kind === 'unavailable' || result.error.kind === 'dependency'
    ? 'unavailable'
    : 'conflict';
}

@Injectable()
export class AgentMissionService {
  constructor(
    @Inject(PERSISTENCE) private readonly persistence: Persistence,
    @Inject(AGENT_MISSION_FINGERPRINTS)
    private readonly fingerprints: AgentMissionFingerprintPort,
    @Inject(AppLogger)
    private readonly logger: AppLogger,
    @Inject(Metrics)
    private readonly metrics: Metrics,
  ) {}

  getCurrent(
    authorization: AgentMissionServiceAuthorization,
  ): Promise<Result<{ readonly mission: AgentMissionViewV1 | null }, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'get',
    );
    return new GetActiveAgentMission({ unitOfWork }).execute(
      authorization.owner,
      authorization.proof,
    )
      .then((result) => result.ok ? { ok: true, value: { mission: result.value } } : result);
  }

  async getCurrentResume(): Promise<
    Result<QuoteAgentMissionResumeView, AppError>
  > {
    const principal = getPrincipal();
    if (principal === undefined || principal.companyId === null) {
      return err({ kind: 'forbidden', reason: 'authenticated_owner_required' });
    }
    const unitOfWork = this.persistence.createAgentMissionResumeUnitOfWork();
    if (unitOfWork === null) {
      return err(appUnavailable('agent_mission_resume_persistence'));
    }
    try {
      return await new GetResumableQuoteAgentMission({ unitOfWork }).execute({
        companyId: principal.companyId,
        ownerUserId: principal.userId,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.name : 'UnknownError';
      this.logger.error(
        `Lecture de reprise AgentMission impossible (${cause}).`,
        undefined,
        'AgentMissionService',
      );
      return err(appUnavailable('agent_mission_resume_persistence'));
    }
  }

  start(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly commandId: string;
    readonly lines?: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<StartQuoteAgentMissionOutput, AppError>> {
    return this.executeStart({
      authorization: input.authorization,
      commandId: input.commandId,
      origin: { actor: 'user_tap', correlation: null },
      customerReference: null,
      lines: input.lines ?? [],
    });
  }

  startFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly realtimeSessionId: string;
    readonly turnId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly customerReference: string | null;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<StartQuoteAgentMissionOutput, AppError>> {
    return this.executeStart({
      authorization: input.authorization,
      // Une seule identité traverse compréhension, commande idempotente, événement et contrôle.
      commandId: input.turnId,
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: input.realtimeSessionId,
          turnId: input.turnId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
        },
      },
      customerReference: input.customerReference,
      lines: input.lines,
    });
  }

  private executeStart(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly commandId: string;
    readonly origin: Parameters<StartQuoteAgentMission['execute']>[0]['origin'];
    readonly customerReference: string | null;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<StartQuoteAgentMissionOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'start',
    );
    const useCase = new StartQuoteAgentMission({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    });
    const owner = input.authorization.owner;
    return useCase.execute({
      ...owner,
      authority: input.authorization.proof,
      commandId: input.commandId,
      origin: input.origin,
      customerReference: input.customerReference,
      lines: input.lines,
    }).then(async (result) => {
      if (result.ok && result.value.outcome === 'created') {
        this.logger.audit('agent_mission.started', {
          ...auditReferences(this.fingerprints, {
            companyId: owner.companyId,
            ownerUserId: owner.ownerUserId,
            missionId: result.value.mission.id,
          }),
          outcome: result.value.outcome,
          startOutcome: result.value.startOutcome,
        });
      }
      if (
        result.ok
        && input.authorization.proof.protocolVersion === 2
        && result.value.mission.status === 'active'
        && result.value.mission.phase === 'awaiting_lines'
      ) {
        const continued = await this.continueLineQueue({
          authorization: input.authorization,
          missionId: result.value.mission.id,
          parentCommandId: input.commandId,
        });
        if (!continued.ok) return continued;
        return {
          ok: true,
          value: Object.freeze({
            ...result.value,
            mission: continued.value.mission,
          }),
        };
      }
      return result;
    });
  }

  cancel(input: {
    readonly authorization: AgentMissionHttpAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly reason?: 'user_cancelled' | 'manual_handoff';
  }): Promise<Result<CancelQuoteAgentMissionOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'cancel',
    );
    const useCase = new CancelQuoteAgentMission({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    });
    const owner = input.authorization.owner;
    return useCase.execute({
      ...owner,
      authority: input.authorization.proof,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedRevision: input.expectedMissionRevision,
      reason: input.reason ?? 'user_cancelled',
      actor: 'user_tap',
    }).then((result) => {
      if (result.ok && result.value.outcome === 'cancelled') {
        this.logger.audit('agent_mission.cancelled', {
          ...auditReferences(this.fingerprints, {
            companyId: owner.companyId,
            ownerUserId: owner.ownerUserId,
            missionId: result.value.mission.id,
          }),
          outcome: result.value.outcome,
        });
      }
      return result;
    });
  }

  async acknowledgeScreen(input: {
    readonly authorization: AgentMissionHttpAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly realtimeSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly draftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
  }): Promise<Result<AcknowledgeQuoteScreenOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      this.metrics.agentMissionScreenAcks.inc({ outcome: 'unavailable' });
      return err(appUnavailable('agent_mission_persistence'));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'screen_ack',
    );
    const ids = { newId: () => randomUUID() };
    const useCase = new AcknowledgeQuoteScreen({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids,
    });
    const owner = input.authorization.owner;
    const acknowledged = await useCase.execute({
      ...owner,
      authority: input.authorization.proof,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedMissionRevision: input.expectedMissionRevision,
      realtimeSessionId: input.realtimeSessionId,
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
      draftSessionId: input.draftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
    });
    if (!acknowledged.ok) {
      this.metrics.agentMissionScreenAcks.inc({
        outcome: agentMissionScreenAckMetricOutcome(acknowledged),
      });
      return acknowledged;
    }

    const advanced = await new AdvanceQuoteAgentMission({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids,
    }).execute({
      ...owner,
      authority: input.authorization.proof,
      missionId: input.missionId,
      acknowledgementCommandId: acknowledged.value.receipt.ackCommandId,
    });
    if (!advanced.ok) {
      this.metrics.agentMissionScreenAcks.inc({
        outcome: agentMissionScreenAckMetricOutcome(advanced),
      });
      return advanced;
    }

    let mission = advanced.value.mission;
    let continuationOutcome: ContinueQuoteAgentMissionLineQueueOutput['outcome'] | null = null;
    if (
      input.authorization.proof.protocolVersion === 2
      && mission.status === 'active'
      && mission.phase === 'awaiting_lines'
    ) {
      const parentCommandId = advanced.value.outcome === 'superseded'
        ? (
            mission.revision === acknowledged.value.receipt.missionRevisionAfter
              ? acknowledged.value.receipt.ackCommandId
              : null
          )
        : deriveAgentMissionSystemCommandId({
            operation: 'consume_staged_customer_resolution',
            ...owner,
            missionId: input.missionId,
            acknowledgementMissionRevision:
              acknowledged.value.receipt.missionRevisionAfter,
          });
      if (parentCommandId !== null) {
        const continued = await this.continueLineQueue({
          authorization: input.authorization,
          missionId: input.missionId,
          parentCommandId,
        });
        if (!continued.ok) {
          this.metrics.agentMissionScreenAcks.inc({
            outcome: agentMissionScreenAckMetricOutcome(continued),
          });
          return continued;
        }
        mission = continued.value.mission;
        continuationOutcome = continued.value.outcome;
      }
    }

    const result: Result<AcknowledgeQuoteScreenOutput, AppError> = {
      ok: true,
      value: Object.freeze({
        ...acknowledged.value,
        mission,
      }),
    };
    this.metrics.agentMissionScreenAcks.inc({
      outcome: agentMissionScreenAckMetricOutcome(result),
    });
    if (acknowledged.value.outcome === 'acknowledged') {
      this.logger.audit('agent_mission.screen_acknowledged', {
        ...auditReferences(this.fingerprints, {
          companyId: owner.companyId,
          ownerUserId: owner.ownerUserId,
          missionId: result.value.mission.id,
        }),
        outcome: acknowledged.value.outcome,
        customerContinuationOutcome: advanced.value.outcome,
        lineContinuationOutcome: continuationOutcome,
        phase: result.value.mission.phase,
      });
    }
    return result;
  }

  decide(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decision: QuoteAgentMissionCustomerDecision;
    readonly lines?: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<DecideQuoteAgentMissionOutput, AppError>> {
    return this.executeDecision({
      ...input,
      origin: { actor: 'user_tap', correlation: null },
      lines: input.lines ?? [],
    });
  }

  decideFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly turnId: string;
    readonly realtimeSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decision: Exclude<
      QuoteAgentMissionCustomerDecision,
      { readonly action: 'select_screen_customer' }
    >;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<DecideQuoteAgentMissionOutput, AppError>> {
    return this.executeDecision({
      authorization: input.authorization,
      missionId: input.missionId,
      commandId: input.turnId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      decision: input.decision,
      lines: input.lines,
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: input.realtimeSessionId,
          turnId: input.turnId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
        },
      },
    });
  }

  private async executeDecision(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decision: QuoteAgentMissionCustomerDecision;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
    readonly origin: Parameters<DecideQuoteAgentMission['execute']>[0]['origin'];
  }): Promise<Result<DecideQuoteAgentMissionOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'decision',
    );
    const owner = input.authorization.owner;
    const result = await new DecideQuoteAgentMission({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    }).execute({
      ...owner,
      authority: input.authorization.proof,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      decision: input.decision,
      origin: input.origin,
      lines: input.lines,
    });
    if (result.ok && result.value.outcome !== 'replayed') {
      this.logger.audit('agent_mission.customer_decision', {
        ...auditReferences(this.fingerprints, {
          companyId: owner.companyId,
          ownerUserId: owner.ownerUserId,
          missionId: result.value.mission.id,
        }),
        actor: input.origin.actor,
        action: input.decision.action,
        outcome: result.value.outcome,
        phase: result.value.mission.phase,
      });
    }
    if (
      result.ok
      && input.authorization.proof.protocolVersion === 2
      && result.value.mission.status === 'active'
      && result.value.mission.phase === 'awaiting_lines'
    ) {
      const continued = await this.continueLineQueue({
        authorization: input.authorization,
        missionId: input.missionId,
        parentCommandId: input.commandId,
      });
      if (!continued.ok) return continued;
      return {
        ok: true,
        value: Object.freeze({
          ...result.value,
          mission: continued.value.mission,
        }),
      };
    }
    return result;
  }

  stageLines(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<StageQuoteAgentMissionLinesServiceOutput, AppError>> {
    return this.executeStageLines({
      ...input,
      origin: { actor: 'user_tap', correlation: null },
    });
  }

  stageLinesFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly turnId: string;
    readonly realtimeSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<Result<StageQuoteAgentMissionLinesServiceOutput, AppError>> {
    return this.executeStageLines({
      authorization: input.authorization,
      missionId: input.missionId,
      commandId: input.turnId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      lines: input.lines,
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: input.realtimeSessionId,
          turnId: input.turnId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
        },
      },
    });
  }

  private async executeStageLines(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
    readonly origin: Parameters<StageQuoteAgentMissionLines['execute']>[0]['origin'];
  }): Promise<Result<StageQuoteAgentMissionLinesServiceOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return err(appUnavailable('agent_mission_persistence'));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'line_stage',
    );
    const owner = input.authorization.owner;
    const staged = await new StageQuoteAgentMissionLines({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    }).execute({
      ...owner,
      authority: input.authorization.proof,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      lines: input.lines,
      origin: input.origin,
    });
    if (!staged.ok) return staged;
    const continued = await this.continueLineQueue({
      authorization: input.authorization,
      missionId: input.missionId,
      parentCommandId: input.commandId,
    });
    if (!continued.ok) return continued;
    if (staged.value.outcome !== 'replayed') {
      this.logger.audit('agent_mission.line_candidates_staged', {
        ...auditReferences(this.fingerprints, {
          companyId: owner.companyId,
          ownerUserId: owner.ownerUserId,
          missionId: input.missionId,
        }),
        actor: input.origin.actor,
        stagedCount: staged.value.stagedCount,
        continuationOutcome: continued.value.outcome,
      });
    }
    const {
      mission: _continuedMission,
      ...continuation
    } = continued.value;
    return {
      ok: true,
      value: Object.freeze({
        outcome: staged.value.outcome,
        mission: continued.value.mission,
        stagedCount: staged.value.stagedCount,
        firstQueueOrdinal: staged.value.firstQueueOrdinal,
        lastQueueOrdinal: staged.value.lastQueueOrdinal,
        continuation: Object.freeze(continuation),
      }),
    };
  }

  decideCatalogueChoice(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly choiceId: string;
    readonly additionalLines?: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<
  Result<DecideQuoteAgentMissionCatalogueChoiceServiceOutput, AppError>
  > {
    return this.executeCatalogueChoice({
      ...input,
      additionalLines: input.additionalLines ?? [],
      origin: { actor: 'user_tap', correlation: null },
    });
  }

  decideCatalogueChoiceFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly turnId: string;
    readonly realtimeSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly choiceId: string;
    readonly additionalLines: readonly AgentMissionQuoteLineCandidateV1[];
  }): Promise<
  Result<DecideQuoteAgentMissionCatalogueChoiceServiceOutput, AppError>
  > {
    return this.executeCatalogueChoice({
      authorization: input.authorization,
      missionId: input.missionId,
      commandId: input.turnId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      decisionId: input.decisionId,
      choiceSetRevision: input.choiceSetRevision,
      pendingLineId: input.pendingLineId,
      expectedWorkRevision: input.expectedWorkRevision,
      choiceId: input.choiceId,
      additionalLines: input.additionalLines,
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: input.realtimeSessionId,
          turnId: input.turnId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
        },
      },
    });
  }

  private async executeCatalogueChoice(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly choiceId: string;
    readonly additionalLines: readonly AgentMissionQuoteLineCandidateV1[];
    readonly origin: Parameters<
    DecideQuoteAgentMissionCatalogueChoice['execute']
    >[0]['origin'];
  }): Promise<
  Result<DecideQuoteAgentMissionCatalogueChoiceServiceOutput, AppError>
  > {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return err(appUnavailable('agent_mission_persistence'));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'catalogue_choice',
    );
    const owner = input.authorization.owner;
    const result = await new DecideQuoteAgentMissionCatalogueChoice({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    }).execute({
      ...owner,
      authority: input.authorization.proof,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      decisionId: input.decisionId,
      choiceSetRevision: input.choiceSetRevision,
      pendingLineId: input.pendingLineId,
      expectedWorkRevision: input.expectedWorkRevision,
      choiceId: input.choiceId,
      additionalLines: input.additionalLines,
      origin: input.origin,
    });
    if (result.ok && result.value.outcome !== 'replayed') {
      this.logger.audit('agent_mission.catalogue_choice', {
        ...auditReferences(this.fingerprints, {
          companyId: owner.companyId,
          ownerUserId: owner.ownerUserId,
          missionId: input.missionId,
        }),
        actor: input.origin.actor,
        outcome: result.value.outcome,
        resolution: result.value.resolution,
        invalidationReason: result.value.invalidationReason,
      });
    }
    if (!result.ok) return result;
    const continued = await this.continueLineQueue({
      authorization: input.authorization,
      missionId: input.missionId,
      parentCommandId: input.commandId,
    });
    if (!continued.ok) return continued;
    const {
      mission: _continuedMission,
      ...continuation
    } = continued.value;
    return {
      ok: true,
      value: Object.freeze({
        outcome: result.value.outcome,
        resolution: result.value.resolution,
        invalidationReason: result.value.invalidationReason,
        mission: continued.value.mission,
        continuation: Object.freeze(continuation),
      }),
    };
  }

  private async continueLineQueue(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly parentCommandId: string;
  }): Promise<Result<ContinueQuoteAgentMissionLineQueueOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return err(appUnavailable('agent_mission_persistence'));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'line_continuation',
    );
    return new ContinueQuoteAgentMissionLineQueue({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    }).execute({
      ...input.authorization.owner,
      authority: input.authorization.proof,
      missionId: input.missionId,
      parentCommandId: input.parentCommandId,
    });
  }
}
