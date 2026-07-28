import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type InterventionProps } from '../../domain/intervention/intervention';
import { type UnitOfWorkPort } from '../ports/services';
import { type InterventionRepository } from './intervention-repository';
import { TxAppError, lockInterventionForMutation } from './intervention-mutation';

export interface CancelInterventionInput {
  companyId: string;
  interventionId: string;
  expectedRevision: number;
}

export interface CancelInterventionDeps {
  interventions: InterventionRepository;
  uow: UnitOfWorkPort;
}

/** §3.5 — annuler un passage NON réalisé (impossible après `completed` : machine §3.3). */
export class CancelIntervention {
  constructor(private readonly deps: CancelInterventionDeps) {}

  async execute(input: CancelInterventionInput): Promise<Result<InterventionProps, AppError>> {
    try {
      const props = await this.deps.uow.runInTransaction(async () => {
        const intervention = await lockInterventionForMutation(this.deps.interventions, input);
        const cancelled = intervention.cancel();
        if (!cancelled.ok) throw new TxAppError(appDomain(cancelled.error));
        await this.deps.interventions.save(intervention);
        return intervention.toProps();
      });
      return ok(props);
    } catch (e) {
      if (e instanceof TxAppError) return err(e.appError);
      throw e;
    }
  }
}
