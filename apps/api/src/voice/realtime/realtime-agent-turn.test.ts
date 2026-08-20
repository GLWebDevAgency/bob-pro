import { describe, expect, it, vi } from 'vitest';
import type {
  AgentAskPayload,
  AgentRun,
  PreclassifiedAgentPlan,
  QuoteCreationSemanticFrameV1,
  RealtimeSemanticHostManifest,
  RealtimeSemanticPlannerResult,
} from '@bob/ai';
import {
  CUSTOMER_CONTACT_MISSION_KIND_V1,
  QUOTE_CREATION_MISSION_KIND_V1,
  type AppError,
  type CustomerContactSemanticFrameV1,
  type Result,
} from '@bob/core';
import { getPrincipal } from '../../observability/logger';
import type { Persistence } from '../../persistence/persistence';
import { prepareRealtimeContext } from './realtime-context';
import {
  classifyRealtimeAgentSpeechPurpose,
  RealtimeBobAgentTurnAdapter,
  realtimeAgentContextVersion,
  type RealtimeBobAgentExecutor,
  type RealtimeAgentContextFence,
  type RealtimeSemanticPlannerPort,
} from './realtime-agent-turn';
import type {
  RealtimeQuoteMissionOrchestrationOutcome,
  RealtimeQuoteMissionOrchestratorPort,
  RealtimeQuoteMissionPreparedTurn,
} from './realtime-quote-mission-orchestrator';
import type {
  RealtimeJarvisMissionOrchestrationOutcome,
  RealtimeJarvisMissionOrchestratorPort,
  RealtimeJarvisMissionPreparedTurn,
} from './realtime-jarvis-mission-orchestrator';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    kind: 'answer',
    intent: 'unknown',
    model: 'gpt-test',
    plan: ['Répondre'],
    card: { title: 'Bob', body: 'Réponse canonique.' },
    ...overrides,
  };
}

function globalPlan(
  intent: PreclassifiedAgentPlan['steps'][number]['intent'] = 'nouveau_devis',
): PreclassifiedAgentPlan {
  return Object.freeze({
    schema: 'bob.preclassified-agent-plan',
    version: 1,
    steps: Object.freeze([Object.freeze({ intent, reference: null })]),
    model: 'gpt-test',
  });
}

function outOfScopePlan(): PreclassifiedAgentPlan {
  return Object.freeze({
    schema: 'bob.preclassified-agent-plan',
    version: 1,
    steps: Object.freeze([]),
    model: 'gpt-test',
  });
}

const MISSION_FRAME = Object.freeze({
  schema: 'bob.semantic.quote-creation',
  version: 1,
  operation: Object.freeze({
    kind: 'start_quote_creation',
    customerReference: null,
  }),
  model: 'gpt-test',
}) satisfies QuoteCreationSemanticFrameV1;

const PREPARED_MISSION = Object.freeze({
  protocolVersion: 1,
  snapshot: Object.freeze({ mission: null }),
  semanticContext: Object.freeze({
    missionAlias: null,
    missionRevision: 0,
    confirmedLineCount: 0,
    pendingLineCount: 0,
    pendingDecisionKind: null,
    protocolVersion: 1,
    phase: 'inactive',
    presentedChoices: Object.freeze([]),
  }),
  availableCapabilities: Object.freeze(['quote.customer.resolve']),
}) satisfies RealtimeQuoteMissionPreparedTurn;

const LEGACY_HOST_MANIFEST = Object.freeze({
  schema: 'bob.realtime-semantic-host-manifest',
  version: 1,
  globalToolNames: [
    'factures_impayees',
    'nouveau_devis',
    'ouvrir_cloture',
    'aide_capacites',
  ] as const,
}) satisfies RealtimeSemanticHostManifest;

const MISSION_HOST_MANIFEST = Object.freeze({
  ...LEGACY_HOST_MANIFEST,
  globalToolNames: ['factures_impayees', 'ouvrir_cloture', 'aide_capacites'] as const,
}) satisfies RealtimeSemanticHostManifest;

function missionPort(
  outcome: RealtimeQuoteMissionOrchestrationOutcome = {
    status: 'ready',
    canonicalSpeech: 'Mission vérifiée.',
    navigate: '/devis/new',
  },
): RealtimeQuoteMissionOrchestratorPort & {
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly runPlanned: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn(async () => ({
    status: 'prepared' as const,
    prepared: PREPARED_MISSION,
  }));
  const runPlanned = vi.fn(async () => outcome);
  return { prepare, runPlanned };
}

function harness(
  options: {
    readonly result?: Result<AgentRun, AppError>;
    readonly requiredProvider?: 'openai' | 'mistral';
    readonly quoteMissions?: RealtimeQuoteMissionOrchestratorPort | null;
    readonly customerContactMissions?: RealtimeJarvisMissionOrchestratorPort | null;
    readonly planning?: RealtimeSemanticPlannerResult;
  } = {},
) {
  const result = options.result ?? {
    ok: true as const,
    value: run({ navigate: '/devis/new' }),
  };
  const planning = options.planning ?? {
    status: 'global_plan' as const,
    plan: globalPlan(),
    plannerDurationMs: 12,
  };
  const runWithTenant = vi.fn(async (_companyId: string, operation: () => Promise<unknown>) =>
    operation(),
  );
  const askBobWithPlan = vi.fn<RealtimeBobAgentExecutor['askBobWithPlan']>(
    async (_payload: AgentAskPayload, _plan, _execution) => result,
  );
  const prepareRealtimeSemanticHost = vi.fn<
    RealtimeBobAgentExecutor['prepareRealtimeSemanticHost']
  >(async (input) => ({
    ok: true,
    value: input.admittedMissionKinds.length === 0 ? LEGACY_HOST_MANIFEST : MISSION_HOST_MANIFEST,
  }));
  const planner = vi.fn<RealtimeSemanticPlannerPort['plan']>(async () => planning);
  const persistence = { runWithTenant } as unknown as Persistence;
  const executor: RealtimeBobAgentExecutor = {
    prepareRealtimeSemanticHost,
    askBobWithPlan,
  };
  const quoteMissions = options.quoteMissions ?? null;
  const customerContactMissions = options.customerContactMissions ?? null;
  return {
    adapter: new RealtimeBobAgentTurnAdapter(
      persistence,
      options.requiredProvider ?? 'openai',
      () => executor,
      quoteMissions,
      { plan: planner },
      () => new Date('2026-07-30T12:00:00.000Z'),
      customerContactMissions,
    ),
    runWithTenant,
    prepareRealtimeSemanticHost,
    askBobWithPlan,
    planner,
    quoteMissions,
    customerContactMissions,
  };
}

const context = {
  screen: { name: '/home', instanceId: 'home-1' },
  entities: [],
  capabilities: ['screen.read'] as const,
};

const contextVersion = realtimeAgentContextVersion({
  version: 1,
  revision: 1,
  context,
});

describe('realtimeAgentContextVersion', () => {
  it('réutilise le digest canonique durable sans y mélanger la révision', () => {
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
    confirmedTimeZone: {
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T00:00:00.000Z',
    },
    contextFence: fence,
    signal,
  };
}

function missionInput(
  signal = new AbortController().signal,
  fence: RealtimeAgentContextFence = contextFence(),
) {
  return {
    ...input(signal, fence),
    // U1-d : les kinds admis viennent de l'admission de session, plus d'une liste codée en dur.
    admittedMissionKinds: [QUOTE_CREATION_MISSION_KIND_V1],
    agentMissionAuthority: {
      owner: { companyId: 'company-1', ownerUserId: 'user-1' },
      proof: {
        protocolVersion: 1 as const,
        subjectHashCandidates: ['a'.repeat(64)],
        principalBindingHash: 'b'.repeat(64),
        capabilityHash: 'c'.repeat(64),
      },
      realtimeSessionId: '20000000-0000-4000-8000-000000000001',
    },
  };
}

describe('RealtimeBobAgentTurnAdapter — planner unique', () => {
  it('refuse un turnId non idempotent avant planner, tenant ou domaine', async () => {
    const h = harness();

    await expect(
      h.adapter.run({
        ...input(),
        turnId: 'not-a-command-id',
      }),
    ).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas sécuriser ce tour. Rien n’a été exécuté.',
    });
    expect(h.planner).not.toHaveBeenCalled();
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
    expect(h.runWithTenant).not.toHaveBeenCalled();
  });

  it('échoue fermé avant tout LLM ou effet si le manifeste hôte ne peut pas être préparé', async () => {
    const h = harness();
    h.prepareRealtimeSemanticHost.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'dependency', port: 'subscription', cause: 'indisponible' },
    });

    await expect(h.adapter.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas vérifier mes capacités. Rien n’a été exécuté.',
    });
    expect(h.prepareRealtimeSemanticHost).toHaveBeenCalledOnce();
    expect(h.planner).not.toHaveBeenCalled();
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
    expect(h.runWithTenant).toHaveBeenCalledOnce();
  });

  it('planifie une seule fois puis exécute le plan global dans la même enveloppe serveur', async () => {
    const plan = globalPlan();
    const h = harness({
      planning: { status: 'global_plan', plan, plannerDurationMs: 17 },
    });
    h.askBobWithPlan.mockImplementationOnce(async (_payload, receivedPlan) => {
      expect(getPrincipal()).toEqual({
        userId: 'user-1',
        companyId: 'company-1',
        confirmedTimeZone: {
          timeZone: 'Europe/Paris',
          confirmedAt: '2026-07-31T00:00:00.000Z',
        },
      });
      expect(receivedPlan).toBe(plan);
      return { ok: true, value: run({ navigate: '/devis/new' }) };
    });

    await expect(h.adapter.run(input())).resolves.toMatchObject({
      status: 'ready',
      canonicalSpeech: 'Réponse canonique.',
      navigate: '/devis/new',
      speechPurpose: 'navigation',
      hasTenantContext: true,
    });
    expect(h.planner).toHaveBeenCalledOnce();
    expect(h.prepareRealtimeSemanticHost.mock.invocationCallOrder[0]).toBeLessThan(
      h.planner.mock.invocationCallOrder[0]!,
    );
    expect(h.planner.mock.invocationCallOrder[0]).toBeLessThan(
      h.askBobWithPlan.mock.invocationCallOrder[0]!,
    );
    expect(h.planner).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: 'Ouvre un nouveau devis',
        quoteMission: {
          missionAlias: null,
          missionRevision: 0,
          confirmedLineCount: 0,
          pendingLineCount: 0,
          pendingDecisionKind: null,
          protocolVersion: null,
          phase: 'unavailable',
          presentedChoices: [],
        },
        screen: {
          route: '/home',
          revision: 1,
          digest: contextVersion.digest,
        },
        hostManifest: LEGACY_HOST_MANIFEST,
        missionCapabilities: [],
        locale: 'fr-FR',
        timeZone: 'Europe/Paris',
        now: '2026-07-30T12:00:00.000Z',
      }),
    );
    expect(h.runWithTenant).toHaveBeenCalledWith('company-1', expect.any(Function));
    expect(h.askBobWithPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Ouvre un nouveau devis',
        autonomy: 'confirm_all',
        tone: 'pote',
      }),
      plan,
      {
        signal: expect.any(AbortSignal),
        requiredProvider: 'openai',
        plannerDurationMs: 17,
      },
    );
  });

  it('borne l’historique au planner et lui transmet le fuseau confirmé', async () => {
    const h = harness();
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('bob' as const),
      text: `tour-${index + 1}`,
    }));

    await h.adapter.run({ ...input(), history });

    const plannerInput = h.planner.mock.calls[0]?.[0];
    expect(plannerInput?.history.map((turn) => turn.text)).toEqual([
      'tour-3',
      'tour-4',
      'tour-5',
      'tour-6',
      'tour-7',
      'tour-8',
    ]);
    expect(plannerInput?.timeZone).toBe('Europe/Paris');
  });

  it('transmet null au planner quand un transport N-1 ne porte aucune confirmation', async () => {
    const h = harness();
    const { confirmedTimeZone: _confirmedTimeZone, ...withoutConfirmation } = input();

    await h.adapter.run(withoutConfirmation);

    expect(h.planner.mock.calls[0]?.[0].timeZone).toBeNull();
  });

  it('prépare la mission, planifie une fois, relit puis exécute uniquement la frame mission', async () => {
    const missions = missionPort();
    const h = harness({
      quoteMissions: missions,
      planning: {
        status: 'mission_frame',
        frame: MISSION_FRAME,
        plannerDurationMs: 19,
      },
    });
    const revalidate = vi.fn(async () => contextVersion);
    const turn = missionInput(undefined, contextFence(revalidate));

    await expect(h.adapter.run(turn)).resolves.toEqual({
      status: 'ready',
      turnId: turn.turnId,
      canonicalSpeech: 'Mission vérifiée.',
      kind: 'answer',
      speechPurpose: 'navigation',
      speechSource: 'card_body',
      hasTenantContext: true,
      contextVersion,
      navigate: '/devis/new',
    });
    expect(missions.prepare).toHaveBeenCalledOnce();
    expect(missions.runPlanned).toHaveBeenCalledWith({
      request: expect.objectContaining({
        authority: turn.agentMissionAuthority,
        contextRevision: 1,
        contextDigest: contextVersion.digest,
      }),
      prepared: PREPARED_MISSION,
      frame: MISSION_FRAME,
    });
    expect(h.planner).toHaveBeenCalledOnce();
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
    expect(h.prepareRealtimeSemanticHost).toHaveBeenCalledOnce();
    expect(h.runWithTenant).toHaveBeenCalledOnce();
    expect(revalidate).toHaveBeenCalledTimes(3);
  });

  it('n’exécute aucune frame mission si le contexte change pendant le planner', async () => {
    const missions = missionPort();
    const h = harness({
      quoteMissions: missions,
      planning: {
        status: 'mission_frame',
        frame: MISSION_FRAME,
        plannerDurationMs: 19,
      },
    });
    const changedContext = { ...contextVersion, revision: 2 };
    let validation = 0;
    const revalidate = vi.fn(async () => {
      validation += 1;
      return validation === 1 ? contextVersion : changedContext;
    });

    await expect(h.adapter.run(missionInput(undefined, contextFence(revalidate)))).resolves.toEqual(
      { status: 'aborted' },
    );

    expect(missions.prepare).toHaveBeenCalledOnce();
    expect(h.planner).toHaveBeenCalledOnce();
    expect(missions.runPlanned).not.toHaveBeenCalled();
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
    expect(h.prepareRealtimeSemanticHost).toHaveBeenCalledOnce();
    expect(h.runWithTenant).toHaveBeenCalledOnce();
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it('publie une décision structurée mission sans navigation ni double traitement', async () => {
    const missions = missionPort({
      status: 'handled',
      canonicalSpeech: 'Deux clients possibles.',
      speechPurpose: 'structured_choice',
    });
    const h = harness({
      quoteMissions: missions,
      planning: {
        status: 'mission_frame',
        frame: MISSION_FRAME,
        plannerDurationMs: 10,
      },
    });

    await expect(h.adapter.run(missionInput())).resolves.toEqual({
      status: 'ready',
      turnId: input().turnId,
      canonicalSpeech: 'Deux clients possibles.',
      kind: 'answer',
      speechPurpose: 'structured_choice',
      speechSource: 'card_body',
      hasTenantContext: true,
      contextVersion,
    });
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
  });

  it('route un geste global sous mission vers le plan injecté avec ownership admis', async () => {
    const missions = missionPort();
    const plan = globalPlan('factures');
    const h = harness({
      quoteMissions: missions,
      planning: { status: 'global_plan', plan, plannerDurationMs: 14 },
      result: { ok: true, value: run({ intent: 'factures' }) },
    });

    await expect(h.adapter.run(missionInput())).resolves.toMatchObject({
      status: 'ready',
      canonicalSpeech: 'Réponse canonique.',
    });
    expect(missions.prepare).toHaveBeenCalledOnce();
    expect(missions.runPlanned).not.toHaveBeenCalled();
    expect(h.askBobWithPlan).toHaveBeenCalledWith(expect.any(Object), plan, {
      signal: expect.any(AbortSignal),
      requiredProvider: 'openai',
      admittedMissionKinds: [QUOTE_CREATION_MISSION_KIND_V1],
      plannerDurationMs: 14,
    });
  });

  it('n’exécute aucun plan global si le contexte change pendant le planner', async () => {
    const h = harness({
      planning: {
        status: 'global_plan',
        plan: globalPlan('factures'),
        plannerDurationMs: 14,
      },
    });
    const changedContext = { ...contextVersion, revision: 2 };
    const revalidate = vi.fn(async () => changedContext);

    await expect(h.adapter.run(input(undefined, contextFence(revalidate)))).resolves.toEqual({
      status: 'aborted',
    });

    expect(h.planner).toHaveBeenCalledOnce();
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
    expect(h.prepareRealtimeSemanticHost).toHaveBeenCalledOnce();
    expect(h.runWithTenant).toHaveBeenCalledOnce();
    expect(revalidate).toHaveBeenCalledOnce();
  });

  it('traite le hors-périmètre par le plan vide sans second cerveau', async () => {
    const plan = outOfScopePlan();
    const h = harness({
      planning: { status: 'out_of_scope', plan, plannerDurationMs: 8 },
      result: { ok: true, value: run() },
    });

    await h.adapter.run({ ...input(), transcript: 'Raconte-moi une blague' });

    expect(h.planner).toHaveBeenCalledOnce();
    expect(h.askBobWithPlan).toHaveBeenCalledWith(
      expect.any(Object),
      plan,
      expect.objectContaining({ plannerDurationMs: 8 }),
    );
  });

  it('rejette une sortie sémantique invalide sans exécuteur ni mutation', async () => {
    const h = harness({
      planning: {
        status: 'rejected',
        reason: 'mixed_authorities',
        plannerDurationMs: 9,
      },
    });

    await expect(h.adapter.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech:
        'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.',
    });
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
    expect(h.prepareRealtimeSemanticHost).toHaveBeenCalledOnce();
    expect(h.runWithTenant).toHaveBeenCalledOnce();
  });

  it('refuse une frame mission forgée quand aucune capability mission n’est admise', async () => {
    const h = harness({
      planning: {
        status: 'mission_frame',
        frame: MISSION_FRAME,
        plannerDurationMs: 7,
      },
    });

    await expect(h.adapter.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.',
    });
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
  });

  it('échoue fermé avant le planner si la projection mission est indisponible', async () => {
    const prepare = vi.fn(async () => ({
      status: 'failed' as const,
      canonicalSpeech: 'Mission indisponible.',
    }));
    const missions: RealtimeQuoteMissionOrchestratorPort = {
      prepare,
      runPlanned: vi.fn(),
    };
    const h = harness({ quoteMissions: missions });

    await expect(h.adapter.run(missionInput())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: 'Mission indisponible.',
    });
    expect(h.planner).not.toHaveBeenCalled();
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
  });

  it('restitue le refus d’ownership du domaine sans contourner la mission', async () => {
    const missions = missionPort();
    const h = harness({
      quoteMissions: missions,
      planning: {
        status: 'global_plan',
        plan: globalPlan(),
        plannerDurationMs: 11,
      },
      result: {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_intent_ownership',
          reason: 'mission_owned',
        },
      },
    });

    await expect(h.adapter.run(missionInput())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech:
        'Je garde la création du devis dans la mission sécurisée. Rien n’a été exécuté. Reformule uniquement l’étape du devis.',
    });
  });

  it('bloque /devis/new si un exécuteur non conforme ignore encore l’ownership', async () => {
    const missions = missionPort();
    const h = harness({
      quoteMissions: missions,
      planning: {
        status: 'global_plan',
        plan: globalPlan('factures'),
        plannerDurationMs: 11,
      },
      result: { ok: true, value: run({ navigate: '/devis/new' }) },
    });

    await expect(h.adapter.run(missionInput())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech:
        'Je ne peux pas ouvrir un devis sans mission vérifiée. Rien n’a été exécuté.',
    });
  });

  it('propage le fournisseur Mistral exact au même exécuteur préclassifié', async () => {
    const h = harness({ requiredProvider: 'mistral' });

    await h.adapter.run(input());

    expect(h.askBobWithPlan).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ requiredProvider: 'mistral' }),
    );
  });

  it('préfère le consentement verbatim et ne publie que la proposition opaque', async () => {
    const h = harness({
      result: {
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
      },
    });

    const result = await h.adapter.run(input());

    expect(result).toMatchObject({
      status: 'ready',
      kind: 'proposed',
      canonicalSpeech: 'Je prépare la relance. Tu veux que je le fasse ?',
      proposalId: '00000000-0000-4000-8000-000000000001',
      speechPurpose: 'action_proposal',
      speechSource: 'spoken_prompt',
    });
    expect(result).not.toHaveProperty('navigate');
    expect(JSON.stringify(result)).not.toContain('private-id');
  });

  it('qualifie explicitement la provenance des réponses', () => {
    expect(classifyRealtimeAgentSpeechPurpose(run({ intent: 'aide' }), false)).toBe(
      'generic_assistance',
    );
    expect(
      classifyRealtimeAgentSpeechPurpose(
        run({ intent: 'unknown', naturalBody: 'Avec plaisir.' }),
        false,
      ),
    ).toBe('business_answer');
    expect(classifyRealtimeAgentSpeechPurpose(run({ intent: 'aide' }), true)).toBe(
      'business_answer',
    );
    expect(
      classifyRealtimeAgentSpeechPurpose(run({ choices: [{ label: 'A', value: 'a' }] }), false),
    ).toBe('structured_choice');
    expect(classifyRealtimeAgentSpeechPurpose(run({ kind: 'done' }), false)).toBe('action_result');
  });

  it('borne toute erreur interne et n’expose jamais sa cause', async () => {
    const h = harness({
      result: {
        ok: false,
        error: { kind: 'dependency', port: 'llm', cause: 'secret-upstream-stack' },
      },
    });

    const result = await h.adapter.run(input());

    expect(result).toEqual({
      status: 'failed',
      canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.',
    });
    expect(JSON.stringify(result)).not.toContain('secret-upstream-stack');
  });

  it('annule le tour pendant le planner sans appeler le domaine', async () => {
    const controller = new AbortController();
    const h = harness();
    h.planner.mockImplementationOnce(
      async (plannerInput) =>
        new Promise<RealtimeSemanticPlannerResult>((_resolve, reject) => {
          plannerInput.signal?.addEventListener(
            'abort',
            () => reject(plannerInput.signal?.reason),
            { once: true },
          );
        }),
    );

    const outcome = h.adapter.run(input(controller.signal));
    await vi.waitFor(() => expect(h.planner).toHaveBeenCalledOnce());
    controller.abort();

    await expect(outcome).resolves.toEqual({ status: 'aborted' });
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
  });

  it('annule le résultat tardif de l’exécuteur avec le même signal', async () => {
    const controller = new AbortController();
    const h = harness();
    let propagatedSignal: AbortSignal | undefined;
    h.askBobWithPlan.mockImplementationOnce((_payload, _plan, execution) => {
      propagatedSignal = execution.signal;
      return new Promise<Result<AgentRun, AppError>>((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(execution.signal.reason), {
          once: true,
        });
      });
    });

    const outcome = h.adapter.run(input(controller.signal));
    await vi.waitFor(() => expect(h.askBobWithPlan).toHaveBeenCalledOnce());
    controller.abort();

    await expect(outcome).resolves.toEqual({ status: 'aborted' });
    expect(propagatedSignal).toBe(controller.signal);
  });

  it('supprime tout rendu si le contexte durable change après le tour', async () => {
    const h = harness({
      result: {
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
      },
    });
    const changed = realtimeAgentContextVersion({
      version: 1,
      revision: 2,
      context,
    });

    const outcome = await h.adapter.run(
      input(
        undefined,
        contextFence(async () => changed),
      ),
    );

    expect(outcome).toEqual({ status: 'aborted' });
    expect(JSON.stringify(outcome)).not.toContain('proposal');
    expect(JSON.stringify(outcome)).not.toContain('private-id');
  });

  it('échoue fermé si la relecture durable est indisponible', async () => {
    const h = harness();

    const outcome = await h.adapter.run(
      input(
        undefined,
        contextFence(async () => {
          throw new Error('database unavailable');
        }),
      ),
    );

    expect(outcome).toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas vérifier le contexte de cet écran. Rien n’a été exécuté.',
    });
    expect(outcome).not.toHaveProperty('navigate');
  });
});

// ---------------------------------------------------------------------------
// U1-d — routage PAR KIND : la fiche client n'existe que si l'admission l'a ouverte
// ---------------------------------------------------------------------------

const CONTACT_FRAME: CustomerContactSemanticFrameV1 = Object.freeze({
  schema: 'bob.semantic.customer-contact',
  version: 1,
  operation: Object.freeze({ kind: 'open_customer_creation', customerName: 'Dupont Plomberie' }),
  model: 'gpt-test',
});

const CONTACT_PREPARED = Object.freeze({
  missionKind: CUSTOMER_CONTACT_MISSION_KIND_V1,
  runId: '60000000-0000-4000-8000-000000000001',
  expectedRevision: 0,
  state: null,
  semanticContext: Object.freeze({
    runAlias: null,
    runRevision: 0,
    phase: 'inactive',
    intentMode: null,
    presentedDuplicateCount: 0,
    proposalPresented: false,
  }),
  availableCapabilities: Object.freeze(['customer_contact.run.open']),
}) satisfies RealtimeJarvisMissionPreparedTurn;

function contactPort(
  outcome: RealtimeJarvisMissionOrchestrationOutcome = {
    status: 'handled',
    canonicalSpeech: 'J’ouvre une nouvelle fiche client.',
    speechPurpose: 'action_result',
  },
): RealtimeJarvisMissionOrchestratorPort & {
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly runPlanned: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn(async () => ({
    status: 'prepared' as const,
    prepared: CONTACT_PREPARED,
  }));
  const runPlanned = vi.fn(async () => outcome);
  return { prepare, runPlanned };
}

describe('RealtimeBobAgentTurnAdapter — customer_contact@1 (U1-d)', () => {
  it('prépare et exécute la fiche client quand le kind est admis', async () => {
    const contact = contactPort();
    const h = harness({
      customerContactMissions: contact,
      planning: {
        status: 'mission_frame',
        missionKind: CUSTOMER_CONTACT_MISSION_KIND_V1,
        frame: CONTACT_FRAME,
        plannerDurationMs: 9,
      },
    });

    await expect(
      h.adapter.run({
        ...missionInput(),
        admittedMissionKinds: [CUSTOMER_CONTACT_MISSION_KIND_V1],
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      canonicalSpeech: 'J’ouvre une nouvelle fiche client.',
      speechPurpose: 'action_result',
    });
    expect(contact.prepare).toHaveBeenCalledOnce();
    expect(contact.runPlanned).toHaveBeenCalledOnce();
    expect(h.askBobWithPlan).not.toHaveBeenCalled();
    // La lentille et les capacités partent au planner, jamais une liste écrite en dur.
    expect(h.planner.mock.calls[0]?.[0]).toMatchObject({
      admittedMissionKinds: [CUSTOMER_CONTACT_MISSION_KIND_V1],
      customerContactMission: CONTACT_PREPARED.semanticContext,
      missionCapabilities: ['customer_contact.run.open'],
    });
  });

  it('n’exécute JAMAIS une frame fiche client si le kind n’est pas admis', async () => {
    const contact = contactPort();
    const h = harness({
      customerContactMissions: contact,
      planning: {
        status: 'mission_frame',
        missionKind: CUSTOMER_CONTACT_MISSION_KIND_V1,
        frame: CONTACT_FRAME,
        plannerDurationMs: 9,
      },
    });

    await expect(
      h.adapter.run({
        ...missionInput(),
        admittedMissionKinds: [QUOTE_CREATION_MISSION_KIND_V1],
      }),
    ).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.',
    });
    expect(contact.prepare).not.toHaveBeenCalled();
    expect(contact.runPlanned).not.toHaveBeenCalled();
  });

  it('laisse le chemin devis intact quand seule la fiche client est admise', async () => {
    const missions = missionPort();
    const contact = contactPort();
    const h = harness({
      quoteMissions: missions,
      customerContactMissions: contact,
      planning: {
        status: 'mission_frame',
        frame: MISSION_FRAME,
        plannerDurationMs: 4,
      },
    });

    await expect(
      h.adapter.run({
        ...missionInput(),
        admittedMissionKinds: [CUSTOMER_CONTACT_MISSION_KIND_V1],
      }),
    ).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.',
    });
    expect(missions.prepare).not.toHaveBeenCalled();
    expect(missions.runPlanned).not.toHaveBeenCalled();
    expect(contact.runPlanned).not.toHaveBeenCalled();
  });

  it('échoue fermé si la fiche client est admise sans orchestrateur câblé', async () => {
    const h = harness({ customerContactMissions: null });

    await expect(
      h.adapter.run({
        ...missionInput(),
        admittedMissionKinds: [CUSTOMER_CONTACT_MISSION_KIND_V1],
      }),
    ).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: 'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.',
    });
    expect(h.planner).not.toHaveBeenCalled();
  });
});
