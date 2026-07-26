import { AGENT_MISSION_KIND } from '../../domain/agent/agent-mission';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type AgentMissionOwner } from '../ports/agent-mission-repository';
import {
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionUnitOfWorkPort,
} from '../ports/agent-mission-unit-of-work';
import { type AppError } from '../result';
import {
  isCanonicalAgentMissionOwner,
  rejectedAgentMissionCapability,
  toAgentMissionView,
  type AgentMissionViewV1,
} from './agent-mission-application';

export interface GetActiveAgentMissionDeps {
  readonly unitOfWork: AgentMissionUnitOfWorkPort;
}

export class GetActiveAgentMission {
  constructor(private readonly deps: GetActiveAgentMissionDeps) {}

  async execute(
    owner: AgentMissionOwner,
    authority: AgentMissionRealtimeAuthorityProof,
  ): Promise<Result<AgentMissionViewV1 | null, AppError>> {
    if (!isCanonicalAgentMissionOwner(owner)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'identity', message: 'Identité mission invalide.' }],
      });
    }
    const execution = await this.deps.unitOfWork.readQuoteCreationOwner(
      owner,
      authority,
      async (transaction) => {
        const now = await transaction.databaseNow();
        const mission = await transaction.missions.findActive({
          ...owner,
          kind: AGENT_MISSION_KIND,
        });
        if (mission === null) return ok(null);
        return toAgentMissionView(mission, now);
      },
    );
    return execution.status === 'capability_rejected'
      ? err(rejectedAgentMissionCapability(execution.reason))
      : execution.value;
  }
}
