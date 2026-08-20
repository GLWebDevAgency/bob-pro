import { describe, expect, it } from 'vitest';
import { Customer, type CustomerProps } from '../../domain/customer/customer';
import { Quote } from '../../domain/billing/quote/quote';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { type CustomerRepository } from '../ports/repositories';
import { UpdateCustomer } from './update-customer';

class MemoryCustomers implements CustomerRepository {
  private readonly map = new Map<string, Customer>();
  private readonly revisions = new Map<string, number>();
  constructor(
    seed: Customer[],
    private readonly beforeCas?: () => void,
  ) {
    for (const c of seed) {
      this.map.set(c.id, c);
      this.revisions.set(c.id, 1);
    }
  }
  async findById(id: string): Promise<Customer | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Customer[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }
  async save(c: Customer): Promise<void> {
    this.map.set(c.id, c);
    this.revisions.set(c.id, (this.revisions.get(c.id) ?? 0) + 1);
  }
  async saveIfRevision(
    c: Customer,
    expectedRevision: number,
  ): Promise<'saved' | 'revision_conflict'> {
    this.beforeCas?.();
    if (this.revisions.get(c.id) !== expectedRevision || !this.map.has(c.id)) {
      return 'revision_conflict';
    }
    this.map.set(c.id, c);
    this.revisions.set(c.id, expectedRevision + 1);
    return 'saved';
  }
  get(id: string): Customer | undefined {
    return this.map.get(id);
  }
  revision(id: string): number | undefined {
    return this.revisions.get(id);
  }
  delete(id: string): void {
    this.map.delete(id);
    this.revisions.delete(id);
  }
}

function customer(props: CustomerProps): Customer {
  const r = Customer.of(props);
  if (!r.ok) throw new Error('customer de test invalide');
  return r.value;
}

/** Aucune pièce : la garde du type ne bloque jamais (fiche vierge de tout contrat). */
const emptyQuotes = { listByCompany: async () => [] };
const emptyInvoices = { listByCompany: async () => [] };

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
    const useCase = new UpdateCustomer({ customers, quotes: emptyQuotes, invoices: emptyInvoices });

    const r = await useCase.execute({
      id: 'cust-1',
      companyId: 'co-1',
      type: 'b2b',
      name: 'Durand SARL',
      siren: '732829320',
      siret: '73282932000074',
      contactName: 'Julie Durand',
      email: 'julie@durand.fr',
      phone: '0612345678',
      address: { line1: '2 rue B', zip: '75002', city: 'Paris' },
    });

    expect(r.ok).toBe(true);
    const saved = customers.get('cust-1');
    expect(saved?.name).toBe('Durand SARL');
    expect(saved?.type).toBe('b2b');
    expect(saved?.siren).toBe('732829320');
    expect(saved?.siret).toBe('73282932000074');
    expect(saved?.contactName).toBe('Julie Durand');
    expect(saved?.toProps().address).toEqual({ line1: '2 rue B', zip: '75002', city: 'Paris' });
  });

  it('refuse une édition sur un client introuvable', async () => {
    const customers = new MemoryCustomers([]);
    const useCase = new UpdateCustomer({ customers, quotes: emptyQuotes, invoices: emptyInvoices });
    const r = await useCase.execute({ ...base, id: 'ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('refuse une édition croisée entre tenants (intégrité multi-tenant)', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({ customers, quotes: emptyQuotes, invoices: emptyInvoices });
    const r = await useCase.execute({ ...base, companyId: 'autre-tenant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('propage une erreur domaine (ex. SIREN invalide) sans écrire', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({ customers, quotes: emptyQuotes, invoices: emptyInvoices });
    const r = await useCase.execute({ ...base, siren: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(customers.get('cust-1')?.siren).toBeUndefined();
  });

  it('commit CAS : la révision scellée gagne une seule fois', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({ customers, quotes: emptyQuotes, invoices: emptyInvoices });

    const result = await useCase.executeAtRevision({ ...base, name: 'Martin corrigé' }, 1);

    expect(result).toEqual({ ok: true, value: { id: 'cust-1' } });
    expect(customers.get('cust-1')?.name).toBe('Martin corrigé');
    expect(customers.revision('cust-1')).toBe(2);
  });

  it('commit CAS : une écriture concurrente reste intacte et Bob reçoit stale_revision', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    await customers.save(customer({ ...base, name: 'Correction humaine' }));
    const useCase = new UpdateCustomer({ customers, quotes: emptyQuotes, invoices: emptyInvoices });

    const result = await useCase.executeAtRevision({ ...base, name: 'Correction Bob' }, 1);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'customer', reason: 'stale_revision' },
    });
    expect(customers.get('cust-1')?.name).toBe('Correction humaine');
    expect(customers.revision('cust-1')).toBe(2);
  });

  it('commit CAS : une cible supprimée entre relecture et UPDATE n’est jamais recréée', async () => {
    const customers = new MemoryCustomers([customer(base)], () => customers.delete('cust-1'));
    const useCase = new UpdateCustomer({ customers, quotes: emptyQuotes, invoices: emptyInvoices });

    const result = await useCase.executeAtRevision({ ...base, name: 'Fantôme' }, 1);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'customer', reason: 'stale_revision' },
    });
    expect(customers.get('cust-1')).toBeUndefined();
  });

  it('commit CAS : adapter sans writer révisionné et révision invalide échouent fermés', async () => {
    const seeded = customer(base);
    const withoutCas: CustomerRepository = {
      findById: async (id) => (id === seeded.id ? seeded : null),
      listByCompany: async () => [seeded],
      save: async () => undefined,
    };
    const useCase = new UpdateCustomer({
      customers: withoutCas,
      quotes: emptyQuotes,
      invoices: emptyInvoices,
    });

    await expect(useCase.executeAtRevision({ ...base, name: 'Bob' }, 1)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'CustomerRepository.saveIfRevision',
        cause: 'customer_revision_writer_missing',
      },
    });
    await expect(useCase.executeAtRevision({ ...base, name: 'Bob' }, 0)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'domain',
        error: {
          code: 'VALIDATION',
          field: 'expectedRevision',
          message: 'Révision client invalide.',
        },
      },
    });
  });
});

describe('UpdateCustomer — garde du TYPE (A3/A4 : la qualité s’apprécie à la conclusion)', () => {
  function signedQuoteFor(customerId: string) {
    return Quote.rehydrate({
      id: 'q-1',
      companyId: 'co-1',
      customerId,
      status: 'signed',
      number: 'D-2026-0001',
      depositPct: null,
      validUntil: null,
      signature: {
        signerName: 'Martin',
        signedAt: '2026-06-01T09:00:00.000Z',
        method: 'onsite_draw',
        accepted: true,
        customerType: 'b2c',
      },
      lines: [],
    });
  }

  function issuedInvoiceFor(customerId: string) {
    const created = Invoice.composeStandalone({ id: 'i-1', companyId: 'co-1', customerId });
    if (!created.ok) throw new Error('invoice');
    return created.value; // brouillon : status 'draft'
  }

  function cancelledIssuedInvoiceFor(customerId: string) {
    const draft = issuedInvoiceFor(customerId);
    return Invoice.rehydrate({
      ...draft.toSnapshot(),
      status: 'cancelled',
      number: 'F-2026-0001',
      issuedAt: '2026-06-01',
      dueAt: '2026-07-01',
    });
  }

  it('devis SIGNÉ présent → changement de type REFUSÉ (b2c→b2b interdit, fiche intacte)', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({
      customers,
      quotes: { listByCompany: async () => [signedQuoteFor('cust-1')] },
      invoices: emptyInvoices,
    });
    const r = await useCase.execute({ ...base, type: 'b2b', siren: '732829320' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION') {
      expect(r.error.error.field).toBe('type');
      expect(r.error.error.message).toContain('conclusion');
    }
    expect(customers.get('cust-1')?.type).toBe('b2c');
  });

  it('b2b→b2c avec devis signé : refus aussi (jamais de gel rétroactif fabriqué)', async () => {
    const proBase = { ...base, type: 'b2b' as const, siren: '732829320' };
    const customers = new MemoryCustomers([customer(proBase)]);
    const useCase = new UpdateCustomer({
      customers,
      quotes: { listByCompany: async () => [signedQuoteFor('cust-1')] },
      invoices: emptyInvoices,
    });
    const { siren: _siren, ...withoutSiren } = proBase;
    const r = await useCase.execute({ ...withoutSiren, type: 'b2c' });
    expect(r.ok).toBe(false);
  });

  it('facture brouillon seule → le type reste modifiable (aucune pièce émise/signée)', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({
      customers,
      quotes: emptyQuotes,
      invoices: { listByCompany: async () => [issuedInvoiceFor('cust-1')] },
    });
    const r = await useCase.execute({ ...base, type: 'b2b', siren: '732829320' });
    expect(r.ok).toBe(true);
    expect(customers.get('cust-1')?.type).toBe('b2b');
  });

  it('facture émise puis annulée → le type reste figé pour préserver sa portée légale', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({
      customers,
      quotes: emptyQuotes,
      invoices: { listByCompany: async () => [cancelledIssuedInvoiceFor('cust-1')] },
    });
    const r = await useCase.execute({ ...base, type: 'b2b', siren: '732829320' });
    expect(r.ok).toBe(false);
    expect(customers.get('cust-1')?.type).toBe('b2c');
  });

  it('pièces d’un AUTRE client → sans effet sur cette fiche', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    const useCase = new UpdateCustomer({
      customers,
      quotes: { listByCompany: async () => [signedQuoteFor('cust-autre')] },
      invoices: emptyInvoices,
    });
    const r = await useCase.execute({ ...base, type: 'b2b', siren: '732829320' });
    expect(r.ok).toBe(true);
  });

  it('type INCHANGÉ → les repos de pièces ne sont jamais interrogés (édition d’adresse libre)', async () => {
    const customers = new MemoryCustomers([customer(base)]);
    let asked = 0;
    const useCase = new UpdateCustomer({
      customers,
      quotes: {
        listByCompany: async () => {
          asked += 1;
          return [];
        },
      },
      invoices: emptyInvoices,
    });
    const r = await useCase.execute({ ...base, name: 'Martin (corrigé)' });
    expect(r.ok).toBe(true);
    expect(asked).toBe(0);
  });
});
