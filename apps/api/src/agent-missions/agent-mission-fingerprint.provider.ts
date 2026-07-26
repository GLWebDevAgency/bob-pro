import { Injectable, type Provider } from '@nestjs/common';
import type {
  AgentMissionFingerprint,
  AgentMissionFingerprintPort,
} from '@bob/core';

export const AGENT_MISSION_FINGERPRINTS = Symbol('AGENT_MISSION_FINGERPRINTS');

/**
 * Garde de composition M1-A : aucun secret improvisé, aucune empreinte non signée. La future
 * activation remplacera ce provider par le keyring versionné demandé dans la spec ; une
 * configuration absente ou partielle continuera de retourner `null` et donc d'échouer fermée.
 */
@Injectable()
export class UnavailableAgentMissionFingerprints implements AgentMissionFingerprintPort {
  sign(): AgentMissionFingerprint | null {
    return null;
  }

  matches(): boolean | null {
    return null;
  }
}

export const agentMissionFingerprintProvider: Provider = {
  provide: AGENT_MISSION_FINGERPRINTS,
  useClass: UnavailableAgentMissionFingerprints,
};
