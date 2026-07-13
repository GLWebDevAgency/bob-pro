import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useFocusEffect, usePathname } from 'expo-router';
import {
  AGENT_CONTEXT_MAX_CAPABILITIES,
  AGENT_CONTEXT_MAX_ENTITIES,
  sanitizeAgentData,
  type AgentCapability,
  type AgentContext,
  type AgentEntityRef,
} from '@bob/ai';

export type { AgentCapability, AgentContext, AgentEntityRef } from '@bob/ai';

/** Chrome local, jamais envoye au cerveau : reserve l'espace du bouton Bob. */
export interface AgentAccessLayout {
  readonly bottomAvoidance?: number;
  readonly hidden?: boolean;
}

interface AgentPublication {
  readonly context: AgentContext;
  readonly layout: AgentAccessLayout;
}

interface AgentContextValue {
  readonly context: AgentContext;
  readonly layout: AgentAccessLayout;
  readonly publish: (publication: AgentPublication) => () => void;
}

const EMPTY_ENTITIES: readonly AgentEntityRef[] = Object.freeze([]);
const EMPTY_CAPABILITIES: readonly AgentCapability[] = Object.freeze([]);
const EMPTY_LAYOUT: AgentAccessLayout = Object.freeze({});

function normalizeScreen(pathname: string): string {
  if (!pathname) return '/';
  return pathname === '/' ? '/' : `/${pathname.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

export function snapshotAgentContext(context: AgentContext): AgentContext {
  return Object.freeze({
    screen: Object.freeze({ ...context.screen }),
    entities: Object.freeze(
      context.entities.slice(0, AGENT_CONTEXT_MAX_ENTITIES).map((entity) =>
        Object.freeze({
          ...entity,
          label: sanitizeAgentData(entity.label, 120) || entity.type,
        }),
      ),
    ),
    capabilities: Object.freeze(context.capabilities.slice(0, AGENT_CONTEXT_MAX_CAPABILITIES)),
  });
}

const AgentContextState = createContext<AgentContextValue | null>(null);

export function AgentContextProvider({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const registrations = useRef(new Map<number, AgentPublication>());
  const sequence = useRef(0);
  const [version, setVersion] = useState(0);

  const publish = useCallback((publication: AgentPublication): (() => void) => {
    sequence.current += 1;
    const id = sequence.current;
    registrations.current.set(id, {
      context: snapshotAgentContext(publication.context),
      layout: { ...publication.layout },
    });
    setVersion((current) => current + 1);
    return () => {
      if (!registrations.current.delete(id)) return;
      setVersion((current) => current + 1);
    };
  }, []);

  const value = useMemo<AgentContextValue>(() => {
    // Une publication focus-safe est toujours la plus recente. Les tabs sous-jacents peuvent
    // rester montes : leur cleanup de focus les retire avant que la route poussee ne parle.
    const active = [...registrations.current.entries()].at(-1)?.[1];
    const fallback: AgentContext = {
      screen: { name: normalizeScreen(pathname), instanceId: pathname || '/' },
      entities: EMPTY_ENTITIES,
      capabilities: EMPTY_CAPABILITIES,
    };
    return {
      context: active?.context ?? fallback,
      layout: active?.layout ?? {},
      publish,
    };
    // version matérialise les mutations de la Map dans la valeur memoisee.
  }, [pathname, publish, version]);

  return <AgentContextState.Provider value={value}>{children}</AgentContextState.Provider>;
}

export function useAgentContext(): AgentContext {
  const value = useContext(AgentContextState);
  if (!value) throw new Error('useAgentContext must be used inside AgentContextProvider');
  return value.context;
}

export function useAgentAccessLayout(): AgentAccessLayout {
  const value = useContext(AgentContextState);
  if (!value) throw new Error('useAgentAccessLayout must be used inside AgentContextProvider');
  return value.layout;
}

/**
 * Publie uniquement pendant que la route est focalisee. Le contexte est remplace quand les
 * donnees reelles changent et retire au blur/unmount, sans contexte stale d'un tab cache.
 */
export function usePublishAgentContext(
  context: AgentContext,
  layout: AgentAccessLayout = EMPTY_LAYOUT,
): void {
  const value = useContext(AgentContextState);
  if (!value) throw new Error('usePublishAgentContext must be used inside AgentContextProvider');
  const { publish } = value;
  useFocusEffect(useCallback(() => publish({ context, layout }), [context, layout, publish]));
}
