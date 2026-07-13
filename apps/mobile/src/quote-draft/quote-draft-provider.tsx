import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LineInput } from '@bob/core';
import {
  acceptQuoteDraftProposal,
  addCatalogueLine,
  addLine,
  applyQuoteDraftCommand,
  completeQuoteDraftMission,
  createQuoteDraft,
  deriveQuoteDraftGuidance,
  expireQuoteDraftProposal,
  proposeQuoteDraft,
  rejectQuoteDraftProposal,
  selectCustomer,
  startQuoteDraftMission,
  stopQuoteDraftMission,
  updateLine,
  type AddQuoteDraftLineInput,
  type ProposeQuoteDraftInput,
  type QuoteDraftCommand,
  type QuoteDraftCustomer,
  type QuoteDraftGuidance,
  type QuoteDraftMissionStopReason,
  type QuoteDraftResult,
  type QuoteDraftState,
} from './quote-draft-model';
import type { CataloguePrestation } from '@bob/core';

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
  readonly apply: (command: QuoteDraftCommand) => QuoteDraftResult<QuoteDraftState>;
  readonly selectCustomer: (customer: QuoteDraftCustomer) => QuoteDraftResult<QuoteDraftState>;
  readonly addLine: (input: Omit<AddQuoteDraftLineInput, 'lineId'> & { readonly lineId?: string }) => QuoteDraftResult<QuoteDraftState>;
  readonly addCatalogueLine: (input: {
    readonly prestation: CataloguePrestation;
    readonly qty: number;
    readonly interaction: AddQuoteDraftLineInput['interaction'];
    readonly lineId?: string;
  }) => QuoteDraftResult<QuoteDraftState>;
  readonly updateLine: (lineId: string, patch: Partial<LineInput>) => QuoteDraftResult<QuoteDraftState>;
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
  readonly reset: () => void;
}

const QuoteDraftContext = createContext<QuoteDraftContextValue | null>(null);

export function QuoteDraftProvider({
  children,
  initialState,
  runtime = DEFAULT_RUNTIME,
}: {
  readonly children: ReactNode;
  readonly initialState?: QuoteDraftState;
  readonly runtime?: QuoteDraftProviderRuntime;
}) {
  const [state, setState] = useState<QuoteDraftState>(
    () => initialState ?? createQuoteDraft(runtime.newId('session')),
  );
  // Fence synchrone : tap et transcript reçus dans le même tick sont sérialisés sur le dernier état.
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((result: QuoteDraftResult<QuoteDraftState>): QuoteDraftResult<QuoteDraftState> => {
    if (result.ok) {
      stateRef.current = result.value;
      setState(result.value);
    }
    return result;
  }, []);

  const apply = useCallback(
    (command: QuoteDraftCommand) => commit(applyQuoteDraftCommand(stateRef.current, command, runtime.now())),
    [commit, runtime],
  );

  const selectCustomerAction = useCallback(
    (customer: QuoteDraftCustomer) => commit(selectCustomer(stateRef.current, customer, runtime.now())),
    [commit, runtime],
  );

  const addLineAction = useCallback(
    (input: Omit<AddQuoteDraftLineInput, 'lineId'> & { readonly lineId?: string }) =>
      commit(addLine(
        stateRef.current,
        { ...input, lineId: input.lineId ?? runtime.newId('line') },
        runtime.now(),
      )),
    [commit, runtime],
  );

  const addCatalogueLineAction = useCallback(
    (input: {
      readonly prestation: CataloguePrestation;
      readonly qty: number;
      readonly interaction: AddQuoteDraftLineInput['interaction'];
      readonly lineId?: string;
    }) => commit(addCatalogueLine(
      stateRef.current,
      { ...input, lineId: input.lineId ?? runtime.newId('line') },
      runtime.now(),
    )),
    [commit, runtime],
  );

  const updateLineAction = useCallback(
    (lineId: string, patch: Partial<LineInput>) =>
      commit(updateLine(stateRef.current, lineId, patch, runtime.now())),
    [commit, runtime],
  );

  const propose = useCallback(
    (
      input: Omit<ProposeQuoteDraftInput, 'id' | 'createdAt' | 'expiresAt'> & {
        readonly id?: string;
        readonly ttlMs?: number;
      },
    ) => {
      const createdAt = runtime.now();
      const ttlMs = input.ttlMs ?? 2 * 60_000;
      return commit(proposeQuoteDraft(stateRef.current, {
        ...input,
        id: input.id ?? runtime.newId('proposal'),
        createdAt,
        expiresAt: createdAt + ttlMs,
      }));
    },
    [commit, runtime],
  );

  const acceptProposal = useCallback(
    (proposalId: string) => commit(acceptQuoteDraftProposal(stateRef.current, proposalId, runtime.now())),
    [commit, runtime],
  );

  const rejectProposal = useCallback(
    (proposalId: string) => commit(rejectQuoteDraftProposal(stateRef.current, proposalId, runtime.now())),
    [commit, runtime],
  );

  const expireProposal = useCallback(() => {
    const next = expireQuoteDraftProposal(stateRef.current, runtime.now());
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, [runtime]);

  const startMission = useCallback(
    (input: { readonly mode: 'manual' | 'guided_voice'; readonly startedFrom: string; readonly id?: string }) =>
      commit(startQuoteDraftMission(stateRef.current, {
        id: input.id ?? runtime.newId('mission'),
        mode: input.mode,
        startedFrom: input.startedFrom,
        startedAt: runtime.now(),
      })),
    [commit, runtime],
  );

  const stopMission = useCallback((reason: QuoteDraftMissionStopReason) => {
    const next = stopQuoteDraftMission(stateRef.current, { reason, stoppedAt: runtime.now() });
    stateRef.current = next;
    setState(next);
  }, [runtime]);

  const completeMission = useCallback(() => {
    const next = completeQuoteDraftMission(stateRef.current, runtime.now());
    stateRef.current = next;
    setState(next);
  }, [runtime]);

  const reset = useCallback(() => {
    const next = createQuoteDraft(runtime.newId('session'));
    stateRef.current = next;
    setState(next);
  }, [runtime]);

  const value = useMemo<QuoteDraftContextValue>(() => ({
    state,
    guidance: deriveQuoteDraftGuidance(state),
    apply,
    selectCustomer: selectCustomerAction,
    addLine: addLineAction,
    addCatalogueLine: addCatalogueLineAction,
    updateLine: updateLineAction,
    propose,
    acceptProposal,
    rejectProposal,
    expireProposal,
    startMission,
    stopMission,
    completeMission,
    reset,
  }), [
    acceptProposal,
    addCatalogueLineAction,
    addLineAction,
    apply,
    completeMission,
    expireProposal,
    propose,
    rejectProposal,
    reset,
    selectCustomerAction,
    startMission,
    state,
    stopMission,
    updateLineAction,
  ]);

  return <QuoteDraftContext.Provider value={value}>{children}</QuoteDraftContext.Provider>;
}

export function useQuoteDraft(): QuoteDraftContextValue {
  const value = useContext(QuoteDraftContext);
  if (value === null) throw new Error('useQuoteDraft doit être utilisé dans QuoteDraftProvider');
  return value;
}
