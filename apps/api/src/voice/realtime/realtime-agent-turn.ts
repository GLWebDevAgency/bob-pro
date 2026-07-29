import { createHash } from 'node:crypto';
import {
  isAllowedAgentNavigationRoute,
  type AgentAskPayload,
  type AgentContext,
  type AgentHistoryTurn,
  type AgentRun,
  type Provider,
} from '@bob/ai';
import type { AppError, Result } from '@bob/core';
import { requestContext } from '../../observability/logger';
import type { Persistence } from '../../persistence/persistence';
import type {
  OpenAiNativeSpeechPurpose,
  OpenAiNativeSpeechSource,
} from './openai-native-speech-risk';
import { prepareRealtimeContext } from './realtime-context';
import type {
  RealtimeQuoteMissionAuthority,
  RealtimeQuoteMissionOrchestratorPort,
} from './realtime-quote-mission-orchestrator';

const MAX_CANONICAL_SPEECH_CHARS = 2_400;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface RealtimeAgentTurnInput {
  /** Clé stable dérivée de la session et de l'item provider avant tout appel LLM ou métier. */
  readonly turnId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly transcript: string;
  readonly history: readonly AgentHistoryTurn[];
  readonly context?: AgentContext;
  /** Autorité serveur dérivée de la lease admise ; jamais fournie par le modèle ou le client. */
  readonly agentMissionAuthority?: RealtimeQuoteMissionAuthority;
  /** Fence durable lu au début du tour, puis relu juste avant toute publication. */
  readonly contextFence: RealtimeAgentContextFence;
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
  askBob(
    input: AgentAskPayload,
    execution: {
      readonly signal: AbortSignal;
      readonly requiredProvider: RealtimeAgentProvider;
    },
  ): Promise<Result<AgentRun, AppError>>;
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
  return left.version === right.version
    && left.revision === right.revision
    && left.digest === right.digest;
}

const CONTEXT_UNAVAILABLE_SPEECH = 'Je ne peux pas vérifier le contexte de cet écran. Rien n’a été exécuté.';

interface SelectedCanonicalSpeech {
  readonly text: string;
  readonly source: OpenAiNativeSpeechSource;
}

function canonicalSpeech(run: AgentRun): SelectedCanonicalSpeech {
  const selected = run.spokenPrompt !== undefined
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
  if (error.kind === 'validation') {
    return "Je n’ai pas bien compris. Reformule ta demande en une phrase courte.";
  }
  if (error.kind === 'forbidden') {
    return "Je ne peux pas traiter cette demande dans cet espace. Tu peux continuer manuellement dans l’application.";
  }
  return "Je rencontre un souci temporaire. Rien n’a été exécuté.";
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
    !hasScreenContext
    && run.naturalBody === undefined
    && (run.intent === 'aide' || run.intent === 'unknown')
  ) return 'generic_assistance';
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

    if (input.agentMissionAuthority !== undefined) {
      const authority = input.agentMissionAuthority;
      const quoteMissions = this.quoteMissions;
      const contextRevision = input.contextFence.expected.revision;
      if (
        quoteMissions === null
        || input.contextFence.expected.version !== 1
        || contextRevision === null
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

      let missionOutcome: Awaited<ReturnType<RealtimeQuoteMissionOrchestratorPort['run']>>;
      try {
        missionOutcome = await requestContext.run(
          {
            correlationId: `bob-live-turn-${input.turnId}`,
            principal: { userId: input.userId, companyId: input.companyId },
          },
          () => quoteMissions.run({
            authority,
            turnId: input.turnId,
            transcript: input.transcript,
            history: input.history,
            contextRevision,
            contextDigest: input.contextFence.expected.digest,
            signal: input.signal,
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
      if (missionOutcome.status === 'ready') {
        let afterMission: RealtimeAgentContextVersion;
        try {
          afterMission = await input.contextFence.revalidate(input.signal);
        } catch {
          if (input.signal.aborted) return { status: 'aborted' };
          return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
        }
        if (input.signal.aborted) return { status: 'aborted' };
        if (!sameContextVersion(afterMission, input.contextFence.expected)) {
          return { status: 'aborted' };
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
    }

    const payload: AgentAskPayload = {
      message: input.transcript,
      // Bob Live ne peut jamais muter sans une proposition opaque et une confirmation dédiée.
      autonomy: 'confirm_all',
      tone: 'pote',
      history: input.history,
      ...(input.context === undefined ? {} : { context: input.context }),
    };

    let result: Result<AgentRun, AppError>;
    try {
      result = await requestContext.run(
        {
          correlationId: `bob-live-turn-${input.turnId}`,
          principal: { userId: input.userId, companyId: input.companyId },
        },
        () => this.persistence.runWithTenant(
          input.companyId,
          () => this.resolveExecutor().askBob(payload, {
            signal: input.signal,
            requiredProvider: this.requiredProvider,
          }),
        ),
      );
    } catch {
      if (input.signal.aborted) return { status: 'aborted' };
      return { status: 'failed', canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.' };
    }
    if (input.signal.aborted) return { status: 'aborted' };
    let currentContext: RealtimeAgentContextVersion;
    try {
      currentContext = await input.contextFence.revalidate(input.signal);
    } catch {
      if (input.signal.aborted) return { status: 'aborted' };
      return { status: 'failed', canonicalSpeech: CONTEXT_UNAVAILABLE_SPEECH };
    }
    if (input.signal.aborted) return { status: 'aborted' };
    // Un changement d'écran/révision invalide silencieusement tout texte, navigation ou proposition.
    if (!sameContextVersion(currentContext, input.contextFence.expected)) return { status: 'aborted' };
    if (!result.ok) return { status: 'failed', canonicalSpeech: safeFailureSpeech(result.error) };

    const speech = canonicalSpeech(result.value);
    if (!speech.text) {
      return { status: 'failed', canonicalSpeech: 'Je n’ai pas de réponse fiable à te donner pour le moment.' };
    }
    const pending = result.value.pending;
    const navigate = isAllowedAgentNavigationRoute(result.value.navigate)
      ? result.value.navigate
      : undefined;
    if (
      input.agentMissionAuthority !== undefined
      && navigate === '/devis/new'
    ) {
      return {
        status: 'failed',
        canonicalSpeech: 'Je ne peux pas ouvrir un devis sans mission vérifiée. Rien n’a été exécuté.',
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
}
