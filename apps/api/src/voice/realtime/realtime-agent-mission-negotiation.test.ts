import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_PROTOCOL_M2A_VERSION,
  AGENT_MISSION_PROTOCOL_VERSION,
  hashRealtimeAgentMissionCapability,
  isRealtimeAgentMissionCapability,
  issueRealtimeAgentMissionCapability,
  parseRealtimeAgentMissionNegotiation,
  realtimeAgentMissionCapabilityProtocolVersion,
  realtimeAgentMissionBootstrapBinding,
} from './realtime-agent-mission-negotiation';

describe('négociation AgentMission Bob Live', () => {
  it('distingue strictement omission, null explicite, V1 et V2', () => {
    expect(parseRealtimeAgentMissionNegotiation({})).toEqual({
      ok: true,
      value: { requested: 'omitted' },
    });
    expect(parseRealtimeAgentMissionNegotiation({
      agentMissionProtocolVersion: null,
    })).toEqual({
      ok: true,
      value: { requested: 'null', protocolVersion: null },
    });
    expect(parseRealtimeAgentMissionNegotiation({
      agentMissionProtocolVersion: AGENT_MISSION_PROTOCOL_VERSION,
    })).toEqual({
      ok: true,
      value: { requested: 'v1', protocolVersion: AGENT_MISSION_PROTOCOL_VERSION },
    });
    expect(parseRealtimeAgentMissionNegotiation({
      agentMissionProtocolVersion: AGENT_MISSION_PROTOCOL_M2A_VERSION,
    })).toEqual({
      ok: true,
      value: {
        requested: 'v2',
        protocolVersion: AGENT_MISSION_PROTOCOL_M2A_VERSION,
      },
    });
  });

  it.each([
    undefined,
    0,
    3,
    99,
    '1',
    true,
    {},
  ])('refuse une valeur présente mais inconnue (%j)', (agentMissionProtocolVersion) => {
    expect(parseRealtimeAgentMissionNegotiation({
      agentMissionProtocolVersion,
    })).toMatchObject({
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'agentMissionProtocolVersion' }],
      },
    });
  });

  it('émet uniquement omission, null/null ou la version corrélée à sa capability', () => {
    const capabilityV1 = `bam1_${Buffer.alloc(32, 1).toString('base64url')}`;
    const capabilityV2 = `bam2_${Buffer.alloc(32, 2).toString('base64url')}`;
    expect(realtimeAgentMissionBootstrapBinding({ requested: 'omitted' })).toEqual({});
    expect(realtimeAgentMissionBootstrapBinding({
      requested: 'null',
      protocolVersion: null,
    })).toEqual({
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
    });
    expect(realtimeAgentMissionBootstrapBinding({
      requested: 'v1',
      protocolVersion: 1,
    })).toEqual({
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
    });
    expect(realtimeAgentMissionBootstrapBinding({
      requested: 'v1',
      protocolVersion: 1,
    }, capabilityV1)).toEqual({
      agentMissionProtocolVersion: 1,
      agentMissionCapability: capabilityV1,
    });
    expect(realtimeAgentMissionBootstrapBinding({
      requested: 'v2',
      protocolVersion: 2,
    }, capabilityV2)).toEqual({
      agentMissionProtocolVersion: 2,
      agentMissionCapability: capabilityV2,
    });
  });

  it('refuse d’attacher une capability à une demande omise ou explicitement nulle', () => {
    const capability = `bam1_${Buffer.alloc(32, 2).toString('base64url')}`;
    expect(() => realtimeAgentMissionBootstrapBinding(
      { requested: 'omitted' },
      capability,
    )).toThrow(/omitted negotiation/u);
    expect(() => realtimeAgentMissionBootstrapBinding(
      { requested: 'null', protocolVersion: null },
      capability,
    )).toThrow(/null negotiation/u);
  });

  it('refuse de croiser une capability V1 avec V2 et réciproquement', () => {
    const capabilityV1 = `bam1_${Buffer.alloc(32, 3).toString('base64url')}`;
    const capabilityV2 = `bam2_${Buffer.alloc(32, 4).toString('base64url')}`;
    expect(() => realtimeAgentMissionBootstrapBinding({
      requested: 'v2',
      protocolVersion: 2,
    }, capabilityV1)).toThrow(/protocol does not match/u);
    expect(() => realtimeAgentMissionBootstrapBinding({
      requested: 'v1',
      protocolVersion: 1,
    }, capabilityV2)).toThrow(/protocol does not match/u);
  });

  it('génère 256 bits canoniques versionnés et ne conserve que leur SHA-256', () => {
    const entropy = () => Uint8Array.from(
      { length: 32 },
      (_, index) => index,
    );
    const issuedV1 = issueRealtimeAgentMissionCapability(entropy);
    const issuedV2 = issueRealtimeAgentMissionCapability(
      AGENT_MISSION_PROTOCOL_M2A_VERSION,
      entropy,
    );
    expect(issuedV1.capability).toBe(
      'bam1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    );
    expect(issuedV2.capability).toBe(
      'bam2_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    );
    for (const [version, issued] of [[1, issuedV1], [2, issuedV2]] as const) {
      expect(isRealtimeAgentMissionCapability(issued.capability)).toBe(true);
      expect(realtimeAgentMissionCapabilityProtocolVersion(issued.capability)).toBe(version);
      expect(issued.capabilityHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(issued.capabilityHash).toBe(
        hashRealtimeAgentMissionCapability(issued.capability),
      );
    }
    expect(issuedV1.capabilityHash).not.toBe(issuedV2.capabilityHash);
  });

  it('refuse toute capability ou entropie non canonique', () => {
    expect(isRealtimeAgentMissionCapability('bam1_capability')).toBe(false);
    expect(isRealtimeAgentMissionCapability(
      `bam1_${Buffer.alloc(31, 1).toString('base64url')}`,
    )).toBe(false);
    expect(isRealtimeAgentMissionCapability(
      `bam2_${Buffer.alloc(33, 1).toString('base64url')}`,
    )).toBe(false);
    expect(realtimeAgentMissionCapabilityProtocolVersion('bam3_inconnue')).toBeNull();
    expect(() => realtimeAgentMissionBootstrapBinding({
      requested: 'v1',
      protocolVersion: 1,
    }, 'bam1_capability')).toThrow(/canonical 256-bit/u);
    expect(() => hashRealtimeAgentMissionCapability('bam1_capability'))
      .toThrow(/malformed/u);
    expect(() => issueRealtimeAgentMissionCapability(() => new Uint8Array(31)))
      .toThrow(/exactly 32 bytes/u);
    expect(() => issueRealtimeAgentMissionCapability(
      3 as never,
      () => new Uint8Array(32),
    )).toThrow(/unsupported/u);
  });
});
