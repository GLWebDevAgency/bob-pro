import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_PROTOCOL_VERSION,
  parseRealtimeAgentMissionNegotiation,
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
});
