import { describe, expect, it } from 'vitest';
import { InMemorySupplierMemoryRepository } from './supplier-memory.testing';

describe('InMemorySupplierMemoryRepository', () => {
  it('apprend un fournisseur par tenant et conserve les infos connues', async () => {
    const repo = new InMemorySupplierMemoryRepository();

    await repo.rememberSupplier(
      'co-1',
      { name: 'Leroy Merlin', siren: '552100554', category: 'materiel', vatRatePct: 20 },
      '2026-07-01T10:00:00.000Z',
    );
    const updated = await repo.rememberSupplier(
      'co-1',
      { name: 'LÉROY  MERLIN', category: 'fournitures' },
      '2026-07-02T10:00:00.000Z',
    );

    expect(updated).toMatchObject({
      companyId: 'co-1',
      key: 'leroy merlin',
      displayName: 'LÉROY  MERLIN',
      siren: '552100554',
      category: 'fournitures',
      vatRatePct: 20,
      seen: 2,
    });
    await repo.rememberSupplier('co-2', { name: 'Leroy Merlin', category: 'carburant' }, '2026-07-03T10:00:00.000Z');

    expect((await repo.supplierProfile('co-1', 'leroy-merlin'))?.category).toBe('fournitures');
    expect((await repo.supplierProfile('co-2', 'leroy-merlin'))?.category).toBe('carburant');
    expect(await repo.knownSupplierNames('co-1')).toEqual(['LÉROY  MERLIN']);
  });
});
