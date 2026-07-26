import { ok, type AppError, type Result } from '@bob/core';

export const AGENT_MISSION_PROTOCOL_VERSION = 1 as const;

export type RealtimeAgentMissionNegotiationRequest =
  | {
      readonly requested: 'omitted';
      readonly protocolVersion?: never;
    }
  | {
      readonly requested: 'null';
      readonly protocolVersion: null;
    }
  | {
      readonly requested: 'v1';
      readonly protocolVersion: typeof AGENT_MISSION_PROTOCOL_VERSION;
    };

/**
 * Décode uniquement la négociation wire. L'absence, `null` et V1 sont trois demandes distinctes :
 * les normaliser en une valeur optionnelle casserait le contrat N/N-1.
 */
export function parseRealtimeAgentMissionNegotiation(
  record: Readonly<Record<string, unknown>>,
): Result<RealtimeAgentMissionNegotiationRequest, AppError> {
  if (!Object.hasOwn(record, 'agentMissionProtocolVersion')) {
    return ok({ requested: 'omitted' });
  }
  if (record.agentMissionProtocolVersion === null) {
    return ok({ requested: 'null', protocolVersion: null });
  }
  if (record.agentMissionProtocolVersion === AGENT_MISSION_PROTOCOL_VERSION) {
    return ok({
      requested: 'v1',
      protocolVersion: AGENT_MISSION_PROTOCOL_VERSION,
    });
  }
  return {
    ok: false,
    error: {
      kind: 'validation',
      issues: [{
        field: 'agentMissionProtocolVersion',
        message: 'Version du protocole Mission Bob non supportée.',
      }],
    },
  };
}
