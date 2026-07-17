import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import { CustomersController } from './api.controllers';

function controller(overrides: Partial<BackendService> = {}) {
  return new CustomersController(overrides as BackendService);
}

const valid = {
  name: 'Mme Nguyen',
  type: 'b2c' as const,
  address: { line1: '4 rue Basse', zip: '92310', city: 'Sèvres' },
};

describe('CustomersController — aucune métrique fournie par le client', () => {
  it.each(['score', 'avgDelayDays', 'outstanding'])(
    'refuse le champ legacy %s avant le domaine',
    async (field) => {
      const createCustomer = vi.fn();
      const value = controller({ createCustomer } as never);
      await expect(value.create({ ...valid, [field]: 0 })).rejects.toMatchObject({ status: 422 });
      expect(createCustomer).not.toHaveBeenCalled();
    },
  );

  it('refuse les champs inconnus dans l’adresse', async () => {
    const createCustomer = vi.fn();
    const value = controller({ createCustomer } as never);
    await expect(
      value.create({ ...valid, address: { ...valid.address, companyId: 'other-company' } }),
    ).rejects.toMatchObject({ status: 422 });
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('transmet uniquement l’identité et les coordonnées validées', async () => {
    const createCustomer = vi.fn(async () => ({ ok: true as const, value: { id: 'customer-1' } }));
    const value = controller({ createCustomer } as never);
    await expect(value.create(valid)).resolves.toEqual({ id: 'customer-1' });
    expect(createCustomer).toHaveBeenCalledWith(valid);
  });

  it('accepte et transmet contactName (contact chez un client entreprise)', async () => {
    const createCustomer = vi.fn(async () => ({ ok: true as const, value: { id: 'customer-1' } }));
    const value = controller({ createCustomer } as never);
    const withContact = { ...valid, type: 'b2b' as const, contactName: 'Julie Durand' };
    await expect(value.create(withContact)).resolves.toEqual({ id: 'customer-1' });
    expect(createCustomer).toHaveBeenCalledWith(withContact);
  });
});

describe('CustomersController — édition post-création (C13/C40 TODO partagé)', () => {
  it('PATCH délègue à updateCustomer avec la même allowlist que la création', async () => {
    const updateCustomer = vi.fn(async () => ({ ok: true as const, value: { id: 'customer-1' } }));
    const value = controller({ updateCustomer } as never);
    await expect(value.update('customer-1', valid)).resolves.toEqual({ id: 'customer-1' });
    expect(updateCustomer).toHaveBeenCalledWith('customer-1', valid);
  });

  it('refuse un champ legacy à l’édition, comme à la création', async () => {
    const updateCustomer = vi.fn();
    const value = controller({ updateCustomer } as never);
    await expect(value.update('customer-1', { ...valid, score: 100 })).rejects.toMatchObject({
      status: 422,
    });
    expect(updateCustomer).not.toHaveBeenCalled();
  });
});
