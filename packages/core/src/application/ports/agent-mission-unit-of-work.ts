import { type Instant } from '../../shared-kernel/time';
import {
  type AgentMissionEventRepositoryPort,
  type AgentMissionOwner,
  type AgentMissionQuoteDraftRepositoryPort,
  type AgentMissionReadRepositoryPort,
  type AgentMissionRepositoryPort,
} from './agent-mission-repository';

export interface AgentMissionReadTransaction {
  /** Horloge DB autoritaire lue après les verrous nécessaires (`clock_timestamp()` côté SQL). */
  databaseNow(): Promise<Instant>;
  readonly missions: AgentMissionReadRepositoryPort;
}

export interface AgentMissionTransaction {
  /** Instant métier unique lu après le verrou owner+kind (`clock_timestamp()` côté SQL). */
  databaseNow(): Promise<Instant>;
  readonly missions: AgentMissionRepositoryPort;
  readonly events: AgentMissionEventRepositoryPort;
  readonly quoteDrafts: AgentMissionQuoteDraftRepositoryPort;
}

export type AgentMissionCompanyUnavailableReason = 'missing' | 'closed';

export type AgentMissionWriteExecution<T> =
  | { readonly status: 'executed'; readonly value: T }
  | {
      readonly status: 'company_unavailable';
      readonly reason: AgentMissionCompanyUnavailableReason;
    };

/**
 * Le port impose une transaction owner/tenant et le verrou owner+kind avant d'exposer les repos.
 * Avant le verrou owner+kind, l'adapter prend le verrou partagé de cycle de vie société et ne
 * lance jamais `work` si la société est absente ou clôturée. L'ordre global est donc
 * company(SHARE) → owner/kind → agrégats, identique aux autres writers financiers.
 */
export interface AgentMissionUnitOfWorkPort {
  readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ): Promise<T>;
  runQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionTransaction) => Promise<T>,
  ): Promise<AgentMissionWriteExecution<T>>;
}
