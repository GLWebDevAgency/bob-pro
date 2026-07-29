import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  OcrPort,
  PaymentGatewayPort,
  PdfRendererPort,
} from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { AppLogger } from './observability/logger';
import type { Metrics } from './observability/metrics';
import { InMemoryPersistence } from './persistence/persistence.testing';
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

function backend(persistence: InMemoryPersistence) {
  const audit = vi.fn();
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
      aiRequests: { inc: vi.fn() },
      aiDuration: { observe: vi.fn() },
      aiGuardViolations: { inc: vi.fn() },
    } as unknown as Metrics,
    {
      audit,
      error: vi.fn(),
      warn: vi.fn(),
      log: vi.fn(),
    } as unknown as AppLogger,
  );
  return { service, audit };
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
  const adapter = new RealtimeBobAgentTurnAdapter(persistence, provider, () => service);
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
});
