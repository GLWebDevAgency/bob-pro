import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BobClient, QuoteDraftSlotView } from '@bob/api-client';
import {
  clearBeforeSignOutCleanupsForTests,
} from '../data/session-cleanup';
import {
  createQuoteDraft,
  type QuoteDraftState,
} from './quote-draft-model';
import {
  QuoteDraftProvider,
  useQuoteDraft,
  type QuoteDraftContextValue,
  type QuoteDraftProviderRuntime,
} from './quote-draft-provider';
import {
  type QuoteDraftAuthoritativeReference,
  type QuoteDraftRemoteObservation,
  type QuoteDraftRemotePersistence,
} from './quote-draft-remote-store';
import {
  decodeQuoteDraftServerSlot,
  encodeQuoteDraftServerPayload,
} from './quote-draft-server-codec';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  client: { companyId: 'company-1' } as BobClient,
}));

vi.mock('../data/auth', () => ({
  useAuth: () => ({
    enabled: true,
    session: {
      user: {
        id: 'user-1',
        app_metadata: { company_id: 'company-1' },
      },
    },
  }),
}));
vi.mock('../data/client', () => ({
  useBobClient: () => mocks.client,
}));
vi.mock('../theme', () => ({
  useTheme: () => ({
    colors: { bg: '#fff', ink800: '#111' },
    personality: 'pro',
  }),
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  View: 'View',
}));
vi.mock('@bob/ui', () => ({
  ErrorRetry: 'ErrorRetry',
}));

function slot(
  sessionId: string,
  slotRevision: number,
  state: QuoteDraftState = createQuoteDraft(sessionId),
): QuoteDraftSlotView {
  return {
    revision: slotRevision,
    payloadVersion: 1,
    payload: encodeQuoteDraftServerPayload(state),
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:01.000Z',
  };
}

function observe(value: QuoteDraftSlotView): QuoteDraftRemoteObservation {
  const state = decodeQuoteDraftServerSlot(value);
  return {
    state,
    reference: {
      sessionId: state.sessionId,
      slotRevision: value.revision,
      contentRevision: state.revision,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function persistenceHarness(
  initial: QuoteDraftRemoteObservation | null,
): {
  readonly persistence: QuoteDraftRemotePersistence;
  setRefresh: (
    refresh: (
      accept: (observation: QuoteDraftRemoteObservation | null) => boolean,
    ) => ReturnType<QuoteDraftRemotePersistence['refresh']>,
  ) => void;
} {
  let refreshImpl: (
    accept: (observation: QuoteDraftRemoteObservation | null) => boolean,
  ) => ReturnType<QuoteDraftRemotePersistence['refresh']> = async (accept) => (
    accept(initial)
      ? { status: 'adopted', observation: initial }
      : { status: 'rejected', observation: initial }
  );
  return {
    persistence: {
      load: vi.fn(async () => initial),
      refresh: (accept) => refreshImpl(accept),
      save: vi.fn(async () => {
        throw new Error('unused_save');
      }),
      clear: vi.fn(async () => undefined),
      dispose: vi.fn(),
    },
    setRefresh: (refresh) => {
      refreshImpl = refresh;
    },
  };
}

const runtime: QuoteDraftProviderRuntime = {
  now: () => Date.parse('2026-07-29T00:00:00.000Z'),
  newId: (kind) => `${kind}-generated`,
};

async function mount(
  persistence: QuoteDraftRemotePersistence,
): Promise<{
  readonly current: () => QuoteDraftContextValue;
  readonly renderer: ReactTestRenderer;
}> {
  let value: QuoteDraftContextValue | null = null;
  function Probe() {
    const current = useQuoteDraft();
    useEffect(() => {
      value = current;
    }, [current]);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QuoteDraftProvider
        runtime={runtime}
        createPersistence={() => persistence}
      >
        <Probe />
      </QuoteDraftProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    current: () => {
      if (value === null) throw new Error('QuoteDraftContext non publié');
      return value;
    },
    renderer,
  };
}

describe('QuoteDraftProvider — hydratation de mission atomique', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    clearBeforeSignOutCleanupsForTests();
  });

  it('adopte uniquement le triplet serveur exact et le publie comme autorité', async () => {
    const initial = observe(slot('initial-session', 2));
    const mission = observe(slot('mission-session', 7));
    const h = persistenceHarness(initial);
    h.setRefresh(async (accept) => (
      accept(mission)
        ? { status: 'adopted', observation: mission }
        : { status: 'rejected', observation: mission }
    ));
    const mounted = await mount(h.persistence);
    renderer = mounted.renderer;

    let result!: Awaited<ReturnType<QuoteDraftContextValue['hydrateMissionDraft']>>;
    await act(async () => {
      result = await mounted.current().hydrateMissionDraft(mission.reference);
    });

    expect(result).toEqual({ status: 'ready', reference: mission.reference });
    expect(mounted.current().state.sessionId).toBe('mission-session');
    expect(mounted.current().authoritativeReference).toEqual(mission.reference);
  });

  it('refuse un slot différent sans modifier l’état rendu', async () => {
    const initial = observe(slot('initial-session', 2));
    const mission = observe(slot('other-session', 8));
    const h = persistenceHarness(initial);
    h.setRefresh(async (accept) => (
      accept(mission)
        ? { status: 'adopted', observation: mission }
        : { status: 'rejected', observation: mission }
    ));
    const mounted = await mount(h.persistence);
    renderer = mounted.renderer;
    const expected: QuoteDraftAuthoritativeReference = {
      sessionId: 'mission-session',
      slotRevision: 7,
      contentRevision: 0,
    };

    let result!: Awaited<ReturnType<QuoteDraftContextValue['hydrateMissionDraft']>>;
    await act(async () => {
      result = await mounted.current().hydrateMissionDraft(expected);
    });

    expect(result).toEqual({ status: 'stale' });
    expect(mounted.current().state.sessionId).toBe('initial-session');
    expect(mounted.current().authoritativeReference).toEqual(initial.reference);
  });

  it('préserve une saisie apparue pendant le GET et invalide son ancienne autorité', async () => {
    const initial = observe(slot('initial-session', 2));
    const mission = observe(slot('mission-session', 7));
    const gate = deferred<void>();
    const h = persistenceHarness(initial);
    h.setRefresh(async (accept) => {
      await gate.promise;
      return accept(mission)
        ? { status: 'adopted', observation: mission }
        : { status: 'rejected', observation: mission };
    });
    const mounted = await mount(h.persistence);
    renderer = mounted.renderer;

    let hydration!: Promise<
      Awaited<ReturnType<QuoteDraftContextValue['hydrateMissionDraft']>>
    >;
    await act(async () => {
      hydration = mounted.current().hydrateMissionDraft(mission.reference);
      await Promise.resolve();
    });
    await act(async () => {
      mounted.current().apply({
        type: 'select_customer',
        customer: { id: 'customer-1', name: 'Camping Les Pins' },
      });
    });
    gate.resolve();
    let result!: Awaited<typeof hydration>;
    await act(async () => {
      result = await hydration;
    });

    expect(result).toEqual({ status: 'superseded' });
    expect(mounted.current().state.flow.draft.customerId).toBe('customer-1');
    expect(mounted.current().authoritativeReference).toBeNull();
  });

  it('refuse une saisie locale déjà présente au lieu de l’écraser', async () => {
    const initial = observe(slot('initial-session', 2));
    const mission = observe(slot('mission-session', 7));
    const h = persistenceHarness(initial);
    h.setRefresh(async (accept) => (
      accept(mission)
        ? { status: 'adopted', observation: mission }
        : { status: 'rejected', observation: mission }
    ));
    const mounted = await mount(h.persistence);
    renderer = mounted.renderer;
    await act(async () => {
      mounted.current().apply({
        type: 'select_customer',
        customer: { id: 'customer-1', name: 'Camping Les Pins' },
      });
    });

    let result!: Awaited<ReturnType<QuoteDraftContextValue['hydrateMissionDraft']>>;
    await act(async () => {
      result = await mounted.current().hydrateMissionDraft(mission.reference);
    });

    expect(result).toEqual({ status: 'local_changes' });
    expect(mounted.current().state.flow.draft.customerId).toBe('customer-1');
  });
});
