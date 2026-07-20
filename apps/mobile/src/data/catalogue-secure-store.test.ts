import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const asyncValues = new Map<string, string>();
  const secureValues = new Map<string, string>();
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');
  const decode = (value: string): unknown => JSON.parse(Buffer.from(value, 'base64').toString());
  const generate = vi.fn(async () => ({
    value: 'generated-master-key',
    encoded: vi.fn(async () => Buffer.from('generated-master-key').toString('base64')),
  }));
  const importKey = vi.fn(async (value: string) => ({
    value: Buffer.from(value, 'base64').toString(),
    encoded: vi.fn(async () => value),
  }));
  const encrypt = vi.fn(
    async (
      plaintext: Uint8Array,
      key: { value: string },
      options: {
        additionalData?: Uint8Array;
      },
    ) => ({
      combined: vi.fn(async () =>
        encode({
          key: key.value,
          aad: [...(options.additionalData ?? [])],
          plaintext: [...plaintext],
        }),
      ),
    }),
  );
  const fromCombined = vi.fn((ciphertext: string) => ({ ciphertext }));
  const decrypt = vi.fn(
    async (
      sealed: { ciphertext: string },
      key: { value: string },
      options: { additionalData?: Uint8Array },
    ) => {
      const payload = decode(sealed.ciphertext) as {
        key: string;
        aad: number[];
        plaintext: number[];
      };
      if (
        payload.key !== key.value ||
        JSON.stringify(payload.aad) !== JSON.stringify([...(options.additionalData ?? [])])
      ) {
        throw new Error('authentication failed');
      }
      return new Uint8Array(payload.plaintext);
    },
  );
  return {
    asyncValues,
    secureValues,
    generate,
    importKey,
    encrypt,
    fromCombined,
    decrypt,
    isAvailable: vi.fn(async () => true),
    secureGet: vi.fn(async (key: string) => secureValues.get(key) ?? null),
    secureSet: vi.fn(async (key: string, value: string) => {
      secureValues.set(key, value);
    }),
    asyncGet: vi.fn(async (key: string) => asyncValues.get(key) ?? null),
    asyncSet: vi.fn(async (key: string, value: string) => {
      asyncValues.set(key, value);
    }),
    asyncRemove: vi.fn(async (key: string) => {
      asyncValues.delete(key);
    }),
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: native.asyncGet,
    setItem: native.asyncSet,
    removeItem: native.asyncRemove,
  },
}));

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  isAvailableAsync: native.isAvailable,
  getItemAsync: native.secureGet,
  setItemAsync: native.secureSet,
}));

vi.mock('expo-crypto', () => ({
  AESKeySize: { AES256: 256 },
  AESEncryptionKey: {
    generate: native.generate,
    import: native.importKey,
  },
  AESSealedData: { fromCombined: native.fromCombined },
  aesEncryptAsync: native.encrypt,
  aesDecryptAsync: native.decrypt,
}));

import { CatalogueStorageError } from './catalogue-storage';
import {
  createSecureCatalogueKeyValueStore,
  EncryptedCatalogueKeyValueStore,
  resetCatalogueSecureStoreForTests,
} from './catalogue-secure-store';

beforeEach(() => {
  native.asyncValues.clear();
  native.secureValues.clear();
  for (const mock of [
    native.generate,
    native.importKey,
    native.encrypt,
    native.fromCombined,
    native.decrypt,
    native.isAvailable,
    native.secureGet,
    native.secureSet,
    native.asyncGet,
    native.asyncSet,
    native.asyncRemove,
  ]) {
    mock.mockClear();
  }
  native.isAvailable.mockResolvedValue(true);
  resetCatalogueSecureStoreForTests();
});

describe('EncryptedCatalogueKeyValueStore', () => {
  function memoryStore() {
    const values = new Map<string, string>();
    const cipher = {
      encrypt: vi.fn(async (value: string, aad: string) =>
        Buffer.from(JSON.stringify({ value, aad })).toString('base64'),
      ),
      decrypt: vi.fn(async (value: string, aad: string) => {
        const decoded = JSON.parse(Buffer.from(value, 'base64').toString()) as {
          value: string;
          aad: string;
        };
        if (decoded.aad !== aad) throw new Error('authentication failed');
        return decoded.value;
      }),
    };
    return {
      values,
      cipher,
      store: new EncryptedCatalogueKeyValueStore(
        {
          get: async (key) => values.get(key) ?? null,
          set: async (key, value) => {
            values.set(key, value);
          },
          remove: async (key) => {
            values.delete(key);
          },
        },
        cipher,
      ),
    };
  }

  it('ne persiste jamais le libellé/prix en clair et relit la valeur authentifiée', async () => {
    const { store, values } = memoryStore();
    const payload = JSON.stringify({ label: 'Secret plomberie', unitPriceHT: 6_500 });

    await store.set('bob.catalogue.perso.v2.' + 'a'.repeat(64), payload);

    expect(JSON.stringify([...values.entries()])).not.toContain('Secret plomberie');
    await expect(store.get('bob.catalogue.perso.v2.' + 'a'.repeat(64))).resolves.toBe(payload);
  });

  it('lie le ciphertext à sa clé logique et refuse un échange entre deux scopes', async () => {
    const { store, values } = memoryStore();
    const a = 'bob.catalogue.perso.v2.' + 'a'.repeat(64);
    const b = 'bob.catalogue.perso.v2.' + 'b'.repeat(64);
    await store.set(a, 'tenant-a');
    const [[, raw]] = [...values.entries()];
    values.set(`bob.catalogue.encrypted.v1.${b}`, raw!);

    await expect(store.get(b)).rejects.toEqual(new CatalogueStorageError('invalid_payload'));
  });

  it("ne confirme pas une écriture que le stockage n'a pas durablement publiée", async () => {
    const store = new EncryptedCatalogueKeyValueStore(
      {
        get: async () => null,
        set: async () => undefined,
        remove: async () => undefined,
      },
      { encrypt: async () => 'YQ==', decrypt: async () => 'unused' },
    );

    await expect(store.set('valid-key', 'payload')).rejects.toEqual(
      new CatalogueStorageError('write_failed'),
    );
  });
});

describe('adaptateur natif catalogue', () => {
  it('garde seulement la clé AES-256 dans SecureStore device-only et le blob chiffré ailleurs', async () => {
    const store = createSecureCatalogueKeyValueStore();
    const logicalKey = 'bob.catalogue.perso.v2.' + 'c'.repeat(64);
    const payload = JSON.stringify({ label: 'Entretien chaudière', unitPriceHT: 13_000 });

    await store.set(logicalKey, payload);
    await expect(store.get(logicalKey)).resolves.toBe(payload);

    expect(native.generate).toHaveBeenCalledOnce();
    expect(native.secureSet).toHaveBeenCalledWith(
      'bob.catalogue.crypto.master.v1',
      expect.any(String),
      { keychainAccessible: 'when-unlocked-this-device-only' },
    );
    const asyncDump = JSON.stringify([...native.asyncValues.entries()]);
    expect(asyncDump).not.toContain('Entretien chaudière');
    expect(asyncDump).not.toContain('13000');
    expect(native.encrypt).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Object),
      expect.objectContaining({
        nonce: { length: 12 },
        tagLength: 16,
        additionalData: expect.any(Uint8Array),
      }),
    );
  });

  it('échoue fermé si le coffre matériel est indisponible', async () => {
    native.isAvailable.mockResolvedValueOnce(false);
    const store = createSecureCatalogueKeyValueStore();

    await expect(store.set('valid-key', 'payload')).rejects.toEqual(
      new CatalogueStorageError('unavailable'),
    );
    expect(native.asyncSet).not.toHaveBeenCalled();
  });
});
