import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type EquipmentPatch, type EquipmentProps } from '../../domain/equipment/equipment';
import { type EquipmentRepository } from './equipment-repository';

export interface UpdateEquipmentInput {
  companyId: string;
  equipmentId: string;
  /** CAS — révision observée par l'écran/la voix : une édition périmée n'écrase jamais. */
  expectedRevision: number;
  patch: EquipmentPatch;
}

export interface UpdateEquipmentDeps {
  equipments: EquipmentRepository;
}

/** Bloc A §1.5 — édition des champs descriptifs (équipement ACTIF, CAS par révision). */
export class UpdateEquipment {
  constructor(private readonly deps: UpdateEquipmentDeps) {}

  async execute(input: UpdateEquipmentInput): Promise<Result<EquipmentProps, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      return err(appDomain({ code: 'VALIDATION', field: 'expectedRevision', message: 'Révision invalide.' }));
    const load = this.deps.equipments.lockById?.bind(this.deps.equipments) ??
      this.deps.equipments.findById.bind(this.deps.equipments);
    const equipment = await load(input.companyId, input.equipmentId);
    if (!equipment || equipment.companyId !== input.companyId)
      return err(appNotFound('equipment', input.equipmentId));
    if (equipment.revision !== input.expectedRevision)
      return err(appConflict('equipment', 'stale_revision'));
    const updated = equipment.update(input.patch);
    if (!updated.ok) return err(appDomain(updated.error));
    await this.deps.equipments.save(equipment);
    return ok(equipment.toProps());
  }
}
