import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  isAvailableAsync: vi.fn(async () => true),
  getItemAsync: vi.fn(async (key: string, _options?: unknown) => native.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string, _options?: unknown) => {
    native.values.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string, _options?: unknown) => {
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

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: vi.fn(async (_algorithm: string, value: string) => {
    // Digest déterministe suffisant pour le contrat d'adapter ; l'intégrité réelle est testée
    // avec SHA-256 Node dans quote-draft-store.test.ts.
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
  }),
}));

import { createQuoteDraft, selectCustomer } from './quote-draft-model';
import { createSecureQuoteDraftPersistence } from './quote-draft-secure-store';

beforeEach(() => {
  native.values.clear();
  native.isAvailableAsync.mockClear();
  native.getItemAsync.mockClear();
  native.setItemAsync.mockClear();
  native.deleteItemAsync.mockClear();
});

describe('Expo SecureStore quote draft adapter', () => {
  it('utilise uniquement le coffre natif this-device et des clés sans identifiants bruts', async () => {
    const identity = {
      mode: 'authenticated' as const,
      userId: 'secret-user-id',
      companyId: 'secret-company-id',
    };
    const selected = selectCustomer(createQuoteDraft('session-1'), {
      id: 'customer-1',
      name: 'Camping Les Pins',
    });
    if (!selected.ok) throw new Error(selected.error.message);
    const persistence = createSecureQuoteDraftPersistence();

    await persistence.save(identity, selected.value, 100);
    expect(native.isAvailableAsync).toHaveBeenCalledOnce();
    expect(native.setItemAsync).toHaveBeenCalled();
    for (const [key, _value, options] of native.setItemAsync.mock.calls) {
      expect(key).not.toContain(identity.userId);
      expect(key).not.toContain(identity.companyId);
      expect(options).toEqual({ keychainAccessible: 'when-unlocked-this-device-only' });
    }
    await expect(persistence.load(identity)).resolves.toMatchObject({
      customer: { id: 'customer-1' },
      saved: { at: 100 },
    });
  });
});
