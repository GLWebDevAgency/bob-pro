import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { PushInstallationStore, type PushInstallationKv } from './push-installation';

const PUSH_KEYCHAIN_SERVICE = 'bob.push.installation.v1';
const REVOCATION_SECRET_BYTES = 32;
const RAW_EXPO_PUSH_TOKEN = /Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,512}\]/u;
const SHA_256_HEX = /^[0-9a-f]{64}$/u;

export type PushInstallationSecureStoreErrorCode =
  'secure_store_unavailable' | 'plaintext_token_rejected' | 'crypto_unavailable';

/** Erreur sans donnée sensible, exploitable par le runtime pour rester fail-closed. */
export class PushInstallationSecureStoreError extends Error {
  constructor(readonly code: PushInstallationSecureStoreErrorCode) {
    super(code);
    this.name = 'PushInstallationSecureStoreError';
  }
}

export interface PushInstallationSecureStoreDependencies {
  readonly secureStore: {
    isAvailable(): Promise<boolean>;
    getItem(key: string, options: SecureStore.SecureStoreOptions): Promise<string | null>;
    setItem(key: string, value: string, options: SecureStore.SecureStoreOptions): Promise<void>;
  };
  readonly crypto: {
    uuidV4(): string;
    randomBytes(byteCount: number): Uint8Array;
    sha256Hex(value: string): Promise<string>;
  };
  readonly now: () => number;
  readonly keychainAccessible: SecureStore.KeychainAccessibilityConstant;
}

function containsRawPushToken(value: string): boolean {
  return RAW_EXPO_PUSH_TOKEN.test(value);
}

function bytesToHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

function createEncryptedKv(
  dependencies: PushInstallationSecureStoreDependencies,
): PushInstallationKv {
  const options: SecureStore.SecureStoreOptions = {
    keychainAccessible: dependencies.keychainAccessible,
    keychainService: PUSH_KEYCHAIN_SERVICE,
  };
  let availability: Promise<boolean> | null = null;

  const requireAvailable = async (): Promise<void> => {
    availability ??= dependencies.secureStore.isAvailable().catch(() => {
      // Une indisponibilité native transitoire pourra être retestée au prochain appel. L'opération
      // courante échoue toujours fermée et aucune mémoire/AsyncStorage de secours n'est utilisée.
      availability = null;
      throw new PushInstallationSecureStoreError('secure_store_unavailable');
    });
    if (!(await availability)) {
      throw new PushInstallationSecureStoreError('secure_store_unavailable');
    }
  };

  const assertNoPlaintextToken = (value: string): void => {
    if (containsRawPushToken(value)) {
      throw new PushInstallationSecureStoreError('plaintext_token_rejected');
    }
  };

  return {
    getItem: async (key) => {
      assertNoPlaintextToken(key);
      await requireAvailable();
      return dependencies.secureStore.getItem(key, options);
    },
    setItem: async (key, value) => {
      assertNoPlaintextToken(key);
      assertNoPlaintextToken(value);
      await requireAvailable();
      await dependencies.secureStore.setItem(key, value, options);
    },
  };
}

const nativeDependencies: PushInstallationSecureStoreDependencies = {
  secureStore: {
    isAvailable: () => SecureStore.isAvailableAsync(),
    getItem: (key, options) => SecureStore.getItemAsync(key, options),
    setItem: (key, value, options) => SecureStore.setItemAsync(key, value, options),
  },
  crypto: {
    uuidV4: () => Crypto.randomUUID(),
    // `getRandomValues` appelle directement le CSPRNG natif. Contrairement à
    // `getRandomBytes`, il n'a aucun repli Math.random dans un debugger de développement.
    randomBytes: (byteCount) => Crypto.getRandomValues(new Uint8Array(byteCount)),
    sha256Hex: (value) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, {
        encoding: Crypto.CryptoEncoding.HEX,
      }),
  },
  now: () => Date.now(),
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Fabrique testable du registre push durable.
 *
 * Seul le fingerprint SHA-256 du token Expo traverse le store pur. Une garde supplémentaire
 * refuse tout token Expo brut qui atteindrait malgré tout la frontière de persistance chiffrée.
 */
export function createSecurePushInstallationStore(
  dependencies: PushInstallationSecureStoreDependencies = nativeDependencies,
): PushInstallationStore {
  const kv = createEncryptedKv(dependencies);
  return new PushInstallationStore(
    kv,
    {
      uuidV4: () => {
        try {
          return dependencies.crypto.uuidV4();
        } catch {
          throw new PushInstallationSecureStoreError('crypto_unavailable');
        }
      },
      secretHex: () => {
        let bytes: Uint8Array;
        try {
          bytes = dependencies.crypto.randomBytes(REVOCATION_SECRET_BYTES);
        } catch {
          throw new PushInstallationSecureStoreError('crypto_unavailable');
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== REVOCATION_SECRET_BYTES) {
          throw new PushInstallationSecureStoreError('crypto_unavailable');
        }
        return bytesToHex(bytes);
      },
      sha256Hex: async (value) => {
        try {
          return await dependencies.crypto.sha256Hex(value);
        } catch {
          throw new PushInstallationSecureStoreError('crypto_unavailable');
        }
      },
    },
    dependencies.now,
  );
}

let singleton: PushInstallationStore | null = null;

/** Lazy : l'import du module ne touche ni le Keychain/Keystore ni le CSPRNG. */
export function getSecurePushInstallationStore(): PushInstallationStore {
  singleton ??= createSecurePushInstallationStore();
  return singleton;
}

/** Empreinte locale opaque : aucun identifiant société/utilisateur n'est persisté dans le coffre. */
export async function deriveSecurePushOwnerKey(companyId: string, userId: string): Promise<string> {
  if (companyId.length < 1 || companyId.length > 128 || userId.length < 1 || userId.length > 256) {
    throw new PushInstallationSecureStoreError('crypto_unavailable');
  }
  try {
    const digest = (
      await nativeDependencies.crypto.sha256Hex(JSON.stringify([companyId, userId]))
    ).toLowerCase();
    if (!SHA_256_HEX.test(digest)) throw new Error('invalid digest');
    return `v1:${digest}`;
  } catch {
    throw new PushInstallationSecureStoreError('crypto_unavailable');
  }
}
