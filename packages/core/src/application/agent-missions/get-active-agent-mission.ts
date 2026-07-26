import { AGENT_MISSION_KIND } from '../../domain/agent/agent-mission';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type AgentMissionOwner } from '../ports/agent-mission-repository';
import { type AgentMissionUnitOfWorkPort } from '../ports/agent-mission-unit-of-work';
import { type AppError } from '../result';
import {
  isCanonicalAgentMissionOwner,
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
  ): Promise<Result<AgentMissionViewV1 | null, AppError>> {
    if (!isCanonicalAgentMissionOwner(owner)) {
      return err({
        kind: 'validation',
        issues: [{ field: 'identity', message: 'Identité mission invalide.' }],
      });
    }
    return this.deps.unitOfWork.readQuoteCreationOwner(owner, async (transaction) => {
      const now = await transaction.databaseNow();
      const mission = await transaction.missions.findActive({
        ...owner,
        kind: AGENT_MISSION_KIND,
      });
      if (mission === null) return ok(null);
      return toAgentMissionView(mission, now);
    });
  }
}
