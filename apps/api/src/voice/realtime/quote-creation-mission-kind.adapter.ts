import { QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import type {
  RealtimeQuoteMissionOrchestrationInput,
  RealtimeQuoteMissionOrchestrationOutcome,
  RealtimeQuoteMissionOrchestratorPort,
  RealtimeQuoteMissionPreparationOutcome,
  RealtimeQuoteMissionPreparedTurn,
} from './realtime-quote-mission-orchestrator';
import type {
  QuoteCreationSemanticFrameV1,
  QuoteCreationSemanticFrameV2,
} from '@bob/ai';
import type { QuoteCreationMissionKindV1 } from './realtime-mission-kind';

export const REALTIME_MISSION_UNAVAILABLE_SPEECH =
  'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.' as const;

export class QuoteCreationMissionKindAdapter
implements QuoteCreationMissionKindV1 {
  readonly id = QUOTE_CREATION_MISSION_KIND_V1;

  constructor(
    private readonly delegate: RealtimeQuoteMissionOrchestratorPort | null,
  ) {}

  prepare(
    input: RealtimeQuoteMissionOrchestrationInput,
  ): Promise<RealtimeQuoteMissionPreparationOutcome> {
    if (this.delegate === null) {
      return Promise.resolve({
        status: 'failed',
        canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
      });
    }
    return this.delegate.prepare(input);
  }

  runPlanned(input: {
    readonly request: RealtimeQuoteMissionOrchestrationInput;
    readonly prepared: RealtimeQuoteMissionPreparedTurn;
    readonly frame: QuoteCreationSemanticFrameV1 | QuoteCreationSemanticFrameV2;
  }): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    if (this.delegate === null) {
      return Promise.resolve({
        status: 'failed',
        canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
      });
    }
    return this.delegate.runPlanned(input);
  }
}
