import { QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import type {
  RealtimeQuoteMissionOrchestrationInput,
  RealtimeQuoteMissionOrchestrationOutcome,
  RealtimeQuoteMissionOrchestratorPort,
} from './realtime-quote-mission-orchestrator';
import type { QuoteCreationMissionKindV1 } from './realtime-mission-kind';

export const REALTIME_MISSION_UNAVAILABLE_SPEECH =
  'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.' as const;

export class QuoteCreationMissionKindAdapter
implements QuoteCreationMissionKindV1 {
  readonly id = QUOTE_CREATION_MISSION_KIND_V1;

  constructor(
    private readonly delegate: RealtimeQuoteMissionOrchestratorPort | null,
  ) {}

  run(
    input: RealtimeQuoteMissionOrchestrationInput,
  ): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    if (this.delegate === null) {
      return Promise.resolve({
        status: 'failed',
        canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
      });
    }
    return this.delegate.run(input);
  }
}
