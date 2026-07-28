import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type Instant } from '../../shared-kernel/time';
import { type ChecklistItem, type InterventionProps } from '../../domain/intervention/intervention';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { type InterventionRepository } from './intervention-repository';
import { TxAppError, lockInterventionForMutation } from './intervention-mutation';

export interface CompleteInterventionInput {
  companyId: string;
  interventionId: string;
  expectedRevision: number;
  /** Heure RÉELLE de fin (appareil au rejeu) — absente : horloge serveur. */
  finishedAt?: Instant;
  /** Checklist FINALE, FIGÉE par ce geste (§3.4) — absente : l'état courant est figé tel quel. */
  checklist?: ChecklistItem[];
  summary?: string | null;
}

export interface CompleteInterventionDeps {
  interventions: InterventionRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

/**
 * §3.5 — terminer le passage : la checklist est FIGÉE, le résumé posé dans le même geste
 * (« je termine le passage avec détartrage coché et le résumé ? » — confirmation groupée).
 * `completed` est un terminal légitime (client absent = fiche envoyable non signée).
 */
export class CompleteIntervention {
  constructor(private readonly deps: CompleteInterventionDeps) {}

  async execute(input: CompleteInterventionInput): Promise<Result<InterventionProps, AppError>> {
    try {
      const props = await this.deps.uow.runInTransaction(async () => {
        const intervention = await lockInterventionForMutation(this.deps.interventions, input);
        const completed = intervention.complete(input.finishedAt ?? this.deps.clock.now(), {
          ...(input.checklist !== undefined ? { checklist: input.checklist } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
        });
        if (!completed.ok) throw new TxAppError(appDomain(completed.error));
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
