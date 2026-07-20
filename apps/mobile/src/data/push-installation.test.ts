import { describe, expect, it } from 'vitest';
import {
  PUSH_INSTALLATION_STATE_KEY,
  PUSH_TOMBSTONE_MIN_RETENTION_MS,
  PushInstallationStore,
  decodePushInstallationState,
  type PushInstallationGenerators,
  type PushInstallationKv,
} from './push-installation';

class MemoryKv implements PushInstallationKv {
  readonly rows = new Map<string, string>();
  failNextSet = false;

  async getItem(key: string): Promise<string | null> {
    return this.rows.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('secure storage unavailable');
    }
    this.rows.set(key, value);
  }
}

function generators(): PushInstallationGenerators {
  let uuid = 0;
  let secret = 0;
  return {
    uuidV4: () => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`;
    },
    secretHex: () => {
      secret += 1;
      return secret.toString(16).padStart(64, '0');
    },
    sha256Hex: async (value) => (value === TOKEN_A ? 'a' : 'b').repeat(64),
  };
}

const TOKEN_A = 'ExponentPushToken[token-alpha]';
const TOKEN_B = 'ExponentPushToken[token-bravo]';

describe('PushInstallationStore — autorité durable v2', () => {
  it('conserve identité, secret et candidate à travers un cold restart', async () => {
    const kv = new MemoryKv();
    let now = 1_000;
    const crypto = generators();
    const first = new PushInstallationStore(kv, crypto, () => now);
    const candidate = await first.prepareBinding('co-a:user-a', TOKEN_A);
    expect(kv.rows.get(PUSH_INSTALLATION_STATE_KEY)).not.toContain(TOKEN_A);

    const restarted = new PushInstallationStore(kv, crypto, () => now);
    const replayed = await restarted.prepareBinding('co-a:user-a', TOKEN_A);
    expect(replayed).toEqual(candidate);
    expect(replayed.bindingGeneration).toBe(1);
    expect((await restarted.snapshot()).generation).toBe(1);
    now += 1;
  });

  it('n’expose jamais une candidate si le write-ahead SecureStore échoue', async () => {
    const kv = new MemoryKv();
    const store = new PushInstallationStore(kv, generators(), () => 1_000);
    await store.load();
    kv.failNextSet = true;
    await expect(store.prepareBinding('co-a:user-a', TOKEN_A)).rejects.toThrow('secure storage');
    await expect(store.snapshot()).resolves.toMatchObject({ generation: 0, active: null });

    const retry = await store.prepareBinding('co-a:user-a', TOKEN_A);
    expect(retry.bindingGeneration).toBe(1);
  });

  it('sérialise les courses et réutilise exactement la même candidate idempotente', async () => {
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => 1_000);
    const [a, b, c] = await Promise.all([
      store.prepareBinding('co-a:user-a', TOKEN_A),
      store.prepareBinding('co-a:user-a', TOKEN_A),
      store.prepareBinding('co-a:user-a', TOKEN_A),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('A→token tourné→B incrémente G et compacte un seul high-water courant', async () => {
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => 1_000);
    const a1 = await store.prepareBinding('co-a:user-a', TOKEN_A);
    const a2 = await store.prepareBinding('co-a:user-a', TOKEN_B);
    const b3 = await store.prepareBinding('co-b:user-b', TOKEN_B);

    expect([a1.bindingGeneration, a2.bindingGeneration, b3.bindingGeneration]).toEqual([1, 2, 3]);
    const state = await store.snapshot();
    expect(state.pendingRevocations).toHaveLength(1);
    expect(state.pendingRevocations[0]).toMatchObject({
      installationId: b3.installationId,
      throughGeneration: 2,
    });
    expect(state.active).toMatchObject({ ownerKey: 'co-b:user-b', generation: 3 });
  });

  it('écrit la tombstone avant retour, la garde après 202 public et au-delà de 31 jours', async () => {
    const kv = new MemoryKv();
    let now = 1_000;
    const store = new PushInstallationStore(kv, generators(), () => now);
    const candidate = await store.prepareBinding('co-a:user-a', TOKEN_A);
    const revocation = await store.prepareRevocation('co-a:user-a');
    expect(revocation).toEqual({
      installationId: candidate.installationId,
      throughGeneration: 1,
      revocationSecret: candidate.revocationSecret,
    });
    expect(JSON.parse(kv.rows.get(PUSH_INSTALLATION_STATE_KEY) ?? '{}')).toMatchObject({
      active: null,
      pendingRevocations: [{ throughGeneration: 1 }],
    });

    await store.recordReplayAttempt(revocation!, true);
    expect((await store.snapshot()).pendingRevocations).toHaveLength(1);
    now += 15_000;
    expect(await store.dueRevocations()).toHaveLength(1);
    now += PUSH_TOMBSTONE_MIN_RETENTION_MS + 1;
    expect((await store.dueRevocations()).map((entry) => entry.throughGeneration)).toEqual([1]);
    expect((await store.snapshot()).pendingRevocations).toHaveLength(1);
  });

  it('repart à 15 s au premier 202 après une longue série d’échecs réseau', async () => {
    let now = 1_000;
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => now);
    await store.prepareBinding('co-a:user-a', TOKEN_A);
    const capability = (await store.prepareRevocation('co-a:user-a'))!;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await store.recordReplayAttempt(capability, false);
      now = (await store.snapshot()).pendingRevocations[0]!.nextAttemptAtMs;
    }

    await store.recordReplayAttempt(capability, true);
    now += 14_999;
    expect(await store.dueRevocations()).toEqual([]);
    now += 1;
    expect(await store.dueRevocations()).toEqual([capability]);
  });

  it('ne retire le tombstone courant qu’après preuve serveur d’un bind G>N', async () => {
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => 1_000);
    await store.prepareBinding('co-a:user-a', TOKEN_A);
    await store.prepareRevocation('co-a:user-a');
    const next = await store.prepareBinding('co-b:user-b', TOKEN_A);
    expect((await store.snapshot()).pendingRevocations).toHaveLength(1);
    expect(await store.confirmBinding(next)).toBe(true);
    expect((await store.snapshot()).pendingRevocations).toEqual([]);
  });

  it('rotation superseded conserve l’ancienne capacité jusqu’à récupération confirmée', async () => {
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => 1_000);
    const stale = await store.prepareBinding('co-a:user-a', TOKEN_A);
    const recovered = await store.rotateAfterSuperseded(stale);
    expect(recovered).not.toBeNull();
    expect(recovered!.installationId).not.toBe(stale.installationId);
    expect(recovered!.bindingGeneration).toBe(1);
    // Une réponse superseded ne fabrique pas une révocation qui pourrait neutraliser le binding
    // légitime concurrent à la même génération.
    expect(await store.dueRevocations(true)).toEqual([]);
    await store.confirmBinding(recovered!);
    expect((await store.snapshot()).pendingRevocations).toHaveLength(0);
  });

  it('retire un tombstone uniquement sur preuve de révocation authentifiée', async () => {
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => 1_000);
    await store.prepareBinding('co-a:user-a', TOKEN_A);
    const capability = await store.prepareRevocation('co-a:user-a');
    expect(await store.confirmAuthenticatedRevocation(capability!)).toBe(true);
    expect(await store.confirmAuthenticatedRevocation(capability!)).toBe(false);
    expect((await store.snapshot()).pendingRevocations).toEqual([]);
  });

  it('une fence de snapshot ancienne ne révoque jamais le binding plus récent du même owner', async () => {
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => 1_000);
    const first = await store.prepareBinding('co-a:user-a', TOKEN_A);
    const observed = {
      installationId: first.installationId,
      ownerKey: first.ownerKey,
      bindingId: first.bindingId,
      bindingGeneration: first.bindingGeneration,
    };
    const second = await store.prepareBinding('co-a:user-a', TOKEN_B);

    await expect(store.prepareRevocationIfActiveFence(observed)).resolves.toBeNull();
    expect((await store.snapshot()).active).toMatchObject({
      bindingId: second.bindingId,
      generation: second.bindingGeneration,
    });
  });

  it('quarantaine tout état corrompu avant de créer une identité neuve', async () => {
    const kv = new MemoryKv();
    kv.rows.set(PUSH_INSTALLATION_STATE_KEY, '{"version":1,"secret":"tronqué"}');
    const store = new PushInstallationStore(kv, generators(), () => 42);
    const loaded = await store.load();
    expect(loaded.recoveredFromCorruption).toBe(true);
    expect(loaded.quarantineKey).toContain('.quarantine.42.');
    expect(kv.rows.get(loaded.quarantineKey!)).toBe('{"version":1,"secret":"tronqué"}');
    expect(decodePushInstallationState(kv.rows.get(PUSH_INSTALLATION_STATE_KEY)!)).not.toBeNull();
  });

  it('accepte un payload uniquement après confirmation et sur fence exact', async () => {
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => 1_000);
    const candidate = await store.prepareBinding('co-a:user-a', TOKEN_A);
    const payload = {
      pushContract: '2',
      route: '/notifications',
      recipientBindingId: candidate.bindingId,
      // Contrat Expo exact émis par NotificationDeliveryService.
      recipientBindingGeneration: String(candidate.bindingGeneration),
    };
    await expect(store.matchesPayload(payload)).resolves.toBe('not_ready');
    await store.confirmBinding(candidate);
    await expect(store.matchesPayload(payload)).resolves.toBe('matched');
    await expect(
      store.matchesPayload({ ...payload, recipientBindingGeneration: '2' }),
    ).resolves.toBe('stale');
    await expect(store.matchesPayload({ ...payload, recipientBindingGeneration: 1 })).resolves.toBe(
      'invalid',
    );
    await expect(
      store.matchesPayload({ ...payload, recipientBindingGeneration: '01' }),
    ).resolves.toBe('invalid');
    await expect(store.matchesPayload({ ...payload, invoiceId: 'secret' })).resolves.toBe(
      'invalid',
    );
    await expect(store.matchesPayload({ ...payload, route: '/facture/secret' })).resolves.toBe(
      'invalid',
    );
    await store.prepareRevocation('co-a:user-a');
    await expect(store.matchesPayload(payload)).resolves.toBe('stale');
  });

  it('codec exact refuse clés inconnues, doublons tombstone et générations incohérentes', async () => {
    const store = new PushInstallationStore(new MemoryKv(), generators(), () => 1_000);
    const state = await store.snapshot();
    expect(decodePushInstallationState(JSON.stringify({ ...state, extra: true }))).toBeNull();
    expect(
      decodePushInstallationState(
        JSON.stringify({
          ...state,
          active: {
            ownerKey: 'a',
            expoPushTokenFingerprint: 'a'.repeat(64),
            bindingId: '00000000-0000-4000-8000-000000000099',
            generation: 2,
            status: 'prepared',
          },
          generation: 1,
        }),
      ),
    ).toBeNull();
  });
});
