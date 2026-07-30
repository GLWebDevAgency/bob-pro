import { type Instant } from '../../shared-kernel/time';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
  type AgentMissionReadRepositoryPort,
} from './agent-mission-repository';
import {
  type AgentMissionQuoteLineWork,
} from '../agent-missions/quote-line-work';
import {
  type CatalogueCandidateRecord,
} from './catalogue-candidate-search';
import { type CustomerCandidateReadPort } from './customer-candidate-search';
import {
  type QuoteVatDecisionContext,
} from './quote-vat-context';

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

export interface AgentMissionResumeQuoteLineWorkReadPort {
  list(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<readonly AgentMissionQuoteLineWork[]>;
}

export interface AgentMissionResumeCatalogueReadPort {
  findByIds(input: {
    readonly companyId: string;
    readonly catalogueItemIds: readonly string[];
  }): Promise<readonly CatalogueCandidateRecord[]>;
}

export interface AgentMissionResumeQuoteVatContextReadPort {
  get(input: {
    readonly companyId: string;
    readonly customerId: string;
  }): Promise<QuoteVatDecisionContext | null>;
}

export interface AgentMissionResumeV2ReadTransaction
extends AgentMissionResumeReadTransaction {
  readonly quoteLineWork: AgentMissionResumeQuoteLineWorkReadPort;
  readonly catalogue: AgentMissionResumeCatalogueReadPort;
  readonly quoteVatContext: AgentMissionResumeQuoteVatContextReadPort;
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

/**
 * Autorité froide V2 séparée : le wire V1 ne gagne ni nouveau port, ni nouveau protocole
 * implicite. L'adapter fournit un snapshot READ ONLY complet sans verrou de ligne.
 */
export interface AgentMissionResumeV2UnitOfWorkPort {
  readQuoteCreationOwnerV2<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionResumeV2ReadTransaction) => Promise<T>,
  ): Promise<AgentMissionResumeReadExecution<T>>;
}
