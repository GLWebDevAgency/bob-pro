import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(async (key: string) => native.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    native.values.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    native.values.delete(key);
  }),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: native.getItemAsync,
  setItemAsync: native.setItemAsync,
  deleteItemAsync: native.deleteItemAsync,
}));

import { KNOWN_TIP_KEYS, resetAllTips } from './tips';

describe('resetAllTips', () => {
  it('efface toutes les clés du registre — une astuce déjà fermée redevient visible', async () => {
    for (const key of KNOWN_TIP_KEYS) native.values.set(key, 'dismissed');

    await resetAllTips();

    for (const key of KNOWN_TIP_KEYS) {
      expect(native.deleteItemAsync).toHaveBeenCalledWith(key);
      expect(native.values.has(key)).toBe(false);
    }
  });

  it('une clé illisible n’empêche pas les autres (best-effort)', async () => {
    native.deleteItemAsync.mockImplementationOnce(async () => {
      throw new Error('stockage indisponible');
    });

    await expect(resetAllTips()).resolves.toBeUndefined();
  });
});
