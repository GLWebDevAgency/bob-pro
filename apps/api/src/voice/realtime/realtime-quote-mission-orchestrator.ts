import {
  understandQuoteCreationTurn,
  type AgentHistoryTurn,
  type LlmPort,
  type QuoteCreationUnderstandingPhase,
} from '@bob/ai';
import type {
  AgentMissionOwner,
  AgentMissionRealtimeAuthorityProof,
  AgentMissionViewV1,
  AppError,
  Result,
  StartQuoteAgentMissionOutput,
} from '@bob/core';
import type {
  AgentMissionServiceAuthorization,
} from '../../agent-missions/agent-mission.service';

export interface RealtimeQuoteMissionAuthority {
  readonly owner: AgentMissionOwner;
  readonly proof: AgentMissionRealtimeAuthorityProof;
  readonly realtimeSessionId: string;
}

export interface RealtimeQuoteMissionGateway {
  getCurrent(
    authorization: AgentMissionServiceAuthorization,
  ): Promise<Result<{ readonly mission: AgentMissionViewV1 | null }, AppError>>;
  startFromVoiceTurn(input: {
    readonly authorization: AgentMissionServiceAuthorization;
    readonly realtimeSessionId: string;
    readonly turnId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly customerReference: string | null;
  }): Promise<Result<StartQuoteAgentMissionOutput, AppError>>;
}

export interface RealtimeQuoteMissionOrchestrationInput {
  readonly authority: RealtimeQuoteMissionAuthority;
  readonly turnId: string;
  readonly transcript: string;
  readonly history: readonly AgentHistoryTurn[];
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly signal: AbortSignal;
}

export type RealtimeQuoteMissionOrchestrationOutcome =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'failed'; readonly canonicalSpeech: string }
  | {
      readonly status: 'ready';
      readonly canonicalSpeech: string;
      readonly navigate: '/devis/new';
    };

export interface RealtimeQuoteMissionOrchestratorPort {
  run(
    input: RealtimeQuoteMissionOrchestrationInput,
  ): Promise<RealtimeQuoteMissionOrchestrationOutcome>;
}

const TEMPORARY_FAILURE =
  'Je rencontre un souci temporaire avec la mission. Rien n’a été exécuté.';
const UNSAFE_UNDERSTANDING =
  'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.';

function understandingState(mission: AgentMissionViewV1 | null): {
  readonly phase: QuoteCreationUnderstandingPhase;
  readonly presentedCustomerCount: number;
} | 'mission_locked' {
  if (mission === null) {
    return { phase: 'inactive', presentedCustomerCount: 0 };
  }
  if (mission.status !== 'active') return 'mission_locked';
  if (mission.phase === 'awaiting_customer') {
    return { phase: 'awaiting_customer', presentedCustomerCount: 0 };
  }
  if (
    mission.phase === 'awaiting_customer_choice'
    && mission.payload.decision?.kind === 'customer'
    && mission.payload.decision.candidates.length >= 1
    && mission.payload.decision.candidates.length <= 5
  ) {
    return {
      phase: 'awaiting_customer_choice',
      presentedCustomerCount: mission.payload.decision.candidates.length,
    };
  }
  return 'mission_locked';
}

function canonicalStartSpeech(mission: AgentMissionViewV1): string {
  if (mission.phase === 'awaiting_draft_decision') {
    return 'J’ai retrouvé un brouillon en cours. Je l’ouvre pour que tu choisisses de le reprendre ou de recommencer.';
  }
  const staged = mission.payload.stagedCustomerResolution;
  if (staged?.kind === 'exact') {
    return 'J’ai trouvé le client dans tes données. J’ouvre le devis et je poursuis dès que l’écran est prêt.';
  }
  if (staged?.kind === 'choices') {
    return 'J’ai trouvé plusieurs clients possibles. J’ouvre le devis pour te présenter les choix.';
  }
  if (staged?.kind === 'too_many') {
    return 'J’ai besoin d’un nom de client plus précis. J’ouvre le devis pour que tu puisses le compléter.';
  }
  return 'Je prépare le devis. Choisis le client, ou dis-moi son nom.';
}

/**
 * Frontière probabiliste → déterministe de M1-C.
 *
 * Le LLM ne reçoit aucune autorité et ne produit qu'une frame typée. Le gateway recharge la
 * mission et exécute le use case avec la preuve issue de la lease. Toute sortie ambiguë échoue
 * fermée afin de ne jamais retomber sur l'ancien hint de navigation sans mission.
 */
export class RealtimeQuoteMissionOrchestrator
implements RealtimeQuoteMissionOrchestratorPort {
  constructor(
    private readonly llm: LlmPort,
    private readonly missions: RealtimeQuoteMissionGateway,
  ) {}

  async run(
    input: RealtimeQuoteMissionOrchestrationInput,
  ): Promise<RealtimeQuoteMissionOrchestrationOutcome> {
    input.signal.throwIfAborted();
    const authorization: AgentMissionServiceAuthorization = {
      owner: input.authority.owner,
      proof: input.authority.proof,
    };
    let current: Awaited<ReturnType<RealtimeQuoteMissionGateway['getCurrent']>>;
    try {
      current = await this.missions.getCurrent(authorization);
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    if (!current.ok) {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    const state = understandingState(current.value.mission);
    if (state === 'mission_locked') {
      return {
        status: 'failed',
        canonicalSpeech:
          'La mission est déjà en cours. J’attends que l’étape affichée soit confirmée avant de poursuivre.',
      };
    }

    let understood: Awaited<ReturnType<typeof understandQuoteCreationTurn>>;
    try {
      understood = await understandQuoteCreationTurn(this.llm, {
        transcript: input.transcript,
        phase: state.phase,
        presentedCustomerCount: state.presentedCustomerCount,
        history: input.history,
        signal: input.signal,
      });
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    if (understood.status === 'rejected') {
      return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
    }

    const operation = understood.frame.operation;
    if (operation.kind === 'unrelated') return { status: 'not_applicable' };
    if (
      operation.kind === 'set_customer_reference'
      || operation.kind === 'select_presented_customer'
    ) {
      return {
        status: 'failed',
        canonicalSpeech:
          'La mission est bien ouverte, mais je ne peux pas encore appliquer ce choix vocal de façon sûre. Continue sur l’écran.',
      };
    }

    let started: Awaited<ReturnType<RealtimeQuoteMissionGateway['startFromVoiceTurn']>>;
    try {
      started = await this.missions.startFromVoiceTurn({
        authorization,
        realtimeSessionId: input.authority.realtimeSessionId,
        turnId: input.turnId,
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        customerReference: operation.customerReference,
      });
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    if (!started.ok || started.value.mission.status !== 'active') {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    return {
      status: 'ready',
      canonicalSpeech: canonicalStartSpeech(started.value.mission),
      navigate: '/devis/new',
    };
  }
}
