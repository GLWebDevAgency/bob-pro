import { describe, expect, it, vi } from 'vitest';
import { requestContext } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import {
  agentMissionPrincipalBindingHash,
} from '../voice/realtime/realtime-agent-mission-admission';
import {
  hashRealtimeAgentMissionCapability,
} from '../voice/realtime/realtime-agent-mission-negotiation';
import {
  admissionSubjectHash,
} from '../voice/realtime/realtime-principal-binding';
import type { RealtimeVoiceSettings } from '../voice/realtime/realtime.types';
import {
  DurableAgentMissionHttpAuthority,
  agentMissionCapabilityMetricOperation,
  type AgentMissionHttpOperation,
} from './agent-mission-http-authority';

const CURRENT_SUBJECT_SECRET = 'c'.repeat(32);
const PREVIOUS_SUBJECT_SECRET = 'p'.repeat(32);
const CAPABILITY = `bam1_${Buffer.alloc(32, 7).toString('base64url')}`;
const CAPABILITY_V2 = `bam2_${Buffer.alloc(32, 8).toString('base64url')}`;

function settings(
  overrides: Partial<RealtimeVoiceSettings> = {},
): RealtimeVoiceSettings {
  return {
    enabled: true,
    provider: 'openai',
    speechDelivery: 'audited-signed-url-v1',
    model: 'gpt-realtime',
    voice: 'marin',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    safetySecret: CURRENT_SUBJECT_SECRET,
    subjectKeyVersion: 2,
    subjectHmacKeyRing: Object.freeze([
      Object.freeze({ version: 1, secret: PREVIOUS_SUBJECT_SECRET }),
      Object.freeze({ version: 2, secret: CURRENT_SUBJECT_SECRET }),
    ]),
    providerTimeoutMs: 4_000,
    sidebandTimeoutMs: 3_000,
    maxSessionSeconds: 900,
    heartbeatSeconds: 10,
    maxCallsPerMinute: 3,
    auditProvider: 'local-whisper',
    localAuditBaseUrl: 'http://127.0.0.1:8080/v1',
    localAuditToken: 'a'.repeat(32),
    mistralTargetDelayMs: 240,
    mistralWebsocketUrl: 'ws://127.0.0.1:3000/v1/voice/realtime/mistral',
    mistralV2InitialBootstrapEnabled: false,
    ...overrides,
  };
}

function metricHarness(): {
  readonly metrics: Pick<Metrics, 'agentMissionCapabilityRejections'>;
  readonly inc: ReturnType<typeof vi.fn>;
} {
  const inc = vi.fn();
  return {
    metrics: {
      agentMissionCapabilityRejections: { inc },
    } as unknown as Pick<Metrics, 'agentMissionCapabilityRejections'>,
    inc,
  };
}

function prepareAs(
  authority: DurableAgentMissionHttpAuthority,
  principal: { userId: string; companyId: string | null } | undefined,
  capability: unknown,
  operation: AgentMissionHttpOperation = 'start_quote_creation',
) {
  return requestContext.run(
    {
      correlationId: 'agent-mission-http-authority-test',
      ...(principal === undefined ? {} : { principal }),
    },
    () => authority.prepare(operation, capability),
  );
}

describe('AgentMission HTTP authority', () => {
  it('dérive owner, hashes courant/historique et hash capability uniquement côté serveur', () => {
    const { metrics, inc } = metricHarness();
    const authority = new DurableAgentMissionHttpAuthority(settings(), metrics);

    const result = prepareAs(authority, {
      companyId: 'company-1',
      userId: 'user-1',
    }, CAPABILITY);

    expect(result).toEqual({
      ok: true,
      value: {
        operation: 'start_quote_creation',
        owner: {
          companyId: 'company-1',
          ownerUserId: 'user-1',
        },
        proof: {
          protocolVersion: 1,
          subjectHashCandidates: [
            admissionSubjectHash(CURRENT_SUBJECT_SECRET, 'company-1', 'user-1'),
            admissionSubjectHash(PREVIOUS_SUBJECT_SECRET, 'company-1', 'user-1'),
          ],
          principalBindingHash: agentMissionPrincipalBindingHash(
            'company-1',
            'user-1',
          ),
          capabilityHash: hashRealtimeAgentMissionCapability(CAPABILITY),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(CAPABILITY);
    expect(inc).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { companyId: null, userId: 'user-1' },
    { companyId: ' company-1', userId: 'user-1' },
    { companyId: 'company-1', userId: '' },
    { companyId: 'company-1', userId: ' user-1' },
    { companyId: 'company-1', userId: 'user-1 ' },
    { companyId: 'company-1', userId: 'user\u0000one' },
    { companyId: 'company-1', userId: 'é'.repeat(257) },
  ] as const)(
    'refuse un principal absent ou non canonique avant toute inspection de capability',
    (principal) => {
      const { metrics, inc } = metricHarness();
      const authority = new DurableAgentMissionHttpAuthority(settings(), metrics);

      expect(prepareAs(authority, principal, CAPABILITY)).toEqual({
        ok: false,
        error: {
          kind: 'forbidden',
          reason: 'authenticated_agent_mission_owner_required',
        },
      });
      expect(inc).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    '',
    `bam1_${'a'.repeat(42)}`,
    `bam1_${'a'.repeat(44)}`,
    `${CAPABILITY}=`,
    ` ${CAPABILITY}`,
    `${CAPABILITY} `,
    `${CAPABILITY},${CAPABILITY}`,
    ['duplicated', CAPABILITY],
    `BAM1_${CAPABILITY.slice(5)}`,
    `bam1_${'+'.repeat(43)}`,
  ])('refuse toute forme non canonique comme malformed sans jamais la mesurer', (candidate) => {
    const { metrics, inc } = metricHarness();
    const authority = new DurableAgentMissionHttpAuthority(settings(), metrics);

    expect(prepareAs(authority, {
      companyId: 'company-1',
      userId: 'user-1',
    }, candidate)).toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'agent_mission_capability_invalid' },
    });
    expect(inc).toHaveBeenCalledOnce();
    expect(inc).toHaveBeenCalledWith({ operation: 'start', reason: 'malformed' });
    if (String(candidate).length > 0) {
      expect(JSON.stringify(inc.mock.calls)).not.toContain(String(candidate));
    }
  });

  it('distingue uniquement le header absent dans la taxonomie métrique bornée', () => {
    const { metrics, inc } = metricHarness();
    const authority = new DurableAgentMissionHttpAuthority(settings(), metrics);

    expect(prepareAs(authority, {
      companyId: 'company-1',
      userId: 'user-1',
    }, undefined)).toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'agent_mission_capability_invalid' },
    });
    expect(inc).toHaveBeenCalledWith({ operation: 'start', reason: 'missing' });
  });

  it('échoue indisponible si le keyring sujet résolu ne peut pas dériver les bindings', () => {
    const { metrics, inc } = metricHarness();
    const authority = new DurableAgentMissionHttpAuthority(
      settings({ safetySecret: null, subjectHmacKeyRing: [] }),
      metrics,
    );

    expect(prepareAs(authority, {
      companyId: 'company-1',
      userId: 'user-1',
    }, CAPABILITY)).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'agent_mission_http_capability' },
    });
    expect(inc).not.toHaveBeenCalled();
  });

  it.each([
    'stage_quote_lines',
    'decide_catalogue_choice',
    'patch_quote_line',
    'cancel_pending_quote_line',
    'decide_quote_line_proposal',
  ] as const)('refuse bam1 sur la surface M2-A avant toute lecture métier (%s)', (operation) => {
    const { metrics, inc } = metricHarness();
    const authority = new DurableAgentMissionHttpAuthority(settings(), metrics);

    expect(prepareAs(authority, {
      companyId: 'company-1',
      userId: 'user-1',
    }, CAPABILITY, operation)).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_protocol',
        reason: 'upgrade_required',
      },
    });
    expect(inc).toHaveBeenCalledWith({
      operation: agentMissionCapabilityMetricOperation(operation),
      reason: 'state',
    });
  });

  it.each([
    'stage_quote_lines',
    'decide_catalogue_choice',
    'patch_quote_line',
    'cancel_pending_quote_line',
    'decide_quote_line_proposal',
  ] as const)('accepte bam2 sur la surface M2-A (%s)', (operation) => {
    const { metrics, inc } = metricHarness();
    const authority = new DurableAgentMissionHttpAuthority(settings(), metrics);

    const result = prepareAs(authority, {
      companyId: 'company-1',
      userId: 'user-1',
    }, CAPABILITY_V2, operation);
    expect(result).toMatchObject({
      ok: true,
      value: {
        operation,
        proof: { protocolVersion: 2 },
      },
    });
    expect(inc).not.toHaveBeenCalled();
  });

  it('borne exhaustivement les opérations historiques et M2-A', () => {
    expect([
      agentMissionCapabilityMetricOperation('get_current_quote_creation'),
      agentMissionCapabilityMetricOperation('start_quote_creation'),
      agentMissionCapabilityMetricOperation('cancel_quote_creation'),
      agentMissionCapabilityMetricOperation('acknowledge_quote_screen'),
      agentMissionCapabilityMetricOperation('decide_quote_creation'),
      agentMissionCapabilityMetricOperation('stage_quote_lines'),
      agentMissionCapabilityMetricOperation('decide_catalogue_choice'),
      agentMissionCapabilityMetricOperation('patch_quote_line'),
      agentMissionCapabilityMetricOperation('cancel_pending_quote_line'),
      agentMissionCapabilityMetricOperation('decide_quote_line_proposal'),
    ]).toEqual([
      'get',
      'start',
      'cancel',
      'screen_ack',
      'decision',
      'line_stage',
      'catalogue_choice',
      'line_patch',
      'line_cancel',
      'line_decision',
    ]);
  });
});
