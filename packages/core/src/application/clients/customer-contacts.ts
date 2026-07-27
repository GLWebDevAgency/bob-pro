import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type CustomerRepository } from '../ports/repositories';
import { type IdGeneratorPort } from '../ports/services';
import {
  CustomerContact,
  type CustomerContactProps,
} from '../../domain/customer/customer-contact';

/**
 * PR-09 « Le métier » — CRUD des contacts multiples d'un client (exigence 1). Use cases PURS :
 * anti-IDOR fail-closed (le client visé est PROUVÉ dans le tenant avant toute écriture — un
 * client absent OU d'un autre tenant reçoit le même not_found, jamais un oracle), invariants
 * revalidés par CustomerContact.of à chaque écriture. Le choix du destinataire à l'ENVOI d'une
 * pièce reste l'affaire de SendInvoice (resolveExplicitRecipientEmail, PR-01) : ces use cases
 * gèrent le carnet, jamais un envoi.
 */

export interface CustomerContactRepository {
  findById(id: string): Promise<CustomerContact | null>;
  listByCustomer(companyId: string, customerId: string): Promise<CustomerContact[]>;
  save(contact: CustomerContact): Promise<void>;
  deleteById(id: string): Promise<void>;
}

interface ContactsDeps {
  contacts: CustomerContactRepository;
  customers: Pick<CustomerRepository, 'findById'>;
}

async function requireOwnedCustomer(
  deps: ContactsDeps,
  companyId: string,
  customerId: string,
): Promise<Result<void, AppError>> {
  const customer = await deps.customers.findById(customerId);
  if (!customer || customer.companyId !== companyId) return err(appNotFound('customer', customerId));
  return ok(undefined);
}

async function requireOwnedContact(
  deps: ContactsDeps,
  companyId: string,
  contactId: string,
): Promise<Result<CustomerContact, AppError>> {
  const contact = await deps.contacts.findById(contactId);
  if (!contact || contact.companyId !== companyId) return err(appNotFound('customer_contact', contactId));
  return ok(contact);
}

// ── Lecture ──

export class ListCustomerContacts {
  constructor(private readonly deps: ContactsDeps) {}

  async execute(input: {
    companyId: string;
    customerId: string;
  }): Promise<Result<CustomerContactProps[], AppError>> {
    const owned = await requireOwnedCustomer(this.deps, input.companyId, input.customerId);
    if (!owned.ok) return owned;
    const contacts = await this.deps.contacts.listByCustomer(input.companyId, input.customerId);
    return ok(contacts.map((contact) => contact.toProps()));
  }
}

// ── Création ──

export interface CreateCustomerContactInput {
  companyId: string;
  customerId: string;
  label: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}

export class CreateCustomerContact {
  constructor(private readonly deps: ContactsDeps & { ids: IdGeneratorPort }) {}

  async execute(
    input: CreateCustomerContactInput,
  ): Promise<Result<CustomerContactProps, AppError>> {
    const owned = await requireOwnedCustomer(this.deps, input.companyId, input.customerId);
    if (!owned.ok) return owned;
    const contact = CustomerContact.of({
      id: this.deps.ids.newId(),
      companyId: input.companyId,
      customerId: input.customerId,
      label: input.label,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
    });
    if (!contact.ok) return err(appDomain(contact.error));
    await this.deps.contacts.save(contact.value);
    return ok(contact.value.toProps());
  }
}

// ── Édition (remplacement complet, mêmes invariants que la création) ──

export interface UpdateCustomerContactInput {
  companyId: string;
  contactId: string;
  label: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}

export class UpdateCustomerContact {
  constructor(private readonly deps: ContactsDeps) {}

  async execute(
    input: UpdateCustomerContactInput,
  ): Promise<Result<CustomerContactProps, AppError>> {
    const existing = await requireOwnedContact(this.deps, input.companyId, input.contactId);
    if (!existing.ok) return existing;
    const contact = CustomerContact.of({
      id: existing.value.id,
      companyId: existing.value.companyId,
      // Le rattachement client est IMMUABLE : un contact ne se « déplace » jamais entre
      // clients par édition (supprimer + recréer reste le geste honnête).
      customerId: existing.value.customerId,
      label: input.label,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      revision: existing.value.revision + 1,
    });
    if (!contact.ok) return err(appDomain(contact.error));
    await this.deps.contacts.save(contact.value);
    return ok(contact.value.toProps());
  }
}

// ── Suppression ──

export class DeleteCustomerContact {
  constructor(private readonly deps: ContactsDeps) {}

  async execute(input: {
    companyId: string;
    contactId: string;
  }): Promise<Result<{ deleted: true }, AppError>> {
    const existing = await requireOwnedContact(this.deps, input.companyId, input.contactId);
    if (!existing.ok) return existing;
    await this.deps.contacts.deleteById(existing.value.id);
    return ok({ deleted: true });
  }
}
