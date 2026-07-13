import { describe, expect, it, vi } from 'vitest';
import { Metrics } from '../../observability/metrics';
import { requestContext, setPrincipal, type AppLogger } from '../../observability/logger';
import {
  InMemoryRealtimeAdmission,
  type RealtimeAdmissionPolicy,
  type RealtimeAdmissionPort,
} from './realtime-admission';
import {
  admissionSubjectHash,
  RealtimeVoiceService,
  parseRealtimeCallBody,
  parseRealtimeControlAcknowledgementBody,
  parseRealtimeContextBody,
  safetyIdentifier,
} from './realtime.service';
import { RealtimeProviderCallCompensatedError } from './openai-realtime-call.adapter';
import type { RealtimeSidebandControl } from './realtime-sideband';
import type { RealtimeAgentTurnPort } from './realtime-agent-turn';
import type { OpenAiRealtimeCallProvider, RealtimeVoiceSettings } from './realtime.types';

const OFFER_SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const SETTINGS: RealtimeVoiceSettings = {
  enabled: true,
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'server-only-key',
  safetySecret: 'safety-secret-at-least-thirty-two-characters',
  providerTimeoutMs: 4_000,
  sidebandTimeoutMs: 3_000,
  maxSessionSeconds: 900,
  heartbeatSeconds: 10,
  maxCallsPerMinute: 3,
};

const ADMISSION_POLICY: RealtimeAdmissionPolicy = {
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

describe('RealtimeVoiceService', () => {
  it('produit un bootstrap WebRTC sans clé durable et avec outils désactivés', async () => {
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
    );

    const result = await runAsPrincipal(() => service.createCall({
      sdp: OFFER_SDP,
      sessionHandle: '00000000-0000-4000-8000-000000000001',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('bootstrap attendu');
    expect(result.value).toMatchObject({
      transport: 'webrtc',
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      sessionHandle: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.value).not.toHaveProperty('callId');
    expect(result.value).not.toHaveProperty('apiKey');
    expect(result.value).not.toHaveProperty('safetyIdentifier');
    const call = vi.mocked(provider.createCall).mock.calls[0]?.[0];
    expect(call?.safetyIdentifier).toMatch(/^bob_[A-Za-z0-9_-]+$/);
    expect(call?.safetyIdentifier).not.toContain('user-1');
    expect(call?.session).toMatchObject({
      model: 'gpt-realtime-2.1',
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
    );

    const config = await runAsPrincipal(() => service.publicConfig());
    const result = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));

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
    const result = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));

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

    const result = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));

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

    await expect(runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }))).resolves.toMatchObject({
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
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admission(1, () => 10_000),
      sidebandStub({ terminateAfterAttach: true }),
      new Metrics(),
      loggerStub(),
      undefined,
      entitled(),
    );

    const first = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));
    const second = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: { kind: 'rate_limited' } });
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
    );

    const result = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));

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
    );

    const result = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));

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
      closeSession: vi.fn(async () => 'pending_reaper' as const),
    };
    const metrics = new Metrics();
    const service = new RealtimeVoiceService(
      SETTINGS,
      provider,
      admission(),
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
    );

    const result = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));

    expect(result.ok).toBe(true);
    expect(order.slice(0, 5)).toEqual(['reserve', 'provider', 'bind', 'sideband', 'activate']);
    expect(order.filter((step) => step === 'bind')).toHaveLength(1);
    if (result.ok) await runAsPrincipal(() => service.hangup(result.value.sessionHandle));
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
    );

    const result = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP }));

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
    );

    await expect(runAsPrincipal(() => service.createCall({
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
      subjectHash,
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
    );
    const controller = new AbortController();
    const running = runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP, sessionHandle: handle }, controller.signal));
    await vi.waitFor(() => expect(provider.createCall).toHaveBeenCalledOnce());

    controller.abort();
    locationAvailable.resolve(undefined);
    await expect(running).resolves.toMatchObject({ ok: false });

    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(provider.hangupCall).toHaveBeenCalledWith('rtc_aborted_bootstrap');
    const subjectHash = admissionSubjectHash(SETTINGS.safetySecret!, 'company-1', 'user-1');
    await expect(durable.claimTermination({ companyId: 'company-1', subjectHash, sessionId: handle }))
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
    });
    if (!reserved.allowed) throw new Error('réservation attendue');
    await durable.bindProvider({ ...reserved.lease, providerCallId: 'rtc_remote_replica' });
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
    );
    const created = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP, sessionHandle: handle }));
    expect(created.ok).toBe(true);

    const context = {
      screen: { name: '/facture/detail', instanceId: 'invoice-1' },
      entities: [{ type: 'invoice' as const, id: 'invoice-1', label: 'Facture F-2026-014' }],
      capabilities: ['screen.read' as const, 'invoice.read' as const],
    };
    await expect(runAsPrincipal(() => service.updateContext(handle, {
      version: 1,
      revision: 4,
      context,
    }))).resolves.toEqual({
      ok: true,
      value: { revision: 4, contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(sideband.contextChanged).toHaveBeenCalledWith({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: handle,
      revision: 4,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await expect(runAsPrincipal(
      () => service.updateContext(handle, { version: 1, revision: 5, context }),
      { userId: 'user-2', companyId: 'company-1' },
    )).resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const signal = new AbortController().signal;
    await attached?.turn?.run({ transcript: 'Résume cette facture.', history: [], signal });
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      companyId: 'company-1',
      transcript: 'Résume cette facture.',
      context,
      signal,
    }));
    const turnInput = runTurn.mock.calls[0]?.[0];
    if (!turnInput) throw new Error('tour attendu');
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
    const durable = admission();
    const provider: OpenAiRealtimeCallProvider = {
      createCall: successfulProviderCreate('rtc_control_service'),
      hangupCall: vi.fn(async () => undefined),
    };
    let contextDigest = '';
    const baseSideband = sidebandStub();
    const consumeAgentControl = vi.fn<RealtimeSidebandControl['consumeAgentControl']>(async () => ({
      status: 'approved',
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
      consumeAgentControl,
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
    );
    const created = await runAsPrincipal(() => service.createCall({ sdp: OFFER_SDP, sessionHandle: handle }));
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
    const candidate = { turnId, contextRevision: 1, contextDigest };

    await expect(runAsPrincipal(() => service.acknowledgeControl(handle, candidate))).resolves.toEqual({
      ok: true,
      value: { ...candidate, kind: 'answer', navigate: '/cloture' },
    });
    expect(consumeAgentControl).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: handle,
      ...candidate,
    }));

    consumeAgentControl.mockResolvedValueOnce({
      status: 'approved',
      control: {
        ...candidate,
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
