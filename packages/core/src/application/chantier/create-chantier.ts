import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ChantierRepository } from '../ports/repositories';
import { Chantier } from '../../domain/chantier/chantier';

export interface CreateChantierInput {
  companyId: string;
  name: string;
  customerId?: string | null;
  address?: string | null;
}

export interface CreateChantierDeps {
  chantiers: ChantierRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

export class CreateChantier {
  constructor(private readonly deps: CreateChantierDeps) {}

  async execute(input: CreateChantierInput): Promise<Result<{ id: string }, AppError>> {
    const id = this.deps.ids.newId();
    const r = Chantier.record({
      id,
      companyId: input.companyId,
      name: input.name,
      customerId: input.customerId ?? null,
      address: input.address ?? null,
      status: 'open',
      openedAt: this.deps.clock.today(),
    });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.chantiers.save(r.value);
    return ok({ id });
  }
}
