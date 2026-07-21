import { describe, expect, it, vi } from 'vitest';
import type { AgentAskPayload, AgentRun } from '@bob/ai';
import type { AppError, Result } from '@bob/core';
import { getPrincipal } from '../../observability/logger';
import type { Persistence } from '../../persistence/persistence';
import {
  RealtimeBobAgentTurnAdapter,
  realtimeAgentContextVersion,
  type RealtimeBobAgentExecutor,
  type RealtimeAgentContextFence,
} from './realtime-agent-turn';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    kind: 'answer',
    intent: 'unknown',
    model: 'test',
    plan: ['Répondre'],
    card: { title: 'Bob', body: 'Réponse canonique.' },
    ...overrides,
  };
}

function harness(result: Result<AgentRun, AppError>, requiredProvider: 'openai' | 'mistral' = 'openai') {
  const runWithTenant = vi.fn(async (_companyId: string, operation: () => Promise<unknown>) => operation());
  const askBob = vi.fn<RealtimeBobAgentExecutor['askBob']>(
    async (_payload: AgentAskPayload, _execution) => result,
  );
  const persistence = { runWithTenant } as unknown as Persistence;
  const executor: RealtimeBobAgentExecutor = { askBob };
  return {
    adapter: new RealtimeBobAgentTurnAdapter(persistence, requiredProvider, () => executor),
    runWithTenant,
    askBob,
  };
}

const context = {
  screen: { name: '/home', instanceId: 'home-1' },
  entities: [],
  capabilities: ['screen.read'] as const,
};

const contextVersion = realtimeAgentContextVersion({ version: 1, revision: 1, context });

function contextFence(
  revalidate: RealtimeAgentContextFence['revalidate'] = async () => contextVersion,
): RealtimeAgentContextFence {
  return { expected: contextVersion, revalidate };
}

function input(
  signal = new AbortController().signal,
  fence: RealtimeAgentContextFence = contextFence(),
) {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    transcript: 'Ouvre un nouveau devis',
    history: [],
    context,
    contextFence: fence,
    signal,
  };
}

describe('RealtimeBobAgentTurnAdapter', () => {
  it('exécute Bob dans un contexte identité+tenant neuf et impose confirm_all', async () => {
    const h = harness({ ok: true, value: run({ navigate: '/devis/new' }) });
    h.askBob.mockImplementationOnce(async (_payload) => {
      expect(getPrincipal()).toEqual({ userId: 'user-1', companyId: 'company-1' });
      return { ok: true, value: run({ navigate: '/devis/new' }) };
    });

    const result = await h.adapter.run(input());

    expect(result).toMatchObject({
      status: 'ready',
      canonicalSpeech: 'Réponse canonique.',
      navigate: '/devis/new',
    });
    expect(h.runWithTenant).toHaveBeenCalledWith('company-1', expect.any(Function));
    expect(h.askBob).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Ouvre un nouveau devis',
        autonomy: 'confirm_all',
        tone: 'pote',
      }),
      { signal: expect.any(AbortSignal), requiredProvider: 'openai' },
    );
  });

  it('propage le fournisseur Mistral exact sans le déduire des clés disponibles', async () => {
    const h = harness({ ok: true, value: run() }, 'mistral');

    await h.adapter.run(input());

    expect(h.askBob).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: expect.any(AbortSignal), requiredProvider: 'mistral' },
    );
  });

  it('préfère le prompt de consentement verbatim et ne publie que la proposition opaque', async () => {
    const h = harness({
      ok: true,
      value: run({
        kind: 'proposed',
        spokenPrompt: 'Je prépare la relance. Tu veux que je le fasse ?',
        navigate: 'https://evil.example',
        pending: {
          tool: 'send_relance',
          args: { invoiceId: 'private-id' },
          label: 'Relancer',
          proposalId: '00000000-0000-4000-8000-000000000001',
          expiresAt: '2026-07-13T20:00:00.000Z',
        },
      }),
    });

    const result = await h.adapter.run(input());

    expect(result).toMatchObject({
      status: 'ready',
      kind: 'proposed',
      canonicalSpeech: 'Je prépare la relance. Tu veux que je le fasse ?',
      proposalId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result).not.toHaveProperty('navigate');
    expect(JSON.stringify(result)).not.toContain('private-id');
  });

  it('rend une erreur publique bornée sans exposer la cause interne', async () => {
    const h = harness({
      ok: false,
      error: { kind: 'dependency', port: 'llm', cause: 'secret-upstream-stack' },
    });

    const result = await h.adapter.run(input());

    expect(result).toEqual({
      status: 'failed',
      canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.',
    });
    expect(JSON.stringify(result)).not.toContain('secret-upstream-stack');
  });

  it('ignore un résultat tardif après interruption', async () => {
    const controller = new AbortController();
    const h = harness({ ok: true, value: run() });
    let propagatedSignal: AbortSignal | undefined;
    h.askBob.mockImplementationOnce((_payload, execution) => {
      propagatedSignal = execution.signal;
      return new Promise<Result<AgentRun, AppError>>((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true });
      });
    });

    const outcome = h.adapter.run(input(controller.signal));
    await vi.waitFor(() => expect(h.askBob).toHaveBeenCalledOnce());
    controller.abort();

    await expect(outcome).resolves.toEqual({ status: 'aborted' });
    expect(propagatedSignal).toBe(controller.signal);
  });

  it('supprime tout rendu et contrôle si le contexte durable change pendant le tour', async () => {
    const h = harness({
      ok: true,
      value: run({
        kind: 'proposed',
        navigate: '/devis/new',
        pending: {
          tool: 'send_relance',
          args: { invoiceId: 'private-id' },
          label: 'Relancer',
          proposalId: '00000000-0000-4000-8000-000000000001',
          expiresAt: '2026-07-13T20:00:00.000Z',
        },
      }),
    });
    const changed = realtimeAgentContextVersion({ version: 1, revision: 2, context });

    const outcome = await h.adapter.run(input(undefined, contextFence(async () => changed)));

    expect(outcome).toEqual({ status: 'aborted' });
    expect(JSON.stringify(outcome)).not.toContain('proposal');
    expect(JSON.stringify(outcome)).not.toContain('/devis/new');
    expect(JSON.stringify(outcome)).not.toContain('private-id');
  });

  it('échoue fermé sans publier de contrôle si la relecture durable est indisponible', async () => {
    const h = harness({ ok: true, value: run({ navigate: '/devis/new' }) });

    const outcome = await h.adapter.run(input(undefined, contextFence(async () => {
      throw new Error('database unavailable');
    })));

    expect(outcome).toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas vérifier le contexte de cet écran. Rien n’a été exécuté.',
    });
    expect(outcome).not.toHaveProperty('navigate');
  });
});
