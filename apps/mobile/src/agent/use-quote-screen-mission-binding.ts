import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { randomUUID } from 'expo-crypto';
import type { AgentMissionViewV1 } from '@bob/core';
import type {
  QuoteDraftAuthoritativeReference,
} from '../quote-draft/quote-draft-remote-store';
import type {
  QuoteDraftMissionHydrationResult,
} from '../quote-draft/quote-draft-provider';
import {
  useAgentMissionRecovery,
} from './agent-mission-recovery';
import {
  useAgentMissionRuntimeActions,
  useAgentMissionRuntimeSnapshot,
} from './agent-mission-provider';
import {
  QuoteManualHandoffCoordinator,
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
  readonly suspendLiveForManualHandoff: () => Promise<boolean>;
  readonly stopLiveAfterManualHandoff: () => Promise<void>;
}

export interface QuoteScreenMissionBinding {
  readonly state: QuoteScreenMissionBindingState;
  /** Retry explicite : conserve les clés idempotentes déjà émises. */
  readonly retry: () => void;
  /** Libère durablement la mission avant de rendre le writer manuel interactif. */
  readonly continueManually: () => Promise<void>;
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
    observation.recovery,
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
  suspendLiveForManualHandoff,
  stopLiveAfterManualHandoff,
}: UseQuoteScreenMissionBindingInput): QuoteScreenMissionBinding {
  const actions = useAgentMissionRuntimeActions();
  const snapshot = useAgentMissionRuntimeSnapshot();
  const recovery = useAgentMissionRecovery();
  const [coordinator] = useState(
    () => new QuoteScreenMissionCoordinator(randomUUID),
  );
  const [handoffCoordinator] = useState(
    () => new QuoteManualHandoffCoordinator(randomUUID),
  );
  const [state, setState] = useState<QuoteScreenMissionBindingState>({
    phase: 'detecting',
  });
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [releasedSessionId, setReleasedSessionId] = useState<string | null>(null);
  const refreshBudget = useRef({ key: '', attempts: 0 });
  const handoffFlight = useRef<Promise<void> | null>(null);

  const observation = useMemo<QuoteScreenMissionObservation>(
    () => ({
      runtimeGeneration: snapshot.generation,
      realtimeSessionId: snapshot.realtimeSessionId,
      confirmedContext: snapshot.confirmedContext,
      screenInstanceId,
      authoritativeDraft,
      recovery: recovery.snapshot,
    }),
    [
      authoritativeDraft,
      screenInstanceId,
      snapshot.confirmedContext,
      snapshot.generation,
      snapshot.realtimeSessionId,
      recovery.snapshot,
    ],
  );
  const key = observationKey(observation);
  const ports = useMemo<QuoteScreenMissionPorts>(
    () => ({
      actions,
      hydrateDraft,
      refreshRecovery: recovery.refresh,
    }),
    [actions, hydrateDraft, recovery.refresh],
  );

  useEffect(() => {
    let current = true;
    if (handoffFlight.current !== null) {
      return () => {
        current = false;
      };
    }
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
            setState({ phase: 'handoff_required', mission: next.mission });
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
      && state.phase !== 'waiting_recovery'
      && state.phase !== 'hydrating'
    ) return undefined;
    const timeout = setTimeout(() => {
      setState((current) => (
        current.phase === 'waiting_context'
          || current.phase === 'waiting_recovery'
          || current.phase === 'hydrating'
          ? { phase: 'error', reason: 'mission_unavailable' }
          : current
      ));
    }, CONTEXT_CONFIRMATION_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [key, retryEpoch, state.phase]);

  const retry = useCallback(() => {
    refreshBudget.current = { key: '', attempts: 0 };
    setState({ phase: 'detecting' });
    void recovery.refresh();
    setRetryEpoch((epoch) => epoch + 1);
  }, [recovery.refresh]);

  const continueManually = useCallback((): Promise<void> => {
    const currentFlight = handoffFlight.current;
    if (currentFlight !== null) return currentFlight;
    if (
      state.phase !== 'handoff_required'
      && state.phase !== 'handoff_error'
    ) return Promise.resolve();
    const mission = state.mission;
    const realtimeSessionId = observation.realtimeSessionId;
    if (realtimeSessionId === null) {
      setState({ phase: 'handoff_error', mission });
      return Promise.resolve();
    }
    setState({ phase: 'handing_off', mission });
    const flight = (async (): Promise<void> => {
      let terminalMission: AgentMissionViewV1 | null = null;
      let transportQuiescent = true;
      try {
        const suspended = await suspendLiveForManualHandoff();
        if (suspended) {
          const result = await handoffCoordinator.handoff({
            mission,
            expectedScreenInstanceId: observation.screenInstanceId,
          }, actions);
          if (result.status === 'completed') {
            terminalMission = result.value.mission;
          }
        }
      } catch {
        // Réponse réseau perdue ≠ mutation absente. La lecture causale ci-dessous tranche.
      } finally {
        // Même après une réponse perdue, aucun transport/capability ne survit à la bascule.
        try {
          await stopLiveAfterManualHandoff();
        } catch {
          transportQuiescent = false;
        }
      }

      // Preuve causale : ce GET est obligatoirement parti APRÈS la mutation et la fermeture.
      const recovered = await recovery.refreshAfterMutation();
      if (!transportQuiescent) {
        setState({ phase: 'handoff_error', mission });
        return;
      }
      if (recovered.phase === 'absent') {
        refreshBudget.current = { key: '', attempts: 0 };
        setReleasedSessionId(realtimeSessionId);
        setState(terminalMission === null
          ? { phase: 'manual', reason: 'no_mission' }
          : { phase: 'handoff', mission: terminalMission });
        return;
      }
      if (recovered.phase === 'resumable') {
        setState({ phase: 'resume_required', recovery: recovered.value });
        return;
      }
      setState({ phase: 'handoff_error', mission });
    })().catch(() => {
      setState({ phase: 'handoff_error', mission });
    }).finally(() => {
      if (handoffFlight.current === flight) handoffFlight.current = null;
    });
    handoffFlight.current = flight;
    return flight;
  }, [
    actions,
    handoffCoordinator,
    observation.realtimeSessionId,
    observation.screenInstanceId,
    recovery,
    state,
    stopLiveAfterManualHandoff,
    suspendLiveForManualHandoff,
  ]);

  return useMemo(
    () => ({ state, retry, continueManually }),
    [continueManually, retry, state],
  );
}
