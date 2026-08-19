import { createHash } from 'node:crypto';
import {
  isAllowedAgentNavigationRoute,
  type AgentAskPayload,
  type AgentContext,
  type AgentHistoryTurn,
  type AgentRun,
  type PreclassifiedAgentPlan,
  type Provider,
  type RealtimeCustomerContactSemanticContext,
  type RealtimeQuoteSemanticMissionContext,
  type RealtimeSemanticHostManifest,
  type RealtimeSemanticPlannerInput,
  type RealtimeSemanticPlannerResult,
} from '@bob/ai';
import {
  CUSTOMER_CONTACT_MISSION_KIND_V1,
  QUOTE_CREATION_MISSION_KIND_V1,
  isMissionKindId,
  type AppError,
  type ConfirmedTimeZone,
  type MissionKindId,
  type Result,
} from '@bob/core';
import { requestContext } from '../../observability/logger';
import type { Persistence } from '../../persistence/persistence';
import type {
  OpenAiNativeSpeechPurpose,
  OpenAiNativeSpeechSource,
} from './openai-native-speech-risk';
import { prepareRealtimeContext } from './realtime-context';
import type {
  RealtimeJarvisMissionOrchestrationInput,
  RealtimeJarvisMissionOrchestratorPort,
  RealtimeJarvisMissionPreparedTurn,
} from './realtime-jarvis-mission-orchestrator';
import type {
  RealtimeQuoteMissionAuthority,
  RealtimeQuoteMissionOrchestrationInput,
  RealtimeQuoteMissionOrchestratorPort,
  RealtimeQuoteMissionPreparedTurn,
} from './realtime-quote-mission-orchestrator';
import type { RealtimeVoiceTraceRecorder } from './realtime-voice-trace';

const MAX_CANONICAL_SPEECH_CHARS = 2_400;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MISSION_OWNERSHIP_REFUSAL =
  'Je garde la création du devis dans la mission sécurisée. Rien n’a été exécuté. Reformule uniquement l’étape du devis.';
const SEMANTIC_PLANNER_FAILURE =
  'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.';
const MAX_REALTIME_PLANNER_HISTORY_TURNS = 6;

export interface RealtimeAgentTurnInput {
  /** Clé stable dérivée de la session et de l'item provider avant tout appel LLM ou métier. */
  readonly turnId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly transcript: string;
  readonly history: readonly AgentHistoryTurn[];
  readonly context?: AgentContext;
  /** Autorité signée et figée au bootstrap ; absente sur les transports N-1 non certifiés. */
  readonly confirmedTimeZone?: ConfirmedTimeZone;
  /** Autorité serveur dérivée de la lease admise ; jamais fournie par le modèle ou le client. */
  readonly agentMissionAuthority?: RealtimeQuoteMissionAuthority;
  /**
   * Kinds admis PAR L'ADMISSION DE SESSION (flag par kind), threadés par le service — jamais
   * codés en dur ici : un kind absent de cette liste n'a ni lentille, ni outil, ni exécution.
   */
  readonly admittedMissionKinds?: readonly MissionKindId[];
  /** Fence durable lu au début du tour, puis relu juste avant toute publication. */
  readonly contextFence: RealtimeAgentContextFence;
  /** Observateur staging non autoritaire ; ses pannes ne modifient jamais le résultat du tour. */
  readonly trace?: RealtimeVoiceTraceRecorder;
  readonly signal: AbortSignal;
}

export interface RealtimeAgentContextVersion {
  readonly version: 1 | null;
  readonly revision: number | null;
  readonly digest: string;
}

export interface RealtimeAgentContextFence {
  readonly expected: RealtimeAgentContextVersion;
  /** Lève si la lecture durable est indisponible ; l'adaptateur échoue alors fermé. */
  revalidate(signal: AbortSignal): Promise<RealtimeAgentContextVersion>;
}

export interface RealtimeAgentTurnReady {
  readonly status: 'ready';
  readonly turnId: string;
  readonly canonicalSpeech: string;
  readonly kind: AgentRun['kind'];
  /** Provenance déterministe utilisée par le routeur acoustique ; jamais fournie par le LLM. */
  readonly speechPurpose: OpenAiNativeSpeechPurpose;
  readonly speechSource: OpenAiNativeSpeechSource;
  readonly hasTenantContext: boolean;
  readonly contextVersion: RealtimeAgentContextVersion;
  readonly navigate?: string;
  readonly proposalId?: string;
  readonly proposalExpiresAt?: string;
}

export type RealtimeAgentTurnOutcome =
  | RealtimeAgentTurnReady
  | { readonly status: 'aborted' }
  | { readonly status: 'failed'; readonly canonicalSpeech: string };

export interface RealtimeAgentTurnPort {
  run(input: RealtimeAgentTurnInput): Promise<RealtimeAgentTurnOutcome>;
}

export type RealtimeAgentProvider = Extract<Provider, 'openai' | 'mistral'>;

export interface RealtimeBobAgentExecutor {
  prepareRealtimeSemanticHost(input: {
    readonly context?: AgentContext;
    readonly admittedMissionKinds: readonly MissionKindId[];
  }): Promise<Result<RealtimeSemanticHostManifest, AppError>>;

  askBobWithPlan(
    input: AgentAskPayload,
    plan: PreclassifiedAgentPlan,
    execution: {
      readonly signal: AbortSignal;
      readonly requiredProvider: RealtimeAgentProvider;
      readonly admittedMissionKinds?: readonly MissionKindId[];
      readonly plannerDurationMs: number;
    },
  ): Promise<Result<AgentRun, AppError>>;
}

export interface RealtimeSemanticPlannerPort {
  plan(input: RealtimeSemanticPlannerInput): Promise<RealtimeSemanticPlannerResult>;
}

function traceSemanticPlan(
  trace: RealtimeVoiceTraceRecorder | undefined,
  turnId: string,
  planning: RealtimeSemanticPlannerResult,
): void {
  if (trace === undefined) return;
  const common = {
    eventKind: 'turn_semantic_plan' as const,
    turnId,
    stage: 'planner' as const,
    durationMs: planning.plannerDurationMs,
  };
  if (planning.status === 'mission_frame') {
    trace.record({
      ...common,
      outcome: 'ready',
      plannerDisposition: 'mission_frame',
      plannerAuthority: 'mission',
      plannerModel: planning.frame.model,
      // Le kind tracé est celui RÉELLEMENT planifié ; absent = writer N-1 (devis).
      missionKind: planning.missionKind ?? QUOTE_CREATION_MISSION_KIND_V1,
    });
    return;
  }
  if (planning.status === 'rejected') {
    trace.record({
      ...common,
      outcome: 'rejected',
      failureClass: 'planner_rejected',
      plannerDisposition: 'rejected',
      plannerAuthority: 'none',
    });
    return;
  }
  if (planning.status === 'out_of_scope') {
    trace.record({
      ...common,
      outcome: 'ready',
      plannerDisposition: 'out_of_scope',
      plannerAuthority: 'none',
      plannerModel: planning.plan.model,
    });
    return;
  }
  const stepCount = planning.plan.steps.length;
  planning.plan.steps.forEach((step, plannerStepIndex) => {
    trace.record({
      ...common,
      outcome: 'ready',
      plannerDisposition: 'global_plan',
      plannerAuthority: 'global',
      plannerModel: planning.plan.model,
      plannerStepIndex,
      plannerStepCount: stepCount,
      plannerIntent: step.intent,
    });
  });
}

interface ContextSnapshotLike {
  readonly version: 1;
  readonly revision: number;
  readonly context: AgentContext;
}

/** Empreinte non réversible d'un snapshot ; aucune donnée écran n'est journalisée. */
export function realtimeAgentContextVersion(
  snapshot: ContextSnapshotLike | null,
): RealtimeAgentContextVersion {
  if (snapshot !== null) {
    const prepared = prepareRealtimeContext(snapshot);
    if (prepared === null) {
      throw new Error('Realtime agent context snapshot is not canonical.');
    }
    return {
      version: snapshot.version,
      revision: snapshot.revision,
      // Autorité unique : ce digest est aussi celui persisté, appliqué par le sideband et
      // présenté aux ACK. Version et révision restent des fences séparées.
      digest: prepared.digest,
    };
  }
  return {
    version: null,
    revision: null,
    digest: createHash('sha256')
      .update('bob-pro:realtime-context-turn:v1\u0000', 'utf8')
      .update('null', 'utf8')
      .digest('hex'),
  };
}

function sameContextVersion(
  left: RealtimeAgentContextVersion,
  right: RealtimeAgentContextVersion,
): boolean {
  return (
    left.version === right.version &&
    left.revision === right.revision &&
    left.digest === right.digest
  );
}

const CONTEXT_UNAVAILABLE_SPEECH =
  'Je ne peux pas vérifier le contexte de cet écran. Rien n’a été exécuté.';

interface SelectedCanonicalSpeech {
  readonly text: string;
  readonly source: OpenAiNativeSpeechSource;
}

function canonicalSpeech(run: AgentRun): SelectedCanonicalSpeech {
  const selected =
    run.spokenPrompt !== undefined
      ? { value: run.spokenPrompt, source: 'spoken_prompt' as const }
      : run.naturalBody !== undefined
        ? { value: run.naturalBody, source: 'natural_body' as const }
        : run.card.body !== undefined
          ? { value: run.card.body, source: 'card_body' as const }
          : { value: run.card.title, source: 'card_title' as const };
  return {
    text: selected.value
      // Les contrôles n'ont aucune valeur vocale et pourraient modifier la trame sideband.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CANONICAL_SPEECH_CHARS),
    source: selected.source,
  };
}

function safeFailureSpeech(error: AppError): string {
  if (
    error.kind === 'conflict' &&
    error.entity === 'agent_intent_ownership' &&
    error.reason === 'mission_owned'
  ) {
    return MISSION_OWNERSHIP_REFUSAL;
  }
  if (error.kind === 'validation') {
    return 'Je n’ai pas bien compris. Reformule ta demande en une phrase courte.';
  }
  if (error.kind === 'forbidden') {
    return 'Je ne peux pas traiter cette demande dans cet espace. Tu peux continuer manuellement dans l’application.';
  }
  return 'Je rencontre un souci temporaire. Rien n’a été exécuté.';
}

export function classifyRealtimeAgentSpeechPurpose(
  run: AgentRun,
  hasScreenContext: boolean,
): OpenAiNativeSpeechPurpose {
  if (run.kind === 'proposed' || run.pending !== undefined) return 'action_proposal';
  if (run.kind === 'done') return 'action_result';
  if (run.navigate !== undefined) return 'navigation';
  if ((run.ask?.length ?? 0) > 0 || (run.choices?.length ?? 0) > 0) {
    return 'structured_choice';
  }
  // Seuls les gabarits d'aide générique, sans contexte tenant et sans naturalisation LLM,
  // peuvent demander le chemin conversationnel. Tout autre answer est un fait métier potentiel.
  if (
    !hasScreenContext &&
    run.naturalBody === undefined &&
    (run.intent === 'aide' || run.intent === 'unknown')
  )
    return 'generic_assistance';
  return 'business_answer';
}

/**
 * Adaptateur monobrain : le moteur métier HTTP reste l'unique autorité sémantique. Le modèle
 * Realtime ne reçoit ensuite qu'un texte canonique à prononcer, sans outil ni décision métier.
 */
export class RealtimeBobAgentTurnAdapter implements RealtimeAgentTurnPort {
  constructor(
    private readonly persistence: Persistence,
    private readonly requiredProvider: RealtimeAgentProvider,
    private readonly resolveExecutor: () => RealtimeBobAgentExecutor,
    private readonly quoteMissions: RealtimeQuoteMissionOrchestratorPort | null = null,
    private readonly semanticPlanner: RealtimeSemanticPlannerPort | null = null,
    private readonly now: () => Date = () => new Date(),
    /** Vertical fiche client (U1-d) : présent dès le boot, délégué nul tant qu'il n'est pas câblé. */
    private readonly customerContactMissions: RealtimeJarvisMissionOrchestratorPort | null = null,
  ) {}

  async run(input: RealtimeAgentTurnInput): Promise<RealtimeAgentTurnOutcome> {
    if (input.signal.aborted) return { status: 'aborted' };
    if (!UUID_V4.test(input.turnId)) {
      return {
        status: 'failed',
        canonicalSpeech: 'Je ne peux pas sécuriser ce tour. Rien n’a été exécuté.',
      };
    }
    const inputContextVersion = realtimeAgentContextVersion(
      input.contextFence.expected.revision === null || input.context === undefined
        ? null
        : {
            version: 1,
            revision: input.contextFence.expected.revision,
            context: input.context,
          },
    );
    if (!sameContextVersion(inputContextVersion, input.contextFence.expected)) {
      return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
    }

    let missionRequest: RealtimeQuoteMissionOrchestrationInput | null = null;
    let preparedMission: RealtimeQuoteMissionPreparedTurn | null = null;
    let semanticMission: RealtimeQuoteSemanticMissionContext = {
      missionAlias: null,
      missionRevision: 0,
      confirmedLineCount: 0,
      pendingLineCount: 0,
      pendingDecisionKind: null,
      protocolVersion: null,
      phase: 'unavailable',
      presentedChoices: [],
    };
    // Kinds admis : dérivés de l'ENTRÉE (admission de session), jamais d'une liste écrite ici.
    // Sans autorité de lease, aucun kind n'est admis — la voix reste sur le chemin global.
    const admittedMissionKinds =
      input.agentMissionAuthority === undefined
        ? (Object.freeze([]) as readonly MissionKindId[])
        : (Object.freeze([
            ...new Set((input.admittedMissionKinds ?? []).filter(isMissionKindId)),
          ]) as readonly MissionKindId[]);
    const executor = this.resolveExecutor();
    let preparedCustomerContact: RealtimeJarvisMissionPreparedTurn | null = null;
    let customerContactRequest: RealtimeJarvisMissionOrchestrationInput | null = null;
    let customerContactContext: RealtimeCustomerContactSemanticContext | undefined;

    if (
      input.agentMissionAuthority !== undefined &&
      admittedMissionKinds.includes(QUOTE_CREATION_MISSION_KIND_V1)
    ) {
      const authority = input.agentMissionAuthority;
      const quoteMissions = this.quoteMissions;
      const contextRevision = input.contextFence.expected.revision;
      if (
        quoteMissions === null ||
        input.contextFence.expected.version !== 1 ||
        contextRevision === null
      ) {
        return {
          status: 'failed',
          canonicalSpeech: 'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.',
        };
      }
      let beforeMission: RealtimeAgentContextVersion;
      try {
        beforeMission = await input.contextFence.revalidate(input.signal);
      } catch {
        if (input.signal.aborted) return { status: 'aborted' };
        return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
      }
      if (input.signal.aborted) return { status: 'aborted' };
      if (!sameContextVersion(beforeMission, input.contextFence.expected)) {
        return { status: 'aborted' };
      }

      missionRequest = {
        authority,
        turnId: input.turnId,
        transcript: input.transcript,
        history: input.history,
        contextRevision,
        contextDigest: input.contextFence.expected.digest,
        signal: input.signal,
      };
      let preparation: Awaited<ReturnType<RealtimeQuoteMissionOrchestratorPort['prepare']>>;
      try {
        preparation = await requestContext.run(
          {
            correlationId: `bob-live-turn-${input.turnId}`,
            principal: { userId: input.userId, companyId: input.companyId },
          },
          () => quoteMissions.prepare(missionRequest!),
        );
      } catch {
        if (input.signal.aborted) return { status: 'aborted' };
        return {
          status: 'failed',
          canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.',
        };
      }
      if (input.signal.aborted) return { status: 'aborted' };
      if (preparation.status === 'failed') return preparation;
      preparedMission = preparation.prepared;
      semanticMission = preparation.prepared.semanticContext;
    }

    if (
      input.agentMissionAuthority !== undefined &&
      admittedMissionKinds.includes(CUSTOMER_CONTACT_MISSION_KIND_V1)
    ) {
      const contextRevision = input.contextFence.expected.revision;
      const customerContactMissions = this.customerContactMissions;
      if (
        customerContactMissions === null ||
        input.contextFence.expected.version !== 1 ||
        contextRevision === null
      ) {
        return {
          status: 'failed',
          canonicalSpeech: 'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.',
        };
      }
      // Même discipline que le devis : l'écran est relu AVANT toute préparation de mission.
      const beforeContact = await this.revalidateContext(input);
      if (beforeContact === 'aborted') return { status: 'aborted' };
      if (beforeContact === 'failed') {
        return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
      }
      customerContactRequest = {
        authority: input.agentMissionAuthority,
        turnId: input.turnId,
        transcript: input.transcript,
        history: input.history,
        contextRevision,
        contextDigest: input.contextFence.expected.digest,
        signal: input.signal,
      };
      let contactPreparation: Awaited<ReturnType<RealtimeJarvisMissionOrchestratorPort['prepare']>>;
      try {
        contactPreparation = await requestContext.run(
          {
            correlationId: `bob-live-turn-${input.turnId}`,
            principal: { userId: input.userId, companyId: input.companyId },
          },
          () => customerContactMissions.prepare(customerContactRequest!),
        );
      } catch {
        if (input.signal.aborted) return { status: 'aborted' };
        return {
          status: 'failed',
          canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.',
        };
      }
      if (input.signal.aborted) return { status: 'aborted' };
      if (contactPreparation.status === 'failed') {
        // ADDITIVITE (SPEC_U1D §3, revue C3-P0) : une panne du vertical fiche client
        // DEGRADE la lentille, elle ne tue jamais le tour — le devis et le chemin global
        // restent servis exactement comme avant l'existence de ce vertical.
        input.trace?.record({
          eventKind: 'provider_failed',
          turnId: input.turnId,
          stage: 'planner',
          outcome: 'unavailable',
          failureClass: 'unknown',
        });
      } else {
        preparedCustomerContact = contactPreparation.prepared;
        customerContactContext = contactPreparation.prepared.semanticContext;
      }
    }

    if (this.semanticPlanner === null) {
      input.trace?.record({
        eventKind: 'provider_failed',
        turnId: input.turnId,
        stage: 'planner',
        outcome: 'unavailable',
        failureClass: 'planner_unavailable',
      });
      return {
        status: 'failed',
        canonicalSpeech: 'Je ne peux pas joindre le planificateur sécurisé. Rien n’a été exécuté.',
      };
    }

    let hostManifest: RealtimeSemanticHostManifest;
    try {
      const preparedHost = await requestContext.run(
        {
          correlationId: `bob-live-turn-${input.turnId}`,
          principal: {
            userId: input.userId,
            companyId: input.companyId,
            ...(input.confirmedTimeZone === undefined
              ? {}
              : { confirmedTimeZone: input.confirmedTimeZone }),
          },
        },
        () =>
          this.persistence.runWithTenant(input.companyId, () =>
            executor.prepareRealtimeSemanticHost({
              ...(input.context === undefined ? {} : { context: input.context }),
              admittedMissionKinds,
            }),
          ),
      );
      if (!preparedHost.ok) {
        input.trace?.record({
          eventKind: 'provider_failed',
          turnId: input.turnId,
          stage: 'planner',
          outcome: 'unavailable',
          failureClass: 'planner_unavailable',
        });
        return {
          status: 'failed',
          canonicalSpeech: 'Je ne peux pas vérifier mes capacités. Rien n’a été exécuté.',
        };
      }
      hostManifest = preparedHost.value;
    } catch {
      if (input.signal.aborted) return { status: 'aborted' };
      input.trace?.record({
        eventKind: 'provider_failed',
        turnId: input.turnId,
        stage: 'planner',
        outcome: 'unavailable',
        failureClass: 'planner_unavailable',
      });
      return {
        status: 'failed',
        canonicalSpeech: 'Je ne peux pas vérifier mes capacités. Rien n’a été exécuté.',
      };
    }
    if (input.signal.aborted) return { status: 'aborted' };

    let planning: RealtimeSemanticPlannerResult;
    try {
      planning = await requestContext.run(
        {
          correlationId: `bob-live-turn-${input.turnId}`,
          principal: {
            userId: input.userId,
            companyId: input.companyId,
            ...(input.confirmedTimeZone === undefined
              ? {}
              : { confirmedTimeZone: input.confirmedTimeZone }),
          },
        },
        () =>
          this.semanticPlanner!.plan({
            transcript: input.transcript,
            history: input.history.slice(-MAX_REALTIME_PLANNER_HISTORY_TURNS),
            ...(input.context === undefined ? {} : { context: input.context }),
            screen:
              input.context === undefined || input.contextFence.expected.revision === null
                ? null
                : {
                    route: input.context.screen.name,
                    revision: input.contextFence.expected.revision,
                    digest: input.contextFence.expected.digest,
                  },
            quoteMission: semanticMission,
            ...(admittedMissionKinds.length === 0 ? {} : { admittedMissionKinds }),
            ...(customerContactContext === undefined
              ? {}
              : { customerContactMission: customerContactContext }),
            hostManifest,
            missionCapabilities: Object.freeze([
              ...(preparedMission?.availableCapabilities ?? []),
              ...(preparedCustomerContact?.availableCapabilities ?? []),
            ]),
            locale: 'fr-FR',
            // Préférence conversationnelle explicitement confirmée et figée au bootstrap. Un
            // transport N-1 sans claim reste null : jamais de repli sur le fuseau légal Paris.
            timeZone: input.confirmedTimeZone?.timeZone ?? null,
            now: this.now().toISOString(),
            signal: input.signal,
          }),
      );
    } catch {
      if (input.signal.aborted) return { status: 'aborted' };
      input.trace?.record({
        eventKind: 'provider_failed',
        turnId: input.turnId,
        stage: 'planner',
        outcome: 'unavailable',
        failureClass: 'planner_unavailable',
      });
      return {
        status: 'failed',
        canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.',
      };
    }
    if (input.signal.aborted) return { status: 'aborted' };
    traceSemanticPlan(input.trace, input.turnId, planning);
    if (planning.status === 'rejected') {
      return { status: 'failed', canonicalSpeech: SEMANTIC_PLANNER_FAILURE };
    }

    if (
      planning.status === 'mission_frame' &&
      planning.missionKind === CUSTOMER_CONTACT_MISSION_KIND_V1
    ) {
      const customerContactMissions = this.customerContactMissions;
      if (
        customerContactRequest === null ||
        preparedCustomerContact === null ||
        customerContactMissions === null ||
        !admittedMissionKinds.includes(CUSTOMER_CONTACT_MISSION_KIND_V1)
      ) {
        return {
          status: 'failed',
          canonicalSpeech: 'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.',
        };
      }
      const contextBeforeContact = await this.revalidateContext(input);
      if (contextBeforeContact === 'aborted') return { status: 'aborted' };
      if (contextBeforeContact === 'failed') {
        return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
      }
      let contactOutcome: Awaited<ReturnType<RealtimeJarvisMissionOrchestratorPort['runPlanned']>>;
      try {
        contactOutcome = await requestContext.run(
          {
            correlationId: `bob-live-turn-${input.turnId}`,
            principal: { userId: input.userId, companyId: input.companyId },
          },
          () =>
            customerContactMissions.runPlanned({
              request: customerContactRequest!,
              prepared: preparedCustomerContact!,
              frame: planning.frame,
            }),
        );
      } catch {
        if (input.signal.aborted) return { status: 'aborted' };
        return {
          status: 'failed',
          canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.',
        };
      }
      if (input.signal.aborted) return { status: 'aborted' };
      if (contactOutcome.status === 'failed') return contactOutcome;
      const contextAfterContact = await this.revalidateContext(input);
      if (contextAfterContact === 'aborted') return { status: 'aborted' };
      if (contextAfterContact === 'failed') {
        return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
      }
      return {
        status: 'ready',
        turnId: input.turnId,
        canonicalSpeech: contactOutcome.canonicalSpeech,
        kind: 'answer',
        speechPurpose: contactOutcome.speechPurpose,
        speechSource: 'card_body',
        hasTenantContext: true,
        contextVersion: input.contextFence.expected,
      };
    }

    if (planning.status === 'mission_frame') {
      if (
        missionRequest === null ||
        preparedMission === null ||
        this.quoteMissions === null ||
        !admittedMissionKinds.includes(QUOTE_CREATION_MISSION_KIND_V1)
      ) {
        return {
          status: 'failed',
          canonicalSpeech: 'Je ne peux pas sécuriser la mission. Rien n’a été exécuté.',
        };
      }
      const currentContextBeforeMission = await this.revalidateContext(input);
      if (currentContextBeforeMission === 'aborted') return { status: 'aborted' };
      if (currentContextBeforeMission === 'failed') {
        return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
      }
      let missionOutcome: Awaited<ReturnType<RealtimeQuoteMissionOrchestratorPort['runPlanned']>>;
      try {
        missionOutcome = await requestContext.run(
          {
            correlationId: `bob-live-turn-${input.turnId}`,
            principal: { userId: input.userId, companyId: input.companyId },
          },
          () =>
            this.quoteMissions!.runPlanned({
              request: missionRequest!,
              prepared: preparedMission!,
              frame: planning.frame,
            }),
        );
      } catch {
        if (input.signal.aborted) return { status: 'aborted' };
        return {
          status: 'failed',
          canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.',
        };
      }
      if (input.signal.aborted) return { status: 'aborted' };
      if (missionOutcome.status === 'failed') return missionOutcome;
      const currentContext = await this.revalidateContext(input);
      if (currentContext === 'aborted') return { status: 'aborted' };
      if (currentContext === 'failed') {
        return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
      }
      if (missionOutcome.status === 'handled') {
        return {
          status: 'ready',
          turnId: input.turnId,
          canonicalSpeech: missionOutcome.canonicalSpeech,
          kind: 'answer',
          speechPurpose: missionOutcome.speechPurpose,
          speechSource: 'card_body',
          hasTenantContext: true,
          contextVersion: input.contextFence.expected,
        };
      }
      return {
        status: 'ready',
        turnId: input.turnId,
        canonicalSpeech: missionOutcome.canonicalSpeech,
        kind: 'answer',
        speechPurpose: 'navigation',
        speechSource: 'card_body',
        hasTenantContext: true,
        contextVersion: input.contextFence.expected,
        navigate: missionOutcome.navigate,
      };
    }

    const payload: AgentAskPayload = {
      message: input.transcript,
      // Bob Live ne peut jamais muter sans une proposition opaque et une confirmation dédiée.
      autonomy: 'confirm_all',
      tone: 'pote',
      history: input.history,
      ...(input.context === undefined ? {} : { context: input.context }),
    };

    const currentContextBeforeGlobal = await this.revalidateContext(input);
    if (currentContextBeforeGlobal === 'aborted') return { status: 'aborted' };
    if (currentContextBeforeGlobal === 'failed') {
      return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
    }

    let result: Result<AgentRun, AppError>;
    try {
      result = await requestContext.run(
        {
          correlationId: `bob-live-turn-${input.turnId}`,
          principal: {
            userId: input.userId,
            companyId: input.companyId,
            ...(input.confirmedTimeZone === undefined
              ? {}
              : { confirmedTimeZone: input.confirmedTimeZone }),
          },
        },
        () =>
          this.persistence.runWithTenant(input.companyId, () =>
            executor.askBobWithPlan(payload, planning.plan, {
              signal: input.signal,
              requiredProvider: this.requiredProvider,
              plannerDurationMs: planning.plannerDurationMs,
              ...(admittedMissionKinds.length === 0 ? {} : { admittedMissionKinds }),
            }),
          ),
      );
    } catch {
      if (input.signal.aborted) return { status: 'aborted' };
      return {
        status: 'failed',
        canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.',
      };
    }
    if (input.signal.aborted) return { status: 'aborted' };
    const currentContext = await this.revalidateContext(input);
    if (currentContext === 'aborted') return { status: 'aborted' };
    if (currentContext === 'failed') {
      return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
    }
    if (!result.ok) return { status: 'failed', canonicalSpeech: safeFailureSpeech(result.error) };

    const speech = canonicalSpeech(result.value);
    if (!speech.text) {
      return {
        status: 'failed',
        canonicalSpeech: 'Je n’ai pas de réponse fiable à te donner pour le moment.',
      };
    }
    const pending = result.value.pending;
    const navigate = isAllowedAgentNavigationRoute(result.value.navigate)
      ? result.value.navigate
      : undefined;
    if (input.agentMissionAuthority !== undefined && navigate === '/devis/new') {
      return {
        status: 'failed',
        canonicalSpeech:
          'Je ne peux pas ouvrir un devis sans mission vérifiée. Rien n’a été exécuté.',
      };
    }
    return {
      status: 'ready',
      turnId: input.turnId,
      canonicalSpeech: speech.text,
      kind: result.value.kind,
      speechPurpose: classifyRealtimeAgentSpeechPurpose(result.value, input.context !== undefined),
      speechSource: speech.source,
      hasTenantContext: input.context !== undefined,
      contextVersion: input.contextFence.expected,
      ...(navigate === undefined ? {} : { navigate }),
      ...(typeof pending?.proposalId === 'string' ? { proposalId: pending.proposalId } : {}),
      ...(typeof pending?.expiresAt === 'string' ? { proposalExpiresAt: pending.expiresAt } : {}),
    };
  }

  private async revalidateContext(
    input: RealtimeAgentTurnInput,
  ): Promise<'current' | 'aborted' | 'failed'> {
    let current: RealtimeAgentContextVersion;
    try {
      current = await input.contextFence.revalidate(input.signal);
    } catch {
      return input.signal.aborted ? 'aborted' : 'failed';
    }
    if (input.signal.aborted) return 'aborted';
    // Un changement d'écran/révision invalide silencieusement tout texte, navigation ou proposition.
    return sameContextVersion(current, input.contextFence.expected) ? 'current' : 'aborted';
  }
}
