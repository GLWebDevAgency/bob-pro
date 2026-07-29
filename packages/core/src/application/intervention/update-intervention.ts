import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type InterventionPatch, type InterventionProps } from '../../domain/intervention/intervention';
import { type UnitOfWorkPort } from '../ports/services';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type InterventionRepository } from './intervention-repository';
import { TxAppError, lockInterventionForMutation } from './intervention-mutation';

export interface UpdateInterventionInput {
  companyId: string;
  interventionId: string;
  expectedRevision: number;
  patch: InterventionPatch;
}

export interface UpdateInterventionDeps {
  interventions: InterventionRepository;
  uow: UnitOfWorkPort;
  /** REQUIS dès que le patch pose un `equipmentId` non nul (fail-closed, patron PR-11). */
  equipments?: EquipmentRepository;
}

/**
 * §3.5 — édition de terrain (checklist, résumé, type, technicien, équipement) AVANT la
 * complétion : la checklist est figée à `completed`, tout est verrouillé à `signed` (le
 * domaine refuse — message unique écran/voix).
 */
export class UpdateIntervention {
  constructor(private readonly deps: UpdateInterventionDeps) {}

  async execute(input: UpdateInterventionInput): Promise<Result<InterventionProps, AppError>> {
    try {
      const props = await this.deps.uow.runInTransaction(async () => {
        const intervention = await lockInterventionForMutation(this.deps.interventions, input);

        // Retag équipement : cohérence équipement↔site PROUVÉE avant la mutation (fail-closed).
        const nextEquipmentId = input.patch.equipmentId?.trim() || null;
        if (input.patch.equipmentId !== undefined && nextEquipmentId !== null) {
          if (!this.deps.equipments) {
            throw new TxAppError({
              kind: 'dependency',
              port: 'EquipmentRepository',
              cause: 'equipmentId fourni sans port de vérification (equipments) : lien refusé.',
            });
          }
          const equipment = await this.deps.equipments.findById(input.companyId, nextEquipmentId);
          if (!equipment || equipment.companyId !== input.companyId) {
            throw new TxAppError({ kind: 'not_found', entity: 'equipment', id: nextEquipmentId });
          }
          if (equipment.chantierId !== intervention.chantierId) {
            throw new TxAppError(
              appDomain({
                code: 'VALIDATION',
                field: 'equipmentId',
                message: 'Cet équipement appartient à un autre site.',
              }),
            );
          }
        }

        const updated = intervention.update(input.patch);
        if (!updated.ok) throw new TxAppError(appDomain(updated.error));
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
