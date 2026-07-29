import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionSession,
} from '@bob/api-client';
import type { AgentContext } from '@bob/ai';
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
