import { describe, expect, it, vi } from 'vitest';
import { CatalogueStorageError, type CatalogueKeyValueStore } from './catalogue-storage';
import {
  CatalogueLegacyMigrator,
  LEGACY_CATALOGUE_ASYNC_STORAGE_KEY,
  LEGACY_CATALOGUE_QUARANTINE_KEY,
} from './catalogue-legacy-migrator';

const LEGACY = JSON.stringify([
  {
    id: 'perso-1',
    label: 'Entretien chaudière',
    category: 'labor',
    unit: 'forfait',
    unitPriceHT: 13_000,
    vatRate: 10,
  },
]);

function digest(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
}

function harness(
  input: {
    legacy?: string;
    sourceRemoveFails?: boolean;
    quarantineSetFails?: boolean;
    quarantineRemoveFails?: boolean;
  } = {},
) {
  const source = new Map<string, string>();
  const secure = new Map<string, string>();
  if (input.legacy !== undefined) source.set(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY, input.legacy);
  const sourcePort = {
    get: vi.fn(async (key: string) => source.get(key) ?? null),
    remove: vi.fn(async (key: string) => {
      if (input.sourceRemoveFails) throw new Error('remove failed');
      source.delete(key);
    }),
  };
  const quarantine: CatalogueKeyValueStore = {
    get: vi.fn(async (key: string) => secure.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      if (input.quarantineSetFails) throw new CatalogueStorageError('write_failed');
      secure.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      if (input.quarantineRemoveFails) throw new CatalogueStorageError('clear_failed');
      secure.delete(key);
    }),
  };
  const migrator = new CatalogueLegacyMigrator(sourcePort, quarantine, {
    sha256: async (value) => digest(value),
    now: () => 1_720_000_000_000,
  });
  return { migrator, source, secure, sourcePort, quarantine, input };
}

describe('CatalogueLegacyMigrator', () => {
  it('déplace le blob opaque dans la quarantaine avant de supprimer la source globale', async () => {
    const { migrator, source, secure, sourcePort, quarantine } = harness({ legacy: LEGACY });

    await expect(migrator.prepare()).resolves.toEqual({
      kind: 'protected_unattributed',
      quarantinedAt: 1_720_000_000_000,
      retention: 'until_user_deletes',
    });

    expect(source.has(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY)).toBe(false);
    expect(secure.has(LEGACY_CATALOGUE_QUARANTINE_KEY)).toBe(true);
    expect(quarantine.set).toHaveBeenCalledBefore(sourcePort.remove);
    // Même un JSON corrompu est protégé comme blob opaque : aucune fausse migration vide.
    const corrupt = harness({ legacy: '{not-json' });
    await expect(corrupt.migrator.prepare()).resolves.toMatchObject({
      kind: 'protected_unattributed',
    });
  });

  it("conserve intégralement la source si l'écriture chiffrée échoue", async () => {
    const { migrator, source, sourcePort } = harness({
      legacy: LEGACY,
      quarantineSetFails: true,
    });

    await expect(migrator.prepare()).rejects.toEqual(new CatalogueStorageError('write_failed'));
    expect(source.get(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY)).toBe(LEGACY);
    expect(sourcePort.remove).not.toHaveBeenCalled();
  });

  it('reprend idempotemment après un échec de suppression sans dupliquer ni réécrire', async () => {
    const state = harness({ legacy: LEGACY, sourceRemoveFails: true });
    await expect(state.migrator.prepare()).resolves.toMatchObject({
      kind: 'protection_incomplete',
    });
    expect(state.secure.size).toBe(1);

    state.input.sourceRemoveFails = false;
    await expect(state.migrator.prepare()).resolves.toMatchObject({
      kind: 'protected_unattributed',
    });
    expect(state.secure.size).toBe(1);
    expect(state.quarantine.set).toHaveBeenCalledTimes(1);
    expect(state.source.size).toBe(0);
  });

  it("bloque un second blob différent au lieu d'écraser la première archive", async () => {
    const state = harness({ legacy: LEGACY, sourceRemoveFails: true });
    await state.migrator.prepare();
    state.source.set(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY, 'different-legacy');
    state.input.sourceRemoveFails = false;

    await expect(state.migrator.prepare()).resolves.toEqual({ kind: 'blocked' });
    expect(state.source.get(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY)).toBe('different-legacy');
    expect(state.quarantine.set).toHaveBeenCalledTimes(1);
  });

  it('ne supprime la quarantaine que sur demande explicite et vérifie la disparition', async () => {
    const state = harness({ legacy: LEGACY });
    await state.migrator.prepare();

    await state.migrator.discard();

    expect(state.source.size).toBe(0);
    expect(state.secure.size).toBe(0);
    await expect(state.migrator.prepare()).resolves.toEqual({ kind: 'none' });
  });

  it('conserve une archive chiffrée si sa suppression échoue et permet un retry', async () => {
    const state = harness({ legacy: LEGACY });
    await state.migrator.prepare();
    state.input.quarantineRemoveFails = true;

    await expect(state.migrator.discard()).rejects.toEqual(
      new CatalogueStorageError('clear_failed'),
    );
    expect(state.secure.has(LEGACY_CATALOGUE_QUARANTINE_KEY)).toBe(true);

    state.input.quarantineRemoveFails = false;
    await expect(state.migrator.discard()).resolves.toBeUndefined();
    expect(state.secure.size).toBe(0);
  });

  it('ne chiffre pas un blob historique au-delà de la limite défensive', async () => {
    const oversized = 'x'.repeat(1_000_001);
    const state = harness({ legacy: oversized });

    await expect(state.migrator.prepare()).resolves.toEqual({ kind: 'blocked' });
    expect(state.source.get(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY)).toBe(oversized);
    expect(state.quarantine.set).not.toHaveBeenCalled();
  });
});
