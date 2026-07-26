import type {
  AcknowledgeQuoteScreenOutput,
  AgentMissionViewV1,
  AppError,
  CancelQuoteAgentMissionOutput,
  Result,
  StartQuoteAgentMissionOutput,
} from '@bob/core';

export const REALTIME_AGENT_MISSION_PROTOCOL_VERSION = 1 as const;

export interface RealtimeAgentMissionStartQuoteInput {
  readonly commandId: string;
}

export interface RealtimeAgentMissionCancelQuoteInput {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
}

export interface RealtimeAgentMissionAcknowledgeQuoteScreenInput {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly draftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
}

/**
 * Capability Bob Live volatile.
 *
 * Le secret n'est jamais un champ de cet objet : l'implémentation HTTP le conserve dans un
 * champ privé natif et ajoute elle-même le header. Le handle est transférable entre couches,
 * mais ni sérialisable ni reconstructible à partir de son `realtimeSessionId`.
 */
export interface RealtimeAgentMissionSession {
  readonly protocolVersion: typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION;
  readonly realtimeSessionId: string;
  readonly disposed: boolean;
  getCurrentQuoteCreation(
    signal?: AbortSignal,
  ): Promise<Result<{ readonly mission: AgentMissionViewV1 | null }, AppError>>;
  startQuoteCreation(
    input: RealtimeAgentMissionStartQuoteInput,
    signal?: AbortSignal,
  ): Promise<Result<StartQuoteAgentMissionOutput, AppError>>;
  cancelQuoteCreation(
    input: RealtimeAgentMissionCancelQuoteInput,
    signal?: AbortSignal,
  ): Promise<Result<CancelQuoteAgentMissionOutput, AppError>>;
  acknowledgeQuoteScreen(
    input: RealtimeAgentMissionAcknowledgeQuoteScreenInput,
    signal?: AbortSignal,
  ): Promise<Result<AcknowledgeQuoteScreenOutput, AppError>>;
  /** Efface immédiatement la capability et rend toute méthode réseau inopérante. */
  dispose(): void;
}
