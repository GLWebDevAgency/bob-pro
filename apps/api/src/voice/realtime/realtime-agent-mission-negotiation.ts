import { createHash, randomBytes } from 'node:crypto';
import { ok, type AppError, type Result } from '@bob/core';

export const AGENT_MISSION_PROTOCOL_VERSIONS = [
  1,
] as const;
export const AGENT_MISSION_PROTOCOL_VERSION = AGENT_MISSION_PROTOCOL_VERSIONS[0];
const AGENT_MISSION_CAPABILITY_PREFIX = 'bam1_';
const AGENT_MISSION_CAPABILITY_PAYLOAD = /^[A-Za-z0-9_-]{43}$/u;

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

export type RealtimeAgentMissionBootstrapBinding =
  | {
      readonly agentMissionProtocolVersion?: never;
      readonly agentMissionCapability?: never;
    }
  | {
      readonly agentMissionProtocolVersion: null;
      readonly agentMissionCapability: null;
    }
  | {
      readonly agentMissionProtocolVersion: typeof AGENT_MISSION_PROTOCOL_VERSION;
      readonly agentMissionCapability: string;
    };

export interface IssuedRealtimeAgentMissionCapability {
  readonly capability: string;
  readonly capabilityHash: string;
}

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

/**
 * Construit la paire wire corrélée. Tant que l'autorité durable n'a pas accepté V1, une demande
 * explicite reçoit toujours `null/null` ; seul un client N qui omet le champ reçoit la forme
 * historique sans clés nouvelles.
 */
export function realtimeAgentMissionBootstrapBinding(
  request: RealtimeAgentMissionNegotiationRequest,
  acceptedCapability: string | null = null,
): RealtimeAgentMissionBootstrapBinding {
  if (request.requested === 'omitted') {
    if (acceptedCapability !== null) {
      throw new Error('Cannot attach an AgentMission capability to an omitted negotiation.');
    }
    return Object.freeze({});
  }
  if (request.requested === 'null') {
    if (acceptedCapability !== null) {
      throw new Error('Cannot attach an AgentMission capability to an explicit null negotiation.');
    }
    return Object.freeze({
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
    });
  }
  if (acceptedCapability === null) {
    return Object.freeze({
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
    });
  }
  if (!isRealtimeAgentMissionCapability(acceptedCapability)) {
    throw new Error('AgentMission capability must be a canonical 256-bit bam1 token.');
  }
  return Object.freeze({
    agentMissionProtocolVersion: AGENT_MISSION_PROTOCOL_VERSION,
    agentMissionCapability: acceptedCapability,
  });
}

export function isRealtimeAgentMissionCapability(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !value.startsWith(AGENT_MISSION_CAPABILITY_PREFIX)
  ) return false;
  const payload = value.slice(AGENT_MISSION_CAPABILITY_PREFIX.length);
  if (!AGENT_MISSION_CAPABILITY_PAYLOAD.test(payload)) return false;
  const bytes = Buffer.from(payload, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === payload;
}

export function hashRealtimeAgentMissionCapability(capability: string): string {
  if (!isRealtimeAgentMissionCapability(capability)) {
    throw new Error('AgentMission capability is malformed.');
  }
  return createHash('sha256').update(capability, 'utf8').digest('hex');
}

export function issueRealtimeAgentMissionCapability(
  entropy: () => Uint8Array = () => randomBytes(32),
): IssuedRealtimeAgentMissionCapability {
  const source = entropy();
  if (!(source instanceof Uint8Array) || source.byteLength !== 32) {
    throw new Error('AgentMission capability entropy must contain exactly 32 bytes.');
  }
  const bytes = Buffer.from(source);
  try {
    const capability = `${AGENT_MISSION_CAPABILITY_PREFIX}${bytes.toString('base64url')}`;
    if (!isRealtimeAgentMissionCapability(capability)) {
      throw new Error('AgentMission capability generation produced a non-canonical token.');
    }
    return Object.freeze({
      capability,
      capabilityHash: hashRealtimeAgentMissionCapability(capability),
    });
  } finally {
    bytes.fill(0);
  }
}
