import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics';

describe('Metrics — contrats AgentMission bornés', () => {
  it('expose exactement les quatre familles et leurs labels à cardinalité finie', async () => {
    const metrics = new Metrics();

    metrics.agentMissionNegotiations.inc({
      requested: 'v1',
      outcome: 'accepted',
      provider: 'openai',
      transport: 'webrtc',
    });
    metrics.agentMissionCapabilityRejections.inc({
      operation: 'screen_ack',
      reason: 'hash_mismatch',
    });
    metrics.agentMissionBootstrapReceipts.inc({ outcome: 'acknowledged' });
    metrics.agentMissionScreenAcks.inc({ outcome: 'context_stale' });

    expect(await metrics.registry.getMetricsAsJSON()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'bob_agent_mission_negotiations_total',
        values: expect.arrayContaining([expect.objectContaining({
          labels: {
            requested: 'v1',
            outcome: 'accepted',
            provider: 'openai',
            transport: 'webrtc',
          },
        })]),
      }),
      expect.objectContaining({
        name: 'bob_agent_mission_capability_rejections_total',
        values: expect.arrayContaining([expect.objectContaining({
          labels: {
            operation: 'screen_ack',
            reason: 'hash_mismatch',
          },
        })]),
      }),
      expect.objectContaining({
        name: 'bob_agent_mission_bootstrap_receipts_total',
        values: expect.arrayContaining([expect.objectContaining({
          labels: { outcome: 'acknowledged' },
        })]),
      }),
      expect.objectContaining({
        name: 'bob_agent_mission_screen_ack_total',
        values: expect.arrayContaining([expect.objectContaining({
          labels: { outcome: 'context_stale' },
        })]),
      }),
    ]));
  });
});
