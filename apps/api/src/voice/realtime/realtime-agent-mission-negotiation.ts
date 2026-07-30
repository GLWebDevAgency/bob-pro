import { createHash, randomBytes } from 'node:crypto';
import {
  AGENT_MISSION_PROTOCOL_M2A,
  AGENT_MISSION_PROTOCOL_V1,
  AGENT_MISSION_PROTOCOL_VERSIONS as CORE_AGENT_MISSION_PROTOCOL_VERSIONS,
  ok,
  type AgentMissionProtocolVersion,
  type AppError,
  type Result,
} from '@bob/core';

export const AGENT_MISSION_PROTOCOL_VERSIONS = CORE_AGENT_MISSION_PROTOCOL_VERSIONS;
export type { AgentMissionProtocolVersion };
/** Version encore demandée par le mobile publié pendant les trains M2-A-1/M2-A-2. */
export const AGENT_MISSION_PROTOCOL_VERSION = AGENT_MISSION_PROTOCOL_V1;
export const AGENT_MISSION_PROTOCOL_M2A_VERSION = AGENT_MISSION_PROTOCOL_M2A;
const AGENT_MISSION_CAPABILITY_PREFIXES = {
  1: 'bam1_',
  2: 'bam2_',
} as const satisfies Record<AgentMissionProtocolVersion, string>;
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
    }
  | {
      readonly requested: 'v2';
      readonly protocolVersion: typeof AGENT_MISSION_PROTOCOL_M2A_VERSION;
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
      readonly agentMissionProtocolVersion: AgentMissionProtocolVersion;
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
  if (record.agentMissionProtocolVersion === AGENT_MISSION_PROTOCOL_M2A_VERSION) {
    return ok({
      requested: 'v2',
      protocolVersion: AGENT_MISSION_PROTOCOL_M2A_VERSION,
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
    throw new Error('AgentMission capability must be a canonical 256-bit token.');
  }
  if (
    realtimeAgentMissionCapabilityProtocolVersion(acceptedCapability)
    !== request.protocolVersion
  ) {
    throw new Error('AgentMission capability protocol does not match negotiation.');
  }
  return Object.freeze({
    agentMissionProtocolVersion: request.protocolVersion,
    agentMissionCapability: acceptedCapability,
  });
}

export function isRealtimeAgentMissionCapability(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const version = realtimeAgentMissionCapabilityProtocolVersion(value);
  if (version === null) return false;
  const payload = value.slice(AGENT_MISSION_CAPABILITY_PREFIXES[version].length);
  if (!AGENT_MISSION_CAPABILITY_PAYLOAD.test(payload)) return false;
  const bytes = Buffer.from(payload, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === payload;
}

export function realtimeAgentMissionCapabilityProtocolVersion(
  capability: string,
): AgentMissionProtocolVersion | null {
  if (capability.startsWith(AGENT_MISSION_CAPABILITY_PREFIXES[1])) return 1;
  if (capability.startsWith(AGENT_MISSION_CAPABILITY_PREFIXES[2])) return 2;
  return null;
}

export function hashRealtimeAgentMissionCapability(capability: string): string {
  if (!isRealtimeAgentMissionCapability(capability)) {
    throw new Error('AgentMission capability is malformed.');
  }
  return createHash('sha256').update(capability, 'utf8').digest('hex');
}

export function issueRealtimeAgentMissionCapability(
  protocolVersionOrEntropy:
    | AgentMissionProtocolVersion
    | (() => Uint8Array) = AGENT_MISSION_PROTOCOL_VERSION,
  entropy: () => Uint8Array = () => randomBytes(32),
): IssuedRealtimeAgentMissionCapability {
  const protocolVersion = typeof protocolVersionOrEntropy === 'function'
    ? AGENT_MISSION_PROTOCOL_VERSION
    : protocolVersionOrEntropy;
  const entropySource = typeof protocolVersionOrEntropy === 'function'
    ? protocolVersionOrEntropy
    : entropy;
  if (!AGENT_MISSION_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    throw new Error('AgentMission capability protocol version is unsupported.');
  }
  const source = entropySource();
  if (!(source instanceof Uint8Array) || source.byteLength !== 32) {
    throw new Error('AgentMission capability entropy must contain exactly 32 bytes.');
  }
  const bytes = Buffer.from(source);
  try {
    const capability =
      `${AGENT_MISSION_CAPABILITY_PREFIXES[protocolVersion]}${bytes.toString('base64url')}`;
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
