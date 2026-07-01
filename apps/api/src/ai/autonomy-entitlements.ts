import { type AutonomyEntitlement } from '@bob/core';
import { type AgentAutonomy } from '@bob/ai';

const AUTONOMY_RANK: Record<AgentAutonomy, number> = {
  confirm_all: 0,
  confirm_outbound: 1,
  auto: 2,
};

export function clampAgentAutonomy(
  requested: AgentAutonomy | undefined,
  entitlement: AutonomyEntitlement,
): AgentAutonomy {
  const max = entitlement as AgentAutonomy;
  const desired = requested ?? max;
  return AUTONOMY_RANK[desired] <= AUTONOMY_RANK[max] ? desired : max;
}
