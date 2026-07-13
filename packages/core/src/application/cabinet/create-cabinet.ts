import { Cabinet } from '../../domain/cabinet/cabinet';
import { type Result, err } from '../../shared-kernel/result';
import { type CabinetRepository } from '../ports/cabinet-repository';
import { type ClockPort, type IdGeneratorPort, type UnitOfWorkPort } from '../ports/services';
import { type AppError, appDomain } from '../result';
import { runCabinetOperation } from './cabinet-operation';
import { cabinetToView, type CabinetView } from './cabinet-view';

export interface CreateCabinetDeps {
  cabinets: CabinetRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
  uow: UnitOfWorkPort;
}

export interface CreateCabinetInput {
  name: string;
  timeZone: string;
  creatorUserId: string;
}

export class CreateCabinet {
  constructor(private readonly deps: CreateCabinetDeps) {}

  async execute(input: CreateCabinetInput): Promise<Result<CabinetView, AppError>> {
    const created = Cabinet.create({
      id: this.deps.ids.newId(),
      name: input.name,
      timeZone: input.timeZone,
      creatorUserId: input.creatorUserId,
      founderMemberId: this.deps.ids.newId(),
      createdAt: this.deps.clock.now(),
    });
    if (!created.ok) return err(appDomain(created.error));

    return runCabinetOperation(this.deps.uow, async () => {
      await this.deps.cabinets.save(created.value, null);
      const view = cabinetToView(created.value, input.creatorUserId);
      if (!view) throw new Error('Created cabinet has no founder membership.');
      return view;
    });
  }
}
