import { type Result, err, ok } from '../../shared-kernel/result';
import { type AgentMissionOwner } from '../ports/agent-mission-repository';
import {
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionUnitOfWorkPort,
} from '../ports/agent-mission-unit-of-work';
import { type AppError, appConflict } from '../result';
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
        const foreground = await transaction.missions.findForeground(owner);
        if (foreground === null) return ok(null);
        if (foreground.status === 'unsupported_kind') {
          return err(appConflict(
            'agent_mission_foreground',
            'active_mission_exists',
          ));
        }
        return toAgentMissionView(foreground.mission, now);
      },
    );
    return execution.status === 'capability_rejected'
      ? err(rejectedAgentMissionCapability(execution.reason))
      : execution.value;
  }
}
