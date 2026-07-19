import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

import type {
  MistralConversationCheckpointOwnerFence,
  MistralConversationCheckpointStore,
  MistralConversationCheckpointIdentity,
} from './mistral-conversation-checkpoint-store';

const mocks = vi.hoisted(() => ({
  session: null as null | {
    readonly user: {
      readonly id: string;
      readonly app_metadata: { readonly company_id: string };
    };
  },
  client: {} as object,
  recover: vi.fn(),
  createStore: vi.fn(),
  appStateListeners: new Set<(state: string) => void>(),
}));

vi.mock('../data/auth', () => ({
  useAuth: () => ({ enabled: true, session: mocks.session }),
}));
vi.mock('../data/client', () => ({
  useBobClient: () => mocks.client,
}));
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, listener: (state: string) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => mocks.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock('../data/tenant-identity', () => ({
  companyIdFromAppMetadata: (metadata: unknown) => (
    typeof metadata === 'object' && metadata !== null && 'company_id' in metadata
      ? (metadata as { readonly company_id: string }).company_id
      : null
  ),
}));
vi.mock('./mistral-conversation-checkpoint-store', () => ({
  createNativeMistralConversationCheckpointStore: () => mocks.createStore(),
}));
vi.mock('./mistral-conversation-terminal-recovery', () => ({
  recoverMistralConversationTerminalCheckpoint: (...args: unknown[]) => mocks.recover(...args),
}));

import {
  MistralConversationCheckpointProvider,
  useMistralConversationCheckpointBinding,
  useRetryMistralConversationCheckpointRecovery,
} from './mistral-conversation-checkpoint-provider';
import type { MistralConversationCheckpointBinding } from './mistral-conversation-runtime';

function session(subjectId: string, companyId: string) {
  return { user: { id: subjectId, app_metadata: { company_id: companyId } } } as const;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function harness() {
  const log: string[] = [];
  let generation = 0;
  const active = new Set<MistralConversationCheckpointOwnerFence>();
  const store: MistralConversationCheckpointStore = {
    activeOwnerFence: vi.fn(() => [...active][0] ?? null),
    activateOwner: vi.fn((identity: MistralConversationCheckpointIdentity) => {
      const fence = Object.freeze({ identity: Object.freeze({ ...identity }), generation: ++generation });
      active.add(fence);
      log.push(`activate:${identity.subjectId}:${identity.companyId}`);
      return fence;
    }),
    deactivateOwner: vi.fn((fence) => {
      if (!active.delete(fence)) throw new Error('stale_owner');
      log.push(`deactivate:${fence.identity.subjectId}:${fence.identity.companyId}`);
    }),
    purgeForAuthBoundary: vi.fn(async (fence) => {
      log.push(`purge:${fence.identity.subjectId}:${fence.identity.companyId}`);
    }),
    load: vi.fn(async () => null),
    save: vi.fn(async () => { throw new Error('unused'); }),
    clearAfterTerminalComplete: vi.fn(async () => undefined),
    retryInterruptedTerminalClear: vi.fn(async (fence) => {
      log.push(`retry-terminal-clear:${fence.identity.subjectId}:${fence.identity.companyId}`);
    }),
    scrubRequiredCheckpoint: vi.fn(async () => undefined),
  };
  mocks.createStore.mockReturnValue(store);
  mocks.recover.mockImplementation(async (input: {
    readonly fence: MistralConversationCheckpointOwnerFence;
  }) => {
    log.push(`recover:${input.fence.identity.subjectId}:${input.fence.identity.companyId}`);
    return true;
  });
  const observed: Array<MistralConversationCheckpointBinding | null> = [];
  let retryRecovery: (() => void) | null = null;
  function Probe() {
    observed.push(useMistralConversationCheckpointBinding());
    retryRecovery = useRetryMistralConversationCheckpointRecovery();
    return null;
  }
  let renderer: ReactTestRenderer;
  return {
    store,
    log,
    observed,
    retryRecovery: () => retryRecovery,
    render: async () => {
      await act(async () => {
        renderer = create(
          <MistralConversationCheckpointProvider>
            <Probe />
          </MistralConversationCheckpointProvider>,
        );
        await flush();
      });
      return renderer!;
    },
    update: async () => {
      await act(async () => {
        renderer!.update(
          <MistralConversationCheckpointProvider>
            <Probe />
          </MistralConversationCheckpointProvider>,
        );
        await flush();
      });
    },
    unmount: async () => {
      await act(async () => renderer!.unmount());
    },
  };
}

describe('MistralConversationCheckpointProvider', () => {
  beforeEach(() => {
    mocks.session = null;
    mocks.client = {};
    mocks.recover.mockReset();
    mocks.createStore.mockReset();
    mocks.appStateListeners.clear();
  });

  it('n’expose le binding authentifié qu’après la reprise terminale', async () => {
    mocks.session = session('subject-1', 'company-1');
    const h = harness();
    const renderer = await h.render();

    expect(h.observed[0]).toBeNull();
    expect(h.observed.at(-1)?.fence.identity).toEqual({
      subjectId: 'subject-1',
      companyId: 'company-1',
    });
    expect(h.log).toEqual([
      'activate:subject-1:company-1',
      'recover:subject-1:company-1',
    ]);
    await act(async () => renderer.unmount());
  });

  it('masque synchronement l’ancien owner puis purge avant activation du tenant suivant', async () => {
    mocks.session = session('subject-1', 'company-1');
    const h = harness();
    await h.render();
    h.observed.length = 0;

    mocks.session = session('subject-2', 'company-2');
    await h.update();

    expect(h.observed[0]).toBeNull();
    expect(h.observed.at(-1)?.fence.identity).toEqual({
      subjectId: 'subject-2',
      companyId: 'company-2',
    });
    expect(h.log).toEqual([
      'activate:subject-1:company-1',
      'recover:subject-1:company-1',
      'purge:subject-1:company-1',
      'deactivate:subject-1:company-1',
      'activate:subject-2:company-2',
      'recover:subject-2:company-2',
    ]);
    await h.unmount();
  });

  it('purge et invalide au logout sans jamais réexposer le binding', async () => {
    mocks.session = session('subject-1', 'company-1');
    const h = harness();
    await h.render();
    h.observed.length = 0;

    mocks.session = null;
    await h.update();

    expect(h.observed.every((value) => value === null)).toBe(true);
    expect(h.log.slice(-2)).toEqual([
      'purge:subject-1:company-1',
      'deactivate:subject-1:company-1',
    ]);
    await h.unmount();
  });

  it('ne republie jamais une ancienne fence apres logout puis relogin du meme owner', async () => {
    mocks.session = session('subject-1', 'company-1');
    const h = harness();
    await h.render();

    mocks.session = null;
    await h.update();
    h.observed.length = 0;
    mocks.session = session('subject-1', 'company-1');
    await h.update();

    expect(h.observed[0]).toBeNull();
    expect(h.observed.at(-1)?.fence.generation).toBe(2);
    expect(h.log).toEqual([
      'activate:subject-1:company-1',
      'recover:subject-1:company-1',
      'purge:subject-1:company-1',
      'deactivate:subject-1:company-1',
      'activate:subject-1:company-1',
      'recover:subject-1:company-1',
    ]);
    await h.unmount();
  });

  it('reprend et purge la fence du singleton natif apres remount vers un autre tenant', async () => {
    mocks.session = session('subject-1', 'company-1');
    const h = harness();
    await h.render();
    await h.unmount();

    h.observed.length = 0;
    mocks.session = session('subject-2', 'company-2');
    await h.render();

    expect(h.observed[0]).toBeNull();
    expect(h.observed.at(-1)?.fence.identity).toEqual({
      subjectId: 'subject-2',
      companyId: 'company-2',
    });
    expect(h.log.slice(-4)).toEqual([
      'purge:subject-1:company-1',
      'deactivate:subject-1:company-1',
      'activate:subject-2:company-2',
      'recover:subject-2:company-2',
    ]);
    await h.unmount();
  });

  it('n’expose jamais le résultat tardif d’une reprise appartenant à l’ancien compte', async () => {
    let releaseFirst!: () => void;
    mocks.session = session('subject-1', 'company-1');
    const h = harness();
    mocks.recover.mockImplementationOnce(async () => new Promise<boolean>((resolve) => {
      releaseFirst = () => resolve(true);
    }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MistralConversationCheckpointProvider>
          {null}
        </MistralConversationCheckpointProvider>,
      );
      await flush();
    });

    mocks.session = session('subject-2', 'company-2');
    await act(async () => {
      renderer.update(
        <MistralConversationCheckpointProvider>
          {null}
        </MistralConversationCheckpointProvider>,
      );
      releaseFirst();
      await flush();
      await flush();
    });

    expect(h.log).not.toContain('recover:subject-1:company-1');
    expect(h.log.slice(-4)).toEqual([
      'purge:subject-1:company-1',
      'deactivate:subject-1:company-1',
      'activate:subject-2:company-2',
      'recover:subject-2:company-2',
    ]);
    await act(async () => renderer.unmount());
  });

  it('conserve la fence et retente une purge SecureStore transitoirement refusée', async () => {
    vi.useFakeTimers();
    try {
      mocks.session = session('subject-1', 'company-1');
      const h = harness();
      await h.render();
      h.observed.length = 0;
      vi.mocked(h.store.purgeForAuthBoundary).mockImplementationOnce(async (fence) => {
        h.log.push(`purge:${fence.identity.subjectId}:${fence.identity.companyId}`);
        throw new Error('secure_store_unavailable');
      });

      mocks.session = session('subject-2', 'company-2');
      await h.update();

      expect(h.observed.every((value) => value === null)).toBe(true);
      expect(h.log).not.toContain('activate:subject-2:company-2');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await flush();
      });

      expect(h.log.slice(-4)).toEqual([
        'purge:subject-1:company-1',
        'deactivate:subject-1:company-1',
        'activate:subject-2:company-2',
        'recover:subject-2:company-2',
      ]);
      expect(h.observed.at(-1)?.fence.identity).toEqual({
        subjectId: 'subject-2',
        companyId: 'company-2',
      });
      await h.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('achève un clear terminal interrompu avec l’ancienne fence avant un switch de tenant', async () => {
    mocks.session = session('subject-1', 'company-1');
    const h = harness();
    await h.render();
    h.observed.length = 0;
    let terminalClearPending = true;
    vi.mocked(h.store.purgeForAuthBoundary).mockImplementation(async (fence) => {
      h.log.push(`purge:${fence.identity.subjectId}:${fence.identity.companyId}`);
      if (terminalClearPending) {
        throw Object.assign(new Error('terminal_clear_in_progress'), {
          name: 'MistralConversationCheckpointStoreError',
          code: 'terminal_clear_in_progress',
        });
      }
    });
    vi.mocked(h.store.retryInterruptedTerminalClear).mockImplementationOnce(async (fence) => {
      h.log.push(`retry-terminal-clear:${fence.identity.subjectId}:${fence.identity.companyId}`);
      terminalClearPending = false;
    });

    mocks.session = session('subject-2', 'company-2');
    await h.update();

    expect(h.observed[0]).toBeNull();
    expect(h.observed.at(-1)?.fence.identity).toEqual({
      subjectId: 'subject-2',
      companyId: 'company-2',
    });
    expect(h.log).toEqual([
      'activate:subject-1:company-1',
      'recover:subject-1:company-1',
      'purge:subject-1:company-1',
      'retry-terminal-clear:subject-1:company-1',
      'purge:subject-1:company-1',
      'deactivate:subject-1:company-1',
      'activate:subject-2:company-2',
      'recover:subject-2:company-2',
    ]);
    expect(h.store.retryInterruptedTerminalClear).toHaveBeenCalledOnce();
    await h.unmount();
  });

  it('reste fermé si la reprise du clear terminal échoue puis retente avant d’activer le tenant suivant', async () => {
    vi.useFakeTimers();
    try {
      mocks.session = session('subject-1', 'company-1');
      const h = harness();
      await h.render();
      h.observed.length = 0;
      let terminalClearPending = true;
      vi.mocked(h.store.purgeForAuthBoundary).mockImplementation(async (fence) => {
        h.log.push(`purge:${fence.identity.subjectId}:${fence.identity.companyId}`);
        if (terminalClearPending) {
          throw Object.assign(new Error('terminal_clear_in_progress'), {
            name: 'MistralConversationCheckpointStoreError',
            code: 'terminal_clear_in_progress',
          });
        }
      });
      vi.mocked(h.store.retryInterruptedTerminalClear)
        .mockImplementationOnce(async (fence) => {
          h.log.push(`retry-terminal-clear:${fence.identity.subjectId}:${fence.identity.companyId}`);
          throw Object.assign(new Error('delete_verification_failed'), {
            name: 'MistralConversationCheckpointStoreError',
            code: 'delete_verification_failed',
          });
        })
        .mockImplementationOnce(async (fence) => {
          h.log.push(`retry-terminal-clear:${fence.identity.subjectId}:${fence.identity.companyId}`);
          terminalClearPending = false;
        });

      mocks.session = session('subject-2', 'company-2');
      await h.update();

      expect(h.observed.every((value) => value === null)).toBe(true);
      expect(h.log).not.toContain('deactivate:subject-1:company-1');
      expect(h.log).not.toContain('activate:subject-2:company-2');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await flush();
      });

      expect(h.log.slice(-8)).toEqual([
        'purge:subject-1:company-1',
        'retry-terminal-clear:subject-1:company-1',
        'purge:subject-1:company-1',
        'retry-terminal-clear:subject-1:company-1',
        'purge:subject-1:company-1',
        'deactivate:subject-1:company-1',
        'activate:subject-2:company-2',
        'recover:subject-2:company-2',
      ]);
      expect(h.observed.at(-1)?.fence.identity).toEqual({
        subjectId: 'subject-2',
        companyId: 'company-2',
      });
      expect(h.store.retryInterruptedTerminalClear).toHaveBeenCalledTimes(2);
      await h.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rearme un cycle borne au retour foreground apres une panne de demarrage', async () => {
    vi.useFakeTimers();
    try {
      mocks.session = session('subject-1', 'company-1');
      const h = harness();
      mocks.recover.mockResolvedValue(false);
      await h.render();

      for (let attempt = 1; attempt < 8; attempt += 1) {
        await act(async () => {
          await vi.runOnlyPendingTimersAsync();
          await flush();
        });
      }
      expect(mocks.recover).toHaveBeenCalledTimes(8);
      expect(h.observed.at(-1)).toBeNull();

      mocks.recover.mockResolvedValue(true);
      await act(async () => {
        for (const listener of [...mocks.appStateListeners]) listener('active');
        await flush();
      });

      expect(mocks.recover).toHaveBeenCalledTimes(9);
      expect(h.observed.at(-1)?.fence.identity).toEqual({
        subjectId: 'subject-1',
        companyId: 'company-1',
      });
      await h.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('expose un retry manuel sans publier le binding avant sa reussite', async () => {
    vi.useFakeTimers();
    try {
      mocks.session = session('subject-1', 'company-1');
      const h = harness();
      mocks.recover.mockResolvedValue(false);
      await h.render();
      expect(h.retryRecovery()).not.toBeNull();
      expect(h.observed.at(-1)).toBeNull();

      mocks.recover.mockResolvedValue(true);
      await act(async () => {
        h.retryRecovery()?.();
        await flush();
      });

      expect(h.observed.at(-1)?.fence.identity).toEqual({
        subjectId: 'subject-1',
        companyId: 'company-1',
      });
      await h.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
