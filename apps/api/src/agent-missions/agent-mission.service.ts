import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CancelQuoteAgentMission,
  GetActiveAgentMission,
  StartQuoteAgentMission,
  appForbidden,
  appUnavailable,
  err,
  type AgentMissionFingerprintPort,
  type AgentMissionViewV1,
  type AppError,
  type CancelQuoteAgentMissionOutput,
  type Result,
  type StartQuoteAgentMissionOutput,
} from '@bob/core';
import { AppLogger, getPrincipal } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { AGENT_MISSION_FINGERPRINTS } from './agent-mission-fingerprint.provider';

function identity(): Result<{ readonly companyId: string; readonly ownerUserId: string }, AppError> {
  const principal = getPrincipal();
  if (
    principal === undefined
    || principal.companyId === null
    || typeof principal.userId !== 'string'
    || principal.userId.trim() === ''
  ) {
    return err(appForbidden('authenticated_agent_mission_owner_required'));
  }
  return {
    ok: true,
    value: {
      companyId: principal.companyId,
      ownerUserId: principal.userId,
    },
  };
}

@Injectable()
export class AgentMissionService {
  constructor(
    @Inject(PERSISTENCE) private readonly persistence: Persistence,
    @Inject(AGENT_MISSION_FINGERPRINTS)
    private readonly fingerprints: AgentMissionFingerprintPort,
    @Inject(AppLogger)
    private readonly logger: AppLogger,
  ) {}

  getCurrent(): Promise<Result<{ readonly mission: AgentMissionViewV1 | null }, AppError>> {
    const owner = identity();
    if (!owner.ok) return Promise.resolve(owner);
    const unitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (unitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    return new GetActiveAgentMission({ unitOfWork }).execute(owner.value)
      .then((result) => result.ok ? { ok: true, value: { mission: result.value } } : result);
  }

  start(input: {
    readonly commandId: string;
  }): Promise<Result<StartQuoteAgentMissionOutput, AppError>> {
    const owner = identity();
    if (!owner.ok) return Promise.resolve(owner);
    const unitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (unitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    const useCase = new StartQuoteAgentMission({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    });
    return useCase.execute({ ...owner.value, commandId: input.commandId }).then((result) => {
      if (result.ok && result.value.outcome === 'created') {
        this.logger.audit('agent_mission.started', {
          companyId: owner.value.companyId,
          ownerUserId: owner.value.ownerUserId,
          missionId: result.value.mission.id,
          outcome: result.value.outcome,
          startOutcome: result.value.startOutcome,
        });
      }
      return result;
    });
  }

  cancel(input: {
    readonly missionId: string;
    readonly commandId: string;
    readonly expectedMissionRevision: number;
  }): Promise<Result<CancelQuoteAgentMissionOutput, AppError>> {
    const owner = identity();
    if (!owner.ok) return Promise.resolve(owner);
    const unitOfWork = this.persistence.createAgentMissionUnitOfWork();
    if (unitOfWork === null) {
      return Promise.resolve(err(appUnavailable('agent_mission_persistence')));
    }
    const useCase = new CancelQuoteAgentMission({
      unitOfWork,
      fingerprints: this.fingerprints,
      ids: { newId: () => randomUUID() },
    });
    return useCase.execute({
      ...owner.value,
      missionId: input.missionId,
      commandId: input.commandId,
      expectedRevision: input.expectedMissionRevision,
      reason: 'user_cancelled',
      actor: 'user_tap',
    }).then((result) => {
      if (result.ok && result.value.outcome === 'cancelled') {
        this.logger.audit('agent_mission.cancelled', {
          companyId: owner.value.companyId,
          ownerUserId: owner.value.ownerUserId,
          missionId: result.value.mission.id,
          outcome: result.value.outcome,
        });
      }
      return result;
    });
  }
}
