import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionSession,
} from '@bob/api-client';
import type { AgentContext } from '@bob/ai';
import type {
  AcknowledgeQuoteScreenOutput,
  AgentMissionViewV1,
  AppError,
} from '@bob/core';
import type { RealtimePublishedFence } from './realtime-driver';

const SHA_256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AgentMissionConfirmedContext {
  readonly realtimeSessionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly screen: {
    readonly name: string;
    readonly instanceId: string;
  };
}

export interface AgentMissionRuntimeSnapshot {
  readonly generation: number;
  readonly realtimeSessionId: string | null;
  readonly confirmedContext: AgentMissionConfirmedContext | null;
}

export interface AgentMissionRuntimeCapture {
  readonly generation: number;
  readonly session: RealtimeAgentMissionSession;
  readonly confirmedContext: AgentMissionConfirmedContext | null;
}

export interface AgentMissionRuntimeBridge {
  /**
   * Transfert move-only synchrone. `true` signifie que l'appelant doit immédiatement oublier
   * le handle et ne plus jamais le disposer.
   */
  readonly adopt: (session: RealtimeAgentMissionSession) => boolean;
  /** Retire le fence avant toute transition d'écran ; la capability reste possédée. */
  readonly invalidateContext: (realtimeSessionId: string) => void;
  /**
   * N'accepte que le fence confirmé par PUT serveur puis synchronisé avec le transport courant.
   */
  readonly confirmContext: (
    realtimeSessionId: string,
    fence: RealtimePublishedFence,
    context: AgentContext,
  ) => boolean;
}

export type AgentMissionRuntimeCall<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'failed'; readonly error: AppError }
  | {
      readonly status:
        | 'context_unconfirmed'
        | 'invalid_response'
        | 'stale'
        | 'unavailable';
    };

export interface AgentMissionQuoteScreenAckInput {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly draft: {
    readonly sessionId: string;
    readonly slotRevision: number;
    readonly contentRevision: number;
  };
  readonly expectedScreenInstanceId: string;
}

export interface AgentMissionRuntimeActions {
  readonly readCurrentQuoteCreation: (
    expectedScreenInstanceId: string,
  ) => Promise<
    AgentMissionRuntimeCall<{ readonly mission: AgentMissionViewV1 | null }>
  >;
  readonly acknowledgeQuoteScreen: (
    input: AgentMissionQuoteScreenAckInput,
  ) => Promise<AgentMissionRuntimeCall<AcknowledgeQuoteScreenOutput>>;
}

type Listener = (snapshot: AgentMissionRuntimeSnapshot) => void;

function canonicalFence(fence: RealtimePublishedFence): boolean {
  return UUID.test(fence.sessionHandle)
    && Number.isSafeInteger(fence.contextRevision)
    && fence.contextRevision >= 1
    && SHA_256.test(fence.contextDigest);
}

function canonicalScreen(context: AgentContext): boolean {
  return context.screen.name.trim() !== ''
    && context.screen.instanceId.trim() !== '';
}

/**
 * Acteur pur de propriété de capability.
 *
 * Il ne connaît ni React, ni route, ni stockage. Une adoption réussie transfère l'unique
 * responsabilité de destruction ; une génération rend toute continuation asynchrone antérieure
 * inerte. Le secret reste enfermé dans l'implémentation HTTP de la session.
 */
export class AgentMissionRuntimeOwner {
  private active = true;
  private destroyed = false;
  private generation = 0;
  private session: RealtimeAgentMissionSession | null = null;
  private confirmedContext: AgentMissionConfirmedContext | null = null;
  private readonly listeners = new Set<Listener>();

  snapshot(): AgentMissionRuntimeSnapshot {
    return Object.freeze({
      generation: this.generation,
      realtimeSessionId: this.session?.realtimeSessionId ?? null,
      confirmedContext: this.confirmedContext,
    });
  }

  capture(): AgentMissionRuntimeCapture | null {
    const session = this.session;
    if (!this.active || session === null || session.disposed) return null;
    return Object.freeze({
      generation: this.generation,
      session,
      confirmedContext: this.confirmedContext,
    });
  }

  isCurrent(capture: AgentMissionRuntimeCapture): boolean {
    return this.active
      && capture.generation === this.generation
      && capture.session === this.session
      && capture.confirmedContext === this.confirmedContext
      && !capture.session.disposed;
  }

  adopt(session: RealtimeAgentMissionSession): boolean {
    if (
      !this.active
      || this.destroyed
      || session.disposed
      || session.protocolVersion !== REALTIME_AGENT_MISSION_PROTOCOL_VERSION
      || !UUID.test(session.realtimeSessionId)
    ) {
      return false;
    }
    if (session === this.session) return true;

    const previous = this.session;
    this.generation += 1;
    this.session = session;
    this.confirmedContext = null;
    previous?.dispose();
    this.emit();
    return true;
  }

  invalidateContext(realtimeSessionId: string): void {
    if (
      !this.active
      || this.session?.realtimeSessionId !== realtimeSessionId
      || this.confirmedContext === null
    ) {
      return;
    }
    this.confirmedContext = null;
    this.emit();
  }

  confirmContext(
    realtimeSessionId: string,
    fence: RealtimePublishedFence,
    context: AgentContext,
  ): boolean {
    if (
      !this.active
      || this.destroyed
      || this.session === null
      || this.session.disposed
      || this.session.realtimeSessionId !== realtimeSessionId
      || fence.sessionHandle !== realtimeSessionId
      || !canonicalFence(fence)
      || !canonicalScreen(context)
    ) {
      return false;
    }
    const confirmed = this.confirmedContext;
    if (confirmed !== null) {
      if (fence.contextRevision < confirmed.revision) return false;
      if (fence.contextRevision === confirmed.revision) {
        return confirmed.digest === fence.contextDigest
          && confirmed.screen.name === context.screen.name
          && confirmed.screen.instanceId === context.screen.instanceId;
      }
    }
    this.confirmedContext = Object.freeze({
      realtimeSessionId,
      revision: fence.contextRevision,
      digest: fence.contextDigest,
      screen: Object.freeze({
        name: context.screen.name,
        instanceId: context.screen.instanceId,
      }),
    });
    this.emit();
    return true;
  }

  subscribe(listener: Listener): () => void {
    if (!this.active || this.destroyed) return () => undefined;
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Fence synchrone de frontière React. La capability reste enfermée le temps de distinguer un
   * cycle Strict Effects d'un vrai démontage, mais aucune capture ni opération ne peut passer.
   */
  deactivate(): void {
    if (this.destroyed || !this.active) return;
    this.active = false;
    this.generation += 1;
  }

  /**
   * Réactive uniquement un owner non détruit après le second setup Strict Effects. La génération
   * change à nouveau : toute continuation partie avant le faux démontage reste définitivement
   * périmée.
   */
  activate(): boolean {
    if (this.destroyed) return false;
    if (this.active) return true;
    this.active = true;
    this.generation += 1;
    this.emit();
    return true;
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.generation += 1;
    const session = this.session;
    this.session = null;
    this.confirmedContext = null;
    this.listeners.clear();
    session?.dispose();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function captureForQuoteScreen(
  owner: AgentMissionRuntimeOwner,
  expectedScreenInstanceId: string,
): AgentMissionRuntimeCapture | null | 'context_unconfirmed' {
  const capture = owner.capture();
  if (capture === null) return null;
  const context = capture.confirmedContext;
  if (
    context === null
    || context.screen.name !== '/devis/new'
    || context.screen.instanceId !== expectedScreenInstanceId
  ) {
    return 'context_unconfirmed';
  }
  return capture;
}

/**
 * Façade écran sans fuite de capability.
 *
 * Elle injecte elle-même l'identité Realtime et le fence confirmé, partage les appels identiques
 * en vol, puis invalide toute réponse reçue après navigation, reconnexion ou logout.
 */
export class FencedAgentMissionRuntimeActions implements AgentMissionRuntimeActions {
  private readonly flights = new Map<string, Promise<AgentMissionRuntimeCall<unknown>>>();

  constructor(private readonly owner: AgentMissionRuntimeOwner) {}

  readCurrentQuoteCreation(
    expectedScreenInstanceId: string,
  ): Promise<
    AgentMissionRuntimeCall<{ readonly mission: AgentMissionViewV1 | null }>
  > {
    const captured = captureForQuoteScreen(this.owner, expectedScreenInstanceId);
    if (captured === null) return Promise.resolve({ status: 'unavailable' });
    if (captured === 'context_unconfirmed') {
      return Promise.resolve({ status: 'context_unconfirmed' });
    }
    const context = captured.confirmedContext;
    if (context === null) return Promise.resolve({ status: 'context_unconfirmed' });
    const key = JSON.stringify([
      'read_quote_creation',
      captured.generation,
      captured.session.realtimeSessionId,
      context.revision,
      context.digest,
      expectedScreenInstanceId,
    ]);
    return this.singleFlight<{ readonly mission: AgentMissionViewV1 | null }>(
      key,
      async (): Promise<
        AgentMissionRuntimeCall<{ readonly mission: AgentMissionViewV1 | null }>
      > => {
      try {
        const result = await captured.session.getCurrentQuoteCreation();
        if (!this.owner.isCurrent(captured)) return { status: 'stale' };
        if (!result.ok) return { status: 'failed', error: result.error };
        return { status: 'completed', value: result.value };
      } catch {
        return { status: 'unavailable' };
      }
      },
    );
  }

  acknowledgeQuoteScreen(
    input: AgentMissionQuoteScreenAckInput,
  ): Promise<AgentMissionRuntimeCall<AcknowledgeQuoteScreenOutput>> {
    const captured = captureForQuoteScreen(
      this.owner,
      input.expectedScreenInstanceId,
    );
    if (captured === null) return Promise.resolve({ status: 'unavailable' });
    if (captured === 'context_unconfirmed') {
      return Promise.resolve({ status: 'context_unconfirmed' });
    }
    const context = captured.confirmedContext;
    if (context === null) return Promise.resolve({ status: 'context_unconfirmed' });
    const key = JSON.stringify([
      'ack_quote_screen',
      captured.generation,
      captured.session.realtimeSessionId,
      context.revision,
      context.digest,
      input.expectedScreenInstanceId,
      input.missionId,
      input.commandId,
      input.expectedMissionRevision,
      input.draft.sessionId,
      input.draft.slotRevision,
      input.draft.contentRevision,
    ]);
    return this.singleFlight<AcknowledgeQuoteScreenOutput>(
      key,
      async (): Promise<AgentMissionRuntimeCall<AcknowledgeQuoteScreenOutput>> => {
      try {
        const result = await captured.session.acknowledgeQuoteScreen({
          missionId: input.missionId,
          commandId: input.commandId,
          expectedMissionRevision: input.expectedMissionRevision,
          contextRevision: context.revision,
          contextDigest: context.digest,
          draftSessionId: input.draft.sessionId,
          expectedDraftSlotRevision: input.draft.slotRevision,
          expectedDraftContentRevision: input.draft.contentRevision,
        });
        if (!this.owner.isCurrent(captured)) return { status: 'stale' };
        if (!result.ok) return { status: 'failed', error: result.error };
        const output = result.value;
        if (
          output.receipt.ackCommandId !== input.commandId
          || output.receipt.missionId !== input.missionId
          || output.receipt.realtimeSessionId !== captured.session.realtimeSessionId
          || output.receipt.contextRevision !== context.revision
          || output.receipt.contextDigest !== context.digest
          || output.mission.id !== input.missionId
        ) {
          return { status: 'invalid_response' };
        }
        return { status: 'completed', value: output };
      } catch {
        return { status: 'unavailable' };
      }
      },
    );
  }

  private singleFlight<T>(
    key: string,
    work: () => Promise<AgentMissionRuntimeCall<T>>,
  ): Promise<AgentMissionRuntimeCall<T>> {
    const existing = this.flights.get(key);
    if (existing !== undefined) {
      return existing as Promise<AgentMissionRuntimeCall<T>>;
    }
    const flight = work().finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(
      key,
      flight as Promise<AgentMissionRuntimeCall<unknown>>,
    );
    return flight;
  }
}
