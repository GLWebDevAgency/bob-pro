import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  GenerationQuoteDraftStore,
  QuoteDraftStoreError,
  type QuoteDraftKeyValueStore,
  type QuoteDraftPersistence,
} from './quote-draft-store';

const OPTIONS: SecureStore.SecureStoreOptions = {
  // Un brouillon financier ne migre pas dans une sauvegarde vers un autre appareil.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let availability: Promise<boolean> | null = null;

async function requireSecureStore(): Promise<void> {
  availability ??= SecureStore.isAvailableAsync().catch((error: unknown) => {
    availability = null;
    throw error;
  });
  if (!(await availability)) throw new QuoteDraftStoreError('unavailable');
}

const encryptedNativeStore: QuoteDraftKeyValueStore = {
  get: async (key) => {
    await requireSecureStore();
    return SecureStore.getItemAsync(key, OPTIONS);
  },
  set: async (key, value) => {
    await requireSecureStore();
    await SecureStore.setItemAsync(key, value, OPTIONS);
  },
  remove: async (key) => {
    await requireSecureStore();
    await SecureStore.deleteItemAsync(key, OPTIONS);
  },
};

/**
 * Adaptateur production : chiffrement matériel/Keystore par Expo SecureStore et SHA-256 natif.
 * Aucun repli AsyncStorage n'existe : une plateforme sans coffre reste mémoire-only et l'UI
 * annonce l'échec au moment d'enregistrer.
 */
export function createSecureQuoteDraftPersistence(): QuoteDraftPersistence {
  return new GenerationQuoteDraftStore(encryptedNativeStore, {
    sha256: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
  });
}
