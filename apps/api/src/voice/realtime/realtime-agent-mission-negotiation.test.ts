import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_PROTOCOL_VERSION,
  hashRealtimeAgentMissionCapability,
  isRealtimeAgentMissionCapability,
  issueRealtimeAgentMissionCapability,
  parseRealtimeAgentMissionNegotiation,
  realtimeAgentMissionBootstrapBinding,
} from './realtime-agent-mission-negotiation';

describe('négociation AgentMission Bob Live', () => {
  it('distingue strictement omission, null explicite et V1', () => {
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
  });

  it.each([
    undefined,
    0,
    2,
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

  it('émet uniquement omission, null/null ou V1/capability', () => {
    const capability = `bam1_${Buffer.alloc(32, 1).toString('base64url')}`;
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
    }, capability)).toEqual({
      agentMissionProtocolVersion: 1,
      agentMissionCapability: capability,
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

  it('génère 256 bits canoniques et ne conserve que leur SHA-256', () => {
    const issued = issueRealtimeAgentMissionCapability(() => Uint8Array.from(
      { length: 32 },
      (_, index) => index,
    ));
    expect(issued.capability).toBe(
      'bam1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    );
    expect(isRealtimeAgentMissionCapability(issued.capability)).toBe(true);
    expect(issued.capabilityHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(issued.capabilityHash).toBe(
      hashRealtimeAgentMissionCapability(issued.capability),
    );
  });

  it('refuse toute capability ou entropie non canonique', () => {
    expect(isRealtimeAgentMissionCapability('bam1_capability')).toBe(false);
    expect(isRealtimeAgentMissionCapability(
      `bam1_${Buffer.alloc(31, 1).toString('base64url')}`,
    )).toBe(false);
    expect(() => realtimeAgentMissionBootstrapBinding({
      requested: 'v1',
      protocolVersion: 1,
    }, 'bam1_capability')).toThrow(/canonical 256-bit/u);
    expect(() => hashRealtimeAgentMissionCapability('bam1_capability'))
      .toThrow(/malformed/u);
    expect(() => issueRealtimeAgentMissionCapability(() => new Uint8Array(31)))
      .toThrow(/exactly 32 bytes/u);
  });
});
