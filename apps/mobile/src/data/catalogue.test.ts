import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOGUE_STORAGE_SCHEMA_VERSION,
  ScopedCatalogueStore,
  readCustomPrestations,
  resolveCatalogueStorageIdentity,
  type CatalogueStorageIdentity,
} from './catalogue-storage';

describe('readCustomPrestations', () => {
  const getItem = vi.fn<() => Promise<string | null>>();

  beforeEach(() => getItem.mockReset());

  it('distingue un catalogue neuf d’un stockage illisible', async () => {
    getItem.mockResolvedValueOnce(null);
    await expect(readCustomPrestations(getItem)).resolves.toEqual([]);

    getItem.mockRejectedValueOnce(new Error('secure storage unavailable'));
    await expect(readCustomPrestations(getItem)).rejects.toThrow('secure storage unavailable');
  });

  it('relit uniquement un tableau entièrement valide', async () => {
    const prestation = {
      id: 'perso-1',
      label: 'Pose chauffe-eau',
      category: 'labor',
      unit: 'heure',
      unitPriceHT: 6_500,
      vatRate: 10,
    };
    getItem.mockResolvedValueOnce(JSON.stringify([prestation]));
    await expect(readCustomPrestations(getItem)).resolves.toEqual([prestation]);
  });

  it.each(['{broken', JSON.stringify({}), JSON.stringify([{ id: 'partial' }])])(
    'refuse une corruption au lieu de la présenter comme un catalogue vide',
    async (raw) => {
      getItem.mockResolvedValueOnce(raw);
      await expect(readCustomPrestations(getItem)).rejects.toThrow();
    },
  );
});

const OWNER_A: CatalogueStorageIdentity = {
  mode: 'authenticated',
  companyId: 'company-1',
  userId: 'user-a',
};
const OWNER_B: CatalogueStorageIdentity = {
  mode: 'authenticated',
  companyId: 'company-1',
  userId: 'user-b',
};
const PRESTATION = {
  id: 'perso-1',
  label: 'Pose chauffe-eau',
  category: 'labor' as const,
  unit: 'heure',
  unitPriceHT: 6_500,
  vatRate: 10 as const,
};

function createStore() {
  const values = new Map<string, string>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const set = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const remove = vi.fn(async (key: string) => {
    values.delete(key);
  });
  const store = new ScopedCatalogueStore(
    { get, set, remove },
    {
      sha256: async (value) => {
        if (value.includes('user-a')) return 'a'.repeat(64);
        if (value.includes('user-b')) return 'b'.repeat(64);
        return 'c'.repeat(64);
      },
    },
  );
  return { store, values, get, set, remove };
}

describe('ScopedCatalogueStore', () => {
  it('échoue fermé sans propriétaire authentifié et ne possède aucun mode démo', () => {
    expect(
      resolveCatalogueStorageIdentity({
        authenticatedCompanyId: OWNER_A.companyId,
        authenticatedUserId: OWNER_A.userId,
      }),
    ).toEqual(OWNER_A);
    expect(() =>
      resolveCatalogueStorageIdentity({
        authenticatedCompanyId: null,
        authenticatedUserId: null,
      }),
    ).toThrow('catalogue_storage_owner_required');
    expect(() =>
      resolveCatalogueStorageIdentity({
        authenticatedCompanyId: null,
        authenticatedUserId: OWNER_A.userId,
      }),
    ).toThrow('catalogue_storage_owner_required');
  });

  it('canonise avec le parseur core et refuse les prix/textes inutilisables en devis', async () => {
    const { store } = createStore();
    await store.update(OWNER_A, () => [
      { ...PRESTATION, label: '  Pose chauffe-eau  ', unit: '  heure  ' },
    ]);
    await expect(store.load(OWNER_A)).resolves.toMatchObject({
      prestations: [{ ...PRESTATION, label: 'Pose chauffe-eau', unit: 'heure' }],
    });

    await expect(
      store.update(OWNER_A, () => [{ ...PRESTATION, unitPriceHT: 1_500_000_001 }]),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(
      store.update(OWNER_A, () => [{ ...PRESTATION, label: 'Pose\ninterdite' }]),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('isole deux comptes du même appareil sans persister leurs identifiants bruts', async () => {
    const { store, values } = createStore();
    await store.update(OWNER_A, () => [PRESTATION]);

    await expect(store.load(OWNER_A)).resolves.toMatchObject({
      version: CATALOGUE_STORAGE_SCHEMA_VERSION,
      revision: 1,
      prestations: [PRESTATION],
    });
    await expect(store.load(OWNER_B)).resolves.toMatchObject({ revision: 0, prestations: [] });
    const persisted = JSON.stringify([...values.entries()]);
    expect(persisted).not.toContain(OWNER_A.companyId);
    expect(persisted).not.toContain(OWNER_A.userId);
  });

  it("n'adopte jamais la clé globale historique dont l'owner est impossible à prouver", async () => {
    const { store, values, get } = createStore();
    values.set('bob.catalogue.perso', JSON.stringify([PRESTATION]));

    await expect(store.load(OWNER_A)).resolves.toMatchObject({ revision: 0, prestations: [] });
    expect(get).not.toHaveBeenCalledWith('bob.catalogue.perso');
    expect(values.get('bob.catalogue.perso')).toBeDefined();
  });

  it('sérialise deux écritures concurrentes sans perdre une prestation', async () => {
    const { store } = createStore();
    const second = { ...PRESTATION, id: 'perso-2', label: 'Déplacement' };

    await Promise.all([
      store.update(OWNER_A, (current) => [...current, PRESTATION]),
      store.update(OWNER_A, (current) => [...current, second]),
    ]);

    await expect(store.load(OWNER_A)).resolves.toMatchObject({
      revision: 2,
      prestations: [PRESTATION, second],
    });
  });

  it("refuse une enveloppe d'un autre scope ou une identité incomplète", async () => {
    const { store, values } = createStore();
    const key = await store.storageKey(OWNER_A);
    values.set(
      key,
      JSON.stringify({
        version: CATALOGUE_STORAGE_SCHEMA_VERSION,
        scopeHash: 'b'.repeat(64),
        revision: 1,
        prestations: [PRESTATION],
      }),
    );
    await expect(store.load(OWNER_A)).rejects.toMatchObject({
      code: 'invalid_payload',
    });
    await expect(store.load({ ...OWNER_A, userId: '../other-user' })).rejects.toMatchObject({
      code: 'owner_required',
    });
  });
});
