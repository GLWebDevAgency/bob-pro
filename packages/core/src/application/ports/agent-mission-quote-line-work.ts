import {
  type AgentMissionQuoteLineWork,
} from '../agent-missions/quote-line-work';
import { type AgentMissionOwner } from './agent-mission-repository';

export interface AgentMissionQuoteLineWorkRepositoryPort {
  listForUpdate(
    input: AgentMissionOwner & {
      readonly missionId: string;
    },
  ): Promise<readonly AgentMissionQuoteLineWork[]>;

  findByIdForUpdate(
    input: AgentMissionOwner & {
      readonly missionId: string;
      readonly workItemId: string;
    },
  ): Promise<AgentMissionQuoteLineWork | null>;

  insertMany(
    input: AgentMissionOwner & {
      readonly missionId: string;
      readonly workItems: readonly AgentMissionQuoteLineWork[];
    },
  ): Promise<'inserted' | 'conflict'>;

  updateCas(input: {
    readonly workItem: AgentMissionQuoteLineWork;
    readonly expectedRevision: number;
  }): Promise<'updated' | 'revision_conflict'>;

  delete(
    input: AgentMissionOwner & {
      readonly missionId: string;
      readonly workItemId: string;
      readonly expectedRevision: number;
    },
  ): Promise<'deleted' | 'not_found' | 'revision_conflict'>;

  deleteAll(
    input: AgentMissionOwner & {
      readonly missionId: string;
    },
  ): Promise<number>;
}
