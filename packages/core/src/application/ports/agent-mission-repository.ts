import {
  type AgentMission,
  type AgentMissionKind,
  type AgentMissionProtocolVersion,
} from '../../domain/agent/agent-mission';
import { type AgentMissionEvent } from '../../domain/agent/agent-mission-event';
import {
  type QuoteDraftPayloadV1,
  type QuoteDraftSlot,
} from '../quote-drafts/quote-draft-slot';

export interface AgentMissionOwner {
  readonly companyId: string;
  readonly ownerUserId: string;
}

export interface AgentMissionQuoteDraftSlot extends QuoteDraftSlot {
  readonly agentMissionId: string | null;
}

/**
 * Référence globale volontairement discriminée : un binaire K2 peut voir un kind ajouté par K3
 * sans tenter de parser son payload avec l'agrégat devis, et refuse alors le start proprement.
 */
export type AgentMissionLookup =
  | {
      readonly status: 'known';
      readonly mission: AgentMission;
    }
  | {
      readonly status: 'unsupported_kind';
      readonly missionId: string;
      readonly kind: string;
    }
  | {
      readonly status: 'unsupported_protocol';
      readonly missionId: string;
      readonly kind: 'quote_creation';
      readonly protocolVersion: AgentMissionProtocolVersion;
    };

export type AgentMissionForeground = AgentMissionLookup;

export type AgentMissionEventLookup =
  | {
      readonly status: 'known';
      readonly event: AgentMissionEvent;
    }
  | {
      readonly status: 'unsupported_kind';
      readonly missionId: string;
      readonly kind: string;
    }
  | {
      readonly status: 'unsupported_protocol';
      readonly missionId: string;
      readonly kind: 'quote_creation';
      readonly protocolVersion: AgentMissionProtocolVersion;
    };

export interface AgentMissionReadRepositoryPort {
  /** Lecture kind-scoped historique, conservée pour les consommateurs M1-C. */
  findActive(input: AgentMissionOwner & {
    readonly kind: AgentMissionKind;
  }): Promise<AgentMission | null>;
  /** Foreground durable unique de l'owner, tous kinds confondus. */
  findForeground(input: AgentMissionOwner): Promise<AgentMissionForeground | null>;
  findById(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<AgentMissionLookup | null>;
}

export interface AgentMissionRepositoryPort extends AgentMissionReadRepositoryPort {
  findActiveForUpdate(input: AgentMissionOwner & {
    readonly kind: AgentMissionKind;
  }): Promise<AgentMission | null>;
  /** Foreground global sous les verrous owner-foreground puis owner+kind historique. */
  findForegroundForUpdate(input: AgentMissionOwner): Promise<AgentMissionForeground | null>;
  findByIdForUpdate(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<AgentMissionLookup | null>;
  insert(mission: AgentMission): Promise<'inserted' | 'conflict'>;
  updateCas(input: {
    readonly mission: AgentMission;
    readonly expectedRevision: number;
  }): Promise<'updated' | 'revision_conflict'>;
}

export interface AgentMissionEventRepositoryPort {
  findByCommandId(input: AgentMissionOwner & {
    readonly commandId: string;
  }): Promise<AgentMissionEventLookup | null>;
  append(event: AgentMissionEvent): Promise<void>;
}

export interface AgentMissionQuoteDraftRepositoryPort {
  getForUpdate(owner: AgentMissionOwner): Promise<AgentMissionQuoteDraftSlot | null>;
  create(input: AgentMissionOwner & {
    readonly payload: QuoteDraftPayloadV1;
  }): Promise<AgentMissionQuoteDraftSlot | null>;
  claim(input: AgentMissionOwner & {
    readonly missionId: string;
    readonly expectedSlotRevision: number;
    readonly expectedDraftSessionId: string;
  }): Promise<AgentMissionQuoteDraftSlot | null>;
  release(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<boolean>;
  /**
   * CAS étroit du seul geste `client → lignes`. L'adapter doit aussi vérifier que le brouillon
   * appartient encore à la mission, que le client est absent et que l'étape vaut `client`.
   */
  selectCustomerCas(input: AgentMissionOwner & {
    readonly missionId: string;
    readonly expectedSlotRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftContentRevision: number;
    readonly payload: QuoteDraftPayloadV1;
  }): Promise<AgentMissionQuoteDraftSlot | null>;
}

export type AgentMissionDraftFenceResult<T> =
  | { readonly status: 'owned_by_agent_mission' }
  | {
      readonly status: 'foreground_unavailable';
      readonly reason: 'lock_timeout' | 'query_canceled' | 'transaction_timeout';
    }
  | {
      readonly status: 'company_unavailable';
      readonly reason: 'missing' | 'closed';
    }
  | { readonly status: 'executed'; readonly value: T };

/**
 * Sérialise un writer manuel avec le propriétaire de mission. L'adapter doit prendre Company
 * SHARE, le verrou foreground global puis le verrou owner+kind historique, dans cet ordre, et
 * exécuter `work` dans la transaction qui vérifie le marqueur. Une société absente ou clôturée
 * refuse le writer sans appeler `work`. Le trigger SQL reste la dernière autorité pour les
 * writers N-1 qui ne connaissent que le verrou historique.
 */
export interface AgentMissionDraftFencePort {
  runLegacyMutationIfUnowned<T>(
    owner: AgentMissionOwner,
    work: () => Promise<T>,
  ): Promise<AgentMissionDraftFenceResult<T>>;
}
