import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  operations: [] as string[],
  isAvailableAsync: vi.fn(async () => true),
  getItemAsync: vi.fn(async (key: string, _options?: unknown) => {
    native.operations.push(`get:${key}`);
    return native.values.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string, _options?: unknown) => {
    native.operations.push(`set:${key}`);
    native.values.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string, _options?: unknown) => {
    native.operations.push(`delete:${key}`);
    native.values.delete(key);
  }),
}));

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  isAvailableAsync: native.isAvailableAsync,
  getItemAsync: native.getItemAsync,
  setItemAsync: native.setItemAsync,
  deleteItemAsync: native.deleteItemAsync,
}));

import {
  MISTRAL_CONVERSATION_CHECKPOINT_KEYCHAIN_SERVICE,
  MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES,
  MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
  MISTRAL_CONVERSATION_CHECKPOINT_VERSION,
  MistralConversationCheckpointStoreError,
  createMistralConversationCheckpointCoordinatorForTesting,
  createMistralConversationCheckpointStoreForTesting as createCheckpointStoreWithCoordinator,
  createNativeMistralConversationCheckpointStore,
  type MistralConversationCheckpointIdentity,
  type MistralConversationCheckpointCoordinator,
  type MistralConversationCheckpointStoreDependencies,
  type MistralConversationTerminalCompleteProof,
  type MistralConversationTerminalCheckpointState,
} from './mistral-conversation-checkpoint-store';

const OWNER_A = { subjectId: 'subject-a', companyId: 'company-a' } as const;
const OWNER_B = { subjectId: 'subject-b', companyId: 'company-b' } as const;
const SESSION_A = '00000000-0000-4000-8000-000000000101';
const SESSION_B = '00000000-0000-4000-8000-000000000102';
const MISSION_EXPIRES_AT = '2026-07-19T15:30:00.000Z';

interface TestDependencies {
  readonly dependencies: MistralConversationCheckpointStoreDependencies;
  readonly values: Map<string, string>;
  readonly operations: string[];
  readonly isAvailable: ReturnType<typeof vi.fn>;
  readonly getItem: ReturnType<typeof vi.fn>;
  readonly setItem: ReturnType<typeof vi.fn>;
  readonly deleteItem: ReturnType<typeof vi.fn>;
}

function createMistralConversationCheckpointStoreForTesting(
  dependencies: MistralConversationCheckpointStoreDependencies,
  coordinator: MistralConversationCheckpointCoordinator =
    createMistralConversationCheckpointCoordinatorForTesting(),
) {
  return createCheckpointStoreWithCoordinator(dependencies, coordinator);
}

function createDependencies(input: {
  readonly available?: boolean;
  readonly getItem?: (key: string) => Promise<string | null>;
  readonly setItem?: (key: string, value: string) => Promise<void>;
  readonly deleteItem?: (key: string) => Promise<void>;
} = {}): TestDependencies {
  const values = new Map<string, string>();
  const operations: string[] = [];
  const isAvailable = vi.fn(async () => input.available ?? true);
  const getItem = vi.fn(input.getItem ?? (async (key: string) => {
    operations.push(`get:${key}`);
    return values.get(key) ?? null;
  }));
  const setItem = vi.fn(input.setItem ?? (async (key: string, value: string) => {
    operations.push(`set:${key}`);
    values.set(key, value);
  }));
  const deleteItem = vi.fn(input.deleteItem ?? (async (key: string) => {
    operations.push(`delete:${key}`);
    values.delete(key);
  }));
  return {
    dependencies: {
      secureStore: { isAvailable, getItem, setItem, deleteItem },
      keychainAccessible: 42,
    },
    values,
    operations,
    isAvailable,
    getItem,
    setItem,
    deleteItem,
  };
}

function state(input: {
  readonly sessionHandle?: string;
  readonly nextServerSequence?: number;
  readonly missionConnectionEpoch?: number;
  readonly phase?: 'draining' | 'closed';
  readonly reason?: 'user' | 'background' | 'expired' | 'fatal_error';
  readonly missionExpiresAt?: string;
} = {}): MistralConversationTerminalCheckpointState {
  const phase = input.phase ?? 'draining';
  const sessionHandle = input.sessionHandle ?? SESSION_A;
  const nextServerSequence = input.nextServerSequence ?? (phase === 'closed' ? 3 : 2);
  return {
    sessionHandle,
    missionExpiresAt: input.missionExpiresAt ?? MISSION_EXPIRES_AT,
    stream: {
      nextServerSequence,
      sessionReadyAccepted: true,
      sessionHandle,
      missionConnectionEpoch: input.missionConnectionEpoch ?? 1,
      ...(phase === 'closed' ? { closed: true } : {}),
    },
    projection: { phase, reason: input.reason ?? 'user' },
  };
}

function terminalCompleteProof(
  identity: MistralConversationCheckpointIdentity = OWNER_A,
  checkpointState: MistralConversationTerminalCheckpointState = state({ phase: 'closed' }),
): MistralConversationTerminalCompleteProof {
  return {
    kind: 'terminal_complete',
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    ...identity,
    sessionHandle: checkpointState.sessionHandle,
    missionConnectionEpoch: checkpointState.stream.missionConnectionEpoch,
    nextServerSequence: checkpointState.stream.nextServerSequence,
    reason: checkpointState.projection.reason,
  };
}

function rawCheckpoint(
  identity: MistralConversationCheckpointIdentity = OWNER_A,
  checkpointState: MistralConversationTerminalCheckpointState = state(),
): string {
  return JSON.stringify({
    version: MISTRAL_CONVERSATION_CHECKPOINT_VERSION,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    subjectId: identity.subjectId,
    companyId: identity.companyId,
    ...checkpointState,
  });
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

beforeEach(() => {
  native.values.clear();
  native.operations.length = 0;
  vi.clearAllMocks();
});

describe('MistralConversationCheckpointStore', () => {
  it('persiste un seul envelope strict, versionné, terminal-only et sans secret métier', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);

    await store.save(fence, state());

    expect([...h.values.keys()]).toEqual([MISTRAL_CONVERSATION_CHECKPOINT_SLOT]);
    const raw = h.values.get(MISTRAL_CONVERSATION_CHECKPOINT_SLOT);
    expect(raw).toBeDefined();
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
      MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES,
    );
    const envelope = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual([
      'companyId',
      'missionExpiresAt',
      'projection',
      'protocol',
      'sessionHandle',
      'stream',
      'subjectId',
      'version',
    ]);
    expect(Object.keys(envelope['stream'] as object).sort()).toEqual([
      'missionConnectionEpoch',
      'nextServerSequence',
      'sessionHandle',
      'sessionReadyAccepted',
    ]);
    expect(Object.keys(envelope['projection'] as object).sort()).toEqual(['phase', 'reason']);
    expect(envelope).toMatchObject({
      version: 1,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      ...OWNER_A,
      projection: { phase: 'draining', reason: 'user' },
    });
    expect(raw).not.toMatch(/transcript|audio|ticket|capability|provider/iu);
    expect(h.setItem).toHaveBeenCalledTimes(1);
  });

  it('utilise exactement WHEN_UNLOCKED_THIS_DEVICE_ONLY, le service dédié et le slot fixe', async () => {
    const store = createNativeMistralConversationCheckpointStore();
    expect(createNativeMistralConversationCheckpointStore()).toBe(store);
    const fence = store.activateOwner(OWNER_A);
    const closed = state({ phase: 'closed' });

    await store.save(fence, closed);
    await store.clearAfterTerminalComplete(fence, terminalCompleteProof(OWNER_A, closed));

    const options = {
      keychainAccessible: 'when-unlocked-this-device-only',
      keychainService: MISTRAL_CONVERSATION_CHECKPOINT_KEYCHAIN_SERVICE,
    };
    expect(native.setItemAsync).toHaveBeenCalledWith(
      MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
      expect.any(String),
      options,
    );
    expect(native.deleteItemAsync).toHaveBeenCalledWith(
      MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
      options,
    );
    for (const [key, passedOptions] of native.getItemAsync.mock.calls) {
      expect(key).toBe(MISTRAL_CONVERSATION_CHECKPOINT_SLOT);
      expect(passedOptions).toEqual(options);
    }
  });

  it('fait un read-after-write exact et un delete suivi d’une relecture nulle', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);

    const closed = state({ phase: 'closed' });
    await store.save(fence, closed);
    expect(h.operations.slice(-2)).toEqual([
      `set:${MISTRAL_CONVERSATION_CHECKPOINT_SLOT}`,
      `get:${MISTRAL_CONVERSATION_CHECKPOINT_SLOT}`,
    ]);

    await store.clearAfterTerminalComplete(fence, terminalCompleteProof(OWNER_A, closed));
    expect(h.operations.slice(-2)).toEqual([
      `delete:${MISTRAL_CONVERSATION_CHECKPOINT_SLOT}`,
      `get:${MISTRAL_CONVERSATION_CHECKPOINT_SLOT}`,
    ]);
    expect(h.values.size).toBe(0);
  });

  it('conserve un checkpoint closed jusqu’au clear explicite terminal_complete', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);

    await store.save(fence, state({ phase: 'closed', nextServerSequence: 3 }));

    expect(h.deleteItem).not.toHaveBeenCalled();
    await expect(store.load(fence)).resolves.toMatchObject({
      stream: { closed: true, nextServerSequence: 3 },
      projection: { phase: 'closed' },
    });
  });

  it('refuse un clear sur draining ou une preuve non exacte sans supprimer le checkpoint', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);
    const draining = state({ nextServerSequence: 3 });
    await store.save(fence, draining);

    await expect(store.clearAfterTerminalComplete(
      fence,
      terminalCompleteProof(OWNER_A, {
        ...draining,
        stream: { ...draining.stream, closed: true },
        projection: { ...draining.projection, phase: 'closed' },
      }),
    )).rejects.toMatchObject({ code: 'terminal_not_closed' });
    expect(h.deleteItem).not.toHaveBeenCalled();

    const closed = state({ phase: 'closed', nextServerSequence: 4 });
    await store.save(fence, closed);
    const exact = terminalCompleteProof(OWNER_A, closed);
    const falseProofs: readonly MistralConversationTerminalCompleteProof[] = [
      { ...exact, subjectId: OWNER_B.subjectId },
      { ...exact, companyId: OWNER_B.companyId },
      { ...exact, sessionHandle: SESSION_B },
      { ...exact, missionConnectionEpoch: exact.missionConnectionEpoch + 1 },
      { ...exact, nextServerSequence: exact.nextServerSequence + 1 },
      { ...exact, reason: 'fatal_error' },
      { ...exact, unexpected: true } as unknown as MistralConversationTerminalCompleteProof,
    ];
    for (const falseProof of falseProofs) {
      await expect(store.clearAfterTerminalComplete(fence, falseProof)).rejects.toMatchObject({
        code: 'terminal_proof_mismatch',
      });
    }
    expect(h.deleteItem).not.toHaveBeenCalled();
    await expect(store.load(fence)).resolves.toMatchObject({ sessionHandle: SESSION_A });
  });

  it('recharge uniquement l’identité exacte et purge atomiquement un ancien propriétaire', async () => {
    const h = createDependencies();
    h.values.set(MISTRAL_CONVERSATION_CHECKPOINT_SLOT, rawCheckpoint(OWNER_A));
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_B);

    await expect(store.load(fence)).resolves.toBeNull();
    expect(h.deleteItem).toHaveBeenCalledOnce();
    expect(h.values.size).toBe(0);
  });

  it('purge puis refuse JSON corrompu, clés inconnues, données sensibles et recoveryPending', async () => {
    const valid = JSON.parse(rawCheckpoint()) as Record<string, unknown>;
    const hostile: readonly string[] = [
      '{',
      JSON.stringify({ ...valid, transcript: 'secret' }),
      JSON.stringify({ ...valid, ticket: 'secret-capability' }),
      JSON.stringify({ ...valid, audio: 'AAAA' }),
      JSON.stringify({ ...valid, protocol: 'bob.mistral-pcm.v1' }),
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({
        ...valid,
        stream: {
          ...(valid['stream'] as object),
          recoveryPending: true,
          recoveryCancellationGeneration: 1,
        },
      }),
      JSON.stringify({
        ...valid,
        projection: { phase: 'closed', reason: 'user' },
      }),
    ];

    for (const raw of hostile) {
      const h = createDependencies();
      h.values.set(MISTRAL_CONVERSATION_CHECKPOINT_SLOT, raw);
      const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
      const fence = store.activateOwner(OWNER_A);
      await expect(store.load(fence)).rejects.toEqual(
        new MistralConversationCheckpointStoreError('checkpoint_corrupted'),
      );
      expect(h.values.size).toBe(0);
    }
  });

  it('mesure le plafond en octets UTF-8, pas en code units JavaScript', async () => {
    const h = createDependencies();
    const unicodeOversize = 'é'.repeat(Math.floor(MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES / 2) + 1);
    expect(unicodeOversize.length).toBeLessThan(MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES);
    expect(new TextEncoder().encode(unicodeOversize).byteLength).toBeGreaterThan(
      MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES,
    );
    h.values.set(MISTRAL_CONVERSATION_CHECKPOINT_SLOT, unicodeOversize);
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);

    await expect(store.load(fence)).rejects.toMatchObject({ code: 'checkpoint_too_large' });
    expect(h.values.size).toBe(0);
  });

  it('refuse les checkpoints non canoniques et la divergence du sessionHandle interne', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);

    const invalidStates: readonly MistralConversationTerminalCheckpointState[] = [
      state({ missionExpiresAt: '2026-07-19T15:30:00Z' }),
      { ...state(), stream: { ...state().stream, sessionHandle: SESSION_B } },
      {
        ...state(),
        stream: {
          ...state().stream,
          recoveryPending: true,
          recoveryCancellationGeneration: 1,
        },
      },
      { ...state(), projection: { phase: 'closed', reason: 'user' } },
    ];
    for (const invalid of invalidStates) {
      await expect(store.save(fence, invalid)).rejects.toMatchObject({ code: 'invalid_checkpoint' });
    }
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it('refuse indisponibilité et exceptions natives sans aucun fallback mémoire', async () => {
    const unavailable = createDependencies({ available: false });
    const unavailableStore = createMistralConversationCheckpointStoreForTesting(
      unavailable.dependencies,
    );
    const unavailableFence = unavailableStore.activateOwner(OWNER_A);
    await expect(unavailableStore.load(unavailableFence)).rejects.toEqual(
      new MistralConversationCheckpointStoreError('secure_store_unavailable'),
    );
    expect(unavailable.getItem).not.toHaveBeenCalled();

    const getFailure = createDependencies({
      getItem: async () => {
        throw new Error('native unavailable');
      },
    });
    const getStore = createMistralConversationCheckpointStoreForTesting(getFailure.dependencies);
    await expect(getStore.load(getStore.activateOwner(OWNER_A))).rejects.toMatchObject({
      code: 'secure_store_unavailable',
    });

    const setFailure = createDependencies({
      setItem: async () => {
        throw new Error('native unavailable');
      },
    });
    const setStore = createMistralConversationCheckpointStoreForTesting(setFailure.dependencies);
    await expect(setStore.save(setStore.activateOwner(OWNER_A), state())).rejects.toMatchObject({
      code: 'secure_store_unavailable',
    });
  });

  it('détecte toute écriture ou suppression non durable par vérification immédiate', async () => {
    const droppedWrite = createDependencies({ setItem: async () => undefined });
    const writeStore = createMistralConversationCheckpointStoreForTesting(
      droppedWrite.dependencies,
    );
    await expect(
      writeStore.save(writeStore.activateOwner(OWNER_A), state()),
    ).rejects.toMatchObject({ code: 'write_verification_failed' });

    const droppedDelete = createDependencies({ deleteItem: async () => undefined });
    const closed = state({ phase: 'closed' });
    droppedDelete.values.set(MISTRAL_CONVERSATION_CHECKPOINT_SLOT, rawCheckpoint(OWNER_A, closed));
    const deleteStore = createMistralConversationCheckpointStoreForTesting(
      droppedDelete.dependencies,
    );
    await expect(
      deleteStore.clearAfterTerminalComplete(
        deleteStore.activateOwner(OWNER_A),
        terminalCompleteProof(OWNER_A, closed),
      ),
    ).rejects.toMatchObject({ code: 'delete_verification_failed' });
  });

  it('interdit régression curseur/epoch, réouverture, conflit terminal et remplacement de session', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);
    await store.save(fence, state({ nextServerSequence: 4, missionConnectionEpoch: 2 }));

    await expect(store.save(fence, state({
      nextServerSequence: 3,
      missionConnectionEpoch: 2,
    }))).rejects.toMatchObject({ code: 'cursor_regression' });
    await expect(store.save(fence, state({
      nextServerSequence: 5,
      missionConnectionEpoch: 1,
    }))).rejects.toMatchObject({ code: 'epoch_regression' });
    await expect(store.save(fence, state({
      sessionHandle: SESSION_B,
      nextServerSequence: 5,
      missionConnectionEpoch: 2,
    }))).rejects.toMatchObject({ code: 'session_replacement_requires_clear' });

    await store.save(fence, state({
      nextServerSequence: 5,
      missionConnectionEpoch: 2,
      phase: 'closed',
    }));
    await expect(store.save(fence, state({
      nextServerSequence: 5,
      missionConnectionEpoch: 2,
      phase: 'draining',
    }))).rejects.toMatchObject({ code: 'terminal_reopen' });
    await expect(store.save(fence, state({
      nextServerSequence: 6,
      missionConnectionEpoch: 2,
      phase: 'closed',
    }))).rejects.toMatchObject({ code: 'terminal_conflict' });
    await expect(store.save(fence, state({
      nextServerSequence: 5,
      missionConnectionEpoch: 2,
      phase: 'closed',
      reason: 'fatal_error',
    }))).rejects.toMatchObject({ code: 'terminal_conflict' });

    await expect(store.save(fence, state({
      nextServerSequence: 5,
      missionConnectionEpoch: 2,
      phase: 'closed',
    }))).resolves.toMatchObject({ projection: { phase: 'closed' } });
  });

  it('impose les minima terminales et une progression stricte draining vers closed', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);

    await expect(store.save(fence, state({
      nextServerSequence: 1,
      phase: 'draining',
    }))).rejects.toMatchObject({ code: 'invalid_checkpoint' });
    await expect(store.save(fence, state({
      nextServerSequence: 2,
      phase: 'closed',
    }))).rejects.toMatchObject({ code: 'invalid_checkpoint' });

    await store.save(fence, state({ nextServerSequence: 3, phase: 'draining' }));
    await expect(store.save(fence, state({
      nextServerSequence: 3,
      phase: 'closed',
    }))).rejects.toMatchObject({ code: 'terminal_conflict' });
    await expect(store.save(fence, state({
      nextServerSequence: 5,
      phase: 'closed',
    }))).resolves.toMatchObject({ stream: { nextServerSequence: 5, closed: true } });
  });

  it('autorise une nouvelle session uniquement après clear vérifié', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);
    const closed = state({ phase: 'closed' });
    await store.save(fence, closed);
    await store.clearAfterTerminalComplete(fence, terminalCompleteProof(OWNER_A, closed));

    await expect(store.save(fence, state({ sessionHandle: SESSION_B }))).resolves.toMatchObject({
      sessionHandle: SESSION_B,
    });
  });

  it('révoque avant le premier await, rejette un write tardif et toute nouvelle session pendant le clear', async () => {
    const secondSetEntered = deferred<void>();
    const releaseSecondSet = deferred<void>();
    let setCount = 0;
    const h = createDependencies({
      setItem: async (key, value) => {
        setCount += 1;
        h.values.set(key, value);
        if (setCount === 2) {
          secondSetEntered.resolve();
          await releaseSecondSet.promise;
        }
      },
    });
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);
    const closed = state({ phase: 'closed' });
    await store.save(fence, closed);

    const lateWrite = store.save(fence, closed);
    await secondSetEntered.promise;
    const clearing = store.clearAfterTerminalComplete(
      fence,
      terminalCompleteProof(OWNER_A, closed),
    );
    expect(() => store.activateOwner(OWNER_B)).toThrowError(
      expect.objectContaining({ code: 'terminal_clear_in_progress' }),
    );
    await expect(store.save(fence, state({ sessionHandle: SESSION_B }))).rejects.toMatchObject({
      code: 'terminal_clear_in_progress',
    });

    releaseSecondSet.resolve();
    await expect(lateWrite).rejects.toMatchObject({ code: 'terminal_clear_in_progress' });
    await expect(clearing).resolves.toBeUndefined();
    expect(h.values.size).toBe(0);
  });

  it('maintient la révocation après delete non attesté puis accepte le retry de la même preuve', async () => {
    let deletePersists = false;
    const h = createDependencies({
      deleteItem: async (key) => {
        if (deletePersists) h.values.delete(key);
      },
    });
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);
    const closed = state({ phase: 'closed' });
    const proof = terminalCompleteProof(OWNER_A, closed);
    await store.save(fence, closed);

    await expect(store.clearAfterTerminalComplete(fence, proof)).rejects.toMatchObject({
      code: 'delete_verification_failed',
    });
    expect(() => store.activateOwner(OWNER_B)).toThrowError(
      expect.objectContaining({ code: 'terminal_clear_in_progress' }),
    );
    await expect(store.load(fence)).rejects.toMatchObject({ code: 'terminal_clear_in_progress' });
    await expect(store.save(fence, state({ sessionHandle: SESSION_B }))).rejects.toMatchObject({
      code: 'terminal_clear_in_progress',
    });
    await expect(store.scrubRequiredCheckpoint()).rejects.toMatchObject({
      code: 'terminal_clear_in_progress',
    });
    await expect(store.clearAfterTerminalComplete(fence, {
      ...proof,
      nextServerSequence: proof.nextServerSequence + 1,
    })).rejects.toMatchObject({ code: 'terminal_proof_mismatch' });

    deletePersists = true;
    await expect(store.retryInterruptedTerminalClear(fence)).resolves.toBeUndefined();
    await expect(store.retryInterruptedTerminalClear(fence)).rejects.toMatchObject({
      code: 'terminal_clear_in_progress',
    });
    await expect(store.save(fence, state({ sessionHandle: SESSION_B }))).resolves.toMatchObject({
      sessionHandle: SESSION_B,
    });
  });

  it('sérialise strictement deux writes concurrents et conserve le curseur le plus avancé', async () => {
    const firstSetEntered = deferred<void>();
    const releaseFirstSet = deferred<void>();
    let setCount = 0;
    let activeNativeWrites = 0;
    let maximumConcurrentWrites = 0;
    const h = createDependencies({
      setItem: async (key, value) => {
        setCount += 1;
        activeNativeWrites += 1;
        maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeNativeWrites);
        if (setCount === 1) {
          firstSetEntered.resolve();
          await releaseFirstSet.promise;
        }
        h.values.set(key, value);
        activeNativeWrites -= 1;
      },
    });
    const coordinator = createMistralConversationCheckpointCoordinatorForTesting();
    const firstStore = createMistralConversationCheckpointStoreForTesting(
      h.dependencies,
      coordinator,
    );
    const secondStore = createMistralConversationCheckpointStoreForTesting(
      h.dependencies,
      coordinator,
    );
    const fence = firstStore.activateOwner(OWNER_A);
    expect(secondStore.activateOwner(OWNER_A)).toBe(fence);

    const first = firstStore.save(fence, state({ nextServerSequence: 2 }));
    await firstSetEntered.promise;
    const second = secondStore.save(fence, state({ nextServerSequence: 3 }));
    await Promise.resolve();
    expect(setCount).toBe(1);
    releaseFirstSet.resolve();
    await Promise.all([first, second]);

    expect(maximumConcurrentWrites).toBe(1);
    await expect(firstStore.load(fence)).resolves.toMatchObject({
      stream: { nextServerSequence: 3 },
    });
  });

  it('purge la frontière auth avant un switch, fence le write en vol et bloque B avant attestation', async () => {
    const setEntered = deferred<void>();
    const releaseSet = deferred<void>();
    const h = createDependencies({
      setItem: async (key, value) => {
        h.values.set(key, value);
        setEntered.resolve();
        await releaseSet.promise;
      },
    });
    const coordinator = createMistralConversationCheckpointCoordinatorForTesting();
    const oldStore = createMistralConversationCheckpointStoreForTesting(h.dependencies, coordinator);
    const newStore = createMistralConversationCheckpointStoreForTesting(h.dependencies, coordinator);
    const oldFence = oldStore.activateOwner(OWNER_A);
    const lateWrite = oldStore.save(oldFence, state());
    await setEntered.promise;

    expect(() => newStore.activateOwner(OWNER_B)).toThrowError(
      expect.objectContaining({ code: 'auth_boundary_purge_required' }),
    );
    const purging = oldStore.purgeForAuthBoundary(oldFence);
    expect(() => newStore.activateOwner(OWNER_B)).toThrowError(
      expect.objectContaining({ code: 'auth_boundary_purge_in_progress' }),
    );
    await expect(newStore.load(oldFence)).rejects.toMatchObject({
      code: 'auth_boundary_purge_in_progress',
    });
    await expect(newStore.save(oldFence, state({ nextServerSequence: 3 }))).rejects.toMatchObject({
      code: 'auth_boundary_purge_in_progress',
    });
    await expect(oldStore.clearAfterTerminalComplete(
      oldFence,
      terminalCompleteProof(OWNER_A, state({ phase: 'closed' })),
    )).rejects.toMatchObject({ code: 'auth_boundary_purge_in_progress' });
    releaseSet.resolve();
    await expect(lateWrite).rejects.toMatchObject({ code: 'auth_boundary_purge_in_progress' });
    await expect(purging).resolves.toBeUndefined();
    await expect(oldStore.purgeForAuthBoundary(oldFence)).resolves.toBeUndefined();

    const newFence = newStore.activateOwner(OWNER_B);
    await expect(newStore.load(newFence)).resolves.toBeNull();
    expect(h.values.size).toBe(0);
  });

  it('exige aussi la purge auth attestée avant logout puis invalide définitivement la fence', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);
    await store.save(fence, state());

    expect(() => store.deactivateOwner(fence)).toThrowError(
      expect.objectContaining({ code: 'auth_boundary_purge_required' }),
    );
    await store.purgeForAuthBoundary(fence);
    store.deactivateOwner(fence);
    await expect(store.load(fence)).rejects.toMatchObject({ code: 'stale_owner' });
    const reconnected = store.activateOwner(OWNER_A);
    expect(reconnected.generation).toBeGreaterThan(fence.generation);
    await expect(store.load(reconnected)).resolves.toBeNull();
  });

  it.each(['delete_noop', 'delete_exception', 'secure_store_unavailable'] as const)(
    'conserve le verrou auth après %s et n’autorise que le retry même fence',
    async (failure) => {
      const h = createDependencies();
      const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
      const fence = store.activateOwner(OWNER_A);
      await store.save(fence, state());
      if (failure === 'delete_noop') {
        h.deleteItem.mockImplementation(async () => undefined);
      } else if (failure === 'delete_exception') {
        h.deleteItem.mockImplementation(async () => {
          throw new Error('native delete failed');
        });
      } else {
        h.isAvailable.mockResolvedValue(false);
      }

      await expect(store.purgeForAuthBoundary(fence)).rejects.toMatchObject({
        code: failure === 'delete_noop'
          ? 'delete_verification_failed'
          : 'secure_store_unavailable',
      });
      expect(() => store.activateOwner(OWNER_B)).toThrowError(
        expect.objectContaining({ code: 'auth_boundary_purge_in_progress' }),
      );
      await expect(store.scrubRequiredCheckpoint()).rejects.toMatchObject({
        code: 'auth_boundary_purge_in_progress',
      });

      h.isAvailable.mockResolvedValue(true);
      h.deleteItem.mockImplementation(async (key: string) => {
        h.values.delete(key);
      });
      await expect(store.purgeForAuthBoundary(fence)).resolves.toBeUndefined();
      await expect(store.purgeForAuthBoundary(fence)).resolves.toBeUndefined();
      await expect(store.load(store.activateOwner(OWNER_B))).resolves.toBeNull();
    },
  );

  it('ne laisse jamais le scrub générique contourner une lecture terminale non vérifiée', async () => {
    const draining = state({ nextServerSequence: 3, phase: 'draining' });
    let readFails = true;
    const h = createDependencies({
      getItem: async (key) => {
        if (readFails) throw new Error('native read unavailable');
        return h.values.get(key) ?? null;
      },
    });
    h.values.set(MISTRAL_CONVERSATION_CHECKPOINT_SLOT, rawCheckpoint(OWNER_A, draining));
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);
    const claimedClosed = {
      ...draining,
      stream: { ...draining.stream, closed: true as const },
      projection: { ...draining.projection, phase: 'closed' as const },
    };
    const proof = terminalCompleteProof(OWNER_A, claimedClosed);

    await expect(store.clearAfterTerminalComplete(fence, proof)).rejects.toMatchObject({
      code: 'secure_store_unavailable',
    });
    await expect(store.scrubRequiredCheckpoint()).rejects.toMatchObject({
      code: 'terminal_clear_in_progress',
    });
    await expect(store.purgeForAuthBoundary(fence)).rejects.toMatchObject({
      code: 'terminal_clear_in_progress',
    });
    expect(h.values.has(MISTRAL_CONVERSATION_CHECKPOINT_SLOT)).toBe(true);

    await expect(store.clearAfterTerminalComplete(fence, {
      ...proof,
      nextServerSequence: proof.nextServerSequence + 1,
    })).rejects.toMatchObject({ code: 'terminal_clear_in_progress' });
    readFails = false;
    await expect(store.clearAfterTerminalComplete(fence, proof)).rejects.toMatchObject({
      code: 'terminal_not_closed',
    });
    expect(h.values.has(MISTRAL_CONVERSATION_CHECKPOINT_SLOT)).toBe(true);
    await expect(store.load(fence)).resolves.toMatchObject({
      projection: { phase: 'draining' },
    });
  });

  it('refuse deux adaptateurs de stockage différents derrière le même coordinateur', () => {
    const coordinator = createMistralConversationCheckpointCoordinatorForTesting();
    createMistralConversationCheckpointStoreForTesting(
      createDependencies().dependencies,
      coordinator,
    );
    expect(() => createMistralConversationCheckpointStoreForTesting(
      createDependencies().dependencies,
      coordinator,
    )).toThrowError(expect.objectContaining({ code: 'coordinator_conflict' }));
  });

  it('invalide les fences forgées, anciennes ou utilisées après logout', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    const fence = store.activateOwner(OWNER_A);
    const sameFence = store.activateOwner({ ...OWNER_A });
    expect(sameFence).toBe(fence);

    await expect(store.load({ ...fence })).rejects.toMatchObject({ code: 'stale_owner' });
    await store.purgeForAuthBoundary(fence);
    store.deactivateOwner(fence);
    await expect(store.load(fence)).rejects.toMatchObject({ code: 'stale_owner' });

    const nextFence = store.activateOwner(OWNER_A);
    expect(nextFence.generation).toBeGreaterThan(fence.generation);
    await expect(store.load(nextFence)).resolves.toBeNull();
  });

  it('refuse une identité non authentifiable avant tout accès natif', async () => {
    const h = createDependencies();
    const store = createMistralConversationCheckpointStoreForTesting(h.dependencies);
    for (const identity of [
      { subjectId: '', companyId: 'company-a' },
      { subjectId: 'subject-a', companyId: '../company-a' },
      { subjectId: 'é', companyId: 'company-a' },
    ]) {
      expect(() => store.activateOwner(identity)).toThrowError(
        expect.objectContaining({ code: 'invalid_owner' }),
      );
    }
    expect(h.isAvailable).not.toHaveBeenCalled();
  });
});
