import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type Instant } from '../../shared-kernel/time';
import { type InterventionProps } from '../../domain/intervention/intervention';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { type InterventionRepository } from './intervention-repository';
import { TxAppError, lockInterventionForMutation } from './intervention-mutation';

export interface StartInterventionInput {
  companyId: string;
  interventionId: string;
  /** CAS — révision observée (chaînée par l'outbox offline, amélioration 7). */
  expectedRevision: number;
  /** Heure RÉELLE du geste (appareil, rejeu offline) — absente : horloge serveur. */
  startedAt?: Instant;
}

export interface StartInterventionDeps {
  interventions: InterventionRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

/** §3.5 — démarrer le passage (« démarre l'intervention chez Carrefour » = MÊME use case). */
export class StartIntervention {
  constructor(private readonly deps: StartInterventionDeps) {}

  async execute(input: StartInterventionInput): Promise<Result<InterventionProps, AppError>> {
    try {
      const props = await this.deps.uow.runInTransaction(async () => {
        const intervention = await lockInterventionForMutation(this.deps.interventions, input);
        const started = intervention.start(input.startedAt ?? this.deps.clock.now());
        if (!started.ok) throw new TxAppError(appDomain(started.error));
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
