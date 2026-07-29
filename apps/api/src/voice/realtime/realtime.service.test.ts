import { describe, expect, it, vi } from 'vitest';
import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import type { AppError, Result } from '@bob/core';
import { Metrics } from '../../observability/metrics';
import { requestContext, setPrincipal, type AppLogger } from '../../observability/logger';
import { InMemoryRealtimeAdmission } from './realtime-admission.testing';
import {
  type RealtimeAdmissionPolicy,
  type RealtimeAdmissionPort,
  prepareRealtimeContext,
} from './realtime-admission';
import {
  admissionSubjectHash,
  agentMissionNegotiationMetricLabels,
  RealtimeVoiceService,
  parseMistralRealtimeCallBody,
  parseRealtimeCallBody,
  parseRealtimeControlAcknowledgementBody,
  parseRealtimeContextBody,
  parseRealtimeResumeTicketBody,
  safetyIdentifier,
} from './realtime.service';
import { RealtimeProviderCallCompensatedError } from './openai-realtime-call.adapter';
import type { RealtimeSidebandControl } from './realtime-sideband';
import { deriveRealtimeTurnId } from './realtime-sideband';
import type { RealtimeDurableControlPort } from './realtime-control';
import type { RealtimeAgentTurnPort } from './realtime-agent-turn';
import {
  BOB_REALTIME_CONFIG_VERSION,
  BOB_REALTIME_CONFIG_VERSION_N_MINUS_ONE,
  type OpenAiRealtimeCallProvider,
  type RealtimeCallBootstrap,
  type RealtimeVoiceSettings,
} from './realtime.types';
import type { MistralRealtimeIngressTicketAuthority } from './realtime-mistral-ingress-ticket';
import {
  RealtimeProviderTerminationRegistry,
  realtimeProviderTerminationAdapter,
} from './realtime-provider-registry';
import { MistralRealtimeTerminationAuthority } from './mistral-realtime-termination';
import type { MistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';
import type { MistralConversationBootstrapTicketAuthority } from './mistral-conversation-bootstrap-ticket';
import {
  hashRealtimeAgentMissionCapability,
  type RealtimeAgentMissionNegotiationRequest,
} from './realtime-agent-mission-negotiation';
import {
  agentMissionPrincipalBindingHash,
  type RealtimeAgentMissionAdmissionGate,
} from './realtime-agent-mission-admission';

const OFFER_SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const AUDITED_BOOTSTRAP_BINDING = {
  configVersion: BOB_REALTIME_CONFIG_VERSION,
  speechDelivery: 'audited-signed-url-v1',
} as const;
const NATIVE_BOOTSTRAP_BINDING = {
  configVersion: BOB_REALTIME_CONFIG_VERSION,
  speechDelivery: 'openai-native-webrtc-v1',
} as const;
const SETTINGS: RealtimeVoiceSettings = {
  enabled: true,
  provider: 'openai',
  speechDelivery: 'audited-signed-url-v1',
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'server-only-key',
  safetySecret: 'safety-secret-at-least-thirty-two-characters',
  subjectKeyVersion: 1,
  providerTimeoutMs: 4_000,
  sidebandTimeoutMs: 3_000,
  maxSessionSeconds: 900,
  heartbeatSeconds: 10,
  maxCallsPerMinute: 3,
  auditProvider: 'openai',
  localAuditBaseUrl: null,
  localAuditToken: null,
  mistralTargetDelayMs: 240,
  mistralWebsocketUrl: 'ws://127.0.0.1:3000/v1/voice/realtime/mistral',
  mistralV2InitialBootstrapEnabled: false,
};

const MISTRAL_SETTINGS: RealtimeVoiceSettings = {
  ...SETTINGS,
  provider: 'mistral',
  model: 'voxtral-mini-transcribe-realtime-2602',
  baseUrl: 'wss://api.mistral.ai',
  apiKey: 'mistral-server-only-key',
  subjectKeyVersion: 7,
  mistralWebsocketUrl: 'wss://api.bob.example/v1/voice/realtime/mistral',
  mistralV2InitialBootstrapEnabled: false,
};

const ADMISSION_POLICY: RealtimeAdmissionPolicy = {
  globalCapacity: {
    providerId: 'openai', providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 1_000, providerMaxSessions: 1_000, configVersion: 1,
  },
  userLimitPerMinute: 3,
  userLimitPerHour: 30,
  tenantLimitPerMinute: 50,
  tenantLimitPerHour: 1_000,
  reservationTtlSeconds: 15,
  activeLeaseSeconds: 30,
  heartbeatSeconds: 10,
  reaperLeaseSeconds: 30,
};

function admission(userLimitPerMinute = 3, now: () => number = Date.now): InMemoryRealtimeAdmission {
  return new InMemoryRealtimeAdmission({ ...ADMISSION_POLICY, userLimitPerMinute }, now);
}

function loggerStub(): AppLogger {
  return { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;
}

function entitled() {
  return { check: vi.fn(async () => ({ allowed: true, plan: 'business' as const })) };
}

function resumeAuthority(
  issue: MistralConversationResumeAuthority['issue'],
): MistralConversationResumeAuthority {
  return {
    issue,
    reconcileInitialBootstrap: vi.fn(async () => ({ status: 'unavailable' as const })),
    redeemAndOpen: vi.fn(async () => ({ status: 'unavailable' as const })),
    acknowledgeTerminal: vi.fn(async () => ({ status: 'unavailable' as const })),
  };
}

const TEST_SPEECH_SOURCE_POLICY = {
  policyForSession: (companyId: string, sessionId: string) => ({
    mode: 'signed-url-v1' as const,
    allowedOrigin: 'https://project.supabase.co',
    allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/${companyId}/bob-live/${sessionId}/`,
  }),
};

function sidebandStub(options: { terminateAfterAttach?: boolean } = {}): RealtimeSidebandControl {
  const sessions = new Map<string, NonNullable<Parameters<RealtimeSidebandControl['attach']>[0]['lifecycle']>>();
  return {
    attach: vi.fn(async (input) => {
      if (!input.lifecycle) return;
      await input.lifecycle.activate();
      if (input.sessionHandle) sessions.set(input.sessionHandle, input.lifecycle);
      if (options.terminateAfterAttach) await input.lifecycle.terminate('user');
    }),
    contextChanged: vi.fn(),
    consumeAgentControl: vi.fn(async () => ({ status: 'not_found' as const })),
    closeForPrincipal: vi.fn(async () => undefined),
    fenceAndDetachSession: vi.fn(({ sessionHandle }) => {
      const lifecycle = sessions.get(sessionHandle);
      if (!lifecycle) return 'not_found' as const;
      lifecycle.fenceAfterDurableTerminationClaim();
      sessions.delete(sessionHandle);
      return 'detached' as const;
    }),
    closeSession: vi.fn(async ({ sessionHandle }) => {
      const lifecycle = sessions.get(sessionHandle);
      if (!lifecycle) return 'not_found' as const;
      const outcome = await lifecycle.terminate('user');
      sessions.delete(sessionHandle);
      return outcome;
    }),
  };
}

function runAsPrincipal<T>(
  fn: () => Promise<T>,
  principal: { userId: string; companyId: string } = { userId: 'user-1', companyId: 'company-1' },
): Promise<T> {
  return requestContext.run({ correlationId: 'test-correlation' }, async () => {
    setPrincipal(principal);
    return fn();
  });
}

function tracedAdmission(base: RealtimeAdmissionPort, order: string[]): RealtimeAdmissionPort {
  return {
    reserve: async (input) => { order.push('reserve'); return base.reserve(input); },
    bindProvider: async (input) => { order.push('bind'); return base.bindProvider(input); },
    activate: async (input) => { order.push('activate'); return base.activate(input); },
    renew: (input) => base.renew(input),
    release: async (input) => { order.push('release'); return base.release(input); },
    claimExpired: (input) => base.claimExpired(input),
    resolveSession: async (input) => {
      order.push('resolve');
      return base.resolveSession(input);
    },
    acknowledgeAgentMissionBootstrap: (input) => (
      base.acknowledgeAgentMissionBootstrap(input)
    ),
    claimTermination: (input) => base.claimTermination(input),
    completeReaping: (input) => base.completeReaping(input),
    updateContext: (input) => base.updateContext(input),
    readContext: (input) => base.readContext(input),
    acquire: (input) => base.acquire(input),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function successfulProviderCreate(callId: string) {
  return vi.fn<OpenAiRealtimeCallProvider['createCall']>(async (input) => {
    await input.onCallCreated(callId);
    return { answerSdp: OFFER_SDP, callId };
  });
}

function missionCapableAdmission(
  base: InMemoryRealtimeAdmission,
  order: string[] = [],
): RealtimeAdmissionPort {
  return {
    ...tracedAdmission(base, order),
    reserve: async (input) => {
      order.push('reserve');
      const binding = input.agentMissionBinding;
      const result = await base.reserve({
        ...input,
        agentMissionBinding: null,
      });
      if (!result.allowed) return result;
      return {
        ...result,
        agentMissionProof: binding === null
          ? null
          : {
              protocolVersion: binding.protocolVersion,
              capabilityHash: binding.capabilityHash,
              releaseFlagVersion: binding.releaseFlagVersion,
            },
      };
    },
  };
}

function missionGate(
  capability: string,
  requested: RealtimeAgentMissionNegotiationRequest['requested'] = 'v1',
): RealtimeAgentMissionAdmissionGate {
  return {
    prepare: vi.fn(async (input) => {
      if (input.negotiation.requested !== requested) {
        return { capability: null, binding: null } as const;
      }
      return {
        capability,
        binding: {
          protocolVersion: 1,
          capabilityHash: hashRealtimeAgentMissionCapability(capability),
          releaseFlagKey: 'bob.agent_missions.quote.v1',
          releaseEnvironment: 'staging',
          releaseFlagVersion: 7,
          principalBindingHash: agentMissionPrincipalBindingHash(
            input.companyId,
            input.userId,
          ),
        },
      } as const;
    }),
  };
}

function negotiationResult(
  binding:
    | Record<never, never>
    | { agentMissionProtocolVersion: null; agentMissionCapability: null }
    | { agentMissionProtocolVersion: 1; agentMissionCapability: string },
): Result<RealtimeCallBootstrap, AppError> {
  return {
    ok: true,
    value: {
      sessionHandle: '20000000-0000-4000-8000-000000000001',
      hardExpiresAt: '2026-07-26T12:15:00.000Z',
      model: 'gpt-realtime',
      voice: 'marin',
      configVersion: BOB_REALTIME_CONFIG_VERSION,
      maxSessionSeconds: 900,
      transport: 'webrtc',
      speechDelivery: 'openai-native-webrtc-v1',
      answerSdp: OFFER_SDP,
      ...binding,
    } as RealtimeCallBootstrap,
  };
}

describe('RealtimeVoiceService', () => {
  it('acquitte le bootstrap Mission avec l’identité dérivée et une métrique bornée', async () => {
    const capability = `bam1_${Buffer.alloc(32, 7).toString('base64url')}`;
    const acknowledgeAgentMissionBootstrap = vi
      .fn<RealtimeAdmissionPort['acknowledgeAgentMissionBootstrap']>()
      .mockResolvedValue({
        ok: true,
        status: 'acknowledged',
        acknowledgedAt: '2026-07-26T12:00:01.000Z',
        leaseExpiresAt: '2026-07-26T12:00:31.000Z',
      });
    const durable = {
      ...tracedAdmission(admission(), []),
      acknowledgeAgentMissionBootstrap,
    };
    const metrics = new Metrics();
    const logger = loggerStub();
    const service = new RealtimeVoiceService(
      SETTINGS,
      {
        createCall: vi.fn(),
        hangupCall: vi.fn(),
      },
      durable,
      sidebandStub(),
      metrics,
      logger,
    );

    await expect(runAsPrincipal(() => service.acknowledgeAgentMissionBootstrap(
      '20000000-0000-4000-8000-000000000001',
      capability,
    ))).resolves.toEqual({
      ok: true,
      value: { acknowledged: true, replayed: false },
    });
    expect(acknowledgeAgentMissionBootstrap).toHaveBeenCalledWith({
      companyId: 'company-1',
      subjectHashCandidates: [admissionSubjectHash(
        SETTINGS.safetySecret!,
        'company-1',
        'user-1',
      )],
      principalBindingHash: agentMissionPrincipalBindingHash(
        'company-1',
        'user-1',
      ),
      sessionId: '20000000-0000-4000-8000-000000000001',
      capabilityHash: hashRealtimeAgentMissionCapability(capability),
    });
    expect(logger.audit).toHaveBeenCalledWith(
      'bob.live.agent_mission.bootstrap_receipt',
      { outcome: 'acknowledged' },
    );
    const metric = (await metrics.registry.getMetricsAsJSON()).find(
      (candidate) => candidate.name === 'bob_agent_mission_bootstrap_receipts_total',
    );
    expect(metric?.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ labels: { outcome: 'acknowledged' } }),
    ]));
    expect(JSON.stringify(vi.mocked(logger.audit).mock.calls)).not.toContain(capability);
  });

  it.each([
    ['hash_mismatch', 'forbidden', 'refused'],
    ['expired', 'forbidden', 'refused'],
    ['unavailable', 'unavailable', 'error'],
  ] as const)('ferme le reçu %s sans exposer sa cause publique', async (
    reason,
    errorKind,
    metricOutcome,
  ) => {
    const capability = `bam1_${Buffer.alloc(32, 9).toString('base64url')}`;
    const durable = {
      ...tracedAdmission(admission(), []),
      acknowledgeAgentMissionBootstrap: vi
        .fn<RealtimeAdmissionPort['acknowledgeAgentMissionBootstrap']>()
        .mockResolvedValue({ ok: false, reason }),
    };
    const metrics = new Metrics();
    const service = new RealtimeVoiceService(
      SETTINGS,
      { createCall: vi.fn(), hangupCall: vi.fn() },
      durable,
      sidebandStub(),
      metrics,
      loggerStub(),
    );

    await expect(runAsPrincipal(() => service.acknowledgeAgentMissionBootstrap(
      '20000000-0000-4000-8000-000000000001',
      capability,
    ))).resolves.toMatchObject({
      ok: false,
      error: { kind: errorKind },
    });
    const metric = (await metrics.registry.getMetricsAsJSON()).find(
      (candidate) => candidate.name === 'bob_agent_mission_bootstrap_receipts_total',
    );
    expect(metric?.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ labels: { outcome: metricOutcome } }),
    ]));
  });

  it('borne les labels de négociation Mission sans secret, hash ni identité', () => {
    const capability = `bam1_${Buffer.alloc(32, 7).toString('base64url')}`;
    expect(agentMissionNegotiationMetricLabels(
      { agentMissionProtocolVersion: 1 },
      'openai',
      negotiationResult({
        agentMissionProtocolVersion: 1,
        agentMissionCapability: capability,
      }),
    )).toEqual({
      requested: 'v1',
      outcome: 'accepted',
      provider: 'openai',
      transport: 'webrtc',
    });
    expect(agentMissionNegotiationMetricLabels(
      { agentMissionProtocolVersion: 1 },
      'openai',
      negotiationResult({
        agentMissionProtocolVersion: null,
        agentMissionCapability: null,
      }),
    )).toEqual({
      requested: 'v1',
      outcome: 'refused',
      provider: 'openai',
      transport: 'webrtc',
    });
    expect(agentMissionNegotiationMetricLabels(
      {},
      'openai',
      negotiationResult({}),
    )).toEqual({
      requested: 'omitted',
      outcome: 'historical',
      provider: 'openai',
      transport: 'webrtc',
    });
    expect(agentMissionNegotiationMetricLabels(
      { agentMissionProtocolVersion: null },
      'openai',
      negotiationResult({
        agentMissionProtocolVersion: null,
        agentMissionCapability: null,
      }),
    )).toEqual({
      requested: 'null',
      outcome: 'historical',
      provider: 'openai',
      transport: 'webrtc',
    });
    expect(agentMissionNegotiationMetricLabels(
      { agentMissionProtocolVersion: 99 },
      'openai',
      {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{
            field: 'agentMissionProtocolVersion',
            message: 'unsupported',
          }],
        },
      },
    )).toEqual({
      requested: 'unknown',
      outcome: 'refused',
      provider: 'openai',
      transport: 'webrtc',
    });
    expect(agentMissionNegotiationMetricLabels(
      { agentMissionProtocolVersion: 1 },
      'mistral',
      negotiationResult({
        agentMissionProtocolVersion: null,
        agentMissionCapability: null,
      }),
    )).toEqual({
      requested: 'v1',
      outcome: 'refused',
      provider: 'mistral',
      transport: 'mistral_pcm',
    });
    expect(JSON.stringify(agentMissionNegotiationMetricLabels(
      { agentMissionProtocolVersion: 1 },
      'openai',
      negotiationResult({
        agentMissionProtocolVersion: 1,
        agentMissionCapability: capability,
      }),
    ))).not.toContain(capability);
  });

  it('rend la capability V1 uniquement après la preuve durable corrélée et avant aucun provider', async () => {
    const order: string[] = [];
    const capability = `bam1_${Buffer.alloc(32, 73).toString('base64url')}`;
    const gate = missionGate(capability);
    const base = admission();
    const reserve = missionCapableAdmission(base, order);
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(async (input) => {
        order.push('provider');
        await input.onCallCreated('rtc_agent_mission_v1');
        return { answerSdp: OFFER_SDP, callId: 'rtc_agent_mission_v1' };
      }),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      reserve,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      undefined,
      undefined,
      undefined,
      gate,
    );

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      agentMissionProtocolVersion: 1,
      sdp: OFFER_SDP,
    }));

    expect(result).toMatchObject({
      ok: true,
      value: {
        agentMissionProtocolVersion: 1,
        agentMissionCapability: capability,
      },
    });
    expect(order.indexOf('reserve')).toBeLessThan(order.indexOf('provider'));
    expect(gate.prepare).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'openai',
      transport: 'webrtc',
      speechDelivery: 'audited-signed-url-v1',
      companyId: 'company-1',
      userId: 'user-1',
    }));
    const serialized = JSON.stringify(result);
    expect(serialized.match(/bam1_[A-Za-z0-9_-]{43}/gu)).toEqual([capability]);
    if (result.ok) {
      await runAsPrincipal(() => service.hangup(result.value.sessionHandle));
    }
  });

  it('forme l’autorité Mission du tour uniquement depuis la lease et sa preuve serveur', async () => {
    const capability = `bam1_${Buffer.alloc(32, 76).toString('base64url')}`;
    const durable = missionCapableAdmission(admission());
    let attached: Parameters<RealtimeSidebandControl['attach']>[0] | undefined;
    const baseSideband = sidebandStub();
    const sideband: RealtimeSidebandControl = {
      ...baseSideband,
      attach: vi.fn(async (input) => {
        attached = input;
        await baseSideband.attach(input);
      }),
    };
    const runTurn = vi.fn<RealtimeAgentTurnPort['run']>().mockResolvedValue({
      status: 'failed',
      canonicalSpeech: 'Test.',
    });
    const service = new RealtimeVoiceService(
      SETTINGS,
      {
        createCall: successfulProviderCreate('rtc_agent_mission_turn_authority'),
        hangupCall: vi.fn(async () => undefined),
      },
      durable,
      sideband,
      new Metrics(),
      loggerStub(),
      { run: runTurn },
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      undefined,
      undefined,
      undefined,
      missionGate(capability),
    );

    const created = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      agentMissionProtocolVersion: 1,
      sdp: OFFER_SDP,
    }));
    if (!created.ok) throw new Error('bootstrap Mission attendu');
    const turnId = '10000000-0000-4000-8000-000000000077';
    await attached?.turn?.run({
      turnId,
      transcript: 'Crée un devis.',
      history: [],
      signal: new AbortController().signal,
    });

    const turnInput = runTurn.mock.calls[0]?.[0];
    expect(turnInput?.agentMissionAuthority).toEqual({
      owner: {
        companyId: 'company-1',
        ownerUserId: 'user-1',
      },
      proof: {
        subjectHashCandidates: [
          admissionSubjectHash(SETTINGS.safetySecret!, 'company-1', 'user-1'),
        ],
        principalBindingHash: agentMissionPrincipalBindingHash(
          'company-1',
          'user-1',
        ),
        capabilityHash: hashRealtimeAgentMissionCapability(capability),
      },
      realtimeSessionId: created.value.sessionHandle,
    });
    expect(turnInput?.turnId).toBe(turnId);
    expect(JSON.stringify(turnInput)).not.toContain(capability);

    await runAsPrincipal(() => service.hangup(created.value.sessionHandle));
  });

  it.each([
    {
      label: 'négociation omise',
      body: { ...AUDITED_BOOTSTRAP_BINDING, sdp: OFFER_SDP },
      requested: 'omitted' as const,
    },
    {
      label: 'négociation null',
      body: {
        ...AUDITED_BOOTSTRAP_BINDING,
        agentMissionProtocolVersion: null,
        sdp: OFFER_SDP,
      },
      requested: 'null' as const,
    },
  ])('libère la lease si un gate fautif injecte une capability sur $label', async ({
    body,
    requested,
  }) => {
    const capability = `bam1_${Buffer.alloc(32, 74).toString('base64url')}`;
    const gate = missionGate(capability, requested);
    const base = admission();
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      missionCapableAdmission(base),
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      undefined,
      undefined,
      undefined,
      gate,
    );

    await expect(runAsPrincipal(() => service.createCall(body))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-agent-mission-admission' },
    });
    expect(provider.createCall).not.toHaveBeenCalled();
    expect(base.snapshot().leases).toHaveLength(0);
  });

  it('valide strictement l’epoch et le curseur du ticket de reprise', () => {
    expect(parseRealtimeResumeTicketBody({
      missionConnectionEpoch: 3,
      nextServerSequence: 42,
    })).toEqual({
      ok: true,
      value: { missionConnectionEpoch: 3, nextServerSequence: 42 },
    });
    for (const body of [
      null,
      { missionConnectionEpoch: 0, nextServerSequence: 0 },
      { missionConnectionEpoch: 1, nextServerSequence: -0 },
      { missionConnectionEpoch: 1, nextServerSequence: 0, companyId: 'attacker' },
      { missionConnectionEpoch: 1, nextServerSequence: 0x1_0000_0001 },
    ]) expect(parseRealtimeResumeTicketBody(body)).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
  });

  it('émet uniquement une capacité terminale liée au principal et atteste sa completion', async () => {
    const sessionHandle = 'mistral_resume_session_0001';
    const issue = vi.fn<MistralConversationResumeAuthority['issue']>(async (input) => ({
      status: 'issued',
      bootstrap: {
        companyId: input.companyId,
        sessionHandle: input.sessionHandle,
        ticket: `r2_${'R'.repeat(43)}`,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        scope: 'terminal_replay',
        ticketExpiresAt: '2026-07-19T12:00:30.000Z',
        expectedMissionConnectionEpoch: 4,
        clientAcceptedMissionConnectionEpoch: input.clientAcceptedMissionConnectionEpoch,
        resumeNextServerSequence: input.resumeNextServerSequence,
      },
    }));
    const authority = resumeAuthority(issue);
    const logger = loggerStub();
    const service = new RealtimeVoiceService(
      MISTRAL_SETTINGS,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      admission(),
      sidebandStub(),
      new Metrics(),
      logger,
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      authority,
    );
    const signal = new AbortController().signal;

    await expect(runAsPrincipal(() => service.requestResumeTicket(sessionHandle, {
      missionConnectionEpoch: 3,
      nextServerSequence: 8,
    }, signal))).resolves.toEqual({
      ok: true,
      value: {
        status: 'issued',
        websocketUrl: MISTRAL_SETTINGS.mistralWebsocketUrl,
        companyId: 'company-1',
        sessionHandle,
        ticket: `r2_${'R'.repeat(43)}`,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        scope: 'terminal_replay',
        ticketExpiresAt: '2026-07-19T12:00:30.000Z',
        expectedMissionConnectionEpoch: 4,
        clientAcceptedMissionConnectionEpoch: 3,
        resumeNextServerSequence: 8,
      },
    });
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      subjectHash: admissionSubjectHash(
        MISTRAL_SETTINGS.safetySecret!,
        'company-1',
        'user-1',
      ),
      subjectKeyVersion: MISTRAL_SETTINGS.subjectKeyVersion,
      sessionHandle,
      clientAcceptedMissionConnectionEpoch: 3,
      resumeNextServerSequence: 8,
      signal,
    }));

    issue.mockResolvedValueOnce({
      status: 'terminal_complete',
      receipt: {
        companyId: 'company-1',
        sessionHandle,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        missionConnectionEpoch: 4,
        nextServerSequence: 12,
        reason: 'user',
        closedAt: '2026-07-19T12:00:00.000Z',
      },
    });
    await expect(runAsPrincipal(() => service.requestResumeTicket(sessionHandle, {
      missionConnectionEpoch: 4,
      nextServerSequence: 12,
    }, signal))).resolves.toEqual({
      ok: true,
      value: {
        status: 'terminal_complete',
        companyId: 'company-1',
        sessionHandle,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        missionConnectionEpoch: 4,
        nextServerSequence: 12,
        reason: 'user',
        closedAt: '2026-07-19T12:00:00.000Z',
      },
    });
    expect(logger.audit).toHaveBeenCalledWith(
      'bob.live.mistral.resume.terminal_complete',
      { sessionHandle },
    );

    issue.mockResolvedValueOnce({
      status: 'terminal_complete',
      receipt: {
        companyId: 'company-2',
        sessionHandle,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        missionConnectionEpoch: 4,
        nextServerSequence: 12,
        reason: 'user',
        closedAt: '2026-07-19T12:00:00.000Z',
      },
    });
    await expect(runAsPrincipal(() => service.requestResumeTicket(sessionHandle, {
      missionConnectionEpoch: 4,
      nextServerSequence: 12,
    }, signal))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-mistral-resume' },
    });
    issue.mockResolvedValueOnce({
      status: 'terminal_complete',
      receipt: {
        companyId: 'company-1',
        sessionHandle,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        missionConnectionEpoch: 5,
        nextServerSequence: 12,
        reason: 'user',
        closedAt: '2026-07-19T12:00:00.000Z',
      },
    });
    await expect(runAsPrincipal(() => service.requestResumeTicket(sessionHandle, {
      missionConnectionEpoch: 4,
      nextServerSequence: 12,
    }, signal))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-mistral-resume' },
    });
  });

  it('authentifie un reçu historique avec le keyring sujet après rotation', async () => {
    const sessionHandle = 'mistral_resume_rotated_0001';
    const previousSecret = 'previous-subject-secret-at-least-32-chars';
    const currentSecret = 'current-subject-secret-at-least-32-chars!!';
    const rotatedSettings: RealtimeVoiceSettings = {
      ...MISTRAL_SETTINGS,
      safetySecret: currentSecret,
      subjectKeyVersion: 8,
      subjectHmacKeyRing: [
        { version: 7, secret: previousSecret },
        { version: 8, secret: currentSecret },
      ],
    };
    const issue = vi.fn<MistralConversationResumeAuthority['issue']>(async (input) => {
      expect(input.subjectHash).toBe(admissionSubjectHash(
        currentSecret,
        'company-1',
        'user-1',
      ));
      expect(input.subjectKeyVersion).toBe(8);
      expect(input.historicalSubjectBindings).toEqual([{
        subjectHash: admissionSubjectHash(previousSecret, 'company-1', 'user-1'),
        subjectKeyVersion: 7,
      }]);
      return {
        status: 'terminal_complete',
        receipt: {
          companyId: 'company-1',
          sessionHandle,
          protocol: MISTRAL_CONVERSATION_PROTOCOL,
          missionConnectionEpoch: 4,
          nextServerSequence: 12,
          reason: 'user',
          closedAt: '2026-07-19T12:00:00.000Z',
        },
      };
    });
    const service = new RealtimeVoiceService(
      rotatedSettings,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      admission(),
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      resumeAuthority(issue),
    );

    await expect(runAsPrincipal(() => service.requestResumeTicket(sessionHandle, {
      missionConnectionEpoch: 4,
      nextServerSequence: 12,
    }, new AbortController().signal))).resolves.toMatchObject({
      ok: true,
      value: { status: 'terminal_complete', sessionHandle },
    });
    expect(issue).toHaveBeenCalledOnce();
  });

  it('refuse toute capacité live, toute fuite inter-tenant et le provider non Mistral', async () => {
    const sessionHandle = 'mistral_resume_session_0002';
    const issue = vi.fn<MistralConversationResumeAuthority['issue']>(async (input) => ({
      status: 'issued',
      bootstrap: {
        companyId: input.companyId,
        sessionHandle: input.sessionHandle,
        ticket: `r2_${'L'.repeat(43)}`,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        scope: 'live_takeover',
        ticketExpiresAt: '2026-07-19T12:00:30.000Z',
        expectedMissionConnectionEpoch: 4,
        clientAcceptedMissionConnectionEpoch: input.clientAcceptedMissionConnectionEpoch,
        resumeNextServerSequence: input.resumeNextServerSequence,
      },
    }));
    const authority = resumeAuthority(issue);
    const createService = (settings: RealtimeVoiceSettings) => new RealtimeVoiceService(
      settings,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      admission(),
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      authority,
    );
    const body = { missionConnectionEpoch: 3, nextServerSequence: 8 };

    await expect(runAsPrincipal(() => createService(MISTRAL_SETTINGS).requestResumeTicket(
      sessionHandle,
      body,
      new AbortController().signal,
    ))).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });

    issue.mockResolvedValueOnce({ status: 'forbidden' });
    await expect(runAsPrincipal(() => createService(MISTRAL_SETTINGS).requestResumeTicket(
      sessionHandle,
      body,
      new AbortController().signal,
    ))).resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });

    await expect(runAsPrincipal(() => createService(SETTINGS).requestResumeTicket(
      sessionHandle,
      body,
      new AbortController().signal,
    ))).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });

  it('ferme une connexion Mistral locale lors du hangup explicite', async () => {
    const now = Date.parse('2026-07-14T10:00:00.000Z');
    const durable = admission(3, () => now);
    const subjectHash = admissionSubjectHash(SETTINGS.safetySecret!, 'company-1', 'user-1');
    const reserved = await durable.reserve({
      companyId: 'company-1',
      subjectHash,
      sessionId: '00000000-0000-4000-8000-000000000040',
      maxSessionSeconds: 60,
      subjectHashCandidates: [subjectHash],
      principalBindingHash: subjectHash,
      agentMissionBinding: null,
    });
    if (!reserved.allowed) throw new Error('Mistral reservation expected.');
    const providerSessionId = 'mistral_explicit_local';
    await durable.bindProvider({
      ...reserved.lease,
      providerId: 'mistral',
      providerCallId: providerSessionId,
    });
    await durable.activate(reserved.lease);
    const close = vi.fn(async () => undefined);
    const terminations = new MistralRealtimeTerminationAuthority(() => now);
    terminations.register({
      connection: { providerSessionId, close },
      hardExpiresAt: reserved.lease.hardExpiresAt,
    });
    const registry = new RealtimeProviderTerminationRegistry([
      realtimeProviderTerminationAdapter('mistral', terminations),
    ]);
    const service = new RealtimeVoiceService(
      MISTRAL_SETTINGS,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      undefined,
      undefined,
      registry,
    );

    await expect(runAsPrincipal(() => service.hangup(reserved.lease.sessionId))).resolves.toEqual({
      ok: true,
      value: { ended: true },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(durable.snapshot().leases).toHaveLength(0);
  });

  it('reprend une réservation Mistral inter-réplique sans egress après le hard cap DB', async () => {
    let now = Date.parse('2026-07-14T10:00:00.000Z');
    const durable = admission(3, () => now);
    const subjectHash = admissionSubjectHash(SETTINGS.safetySecret!, 'company-1', 'user-1');
    const stale = await durable.reserve({
      companyId: 'company-1',
      subjectHash,
      sessionId: '00000000-0000-4000-8000-000000000041',
      maxSessionSeconds: 60,
      subjectHashCandidates: [subjectHash],
      principalBindingHash: subjectHash,
      agentMissionBinding: null,
    });
    if (!stale.allowed) throw new Error('Stale Mistral reservation expected.');
    await durable.bindProvider({
      ...stale.lease,
      providerId: 'mistral',
      providerCallId: 'mistral_remote_replica',
    });
    now = Date.parse(stale.lease.hardExpiresAt);

    const terminations = new MistralRealtimeTerminationAuthority(() => now);
    const registry = new RealtimeProviderTerminationRegistry([
      realtimeProviderTerminationAdapter('mistral', terminations),
    ]);
    const issue = vi.fn<MistralRealtimeIngressTicketAuthority['issue']>(async (input) => ({
      ok: true,
      bootstrap: {
        companyId: input.companyId,
        sessionId: input.sessionId,
        ticket: 'R'.repeat(43),
        protocol: 'bob.mistral-pcm.v1',
        ticketExpiresAt: new Date(now + 15_000).toISOString(),
        hardExpiresAt: new Date(now + MISTRAL_SETTINGS.maxSessionSeconds * 1_000).toISOString(),
        maxAudioBytes: 1_920_000,
        contextRevision: input.contextRevision,
        contextDigest: 'f'.repeat(64),
      },
    }));
    const service = new RealtimeVoiceService(
      MISTRAL_SETTINGS,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      { issue } as unknown as MistralRealtimeIngressTicketAuthority,
      registry,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      agentMissionProtocolVersion: null,
      sessionHandle: '00000000-0000-4000-8000-000000000042',
      context: {
        version: 1,
        revision: 1,
        context: {
          screen: { name: '/today', instanceId: 'today-1' },
          entities: [],
          capabilities: ['screen.read'],
        },
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      value: {
        transport: 'mistral-pcm',
        agentMissionProtocolVersion: null,
        agentMissionCapability: null,
      },
    });
    expect(issue).toHaveBeenCalledOnce();
    expect(terminations.state()).toEqual({ activeConnections: 0, terminalProofs: 1 });
    expect(durable.snapshot().leases).toEqual([
      expect.objectContaining({ sessionId: '00000000-0000-4000-8000-000000000042' }),
    ]);
  });

  it('émet un bootstrap PCM Mistral one-shot sans appeler OpenAI ni exposer de secret', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const sideband = sidebandStub();
    const issue = vi.fn<MistralRealtimeIngressTicketAuthority['issue']>(async (input) => ({
      ok: true,
      bootstrap: {
        companyId: input.companyId,
        sessionId: input.sessionId,
        ticket: 'T'.repeat(43),
        protocol: 'bob.mistral-pcm.v1',
        ticketExpiresAt: '2026-07-14T10:00:15.000Z',
        hardExpiresAt: '2026-07-14T10:15:00.000Z',
        maxAudioBytes: 28_800_000,
        contextRevision: input.contextRevision,
        contextDigest: 'd'.repeat(64),
      },
    }));
    const tickets = { issue } as unknown as MistralRealtimeIngressTicketAuthority;
    const service = new RealtimeVoiceService(
      MISTRAL_SETTINGS,
      provider,
      admission(),
      sideband,
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      tickets,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );
    const context = {
      version: 1,
      revision: 3,
      context: {
        screen: { name: '/devis/new', instanceId: 'quote-new-1' },
        entities: [],
        capabilities: ['screen.read'],
      },
    };

    const config = await runAsPrincipal(() => service.publicConfig());
    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      agentMissionProtocolVersion: 1,
      sessionHandle: '00000000-0000-4000-8000-000000000031',
      context,
    }));

    expect(config).toMatchObject({
      available: true,
      transport: 'mistral-pcm',
      protocol: 'bob.mistral-pcm.v1',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        transport: 'mistral-pcm',
        websocketUrl: MISTRAL_SETTINGS.mistralWebsocketUrl,
        companyId: 'company-1',
        ticket: 'T'.repeat(43),
        protocol: 'bob.mistral-pcm.v1',
        agentMissionProtocolVersion: null,
        agentMissionCapability: null,
        contextRevision: 3,
        contextDigest: 'd'.repeat(64),
        speechSourcePolicy: TEST_SPEECH_SOURCE_POLICY.policyForSession(
          'company-1',
          '00000000-0000-4000-8000-000000000031',
        ),
      },
    });
    expect(JSON.stringify(result)).not.toContain(String(MISTRAL_SETTINGS.apiKey));
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      companyId: 'company-1',
      subjectKeyVersion: 7,
      plan: 'business',
      contextSchemaVersion: 1,
      contextRevision: 3,
      context: context.context,
    }));
    expect(provider.createCall).not.toHaveBeenCalled();
    expect(sideband.attach).not.toHaveBeenCalled();
  });

  it('émet le bootstrap v2 durable explicite sans traverser le ticket v1', async () => {
    const settings: RealtimeVoiceSettings = {
      ...MISTRAL_SETTINGS,
      mistralV2InitialBootstrapEnabled: true,
    };
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const v1Issue = vi.fn<MistralRealtimeIngressTicketAuthority['issue']>();
    const ticket = `b2_${Buffer.alloc(32, 1).toString('base64url')}`;
    const issue = vi.fn<MistralConversationBootstrapTicketAuthority['issue']>(async (input) => ({
      status: 'issued',
      bootstrap: {
        companyId: input.lease.companyId,
        sessionHandle: input.lease.sessionId,
        ticket,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        ticketExpiresAt: '2026-07-19T10:00:30.000Z',
        hardExpiresAt: input.lease.hardExpiresAt,
        contextRevision: input.contextRevision,
        contextDigest: 'e'.repeat(64),
        routeMode: 'push_to_talk',
        fullDuplexCertified: false,
        maxMissionAudioBytes: 28_800_000,
      },
    }));
    const bootstrap = {
      issue,
      redeemAndOpenInitial: vi.fn(async () => ({ status: 'unavailable' as const })),
    } satisfies MistralConversationBootstrapTicketAuthority;
    const service = new RealtimeVoiceService(
      settings,
      provider,
      admission(),
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      { issue: v1Issue } as unknown as MistralRealtimeIngressTicketAuthority,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      undefined,
      bootstrap,
      { liveTurnsAvailable: true },
    );
    const context = {
      version: 1 as const,
      revision: 4,
      context: {
        screen: { name: '/devis/new', instanceId: 'quote-new-v2' },
        entities: [],
        capabilities: ['screen.read'],
      },
    };

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      sessionHandle: '00000000-0000-4000-8000-000000000033',
      context,
    }));

    await expect(runAsPrincipal(() => service.publicConfig())).resolves.toMatchObject({
      transport: 'mistral-pcm',
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        transport: 'mistral-pcm',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        ticket,
        sessionHandle: '00000000-0000-4000-8000-000000000033',
        contextRevision: 4,
        contextDigest: 'e'.repeat(64),
        routeMode: 'push_to_talk',
        fullDuplexCertified: false,
      },
    });
    if (!result.ok) throw new Error('bootstrap Mistral v2 attendu');
    expect(result.value).not.toHaveProperty('agentMissionProtocolVersion');
    expect(result.value).not.toHaveProperty('agentMissionCapability');
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      subjectKeyVersion: 7,
      plan: 'business',
      contextSchemaVersion: 1,
      contextRevision: 4,
      context: context.context,
    }));
    expect(v1Issue).not.toHaveBeenCalled();
    expect(provider.createCall).not.toHaveBeenCalled();
  });

  it('refuse le protocole v2 avant admission quand le canary initial est désactivé', async () => {
    const durable = admission();
    const reserve = vi.spyOn(durable, 'reserve');
    const entitlement = entitled();
    const bootstrapIssue = vi.fn<MistralConversationBootstrapTicketAuthority['issue']>();
    const service = new RealtimeVoiceService(
      MISTRAL_SETTINGS,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitlement,
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      undefined,
      {
        issue: bootstrapIssue,
        redeemAndOpenInitial: vi.fn(async () => ({ status: 'unavailable' as const })),
      },
    );

    await expect(runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      context: { version: 1, revision: 1, context: {} },
    }))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-mistral-v2-live-runtime' },
    });
    expect(entitlement.check).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(bootstrapIssue).not.toHaveBeenCalled();
  });

  it('n’annonce ni n’émet v2 quand seule la composition replay terminal est disponible', async () => {
    const settings: RealtimeVoiceSettings = {
      ...MISTRAL_SETTINGS,
      mistralV2InitialBootstrapEnabled: true,
    };
    const durable = admission();
    const reserve = vi.spyOn(durable, 'reserve');
    const entitlement = entitled();
    const bootstrapIssue = vi.fn<MistralConversationBootstrapTicketAuthority['issue']>();
    const service = new RealtimeVoiceService(
      settings,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitlement,
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      undefined,
      {
        issue: bootstrapIssue,
        redeemAndOpenInitial: vi.fn(async () => ({ status: 'unavailable' as const })),
      },
      { liveTurnsAvailable: false },
    );

    await expect(runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      context: { version: 1, revision: 1, context: {} },
    }))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-mistral-v2-live-runtime' },
    });
    expect(entitlement.check).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(bootstrapIssue).not.toHaveBeenCalled();
    await expect(runAsPrincipal(() => service.publicConfig())).resolves.toMatchObject({
      transport: 'mistral-pcm',
      protocol: 'bob.mistral-pcm.v1',
    });
  });

  it('rejette un bootstrap Mistral sans contexte exact et libère le bail si le ticket échoue', async () => {
    expect(parseMistralRealtimeCallBody({ sdp: OFFER_SDP, context: {} }))
      .toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(parseMistralRealtimeCallBody({ context: { version: 1, revision: 1, context: {} }, model: 'evil' }))
      .toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(parseMistralRealtimeCallBody({
      context: { version: 1, revision: 1, context: {} },
    })).toMatchObject({
      ok: true,
      value: {
        wireContract: 'v3-legacy',
        configVersion: BOB_REALTIME_CONFIG_VERSION_N_MINUS_ONE,
        speechDelivery: 'audited-signed-url-v1',
        protocol: 'bob.mistral-pcm.v1',
      },
    });
    expect(parseMistralRealtimeCallBody({
      context: { version: 1, revision: 1, context: {} },
      configVersion: BOB_REALTIME_CONFIG_VERSION,
    })).toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(parseMistralRealtimeCallBody({
      ...AUDITED_BOOTSTRAP_BINDING,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      context: { version: 1, revision: 1, context: {} },
    })).toMatchObject({ ok: true, value: { protocol: MISTRAL_CONVERSATION_PROTOCOL } });
    expect(parseMistralRealtimeCallBody({
      ...AUDITED_BOOTSTRAP_BINDING,
      protocol: 'bob.mistral-pcm.v3',
      context: { version: 1, revision: 1, context: {} },
    })).toMatchObject({ ok: false, error: { kind: 'validation' } });

    const durable = admission();
    const release = vi.spyOn(durable, 'release');
    const service = new RealtimeVoiceService(
      MISTRAL_SETTINGS,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      {
        issue: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
      } as unknown as MistralRealtimeIngressTicketAuthority,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );
    await expect(runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sessionHandle: '00000000-0000-4000-8000-000000000032',
      context: { version: 1, revision: 1, context: {} },
    }))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'mistral-realtime-ingress' },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('reste en livraison auditée texte avec le provider OpenAI tant que speechDelivery ne demande pas native', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_12345678'),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admission(),
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
      agentMissionProtocolVersion: null,
      sessionHandle: '00000000-0000-4000-8000-000000000001',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('bootstrap attendu');
    expect(result.value).toMatchObject({
      transport: 'webrtc',
      speechDelivery: 'audited-signed-url-v1',
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
      sessionHandle: '00000000-0000-4000-8000-000000000001',
      speechSourcePolicy: TEST_SPEECH_SOURCE_POLICY.policyForSession(
        'company-1',
        '00000000-0000-4000-8000-000000000001',
      ),
    });
    expect(result.value).not.toHaveProperty('callId');
    expect(result.value).not.toHaveProperty('apiKey');
    expect(result.value).not.toHaveProperty('safetyIdentifier');
    const call = vi.mocked(provider.createCall).mock.calls[0]?.[0];
    expect(call?.safetyIdentifier).toMatch(/^bob_[A-Za-z0-9_-]+$/);
    expect(call?.safetyIdentifier).not.toContain('user-1');
    expect(call?.session).toMatchObject({
      model: 'gpt-realtime-2.1',
      output_modalities: ['text'],
      max_output_tokens: 1,
      tools: [],
      tool_choice: 'none',
      audio: {
        input: {
          turn_detection: {
            type: 'semantic_vad',
            create_response: false,
            interrupt_response: true,
          },
        },
      },
    });
    await expect(runAsPrincipal(() => service.hangup(result.value.sessionHandle))).resolves.toEqual({
      ok: true,
      value: { ended: true },
    });
  });

  it('sert un client N-1 en audited sans ajouter le discriminant v4 à la réponse wire', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_legacy_12345678'),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admission(),
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    const parsed = parseRealtimeCallBody({ sdp: OFFER_SDP });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        wireContract: 'v3-legacy',
        configVersion: BOB_REALTIME_CONFIG_VERSION_N_MINUS_ONE,
        speechDelivery: 'audited-signed-url-v1',
        agentMissionNegotiation: { requested: 'omitted' },
      },
    });

    const result = await runAsPrincipal(() => service.createCall({
      sdp: OFFER_SDP,
      sessionHandle: '00000000-0000-4000-8000-000000000003',
    }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        transport: 'webrtc',
        speechSourcePolicy: TEST_SPEECH_SOURCE_POLICY.policyForSession(
          'company-1',
          '00000000-0000-4000-8000-000000000003',
        ),
      },
    });
    if (!result.ok) throw new Error('bootstrap legacy attendu');
    expect(result.value).not.toHaveProperty('speechDelivery');
    expect(result.value).not.toHaveProperty('agentMissionProtocolVersion');
    expect(result.value).not.toHaveProperty('agentMissionCapability');
  });

  it('natif OpenAI : annonce le contrat explicite et ne construit jamais de policy signée', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_native_12345678'),
      hangupCall: vi.fn(async () => undefined),
    };
    const policyForSession = vi.fn(() => {
      throw new Error('la policy signée ne doit pas être appelée');
    });
    const sideband = sidebandStub();
    const service = new RealtimeVoiceService(
      { ...SETTINGS, speechDelivery: 'openai-native-webrtc-v1' },
      provider,
      admission(),
      sideband,
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      { policyForSession },
    );

    await expect(runAsPrincipal(() => service.publicConfig())).resolves.toMatchObject({
      transport: 'webrtc',
      speechDelivery: 'openai-native-webrtc-v1',
    });
    const result = await runAsPrincipal(() => service.createCall({
      ...NATIVE_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
      agentMissionProtocolVersion: 1,
      sessionHandle: '00000000-0000-4000-8000-000000000002',
    }));

    expect(result).toMatchObject({
      ok: true,
      value: {
        transport: 'webrtc',
        speechDelivery: 'openai-native-webrtc-v1',
        agentMissionProtocolVersion: null,
        agentMissionCapability: null,
      },
    });
    if (result.ok) expect(result.value).not.toHaveProperty('speechSourcePolicy');
    expect(policyForSession).not.toHaveBeenCalled();
    expect(provider.createCall).toHaveBeenCalledOnce();
    expect(sideband.attach).toHaveBeenCalledWith(expect.objectContaining({
      speechDelivery: 'openai-native-webrtc-v1',
      plan: 'business',
      subjectKeyVersion: SETTINGS.subjectKeyVersion,
    }));
    const call = vi.mocked(provider.createCall).mock.calls[0]?.[0];
    expect(call?.session).toMatchObject({
      output_modalities: ['audio'],
      max_output_tokens: 4_096,
      tools: [],
      tool_choice: 'none',
      audio: {
        input: {
          turn_detection: {
            create_response: false,
            interrupt_response: false,
          },
        },
      },
    });
  });

  it('refuse un bootstrap dont delivery/version ne correspondent pas au config négocié', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_must_not_exist'),
      hangupCall: vi.fn(async () => undefined),
    };
    const durable = admission();
    const reserve = vi.spyOn(durable, 'reserve');
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    for (const body of [
      { ...NATIVE_BOOTSTRAP_BINDING, sdp: OFFER_SDP },
      { sdp: OFFER_SDP, configVersion: BOB_REALTIME_CONFIG_VERSION },
      { sdp: OFFER_SDP, speechDelivery: 'audited-signed-url-v1' },
      {
        ...AUDITED_BOOTSTRAP_BINDING,
        configVersion: 'bob-live-provider-neutral-v2',
        sdp: OFFER_SDP,
      },
    ]) {
      await expect(runAsPrincipal(() => service.createCall(body))).resolves.toMatchObject({
        ok: false,
        error: { kind: 'validation' },
      });
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(provider.createCall).not.toHaveBeenCalled();
  });

  it('libère le bail et interdit tout egress fournisseur si la policy audio manque', async () => {
    const durable = admission();
    const release = vi.spyOn(durable, 'release');
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_must_not_exist'),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      { policyForSession: () => { throw new Error('storage unavailable'); } },
    );

    await expect(runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-speech' },
    });
    expect(provider.createCall).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('refuse avant tout appel fournisseur lorsque Bob Live est désactivé', async () => {
    const provider: OpenAiRealtimeCallProvider = { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) };
    const service = new RealtimeVoiceService(
      { ...SETTINGS, enabled: false },
      provider,
      admission(),
      sidebandStub({ terminateAfterAttach: true }),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    const config = await runAsPrincipal(() => service.publicConfig());
    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));

    expect(config).toMatchObject({ available: false, availabilityReason: 'disabled' });
    expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
    expect(provider.createCall).not.toHaveBeenCalled();
  });

  it('refuse un plan non éligible avant admission et avant tout coût fournisseur', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const admissionPort = admission();
    const reserve = vi.spyOn(admissionPort, 'reserve');
    const entitlement = { check: vi.fn(async () => ({ allowed: false, plan: 'solo' as const })) };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admissionPort,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitlement,
    );

    const config = await runAsPrincipal(() => service.publicConfig());
    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));

    expect(config).toMatchObject({ available: false, availabilityReason: 'not_entitled' });
    expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
    expect(entitlement.check).toHaveBeenCalledWith({ userId: 'user-1', companyId: 'company-1' });
    expect(reserve).not.toHaveBeenCalled();
    expect(provider.createCall).not.toHaveBeenCalled();
  });

  it('échoue fermé si la décision d’abonnement est indisponible', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const admissionPort = admission();
    const reserve = vi.spyOn(admissionPort, 'reserve');
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admissionPort,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      { check: vi.fn(async () => { throw new Error('subscription unavailable'); }) },
    );

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-entitlement' },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(provider.createCall).not.toHaveBeenCalled();
  });

  it('échoue fermé si l’adapter entitlement est absent, sans admission ni coût fournisseur', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const admissionPort = admission();
    const reserve = vi.spyOn(admissionPort, 'reserve');
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admissionPort,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
    );

    await expect(runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-entitlement' },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(provider.createCall).not.toHaveBeenCalled();
  });

  it('rejette tout paramètre client qui tenterait de choisir modèle, prompt ou outils', () => {
    const result = parseRealtimeCallBody({ sdp: OFFER_SDP, model: 'evil', tools: [{ name: 'pay' }] });
    expect(result).toMatchObject({ ok: false, error: { kind: 'validation' } });
  });

  it('distingue la négociation Mission explicite sur les bootstraps WebRTC et Mistral', () => {
    expect(parseRealtimeCallBody({
      sdp: OFFER_SDP,
      agentMissionProtocolVersion: null,
    })).toMatchObject({
      ok: true,
      value: {
        agentMissionNegotiation: { requested: 'null', protocolVersion: null },
      },
    });
    expect(parseRealtimeCallBody({
      ...NATIVE_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
      agentMissionProtocolVersion: 1,
    })).toMatchObject({
      ok: true,
      value: {
        agentMissionNegotiation: { requested: 'v1', protocolVersion: 1 },
      },
    });
    expect(parseMistralRealtimeCallBody({
      context: { version: 1, revision: 1, context: {} },
      agentMissionProtocolVersion: 1,
    })).toMatchObject({
      ok: true,
      value: {
        agentMissionNegotiation: { requested: 'v1', protocolVersion: 1 },
      },
    });
  });

  it('refuse une version Mission inconnue au lieu de la rabattre sur le parcours historique', () => {
    expect(parseRealtimeCallBody({
      sdp: OFFER_SDP,
      agentMissionProtocolVersion: 2,
    })).toMatchObject({
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'agentMissionProtocolVersion' }],
      },
    });
    expect(parseMistralRealtimeCallBody({
      context: { version: 1, revision: 1, context: {} },
      agentMissionProtocolVersion: '1',
    })).toMatchObject({
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'agentMissionProtocolVersion' }],
      },
    });
  });

  it('rejette un contexte versionné incomplet ou enrichi de champs inconnus', () => {
    expect(parseRealtimeContextBody({ version: 2, revision: 1, context: {} })).toMatchObject({ ok: false });
    expect(parseRealtimeContextBody({ version: 1, revision: 0, context: {} })).toMatchObject({ ok: false });
    expect(parseRealtimeContextBody({ version: 1, revision: 1, context: {}, providerCallId: 'rtc_leak' }))
      .toMatchObject({ ok: false });
    expect(parseRealtimeControlAcknowledgementBody({
      turnId: '00000000-0000-4000-8000-000000000001',
      contextRevision: 1,
      contextDigest: 'a'.repeat(64),
      bob_response_nonce: 'provider-secret',
    })).toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(parseRealtimeControlAcknowledgementBody({
      turnId: 'rogue',
      contextRevision: 1,
      contextDigest: 'a'.repeat(64),
    })).toMatchObject({ ok: false, error: { kind: 'validation' } });
  });

  it('applique le quota par utilisateur avant de consommer le fournisseur', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_12345678'),
      hangupCall: vi.fn(async () => undefined),
    };
    const sideband = sidebandStub();
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admission(1, () => 10_000),
      sideband,
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    const first = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));
    if (!first.ok) throw new Error('First bootstrap should be admitted.');
    await runAsPrincipal(() => service.hangup(first.value.sessionHandle));
    const second = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: { kind: 'rate_limited' } });
    expect(provider.createCall).toHaveBeenCalledTimes(1);
  });

  it('refuse la capacité globale avant tout second appel fournisseur', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_capacity_1'),
      hangupCall: vi.fn(async () => undefined),
    };
    const bounded = new InMemoryRealtimeAdmission({
      ...ADMISSION_POLICY,
      globalCapacity: {
        providerId: 'openai',
        providerModel: 'gpt-realtime-2.1',
        globalMaxSessions: 1,
        providerMaxSessions: 2,
        configVersion: 9,
      },
    });
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      bounded,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    const first = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));
    const second = await runAsPrincipal(
      () => service.createCall({ ...AUDITED_BOOTSTRAP_BINDING, sdp: OFFER_SDP }),
      { userId: 'user-2', companyId: 'company-1' },
    );

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-admission' },
    });
    expect(provider.createCall).toHaveBeenCalledTimes(1);
  });

  it('normalise une erreur fournisseur sans propager secret ou SDP', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(async () => {
        throw new Error(`private ${SETTINGS.apiKey} ${OFFER_SDP}`);
      }),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admission(),
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));

    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'openai-realtime', cause: 'provider_unknown' },
    });
    expect(JSON.stringify(result)).not.toContain(String(SETTINGS.apiKey));
    expect(JSON.stringify(result)).not.toContain(OFFER_SDP);
  });

  it('raccroche l’appel fournisseur si le contrôle sideband échoue après sa création', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_orphan_guard'),
      hangupCall: vi.fn(async () => undefined),
    };
    const sideband: RealtimeSidebandControl = {
      attach: vi.fn(async () => {
        throw new Error('sideband_timeout');
      }),
      contextChanged: vi.fn(),
      consumeAgentControl: vi.fn(async () => ({ status: 'not_found' as const })),
      closeForPrincipal: vi.fn(async () => undefined),
      fenceAndDetachSession: vi.fn(() => 'not_found' as const),
      closeSession: vi.fn(async () => 'not_found' as const),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admission(),
      sideband,
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));

    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'openai-realtime', cause: 'sideband_timeout' },
    });
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(provider.hangupCall).toHaveBeenCalledWith('rtc_orphan_guard');
  });

  it('ne déclare jamais terminé un hangup local encore confié au reaper', async () => {
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const sideband: RealtimeSidebandControl = {
      attach: vi.fn(async () => undefined),
      contextChanged: vi.fn(),
      consumeAgentControl: vi.fn(async () => ({ status: 'not_found' as const })),
      closeForPrincipal: vi.fn(async () => undefined),
      fenceAndDetachSession: vi.fn(() => 'not_found' as const),
      closeSession: vi.fn(async () => 'pending_reaper' as const),
    };
    const metrics = new Metrics();
    const durable = admission();
    const pendingAdmission: RealtimeAdmissionPort = {
      ...tracedAdmission(durable, []),
      claimTermination: vi.fn(async () => ({
        ok: true as const,
        claim: null,
        pending: true,
      })),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      pendingAdmission,
      sideband,
      metrics,
      loggerStub(),
    );

    await expect(runAsPrincipal(() => service.hangup(
      '00000000-0000-4000-8000-000000000099',
    ))).resolves.toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'bob-live-hangup',
        retryAfterSeconds: 10,
      },
    });
    expect(provider.hangupCall).not.toHaveBeenCalled();
    const providerErrors = await metrics.bobLiveProviderErrors.get();
    expect(providerErrors.values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        labels: { class: 'explicit_hangup_pending_reaper' },
        value: 1,
      }),
    ]));
    expect(pendingAdmission.claimTermination).toHaveBeenCalledOnce();
  });

  it('ne déclare pas terminé un hangup déjà revendiqué par une autre réplique', async () => {
    const durable = admission();
    const pendingAdmission: RealtimeAdmissionPort = {
      ...tracedAdmission(durable, []),
      claimTermination: vi.fn(async () => ({ ok: true as const, claim: null, pending: true })),
    };
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      pendingAdmission,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
    );

    await expect(runAsPrincipal(() => service.hangup(
      '00000000-0000-4000-8000-000000000098',
    ))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-hangup', retryAfterSeconds: 10 },
    });
    expect(provider.hangupCall).not.toHaveBeenCalled();
  });

  it('un hangup reçu avant le bootstrap interdit tout appel provider sur ce handle', async () => {
    const handle = '00000000-0000-4000-8000-000000000097';
    const durable = admission();
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(async () => ({
        answerSdp: OFFER_SDP,
        callId: 'rtc_must_not_exist',
      })),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    await expect(runAsPrincipal(() => service.hangup(handle))).resolves.toEqual({
      ok: true,
      value: { ended: true },
    });
    await expect(runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
      sessionHandle: handle,
    }))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'conflict', entity: 'realtime_session' },
    });
    expect(provider.createCall).not.toHaveBeenCalled();
    expect(provider.hangupCall).not.toHaveBeenCalled();
  });

  it('respecte l’ordre durable reserve → provider → bind → sideband → activate', async () => {
    const order: string[] = [];
    const durable = tracedAdmission(admission(), order);
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(async (input) => {
        order.push('provider');
        await input.onCallCreated('rtc_ordered');
        return { answerSdp: OFFER_SDP, callId: 'rtc_ordered' };
      }),
      hangupCall: vi.fn(async () => undefined),
    };
    const baseSideband = sidebandStub();
    const sideband: RealtimeSidebandControl = {
      ...baseSideband,
      attach: vi.fn(async (input) => {
        order.push('sideband');
        await baseSideband.attach(input);
      }),
    };
    const service = new RealtimeVoiceService(
      SETTINGS, provider, durable, sideband, new Metrics(), loggerStub(), undefined, entitled(),
      undefined, undefined, undefined, TEST_SPEECH_SOURCE_POLICY,
    );

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));

    expect(result.ok).toBe(true);
    expect(order.slice(0, 6))
      .toEqual(['reserve', 'provider', 'bind', 'sideband', 'activate', 'resolve']);
    expect(order.filter((step) => step === 'bind')).toHaveLength(1);
    if (result.ok) await runAsPrincipal(() => service.hangup(result.value.sessionHandle));
  });

  it('ne rend aucune capability si un hangup gagne pendant la finalisation du bootstrap', async () => {
    const handle = '00000000-0000-4000-8000-000000000096';
    const capability = `bam1_${Buffer.alloc(32, 75).toString('base64url')}`;
    const durable = missionCapableAdmission(admission());
    const claimTermination = vi.spyOn(durable, 'claimTermination');
    const attached = deferred<void>();
    const finishAttach = deferred<void>();
    let lifecycle: NonNullable<
      Parameters<RealtimeSidebandControl['attach']>[0]['lifecycle']
    > | null = null;
    const sideband: RealtimeSidebandControl = {
      attach: vi.fn(async (input) => {
        if (!input.lifecycle) throw new Error('missing_lifecycle');
        lifecycle = input.lifecycle;
        await input.lifecycle.activate();
        attached.resolve(undefined);
        await finishAttach.promise;
      }),
      contextChanged: vi.fn(),
      consumeAgentControl: vi.fn(async () => ({ status: 'not_found' as const })),
      closeForPrincipal: vi.fn(async () => undefined),
      fenceAndDetachSession: vi.fn(() => {
        lifecycle?.fenceAfterDurableTerminationClaim();
        return 'detached' as const;
      }),
      closeSession: vi.fn(async () => {
        if (!lifecycle) return 'not_found' as const;
        return lifecycle.terminate('user');
      }),
    };
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_bootstrap_hangup_race'),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      durable,
      sideband,
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
      undefined,
      undefined,
      undefined,
      missionGate(capability),
    );

    const bootstrap = runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      agentMissionProtocolVersion: 1,
      sdp: OFFER_SDP,
      sessionHandle: handle,
    }));
    await attached.promise;
    await expect(runAsPrincipal(() => service.hangup(handle))).resolves.toEqual({
      ok: true,
      value: { ended: true },
    });
    finishAttach.resolve(undefined);

    const result = await bootstrap;
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'openai-realtime',
        cause: 'realtime_bootstrap_fenced',
      },
    });
    expect(JSON.stringify(result)).not.toContain(capability);
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(claimTermination).toHaveBeenCalledOnce();
    expect(claimTermination.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sideband.fenceAndDetachSession).mock.invocationCallOrder[0]!,
    );
  });

  it('compense exactement une fois si le bind durable échoue dès la publication de Location', async () => {
    const base = admission();
    const durable: RealtimeAdmissionPort = {
      ...tracedAdmission(base, []),
      bindProvider: vi.fn(async () => ({ ok: false, reason: 'unavailable' as const })),
    };
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(async (input) => {
        await input.onCallCreated('rtc_bind_failure');
        return { answerSdp: OFFER_SDP, callId: 'rtc_bind_failure' };
      }),
      hangupCall: vi.fn(async () => undefined),
    };
    const sideband = sidebandStub();
    const service = new RealtimeVoiceService(
      SETTINGS, provider, durable, sideband, new Metrics(), loggerStub(), undefined, entitled(),
      undefined, undefined, undefined, TEST_SPEECH_SOURCE_POLICY,
    );

    const result = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
    }));

    expect(result).toMatchObject({ ok: false, error: { kind: 'dependency' } });
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(provider.hangupCall).toHaveBeenCalledWith('rtc_bind_failure');
    expect(durable.bindProvider).toHaveBeenCalledOnce();
    expect(sideband.attach).not.toHaveBeenCalled();
  });

  it('ne double jamais le hangup déjà compensé par l’adapter', async () => {
    const handle = '00000000-0000-4000-8000-000000000008';
    const durable = admission();
    const hangupCall = vi.fn<OpenAiRealtimeCallProvider['hangupCall']>(async () => undefined);
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(async (input) => {
        await input.onCallCreated('rtc_compensated_once');
        await hangupCall('rtc_compensated_once');
        throw new RealtimeProviderCallCompensatedError('provider_invalid_sdp');
      }),
      hangupCall,
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );

    await expect(runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
      sessionHandle: handle,
    }))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', cause: 'provider_invalid_sdp' },
    });
    expect(hangupCall).toHaveBeenCalledOnce();
    expect(hangupCall).toHaveBeenCalledWith('rtc_compensated_once');
    const subjectHash = admissionSubjectHash(SETTINGS.safetySecret!, 'company-1', 'user-1');
    await expect(durable.claimTermination({
      companyId: 'company-1',
      subjectHashCandidates: [subjectHash],
      principalBindingHash: subjectHash,
      sessionId: handle,
    })).resolves.toEqual({ ok: true, claim: null, pending: false });
  });

  it('nettoie l’appel créé quand le client annule pendant le bootstrap', async () => {
    const handle = '00000000-0000-4000-8000-000000000009';
    const locationAvailable = deferred<void>();
    const durable = admission();
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(async (input) => {
        await locationAvailable.promise;
        await input.onCallCreated('rtc_aborted_bootstrap');
        return { answerSdp: OFFER_SDP, callId: 'rtc_aborted_bootstrap' };
      }),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(
      SETTINGS, provider, durable, sidebandStub(), new Metrics(), loggerStub(), undefined, entitled(),
      undefined, undefined, undefined, TEST_SPEECH_SOURCE_POLICY,
    );
    const controller = new AbortController();
    const running = runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
      sessionHandle: handle,
    }, controller.signal));
    await vi.waitFor(() => expect(provider.createCall).toHaveBeenCalledOnce());

    controller.abort();
    locationAvailable.resolve(undefined);
    await expect(running).resolves.toMatchObject({ ok: false });

    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(provider.hangupCall).toHaveBeenCalledWith('rtc_aborted_bootstrap');
    const subjectHash = admissionSubjectHash(SETTINGS.safetySecret!, 'company-1', 'user-1');
    await expect(durable.claimTermination({
      companyId: 'company-1',
      subjectHashCandidates: [subjectHash],
      principalBindingHash: subjectHash,
      sessionId: handle,
    }))
      .resolves.toEqual({ ok: true, claim: null, pending: false });
  });

  it('termine par handle opaque depuis une autre réplique sans révéler les sessions étrangères', async () => {
    const handle = '00000000-0000-4000-8000-000000000010';
    const durable = admission();
    const subjectHash = admissionSubjectHash(SETTINGS.safetySecret!, 'company-1', 'user-1');
    const reserved = await durable.reserve({
      companyId: 'company-1',
      subjectHash,
      sessionId: handle,
      maxSessionSeconds: SETTINGS.maxSessionSeconds,
      subjectHashCandidates: [subjectHash],
      principalBindingHash: subjectHash,
      agentMissionBinding: null,
    });
    if (!reserved.allowed) throw new Error('réservation attendue');
    await durable.bindProvider({
      ...reserved.lease,
      providerId: 'openai',
      providerCallId: 'rtc_remote_replica',
    });
    await durable.activate(reserved.lease);
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const service = new RealtimeVoiceService(SETTINGS, provider, durable, sidebandStub(), new Metrics(), loggerStub());

    const hidden = await runAsPrincipal(
      () => service.hangup(handle),
      { userId: 'user-2', companyId: 'company-1' },
    );
    expect(hidden).toEqual({ ok: true, value: { ended: true } });
    expect(provider.hangupCall).not.toHaveBeenCalled();

    await expect(runAsPrincipal(() => service.hangup(handle))).resolves.toEqual({
      ok: true,
      value: { ended: true },
    });
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(provider.hangupCall).toHaveBeenCalledWith('rtc_remote_replica');
  });

  it('retrouve et termine une lease créée avec la clé HMAC historique', async () => {
    const handle = '00000000-0000-4000-8000-000000000011';
    const previousSecret = 'previous-subject-secret-at-least-32-chars';
    const currentSecret = 'current-subject-secret-at-least-32-chars!!';
    const historicalSubjectHash = admissionSubjectHash(
      previousSecret,
      'company-1',
      'user-1',
    );
    const durable = admission();
    const reserved = await durable.reserve({
      companyId: 'company-1',
      subjectHash: historicalSubjectHash,
      subjectHashCandidates: [historicalSubjectHash],
      principalBindingHash: agentMissionPrincipalBindingHash('company-1', 'user-1'),
      agentMissionBinding: null,
      sessionId: handle,
      maxSessionSeconds: SETTINGS.maxSessionSeconds,
    });
    if (!reserved.allowed) throw new Error('réservation historique attendue');
    await durable.bindProvider({
      ...reserved.lease,
      providerId: 'openai',
      providerCallId: 'rtc_hmac_rotated',
    });
    await durable.activate(reserved.lease);
    const provider: OpenAiRealtimeCallProvider = {
      createCall: vi.fn(),
      hangupCall: vi.fn(async () => undefined),
    };
    const rotatedSettings: RealtimeVoiceSettings = {
      ...SETTINGS,
      safetySecret: currentSecret,
      subjectKeyVersion: 2,
      subjectHmacKeyRing: [
        { version: 1, secret: previousSecret },
        { version: 2, secret: currentSecret },
      ],
    };
    const service = new RealtimeVoiceService(
      rotatedSettings,
      provider,
      durable,
      sidebandStub(),
      new Metrics(),
      loggerStub(),
    );

    await expect(runAsPrincipal(() => service.hangup(handle))).resolves.toEqual({
      ok: true,
      value: { ended: true },
    });
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(provider.hangupCall).toHaveBeenCalledWith('rtc_hmac_rotated');
  });

  it('publie un contexte monotone lié au sujet puis le fige au début du tour monobrain', async () => {
    const handle = '00000000-0000-4000-8000-000000000020';
    const durable = admission();
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_context_turn'),
      hangupCall: vi.fn(async () => undefined),
    };
    let attached: Parameters<RealtimeSidebandControl['attach']>[0] | undefined;
    const baseSideband = sidebandStub();
    const sideband: RealtimeSidebandControl = {
      ...baseSideband,
      attach: vi.fn(async (input) => {
        attached = input;
        await baseSideband.attach(input);
      }),
    };
    const runTurn = vi.fn<RealtimeAgentTurnPort['run']>().mockResolvedValue({
      status: 'failed',
      canonicalSpeech: 'Test.',
    });
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      durable,
      sideband,
      new Metrics(),
      loggerStub(),
      { run: runTurn },
      entitled(),
      undefined,
      undefined,
      undefined,
      TEST_SPEECH_SOURCE_POLICY,
    );
    const created = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
      sessionHandle: handle,
    }));
    expect(created.ok).toBe(true);

    const context = {
      screen: { name: '/facture/detail', instanceId: 'invoice-1' },
      entities: [{ type: 'invoice' as const, id: 'invoice-1', label: 'Facture F-2026-014' }],
      capabilities: ['screen.read' as const, 'invoice.read' as const],
    };
    const preparedContext = prepareRealtimeContext({ version: 1, revision: 4, context });
    if (preparedContext === null) throw new Error('contexte canonique attendu');
    await expect(runAsPrincipal(() => service.updateContext(handle, {
      version: 1,
      revision: 4,
      context,
    }))).resolves.toEqual({
      ok: true,
      value: { revision: 4, contextDigest: preparedContext.digest },
    });
    expect(sideband.contextChanged).toHaveBeenCalledWith({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: handle,
      revision: 4,
      digest: preparedContext.digest,
    });

    await expect(runAsPrincipal(
      () => service.updateContext(handle, { version: 1, revision: 5, context }),
      { userId: 'user-2', companyId: 'company-1' },
    )).resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const signal = new AbortController().signal;
    const turnId = deriveRealtimeTurnId(handle, 'item-context-turn');
    await attached?.turn?.run({
      turnId,
      transcript: 'Résume cette facture.',
      history: [],
      signal,
    });
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId,
      userId: 'user-1',
      companyId: 'company-1',
      transcript: 'Résume cette facture.',
      context,
      signal,
    }));
    const turnInput = runTurn.mock.calls[0]?.[0];
    if (!turnInput) throw new Error('tour attendu');
    expect(turnInput).not.toHaveProperty('agentMissionAuthority');
    expect(turnInput.contextFence.expected).toMatchObject({ version: 1, revision: 4 });
    await expect(turnInput.contextFence.revalidate(signal)).resolves.toEqual(
      turnInput.contextFence.expected,
    );

    const nextContext = {
      ...context,
      screen: { name: '/devis/new', instanceId: 'quote-new-1' },
    };
    await expect(runAsPrincipal(() => service.updateContext(handle, {
      version: 1,
      revision: 5,
      context: nextContext,
    }))).resolves.toEqual({
      ok: true,
      value: { revision: 5, contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const changedVersion = await turnInput.contextFence.revalidate(signal);
    expect(changedVersion).toMatchObject({ version: 1, revision: 5 });
    expect(changedVersion.digest).not.toBe(turnInput.contextFence.expected.digest);

    await runAsPrincipal(() => service.hangup(handle));
  });

  it('acquitte un contrôle allowlisté une fois puis revalide durablement sujet, session et contexte', async () => {
    const handle = '00000000-0000-4000-8000-000000000090';
    const turnId = '00000000-0000-4000-8000-000000000091';
    const acknowledgementId = '00000000-0000-4000-8000-000000000092';
    const durable = admission();
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_control_service'),
      hangupCall: vi.fn(async () => undefined),
    };
    let contextDigest = '';
    const baseSideband = sidebandStub();
    const consumeControl = vi.fn<RealtimeDurableControlPort['consume']>(async () => ({
      status: 'approved',
      idempotent: false,
      control: {
        turnId,
        kind: 'answer',
        contextRevision: 1,
        contextDigest,
        navigate: '/cloture',
      },
    }));
    const sideband: RealtimeSidebandControl = {
      ...baseSideband,
      contextChanged: vi.fn((input) => { contextDigest = input.digest; }),
    };
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      durable,
      sideband,
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
      undefined,
      undefined,
      { issue: vi.fn(), consume: consumeControl } as unknown as RealtimeDurableControlPort,
      TEST_SPEECH_SOURCE_POLICY,
    );
    const created = await runAsPrincipal(() => service.createCall({
      ...AUDITED_BOOTSTRAP_BINDING,
      sdp: OFFER_SDP,
      sessionHandle: handle,
    }));
    expect(created.ok).toBe(true);
    const context = {
      screen: { name: '/cloture', instanceId: 'closing-1' },
      entities: [],
      capabilities: ['screen.read' as const],
    };
    await expect(runAsPrincipal(() => service.updateContext(handle, {
      version: 1,
      revision: 1,
      context,
    }))).resolves.toEqual({
      ok: true,
      value: { revision: 1, contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const candidate = { turnId, acknowledgementId, contextRevision: 1, contextDigest };

    await expect(runAsPrincipal(() => service.acknowledgeControl(handle, candidate))).resolves.toEqual({
      ok: true,
      value: { ...candidate, kind: 'answer', navigate: '/cloture' },
    });
    expect(consumeControl).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      subjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sessionId: handle,
      ...candidate,
    }));

    consumeControl.mockResolvedValueOnce({
      status: 'approved',
      idempotent: false,
      control: {
        turnId,
        contextRevision: 1,
        contextDigest,
        kind: 'answer',
        navigate: '/cloture',
        providerResponseId: 'resp_must_never_cross_the_boundary',
        nonce: 'provider-controlled',
      },
    } as never);
    await expect(runAsPrincipal(() => service.acknowledgeControl(handle, candidate)))
      .resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const blockedRead = vi.spyOn(durable, 'readContext')
      .mockImplementationOnce(() => new Promise(() => undefined));
    const abortedRequest = new AbortController();
    const blockedAcknowledgement = runAsPrincipal(
      () => service.acknowledgeControl(handle, candidate, abortedRequest.signal),
    );
    await vi.waitFor(() => expect(blockedRead).toHaveBeenCalledTimes(1));
    abortedRequest.abort();
    await expect(blockedAcknowledgement)
      .resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });
    blockedRead.mockRestore();

    await expect(runAsPrincipal(
      () => service.acknowledgeControl(handle, candidate),
      { userId: 'user-2', companyId: 'company-1' },
    )).resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });
    await expect(runAsPrincipal(() => service.updateContext(handle, {
      version: 1,
      revision: 2,
      context: { ...context, screen: { name: '/home', instanceId: 'home-2' } },
    }))).resolves.toEqual({
      ok: true,
      value: { revision: 2, contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    await expect(runAsPrincipal(() => service.acknowledgeControl(handle, candidate)))
      .resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });
    await runAsPrincipal(() => service.hangup(handle));
  });
});

describe('safetyIdentifier', () => {
  it('est stable, pseudonymisé et séparé entre utilisateurs', () => {
    const secret = 'a-secure-secret-with-at-least-thirty-two-characters';
    const first = safetyIdentifier(secret, 'user-1');
    expect(first).toBe(safetyIdentifier(secret, 'user-1'));
    expect(first).not.toBe(safetyIdentifier(secret, 'user-2'));
    expect(first).not.toContain('user-1');
  });
});
