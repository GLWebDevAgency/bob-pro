import { describe, expect, it, vi } from 'vitest';
import type { BobClient } from '@bob/api-client';
import {
  PushInstallationStore,
  type PushInstallationGenerators,
  type PushInstallationKv,
} from './push-installation';
import { PushInstallationRuntime } from './push-installation-runtime';

class MemoryKv implements PushInstallationKv {
  readonly rows = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.rows.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.rows.set(key, value);
  }
}

function crypto(): PushInstallationGenerators {
  let id = 0;
  return {
    uuidV4: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    secretHex: () => String(++id).padStart(64, 'a'),
    sha256Hex: async (value) => (value.includes('alpha') ? 'a' : 'b').repeat(64),
  };
}

type RuntimeClient = Pick<
  BobClient,
  'registerDevice' | 'revokeDeviceBinding' | 'replayPushRevocation'
>;

function client(overrides: Partial<RuntimeClient> = {}): RuntimeClient {
  return {
    registerDevice: vi.fn<RuntimeClient['registerDevice']>(async () => ({
      ok: true,
      value: { status: 'bound' },
    })),
    revokeDeviceBinding: vi.fn<RuntimeClient['revokeDeviceBinding']>(async () => ({
      ok: true,
      value: { accepted: true },
    })),
    replayPushRevocation: vi.fn<RuntimeClient['replayPushRevocation']>(async () => ({
      ok: true,
      value: { accepted: true },
    })),
    ...overrides,
  };
}

const TOKEN_A = 'ExponentPushToken[token-alpha]';
const TOKEN_B = 'ExponentPushToken[token-bravo]';

function payload(bindingId: string, generation: number) {
  return {
    pushContract: '2',
    route: '/notifications',
    recipientBindingId: bindingId,
    recipientBindingGeneration: String(generation),
  };
}

describe('PushInstallationRuntime', () => {
  it('réconcilie un owner puis confirme le fence exact après le bind serveur', async () => {
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const api = client();
    const runtime = new PushInstallationRuntime({ store });
    await expect(runtime.matchPayload({})).resolves.toBe('not_ready');
    await runtime.updateOwner('owner-a', api);
    await runtime.registerCurrent(TOKEN_A, 'ios');

    const state = await store.snapshot();
    expect(api.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        expoPushToken: TOKEN_A,
        bindingGeneration: 1,
      }),
    );
    await expect(runtime.matchPayload(payload(state.active!.bindingId, 1))).resolves.toBe(
      'matched',
    );
  });

  it('ferme la fence précédente synchroniquement pendant la dérivation du nouvel owner', async () => {
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const api = client();
    const runtime = new PushInstallationRuntime({ store });
    await runtime.updateOwner('owner-a', api);
    await runtime.registerCurrent(TOKEN_A, 'ios');
    const active = (await store.snapshot()).active!;

    const transition = runtime.beginOwnerTransition(api);
    await expect(runtime.matchPayload(payload(active.bindingId, active.generation))).resolves.toBe(
      'not_ready',
    );
    await expect(runtime.completeOwnerTransition(transition, 'owner-b')).resolves.toBe(true);
    await expect(runtime.matchPayload(payload(active.bindingId, active.generation))).resolves.toBe(
      'stale',
    );
  });

  it('un teardown invalide la transition et empêche sa publication tardive', async () => {
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const api = client();
    const runtime = new PushInstallationRuntime({ store });
    const transition = runtime.beginOwnerTransition(api);
    runtime.abortOwnerTransition(transition);

    await expect(runtime.completeOwnerTransition(transition, 'owner-a')).resolves.toBe(false);
    await expect(runtime.registerCurrent(TOKEN_A, 'ios')).rejects.toThrow('non réconcilié');
  });

  it('A→B écrit le tombstone avant B et rend le payload A stale, même dans la même société', async () => {
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const api = client();
    const runtime = new PushInstallationRuntime({ store });
    await runtime.updateOwner('company:owner-a', api);
    await runtime.registerCurrent(TOKEN_A, 'ios');
    const a = (await store.snapshot()).active!;

    await runtime.updateOwner('company:owner-b', api);
    expect((await store.snapshot()).active).toBeNull();
    await runtime.registerCurrent(TOKEN_A, 'ios');
    const b = (await store.snapshot()).active!;

    expect(b.generation).toBe(2);
    expect(b.bindingId).not.toBe(a.bindingId);
    await expect(runtime.matchPayload(payload(a.bindingId, a.generation))).resolves.toBe('stale');
    await expect(runtime.matchPayload(payload(b.bindingId, b.generation))).resolves.toBe('matched');
  });

  it('conserve la révocation write-ahead lorsque le réseau authentifié est indisponible', async () => {
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const api = client({
      revokeDeviceBinding: vi.fn<RuntimeClient['revokeDeviceBinding']>(async () => ({
        ok: false,
        error: { kind: 'dependency', port: 'push', cause: 'offline' },
      })),
    });
    const runtime = new PushInstallationRuntime({ store });
    await runtime.updateOwner('owner-a', api);
    await runtime.registerCurrent(TOKEN_A, 'ios');

    await expect(runtime.revokeOwnerAuthenticated('owner-a', api)).rejects.toThrow('indisponible');
    expect((await store.snapshot()).active).toBeNull();
    expect(await store.dueRevocations(true)).toHaveLength(1);
  });

  it('effectue une seule rotation de récupération après superseded', async () => {
    const registerDevice = vi
      .fn<RuntimeClient['registerDevice']>()
      .mockResolvedValueOnce({ ok: true, value: { status: 'superseded' } })
      .mockResolvedValueOnce({ ok: true, value: { status: 'bound' } });
    const api = client({ registerDevice });
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const runtime = new PushInstallationRuntime({ store });
    await runtime.updateOwner('owner-a', api);
    await runtime.registerCurrent(TOKEN_A, 'android');

    expect(registerDevice).toHaveBeenCalledTimes(2);
    const [first, second] = registerDevice.mock.calls.map((call) => call[0]);
    expect(second!.installationId).not.toBe(first!.installationId);
    expect((await store.snapshot()).active?.status).toBe('confirmed');
  });

  it('une réponse de bind tardive ne confirme jamais l’ancien owner', async () => {
    let resolve!: (value: Awaited<ReturnType<RuntimeClient['registerDevice']>>) => void;
    const delayed = new Promise<Awaited<ReturnType<RuntimeClient['registerDevice']>>>((done) => {
      resolve = done;
    });
    const registerDevice = vi.fn<RuntimeClient['registerDevice']>(async () => delayed);
    const api = client({ registerDevice });
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const runtime = new PushInstallationRuntime({ store });
    await runtime.updateOwner('owner-a', api);
    const old = runtime.registerCurrent(TOKEN_A, 'ios');
    await vi.waitFor(() => expect(registerDevice).toHaveBeenCalledOnce());

    await runtime.updateOwner('owner-b', api);
    resolve({ ok: true, value: { status: 'bound' } });
    await expect(old).rejects.toThrow('obsolète');
    expect((await store.snapshot()).active).toBeNull();
  });

  it('ferme la course ABA : une réponse de l’ancienne session du même owner ne confirme rien', async () => {
    let resolve!: (value: Awaited<ReturnType<RuntimeClient['registerDevice']>>) => void;
    const delayed = new Promise<Awaited<ReturnType<RuntimeClient['registerDevice']>>>((done) => {
      resolve = done;
    });
    const registerDevice = vi.fn<RuntimeClient['registerDevice']>(async () => delayed);
    const api = client({ registerDevice });
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const runtime = new PushInstallationRuntime({ store });
    await runtime.updateOwner('owner-a', api);
    const old = runtime.registerCurrent(TOKEN_A, 'ios');
    await vi.waitFor(() => expect(registerDevice).toHaveBeenCalledOnce());

    await runtime.updateOwner(null, api);
    await runtime.updateOwner('owner-a', api);
    resolve({ ok: true, value: { status: 'bound' } });
    await expect(old).rejects.toThrow('obsolète');
    expect((await store.snapshot()).active).toBeNull();
  });

  it('sérialise deux rotations de token du même owner sans révoquer la candidate la plus récente', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<RuntimeClient['registerDevice']>>) => void;
    const firstResponse = new Promise<Awaited<ReturnType<RuntimeClient['registerDevice']>>>(
      (done) => {
        resolveFirst = done;
      },
    );
    let calls = 0;
    const registerDevice = vi.fn<RuntimeClient['registerDevice']>(async () => {
      calls += 1;
      return calls === 1 ? firstResponse : { ok: true, value: { status: 'bound' } };
    });
    const api = client({ registerDevice });
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const runtime = new PushInstallationRuntime({ store });
    await runtime.updateOwner('owner-a', api);

    const first = runtime.registerCurrent(TOKEN_A, 'ios');
    const second = runtime.registerCurrent(TOKEN_B, 'ios');
    await vi.waitFor(() => expect(registerDevice).toHaveBeenCalledOnce());
    resolveFirst({ ok: true, value: { status: 'bound' } });
    await Promise.all([first, second]);

    expect(registerDevice).toHaveBeenCalledTimes(2);
    expect((await store.snapshot()).active).toMatchObject({
      expoPushTokenFingerprint: 'b'.repeat(64),
      generation: 2,
      status: 'confirmed',
    });
  });

  it('invalide une décision payload en vol dès que l’owner change', async () => {
    const api = client();
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const runtime = new PushInstallationRuntime({ store });
    await runtime.updateOwner('owner-a', api);
    let resolveMatch!: (value: 'matched') => void;
    const delayedMatch = new Promise<'matched'>((done) => {
      resolveMatch = done;
    });
    vi.spyOn(store, 'matchesPayload').mockImplementation(async () => delayedMatch);

    const decision = runtime.matchPayload({});
    const logout = runtime.updateOwner(null, api);
    resolveMatch('matched');
    await expect(decision).resolves.toBe('not_ready');
    await logout;
  });

  it('une révocation permission en vol ne neutralise pas un binding ABA plus récent', async () => {
    const api = client();
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const runtime = new PushInstallationRuntime({ store });
    const firstTransition = runtime.beginOwnerTransition(api);
    await runtime.completeOwnerTransition(firstTransition, 'owner-a');
    await runtime.registerCurrent(TOKEN_A, 'ios');
    const observed = await store.snapshot();

    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    vi.spyOn(store, 'snapshot').mockImplementationOnce(async () => {
      await snapshotGate;
      return observed;
    });
    const staleRevocation = runtime.revokeTransitionOwnerAuthenticated(firstTransition, 'owner-a');

    const nextTransition = runtime.beginOwnerTransition(api);
    await runtime.completeOwnerTransition(nextTransition, 'owner-a');
    await runtime.registerCurrent(TOKEN_B, 'ios');
    releaseSnapshot();

    await expect(staleRevocation).resolves.toBe(false);
    expect((await store.snapshot()).active).toMatchObject({
      ownerKey: 'owner-a',
      expoPushTokenFingerprint: 'b'.repeat(64),
      status: 'confirmed',
    });
  });

  it('une exception réseau après write-ahead garde le tombstone et ferme le cache local', async () => {
    const api = client({
      revokeDeviceBinding: vi.fn<RuntimeClient['revokeDeviceBinding']>(async () => {
        throw new Error('socket reset');
      }),
    });
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => 1_000);
    const runtime = new PushInstallationRuntime({ store });
    const transition = runtime.beginOwnerTransition(api);
    await runtime.completeOwnerTransition(transition, 'owner-a');
    await runtime.registerCurrent(TOKEN_A, 'ios');

    await expect(runtime.revokeTransitionOwnerAuthenticated(transition, 'owner-a')).resolves.toBe(
      true,
    );
    expect((await store.snapshot()).active).toBeNull();
    expect(await store.dueRevocations(true)).toHaveLength(1);
  });

  it('rejoue automatiquement un 202 public après 15 secondes sans supprimer le tombstone', async () => {
    let now = 1_000;
    const scheduled: Array<{ delay: number; callback: () => void }> = [];
    const scheduler = {
      set: vi.fn((delay: number, callback: () => void) => {
        scheduled.push({ delay, callback });
        return callback;
      }),
      clear: vi.fn(),
    };
    const api = client();
    const store = new PushInstallationStore(new MemoryKv(), crypto(), () => now);
    const runtime = new PushInstallationRuntime({ store, scheduler });
    await runtime.updateOwner('owner-a', api);
    await runtime.registerCurrent(TOKEN_B, 'ios');
    await store.prepareRevocation('owner-a');
    runtime.setAppActive(true);
    await vi.waitFor(() => expect(api.replayPushRevocation).toHaveBeenCalledOnce());
    expect((await store.snapshot()).pendingRevocations).toHaveLength(1);
    expect(scheduled.at(-1)?.delay).toBe(15_000);

    now += 15_000;
    scheduled.at(-1)!.callback();
    await vi.waitFor(() => expect(api.replayPushRevocation).toHaveBeenCalledTimes(2));
  });
});
