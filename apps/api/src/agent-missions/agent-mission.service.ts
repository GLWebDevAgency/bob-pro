import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AcknowledgeQuoteScreen,
  AdvanceQuoteAgentMission,
  CancelQuoteAgentMission,
  DecideQuoteAgentMission,
  GetActiveAgentMission,
  GetResumableQuoteAgentMission,
  StartQuoteAgentMission,
  appUnavailable,
  err,
  type AgentMissionFingerprintPort,
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
  type DecideQuoteAgentMissionOutput,
  type QuoteAgentMissionCustomerDecision,
  type Result,
  type QuoteAgentMissionResumeView,
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

function observeCapabilityRejection<T>(
  execution: AgentMissionReadExecution<T> | AgentMissionWriteExecution<T>,
  metrics: Pick<Metrics, 'agentMissionCapabilityRejections'>,
  operation: AgentMissionCapabilityMetricOperation,
): void {
  if (execution.status === 'capability_rejected') {
    metrics.agentMissionCapabilityRejections.inc({
      operation,
      reason: execution.reason,
    });
  }
}

function instrumentAgentMissionCapabilityRejections(
  delegate: AgentMissionUnitOfWorkPort,
  metrics: Pick<Metrics, 'agentMissionCapabilityRejections'>,
  operation: AgentMissionCapabilityMetricOperation,
): AgentMissionUnitOfWorkPort {
  return {
    async readQuoteCreationOwner<T>(
      owner: AgentMissionHttpAuthorization['owner'],
      authority: AgentMissionRealtimeAuthorityProof,
      work: (transaction: AgentMissionReadTransaction) => Promise<T>,
    ): Promise<AgentMissionReadExecution<T>> {
      const execution = await delegate.readQuoteCreationOwner(owner, authority, work);
      observeCapabilityRejection(execution, metrics, operation);
      return execution;
    },
    async runQuoteCreationOwner<T>(
      owner: AgentMissionHttpAuthorization['owner'],
      authority: AgentMissionRealtimeAuthorityProof,
      work: (transaction: AgentMissionTransaction) => Promise<T>,
    ): Promise<AgentMissionWriteExecution<T>> {
      const execution = await delegate.runQuoteCreationOwner(owner, authority, work);
      observeCapabilityRejection(execution, metrics, operation);
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
  }): Promise<Result<StartQuoteAgentMissionOutput, AppError>> {
    return this.executeStart({
      authorization: input.authorization,
      commandId: input.commandId,
      origin: { actor: 'user_tap', correlation: null },
      customerReference: null,
    });
  }

  startFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly realtimeSessionId: string;
    readonly turnId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly customerReference: string | null;
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
    });
  }

  private executeStart(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly commandId: string;
    readonly origin: Parameters<StartQuoteAgentMission['execute']>[0]['origin'];
    readonly customerReference: string | null;
  }): Promise<Result<StartQuoteAgentMissionOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
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
    }).then((result) => {
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

    const result: Result<AcknowledgeQuoteScreenOutput, AppError> = {
      ok: true,
      value: Object.freeze({
        ...acknowledged.value,
        mission: advanced.value.mission,
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
        continuationOutcome: advanced.value.outcome,
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
  }): Promise<Result<DecideQuoteAgentMissionOutput, AppError>> {
    return this.executeDecision({
      ...input,
      origin: { actor: 'user_tap', correlation: null },
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

  private executeDecision(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decision: QuoteAgentMissionCustomerDecision;
    readonly origin: Parameters<DecideQuoteAgentMission['execute']>[0]['origin'];
  }): Promise<Result<DecideQuoteAgentMissionOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      'decision',
    );
    const owner = input.authorization.owner;
    return new DecideQuoteAgentMission({
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
    }).then((result) => {
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
      return result;
    });
  }
}
