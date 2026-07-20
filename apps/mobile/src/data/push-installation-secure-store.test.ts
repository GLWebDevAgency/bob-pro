import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  isAvailableAsync: vi.fn(async () => true),
  getItemAsync: vi.fn(async (key: string, _options?: unknown) => native.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string, _options?: unknown) => {
    native.values.set(key, value);
  }),
  randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
  getRandomValues: vi.fn((target: Uint8Array) => {
    target.fill(0xab);
    return target;
  }),
  digestStringAsync: vi.fn(async (_algorithm: string, value: string) => {
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
  }),
}));

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  isAvailableAsync: native.isAvailableAsync,
  getItemAsync: native.getItemAsync,
  setItemAsync: native.setItemAsync,
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
  randomUUID: native.randomUUID,
  getRandomValues: native.getRandomValues,
  digestStringAsync: native.digestStringAsync,
}));

import {
  PushInstallationSecureStoreError,
  createSecurePushInstallationStore,
  deriveSecurePushOwnerKey,
  getSecurePushInstallationStore,
  type PushInstallationSecureStoreDependencies,
} from './push-installation-secure-store';

const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];

function createDependencies(
  overrides: {
    available?: boolean;
    uuidV4?: () => string;
    randomBytes?: (byteCount: number) => Uint8Array;
    sha256Hex?: (value: string) => Promise<string>;
  } = {},
): {
  dependencies: PushInstallationSecureStoreDependencies;
  values: Map<string, string>;
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  randomBytes: ReturnType<typeof vi.fn>;
  sha256Hex: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, string>();
  const getItem = vi.fn(async (key: string) => values.get(key) ?? null);
  const setItem = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const randomBytes = vi.fn(
    overrides.randomBytes ??
      ((byteCount: number) => {
        const bytes = new Uint8Array(byteCount);
        bytes.fill(0x5a);
        return bytes;
      }),
  );
  const sha256Hex = vi.fn(overrides.sha256Hex ?? (async (_value: string) => '11'.repeat(32)));
  let uuidIndex = 0;
  return {
    dependencies: {
      secureStore: {
        isAvailable: vi.fn(async () => overrides.available ?? true),
        getItem,
        setItem,
      },
      crypto: {
        uuidV4: overrides.uuidV4 ?? (() => UUIDS[uuidIndex++] ?? UUIDS.at(-1)!),
        randomBytes,
        sha256Hex,
      },
      now: () => 1_000,
      keychainAccessible: 999,
    },
    values,
    getItem,
    setItem,
    randomBytes,
    sha256Hex,
  };
}

beforeEach(() => {
  native.values.clear();
  vi.clearAllMocks();
});

describe('secure push installation adapter', () => {
  it('dérive une identité propriétaire opaque sans persister les identifiants bruts', async () => {
    await expect(deriveSecurePushOwnerKey('company-secret', 'user-secret')).resolves.toMatch(
      /^v1:[0-9a-f]{64}$/u,
    );
    expect(native.digestStringAsync).toHaveBeenCalledWith(
      'SHA-256',
      '["company-secret","user-secret"]',
      { encoding: 'hex' },
    );
  });
  it('reste lazy et conserve un singleton sans accéder au coffre', () => {
    const first = getSecurePushInstallationStore();
    const second = getSecurePushInstallationStore();

    expect(first).toBe(second);
    expect(native.isAvailableAsync).not.toHaveBeenCalled();
    expect(native.getRandomValues).not.toHaveBeenCalled();
  });

  it('utilise le Keychain/Keystore this-device-only et un secret CSPRNG de 32 octets', async () => {
    const store = createSecurePushInstallationStore();
    const token = 'ExponentPushToken[native-wrapper-token]';

    await store.load();
    await store.prepareBinding('company-1:user-1', token);

    expect(native.isAvailableAsync).toHaveBeenCalledOnce();
    expect(native.getRandomValues).toHaveBeenCalledOnce();
    expect(native.getRandomValues.mock.calls[0]?.[0]).toHaveLength(32);
    expect(native.digestStringAsync).toHaveBeenCalledWith('SHA-256', token, { encoding: 'hex' });
    expect(native.setItemAsync).toHaveBeenCalledWith(
      'bob.push.installation.v1',
      expect.any(String),
      {
        keychainAccessible: 'when-unlocked-this-device-only',
        keychainService: 'bob.push.installation.v1',
      },
    );
    expect(JSON.parse(native.values.get('bob.push.installation.v1') ?? '{}')).toMatchObject({
      revocationSecret: 'ab'.repeat(32),
    });
    expect(native.values.get('bob.push.installation.v1')).not.toContain(token);
  });

  it('persiste uniquement le SHA-256 du token Expo, jamais sa valeur brute', async () => {
    const { dependencies, values, sha256Hex } = createDependencies();
    const store = createSecurePushInstallationStore(dependencies);
    const token = 'ExponentPushToken[ultra-secret-device-token]';

    const candidate = await store.prepareBinding('company-1:user-1', token);

    expect(candidate.expoPushToken).toBe(token);
    expect(sha256Hex).toHaveBeenCalledWith(token);
    for (const [key, value] of values) {
      expect(key).not.toContain(token);
      expect(value).not.toContain(token);
    }
    await expect(store.snapshot()).resolves.toMatchObject({
      active: { expoPushTokenFingerprint: '11'.repeat(32) },
    });
  });

  it('échoue fermé avant toute lecture ou écriture si SecureStore est indisponible', async () => {
    const { dependencies, getItem, setItem } = createDependencies({ available: false });
    const store = createSecurePushInstallationStore(dependencies);

    await expect(store.load()).rejects.toEqual(
      new PushInstallationSecureStoreError('secure_store_unavailable'),
    );
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('rejette un token brut à la frontière de persistance, y compris pendant une quarantaine', async () => {
    const { dependencies, values, setItem } = createDependencies();
    values.set(
      'bob.push.installation.v1',
      '{"legacy":"ExponentPushToken[raw-token-must-not-survive]"}',
    );
    const store = createSecurePushInstallationStore(dependencies);

    await expect(store.load()).rejects.toEqual(
      new PushInstallationSecureStoreError('plaintext_token_rejected'),
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it('rejette un CSPRNG absent ou une sortie qui ne contient pas exactement 256 bits', async () => {
    const throwing = createDependencies({
      randomBytes: () => {
        throw new Error('native crypto unavailable');
      },
    });
    const short = createDependencies({
      randomBytes: () => new Uint8Array(31),
    });

    await expect(createSecurePushInstallationStore(throwing.dependencies).load()).rejects.toEqual(
      new PushInstallationSecureStoreError('crypto_unavailable'),
    );
    await expect(createSecurePushInstallationStore(short.dependencies).load()).rejects.toEqual(
      new PushInstallationSecureStoreError('crypto_unavailable'),
    );
  });

  it('échoue fermé si le générateur UUID natif est indisponible', async () => {
    const { dependencies } = createDependencies({
      uuidV4: () => {
        throw new Error('native uuid unavailable');
      },
    });

    await expect(createSecurePushInstallationStore(dependencies).load()).rejects.toEqual(
      new PushInstallationSecureStoreError('crypto_unavailable'),
    );
  });

  it('échoue fermé lorsque SHA-256 natif est indisponible', async () => {
    const { dependencies, values } = createDependencies({
      sha256Hex: async () => {
        throw new Error('native digest unavailable');
      },
    });
    const store = createSecurePushInstallationStore(dependencies);

    await expect(
      store.prepareBinding('company-1:user-1', 'ExponentPushToken[token-12345]'),
    ).rejects.toEqual(new PushInstallationSecureStoreError('crypto_unavailable'));
    expect([...values.values()].join('\n')).not.toContain('ExponentPushToken[token-12345]');
  });
});
