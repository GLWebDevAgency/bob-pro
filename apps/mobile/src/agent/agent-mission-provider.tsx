import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AgentContext } from '@bob/ai';
import type { RealtimeAgentMissionSession } from '@bob/api-client';
import {
  AgentMissionRuntimeOwner,
  FencedAgentMissionRuntimeActions,
  type AgentMissionRuntimeBridge,
  type AgentMissionRuntimeActions,
  type AgentMissionRuntimeSnapshot,
} from './agent-mission-runtime';
import type { RealtimePublishedFence } from './realtime-driver';
import { registerBeforeSignOutCleanup } from '../data/session-cleanup';

interface AgentMissionRuntimeContextValue {
  readonly bridge: AgentMissionRuntimeBridge;
  readonly actions: AgentMissionRuntimeActions;
  readonly snapshot: AgentMissionRuntimeSnapshot;
}

const AgentMissionRuntimeContext =
  createContext<AgentMissionRuntimeContextValue | null>(null);

/**
 * Propriétaire authentifié unique de la capability Mission.
 *
 * Sa position au-dessus du routeur garantit que la navigation Home → devis ne détruit pas le
 * handle. Le remount de la frontière authentifiée (logout, owner ou tenant différent) détruit
 * en revanche synchroniquement l'ancien handle.
 */
export function AgentMissionProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [owner] = useState(() => new AgentMissionRuntimeOwner());
  const [actions] = useState(() => new FencedAgentMissionRuntimeActions(owner));
  const [snapshot, setSnapshot] = useState(() => owner.snapshot());
  const effectGeneration = useRef(0);

  useEffect(() => {
    const generation = ++effectGeneration.current;
    if (!owner.activate()) return undefined;
    const unsubscribe = owner.subscribe(setSnapshot);
    const unregisterSignOut = registerBeforeSignOutCleanup(() => {
      // La déconnexion est une vraie frontière de sécurité, pas un faux cycle Strict Effects :
      // invalider et détruire immédiatement la capability avant toute bascule de principal.
      owner.dispose();
      return Promise.resolve();
    });
    return () => {
      unregisterSignOut();
      unsubscribe();
      // Invalidation SYNCHRONE : aucune opération tardive ne survit au démontage. La destruction
      // est différée d'une micro-tâche uniquement pour laisser React 19 rejouer setup après son
      // cleanup de vérification ; un vrai unmount n'a pas de second setup et détruit le handle.
      owner.deactivate();
      queueMicrotask(() => {
        if (effectGeneration.current === generation) owner.dispose();
      });
    };
  }, [owner]);

  const bridge = useMemo<AgentMissionRuntimeBridge>(
    () => Object.freeze({
      adopt: (session: RealtimeAgentMissionSession) => owner.adopt(session),
      invalidateContext: (realtimeSessionId: string) =>
        owner.invalidateContext(realtimeSessionId),
      confirmContext: (
        realtimeSessionId: string,
        fence: RealtimePublishedFence,
        context: AgentContext,
      ) =>
        owner.confirmContext(realtimeSessionId, fence, context),
    }),
    [owner],
  );
  const value = useMemo<AgentMissionRuntimeContextValue>(
    () => Object.freeze({ actions, bridge, snapshot }),
    [actions, bridge, snapshot],
  );

  return (
    <AgentMissionRuntimeContext.Provider value={value}>
      {children}
    </AgentMissionRuntimeContext.Provider>
  );
}

export function useAgentMissionRuntimeBridge(): AgentMissionRuntimeBridge {
  const value = useContext(AgentMissionRuntimeContext);
  if (value === null) {
    throw new Error(
      'useAgentMissionRuntimeBridge doit être utilisé dans AgentMissionProvider',
    );
  }
  return value.bridge;
}

export function useAgentMissionRuntimeSnapshot(): AgentMissionRuntimeSnapshot {
  const value = useContext(AgentMissionRuntimeContext);
  if (value === null) {
    throw new Error(
      'useAgentMissionRuntimeSnapshot doit être utilisé dans AgentMissionProvider',
    );
  }
  return value.snapshot;
}

export function useAgentMissionRuntimeActions(): AgentMissionRuntimeActions {
  const value = useContext(AgentMissionRuntimeContext);
  if (value === null) {
    throw new Error(
      'useAgentMissionRuntimeActions doit être utilisé dans AgentMissionProvider',
    );
  }
  return value.actions;
}
