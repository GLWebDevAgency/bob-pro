import { CUSTOMER_CONTACT_MISSION_KIND_V1, type CustomerContactSemanticFrameV1 } from '@bob/core';
import { REALTIME_MISSION_UNAVAILABLE_SPEECH } from './quote-creation-mission-kind.adapter';
import type {
  RealtimeJarvisMissionOrchestrationInput,
  RealtimeJarvisMissionOrchestrationOutcome,
  RealtimeJarvisMissionOrchestratorPort,
  RealtimeJarvisMissionPreparationOutcome,
  RealtimeJarvisMissionPreparedTurn,
} from './realtime-jarvis-mission-orchestrator';
import type { CustomerContactMissionKindV1 } from './realtime-mission-kind';

/**
 * Adaptateur `customer_contact@1` — patron EXACT de `QuoteCreationMissionKindAdapter` : le kind
 * existe dans le registre dès le boot (sinon `missing_id`), et un délégué absent (provider
 * d'admission pas encore câblé, vague B) échoue FERMÉ avec la parole canonique commune.
 */
export class CustomerContactMissionKindAdapter implements CustomerContactMissionKindV1 {
  readonly id = CUSTOMER_CONTACT_MISSION_KIND_V1;

  constructor(private readonly delegate: RealtimeJarvisMissionOrchestratorPort | null) {}

  prepare(
    input: RealtimeJarvisMissionOrchestrationInput,
  ): Promise<RealtimeJarvisMissionPreparationOutcome> {
    if (this.delegate === null) {
      return Promise.resolve({
        status: 'failed',
        canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
      });
    }
    return this.delegate.prepare(input);
  }

  runPlanned(input: {
    readonly request: RealtimeJarvisMissionOrchestrationInput;
    readonly prepared: RealtimeJarvisMissionPreparedTurn;
    readonly frame: CustomerContactSemanticFrameV1;
  }): Promise<RealtimeJarvisMissionOrchestrationOutcome> {
    if (this.delegate === null) {
      return Promise.resolve({
        status: 'failed',
        canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
      });
    }
    return this.delegate.runPlanned(input);
  }
}
