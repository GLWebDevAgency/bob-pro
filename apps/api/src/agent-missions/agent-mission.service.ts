import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AcknowledgeQuoteScreen,
  AdvanceQuoteAgentMission,
  CancelQuoteAgentMissionPendingLine,
  CancelQuoteAgentMission,
  ContinueQuoteAgentMissionLineQueue,
  ContinueQuoteAgentMissionLineResolution,
  DecideQuoteAgentMissionCatalogueChoice,
  DecideQuoteAgentMissionLineProposal,
  DecideQuoteAgentMission,
  GetActiveAgentMission,
  GetResumableQuoteAgentMission,
  GetResumableQuoteAgentMissionV2,
  PatchQuoteAgentMissionLine,
  StageQuoteAgentMissionLines,
  StartQuoteAgentMission,
  appConflict,
  appUnavailable,
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
  type CancelQuoteAgentMissionPendingLineOutput,
  type ContinueQuoteAgentMissionLineResolutionOutput,
  type ContinueQuoteAgentMissionLineQueueOutput,
  type DecideQuoteAgentMissionCatalogueChoiceOutput,
  type DecideQuoteAgentMissionLineProposalOutput,
  type DecideQuoteAgentMissionOutput,
  type AgentMissionQuoteLinePatchScope,
  type AgentMissionQuoteLinePatchV1,
  type AgentMissionQuoteLineRequiredFact,
  type QuoteAgentMissionCustomerDecision,
  type QuoteAgentMissionPlannerResumeV2,
  type QuoteAgentMissionPresentationV1,
  type QuoteAgentMissionResumeViewV2,
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
  readonly continuation: AgentMissionLineContinuationServiceOutput;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

export interface DecideQuoteAgentMissionCatalogueChoiceServiceOutput
extends Omit<DecideQuoteAgentMissionCatalogueChoiceOutput, 'mission'> {
  readonly mission: AgentMissionViewV1;
  readonly continuation: AgentMissionLineContinuationServiceOutput;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

export interface AcknowledgeQuoteScreenServiceOutputV2
extends AcknowledgeQuoteScreenOutput {
  readonly presentation: QuoteAgentMissionPresentationV1;
}

export interface GetCurrentQuoteAgentMissionServiceOutputV2 {
  readonly mission: AgentMissionViewV1 | null;
  readonly presentation: QuoteAgentMissionPresentationV1 | null;
}

export type DecideQuoteAgentMissionServiceOutputV2 =
DecideQuoteAgentMissionOutput & {
  readonly presentation: QuoteAgentMissionPresentationV1;
};

export interface AgentMissionLineContinuationServiceOutput {
  readonly outcome:
    | Exclude<
        ContinueQuoteAgentMissionLineQueueOutput['outcome'],
        'deferred_to_m2a2'
      >
    | Exclude<
        ContinueQuoteAgentMissionLineResolutionOutput['outcome'],
        'needs_catalogue_resolution'
      >;
  readonly pendingLineId: string | null;
  readonly presentedChoiceCount: number;
  readonly requiredFact: AgentMissionQuoteLineRequiredFact | null;
  readonly proposalId: string | null;
}

interface AgentMissionLineConvergenceOutput {
  readonly mission: AgentMissionViewV1;
  readonly continuation: AgentMissionLineContinuationServiceOutput;
}

export interface PatchQuoteAgentMissionLineServiceOutput {
  readonly outcome: 'patched' | 'replayed';
  readonly pendingLineId: string;
  readonly workRevisionAfter: number;
  readonly mission: AgentMissionViewV1;
  readonly continuation: AgentMissionLineContinuationServiceOutput;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

export interface CancelQuoteAgentMissionPendingLineServiceOutput
extends Omit<
  CancelQuoteAgentMissionPendingLineOutput,
  'mission' | 'commandReceipt'
> {
  readonly mission: AgentMissionViewV1;
  readonly continuation: AgentMissionLineContinuationServiceOutput;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

export interface DecideQuoteAgentMissionLineProposalServiceOutput
extends Omit<
  DecideQuoteAgentMissionLineProposalOutput,
  'mission' | 'commandReceipt'
> {
  readonly mission: AgentMissionViewV1;
  readonly continuation: AgentMissionLineContinuationServiceOutput;
  readonly presentation: QuoteAgentMissionPresentationV1;
}

const AGENT_MISSION_RESUME_V2_CAUSE_CODES = new Set([
  'AGENT_MISSION_DATABASE_CLOCK_UNAVAILABLE',
  'AGENT_MISSION_FOREGROUND_AMBIGUOUS',
  'AGENT_MISSION_PROTOCOL_VERSION_CORRUPT',
  'AGENT_MISSION_QUOTE_DRAFT_CORRUPT',
  'AGENT_MISSION_QUOTE_DRAFT_VERSION_OR_REVISION_CORRUPT',
  'AGENT_MISSION_QUOTE_LINE_WORK_ROW_CORRUPT',
  'AGENT_MISSION_QUOTE_VAT_CONTEXT_CORRUPT',
  'AGENT_MISSION_RESUME_CATALOGUE_INPUT_INVALID',
  'AGENT_MISSION_RESUME_CATALOGUE_ROW_CORRUPT',
  'AGENT_MISSION_ROW_CORRUPT',
] as const);

type AgentMissionResumeV2CauseCode =
  | 'AGENT_MISSION_DATABASE_CLOCK_UNAVAILABLE'
  | 'AGENT_MISSION_FOREGROUND_AMBIGUOUS'
  | 'AGENT_MISSION_PROTOCOL_VERSION_CORRUPT'
  | 'AGENT_MISSION_QUOTE_DRAFT_CORRUPT'
  | 'AGENT_MISSION_QUOTE_DRAFT_VERSION_OR_REVISION_CORRUPT'
  | 'AGENT_MISSION_QUOTE_LINE_WORK_ROW_CORRUPT'
  | 'AGENT_MISSION_QUOTE_VAT_CONTEXT_CORRUPT'
  | 'AGENT_MISSION_RESUME_CATALOGUE_INPUT_INVALID'
  | 'AGENT_MISSION_RESUME_CATALOGUE_ROW_CORRUPT'
  | 'AGENT_MISSION_ROW_CORRUPT'
  | 'unexpected_error';

function classifyAgentMissionResumeV2Failure(error: unknown): Readonly<{
  errorType: 'error' | 'non_error';
  causeCode: AgentMissionResumeV2CauseCode;
  port: 'agent_mission_resume_v2_persistence';
}> {
  const message = error instanceof Error ? error.message : '';
  const candidate = message.split(':', 1)[0] ?? '';
  const causeCode = AGENT_MISSION_RESUME_V2_CAUSE_CODES.has(
    candidate as Exclude<AgentMissionResumeV2CauseCode, 'unexpected_error'>,
  )
    ? candidate as Exclude<AgentMissionResumeV2CauseCode, 'unexpected_error'>
    : 'unexpected_error';
  return Object.freeze({
    errorType: error instanceof Error ? 'error' : 'non_error',
    causeCode,
    port: 'agent_mission_resume_v2_persistence',
  });
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

  async getCurrentV2(
    authorization: AgentMissionServiceAuthorization,
  ): Promise<Result<GetCurrentQuoteAgentMissionServiceOutputV2, AppError>> {
    if (authorization.proof.protocolVersion !== 2) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    const current = await this.getCurrent(authorization);
    if (!current.ok) return current;
    const mission = current.value.mission;
    if (mission !== null) {
      return this.attachCurrentLinePresentation(
        authorization.owner,
        Object.freeze({ mission }),
      );
    }
    const resumed = await this.readCurrentResumeV2(authorization.owner);
    if (!resumed.ok) return resumed;
    if (resumed.value.mission !== null || resumed.value.presentation !== null) {
      return err({
        kind: 'dependency',
        port: 'agent_mission_command_projection',
        cause: 'mission_changed_after_read',
      });
    }
    return {
      ok: true,
      value: Object.freeze({ mission: null, presentation: null }),
    };
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

  async getCurrentResumeV2(): Promise<
    Result<QuoteAgentMissionResumeViewV2, AppError>
  > {
    const principal = getPrincipal();
    if (principal === undefined || principal.companyId === null) {
      return err({ kind: 'forbidden', reason: 'authenticated_owner_required' });
    }
    return this.readCurrentResumeV2({
      companyId: principal.companyId,
      ownerUserId: principal.userId,
    });
  }

  /**
   * Projection interne du planner Realtime. Elle n'est exposée par aucun controller et ne remplace
   * jamais la vérification de capability de `getCurrentV2`; l'orchestrateur appelle les deux puis
   * exige leur cohérence avant de montrer au modèle des alias/libellés sans identifiants.
   */
  async getCurrentPlannerResumeV2(
    authorization: AgentMissionServiceAuthorization,
  ): Promise<Result<QuoteAgentMissionPlannerResumeV2, AppError>> {
    if (authorization.proof.protocolVersion !== 2) {
      return err(appConflict('agent_mission_protocol', 'upgrade_required'));
    }
    const unitOfWork = this.persistence.createAgentMissionResumeV2UnitOfWork();
    if (unitOfWork === null) {
      return err(appUnavailable('agent_mission_resume_v2_persistence'));
    }
    try {
      return await new GetResumableQuoteAgentMissionV2({
        unitOfWork,
      }).executeForPlanner(authorization.owner);
    } catch (error) {
      this.logger.error(
        'Lecture du contexte planner AgentMission V2 impossible.',
        undefined,
        'AgentMissionService',
        classifyAgentMissionResumeV2Failure(error),
      );
      return err(appUnavailable('agent_mission_resume_v2_persistence'));
    }
  }

  private async readCurrentResumeV2(
    owner: AgentMissionServiceAuthorization['owner'],
  ): Promise<Result<QuoteAgentMissionResumeViewV2, AppError>> {
    const unitOfWork = this.persistence.createAgentMissionResumeV2UnitOfWork();
    if (unitOfWork === null) {
      return err(appUnavailable('agent_mission_resume_v2_persistence'));
    }
    try {
      return await new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(owner);
    } catch (error) {
      this.logger.error(
        'Lecture de reprise AgentMission V2 impossible.',
        undefined,
        'AgentMissionService',
        classifyAgentMissionResumeV2Failure(error),
      );
      return err(appUnavailable('agent_mission_resume_v2_persistence'));
    }
  }

  private async attachCurrentLinePresentation<
    T extends { readonly mission: AgentMissionViewV1 },
  >(
    owner: AgentMissionServiceAuthorization['owner'],
    value: T,
  ): Promise<Result<T & {
    readonly presentation: QuoteAgentMissionPresentationV1;
  }, AppError>> {
    const resumed = await this.readCurrentResumeV2(owner);
    if (!resumed.ok) return resumed;
    const current = resumed.value;
    const commandDraft = value.mission.payload.draft;
    if (
      current.mission === null
      || current.presentation === null
      || commandDraft === null
      || current.mission.id !== value.mission.id
      || current.mission.status !== value.mission.status
      || current.mission.phase !== value.mission.phase
      || current.mission.revision !== value.mission.revision
      || current.mission.actionable !== value.mission.actionable
      || current.mission.draft.sessionId !== commandDraft.sessionId
      || current.mission.draft.slotRevision !== commandDraft.slotRevision
      || current.mission.draft.contentRevision !== commandDraft.contentRevision
    ) {
      return err({
        kind: 'dependency',
        port: 'agent_mission_command_projection',
        cause: current.mission === null
          ? 'mission_missing_after_command'
          : 'mission_changed_after_command',
      });
    }
    return {
      ok: true,
      value: Object.freeze({
        ...value,
        presentation: current.presentation,
      }),
    };
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
    let continuationOutcome:
      AgentMissionLineContinuationServiceOutput['outcome'] | null = null;
    if (
      input.authorization.proof.protocolVersion === 2
      && mission.status === 'active'
      && (
        mission.phase === 'awaiting_lines'
        || mission.phase === 'awaiting_catalogue_choice'
        || mission.phase === 'awaiting_line_details'
        || mission.phase === 'awaiting_line_confirmation'
      )
    ) {
      const continued = await this.continueLineQueue({
        authorization: input.authorization,
        missionId: input.missionId,
        parentCommandId: acknowledged.value.receipt.ackCommandId,
      });
      if (!continued.ok) {
        this.metrics.agentMissionScreenAcks.inc({
          outcome: agentMissionScreenAckMetricOutcome(continued),
        });
        return continued;
      }
      mission = continued.value.mission;
      continuationOutcome = continued.value.continuation.outcome;
    }

    const acknowledgedValue = Object.freeze({
      ...acknowledged.value,
      mission,
    });
    const result: Result<AcknowledgeQuoteScreenOutput, AppError> =
      input.authorization.proof.protocolVersion === 2
      ? await this.attachCurrentLinePresentation(owner, acknowledgedValue)
      : { ok: true, value: acknowledgedValue };
    if (!result.ok) {
      this.metrics.agentMissionScreenAcks.inc({
        outcome: agentMissionScreenAckMetricOutcome(result),
      });
      return result;
    }
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
    if (!result.ok) return result;
    if (result.value.outcome !== 'replayed') {
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
    let finalValue = result.value;
    if (
      input.authorization.proof.protocolVersion === 2
      && result.value.mission.status === 'active'
      && result.value.mission.phase === 'awaiting_lines'
    ) {
      const continued = await this.continueLineQueue({
        authorization: input.authorization,
        missionId: input.missionId,
        parentCommandId: input.commandId,
      });
      if (!continued.ok) return continued;
      finalValue = Object.freeze({
        ...result.value,
        mission: continued.value.mission,
      });
    }
    return input.authorization.proof.protocolVersion === 2
      ? this.attachCurrentLinePresentation(owner, finalValue)
      : { ok: true, value: finalValue };
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
        continuationOutcome: continued.value.continuation.outcome,
      });
    }
    return this.attachCurrentLinePresentation(owner, Object.freeze({
      outcome: staged.value.outcome,
      mission: continued.value.mission,
      stagedCount: staged.value.stagedCount,
      firstQueueOrdinal: staged.value.firstQueueOrdinal,
      lastQueueOrdinal: staged.value.lastQueueOrdinal,
      continuation: continued.value.continuation,
    }));
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
  }): Promise<Result<DecideQuoteAgentMissionCatalogueChoiceServiceOutput, AppError>> {
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
      // La voix ne peut pas transporter une ligne additionnelle avec un choix ordinal : le modèle
      // voit la ligne courante et les choix, donc ce canal permettrait une recopie indétectable du
      // contexte. Le parcours tactile garde son contrat explicite et autoritaire.
      additionalLines: [],
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
    return this.attachCurrentLinePresentation(owner, Object.freeze({
      outcome: result.value.outcome,
      resolution: result.value.resolution,
      invalidationReason: result.value.invalidationReason,
      mission: continued.value.mission,
      continuation: continued.value.continuation,
    }));
  }

  patchLine(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly scope: AgentMissionQuoteLinePatchScope;
    readonly patch: AgentMissionQuoteLinePatchV1;
  }): Promise<Result<PatchQuoteAgentMissionLineServiceOutput, AppError>> {
    return this.executePatchLine({
      ...input,
      origin: { actor: 'user_tap', correlation: null },
    });
  }

  patchLineFromVoiceTurn(input: {
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
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly scope: AgentMissionQuoteLinePatchScope;
    readonly patch: AgentMissionQuoteLinePatchV1;
  }): Promise<Result<PatchQuoteAgentMissionLineServiceOutput, AppError>> {
    return this.executePatchLine({
      authorization: input.authorization,
      missionId: input.missionId,
      commandId: input.turnId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      pendingLineId: input.pendingLineId,
      expectedWorkRevision: input.expectedWorkRevision,
      scope: input.scope,
      patch: input.patch,
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

  private async executePatchLine(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly scope: AgentMissionQuoteLinePatchScope;
    readonly patch: AgentMissionQuoteLinePatchV1;
    readonly origin: Parameters<PatchQuoteAgentMissionLine['execute']>[0]['origin'];
  }): Promise<Result<PatchQuoteAgentMissionLineServiceOutput, AppError>> {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return err(appUnavailable('agent_mission_persistence'));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'line_patch',
    );
    const owner = input.authorization.owner;
    const patched = await new PatchQuoteAgentMissionLine({
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
      pendingLineId: input.pendingLineId,
      expectedWorkRevision: input.expectedWorkRevision,
      scope: input.scope,
      patch: input.patch,
      origin: input.origin,
    });
    if (!patched.ok) return patched;
    const continued = await this.continueLineQueue({
      authorization: input.authorization,
      missionId: input.missionId,
      parentCommandId: input.commandId,
    });
    if (!continued.ok) return continued;
    if (patched.value.outcome !== 'replayed') {
      this.logger.audit('agent_mission.line_fact_patched', {
        ...auditReferences(this.fingerprints, {
          companyId: owner.companyId,
          ownerUserId: owner.ownerUserId,
          missionId: input.missionId,
        }),
        actor: input.origin.actor,
        outcome: patched.value.outcome,
        phase: continued.value.mission.phase,
        continuationOutcome: continued.value.continuation.outcome,
      });
    }
    return this.attachCurrentLinePresentation(owner, Object.freeze({
      outcome: patched.value.outcome,
      pendingLineId: patched.value.pendingLineId,
      workRevisionAfter: patched.value.workRevisionAfter,
      mission: continued.value.mission,
      continuation: continued.value.continuation,
    }));
  }

  cancelPendingLine(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
  }): Promise<
    Result<CancelQuoteAgentMissionPendingLineServiceOutput, AppError>
  > {
    return this.executePendingLineCancellation({
      ...input,
      origin: { actor: 'user_tap', correlation: null },
    });
  }

  cancelPendingLineFromVoiceTurn(input: {
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
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
  }): Promise<
    Result<CancelQuoteAgentMissionPendingLineServiceOutput, AppError>
  > {
    return this.executePendingLineCancellation({
      authorization: input.authorization,
      missionId: input.missionId,
      commandId: input.turnId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      pendingLineId: input.pendingLineId,
      expectedWorkRevision: input.expectedWorkRevision,
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

  private async executePendingLineCancellation(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly pendingLineId: string;
    readonly expectedWorkRevision: number;
    readonly origin: Parameters<
      CancelQuoteAgentMissionPendingLine['execute']
    >[0]['origin'];
  }): Promise<
    Result<CancelQuoteAgentMissionPendingLineServiceOutput, AppError>
  > {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return err(appUnavailable('agent_mission_persistence'));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'line_cancel',
    );
    const owner = input.authorization.owner;
    const cancelled = await new CancelQuoteAgentMissionPendingLine({
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
      pendingLineId: input.pendingLineId,
      expectedWorkRevision: input.expectedWorkRevision,
      origin: input.origin,
    });
    if (!cancelled.ok) return cancelled;
    const continued = await this.continueLineQueue({
      authorization: input.authorization,
      missionId: input.missionId,
      parentCommandId: input.commandId,
    });
    if (!continued.ok) return continued;
    if (cancelled.value.outcome !== 'replayed') {
      this.logger.audit('agent_mission.pending_line_cancelled', {
        ...auditReferences(this.fingerprints, {
          companyId: owner.companyId,
          ownerUserId: owner.ownerUserId,
          missionId: input.missionId,
        }),
        actor: input.origin.actor,
        outcome: cancelled.value.outcome,
        phase: continued.value.mission.phase,
        continuationOutcome: continued.value.continuation.outcome,
      });
    }
    return this.attachCurrentLinePresentation(owner, Object.freeze({
      outcome: cancelled.value.outcome,
      pendingLineId: cancelled.value.pendingLineId,
      mission: continued.value.mission,
      continuation: continued.value.continuation,
    }));
  }

  decideLineProposal(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly choiceSetHash: string;
    readonly choiceId: string;
    readonly pendingLineId: string;
    readonly proposalId: string;
    readonly proposalRevision: 1;
    readonly expectedWorkRevision: number;
    readonly expectedCatalogue:
      | { readonly itemId: string; readonly revision: number }
      | null;
    readonly diffHash: string;
  }): Promise<
    Result<DecideQuoteAgentMissionLineProposalServiceOutput, AppError>
  > {
    return this.executeLineProposalDecision({
      ...input,
      origin: { actor: 'user_tap', correlation: null },
    });
  }

  decideLineProposalFromVoiceTurn(input: {
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
    readonly choiceSetHash: string;
    readonly choiceId: string;
    readonly pendingLineId: string;
    readonly proposalId: string;
    readonly proposalRevision: 1;
    readonly expectedWorkRevision: number;
    readonly expectedCatalogue:
      | { readonly itemId: string; readonly revision: number }
      | null;
    readonly diffHash: string;
  }): Promise<
    Result<DecideQuoteAgentMissionLineProposalServiceOutput, AppError>
  > {
    return this.executeLineProposalDecision({
      authorization: input.authorization,
      missionId: input.missionId,
      commandId: input.turnId,
      expectedMissionRevision: input.expectedMissionRevision,
      expectedDraftSessionId: input.expectedDraftSessionId,
      expectedDraftSlotRevision: input.expectedDraftSlotRevision,
      expectedDraftContentRevision: input.expectedDraftContentRevision,
      decisionId: input.decisionId,
      choiceSetRevision: input.choiceSetRevision,
      choiceSetHash: input.choiceSetHash,
      choiceId: input.choiceId,
      pendingLineId: input.pendingLineId,
      proposalId: input.proposalId,
      proposalRevision: input.proposalRevision,
      expectedWorkRevision: input.expectedWorkRevision,
      expectedCatalogue: input.expectedCatalogue,
      diffHash: input.diffHash,
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

  private async executeLineProposalDecision(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftSlotRevision: number;
    readonly expectedDraftContentRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly choiceSetHash: string;
    readonly choiceId: string;
    readonly pendingLineId: string;
    readonly proposalId: string;
    readonly proposalRevision: 1;
    readonly expectedWorkRevision: number;
    readonly expectedCatalogue:
      | { readonly itemId: string; readonly revision: number }
      | null;
    readonly diffHash: string;
    readonly origin: Parameters<
      DecideQuoteAgentMissionLineProposal['execute']
    >[0]['origin'];
  }): Promise<
    Result<DecideQuoteAgentMissionLineProposalServiceOutput, AppError>
  > {
    const persistedUnitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (persistedUnitOfWork === null) {
      return err(appUnavailable('agent_mission_persistence'));
    }
    const unitOfWork = instrumentAgentMissionCapabilityRejections(
      persistedUnitOfWork,
      this.metrics,
      this.logger,
      'line_decision',
    );
    const owner = input.authorization.owner;
    const decided = await new DecideQuoteAgentMissionLineProposal({
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
      choiceSetHash: input.choiceSetHash,
      choiceId: input.choiceId,
      pendingLineId: input.pendingLineId,
      proposalId: input.proposalId,
      proposalRevision: input.proposalRevision,
      expectedWorkRevision: input.expectedWorkRevision,
      expectedCatalogue: input.expectedCatalogue,
      diffHash: input.diffHash,
      origin: input.origin,
    });
    if (!decided.ok) return decided;
    const continued = await this.continueLineQueue({
      authorization: input.authorization,
      missionId: input.missionId,
      parentCommandId: input.commandId,
    });
    if (!continued.ok) return continued;
    if (decided.value.outcome !== 'replayed') {
      this.logger.audit('agent_mission.line_proposal_decided', {
        ...auditReferences(this.fingerprints, {
          companyId: owner.companyId,
          ownerUserId: owner.ownerUserId,
          missionId: input.missionId,
        }),
        actor: input.origin.actor,
        outcome: decided.value.outcome,
        invalidationReason: decided.value.invalidationReason,
        phase: continued.value.mission.phase,
        continuationOutcome: continued.value.continuation.outcome,
      });
    }
    return this.attachCurrentLinePresentation(owner, Object.freeze({
      outcome: decided.value.outcome,
      invalidationReason: decided.value.invalidationReason,
      mission: continued.value.mission,
      continuation: continued.value.continuation,
    }));
  }

  private async continueLineQueue(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly missionId: string;
    readonly parentCommandId: string;
  }): Promise<Result<AgentMissionLineConvergenceOutput, AppError>> {
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
    const deps = {
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    };
    const resolution = new ContinueQuoteAgentMissionLineResolution(deps);
    const resolutionInput = {
      ...input.authorization.owner,
      authority: input.authorization.proof,
      missionId: input.missionId,
      parentCommandId: input.parentCommandId,
    };

    const firstResolution = await resolution.execute(resolutionInput);
    if (!firstResolution.ok) return firstResolution;
    let resolved = firstResolution.value;
    let catalogue: ContinueQuoteAgentMissionLineQueueOutput | null = null;

    if (resolved.outcome === 'needs_catalogue_resolution') {
      const queued = await new ContinueQuoteAgentMissionLineQueue(deps).execute(
        resolutionInput,
      );
      if (!queued.ok) return queued;
      catalogue = queued.value;
      const secondResolution = await resolution.execute(resolutionInput);
      if (!secondResolution.ok) return secondResolution;
      resolved = secondResolution.value;
    }

    if (resolved.outcome === 'needs_catalogue_resolution') {
      return err(appConflict(
        'agent_mission_line_continuation',
        'continuation_non_convergent',
      ));
    }

    let outcome: AgentMissionLineContinuationServiceOutput['outcome'] =
      resolved.outcome;
    let presentedChoiceCount = 0;
    if (resolved.outcome === 'catalogue_choice_pending') {
      const decision = resolved.mission.payload.decision;
      if (
        decision?.kind !== 'catalogue'
        || decision.candidates.length < 1
        || decision.candidates.length > 5
      ) {
        return err({
          kind: 'dependency',
          port: 'agent_mission_line_continuation',
          cause: 'catalogue_choice_projection_unavailable',
        });
      }
      presentedChoiceCount = decision.candidates.length + 1;
      outcome = catalogue?.outcome === 'choices_presented'
        || catalogue?.outcome === 'replayed'
        ? catalogue.outcome
        : resolved.outcome;
    }

    return {
      ok: true,
      value: Object.freeze({
        mission: resolved.mission,
        continuation: Object.freeze({
          outcome,
          pendingLineId: resolved.pendingLineId,
          presentedChoiceCount,
          requiredFact: resolved.requiredFact,
          proposalId: resolved.proposalId,
        }),
      }),
    };
  }
}
