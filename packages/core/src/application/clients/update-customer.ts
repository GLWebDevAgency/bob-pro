import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type CustomerRepository } from '../ports/repositories';
import { Customer, type CustomerProps } from '../../domain/customer/customer';

/**
 * Édition post-création de la fiche client (C13/C40 TODO partagé) — la création mobile est
 * volontairement MINIMALE (nom + type) ; cet use case permet de compléter/corriger ensuite
 * adresse, SIREN, contact, etc. Remplacement complet (mêmes invariants que la création,
 * revalidés via Customer.of) plutôt qu'un merge partiel côté domaine — le formulaire hôte
 * détient déjà l'état complet de la fiche.
 */
export type UpdateCustomerInput = { id: string; companyId: string } & Omit<CustomerProps, 'id' | 'companyId'>;

export interface UpdateCustomerDeps {
  customers: CustomerRepository;
}

export class UpdateCustomer {
  constructor(private readonly deps: UpdateCustomerDeps) {}

  async execute(input: UpdateCustomerInput): Promise<Result<{ id: string }, AppError>> {
    const existing = await this.deps.customers.findById(input.id);
    if (!existing || existing.companyId !== input.companyId) return err(appNotFound('customer', input.id));
    const r = Customer.of({ ...input });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.customers.save(r.value);
    return ok({ id: input.id });
  }
}
