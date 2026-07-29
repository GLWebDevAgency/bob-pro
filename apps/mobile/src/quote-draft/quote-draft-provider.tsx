import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { LineInput } from '@bob/core';
import { t } from '@bob/i18n';
import { ErrorRetry } from '@bob/ui';
import type { BobClient } from '@bob/api-client';
import { useAuth } from '../data/auth';
import { useBobClient } from '../data/client';
import { registerBeforeSignOutCleanup } from '../data/session-cleanup';
import { companyIdFromAppMetadata } from '../data/tenant-identity';
import { useTheme } from '../theme';
import {
  acceptQuoteDraftProposal,
  addCatalogueLine,
  addLine,
  applyQuoteDraftCommand,
  applyQuoteDraftCommands,
  clearQuoteDraftLineForm,
  completeQuoteDraft,
  completeQuoteDraftMission,
  createQuoteDraft,
  deriveQuoteDraftGuidance,
  discardQuoteDraft,
  expireQuoteDraftProposal,
  hasMeaningfulQuoteDraft,
  hasUnsavedQuoteDraftChanges,
  proposeQuoteDraft,
  rejectQuoteDraftProposal,
  requireQuoteDraftRevision,
  selectCustomer,
  startQuoteDraftMission,
  stopQuoteDraftMission,
  updateQuoteDraftLineForm,
  updateLine,
  type AddQuoteDraftLineInput,
  type ProposeQuoteDraftInput,
  type QuoteDraftCommand,
  type QuoteDraftCustomer,
  type QuoteDraftGuidance,
  type QuoteDraftLineFormState,
  type QuoteDraftMissionStopReason,
  type QuoteDraftResult,
  type QuoteDraftState,
} from './quote-draft-model';
import type { CataloguePrestation } from '@bob/core';
import {
  createQuoteDraftRemotePersistence,
  disposeQuoteDraftSession,
  isQuoteDraftRevisionConflict,
  type QuoteDraftAuthoritativeReference,
  type QuoteDraftRemotePersistence,
} from './quote-draft-remote-store';

export interface QuoteDraftProviderRuntime {
  readonly now: () => number;
  readonly newId: (kind: 'session' | 'mission' | 'line' | 'proposal') => string;
}

function fallbackId(kind: 'session' | 'mission' | 'line' | 'proposal'): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DEFAULT_RUNTIME: QuoteDraftProviderRuntime = {
  now: () => Date.now(),
  newId: fallbackId,
};

export interface QuoteDraftContextValue {
  readonly state: QuoteDraftState;
  /**
   * Non-null uniquement si l'état rendu correspond exactement au slot serveur observé.
   * Toute saisie locale non enregistrée le remet à null.
   */
  readonly authoritativeReference: QuoteDraftAuthoritativeReference | null;
  /** Brouillon enregistré PARKÉ par `startFresh` — jamais touché tant qu'il n'est pas repris
   * explicitement. Source unique pour la carte « brouillon » de ventes.tsx (bug fondateur
   * 2026-07-17 : « Devis » ne doit plus reprendre en silence ce qui traînait). */
  readonly pendingResume: QuoteDraftState | null;
  readonly guidance: QuoteDraftGuidance | null;
  readonly persistence: {
    readonly ready: boolean;
    readonly status: 'hydrating' | 'ready' | 'saving' | 'clearing' | 'error';
    readonly error: 'load' | 'save' | 'clear' | 'conflict' | null;
  };
  readonly apply: (command: QuoteDraftCommand) => QuoteDraftResult<QuoteDraftState>;
  readonly applyAtRevision: (
    command: QuoteDraftCommand,
    expectedRevision: number,
  ) => QuoteDraftResult<QuoteDraftState>;
  readonly applyAll: (commands: readonly QuoteDraftCommand[]) => QuoteDraftResult<QuoteDraftState>;
  readonly selectCustomer: (customer: QuoteDraftCustomer) => QuoteDraftResult<QuoteDraftState>;
  readonly addLine: (
    input: Omit<AddQuoteDraftLineInput, 'lineId'> & {
      readonly lineId?: string;
      readonly expectedRevision?: number;
    },
  ) => QuoteDraftResult<QuoteDraftState>;
  readonly addCatalogueLine: (input: {
    readonly prestation: CataloguePrestation;
    readonly qty: number;
    readonly interaction: AddQuoteDraftLineInput['interaction'];
    readonly lineId?: string;
  }) => QuoteDraftResult<QuoteDraftState>;
  readonly updateLine: (
    lineId: string,
    patch: Partial<LineInput>,
  ) => QuoteDraftResult<QuoteDraftState>;
  readonly updateLineForm: (patch: Partial<QuoteDraftLineFormState>) => void;
  readonly clearLineForm: () => void;
  readonly propose: (
    input: Omit<ProposeQuoteDraftInput, 'id' | 'createdAt' | 'expiresAt'> & {
      readonly id?: string;
      readonly ttlMs?: number;
    },
  ) => QuoteDraftResult<QuoteDraftState>;
  readonly acceptProposal: (proposalId: string) => QuoteDraftResult<QuoteDraftState>;
  readonly rejectProposal: (proposalId: string) => QuoteDraftResult<QuoteDraftState>;
  readonly expireProposal: () => void;
  readonly startMission: (input: {
    readonly mode: 'manual' | 'guided_voice';
    readonly startedFrom: string;
    readonly id?: string;
  }) => QuoteDraftResult<QuoteDraftState>;
  readonly stopMission: (reason: QuoteDraftMissionStopReason) => void;
  readonly completeMission: () => void;
  /** `true` signifie que le slot BDD a réellement été committé avec sa révision CAS. */
  readonly save: () => Promise<boolean>;
  /** N'efface la mémoire qu'après suppression durable et CAS du slot serveur. */
  readonly discard: () => Promise<boolean>;
  /** Fence pièce + purge durable ; un échec laisse le brouillon récupérable pour retry. */
  readonly complete: (artifactId: string) => Promise<boolean>;
  readonly reset: () => Promise<boolean>;
  /** Ouvre une session VIERGE en mémoire, SANS toucher le serveur : un brouillon déjà enregistré
   * et significatif est parké dans `pendingResume` (jamais silencieusement écrasé ni repris).
   * Idempotent : rappeler sans avoir rien saisi ne re-parque rien (la session courante est
   * déjà vierge). Toute entrée « créer un devis » doit appeler ceci — jamais reprendre en
   * silence ce qui traînait (bug fondateur 2026-07-17). */
  readonly startFresh: () => void;
  /** Ramène le brouillon parké en session active — le SEUL chemin de reprise explicite. */
  readonly resumePending: () => void;
  readonly hydrateMissionDraft: (
    expected: QuoteDraftAuthoritativeReference,
  ) => Promise<QuoteDraftMissionHydrationResult>;
}

export type QuoteDraftMissionHydrationResult =
  | {
      readonly status: 'ready';
      readonly reference: QuoteDraftAuthoritativeReference;
    }
  | {
      readonly status:
        | 'busy'
        | 'local_changes'
        | 'not_found'
        | 'stale'
        | 'superseded'
        | 'unavailable';
    };

const QuoteDraftContext = createContext<QuoteDraftContextValue | null>(null);

interface QuoteDraftProviderProps {
  readonly children: ReactNode;
  readonly runtime?: QuoteDraftProviderRuntime;
  /** Fabrique injectable pour tests ; la production utilise exclusivement le client HTTP. */
  readonly createPersistence?: (client: BobClient) => QuoteDraftRemotePersistence;
}

export function QuoteDraftProvider({
  children,
  runtime = DEFAULT_RUNTIME,
  createPersistence = createQuoteDraftRemotePersistence,
}: QuoteDraftProviderProps) {
  const { enabled, session } = useAuth();
  const client = useBobClient();
  const authenticatedUserId = session?.user.id ?? null;
  const authenticatedCompanyId = companyIdFromAppMetadata(session?.user.app_metadata);
  const authenticated = enabled
    && authenticatedUserId !== null
    && authenticatedCompanyId !== null
    && client.companyId === authenticatedCompanyId;
  const sessionKey = authenticated
    ? `${authenticatedCompanyId}:${authenticatedUserId}`
    : 'unauthenticated';
  const persistence = useMemo(
    () => (authenticated ? createPersistence(client) : null),
    [authenticated, client, createPersistence, sessionKey],
  );
  if (!authenticated || persistence === null) {
    // AuthGate ne monte pas ce provider sans session. Cette barrière empêche néanmoins toute
    // future composition de créer un brouillon local, public ou attribué à une identité inventée.
    throw new Error('QuoteDraftProvider: session authentifiée et tenant cohérent requis');
  }

  // La key React est une fence synchrone : aucun rendu du compte B ne peut exposer une frame du
  // brouillon du compte A pendant que les effets d'identité se mettent à jour.
  return (
    <QuoteDraftSessionProvider
      key={sessionKey}
      persistence={persistence}
      runtime={runtime}
    >
      {children}
    </QuoteDraftSessionProvider>
  );
}

function QuoteDraftSessionProvider({
  children,
  persistence,
  runtime,
}: {
  readonly children: ReactNode;
  readonly persistence: QuoteDraftRemotePersistence;
  readonly runtime: QuoteDraftProviderRuntime;
}) {
  const { colors, personality } = useTheme();
  const [state, setState] = useState<QuoteDraftState>(
    () => createQuoteDraft(runtime.newId('session')),
  );
  /** Brouillon enregistré parké par `startFresh` — jamais écrasé tant qu'il n'est pas repris ou
   * qu'une nouvelle sauvegarde/suppression ne le rend caduc (la BDD est un slot UNIQUE). */
  const [pendingResume, setPendingResume] = useState<QuoteDraftState | null>(null);
  const [authoritativeReference, setAuthoritativeReference] =
    useState<QuoteDraftAuthoritativeReference | null>(null);
  const [persistenceState, setPersistenceState] = useState<QuoteDraftContextValue['persistence']>(
    () => ({ ready: false, status: 'hydrating', error: null }),
  );
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  // Fence synchrone : tap et transcript reçus dans le même tick sont sérialisés sur le dernier état.
  const stateRef = useRef(state);
  stateRef.current = state;
  const authoritativeReferenceRef =
    useRef<QuoteDraftAuthoritativeReference | null>(authoritativeReference);
  authoritativeReferenceRef.current = authoritativeReference;
  const mutationEpoch = useRef(0);
  const persistenceOperation =
    useRef<'save' | 'clear' | 'complete' | 'mission_hydrate' | null>(null);

  const publishAuthoritativeReference = useCallback(
    (reference: QuoteDraftAuthoritativeReference | null): void => {
      authoritativeReferenceRef.current = reference;
      setAuthoritativeReference(reference);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const epochAtStart = mutationEpoch.current;
    setPersistenceState({ ready: false, status: 'hydrating', error: null });
    void persistence
      .load()
      .then((hydrated) => {
        if (!active) return;
        // Double fence : les enfants ne sont pas encore montés, et une future évolution qui les
        // monterait ne pourra toujours pas écraser une saisie arrivée pendant l'I/O.
        if (hydrated !== null && mutationEpoch.current === epochAtStart) {
          stateRef.current = hydrated.state;
          setState(hydrated.state);
          publishAuthoritativeReference(hydrated.reference);
        } else if (hydrated === null && mutationEpoch.current === epochAtStart) {
          publishAuthoritativeReference(null);
        }
        setPersistenceState({ ready: true, status: 'ready', error: null });
      })
      .catch(() => {
        if (!active) return;
        // Fail closed : l'état vierge en mémoire reste caché. Un échec serveur n'est jamais
        // présenté comme l'absence d'un brouillon et aucune donnée locale ne prend le relais.
        setPersistenceState({ ready: false, status: 'error', error: 'load' });
      });
    return () => {
      active = false;
    };
  }, [hydrationAttempt, persistence, publishAuthoritativeReference]);

  const assign = useCallback((next: QuoteDraftState, isMutation = true): void => {
    if (isMutation) mutationEpoch.current += 1;
    const currentReference = authoritativeReferenceRef.current;
    if (
      currentReference !== null
      && (
        currentReference.sessionId !== next.sessionId
        || currentReference.contentRevision !== next.revision
        || hasUnsavedQuoteDraftChanges(next)
      )
    ) {
      publishAuthoritativeReference(null);
    }
    stateRef.current = next;
    setState(next);
  }, [publishAuthoritativeReference]);

  useEffect(() => {
    const unregister = registerBeforeSignOutCleanup(() => {
      // La déconnexion invalide les réponses tardives et purge toute mémoire du compte courant.
      // Le slot BDD reste intact afin que l'utilisateur puisse le reprendre à sa prochaine session.
      persistence.dispose();
      mutationEpoch.current += 1;
      persistenceOperation.current = null;
      const empty = createQuoteDraft(runtime.newId('session'));
      stateRef.current = empty;
      setState(empty);
      publishAuthoritativeReference(null);
      setPendingResume(null);
      setPersistenceState({ ready: false, status: 'hydrating', error: null });
      return disposeQuoteDraftSession(persistence);
    });
    return () => {
      unregister();
      persistence.dispose();
    };
  }, [persistence, publishAuthoritativeReference, runtime]);

  const commit = useCallback(
    (result: QuoteDraftResult<QuoteDraftState>): QuoteDraftResult<QuoteDraftState> => {
      if (result.ok) assign(result.value);
      return result;
    },
    [assign],
  );

  const apply = useCallback(
    (command: QuoteDraftCommand) =>
      commit(applyQuoteDraftCommand(stateRef.current, command, runtime.now())),
    [commit, runtime],
  );

  const applyAtRevision = useCallback(
    (command: QuoteDraftCommand, expectedRevision: number): QuoteDraftResult<QuoteDraftState> => {
      const fenced = requireQuoteDraftRevision(stateRef.current, expectedRevision);
      if (!fenced.ok) return fenced;
      return commit(applyQuoteDraftCommand(stateRef.current, command, runtime.now()));
    },
    [commit, runtime],
  );

  const applyAll = useCallback(
    (commands: readonly QuoteDraftCommand[]) =>
      commit(applyQuoteDraftCommands(stateRef.current, commands, runtime.now())),
    [commit, runtime],
  );

  const selectCustomerAction = useCallback(
    (customer: QuoteDraftCustomer) =>
      commit(selectCustomer(stateRef.current, customer, runtime.now())),
    [commit, runtime],
  );

  const addLineAction = useCallback(
    (
      input: Omit<AddQuoteDraftLineInput, 'lineId'> & {
        readonly lineId?: string;
        readonly expectedRevision?: number;
      },
    ) => {
      if (input.expectedRevision !== undefined) {
        const fenced = requireQuoteDraftRevision(stateRef.current, input.expectedRevision);
        if (!fenced.ok) return fenced;
      }
      const { expectedRevision: _expectedRevision, ...lineInput } = input;
      return commit(
        addLine(
          stateRef.current,
          { ...lineInput, lineId: input.lineId ?? runtime.newId('line') },
          runtime.now(),
        ),
      );
    },
    [commit, runtime],
  );

  const addCatalogueLineAction = useCallback(
    (input: {
      readonly prestation: CataloguePrestation;
      readonly qty: number;
      readonly interaction: AddQuoteDraftLineInput['interaction'];
      readonly lineId?: string;
    }) =>
      commit(
        addCatalogueLine(
          stateRef.current,
          { ...input, lineId: input.lineId ?? runtime.newId('line') },
          runtime.now(),
        ),
      ),
    [commit, runtime],
  );

  const updateLineAction = useCallback(
    (lineId: string, patch: Partial<LineInput>) =>
      commit(updateLine(stateRef.current, lineId, patch, runtime.now())),
    [commit, runtime],
  );

  const updateLineFormAction = useCallback(
    (patch: Partial<QuoteDraftLineFormState>) => {
      const next = updateQuoteDraftLineForm(stateRef.current, patch);
      if (next === stateRef.current) return;
      assign(next);
    },
    [assign],
  );

  const clearLineFormAction = useCallback(() => {
    const next = clearQuoteDraftLineForm(stateRef.current);
    if (next === stateRef.current) return;
    assign(next);
  }, [assign]);

  const propose = useCallback(
    (
      input: Omit<ProposeQuoteDraftInput, 'id' | 'createdAt' | 'expiresAt'> & {
        readonly id?: string;
        readonly ttlMs?: number;
      },
    ) => {
      const createdAt = runtime.now();
      const ttlMs = input.ttlMs ?? 2 * 60_000;
      return commit(
        proposeQuoteDraft(stateRef.current, {
          ...input,
          id: input.id ?? runtime.newId('proposal'),
          createdAt,
          expiresAt: createdAt + ttlMs,
        }),
      );
    },
    [commit, runtime],
  );

  const acceptProposal = useCallback(
    (proposalId: string) =>
      commit(acceptQuoteDraftProposal(stateRef.current, proposalId, runtime.now())),
    [commit, runtime],
  );

  const rejectProposal = useCallback(
    (proposalId: string) =>
      commit(rejectQuoteDraftProposal(stateRef.current, proposalId, runtime.now())),
    [commit, runtime],
  );

  const expireProposal = useCallback(() => {
    const next = expireQuoteDraftProposal(stateRef.current, runtime.now());
    if (next === stateRef.current) return;
    assign(next);
  }, [assign, runtime]);

  const startMission = useCallback(
    (input: {
      readonly mode: 'manual' | 'guided_voice';
      readonly startedFrom: string;
      readonly id?: string;
    }) =>
      commit(
        startQuoteDraftMission(stateRef.current, {
          id: input.id ?? runtime.newId('mission'),
          mode: input.mode,
          startedFrom: input.startedFrom,
          startedAt: runtime.now(),
        }),
      ),
    [commit, runtime],
  );

  const stopMission = useCallback(
    (reason: QuoteDraftMissionStopReason) => {
      const next = stopQuoteDraftMission(stateRef.current, { reason, stoppedAt: runtime.now() });
      if (next !== stateRef.current) assign(next);
    },
    [assign, runtime],
  );

  const completeMission = useCallback(() => {
    const next = completeQuoteDraftMission(stateRef.current, runtime.now());
    if (next !== stateRef.current) assign(next);
  }, [assign, runtime]);

  const save = useCallback(async (): Promise<boolean> => {
    if (persistenceOperation.current !== null) return false;
    persistenceOperation.current = 'save';
    setPersistenceState({ ready: true, status: 'saving', error: null });
    try {
      // Une transcription peut arriver pendant un PUT. On recommence alors avec le dernier état ;
      // l'adapter sérialise les requêtes et avance la révision CAS après chaque commit réel.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const epoch = mutationEpoch.current;
        const saved = await persistence.save(stateRef.current);
        if (epoch !== mutationEpoch.current) continue;
        assign(saved.state, false);
        publishAuthoritativeReference(saved.reference);
        // Le slot BDD unique porte désormais CETTE session : un ancien brouillon parké
        // (jamais re-sauvegardé depuis) n'existe plus nulle part — le proposer resterait fantôme.
        setPendingResume(null);
        setPersistenceState({ ready: true, status: 'ready', error: null });
        return true;
      }
      setPersistenceState({ ready: true, status: 'error', error: 'save' });
      return false;
    } catch (error: unknown) {
      setPersistenceState({
        ready: true,
        status: 'error',
        error: isQuoteDraftRevisionConflict(error) ? 'conflict' : 'save',
      });
      return false;
    } finally {
      persistenceOperation.current = null;
    }
  }, [assign, persistence, publishAuthoritativeReference]);

  const discard = useCallback(async (): Promise<boolean> => {
    if (persistenceOperation.current !== null) return false;
    persistenceOperation.current = 'clear';
    setPersistenceState({ ready: true, status: 'clearing', error: null });
    try {
      await persistence.clear();
      assign(discardQuoteDraft(stateRef.current, runtime.newId('session')));
      publishAuthoritativeReference(null);
      // Le slot BDD unique est vidé : un brouillon parké n'y survit pas non plus.
      setPendingResume(null);
      setPersistenceState({ ready: true, status: 'ready', error: null });
      return true;
    } catch (error: unknown) {
      setPersistenceState({
        ready: true,
        status: 'error',
        error: isQuoteDraftRevisionConflict(error) ? 'conflict' : 'clear',
      });
      return false;
    } finally {
      persistenceOperation.current = null;
    }
  }, [assign, persistence, publishAuthoritativeReference, runtime]);

  const complete = useCallback(
    async (artifactId: string): Promise<boolean> => {
      if (persistenceOperation.current !== null) return false;
      const result = completeQuoteDraft(stateRef.current, {
        artifactId,
        newSessionId: runtime.newId('session'),
      });
      if (!result.didReset) return true;
      persistenceOperation.current = 'complete';
      setPersistenceState({ ready: true, status: 'clearing', error: null });
      try {
        await persistence.clear();
        assign(result.state);
        publishAuthoritativeReference(null);
        setPendingResume(null);
        setPersistenceState({ ready: true, status: 'ready', error: null });
        return true;
      } catch (error: unknown) {
        setPersistenceState({
          ready: true,
          status: 'error',
          error: isQuoteDraftRevisionConflict(error) ? 'conflict' : 'clear',
        });
        return false;
      } finally {
        persistenceOperation.current = null;
      }
    },
    [assign, persistence, publishAuthoritativeReference, runtime],
  );

  const reset = discard;

  const startFresh = useCallback(() => {
    const current = stateRef.current;
    // Ne parque que si le brouillon courant est réellement enregistré (résiste à un redémarrage)
    // ET significatif — une session déjà vierge n'a rien à proposer, ce serait un faux positif.
    if (current.saved !== null && hasMeaningfulQuoteDraft(current)) {
      setPendingResume(current);
    }
    assign(createQuoteDraft(runtime.newId('session')));
    publishAuthoritativeReference(null);
  }, [assign, publishAuthoritativeReference, runtime]);

  const resumePending = useCallback(() => {
    if (pendingResume === null) return;
    assign(pendingResume);
    publishAuthoritativeReference(null);
    setPendingResume(null);
  }, [assign, pendingResume, publishAuthoritativeReference]);

  const hydrateMissionDraft = useCallback(
    async (
      expected: QuoteDraftAuthoritativeReference,
    ): Promise<QuoteDraftMissionHydrationResult> => {
      if (persistenceOperation.current !== null) return { status: 'busy' };
      persistenceOperation.current = 'mission_hydrate';
      const epochAtStart = mutationEpoch.current;
      let rejection: Exclude<
        QuoteDraftMissionHydrationResult['status'],
        'ready' | 'busy' | 'unavailable'
      > = 'stale';
      try {
        const refreshed = await persistence.refresh((observed) => {
          if (mutationEpoch.current !== epochAtStart) {
            rejection = 'superseded';
            return false;
          }
          if (observed === null) {
            rejection = 'not_found';
            return false;
          }
          const reference = observed.reference;
          if (
            reference.sessionId !== expected.sessionId
            || reference.slotRevision !== expected.slotRevision
            || reference.contentRevision !== expected.contentRevision
          ) {
            rejection = 'stale';
            return false;
          }
          if (hasUnsavedQuoteDraftChanges(stateRef.current)) {
            rejection = 'local_changes';
            return false;
          }
          // L'assignation et l'adoption CAS sont dans la même section sérialisée du store.
          assign(observed.state, false);
          publishAuthoritativeReference(reference);
          return true;
        });
        if (refreshed.status !== 'adopted' || refreshed.observation === null) {
          return { status: rejection };
        }
        return {
          status: 'ready',
          reference: refreshed.observation.reference,
        };
      } catch {
        return { status: 'unavailable' };
      } finally {
        persistenceOperation.current = null;
      }
    },
    [assign, persistence, publishAuthoritativeReference],
  );

  const value = useMemo<QuoteDraftContextValue>(
    () => ({
      state,
      authoritativeReference,
      pendingResume,
      guidance: deriveQuoteDraftGuidance(state),
      persistence: persistenceState,
      apply,
      applyAtRevision,
      applyAll,
      selectCustomer: selectCustomerAction,
      addLine: addLineAction,
      addCatalogueLine: addCatalogueLineAction,
      updateLine: updateLineAction,
      updateLineForm: updateLineFormAction,
      clearLineForm: clearLineFormAction,
      propose,
      acceptProposal,
      rejectProposal,
      expireProposal,
      startMission,
      stopMission,
      completeMission,
      save,
      discard,
      complete,
      reset,
      startFresh,
      resumePending,
      hydrateMissionDraft,
    }),
    [
      acceptProposal,
      addCatalogueLineAction,
      addLineAction,
      apply,
      applyAtRevision,
      applyAll,
      clearLineFormAction,
      complete,
      completeMission,
      authoritativeReference,
      pendingResume,
      hydrateMissionDraft,
      resumePending,
      startFresh,
      discard,
      expireProposal,
      persistenceState,
      propose,
      rejectProposal,
      reset,
      save,
      selectCustomerAction,
      startMission,
      state,
      stopMission,
      updateLineFormAction,
      updateLineAction,
    ],
  );

  if (!persistenceState.ready && persistenceState.error === 'load') {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          paddingHorizontal: 24,
          backgroundColor: colors.bg,
        }}
      >
        <ErrorRetry
          message={t('devis.draftLoad.error', { personality })}
          onRetry={() => setHydrationAttempt((attempt) => attempt + 1)}
        />
      </View>
    );
  }

  if (!persistenceState.ready) {
    return (
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={t('devis.draftLoad.loading', { personality })}
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.bg,
        }}
      >
        <ActivityIndicator color={colors.ink800} />
      </View>
    );
  }

  return <QuoteDraftContext.Provider value={value}>{children}</QuoteDraftContext.Provider>;
}

export function useQuoteDraft(): QuoteDraftContextValue {
  const value = useContext(QuoteDraftContext);
  if (value === null) throw new Error('useQuoteDraft doit être utilisé dans QuoteDraftProvider');
  return value;
}
