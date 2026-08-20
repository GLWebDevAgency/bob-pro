/** Autorité React owner-scopée unique de convergence Jarvis (SPEC U1-h L7). */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { focusManager, useQueryClient } from '@tanstack/react-query';
import type { JarvisRunView } from '@bob/api-client';
import { useAuth } from '../data/auth';
import { useBobClient } from '../data/client';
import { AGENT_REFRESH_QUERY_KEY_PREFIXES } from '../assistant/refresh-after-action';
import {
  JarvisRunConvergenceCoordinator,
  type JarvisRunExactReader,
} from './jarvis-run-convergence';

export interface JarvisRunConvergenceHandle {
  readonly supported: boolean;
  readonly observe: (run: JarvisRunView) => void;
}

const UNAVAILABLE_CONVERGENCE: JarvisRunConvergenceHandle = Object.freeze({
  supported: false,
  observe: () => undefined,
});

const JarvisRunConvergenceContext =
  createContext<JarvisRunConvergenceHandle>(UNAVAILABLE_CONVERGENCE);

/**
 * Instance unique, durable au-dessus des routes, reconstruite à chaque frontière d'identité.
 * Assistant et fiche client publient dans la même file ; ils ne possèdent aucun timer.
 */
export function JarvisRunConvergenceProvider({ children }: { readonly children: ReactNode }) {
  const auth = useAuth();
  const client = useBobClient();
  const queryClient = useQueryClient();
  const session = auth.session;
  const authenticated = auth.enabled && session !== null && client.companyId !== 'public';
  const identity =
    authenticated && session !== null
      ? `${session.user.id}:${client.companyId}`
      : 'unauthenticated';
  const readRun = useMemo<JarvisRunExactReader | null>(
    () => (typeof client.jarvisGetRun === 'function' ? client.jarvisGetRun.bind(client) : null),
    [client],
  );
  const onSettled = useCallback(
    (_runId: string): void => {
      for (const prefix of AGENT_REFRESH_QUERY_KEY_PREFIXES) {
        void queryClient.invalidateQueries({ queryKey: prefix });
      }
      const currentKey = ['jarvis-run', 'current', identity] as const;
      void queryClient
        .cancelQueries({ queryKey: currentKey, exact: true })
        .then(() => queryClient.refetchQueries({ queryKey: currentKey, exact: true }));
    },
    [identity, queryClient],
  );
  const coordinator = useMemo(
    () => (authenticated && readRun !== null
      ? new JarvisRunConvergenceCoordinator(readRun, onSettled)
      : null),
    [authenticated, onSettled, readRun],
  );

  useEffect(() => {
    if (coordinator === null) return undefined;
    const activation = coordinator.activate(focusManager.isFocused());
    const syncAvailability = (): void => coordinator.setAvailable(focusManager.isFocused());
    const unsubscribe = focusManager.subscribe(syncAvailability);
    return () => {
      unsubscribe();
      coordinator.release(activation);
    };
  }, [coordinator]);

  const value = useMemo<JarvisRunConvergenceHandle>(
    () => (coordinator === null
      ? UNAVAILABLE_CONVERGENCE
      : Object.freeze({
          supported: true,
          observe: (run: JarvisRunView): void => coordinator.observe(run),
        })),
    [coordinator],
  );

  return (
    <JarvisRunConvergenceContext.Provider value={value}>
      {children}
    </JarvisRunConvergenceContext.Provider>
  );
}

export function useJarvisRunConvergence(): JarvisRunConvergenceHandle {
  return useContext(JarvisRunConvergenceContext);
}
