import { describe, expect, it, vi } from 'vitest';
import type { AgentAskPayload, AgentRun } from '@bob/ai';
import type { AppError, Result } from '@bob/core';
import { getPrincipal } from '../../observability/logger';
import type { Persistence } from '../../persistence/persistence';
import { prepareRealtimeContext } from './realtime-context';
import {
  classifyRealtimeAgentSpeechPurpose,
  RealtimeBobAgentTurnAdapter,
  realtimeAgentContextVersion,
  type RealtimeBobAgentExecutor,
  type RealtimeAgentContextFence,
} from './realtime-agent-turn';
import type {
  RealtimeQuoteMissionOrchestratorPort,
} from './realtime-quote-mission-orchestrator';

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

function harness(
  result: Result<AgentRun, AppError>,
  requiredProvider: 'openai' | 'mistral' = 'openai',
  quoteMissions: RealtimeQuoteMissionOrchestratorPort | null = null,
) {
  const runWithTenant = vi.fn(async (_companyId: string, operation: () => Promise<unknown>) => operation());
  const askBob = vi.fn<RealtimeBobAgentExecutor['askBob']>(
    async (_payload: AgentAskPayload, _execution) => result,
  );
  const persistence = { runWithTenant } as unknown as Persistence;
  const executor: RealtimeBobAgentExecutor = { askBob };
  return {
    adapter: new RealtimeBobAgentTurnAdapter(
      persistence,
      requiredProvider,
      () => executor,
      quoteMissions,
    ),
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

describe('realtimeAgentContextVersion', () => {
  it('réutilise exactement le digest canonique durable sans y mélanger la révision', () => {
    const first = { version: 1 as const, revision: 1, context };
    const second = { version: 1 as const, revision: 2, context };
    const prepared = prepareRealtimeContext(first);
    if (prepared === null) throw new Error('contexte de test canonique attendu');

    expect(realtimeAgentContextVersion(first)).toEqual({
      version: 1,
      revision: 1,
      digest: prepared.digest,
    });
    expect(realtimeAgentContextVersion(second)).toEqual({
      version: 1,
      revision: 2,
      digest: prepared.digest,
    });
  });
});

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
    turnId: '10000000-0000-4000-8000-000000000001',
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
  it('refuse un turnId qui ne peut pas porter l’idempotence durable', async () => {
    const h = harness({ ok: true, value: run({ navigate: '/devis/new' }) });

    const result = await h.adapter.run({
      ...input(),
      turnId: 'not-a-command-id',
    });

    expect(result).toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas sécuriser ce tour. Rien n’a été exécuté.',
    });
    expect(h.askBob).not.toHaveBeenCalled();
    expect(h.runWithTenant).not.toHaveBeenCalled();
  });

  it('exécute Bob dans un contexte identité+tenant neuf et impose confirm_all', async () => {
    const h = harness({ ok: true, value: run({ navigate: '/devis/new' }) });
    h.askBob.mockImplementationOnce(async (_payload) => {
      expect(getPrincipal()).toEqual({ userId: 'user-1', companyId: 'company-1' });
      return { ok: true, value: run({ navigate: '/devis/new' }) };
    });

    const result = await h.adapter.run(input());

    expect(result).toMatchObject({
      status: 'ready',
      turnId: '10000000-0000-4000-8000-000000000001',
      canonicalSpeech: 'Réponse canonique.',
      navigate: '/devis/new',
      speechPurpose: 'navigation',
      speechSource: 'card_body',
      hasTenantContext: true,
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

  it('ne rend la navigation mission qu’après orchestration et double revalidation du contexte', async () => {
    const runMission = vi.fn<RealtimeQuoteMissionOrchestratorPort['run']>(
      async () => ({
        status: 'ready',
        canonicalSpeech: 'Mission vérifiée.',
        navigate: '/devis/new',
      }),
    );
    const h = harness(
      { ok: true, value: run({ navigate: '/devis/new' }) },
      'openai',
      { run: runMission },
    );
    const revalidate = vi.fn(async () => contextVersion);
    const missionInput = {
      ...input(undefined, contextFence(revalidate)),
      agentMissionAuthority: {
        owner: { companyId: 'company-1', ownerUserId: 'user-1' },
        proof: {
          subjectHashCandidates: ['a'.repeat(64)],
          principalBindingHash: 'b'.repeat(64),
          capabilityHash: 'c'.repeat(64),
        },
        realtimeSessionId: '20000000-0000-4000-8000-000000000001',
      },
    };

    await expect(h.adapter.run(missionInput)).resolves.toEqual({
      status: 'ready',
      turnId: missionInput.turnId,
      canonicalSpeech: 'Mission vérifiée.',
      kind: 'answer',
      speechPurpose: 'navigation',
      speechSource: 'card_body',
      hasTenantContext: true,
      contextVersion,
      navigate: '/devis/new',
    });
    expect(runMission).toHaveBeenCalledWith(expect.objectContaining({
      authority: missionInput.agentMissionAuthority,
      turnId: missionInput.turnId,
      transcript: missionInput.transcript,
      contextRevision: 1,
      contextDigest: contextVersion.digest,
    }));
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(h.askBob).not.toHaveBeenCalled();
    expect(h.runWithTenant).not.toHaveBeenCalled();
  });

  it('publie la progression mission sans renavigation ni double traitement générique', async () => {
    const runMission = vi.fn<RealtimeQuoteMissionOrchestratorPort['run']>(
      async () => ({
        status: 'handled',
        canonicalSpeech: 'Deux clients possibles.',
        speechPurpose: 'structured_choice',
      }),
    );
    const h = harness(
      { ok: true, value: run({ navigate: '/devis/new' }) },
      'openai',
      { run: runMission },
    );
    const revalidate = vi.fn(async () => contextVersion);
    const missionInput = {
      ...input(undefined, contextFence(revalidate)),
      agentMissionAuthority: {
        owner: { companyId: 'company-1', ownerUserId: 'user-1' },
        proof: {
          subjectHashCandidates: ['a'.repeat(64)],
          principalBindingHash: 'b'.repeat(64),
          capabilityHash: 'c'.repeat(64),
        },
        realtimeSessionId: '20000000-0000-4000-8000-000000000001',
      },
    };

    const outcome = await h.adapter.run(missionInput);

    expect(outcome).toEqual({
      status: 'ready',
      turnId: missionInput.turnId,
      canonicalSpeech: 'Deux clients possibles.',
      kind: 'answer',
      speechPurpose: 'structured_choice',
      speechSource: 'card_body',
      hasTenantContext: true,
      contextVersion,
    });
    expect(outcome).not.toHaveProperty('navigate');
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(h.askBob).not.toHaveBeenCalled();
    expect(h.runWithTenant).not.toHaveBeenCalled();
  });

  it('interdit au moteur historique de contourner une mission par /devis/new', async () => {
    const runMission = vi.fn<RealtimeQuoteMissionOrchestratorPort['run']>(
      async () => ({ status: 'not_applicable' }),
    );
    const h = harness(
      { ok: true, value: run({ navigate: '/devis/new' }) },
      'openai',
      { run: runMission },
    );

    const outcome = await h.adapter.run({
      ...input(),
      agentMissionAuthority: {
        owner: { companyId: 'company-1', ownerUserId: 'user-1' },
        proof: {
          subjectHashCandidates: ['a'.repeat(64)],
          principalBindingHash: 'b'.repeat(64),
          capabilityHash: 'c'.repeat(64),
        },
        realtimeSessionId: '20000000-0000-4000-8000-000000000001',
      },
    });

    expect(outcome).toEqual({
      status: 'failed',
      canonicalSpeech:
        'Je ne peux pas ouvrir un devis sans mission vérifiée. Rien n’a été exécuté.',
    });
    expect(h.askBob).toHaveBeenCalledOnce();
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
      speechPurpose: 'action_proposal',
      speechSource: 'spoken_prompt',
      hasTenantContext: true,
    });
    expect(result).not.toHaveProperty('navigate');
    expect(JSON.stringify(result)).not.toContain('private-id');
  });

  it('qualifie explicitement la provenance et ferme les réponses ambiguës sur business_answer', () => {
    expect(classifyRealtimeAgentSpeechPurpose(run({ intent: 'aide' }), false))
      .toBe('generic_assistance');
    expect(classifyRealtimeAgentSpeechPurpose(run({ intent: 'unknown', naturalBody: 'Avec plaisir.' }), false))
      .toBe('business_answer');
    expect(classifyRealtimeAgentSpeechPurpose(run({ intent: 'aide' }), true))
      .toBe('business_answer');
    expect(classifyRealtimeAgentSpeechPurpose(run({ choices: [{ label: 'A', value: 'a' }] }), false))
      .toBe('structured_choice');
    expect(classifyRealtimeAgentSpeechPurpose(run({ kind: 'done' }), false))
      .toBe('action_result');
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
