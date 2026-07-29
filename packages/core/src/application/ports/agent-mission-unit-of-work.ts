import { type Instant } from '../../shared-kernel/time';
import {
  type AgentMissionEventRepositoryPort,
  type AgentMissionOwner,
  type AgentMissionQuoteDraftRepositoryPort,
  type AgentMissionReadRepositoryPort,
  type AgentMissionRepositoryPort,
} from './agent-mission-repository';
import {
  type CustomerCandidateReadPort,
  type CustomerCandidateSearchPort,
} from './customer-candidate-search';

export interface AgentMissionRealtimeAuthorityProof {
  /**
   * Empreintes HMAC sujet dérivées côté serveur depuis le keyring Bob Live courant et retenu.
   * Le client ne choisit jamais cette liste.
   */
  readonly subjectHashCandidates: readonly string[];
  /** Verrou stable du principal, dérivé côté serveur et jamais persisté. */
  readonly principalBindingHash: string;
  /** SHA-256 de la capability canonique présentée ; le secret ne traverse jamais ce port. */
  readonly capabilityHash: string;
}

export type AgentMissionCapabilityRejectionReason =
  | 'malformed'
  | 'not_found'
  | 'ambiguous'
  | 'expired'
  | 'state'
  | 'hash_mismatch';

export interface AgentMissionAuthorizedRealtimeLease {
  readonly realtimeSessionId: string;
}

export interface AgentMissionQuoteScreenFences {
  readonly missionId: string;
  readonly realtimeSessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly draftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly databaseNow: Instant;
}

export type AgentMissionQuoteScreenObservation =
  | {
      readonly status: 'ready';
      readonly realtimeSessionId: string;
      readonly contextRevision: number;
      readonly contextDigest: string;
      readonly screenInstanceId: string;
      readonly draft: {
        readonly sessionId: string;
        readonly slotRevision: number;
        readonly contentRevision: number;
      };
      readonly draftHasCustomer: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly reason: 'context_stale' | 'draft_stale' | 'unavailable';
    };

export interface AgentMissionQuoteScreenAuthorityPort {
  observeForUpdate(
    owner: AgentMissionOwner,
    fences: AgentMissionQuoteScreenFences,
  ): Promise<AgentMissionQuoteScreenObservation>;
}

export interface AgentMissionReadTransaction {
  /** Horloge DB autoritaire lue après les verrous nécessaires (`clock_timestamp()` côté SQL). */
  databaseNow(): Promise<Instant>;
  readonly realtime: AgentMissionAuthorizedRealtimeLease;
  readonly missions: AgentMissionReadRepositoryPort;
}

export interface AgentMissionTransaction {
  /** Instant métier unique lu après le verrou owner+kind (`clock_timestamp()` côté SQL). */
  databaseNow(): Promise<Instant>;
  readonly realtime: AgentMissionAuthorizedRealtimeLease;
  readonly missions: AgentMissionRepositoryPort;
  readonly events: AgentMissionEventRepositoryPort;
  readonly quoteDrafts: AgentMissionQuoteDraftRepositoryPort;
  readonly quoteScreen: AgentMissionQuoteScreenAuthorityPort;
  readonly customers: CustomerCandidateSearchPort & CustomerCandidateReadPort;
}

export type AgentMissionCompanyUnavailableReason = 'missing' | 'closed';

export type AgentMissionWriteExecution<T> =
  | { readonly status: 'executed'; readonly value: T }
  | {
      readonly status: 'capability_rejected';
      readonly reason: AgentMissionCapabilityRejectionReason;
    }
  | {
      readonly status: 'company_unavailable';
      readonly reason: AgentMissionCompanyUnavailableReason;
    };

export type AgentMissionReadExecution<T> =
  | { readonly status: 'executed'; readonly value: T }
  | {
      readonly status: 'capability_rejected';
      readonly reason: AgentMissionCapabilityRejectionReason;
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
    authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ): Promise<AgentMissionReadExecution<T>>;
  runQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionTransaction) => Promise<T>,
  ): Promise<AgentMissionWriteExecution<T>>;
}
