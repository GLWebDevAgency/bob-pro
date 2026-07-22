import { describe, expect, it, vi } from 'vitest';
import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import { Metrics } from '../../observability/metrics';
import { requestContext, setPrincipal, type AppLogger } from '../../observability/logger';
import type { RealtimeAdmissionPort } from './realtime-admission';
import type { OpenAiRealtimeCallProvider, RealtimeVoiceSettings } from './realtime.types';
import type { RealtimeSidebandControl } from './realtime-sideband';
import {
  parseRealtimeBootstrapReconciliationBody,
  RealtimeVoiceService,
} from './realtime.service';
import type { MistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';

const SESSION_HANDLE = 'mistral_reconcile_session_0001';
const BOOTSTRAP_TICKET = 'b2_QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI';
const RESUME_TICKET = 'r2_UlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlI';
const SETTINGS: RealtimeVoiceSettings = {
  enabled: true,
  provider: 'mistral',
  speechDelivery: 'audited-signed-url-v1',
  model: 'voxtral-mini-transcribe-realtime-2602',
  voice: 'marin',
  baseUrl: 'wss://api.mistral.ai',
  apiKey: 'mistral-server-only-key',
  safetySecret: 'safety-secret-at-least-thirty-two-characters',
  subjectKeyVersion: 7,
  providerTimeoutMs: 4_000,
  sidebandTimeoutMs: 3_000,
  maxSessionSeconds: 900,
  heartbeatSeconds: 10,
  maxCallsPerMinute: 3,
  auditProvider: 'openai',
  localAuditBaseUrl: null,
  localAuditToken: null,
  mistralTargetDelayMs: 240,
  mistralWebsocketUrl: 'wss://api.bob.example/v1/voice/realtime/mistral',
  mistralV2InitialBootstrapEnabled: true,
};

function loggerStub(): AppLogger {
  return { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;
}

function authority(
  reconcileInitialBootstrap: MistralConversationResumeAuthority['reconcileInitialBootstrap'],
): MistralConversationResumeAuthority {
  return {
    issue: vi.fn(async () => ({ status: 'unavailable' as const })),
    reconcileInitialBootstrap,
    redeemAndOpen: vi.fn(async () => ({ status: 'unavailable' as const })),
    acknowledgeTerminal: vi.fn(async () => ({ status: 'unavailable' as const })),
  };
}

function service(
  resumeAuthority: MistralConversationResumeAuthority,
  logger: AppLogger = loggerStub(),
  settings: RealtimeVoiceSettings = SETTINGS,
  liveTurnsAvailable = true,
): RealtimeVoiceService {
  return new RealtimeVoiceService(
    settings,
    { createCall: vi.fn(), hangupCall: vi.fn() } as OpenAiRealtimeCallProvider,
    {} as RealtimeAdmissionPort,
    {} as RealtimeSidebandControl,
    new Metrics(),
    logger,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    resumeAuthority,
    undefined,
    { liveTurnsAvailable },
  );
}

function runAsPrincipal<T>(
  fn: () => Promise<T>,
  principal: { userId: string; companyId: string } | null = {
    userId: 'user-1',
    companyId: 'company-1',
  },
): Promise<T> {
  return requestContext.run({ correlationId: 'reconciliation-test' }, async () => {
    if (principal !== null) setPrincipal(principal);
    return fn();
  });
}

const BODY = Object.freeze({
  protocol: MISTRAL_CONVERSATION_PROTOCOL,
  bootstrapTicket: BOOTSTRAP_TICKET,
  attempt: 1,
});

describe('RealtimeVoiceService — réconciliation du bootstrap Mistral v2', () => {
  it('parse uniquement le body exact et borne la tentative de 1 à 8', () => {
    expect(parseRealtimeBootstrapReconciliationBody(BODY)).toEqual({ ok: true, value: BODY });

    for (const body of [
      null,
      [],
      { ...BODY, protocol: 'bob.mistral-pcm.v1' },
      { ...BODY, bootstrapTicket: `r2_${'R'.repeat(43)}` },
      { ...BODY, bootstrapTicket: BOOTSTRAP_TICKET.slice(0, -1) },
      { ...BODY, attempt: 0 },
      { ...BODY, attempt: 9 },
      { ...BODY, attempt: 1.5 },
      { ...BODY, providerSessionId: 'private' },
      { protocol: BODY.protocol, bootstrapTicket: BODY.bootstrapTicket },
    ]) expect(parseRealtimeBootstrapReconciliationBody(body)).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
  });

  it('refuse toute réconciliation live avant l’autorité sans capability runtime attestée', async () => {
    const reconcile = vi.fn<
      MistralConversationResumeAuthority['reconcileInitialBootstrap']
    >(async () => ({ status: 'retry_initial' }));

    await expect(runAsPrincipal(() => service(
      authority(reconcile),
      loggerStub(),
      SETTINGS,
      false,
    ).reconcileInitialBootstrap(
      SESSION_HANDLE,
      BODY,
      new AbortController().signal,
    ))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-mistral-reconciliation' },
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each(['live_takeover', 'terminal_replay'] as const)(
    'lie strictement une capability %s au principal et à la preuve initiale',
    async (scope) => {
      const reconcile = vi.fn<
        MistralConversationResumeAuthority['reconcileInitialBootstrap']
      >(async (input) => ({
        status: 'issued',
        bootstrap: {
          companyId: input.companyId,
          sessionHandle: input.sessionHandle,
          ticket: RESUME_TICKET,
          protocol: MISTRAL_CONVERSATION_PROTOCOL,
          scope,
          ticketExpiresAt: '2026-07-19T12:00:30.000Z',
          expectedMissionConnectionEpoch: 2,
          clientAcceptedMissionConnectionEpoch: 0,
          resumeNextServerSequence: 0,
        },
      }));
      const logger = loggerStub();
      const signal = new AbortController().signal;

      await expect(runAsPrincipal(() => service(authority(reconcile), logger)
        .reconcileInitialBootstrap(SESSION_HANDLE, BODY, signal))).resolves.toEqual({
        ok: true,
        value: {
          status: 'issued',
          websocketUrl: SETTINGS.mistralWebsocketUrl,
          companyId: 'company-1',
          sessionHandle: SESSION_HANDLE,
          ticket: RESUME_TICKET,
          protocol: MISTRAL_CONVERSATION_PROTOCOL,
          scope,
          ticketExpiresAt: '2026-07-19T12:00:30.000Z',
          expectedMissionConnectionEpoch: 2,
          clientAcceptedMissionConnectionEpoch: 0,
          resumeNextServerSequence: 0,
        },
      });
      expect(reconcile).toHaveBeenCalledWith({
        companyId: 'company-1',
        userId: 'user-1',
        sessionHandle: SESSION_HANDLE,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        bootstrapTicket: BOOTSTRAP_TICKET,
        attempt: 1,
        signal,
      });
      expect(JSON.stringify((logger.audit as ReturnType<typeof vi.fn>).mock.calls))
        .not.toContain(BOOTSTRAP_TICKET);
      expect(JSON.stringify((logger.audit as ReturnType<typeof vi.fn>).mock.calls))
        .not.toContain(RESUME_TICKET);
    },
  );

  it.each(['retry_initial', 'attempt_consumed'] as const)(
    'rend l’état public exact %s sans capability synthétique',
    async (status) => {
      const reconcile = vi.fn<
        MistralConversationResumeAuthority['reconcileInitialBootstrap']
      >(async () => ({ status }));

      await expect(runAsPrincipal(() => service(authority(reconcile)).reconcileInitialBootstrap(
        SESSION_HANDLE,
        BODY,
        new AbortController().signal,
      ))).resolves.toEqual({ ok: true, value: { status } });
    },
  );

  it.each([
    ['not_found', 'not_found'],
    ['forbidden', 'not_found'],
    ['expired', 'conflict'],
    ['invalid', 'validation'],
    ['unavailable', 'unavailable'],
  ] as const)('mappe %s vers une erreur publique %s', async (status, kind) => {
    const reconcile = vi.fn<
      MistralConversationResumeAuthority['reconcileInitialBootstrap']
    >(async () => ({ status }));

    await expect(runAsPrincipal(() => service(authority(reconcile)).reconcileInitialBootstrap(
      SESSION_HANDLE,
      BODY,
      new AbortController().signal,
    ))).resolves.toMatchObject({ ok: false, error: { kind } });
  });

  it('refuse le principal absent, le signal déjà annulé et une autorité incohérente', async () => {
    const reconcile = vi.fn<
      MistralConversationResumeAuthority['reconcileInitialBootstrap']
    >(async (input) => ({
      status: 'issued',
      bootstrap: {
        companyId: 'company-attacker',
        sessionHandle: input.sessionHandle,
        ticket: RESUME_TICKET,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        scope: 'live_takeover',
        ticketExpiresAt: '2026-07-19T12:00:30.000Z',
        expectedMissionConnectionEpoch: 1,
        clientAcceptedMissionConnectionEpoch: 0,
        resumeNextServerSequence: 0,
      },
    }));
    const underTest = service(authority(reconcile));

    await expect(runAsPrincipal(() => underTest.reconcileInitialBootstrap(
      SESSION_HANDLE,
      BODY,
      new AbortController().signal,
    ), null)).resolves.toMatchObject({ ok: false, error: { kind: 'forbidden' } });

    const controller = new AbortController();
    controller.abort();
    await expect(runAsPrincipal(() => underTest.reconcileInitialBootstrap(
      SESSION_HANDLE,
      BODY,
      controller.signal,
    ))).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(reconcile).not.toHaveBeenCalled();

    await expect(runAsPrincipal(() => underTest.reconcileInitialBootstrap(
      SESSION_HANDLE,
      BODY,
      new AbortController().signal,
    ))).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('transforme une exception de l’autorité en 503 sans journaliser les tickets', async () => {
    const logger = loggerStub();
    const reconcile = vi.fn<
      MistralConversationResumeAuthority['reconcileInitialBootstrap']
    >(async () => { throw new Error(`sensitive ${BOOTSTRAP_TICKET}`); });

    await expect(runAsPrincipal(() => service(authority(reconcile), logger)
      .reconcileInitialBootstrap(SESSION_HANDLE, BODY, new AbortController().signal)))
      .resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain(BOOTSTRAP_TICKET);
  });
});
