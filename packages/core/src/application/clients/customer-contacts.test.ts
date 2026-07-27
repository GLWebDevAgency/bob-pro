import { describe, expect, it } from 'vitest';
import {
  CreateCustomerContact,
  DeleteCustomerContact,
  ListCustomerContacts,
  UpdateCustomerContact,
  type CustomerContactRepository,
} from './customer-contacts';
import { CustomerContact } from '../../domain/customer/customer-contact';
import { Customer, type CustomerProps } from '../../domain/customer/customer';

const customerProps: CustomerProps = {
  id: 'cus-ratp',
  companyId: 'co-1',
  type: 'b2g',
  name: 'RATP CAP',
  address: { line1: '54 quai de la Rapée', zip: '75012', city: 'Paris' },
  email: 'facturation@ratp.fr',
};

function makeEnv() {
  const customerR = Customer.of(customerProps);
  if (!customerR.ok) throw new Error('customer');
  const customer = customerR.value;
  const store = new Map<string, CustomerContact>();
  const contacts: CustomerContactRepository = {
    findById: async (id) => store.get(id) ?? null,
    listByCustomer: async (companyId, customerId) =>
      [...store.values()].filter(
        (contact) => contact.companyId === companyId && contact.customerId === customerId,
      ),
    save: async (contact) => {
      store.set(contact.id, contact);
    },
    deleteById: async (id) => {
      store.delete(id);
    },
  };
  const customers = {
    findById: async (id: string) => (id === customer.id ? customer : null),
  };
  let seq = 0;
  const ids = { newId: () => `contact-${(seq += 1)}` };
  return { contacts, customers, ids, store };
}

describe('CustomerContact — CRUD (PR-09, exigence 1)', () => {
  it('crée un contact validé/normalisé (label libre, e-mail en minuscules)', async () => {
    const env = makeEnv();
    const created = await new CreateCustomerContact(env).execute({
      companyId: 'co-1',
      customerId: 'cus-ratp',
      label: '  Compta ',
      name: 'Mme  Lefèvre',
      email: 'Compta.CAP@RATP.fr',
      phone: '06 12 34 56 78',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({
      customerId: 'cus-ratp',
      label: 'Compta',
      name: 'Mme Lefèvre',
      email: 'compta.cap@ratp.fr',
      phone: '06 12 34 56 78',
      revision: 1,
    });
  });

  it('anti-IDOR : client d’un autre tenant (ou absent) → not_found, rien d’écrit', async () => {
    const env = makeEnv();
    const otherTenant = await new CreateCustomerContact(env).execute({
      companyId: 'co-AUTRE',
      customerId: 'cus-ratp',
      label: 'Compta',
      name: 'X',
    });
    expect(otherTenant.ok).toBe(false);
    if (!otherTenant.ok) expect(otherTenant.error.kind).toBe('not_found');
    const absent = await new CreateCustomerContact(env).execute({
      companyId: 'co-1',
      customerId: 'cus-inconnu',
      label: 'Compta',
      name: 'X',
    });
    expect(absent.ok).toBe(false);
    expect(env.store.size).toBe(0);
  });

  it('invariants : label/nom requis, e-mail difforme refusé — rien d’écrit', async () => {
    const env = makeEnv();
    const base = { companyId: 'co-1', customerId: 'cus-ratp', label: 'Compta', name: 'Mme Lefèvre' };
    expect((await new CreateCustomerContact(env).execute({ ...base, label: '  ' })).ok).toBe(false);
    expect((await new CreateCustomerContact(env).execute({ ...base, name: '' })).ok).toBe(false);
    expect(
      (await new CreateCustomerContact(env).execute({ ...base, email: 'pas-un-email' })).ok,
    ).toBe(false);
    expect(env.store.size).toBe(0);
  });

  it('liste les contacts DU client demandé (tenant + client filtrés)', async () => {
    const env = makeEnv();
    await new CreateCustomerContact(env).execute({
      companyId: 'co-1',
      customerId: 'cus-ratp',
      label: 'Compta',
      name: 'A',
    });
    await new CreateCustomerContact(env).execute({
      companyId: 'co-1',
      customerId: 'cus-ratp',
      label: 'Valideur',
      name: 'B',
    });
    const listed = await new ListCustomerContacts(env).execute({
      companyId: 'co-1',
      customerId: 'cus-ratp',
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((contact) => contact.label)).toEqual(['Compta', 'Valideur']);
    const foreign = await new ListCustomerContacts(env).execute({
      companyId: 'co-AUTRE',
      customerId: 'cus-ratp',
    });
    expect(foreign.ok).toBe(false);
  });

  it('édite (revision +1, rattachement client IMMUABLE) ; contact d’un autre tenant refusé', async () => {
    const env = makeEnv();
    const created = await new CreateCustomerContact(env).execute({
      companyId: 'co-1',
      customerId: 'cus-ratp',
      label: 'Compta',
      name: 'A',
    });
    if (!created.ok) throw new Error('création');
    const updated = await new UpdateCustomerContact(env).execute({
      companyId: 'co-1',
      contactId: created.value.id,
      label: 'Compta fournisseurs',
      name: 'A',
      email: 'compta@ratp.fr',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value).toMatchObject({
      label: 'Compta fournisseurs',
      email: 'compta@ratp.fr',
      customerId: 'cus-ratp',
      revision: 2,
    });
    const foreign = await new UpdateCustomerContact(env).execute({
      companyId: 'co-AUTRE',
      contactId: created.value.id,
      label: 'X',
      name: 'X',
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.kind).toBe('not_found');
  });

  it('supprime (tenant vérifié) — un contact d’un autre tenant reste intouché', async () => {
    const env = makeEnv();
    const created = await new CreateCustomerContact(env).execute({
      companyId: 'co-1',
      customerId: 'cus-ratp',
      label: 'Compta',
      name: 'A',
    });
    if (!created.ok) throw new Error('création');
    const foreign = await new DeleteCustomerContact(env).execute({
      companyId: 'co-AUTRE',
      contactId: created.value.id,
    });
    expect(foreign.ok).toBe(false);
    expect(env.store.size).toBe(1);
    const deleted = await new DeleteCustomerContact(env).execute({
      companyId: 'co-1',
      contactId: created.value.id,
    });
    expect(deleted.ok).toBe(true);
    expect(env.store.size).toBe(0);
  });
});
