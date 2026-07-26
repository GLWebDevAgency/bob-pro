import type { Provider } from '@nestjs/common';

export const AGENT_MISSION_HTTP_AUTHORITY = Symbol('AGENT_MISSION_HTTP_AUTHORITY');

export type AgentMissionHttpOperation =
  | 'get_current_quote_creation'
  | 'start_quote_creation'
  | 'cancel_quote_creation';

export interface AgentMissionHttpAuthority {
  /**
   * Contrat volontairement non activable tel quel en production M1-A. Un provider futur ne peut
   * retourner true qu'après avoir lié le Principal request-scoped à une lease/capability durable
   * relue côté serveur. L'activation doit faire évoluer atomiquement ce contrat et ses preuves ;
   * un header ou identifiant libre fourni par le client ne constitue jamais cette liaison.
   */
  authorize(operation: AgentMissionHttpOperation): Promise<boolean>;
}

/**
 * M1-A compose les routes sans fabriquer une fausse capability à partir du JWT ou d'un header.
 * La future tranche Realtime substituera cette autorité par une preuve liée à la lease.
 */
export class DisabledAgentMissionHttpAuthority implements AgentMissionHttpAuthority {
  async authorize(_operation: AgentMissionHttpOperation): Promise<boolean> {
    return false;
  }
}

export const agentMissionHttpAuthorityProvider: Provider = {
  provide: AGENT_MISSION_HTTP_AUTHORITY,
  useClass: DisabledAgentMissionHttpAuthority,
};
