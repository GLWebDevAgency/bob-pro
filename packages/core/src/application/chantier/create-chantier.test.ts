import { describe, expect, it } from 'vitest';
import { Chantier } from '../../domain/chantier/chantier';
import { Customer, type CustomerProps } from '../../domain/customer/customer';
import { type ChantierRepository, type CustomerRepository } from '../ports/repositories';
import { CreateChantier } from './create-chantier';

class MemoryChantiers implements ChantierRepository {
  private readonly map = new Map<string, Chantier>();
  async save(c: Chantier): Promise<void> {
    this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Chantier | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Chantier[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }
  get(id: string): Chantier | undefined {
    return this.map.get(id);
  }
}

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
}

function customer(props: CustomerProps): Customer {
  const r = Customer.of(props);
  if (!r.ok) throw new Error('customer de test invalide');
  return r.value;
}

const ids = { newId: () => 'chantier-1' };
const clock = { today: () => '2026-07-17', now: () => '2026-07-17T10:00:00.000Z' };

describe('CreateChantier', () => {
  it('crée un chantier rattaché au client, avec adresse et note pré-remplie', async () => {
    const chantiers = new MemoryChantiers();
    const customers = new MemoryCustomers([
      customer({ id: 'cust-1', companyId: 'co-1', type: 'b2c', name: 'Martin', address: { line1: '1 rue A', zip: '75001', city: 'Paris' } }),
    ]);
    const useCase = new CreateChantier({ chantiers, customers, ids, clock });

    const r = await useCase.execute({
      companyId: 'co-1',
      name: 'Villa Durand',
      customerId: 'cust-1',
      address: '1 rue A, 75001 Paris',
      notes: 'Code portail 1234, chien dans le jardin.',
    });

    expect(r.ok).toBe(true);
    const saved = chantiers.get('chantier-1');
    expect(saved?.notes).toBe('Code portail 1234, chien dans le jardin.');
    expect(saved?.customerId).toBe('cust-1');
    expect(saved?.address).toBe('1 rue A, 75001 Paris');
  });

  it('refuse un chantier rattaché à un client d’un autre tenant', async () => {
    const chantiers = new MemoryChantiers();
    const customers = new MemoryCustomers([
      customer({ id: 'cust-1', companyId: 'autre-tenant', type: 'b2c', name: 'Martin', address: { line1: '1 rue A', zip: '75001', city: 'Paris' } }),
    ]);
    const useCase = new CreateChantier({ chantiers, customers, ids, clock });

    const r = await useCase.execute({ companyId: 'co-1', name: 'Villa Durand', customerId: 'cust-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('note et adresse restent optionnelles (null par défaut)', async () => {
    const chantiers = new MemoryChantiers();
    const customers = new MemoryCustomers([]);
    const useCase = new CreateChantier({ chantiers, customers, ids, clock });

    const r = await useCase.execute({ companyId: 'co-1', name: 'Villa Durand' });
    expect(r.ok).toBe(true);
    const saved = chantiers.get('chantier-1');
    expect(saved?.notes).toBeNull();
    expect(saved?.address).toBeNull();
    expect(saved?.customerId).toBeNull();
  });
});
