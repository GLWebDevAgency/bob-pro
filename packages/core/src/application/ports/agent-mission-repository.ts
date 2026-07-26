import {
  type AgentMission,
  type AgentMissionKind,
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

export interface AgentMissionReadRepositoryPort {
  findActive(input: AgentMissionOwner & {
    readonly kind: AgentMissionKind;
  }): Promise<AgentMission | null>;
  findById(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<AgentMission | null>;
}

export interface AgentMissionRepositoryPort extends AgentMissionReadRepositoryPort {
  findActiveForUpdate(input: AgentMissionOwner & {
    readonly kind: AgentMissionKind;
  }): Promise<AgentMission | null>;
  findByIdForUpdate(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<AgentMission | null>;
  insert(mission: AgentMission): Promise<void>;
  updateCas(input: {
    readonly mission: AgentMission;
    readonly expectedRevision: number;
  }): Promise<'updated' | 'revision_conflict'>;
}

export interface AgentMissionEventRepositoryPort {
  findByCommandId(input: AgentMissionOwner & {
    readonly commandId: string;
  }): Promise<AgentMissionEvent | null>;
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
}

export type AgentMissionDraftFenceResult<T> =
  | { readonly status: 'owned_by_agent_mission' }
  | {
      readonly status: 'company_unavailable';
      readonly reason: 'missing' | 'closed';
    }
  | { readonly status: 'executed'; readonly value: T };

/**
 * Sérialise un writer manuel avec le propriétaire de mission. L'adapter doit prendre le même
 * verrou Company SHARE puis le même verrou owner+kind que l'UoW AgentMission, dans cet ordre, et
 * exécuter `work` dans la transaction qui vérifie le marqueur. Une société absente ou clôturée
 * refuse le writer sans appeler `work`. Le trigger SQL reste la dernière autorité pour les
 * writers N-1.
 */
export interface AgentMissionDraftFencePort {
  runLegacyMutationIfUnowned<T>(
    owner: AgentMissionOwner,
    work: () => Promise<T>,
  ): Promise<AgentMissionDraftFenceResult<T>>;
}
