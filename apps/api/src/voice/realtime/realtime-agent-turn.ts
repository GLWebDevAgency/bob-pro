import { createHash, randomUUID } from 'node:crypto';
import {
  isAllowedAgentNavigationRoute,
  type AgentAskPayload,
  type AgentContext,
  type AgentHistoryTurn,
  type AgentRun,
} from '@bob/ai';
import type { AppError, Result } from '@bob/core';
import { requestContext } from '../../observability/logger';
import type { Persistence } from '../../persistence/persistence';

const MAX_CANONICAL_SPEECH_CHARS = 2_400;

export interface RealtimeAgentTurnInput {
  readonly userId: string;
  readonly companyId: string;
  readonly transcript: string;
  readonly history: readonly AgentHistoryTurn[];
  readonly context?: AgentContext;
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

export interface RealtimeBobAgentExecutor {
  askBob(
    input: AgentAskPayload,
    execution: { readonly signal: AbortSignal },
  ): Promise<Result<AgentRun, AppError>>;
}

interface ContextSnapshotLike {
  readonly version: 1;
  readonly revision: number;
  readonly context: AgentContext;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Empreinte non réversible d'un snapshot ; aucune donnée écran n'est journalisée. */
export function realtimeAgentContextVersion(
  snapshot: ContextSnapshotLike | null,
): RealtimeAgentContextVersion {
  return {
    version: snapshot?.version ?? null,
    revision: snapshot?.revision ?? null,
    digest: createHash('sha256')
      .update('bob-pro:realtime-context-turn:v1\u0000', 'utf8')
      .update(canonicalJson(snapshot), 'utf8')
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

function canonicalSpeech(run: AgentRun): string {
  const value = run.spokenPrompt ?? run.naturalBody ?? run.card.body ?? run.card.title;
  return value
    // Les contrôles n'ont aucune valeur vocale et pourraient modifier la trame sideband.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CANONICAL_SPEECH_CHARS);
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

/**
 * Adaptateur monobrain : le moteur métier HTTP reste l'unique autorité sémantique. Le modèle
 * Realtime ne reçoit ensuite qu'un texte canonique à prononcer, sans outil ni décision métier.
 */
export class RealtimeBobAgentTurnAdapter implements RealtimeAgentTurnPort {
  constructor(
    private readonly persistence: Persistence,
    private readonly resolveExecutor: () => RealtimeBobAgentExecutor,
  ) {}

  async run(input: RealtimeAgentTurnInput): Promise<RealtimeAgentTurnOutcome> {
    if (input.signal.aborted) return { status: 'aborted' };
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
          correlationId: `bob-live-turn-${randomUUID()}`,
          principal: { userId: input.userId, companyId: input.companyId },
        },
        () => this.persistence.runWithTenant(
          input.companyId,
          () => this.resolveExecutor().askBob(payload, { signal: input.signal }),
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
    if (!speech) {
      return { status: 'failed', canonicalSpeech: 'Je n’ai pas de réponse fiable à te donner pour le moment.' };
    }
    const pending = result.value.pending;
    return {
      status: 'ready',
      turnId: randomUUID(),
      canonicalSpeech: speech,
      kind: result.value.kind,
      contextVersion: input.contextFence.expected,
      ...(isAllowedAgentNavigationRoute(result.value.navigate)
        ? { navigate: result.value.navigate }
        : {}),
      ...(typeof pending?.proposalId === 'string' ? { proposalId: pending.proposalId } : {}),
      ...(typeof pending?.expiresAt === 'string' ? { proposalExpiresAt: pending.expiresAt } : {}),
    };
  }
}
