import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type Instant } from '../../shared-kernel/time';
import { type ChecklistItem, type InterventionProps } from '../../domain/intervention/intervention';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { type InterventionRepository } from './intervention-repository';
import { TxAppError, lockInterventionForMutation } from './intervention-mutation';

/**
 * [Revue adversariale 28/07 — finding 9a] Tolérance d'AVANCE d'horloge appareil sur `finishedAt`.
 * Le rejeu hors-ligne transmet l'heure RÉELLE du geste (§3.6) : un téléphone légèrement en avance
 * reste légitime. Au-delà, la fiche serait terminée DANS LE FUTUR — le PDF, le nom de fichier de
 * l'archive et la date de la ligne de facture (`parisDateOnly(finishedAt)`) mentiraient tous.
 * Le domaine ne borne que la chronologie `startedAt ≤ finishedAt` : la borne HAUTE a besoin de
 * l'horloge, elle vit donc ici (comme le CHECK SQL ne peut pas la porter non plus).
 */
export const FINISHED_AT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export const FINISHED_AT_IN_FUTURE_MESSAGE =
  'Date de fin dans le futur : vérifie l’heure de ton téléphone, puis termine le passage.';

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
    const now = this.deps.clock.now();
    // Borne HAUTE (le domaine ne borne que la chronologie interne) : un passage ne se termine
    // jamais dans le futur — sinon la date métier de la fiche, de l'archive et de la facture
    // serait fabriquée. Refus ACTIONNABLE (« vérifie l'heure de ton téléphone »).
    if (input.finishedAt !== undefined) {
      const declared = Date.parse(input.finishedAt);
      if (
        !Number.isNaN(declared) &&
        declared > Date.parse(now) + FINISHED_AT_CLOCK_SKEW_TOLERANCE_MS
      ) {
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'finishedAt',
            message: FINISHED_AT_IN_FUTURE_MESSAGE,
          }),
        );
      }
    }
    try {
      const props = await this.deps.uow.runInTransaction(async () => {
        const intervention = await lockInterventionForMutation(this.deps.interventions, input);
        const completed = intervention.complete(input.finishedAt ?? now, {
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
