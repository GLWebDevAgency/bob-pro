import { describe, expect, it } from 'vitest';
import { Customer, type CustomerProps } from '../../domain/customer/customer';
import { type CustomerRepository } from '../ports/repositories';
import { UpdateCustomer } from './update-customer';

class MemoryCustomers implements CustomerRepository {
  private readonly map = new Map<string, Customer>();
  constructor(seed: Customer[]) {
    for (const c of seed) this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Customer | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Customer[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }
  async save(c: Customer): Promise<void> {
    this.map.set(c.id, c);
  }
  get(id: string): Customer | undefined {
    return this.map.get(id);
  }
}

function customer(props: CustomerProps): Customer {
  const r = Customer.of(props);
  if (!r.ok) throw new Error('customer de test invalide');
  return r.value;
}

const base: CustomerProps = {
  id: 'cust-1',
  companyId: 'co-1',
  type: 'b2c',
  name: 'Martin',
  address: { line1: '1 rue A', zip: '75001', city: 'Paris' },
};

describe('UpdateCustomer', () => {
  it('remplace la fiche et revalide les invariants du domaine', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({ customers });

    const r = await useCase.execute({
      id: 'cust-1',
      companyId: 'co-1',
      type: 'b2b',
      name: 'Durand SARL',
      siren: '123456789',
      contactName: 'Julie Durand',
      email: 'julie@durand.fr',
      phone: '0612345678',
      address: { line1: '2 rue B', zip: '75002', city: 'Paris' },
    });

    expect(r.ok).toBe(true);
    const saved = customers.get('cust-1');
    expect(saved?.name).toBe('Durand SARL');
    expect(saved?.type).toBe('b2b');
    expect(saved?.siren).toBe('123456789');
    expect(saved?.contactName).toBe('Julie Durand');
    expect(saved?.toProps().address).toEqual({ line1: '2 rue B', zip: '75002', city: 'Paris' });
  });

  it('refuse une édition sur un client introuvable', async () => {
    const customers = new MemoryCustomers([]);
    const useCase = new UpdateCustomer({ customers });
    const r = await useCase.execute({ ...base, id: 'ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('refuse une édition croisée entre tenants (intégrité multi-tenant)', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({ customers });
    const r = await useCase.execute({ ...base, companyId: 'autre-tenant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('propage une erreur domaine (ex. SIREN invalide) sans écrire', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({ customers });
    const r = await useCase.execute({ ...base, siren: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(customers.get('cust-1')?.siren).toBeUndefined();
  });
});
