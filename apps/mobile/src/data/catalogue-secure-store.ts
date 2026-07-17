import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { CatalogueStorageError, type CatalogueKeyValueStore } from './catalogue-storage';

const CIPHER_VERSION = 1 as const;
const CIPHER_ALGORITHM = 'A256GCM' as const;
const MASTER_KEY_NAME = 'bob.catalogue.crypto.master.v1';
const CIPHERTEXT_PREFIX = 'bob.catalogue.encrypted.v1';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const LOGICAL_KEY = /^[A-Za-z0-9._-]{1,180}$/u;

/**
 * Plafond défensif du blob chiffré. Le catalogue métier est borné séparément par son parseur ;
 * cette limite protège surtout d'une valeur AsyncStorage hostile avant allocation/déchiffrement.
 */
export const CATALOGUE_ENCRYPTED_VALUE_MAX_BYTES = 1_000_000;

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  // Les prix de l'entreprise ne migrent jamais via une sauvegarde vers un autre appareil.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

interface EncryptedEnvelopeV1 {
  readonly version: typeof CIPHER_VERSION;
  readonly algorithm: typeof CIPHER_ALGORITHM;
  readonly ciphertext: string;
}

export interface CatalogueCipher {
  readonly encrypt: (plaintext: string, associatedData: string) => Promise<string>;
  readonly decrypt: (ciphertext: string, associatedData: string) => Promise<string>;
}

export interface CatalogueCiphertextStore {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function physicalKey(logicalKey: string): string {
  if (!LOGICAL_KEY.test(logicalKey)) throw new CatalogueStorageError('invalid_payload');
  return `${CIPHERTEXT_PREFIX}.${logicalKey}`;
}

function encodeEnvelope(ciphertext: string): string {
  if (!BASE64.test(ciphertext) || ciphertext.length > CATALOGUE_ENCRYPTED_VALUE_MAX_BYTES * 2) {
    throw new CatalogueStorageError('payload_too_large');
  }
  return JSON.stringify({
    version: CIPHER_VERSION,
    algorithm: CIPHER_ALGORITHM,
    ciphertext,
  } satisfies EncryptedEnvelopeV1);
}

function decodeEnvelope(raw: string): EncryptedEnvelopeV1 {
  if (utf8Bytes(raw) > CATALOGUE_ENCRYPTED_VALUE_MAX_BYTES * 2) {
    throw new CatalogueStorageError('payload_too_large');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new CatalogueStorageError('invalid_payload');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'algorithm', 'ciphertext']) ||
    value['version'] !== CIPHER_VERSION ||
    value['algorithm'] !== CIPHER_ALGORITHM ||
    typeof value['ciphertext'] !== 'string' ||
    !BASE64.test(value['ciphertext']) ||
    value['ciphertext'].length > CATALOGUE_ENCRYPTED_VALUE_MAX_BYTES * 2
  ) {
    throw new CatalogueStorageError('invalid_payload');
  }
  return {
    version: CIPHER_VERSION,
    algorithm: CIPHER_ALGORITHM,
    ciphertext: value['ciphertext'],
  };
}

/**
 * Adaptateur générique : AsyncStorage ne reçoit que de l'AES-GCM authentifié. L'AAD lie le
 * ciphertext à sa clé logique ; copier un blob d'un tenant vers un autre échoue au déchiffrement.
 */
export class EncryptedCatalogueKeyValueStore implements CatalogueKeyValueStore {
  constructor(
    private readonly ciphertextStore: CatalogueCiphertextStore,
    private readonly cipher: CatalogueCipher,
  ) {}

  async get(logicalKey: string): Promise<string | null> {
    const key = physicalKey(logicalKey);
    let raw: string | null;
    try {
      raw = await this.ciphertextStore.get(key);
    } catch {
      throw new CatalogueStorageError('unavailable');
    }
    if (raw === null) return null;
    const envelope = decodeEnvelope(raw);
    try {
      const plaintext = await this.cipher.decrypt(envelope.ciphertext, logicalKey);
      if (utf8Bytes(plaintext) > CATALOGUE_ENCRYPTED_VALUE_MAX_BYTES) {
        throw new CatalogueStorageError('payload_too_large');
      }
      return plaintext;
    } catch (error: unknown) {
      if (error instanceof CatalogueStorageError) throw error;
      throw new CatalogueStorageError('invalid_payload');
    }
  }

  async set(logicalKey: string, value: string): Promise<void> {
    if (utf8Bytes(value) > CATALOGUE_ENCRYPTED_VALUE_MAX_BYTES) {
      throw new CatalogueStorageError('payload_too_large');
    }
    const key = physicalKey(logicalKey);
    let encoded: string;
    try {
      encoded = encodeEnvelope(await this.cipher.encrypt(value, logicalKey));
      await this.ciphertextStore.set(key, encoded);
      // Read-after-write obligatoire : certains bridges de stockage peuvent résoudre après une
      // écriture tronquée/no-op. Le store métier ne publie jamais une révision non relisible.
      const persisted = await this.ciphertextStore.get(key);
      if (persisted !== encoded) throw new CatalogueStorageError('write_failed');
    } catch (error: unknown) {
      if (error instanceof CatalogueStorageError) throw error;
      throw new CatalogueStorageError('write_failed');
    }
  }

  async remove(logicalKey: string): Promise<void> {
    const key = physicalKey(logicalKey);
    try {
      await this.ciphertextStore.remove(key);
      if ((await this.ciphertextStore.get(key)) !== null) {
        throw new CatalogueStorageError('clear_failed');
      }
    } catch (error: unknown) {
      if (error instanceof CatalogueStorageError) throw error;
      throw new CatalogueStorageError('clear_failed');
    }
  }
}

let masterKeyPromise: Promise<Crypto.AESEncryptionKey> | null = null;
let secureStoreAvailability: Promise<boolean> | null = null;

async function requireSecureStore(): Promise<void> {
  secureStoreAvailability ??= SecureStore.isAvailableAsync().catch((error: unknown) => {
    secureStoreAvailability = null;
    throw error;
  });
  if (!(await secureStoreAvailability)) throw new CatalogueStorageError('unavailable');
}

async function loadOrCreateMasterKey(): Promise<Crypto.AESEncryptionKey> {
  await requireSecureStore();
  const stored = await SecureStore.getItemAsync(MASTER_KEY_NAME, SECURE_STORE_OPTIONS);
  if (stored !== null) {
    try {
      return await Crypto.AESEncryptionKey.import(stored, 'base64');
    } catch {
      throw new CatalogueStorageError('invalid_payload');
    }
  }

  const generated = await Crypto.AESEncryptionKey.generate(Crypto.AESKeySize.AES256);
  const encoded = await generated.encoded('base64');
  await SecureStore.setItemAsync(MASTER_KEY_NAME, encoded, SECURE_STORE_OPTIONS);
  // Une seconde initialisation concurrente/process kill ne doit jamais laisser le runtime avec
  // une clé différente de celle durablement publiée dans le Keystore.
  const committed = await SecureStore.getItemAsync(MASTER_KEY_NAME, SECURE_STORE_OPTIONS);
  if (committed === null) throw new CatalogueStorageError('unavailable');
  try {
    return await Crypto.AESEncryptionKey.import(committed, 'base64');
  } catch {
    throw new CatalogueStorageError('invalid_payload');
  }
}

async function masterKey(): Promise<Crypto.AESEncryptionKey> {
  masterKeyPromise ??= loadOrCreateMasterKey().catch((error: unknown) => {
    masterKeyPromise = null;
    throw error;
  });
  return masterKeyPromise;
}

const nativeCipher: CatalogueCipher = {
  encrypt: async (plaintext, associatedData) => {
    try {
      const sealed = await Crypto.aesEncryptAsync(
        new TextEncoder().encode(plaintext),
        await masterKey(),
        {
          nonce: { length: 12 },
          tagLength: 16,
          additionalData: new TextEncoder().encode(associatedData),
        },
      );
      return sealed.combined('base64');
    } catch (error: unknown) {
      if (error instanceof CatalogueStorageError) throw error;
      throw new CatalogueStorageError('unavailable');
    }
  },
  decrypt: async (ciphertext, associatedData) => {
    try {
      const sealed = Crypto.AESSealedData.fromCombined(ciphertext, {
        ivLength: 12,
        tagLength: 16,
      });
      const plaintext = await Crypto.aesDecryptAsync(sealed, await masterKey(), {
        additionalData: new TextEncoder().encode(associatedData),
      });
      return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } catch (error: unknown) {
      if (error instanceof CatalogueStorageError) throw error;
      throw new CatalogueStorageError('invalid_payload');
    }
  },
};

const nativeCiphertextStore: CatalogueCiphertextStore = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};

/** Adaptateur production : clé AES-256 device-only en SecureStore, payload AES-GCM en AsyncStorage. */
export function createSecureCatalogueKeyValueStore(): CatalogueKeyValueStore {
  return new EncryptedCatalogueKeyValueStore(nativeCiphertextStore, nativeCipher);
}

/** Test uniquement : réinitialise les singletons natifs entre cas Vitest. */
export function resetCatalogueSecureStoreForTests(): void {
  masterKeyPromise = null;
  secureStoreAvailability = null;
}
