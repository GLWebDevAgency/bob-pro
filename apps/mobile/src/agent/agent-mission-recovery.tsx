import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../data/auth';
import { useBobClient } from '../data/client';
import {
  deriveAgentMissionRecoverySnapshot,
  type AgentMissionRecoverySnapshot,
} from './agent-mission-recovery-state';
import { loadQuoteAgentMissionRecovery } from './agent-mission-recovery-loader';

interface AgentMissionRecoveryContextValue {
  readonly snapshot: AgentMissionRecoverySnapshot;
  /**
   * Relit le snapshot JWT+RLS et retourne directement le résultat de CETTE lecture.
   * Le coordinateur n'attend donc jamais une publication React ultérieure pour vérifier ses
   * fences après un ACK ou une décision.
   */
  readonly refresh: () => Promise<AgentMissionRecoverySnapshot>;
  /**
   * Lecture causale après une écriture : toute lecture partie avant la mutation est annulée,
   * puis un GET neuf doit prouver l'état post-commit.
   */
  readonly refreshAfterMutation: () => Promise<AgentMissionRecoverySnapshot>;
}

const AgentMissionRecoveryContext =
  createContext<AgentMissionRecoveryContextValue | null>(null);

/**
 * Cache mémoire owner-scopé, non persisté, consacré à la reprise froide.
 *
 * Cette couche ne crée aucune capability, ne parle pas et ne navigue pas. Elle disparaît avec la
 * frontière authentifiée ; `gcTime: 0` empêche aussi une vue contenant des libellés clients de
 * rester dans le cache après le démontage du dernier observateur.
 */
export function AgentMissionRecoveryProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const auth = useAuth();
  const client = useBobClient();
  const queryClient = useQueryClient();
  const session = auth.session;
  const authenticated =
    auth.enabled
    && session !== null
    && client.companyId !== 'public';
  const identity = authenticated && session !== null
    ? `${session.user.id}:${client.companyId}`
    : 'unauthenticated';
  const queryKey = useMemo(
    () => [
      'agent-mission-resume',
      'quote-creation',
      'v2-first-v1-upgrade-fallback',
      identity,
    ] as const,
    [identity],
  );
  const query = useQuery({
    queryKey,
    enabled: authenticated,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) => loadQuoteAgentMissionRecovery(client, signal),
  });
  const snapshot = useMemo(
    () => deriveAgentMissionRecoverySnapshot({
      authenticated,
      pending: query.isPending,
      fetching: query.isFetching,
      failed: query.isError,
      data: query.data,
    }),
    [
      authenticated,
      query.data,
      query.isError,
      query.isFetching,
      query.isPending,
    ],
  );
  const { refetch } = query;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const refreshEpoch = useRef(0);
  const refreshFlight = useRef<{
    readonly identity: string;
    readonly epoch: number;
    readonly promise: Promise<AgentMissionRecoverySnapshot>;
  } | null>(null);
  const runRefresh = useCallback((
    epoch: number,
    cancelRefetch: boolean,
  ): Promise<AgentMissionRecoverySnapshot> => {
    if (!authenticated) {
      return Promise.resolve({ phase: 'error', reason: 'unauthenticated' });
    }
    const current = refreshFlight.current;
    if (
      current !== null
      && current.identity === identity
      && current.epoch === epoch
    ) {
      return current.promise;
    }
    const promise = refetch({ cancelRefetch }).then(
      (result): AgentMissionRecoverySnapshot =>
        deriveAgentMissionRecoverySnapshot({
          authenticated: true,
          pending: result.isPending,
          fetching: result.isFetching,
          failed: result.isError,
          data: result.data,
        }),
      (): AgentMissionRecoverySnapshot => ({
        phase: 'error',
        reason: 'unavailable',
      }),
    ).finally(() => {
      if (refreshFlight.current?.promise === promise) {
        refreshFlight.current = null;
      }
    });
    refreshFlight.current = Object.freeze({ identity, epoch, promise });
    return promise;
  }, [authenticated, identity, refetch]);
  const refresh = useCallback(
    (): Promise<AgentMissionRecoverySnapshot> =>
      runRefresh(refreshEpoch.current, false),
    [runRefresh],
  );
  const refreshAfterMutation = useCallback(
    async (): Promise<AgentMissionRecoverySnapshot> => {
      if (!authenticated) {
        return { phase: 'error', reason: 'unauthenticated' };
      }
      const requestedIdentity = identity;
      const epoch = refreshEpoch.current + 1;
      refreshEpoch.current = epoch;
      refreshFlight.current = null;
      await queryClient.cancelQueries({ queryKey, exact: true });
      if (identityRef.current !== requestedIdentity) {
        return { phase: 'error', reason: 'unauthenticated' };
      }
      return runRefresh(epoch, true);
    },
    [authenticated, identity, queryClient, queryKey, runRefresh],
  );
  const value = useMemo<AgentMissionRecoveryContextValue>(
    () => Object.freeze({ snapshot, refresh, refreshAfterMutation }),
    [refresh, refreshAfterMutation, snapshot],
  );

  return (
    <AgentMissionRecoveryContext.Provider value={value}>
      {children}
    </AgentMissionRecoveryContext.Provider>
  );
}

export function useAgentMissionRecovery(): AgentMissionRecoveryContextValue {
  const value = useContext(AgentMissionRecoveryContext);
  if (value === null) {
    throw new Error(
      'useAgentMissionRecovery doit être utilisé dans AgentMissionRecoveryProvider',
    );
  }
  return value;
}
