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
  QuoteMissionAbandonCoordinator,
  QuoteScreenMissionCoordinator,
  type QuoteScreenMissionBindingState,
  type QuoteScreenMissionObservation,
  type QuoteScreenMissionPorts,
} from './quote-screen-mission-coordinator';

const MAX_UNCHANGED_REFRESHES = 6;
const CONTEXT_CONFIRMATION_TIMEOUT_MS = 15_000;
const LOADING_RECOVERY = Object.freeze({ phase: 'loading' as const });

export interface UseQuoteScreenMissionBindingInput {
  readonly screenInstanceId: string;
  readonly authoritativeDraft: QuoteDraftAuthoritativeReference | null;
  readonly persistenceStatus: 'hydrating' | 'ready' | 'saving' | 'clearing' | 'error';
  readonly hydrateDraft: (
    expected: QuoteDraftAuthoritativeReference,
  ) => Promise<QuoteDraftMissionHydrationResult>;
  readonly suspendLiveForManualHandoff: () => Promise<boolean>;
  readonly stopLiveAfterManualHandoff: () => Promise<number | null>;
}

export interface QuoteScreenMissionBinding {
  readonly state: QuoteScreenMissionBindingState;
  /** Retry explicite : conserve les clés idempotentes déjà émises. */
  readonly retry: () => void;
  /** Libère durablement la mission avant de rendre le writer manuel interactif. */
  readonly continueManually: () => Promise<void>;
  /**
   * Abandonne explicitement la mission Bob tout en conservant le brouillon. `true` n'est rendu
   * qu'après terminalisation, arrêt du transport et GET causal prouvant le slot libéré.
   */
  readonly abandonMission: () => Promise<boolean>;
}

function observationKey(observation: QuoteScreenMissionObservation): string {
  return JSON.stringify([
    observation.runtimeGeneration,
    observation.protocolVersion,
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
  const [abandonCoordinator] = useState(
    () => new QuoteMissionAbandonCoordinator(randomUUID),
  );
  const [state, setState] = useState<QuoteScreenMissionBindingState>({
    phase: 'detecting',
  });
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [
    releasedRuntimeGeneration,
    setReleasedRuntimeGeneration,
  ] = useState<number | null>(null);
  const [
    recoveryVerifiedRuntimeGeneration,
    setRecoveryVerifiedRuntimeGeneration,
  ] = useState<number | null>(null);
  const refreshBudget = useRef({ key: '', attempts: 0 });
  const lastObservationKey = useRef('');
  const handoffFlight = useRef<Promise<void> | null>(null);
  const abandonFlight = useRef<Promise<boolean> | null>(null);
  const runtimeLossFlight = useRef<{
    readonly generation: number;
    readonly promise: Promise<QuoteScreenMissionObservation['recovery']>;
  } | null>(null);
  const runtimeLossDetected =
    snapshot.realtimeSessionId === null
    && recoveryVerifiedRuntimeGeneration !== snapshot.generation;
  const effectiveRecovery =
    runtimeLossDetected
      ? LOADING_RECOVERY
      : recovery.snapshot;

  const observation = useMemo<QuoteScreenMissionObservation>(
    () => ({
      runtimeGeneration: snapshot.generation,
      protocolVersion: snapshot.protocolVersion,
      realtimeSessionId: snapshot.realtimeSessionId,
      confirmedContext: snapshot.confirmedContext,
      screenInstanceId,
      authoritativeDraft,
      recovery: effectiveRecovery,
    }),
    [
      authoritativeDraft,
      screenInstanceId,
      snapshot.confirmedContext,
      snapshot.generation,
      snapshot.protocolVersion,
      snapshot.realtimeSessionId,
      effectiveRecovery,
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
    const currentSessionId = snapshot.realtimeSessionId;
    if (currentSessionId !== null) {
      setRecoveryVerifiedRuntimeGeneration(null);
      return undefined;
    }
    const generation = snapshot.generation;
    if (recoveryVerifiedRuntimeGeneration === generation) {
      return undefined;
    }
    if (handoffFlight.current !== null) return undefined;

    let current = true;
    setState({ phase: 'detecting' });
    const existingFlight = runtimeLossFlight.current;
    const promise =
      existingFlight?.generation === generation
        ? existingFlight.promise
        : recovery.refreshAfterMutation().catch(
            (): QuoteScreenMissionObservation['recovery'] => ({
              phase: 'error',
              reason: 'unavailable',
            }),
          );
    if (existingFlight?.generation !== generation) {
      runtimeLossFlight.current = { generation, promise };
    }
    void promise.then(
      () => {
        if (!current || snapshot.realtimeSessionId !== null) return;
        // `refreshAfterMutation` alimente le QueryClient avant de résoudre. On ne conserve
        // volontairement aucune copie locale : `recovery.snapshot` reste l'unique autorité et
        // pourra ensuite refléter une expiration, annulation distante ou un retry réussi.
        setRecoveryVerifiedRuntimeGeneration(generation);
        if (runtimeLossFlight.current?.promise === promise) {
          runtimeLossFlight.current = null;
        }
      },
    );
    return () => {
      current = false;
    };
  }, [
    recovery.refreshAfterMutation,
    recoveryVerifiedRuntimeGeneration,
    snapshot.generation,
    snapshot.realtimeSessionId,
  ]);

  useEffect(() => {
    let current = true;
    if (handoffFlight.current !== null) {
      return () => {
        current = false;
      };
    }
    if (
      releasedRuntimeGeneration !== null
      && releasedRuntimeGeneration === observation.runtimeGeneration
    ) {
      return () => {
        current = false;
      };
    }
    if (
      releasedRuntimeGeneration !== null
      && releasedRuntimeGeneration !== observation.runtimeGeneration
    ) {
      setReleasedRuntimeGeneration(null);
      setState({ phase: 'detecting' });
      return () => {
        current = false;
      };
    }
    if (lastObservationKey.current !== key) {
      lastObservationKey.current = key;
      setState({ phase: 'detecting' });
    }

    void coordinator.advance(observation, ports).then(
      (next) => {
        if (!current) return;
        if (next.phase !== 'refreshing') {
          if (
            next.phase === 'waiting_recovery'
            && refreshBudget.current.attempts > MAX_UNCHANGED_REFRESHES
          ) {
            // Le refetch qui a épuisé la borne publie souvent `loading` juste après sa réponse.
            // Cette publication transitoire ne doit pas effacer l'erreur terminale ni réarmer
            // silencieusement la boucle. Une réponse convergée ou un retry explicite la libérera.
            setState({ phase: 'error', reason: 'slot_unavailable' });
            return;
          }
          // React Query publie légitimement loading entre deux observations du MÊME tuple
          // mission. Réinitialiser ici rendrait la borne infinie. Seul un état convergé,
          // terminal ou explicitement erroné libère le budget.
          if (
            next.phase !== 'waiting_recovery'
            && next.phase !== 'hydrating'
            && next.phase !== 'acknowledging'
            && next.phase !== 'detecting'
          ) {
            refreshBudget.current = { key: '', attempts: 0 };
          }
          if (
            next.phase === 'ready'
            && next.mission.phase === 'awaiting_lines'
            && next.protocolVersion === 1
            && observation.realtimeSessionId !== null
          ) {
            setState({ phase: 'handoff_required', mission: next.mission });
            return;
          }
          setState(next);
          return;
        }

        const convergenceKey = next.convergenceKey;
        const attempts = refreshBudget.current.key === convergenceKey
          ? refreshBudget.current.attempts + 1
          : 1;
        refreshBudget.current = { key: convergenceKey, attempts };
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
    releasedRuntimeGeneration,
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
      let releasedGeneration: number | null = null;
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
          releasedGeneration = await stopLiveAfterManualHandoff();
          if (releasedGeneration === null) transportQuiescent = false;
        } catch {
          transportQuiescent = false;
        }
      }

      // Preuve causale : ce GET est obligatoirement parti APRÈS la mutation et la fermeture.
      const recovered = await recovery.refreshAfterMutation();
      if (releasedGeneration !== null) {
        // Le GET causal du handoff certifie déjà cette génération sans runtime. Réarmer l'effet
        // global déclencherait une deuxième lecture et pourrait écraser l'état terminal.
        setRecoveryVerifiedRuntimeGeneration(releasedGeneration);
      }
      if (!transportQuiescent) {
        setState({ phase: 'handoff_error', mission });
        return;
      }
      if (recovered.phase === 'absent') {
        refreshBudget.current = { key: '', attempts: 0 };
        setReleasedRuntimeGeneration(releasedGeneration);
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

  const abandonMission = useCallback((): Promise<boolean> => {
    const currentFlight = abandonFlight.current;
    if (currentFlight !== null) return currentFlight;
    if (state.phase !== 'ready' || state.protocolVersion !== 2) {
      return Promise.resolve(false);
    }
    const mission = state.mission;
    const realtimeSessionId = observation.realtimeSessionId;
    if (realtimeSessionId === null) return Promise.resolve(false);

    const flight = (async (): Promise<boolean> => {
      let transportQuiescent = true;
      let releasedGeneration: number | null = null;
      try {
        const suspended = await suspendLiveForManualHandoff();
        if (suspended) {
          const result = await abandonCoordinator.abandon({
            mission,
            expectedScreenInstanceId: observation.screenInstanceId,
          }, actions);
          // Le statut HTTP n'est pas l'autorité finale : une réponse peut se perdre après commit.
          // Le GET causal ci-dessous est le seul verdict qui autorise la saisie manuelle.
          void result;
        }
      } catch {
        // Réponse perdue ≠ mutation absente. Le GET causal après fermeture tranche.
      } finally {
        try {
          releasedGeneration = await stopLiveAfterManualHandoff();
          if (releasedGeneration === null) transportQuiescent = false;
        } catch {
          transportQuiescent = false;
        }
      }

      const recovered = await recovery.refreshAfterMutation();
      if (releasedGeneration !== null) {
        setRecoveryVerifiedRuntimeGeneration(releasedGeneration);
      }
      if (!transportQuiescent) return false;
      if (recovered.phase === 'absent') {
        refreshBudget.current = { key: '', attempts: 0 };
        setReleasedRuntimeGeneration(releasedGeneration);
        setState({ phase: 'manual', reason: 'no_mission' });
        // Une réponse perdue est acceptée seulement si l'autorité causale confirme l'absence.
        return true;
      }
      if (recovered.phase === 'resumable') {
        setState({ phase: 'resume_required', recovery: recovered.value });
      }
      return false;
    })().catch(() => false).finally(() => {
      if (abandonFlight.current === flight) abandonFlight.current = null;
    });
    abandonFlight.current = flight;
    return flight;
  }, [
    abandonCoordinator,
    actions,
    observation.realtimeSessionId,
    observation.screenInstanceId,
    recovery,
    state,
    stopLiveAfterManualHandoff,
    suspendLiveForManualHandoff,
  ]);

  return useMemo(
    () => ({ state, retry, continueManually, abandonMission }),
    [abandonMission, continueManually, retry, state],
  );
}
