import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { randomUUID } from 'expo-crypto';
import type {
  QuoteDraftAuthoritativeReference,
} from '../quote-draft/quote-draft-remote-store';
import type {
  QuoteDraftMissionHydrationResult,
} from '../quote-draft/quote-draft-provider';
import {
  useAgentMissionRuntimeActions,
  useAgentMissionRuntimeSnapshot,
} from './agent-mission-provider';
import {
  QuoteScreenMissionCoordinator,
  type QuoteScreenMissionBindingState,
  type QuoteScreenMissionObservation,
  type QuoteScreenMissionPorts,
} from './quote-screen-mission-coordinator';

const MAX_UNCHANGED_REFRESHES = 6;
const CONTEXT_CONFIRMATION_TIMEOUT_MS = 15_000;

export interface UseQuoteScreenMissionBindingInput {
  readonly screenInstanceId: string;
  readonly authoritativeDraft: QuoteDraftAuthoritativeReference | null;
  readonly persistenceStatus: 'hydrating' | 'ready' | 'saving' | 'clearing' | 'error';
  readonly hydrateDraft: (
    expected: QuoteDraftAuthoritativeReference,
  ) => Promise<QuoteDraftMissionHydrationResult>;
}

export interface QuoteScreenMissionBinding {
  readonly state: QuoteScreenMissionBindingState;
  /** Retry explicite : conserve les clés idempotentes déjà émises. */
  readonly retry: () => void;
}

function observationKey(observation: QuoteScreenMissionObservation): string {
  return JSON.stringify([
    observation.runtimeGeneration,
    observation.realtimeSessionId,
    observation.confirmedContext?.revision ?? null,
    observation.confirmedContext?.digest ?? null,
    observation.confirmedContext?.screen.name ?? null,
    observation.confirmedContext?.screen.instanceId ?? null,
    observation.screenInstanceId,
    observation.authoritativeDraft?.sessionId ?? null,
    observation.authoritativeDraft?.slotRevision ?? null,
    observation.authoritativeDraft?.contentRevision ?? null,
  ]);
}

/**
 * Adaptateur React très mince autour du coordinateur pur.
 *
 * Le coordinateur reste propriétaire des décisions réseau. Ce hook ne fait que :
 * - capturer une observation cohérente du rendu ;
 * - ignorer toute continuation appartenant à un ancien rendu ;
 * - rejouer les transitions `refreshing` jusqu'au point fixe, avec borne stricte ;
 * - exposer un retry utilisateur sans régénérer les commandIds idempotents.
 */
export function useQuoteScreenMissionBinding({
  screenInstanceId,
  authoritativeDraft,
  persistenceStatus,
  hydrateDraft,
}: UseQuoteScreenMissionBindingInput): QuoteScreenMissionBinding {
  const actions = useAgentMissionRuntimeActions();
  const snapshot = useAgentMissionRuntimeSnapshot();
  const [coordinator] = useState(
    () => new QuoteScreenMissionCoordinator(randomUUID),
  );
  const [state, setState] = useState<QuoteScreenMissionBindingState>({
    phase: 'detecting',
  });
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [releasedSessionId, setReleasedSessionId] = useState<string | null>(null);
  const refreshBudget = useRef({ key: '', attempts: 0 });

  const observation = useMemo<QuoteScreenMissionObservation>(
    () => ({
      runtimeGeneration: snapshot.generation,
      realtimeSessionId: snapshot.realtimeSessionId,
      confirmedContext: snapshot.confirmedContext,
      screenInstanceId,
      authoritativeDraft,
    }),
    [
      authoritativeDraft,
      screenInstanceId,
      snapshot.confirmedContext,
      snapshot.generation,
      snapshot.realtimeSessionId,
    ],
  );
  const key = observationKey(observation);
  const ports = useMemo<QuoteScreenMissionPorts>(
    () => ({ actions, hydrateDraft }),
    [actions, hydrateDraft],
  );

  useEffect(() => {
    let current = true;
    if (
      releasedSessionId !== null
      && releasedSessionId === observation.realtimeSessionId
    ) {
      return () => {
        current = false;
      };
    }
    if (
      releasedSessionId !== null
      && releasedSessionId !== observation.realtimeSessionId
    ) {
      setReleasedSessionId(null);
      setState({ phase: 'detecting' });
      return () => {
        current = false;
      };
    }
    if (refreshBudget.current.key !== key) {
      refreshBudget.current = { key, attempts: 0 };
      setState({ phase: 'detecting' });
    }

    void coordinator.advance(observation, ports).then(
      (next) => {
        if (!current) return;
        if (next.phase !== 'refreshing') {
          refreshBudget.current = { key, attempts: 0 };
          if (
            next.phase === 'ready'
            && next.mission.phase === 'awaiting_lines'
            && observation.realtimeSessionId !== null
          ) {
            setReleasedSessionId(observation.realtimeSessionId);
            setState({ phase: 'handoff', mission: next.mission });
            return;
          }
          setState(next);
          return;
        }

        const attempts = refreshBudget.current.key === key
          ? refreshBudget.current.attempts + 1
          : 1;
        refreshBudget.current = { key, attempts };
        if (attempts > MAX_UNCHANGED_REFRESHES) {
          setState({ phase: 'error', reason: 'slot_unavailable' });
          return;
        }
        setState(next);
        setRefreshEpoch((epoch) => epoch + 1);
      },
      () => {
        if (!current) return;
        setState({ phase: 'error', reason: 'mission_unavailable' });
      },
    );

    return () => {
      current = false;
    };
  }, [
    coordinator,
    key,
    observation,
    persistenceStatus,
    ports,
    refreshEpoch,
    releasedSessionId,
    retryEpoch,
  ]);

  useEffect(() => {
    if (
      state.phase !== 'waiting_context'
      && state.phase !== 'hydrating'
    ) return undefined;
    const timeout = setTimeout(() => {
      setState((current) => (
        current.phase === 'waiting_context' || current.phase === 'hydrating'
          ? { phase: 'error', reason: 'mission_unavailable' }
          : current
      ));
    }, CONTEXT_CONFIRMATION_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [key, retryEpoch, state.phase]);

  const retry = useCallback(() => {
    refreshBudget.current = { key: '', attempts: 0 };
    setState({ phase: 'detecting' });
    setRetryEpoch((epoch) => epoch + 1);
  }, []);

  return useMemo(() => ({ state, retry }), [retry, state]);
}
