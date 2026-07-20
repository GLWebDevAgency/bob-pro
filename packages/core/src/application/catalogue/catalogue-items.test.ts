import { describe, expect, it } from 'vitest';
import {
  CreateCatalogueItem,
  DeleteCatalogueItem,
  ListCatalogueItems,
  UpdateCatalogueItem,
  type CatalogueItemWriteInput,
} from './catalogue-items';
import {
  type CatalogueCreateWriteResult,
  type CatalogueDeleteWriteResult,
  type CatalogueItemRecord,
  type CatalogueRepository,
  type CatalogueUpdateWriteResult,
} from './catalogue-repository';
import { type ClockPort, type IdGeneratorPort } from '../ports/services';

const CREATED_AT = '2026-07-17T08:00:00.000Z';
const UPDATED_AT = '2026-07-17T09:00:00.000Z';

const labor: CatalogueItemWriteInput = {
  label: 'Main-d’œuvre plomberie',
  category: 'labor',
  unit: 'heure',
  unitPriceHT: 5_500,
  vatRate: 10,
};

function clone(item: CatalogueItemRecord): CatalogueItemRecord {
  return { ...item };
}

class InMemoryTenantCatalogue implements CatalogueRepository {
  private readonly rows = new Map<string, CatalogueItemRecord>();

  private key(companyId: string, id: string): string {
    return `${companyId}\u0000${id}`;
  }

  seed(item: CatalogueItemRecord): void {
    this.rows.set(this.key(item.companyId, item.id), clone(item));
  }

  snapshot(companyId: string, id: string): CatalogueItemRecord | null {
    const item = this.rows.get(this.key(companyId, id));
    return item ? clone(item) : null;
  }

  async listByCompany(companyId: string): Promise<readonly CatalogueItemRecord[]> {
    return [...this.rows.values()].filter((item) => item.companyId === companyId).map(clone);
  }

  async create(item: CatalogueItemRecord): Promise<CatalogueCreateWriteResult> {
    if ([...this.rows.values()].some((candidate) => candidate.id === item.id)) {
      return { status: 'id_conflict' };
    }
    this.rows.set(this.key(item.companyId, item.id), clone(item));
    return { status: 'created', item: clone(item) };
  }

  async update(
    input: Parameters<CatalogueRepository['update']>[0],
  ): Promise<CatalogueUpdateWriteResult> {
    const key = this.key(input.companyId, input.id);
    const current = this.rows.get(key);
    if (!current) return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    const updated: CatalogueItemRecord = {
      ...input.item,
      createdAt: current.createdAt,
    };
    this.rows.set(key, clone(updated));
    return { status: 'updated', item: clone(updated) };
  }

  async delete(
    input: Parameters<CatalogueRepository['delete']>[0],
  ): Promise<CatalogueDeleteWriteResult> {
    const key = this.key(input.companyId, input.id);
    const current = this.rows.get(key);
    if (!current) return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    this.rows.delete(key);
    return { status: 'deleted' };
  }
}

function clock(now = CREATED_AT): ClockPort {
  return {
    now: () => now,
    today: () => now.slice(0, 10),
  };
}

function ids(...values: string[]): IdGeneratorPort {
  let index = 0;
  return { newId: () => values[index++] ?? 'unexpected-id-generation' };
}

function record(overrides: Partial<CatalogueItemRecord> = {}): CatalogueItemRecord {
  return {
    id: 'catalogue-1',
    companyId: 'company-a',
    ...labor,
    revision: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe('Catalogue propriétaire — CRUD tenant-scoped et CAS', () => {
  it('une liste vide reste vide : aucune suggestion ni aucun prix n’est inventé', async () => {
    const repository = new InMemoryTenantCatalogue();
    const result = await new ListCatalogueItems({ catalogue: repository }).execute({
      companyId: 'company-a',
    });

    expect(result).toEqual({ ok: true, value: [] });
  });

  it('crée uniquement les valeurs fournies, canoniques et sérialisables à la révision 1', async () => {
    const repository = new InMemoryTenantCatalogue();
    const result = await new CreateCatalogueItem({
      catalogue: repository,
      ids: ids('catalogue-1'),
      clock: clock(),
    }).execute({
      companyId: 'company-a',
      item: { ...labor, label: '  Main-d’œuvre plomberie  ', unit: '  heure  ' },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: 'catalogue-1',
        ...labor,
        revision: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    });
    if (!result.ok) throw new Error('Création attendue.');
    expect(JSON.parse(JSON.stringify(result.value))).toEqual(result.value);
    expect(repository.snapshot('company-a', 'catalogue-1')).toMatchObject({
      companyId: 'company-a',
      ...labor,
    });
  });

  it('rejette une prestation invalide sans écrire ni créer de valeur de remplacement', async () => {
    const repository = new InMemoryTenantCatalogue();
    const useCase = new CreateCatalogueItem({
      catalogue: repository,
      ids: ids('catalogue-1'),
      clock: clock(),
    });

    for (const item of [
      { ...labor, unitPriceHT: 0 },
      { ...labor, category: 'subscription' },
      { ...labor, vatRate: 7 },
      { ...labor, label: '   ' },
      { ...labor, unexpected: 'forbidden' },
      { label: labor.label },
      undefined,
    ] as CatalogueItemWriteInput[]) {
      const result = await useCase.execute({ companyId: 'company-a', item });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('validation');
    }
    expect(await repository.listByCompany('company-a')).toEqual([]);
  });

  it('échoue proprement si le générateur produit un id invalide ou déjà présent', async () => {
    const repository = new InMemoryTenantCatalogue();
    repository.seed(record());

    const invalidId = await new CreateCatalogueItem({
      catalogue: repository,
      ids: ids('invalid_id'),
      clock: clock(),
    }).execute({ companyId: 'company-a', item: labor });
    expect(invalidId).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'id_generator',
        cause: 'invalid_catalogue_item_id',
      },
    });

    const collision = await new CreateCatalogueItem({
      catalogue: repository,
      ids: ids('catalogue-1'),
      clock: clock(),
    }).execute({ companyId: 'company-b', item: labor });
    expect(collision).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'catalogue_item', reason: 'id_conflict' },
    });
    expect(await repository.listByCompany('company-b')).toEqual([]);
  });

  it('met à jour par CAS, conserve la vraie date de création et incrémente la révision', async () => {
    const repository = new InMemoryTenantCatalogue();
    repository.seed(record());

    const result = await new UpdateCatalogueItem({
      catalogue: repository,
      clock: clock(UPDATED_AT),
    }).execute({
      companyId: 'company-a',
      itemId: 'catalogue-1',
      expectedRevision: 1,
      item: {
        label: 'Déplacement urgent',
        category: 'travel',
        unit: 'forfait',
        unitPriceHT: 7_500,
        vatRate: 20,
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: 'catalogue-1',
        label: 'Déplacement urgent',
        category: 'travel',
        unit: 'forfait',
        unitPriceHT: 7_500,
        vatRate: 20,
        revision: 2,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
    });
  });

  it('rejette une révision périmée sans perdre la première écriture', async () => {
    const repository = new InMemoryTenantCatalogue();
    repository.seed(record());
    const useCase = new UpdateCatalogueItem({
      catalogue: repository,
      clock: clock(UPDATED_AT),
    });

    const first = await useCase.execute({
      companyId: 'company-a',
      itemId: 'catalogue-1',
      expectedRevision: 1,
      item: { ...labor, unitPriceHT: 6_000 },
    });
    const stale = await useCase.execute({
      companyId: 'company-a',
      itemId: 'catalogue-1',
      expectedRevision: 1,
      item: { ...labor, unitPriceHT: 9_999 },
    });

    expect(first.ok).toBe(true);
    expect(stale).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'catalogue_item', reason: 'stale_revision' },
    });
    expect(repository.snapshot('company-a', 'catalogue-1')?.unitPriceHT).toBe(6_000);
    expect(repository.snapshot('company-a', 'catalogue-1')?.revision).toBe(2);
  });

  it('rend not_found pour toute lecture croisée implicite, mise à jour ou suppression autre tenant', async () => {
    const repository = new InMemoryTenantCatalogue();
    repository.seed(record());

    const list = await new ListCatalogueItems({ catalogue: repository }).execute({
      companyId: 'company-b',
    });
    const update = await new UpdateCatalogueItem({
      catalogue: repository,
      clock: clock(UPDATED_AT),
    }).execute({
      companyId: 'company-b',
      itemId: 'catalogue-1',
      expectedRevision: 1,
      item: { ...labor, unitPriceHT: 1 },
    });
    const deletion = await new DeleteCatalogueItem({ catalogue: repository }).execute({
      companyId: 'company-b',
      itemId: 'catalogue-1',
      expectedRevision: 1,
    });

    expect(list).toEqual({ ok: true, value: [] });
    expect(update).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'catalogue_item', id: 'catalogue-1' },
    });
    expect(deletion).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'catalogue_item', id: 'catalogue-1' },
    });
    expect(repository.snapshot('company-a', 'catalogue-1')).not.toBeNull();
  });

  it('supprime par CAS puis retourne not_found ; une suppression périmée ne supprime rien', async () => {
    const repository = new InMemoryTenantCatalogue();
    repository.seed(record());
    const useCase = new DeleteCatalogueItem({ catalogue: repository });

    const stale = await useCase.execute({
      companyId: 'company-a',
      itemId: 'catalogue-1',
      expectedRevision: 2,
    });
    expect(stale).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'catalogue_item', reason: 'stale_revision' },
    });
    expect(repository.snapshot('company-a', 'catalogue-1')).not.toBeNull();

    const deleted = await useCase.execute({
      companyId: 'company-a',
      itemId: 'catalogue-1',
      expectedRevision: 1,
    });
    const again = await useCase.execute({
      companyId: 'company-a',
      itemId: 'catalogue-1',
      expectedRevision: 1,
    });

    expect(deleted).toEqual({ ok: true, value: { id: 'catalogue-1', deleted: true } });
    expect(again).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'catalogue_item', id: 'catalogue-1' },
    });
  });

  it('rejette les révisions invalides avant tout accès repository', async () => {
    const repository = new InMemoryTenantCatalogue();
    repository.seed(record());
    const update = new UpdateCatalogueItem({ catalogue: repository, clock: clock() });
    const deletion = new DeleteCatalogueItem({ catalogue: repository });

    for (const expectedRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      const updateResult = await update.execute({
        companyId: 'company-a',
        itemId: 'catalogue-1',
        expectedRevision,
        item: labor,
      });
      expect(updateResult.ok).toBe(false);
    }
    for (const expectedRevision of [0, -1, 1.5]) {
      const deleteResult = await deletion.execute({
        companyId: 'company-a',
        itemId: 'catalogue-1',
        expectedRevision,
      });
      expect(deleteResult.ok).toBe(false);
    }
    expect(repository.snapshot('company-a', 'catalogue-1')).toEqual(record());
  });
});

describe('Catalogue propriétaire — défense en profondeur du port', () => {
  it('fail-close si l’adapter annonce created mais renvoie une autre valeur', async () => {
    const repository: CatalogueRepository = {
      listByCompany: async () => [],
      create: async (item) => ({
        status: 'created',
        item: { ...item, unitPriceHT: item.unitPriceHT + 1 },
      }),
      update: async () => ({ status: 'not_found' }),
      delete: async () => ({ status: 'not_found' }),
    };

    const result = await new CreateCatalogueItem({
      catalogue: repository,
      ids: ids('catalogue-1'),
      clock: clock(),
    }).execute({ companyId: 'company-a', item: labor });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'catalogue', cause: 'unexpected_create_result' },
    });
  });

  it('fail-close si un adapter de lecture mélange deux tenants', async () => {
    const repository: CatalogueRepository = {
      listByCompany: async () => [record({ companyId: 'company-b' })],
      create: async (item) => ({ status: 'created', item }),
      update: async () => ({ status: 'not_found' }),
      delete: async () => ({ status: 'not_found' }),
    };

    const result = await new ListCatalogueItems({ catalogue: repository }).execute({
      companyId: 'company-a',
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'catalogue', cause: 'tenant_scope_violation' },
    });
  });

  it('fail-close sur une ligne persistée invalide au lieu de fabriquer ou masquer une valeur', async () => {
    const repository: CatalogueRepository = {
      listByCompany: async () => [record({ unitPriceHT: 0 })],
      create: async (item) => ({ status: 'created', item }),
      update: async () => ({ status: 'not_found' }),
      delete: async () => ({ status: 'not_found' }),
    };

    const result = await new ListCatalogueItems({ catalogue: repository }).execute({
      companyId: 'company-a',
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'catalogue', cause: 'invalid_persisted_record' },
    });
  });

  it('fail-close si l’adapter annonce updated mais renvoie un autre contenu', async () => {
    const repository: CatalogueRepository = {
      listByCompany: async () => [],
      create: async (item) => ({ status: 'created', item }),
      update: async () => ({
        status: 'updated',
        item: record({ revision: 2, unitPriceHT: 999_999, updatedAt: UPDATED_AT }),
      }),
      delete: async () => ({ status: 'not_found' }),
    };

    const result = await new UpdateCatalogueItem({
      catalogue: repository,
      clock: clock(UPDATED_AT),
    }).execute({
      companyId: 'company-a',
      itemId: 'catalogue-1',
      expectedRevision: 1,
      item: labor,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'dependency', port: 'catalogue', cause: 'unexpected_update_result' },
    });
  });
});
