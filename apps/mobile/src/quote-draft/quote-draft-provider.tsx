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
import type { QuoteDraftStorageIdentity } from './quote-draft-codec';
import { createSecureQuoteDraftPersistence } from './quote-draft-secure-store';
import type { QuoteDraftPersistence } from './quote-draft-store';

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
  readonly guidance: QuoteDraftGuidance | null;
  readonly persistence: {
    readonly ready: boolean;
    readonly status: 'hydrating' | 'ready' | 'saving' | 'clearing' | 'error';
    readonly error: 'load' | 'save' | 'clear' | null;
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
  /** `true` signifie que le pointeur chiffré a réellement été committé sur le device. */
  readonly save: () => Promise<boolean>;
  /** N'efface la mémoire qu'après suppression durable du snapshot. */
  readonly discard: () => Promise<boolean>;
  /** Fence pièce + purge durable ; un échec laisse le brouillon récupérable pour retry. */
  readonly complete: (artifactId: string) => Promise<boolean>;
  readonly reset: () => Promise<boolean>;
}

const QuoteDraftContext = createContext<QuoteDraftContextValue | null>(null);

const DEFAULT_PERSISTENCE = createSecureQuoteDraftPersistence();

interface QuoteDraftProviderProps {
  readonly children: ReactNode;
  readonly initialState?: QuoteDraftState;
  readonly runtime?: QuoteDraftProviderRuntime;
  /** Ports injectables pour tests/intégration ; la production dérive toujours la vraie identité. */
  readonly persistence?: QuoteDraftPersistence;
  readonly identity?: QuoteDraftStorageIdentity;
}

export function QuoteDraftProvider({
  children,
  initialState,
  runtime = DEFAULT_RUNTIME,
  persistence = DEFAULT_PERSISTENCE,
  identity: injectedIdentity,
}: QuoteDraftProviderProps) {
  const { enabled, session } = useAuth();
  const client = useBobClient();
  const injectedMode = injectedIdentity?.mode;
  const injectedUserId = injectedIdentity?.userId;
  const injectedCompanyId = injectedIdentity?.companyId;
  const authenticatedUserId = session?.user.id ?? null;
  const authenticatedCompanyId = companyIdFromAppMetadata(session?.user.app_metadata);
  const identity = useMemo<QuoteDraftStorageIdentity>(() => {
    if (
      injectedMode !== undefined &&
      injectedUserId !== undefined &&
      injectedCompanyId !== undefined
    ) {
      return { mode: injectedMode, userId: injectedUserId, companyId: injectedCompanyId };
    }
    if (!enabled) {
      return { mode: 'demo', userId: 'local-demo-user', companyId: client.companyId };
    }
    if (authenticatedUserId === null || authenticatedCompanyId === null) {
      // AuthGate ne monte pas ce provider dans ce cas. Ce throw empêche néanmoins qu'une future
      // composition fasse retomber un brouillon authentifié dans un namespace public.
      throw new Error('QuoteDraftProvider: identité authentifiée incomplète');
    }
    return {
      mode: 'authenticated',
      userId: authenticatedUserId,
      companyId: authenticatedCompanyId,
    };
    // Les valeurs scalaires rendent l'identité stable pendant un refresh JWT. Une nouvelle
    // instance `Session` portant le même compte ne doit surtout pas relancer l'hydratation.
  }, [
    authenticatedCompanyId,
    authenticatedUserId,
    client.companyId,
    enabled,
    injectedCompanyId,
    injectedMode,
    injectedUserId,
  ]);
  const identityKey = JSON.stringify([identity.mode, identity.userId, identity.companyId]);

  // La key React est une fence synchrone : aucun rendu du compte B ne peut exposer une frame du
  // brouillon du compte A pendant que les effets d'identité se mettent à jour.
  return (
    <QuoteDraftSessionProvider
      key={identityKey}
      identity={identity}
      initialState={initialState}
      persistence={persistence}
      runtime={runtime}
    >
      {children}
    </QuoteDraftSessionProvider>
  );
}

function QuoteDraftSessionProvider({
  children,
  identity,
  initialState,
  persistence,
  runtime,
}: {
  readonly children: ReactNode;
  readonly identity: QuoteDraftStorageIdentity;
  readonly initialState?: QuoteDraftState;
  readonly persistence: QuoteDraftPersistence;
  readonly runtime: QuoteDraftProviderRuntime;
}) {
  const { colors } = useTheme();
  const [state, setState] = useState<QuoteDraftState>(
    () => initialState ?? createQuoteDraft(runtime.newId('session')),
  );
  const [persistenceState, setPersistenceState] = useState<QuoteDraftContextValue['persistence']>(
    () =>
      initialState === undefined
        ? { ready: false, status: 'hydrating', error: null }
        : { ready: true, status: 'ready', error: null },
  );
  // Fence synchrone : tap et transcript reçus dans le même tick sont sérialisés sur le dernier état.
  const stateRef = useRef(state);
  stateRef.current = state;
  const mutationEpoch = useRef(0);
  const persistenceOperation = useRef<'save' | 'clear' | 'complete' | null>(null);

  useEffect(() => {
    if (initialState !== undefined) return;
    let active = true;
    const epochAtStart = mutationEpoch.current;
    void persistence
      .load(identity)
      .then((hydrated) => {
        if (!active) return;
        // Double fence : les enfants ne sont pas encore montés, et une future évolution qui les
        // monterait ne pourra toujours pas écraser une saisie arrivée pendant l'I/O.
        if (hydrated !== null && mutationEpoch.current === epochAtStart) {
          stateRef.current = hydrated;
          setState(hydrated);
        }
        setPersistenceState({ ready: true, status: 'ready', error: null });
      })
      .catch(() => {
        if (!active) return;
        // Pas de crash et surtout aucun fallback en clair : le devis reste utilisable en mémoire.
        setPersistenceState({ ready: true, status: 'error', error: 'load' });
      });
    return () => {
      active = false;
    };
  }, [identity, initialState, persistence]);

  useEffect(
    () => registerBeforeSignOutCleanup(() => persistence.clear(identity)),
    [identity, persistence],
  );

  const assign = useCallback((next: QuoteDraftState, isMutation = true): void => {
    if (isMutation) mutationEpoch.current += 1;
    stateRef.current = next;
    setState(next);
  }, []);

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
      // Une transcription peut arriver pendant un write SecureStore. On recommence alors avec le
      // dernier état au lieu de quitter sur une version déjà dépassée.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const epoch = mutationEpoch.current;
        const saved = await persistence.save(identity, stateRef.current, runtime.now());
        if (epoch !== mutationEpoch.current) continue;
        assign(saved, false);
        setPersistenceState({ ready: true, status: 'ready', error: null });
        return true;
      }
      setPersistenceState({ ready: true, status: 'error', error: 'save' });
      return false;
    } catch {
      setPersistenceState({ ready: true, status: 'error', error: 'save' });
      return false;
    } finally {
      persistenceOperation.current = null;
    }
  }, [assign, identity, persistence, runtime]);

  const discard = useCallback(async (): Promise<boolean> => {
    if (persistenceOperation.current !== null) return false;
    persistenceOperation.current = 'clear';
    setPersistenceState({ ready: true, status: 'clearing', error: null });
    try {
      await persistence.clear(identity);
      assign(discardQuoteDraft(stateRef.current, runtime.newId('session')));
      setPersistenceState({ ready: true, status: 'ready', error: null });
      return true;
    } catch {
      setPersistenceState({ ready: true, status: 'error', error: 'clear' });
      return false;
    } finally {
      persistenceOperation.current = null;
    }
  }, [assign, identity, persistence, runtime]);

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
        await persistence.clear(identity);
        assign(result.state);
        setPersistenceState({ ready: true, status: 'ready', error: null });
        return true;
      } catch {
        setPersistenceState({ ready: true, status: 'error', error: 'clear' });
        return false;
      } finally {
        persistenceOperation.current = null;
      }
    },
    [assign, identity, persistence, runtime],
  );

  const reset = discard;

  const value = useMemo<QuoteDraftContextValue>(
    () => ({
      state,
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

  if (!persistenceState.ready) {
    return (
      <View
        accessibilityRole="progressbar"
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
