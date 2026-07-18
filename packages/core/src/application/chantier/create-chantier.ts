import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ChantierRepository, type CustomerRepository } from '../ports/repositories';
import { Chantier } from '../../domain/chantier/chantier';

export interface CreateChantierInput {
  companyId: string;
  name: string;
  customerId?: string | null;
  address?: string | null;
  notes?: string | null;
}

export interface CreateChantierDeps {
  chantiers: ChantierRepository;
  customers: CustomerRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

export class CreateChantier {
  constructor(private readonly deps: CreateChantierDeps) {}

  async execute(input: CreateChantierInput): Promise<Result<{ id: string }, AppError>> {
    // Intégrité référentielle : si un client est lié, il doit appartenir au même tenant.
    if (input.customerId) {
      const customer = await this.deps.customers.findById(input.customerId);
      if (!customer || customer.companyId !== input.companyId) return err(appNotFound('customer', input.customerId));
    }
    const id = this.deps.ids.newId();
    const r = Chantier.record({
      id,
      companyId: input.companyId,
      name: input.name,
      customerId: input.customerId ?? null,
      address: input.address ?? null,
      notes: input.notes ?? null,
      status: 'open',
      // Date d'ouverture = jour MÉTIER Europe/Paris : un chantier ouvert juste après minuit
      // (Paris) ne doit pas être daté de la veille parce que l'UTC n'a pas encore basculé.
      openedAt: parisDateOnly(this.deps.clock.now()),
    });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.chantiers.save(r.value);
    return ok({ id });
  }
}
