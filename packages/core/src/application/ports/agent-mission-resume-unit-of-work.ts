import { type Instant } from '../../shared-kernel/time';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
  type AgentMissionReadRepositoryPort,
} from './agent-mission-repository';
import { type CustomerCandidateReadPort } from './customer-candidate-search';

export interface AgentMissionResumeQuoteDraftReadPort {
  get(owner: AgentMissionOwner): Promise<AgentMissionQuoteDraftSlot | null>;
}

/**
 * Snapshot owner-scopé de reprise après perte de la capability volatile.
 *
 * Cette transaction ne possède volontairement ni lease Realtime, ni événement, ni méthode
 * d'écriture. L'adapter doit être REPEATABLE READ + READ ONLY sous les GUC tenant et owner.
 */
export interface AgentMissionResumeReadTransaction {
  databaseNow(): Promise<Instant>;
  readonly missions: Pick<AgentMissionReadRepositoryPort, 'findActive' | 'findForeground'>;
  readonly quoteDrafts: AgentMissionResumeQuoteDraftReadPort;
  readonly customers: Pick<CustomerCandidateReadPort, 'findByIds'>;
}

export type AgentMissionResumeReadExecution<T> =
  | { readonly status: 'executed'; readonly value: T }
  | {
      readonly status: 'company_unavailable';
      readonly reason: 'missing' | 'closed';
    };

export interface AgentMissionResumeUnitOfWorkPort {
  readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionResumeReadTransaction) => Promise<T>,
  ): Promise<AgentMissionResumeReadExecution<T>>;
}
