import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import { CatalogueController } from './api.controllers';

function controller(overrides: Partial<BackendService> = {}) {
  return new CatalogueController(overrides as BackendService);
}

const item = {
  label: 'Main-d’œuvre plomberie',
  category: 'labor' as const,
  unit: 'heure',
  unitPriceHT: 5_500,
  vatRate: 20 as const,
};

describe('CatalogueController — frontière HTTP stricte', () => {
  it('ne laisse jamais le client fournir id, companyId ou prix indicatif', async () => {
    const createCatalogueItem = vi.fn();
    const value = controller({ createCatalogueItem } as never);

    await expect(value.create({ ...item, companyId: 'other-company' }))
      .rejects.toMatchObject({ status: 422 });
    expect(createCatalogueItem).not.toHaveBeenCalled();
  });

  it('transmet seulement les champs métier et la révision CAS', async () => {
    const updateCatalogueItem = vi.fn(async () => ({
      ok: true as const,
      value: {
        id: 'item-1',
        ...item,
        revision: 4,
        createdAt: '2026-07-17T10:00:00.000Z',
        updatedAt: '2026-07-17T11:00:00.000Z',
      },
    }));
    const value = controller({ updateCatalogueItem } as never);

    await expect(value.update('item-1', { ...item, expectedRevision: 3 }))
      .resolves.toMatchObject({ id: 'item-1', revision: 4 });
    expect(updateCatalogueItem).toHaveBeenCalledWith({
      itemId: 'item-1',
      expectedRevision: 3,
      item,
    });
  });

  it('refuse une suppression sans révision valide avant le domaine', async () => {
    const deleteCatalogueItem = vi.fn();
    const value = controller({ deleteCatalogueItem } as never);

    await expect(value.remove('item-1', { expectedRevision: 0 }))
      .rejects.toMatchObject({ status: 422 });
    expect(deleteCatalogueItem).not.toHaveBeenCalled();
  });
});
