import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  OcrPort,
  PaymentGatewayPort,
  PdfRendererPort,
} from '@bob/core';
import {
  planRealtimeSemanticTurn,
  type PreclassifiedAgentPlan,
} from '@bob/ai';
import { MERCIER_PROPS } from '@bob/core/testing';
import { buildLlmForProvider } from './ai/providers';
import { BackendService } from './backend.service';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import {
  requestContext,
  type AppLogger,
} from './observability/logger';
import type { Metrics } from './observability/metrics';
import { InMemoryPersistence } from './persistence/persistence.testing';
import type { VoiceTraceRecorderPort } from './voice/voice-trace.port';
import {
  RealtimeBobAgentTurnAdapter,
  realtimeAgentContextVersion,
} from './voice/realtime/realtime-agent-turn';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function backend(
  persistence: InMemoryPersistence,
  voiceTrace: VoiceTraceRecorderPort | null = null,
) {
  const audit = vi.fn();
  const aiRequests = vi.fn();
  const aiDuration = vi.fn();
  const aiGuardViolations = vi.fn();
  const service = new BackendService(
    persistence,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    {
      setUserCompanyId: vi.fn(async () => undefined),
      deleteUser: vi.fn(async () => undefined),
    } as SupabaseAdminPort,
    {} as NotificationDeliveryService,
    {
      aiRequests: { inc: aiRequests },
      aiDuration: { observe: aiDuration },
      aiGuardViolations: { inc: aiGuardViolations },
    } as unknown as Metrics,
    {
      audit,
      error: vi.fn(),
      warn: vi.fn(),
      log: vi.fn(),
    } as unknown as AppLogger,
    undefined,
    undefined,
    null,
    null,
    voiceTrace,
  );
  return {
    service,
    audit,
    metrics: { aiRequests, aiDuration, aiGuardViolations },
  };
}

function helpCompletion(model: string): Response {
  return new Response(JSON.stringify({
    model,
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call-help',
              type: 'function',
              function: { name: 'aide_capacites', arguments: '{}' },
            },
          ],
        },
      },
    ],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function toolCompletion(model: string, name: string): Response {
  return new Response(JSON.stringify({
    model,
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: '{}' },
        }],
      },
    }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function runRealtimeTurn(
  provider: 'openai' | 'mistral',
  withCompetingKey: boolean,
) {
  vi.stubEnv('ANTHROPIC_API_KEY', withCompetingKey ? 'anthropic-key' : '');
  vi.stubEnv('GLM_API_KEY', withCompetingKey ? 'glm-key' : '');
  vi.stubEnv('GLM_URL', 'https://glm.test/v1');
  vi.stubEnv('GLM_MODEL', 'glm-provider-isolation-test');
  vi.stubEnv('DEEPSEEK_API_KEY', withCompetingKey ? 'deepseek-key' : '');
  vi.stubEnv('DEEPSEEK_URL', 'https://deepseek.test/v1');
  vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-provider-isolation-test');
  vi.stubEnv('OPENAI_API_KEY', 'openai-key');
  vi.stubEnv('OPENAI_URL', 'https://openai.test/v1');
  vi.stubEnv('OPENAI_MODEL', 'gpt-provider-isolation-test');
  vi.stubEnv('MISTRAL_API_KEY', 'mistral-key');
  vi.stubEnv('MISTRAL_URL', 'https://mistral.test/v1');
  vi.stubEnv('MISTRAL_MODEL', 'mistral-provider-isolation-test');
  if (!withCompetingKey) {
    vi.stubEnv(provider === 'openai' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY', '');
  }

  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => helpCompletion(
      provider === 'openai' ? 'gpt-provider-isolation-proof' : 'mistral-provider-isolation-proof',
    ),
  );
  vi.stubGlobal('fetch', fetchMock);

  const persistence = new InMemoryPersistence();
  await persistence.seed();
  const { service, audit } = backend(persistence);
  const llm = buildLlmForProvider(provider);
  if (llm === undefined) throw new Error('provider LLM attendu');
  const adapter = new RealtimeBobAgentTurnAdapter(
    persistence,
    provider,
    () => service,
    null,
    { plan: (input) => planRealtimeSemanticTurn(llm, input) },
  );
  const version = realtimeAgentContextVersion(null);
  const outcome = await adapter.run({
    turnId: '10000000-0000-4000-8000-000000000001',
    userId: 'user-owner',
    companyId: MERCIER_PROPS.id,
    transcript: 'Tu sais faire quoi ?',
    history: [],
    contextFence: {
      expected: version,
      revalidate: async () => version,
    },
    signal: new AbortController().signal,
  });

  return { outcome, fetchMock, audit };
}

async function runRealtimeNotificationMutation() {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('GLM_API_KEY', '');
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('MISTRAL_API_KEY', 'competing-mistral-key');
  vi.stubEnv('MISTRAL_URL', 'https://mistral.test/v1');
  vi.stubEnv('OPENAI_API_KEY', 'openai-key');
  vi.stubEnv('OPENAI_URL', 'https://openai.test/v1');
  vi.stubEnv('OPENAI_MODEL', 'gpt-provider-isolation-test');
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => toolCompletion(
      'gpt-provider-isolation-proof',
      'marquer_notifications_lues',
    ),
  );
  vi.stubGlobal('fetch', fetchMock);

  const persistence = new InMemoryPersistence();
  await persistence.seed();
  await persistence.notificationJobs.enqueue({
    id: 'notification-live-unread',
    companyId: MERCIER_PROPS.id,
    kind: 'invoice-relance',
    dedupeKey: 'invoice:live:relance:manual:v1',
    notification: {
      channel: 'email',
      to: 'client@example.test',
      subject: 'Relance',
      body: 'Relance en attente.',
      idempotencyKey: 'notification-live-unread',
    },
    now: '2026-07-30T11:59:00.000Z',
  });
  const notePlanning = vi.fn<VoiceTraceRecorderPort['notePlanning']>();
  const voiceTrace: VoiceTraceRecorderPort = {
    noteTranscription: vi.fn(),
    notePlanning,
    noteSynthesis: vi.fn(),
  };
  const { service, audit, metrics } = backend(persistence, voiceTrace);
  const llm = buildLlmForProvider('openai');
  if (llm === undefined) throw new Error('provider LLM attendu');
  const adapter = new RealtimeBobAgentTurnAdapter(
    persistence,
    'openai',
    () => service,
    null,
    { plan: (input) => planRealtimeSemanticTurn(llm, input) },
    () => new Date('2026-07-30T12:00:00.000Z'),
  );
  const version = realtimeAgentContextVersion(null);
  const outcome = await adapter.run({
    turnId: '10000000-0000-4000-8000-000000000002',
    userId: 'user-owner',
    companyId: MERCIER_PROPS.id,
    transcript: 'Marque toutes les notifications comme lues',
    history: [],
    contextFence: {
      expected: version,
      revalidate: async () => version,
    },
    signal: new AbortController().signal,
  });
  return {
    outcome,
    fetchMock,
    audit,
    metrics,
    notePlanning,
    persistence,
  };
}

describe('Bob Live — isolation fournisseur de bout en bout', () => {
  it('garde tout le tour sur OpenAI quand une clé Mistral concurrente existe', async () => {
    const { outcome, fetchMock, audit } = await runRealtimeTurn('openai', true);

    expect(outcome).toMatchObject({ status: 'ready', kind: 'answer' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openai.test/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer openai-key');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'gpt-provider-isolation-test',
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('mistral.test');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('mistral-key');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('glm.test');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('deepseek.test');
    expect(audit).toHaveBeenCalledWith('ai.ask', expect.objectContaining({
      selectedProvider: 'openai',
      requiredProvider: 'openai',
    }));
  });

  it('fonctionne avec OpenAI comme unique clé LLM disponible', async () => {
    const { outcome, fetchMock } = await runRealtimeTurn('openai', false);

    expect(outcome).toMatchObject({ status: 'ready', kind: 'answer' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openai.test/v1/chat/completions');
  });

  it('garde symétriquement un tour Mistral quand tous les fournisseurs sont configurés', async () => {
    const { outcome, fetchMock, audit } = await runRealtimeTurn('mistral', true);

    expect(outcome).toMatchObject({ status: 'ready', kind: 'answer' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://mistral.test/v1/chat/completions');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mistral-key');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'mistral-provider-isolation-test',
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('openai.test');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('openai-key');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('glm.test');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('deepseek.test');
    expect(audit).toHaveBeenCalledWith('ai.ask', expect.objectContaining({
      selectedProvider: 'mistral',
      requiredProvider: 'mistral',
    }));
  });

  it('planifie une mutation une seule fois, conserve consentement/journal et exclut VoiceTrace V1', async () => {
    const {
      outcome,
      fetchMock,
      audit,
      metrics,
      notePlanning,
      persistence,
    } = await runRealtimeNotificationMutation();

    expect(outcome).toMatchObject({
      status: 'ready',
      kind: 'proposed',
      proposalId: expect.any(String),
      proposalExpiresAt: expect.any(String),
    });
    if (outcome.status !== 'ready' || outcome.proposalId === undefined) {
      throw new Error('proposition opaque attendue');
    }
    // Une complétion = le planner sémantique. L'enveloppe Backend préclassifiée ne rappelle
    // aucun LLM pour classifier ou naturaliser la proposition.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openai.test/v1/chat/completions');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('mistral.test');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('competing-mistral-key');

    const journal = await persistence.agentJournal.load(
      MERCIER_PROPS.id,
      outcome.proposalId,
    );
    const planned = journal.find((entry) => entry.phase === 'planned');
    const owner = journal.find((entry) => entry.tool === '__proposal_owner__');
    expect(planned).toMatchObject({
      tool: 'marquer_notifications_lues',
      mutating: true,
    });
    expect(owner).toMatchObject({
      phase: 'executed',
      args: {
        userId: 'user-owner',
        ownership: expect.objectContaining({
          admittedMissionKinds: [],
          bindings: [expect.objectContaining({
            tool: 'marquer_notifications_lues',
            intent: 'marquer_notifications_lues',
          })],
        }),
      },
    });
    expect(
      Date.parse(outcome.proposalExpiresAt ?? '') - Date.parse(planned?.at ?? ''),
    ).toBe(10 * 60 * 1_000);

    expect(audit).toHaveBeenCalledWith('ai.ask', expect.objectContaining({
      selectedProvider: 'openai',
      requiredProvider: 'openai',
      requestedAutonomy: 'confirm_all',
      effectiveAutonomy: 'confirm_all',
      planningSource: 'realtime_semantic_planner',
      plannerDurationMs: expect.any(Number),
    }));
    expect(notePlanning).not.toHaveBeenCalled();
    expect(metrics.aiRequests).toHaveBeenCalledOnce();
    expect(metrics.aiDuration).toHaveBeenCalledOnce();
  });

  it('refuse un plan préclassifié avant tout effet si le tenant n’a pas l’entitlement IA', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-key');
    vi.stubEnv('MISTRAL_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const persistence = new InMemoryPersistence();
    await persistence.seed();
    const subscription = await persistence.subscriptions.findByCompanyId(MERCIER_PROPS.id);
    if (subscription === null) throw new Error('abonnement de test attendu');
    await persistence.subscriptions.save({ ...subscription, plan: 'free' });
    const append = vi.spyOn(persistence.agentJournal, 'append');
    const { service, audit, metrics } = backend(persistence);
    const plan: PreclassifiedAgentPlan = Object.freeze({
      schema: 'bob.preclassified-agent-plan',
      version: 1,
      steps: Object.freeze([Object.freeze({
        intent: 'marquer_notifications_lues',
        reference: null,
      })]),
      model: 'gpt-provider-isolation-proof',
    });

    const result = await requestContext.run(
      {
        correlationId: 'entitlement-before-effect',
        principal: { userId: 'user-owner', companyId: MERCIER_PROPS.id },
      },
      () => service.askBobWithPlan(
        {
          message: 'Marque toutes les notifications comme lues',
          autonomy: 'confirm_all',
        },
        plan,
        { requiredProvider: 'openai', plannerDurationMs: 12 },
      ),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'forbidden',
        reason: "L'assistant Bob est inclus à partir de l'offre Solo.",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(metrics.aiRequests).not.toHaveBeenCalled();
    expect(metrics.aiDuration).not.toHaveBeenCalled();
  });
});
